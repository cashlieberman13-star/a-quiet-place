/* shared/worldgen.js — deterministic world generation (Node + browser) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WorldGen = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SIZE = 2400, WALL_T = 10, DOOR_W = 46, PR = 10, CR = 13;

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function shuffle(arr, rnd) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = (rnd() * (i + 1)) | 0, t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  function rectsOverlap(a, b, pad) {
    return a.x < b.x + b.w + pad && a.x + a.w + pad > b.x &&
           a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;
  }

  function pointInRect(px, py, r, pad) {
    pad = pad || 0;
    return px > r.x - pad && px < r.x + r.w + pad && py > r.y - pad && py < r.y + r.h + pad;
  }

  function circleRectResolve(px, py, rad, rc) {
    var nx = clamp(px, rc.x, rc.x + rc.w), ny = clamp(py, rc.y, rc.y + rc.h);
    var dx = px - nx, dy = py - ny, d2 = dx * dx + dy * dy;
    if (d2 >= rad * rad) return null;
    if (d2 > 1e-9) {
      var d = Math.sqrt(d2), push = (rad - d) / d;
      return { x: px + dx * push, y: py + dy * push };
    }
    var l = px - rc.x, rr = rc.x + rc.w - px, t = py - rc.y, b = rc.y + rc.h - py;
    var m = Math.min(l, rr, t, b);
    if (m === l) return { x: rc.x - rad, y: py };
    if (m === rr) return { x: rc.x + rc.w + rad, y: py };
    if (m === t) return { x: px, y: rc.y - rad };
    return { x: px, y: rc.y + rc.h + rad };
  }

  /* resolve a moving circle against rects + trees. returns corrected pos + hit list */
  function resolveCircle(px, py, rad, rects, trees, size) {
    var hits = [];
    px = clamp(px, rad, size - rad); py = clamp(py, rad, size - rad);
    for (var pass = 0; pass < 2; pass++) {
      var i, res;
      for (i = 0; i < rects.length; i++) {
        res = circleRectResolve(px, py, rad, rects[i]);
        if (res) { px = res.x; py = res.y; hits.push(rects[i]); }
      }
      if (trees) for (i = 0; i < trees.length; i++) {
        var tr = trees[i], dx = px - tr.x, dy = py - tr.y, rr = rad + tr.r, d2 = dx * dx + dy * dy;
        if (d2 < rr * rr) {
          if (d2 > 1e-9) { var d = Math.sqrt(d2); px = tr.x + dx / d * rr; py = tr.y + dy / d * rr; }
          else { px = tr.x + rr; }
          hits.push(tr);
        }
      }
    }
    return { x: px, y: py, hits: hits };
  }

  function buildWalls(b, rnd, walls, doors) {
    var T = WALL_T, D = DOOR_W, x = b.x, y = b.y, w = b.w, h = b.h;
    var sides = shuffle([0, 1, 2, 3], rnd);            /* 0=N 1=E 2=S 3=W */
    var defs = [{ s: sides[0], f: 0.25 + rnd() * 0.5 }];
    if (rnd() < 0.55 && w + h > 320) defs.push({ s: sides[1], f: 0.25 + rnd() * 0.5 });
    function doorFor(sd) { for (var i = 0; i < defs.length; i++) if (defs[i].s === sd) return defs[i]; return null; }
    function seg(ax, ay, aw, ah) { if (aw > 1 && ah > 1) walls.push({ x: Math.round(ax), y: Math.round(ay), w: Math.round(aw), h: Math.round(ah) }); }
    function side(sd) {
      var horiz = sd === 0 || sd === 2, len = horiz ? w : h, base = horiz ? x : y;
      function line(a0, a1) {
        if (a1 - a0 < 2) return;
        if (horiz) seg(base + a0, sd === 0 ? y : y + h - T, a1 - a0, T);
        else seg(sd === 3 ? x : x + w - T, base + a0, T, a1 - a0);
      }
      var dd = doorFor(sd);
      if (!dd) { line(0, len); return; }
      var gs = Math.round(dd.f * (len - D));
      line(0, gs); line(gs + D, len);
      var dr;
      if (horiz) dr = { x: base + gs, y: sd === 0 ? y : y + h - T, w: D, h: T };
      else dr = { x: sd === 3 ? x : x + w - T, y: base + gs, w: T, h: D };
      dr.b = b.i; dr.side = sd;
      doors.push(dr);
    }
    side(0); side(1); side(2); side(3);
    if (rnd() < 0.6 && w > 190 && h > 160) {           /* interior wall with a gap */
      var gap = 46;
      if (w >= h) {
        var ix = x + Math.round(w * (0.45 + rnd() * 0.2));
        var g1 = y + T + Math.round(rnd() * (h - 2 * T - gap));
        seg(ix, y + T, T, g1 - (y + T));
        seg(ix, g1 + gap, T, (y + h - T) - (g1 + gap));
      } else {
        var iy = y + Math.round(h * (0.45 + rnd() * 0.2));
        var g2 = x + T + Math.round(rnd() * (w - 2 * T - gap));
        seg(x + T, iy, g2 - (x + T), T);
        seg(g2 + gap, iy, (x + w - T) - (g2 + gap), T);
      }
    }
  }

  function generate(seed) {
    var rnd = mulberry32(seed);
    var walls = [], doors = [], trees = [], fuses = [], waypoints = [], buildings = [];
    var plaza = { x: SIZE / 2, y: SIZE / 2, r: 180 };
    var cell = SIZE / 4;

    /* --- buildings on a jittered grid ring, center kept for the plaza --- */
    var spots = [];
    for (var gx = 0; gx < 4; gx++) for (var gy = 0; gy < 4; gy++) {
      if (gx >= 1 && gx <= 2 && gy >= 1 && gy <= 2) continue;
      spots.push([gx, gy]);
    }
    shuffle(spots, rnd);
    for (var s = 0; s < spots.length && buildings.length < 8; s++) {
      var bw = 150 + ((rnd() * 5) | 0) * 24, bh = 140 + ((rnd() * 5) | 0) * 24;
      var bx = clamp((spots[s][0] + 0.5) * cell - bw / 2 + (rnd() - 0.5) * cell * 0.45, 70, SIZE - 70 - bw);
      var by = clamp((spots[s][1] + 0.5) * cell - bh / 2 + (rnd() - 0.5) * cell * 0.45, 70, SIZE - 70 - bh);
      var b = { x: Math.round(bx), y: Math.round(by), w: bw, h: bh, i: buildings.length };
      var ok = true, k;
      for (k = 0; k < buildings.length; k++) if (rectsOverlap(b, buildings[k], 90)) { ok = false; break; }
      if (ok) {
        var cx = clamp(plaza.x, b.x, b.x + b.w), cy = clamp(plaza.y, b.y, b.y + b.h);
        var ddx = plaza.x - cx, ddy = plaza.y - cy;
        if (ddx * ddx + ddy * ddy < (plaza.r + 90) * (plaza.r + 90)) ok = false;
      }
      if (!ok) continue;
      buildings.push(b);
      buildWalls(b, rnd, walls, doors);
    }

    /* --- fuses: inside distinct buildings --- */
    var chosen = shuffle(buildings.slice(), rnd).slice(0, Math.min(5, buildings.length));
    for (var fi = 0; fi < chosen.length; fi++) {
      var bb = chosen[fi], fp = null;
      for (var tr2 = 0; tr2 < 16 && !fp; tr2++) {
        var fx = bb.x + 30 + rnd() * (bb.w - 60), fy = bb.y + 30 + rnd() * (bb.h - 60), clear = true;
        for (var wi = 0; wi < walls.length; wi++) if (pointInRect(fx, fy, walls[wi], 22)) { clear = false; break; }
        if (clear) fp = { x: Math.round(fx), y: Math.round(fy) };
      }
      if (fp) fuses.push({ id: fi, x: fp.x, y: fp.y, b: bb.i });
    }

    /* --- creature waypoints: just outside every door + open field --- */
    for (var di = 0; di < doors.length; di++) {
      var dr = doors[di], dcx = dr.x + dr.w / 2, dcy = dr.y + dr.h / 2, o = 46;
      var wx = dcx, wy = dcy;
      if (dr.side === 0) wy = dr.y - o;
      else if (dr.side === 2) wy = dr.y + dr.h + o;
      else if (dr.side === 3) wx = dr.x - o;
      else wx = dr.x + dr.w + o;
      waypoints.push({ x: Math.round(wx), y: Math.round(wy) });
    }
    for (var wp = 0; wp < 16; wp++) {
      var px = 120 + rnd() * (SIZE - 240), py = 120 + rnd() * (SIZE - 240), inside = false;
      for (var bi = 0; bi < buildings.length; bi++) if (pointInRect(px, py, buildings[bi], 60)) { inside = true; break; }
      if (!inside) waypoints.push({ x: Math.round(px), y: Math.round(py) });
    }
    waypoints.push({ x: plaza.x, y: plaza.y + plaza.r + 60 });

    var spawn = { x: Math.round(plaza.x), y: Math.round(plaza.y + plaza.r + 70) };

    /* --- trees --- */
    for (var ti = 0; ti < 500 && trees.length < 150; ti++) {
      var tx = 50 + rnd() * (SIZE - 100), ty = 50 + rnd() * (SIZE - 100), bad = false;
      var dpx = tx - plaza.x, dpy = ty - plaza.y;
      if (dpx * dpx + dpy * dpy < (plaza.r + 60) * (plaza.r + 60)) bad = true;
      if (!bad) for (var bi2 = 0; bi2 < buildings.length; bi2++) if (pointInRect(tx, ty, buildings[bi2], 46)) { bad = true; break; }
      if (!bad) for (var wp2 = 0; wp2 < waypoints.length; wp2++) {
        var dwx = tx - waypoints[wp2].x, dwy = ty - waypoints[wp2].y;
        if (dwx * dwx + dwy * dwy < 70 * 70) { bad = true; break; }
      }
      if (!bad) { var dsx = tx - spawn.x, dsy = ty - spawn.y; if (dsx * dsx + dsy * dsy < 130 * 130) bad = true; }
      if (!bad) trees.push({ x: Math.round(tx), y: Math.round(ty), r: 9, cr: 22 + Math.round(rnd() * 16) });
    }

    return { seed: seed, size: SIZE, plaza: plaza, buildings: buildings, walls: walls,
             doors: doors, trees: trees, fuses: fuses, waypoints: waypoints, spawn: spawn };
  }

  return { SIZE: SIZE, WALL_T: WALL_T, DOOR_W: DOOR_W, PR: PR, CR: CR,
           generate: generate, mulberry32: mulberry32, resolveCircle: resolveCircle,
           pointInRect: pointInRect, clamp: clamp };
});
