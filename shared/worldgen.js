/* shared/worldgen.js — v3: villages, crashed plane, forest patches. Units: meters. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WorldGen = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var SIZE = 1400, WALL_T = 0.3, DOOR_W = 1.6, PR = 0.5, CR = 0.6;
  var NIGHT = 300, DAY = 600;

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function shuffle(arr, rnd) { for (var i = arr.length - 1; i > 0; i--) { var j = (rnd() * (i + 1)) | 0, t = arr[i]; arr[i] = arr[j]; arr[j] = t; } return arr; }
  function rectsOverlap(a, b, pad) { return a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.z < b.z + b.h + pad && a.z + a.h + pad > b.z; }
  function pointInRect(px, pz, r, pad) { pad = pad || 0; return px > r.x - pad && px < r.x + r.w + pad && pz > r.z - pad && pz < r.z + r.h + pad; }

  function h2(x, y) {
    var n = (x * 374761393 + y * 668265263) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  }
  function vnoise(x, y) {
    var ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    var a = h2(ix, iy), b = h2(ix + 1, iy), c = h2(ix, iy + 1), d = h2(ix + 1, iy + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }
  function roadX(z) { return SIZE / 2 + Math.sin(z * 0.011) * 52; }
  function roadZ(x) { return SIZE / 2 + Math.sin(x * 0.008) * 66; }
  function height(x, z) {
    var n = vnoise(x * 0.008, z * 0.008) * 6 + vnoise(x * 0.03, z * 0.03) * 1.4 - 3;
    var rd = Math.min(Math.abs(x - roadX(z)), Math.abs(z - roadZ(x)));
    var f = clamp((rd - 5) / 16, 0, 1);
    var dp = Math.hypot(x - SIZE / 2, z - SIZE / 2);
    var pf = clamp((dp - 34) / 30, 0, 1);
    var flat = Math.min(f, pf);
    return n * (0.12 + 0.88 * flat * flat) - (1 - f) * 0.35;
  }
  function forestN(x, z, off) { return vnoise(x * 0.004 + off, z * 0.004 - off) * 0.7 + vnoise(x * 0.013 + off, z * 0.013) * 0.3; }

  function circleRectResolve(px, pz, rad, rc) {
    var nx = clamp(px, rc.x, rc.x + rc.w), nz = clamp(pz, rc.z, rc.z + rc.h);
    var dx = px - nx, dz = pz - nz, d2 = dx * dx + dz * dz;
    if (d2 >= rad * rad) return null;
    if (d2 > 1e-9) { var d = Math.sqrt(d2), push = (rad - d) / d; return { x: px + dx * push, z: pz + dz * push }; }
    var l = px - rc.x, rr = rc.x + rc.w - px, t = pz - rc.z, b = rc.z + rc.h - pz;
    var m = Math.min(l, rr, t, b);
    if (m === l) return { x: rc.x - rad, z: pz };
    if (m === rr) return { x: rc.x + rc.w + rad, z: pz };
    if (m === t) return { x: px, z: rc.z - rad };
    return { x: px, z: rc.z + rc.h + rad };
  }
  function resolveCircle(px, pz, rad, rects, trees, size) {
    var hits = [];
    px = clamp(px, rad, size - rad); pz = clamp(pz, rad, size - rad);
    for (var pass = 0; pass < 2; pass++) {
      var i, res;
      for (i = 0; i < rects.length; i++) {
        res = circleRectResolve(px, pz, rad, rects[i]);
        if (res) { px = res.x; pz = res.z; hits.push(rects[i]); }
      }
      if (trees) for (i = 0; i < trees.length; i++) {
        var tr = trees[i], dx = px - tr.x, dz = pz - tr.z, rr = rad + tr.r, d2 = dx * dx + dz * dz;
        if (d2 < rr * rr) {
          if (d2 > 1e-9) { var d = Math.sqrt(d2); px = tr.x + dx / d * rr; pz = tr.z + dz / d * rr; }
          else px = tr.x + rr;
          hits.push(tr);
        }
      }
    }
    return { x: px, z: pz, hits: hits };
  }

  function buildWalls(b, rnd, walls, doors) {
    var T = WALL_T, D = DOOR_W, x = b.x, z = b.z, w = b.w, h = b.h;
    var sides = shuffle([0, 1, 2, 3], rnd);
    var defs = [{ s: sides[0], f: 0.25 + rnd() * 0.5 }];
    if (rnd() < 0.55 && w + h > 14) defs.push({ s: sides[1], f: 0.25 + rnd() * 0.5 });
    function doorFor(sd) { for (var i = 0; i < defs.length; i++) if (defs[i].s === sd) return defs[i]; return null; }
    function seg(ax, az, aw, ah) { if (aw > 0.05 && ah > 0.05) walls.push({ x: +ax.toFixed(2), z: +az.toFixed(2), w: +aw.toFixed(2), h: +ah.toFixed(2) }); }
    function side(sd) {
      var horiz = sd === 0 || sd === 2, len = horiz ? w : h, base = horiz ? x : z;
      function line(a0, a1) {
        if (a1 - a0 < 0.05) return;
        if (horiz) seg(base + a0, sd === 0 ? z : z + h - T, a1 - a0, T);
        else seg(sd === 3 ? x : x + w - T, base + a0, T, a1 - a0);
      }
      var dd = doorFor(sd);
      if (!dd) { line(0, len); return; }
      var gs = Math.round(dd.f * (len - D) * 100) / 100;
      line(0, gs); line(gs + D, len);
      var dr;
      if (horiz) dr = { x: base + gs, z: sd === 0 ? z : z + h - T, w: D, h: T };
      else dr = { x: sd === 3 ? x : x + w - T, z: base + gs, w: T, h: D };
      dr.b = b.i; dr.side = sd;
      doors.push(dr);
    }
    side(0); side(1); side(2); side(3);
    if (rnd() < 0.5 && w > 10 && h > 9) {
      var gap = 1.7;
      if (w >= h) {
        var ix = x + Math.round(w * (0.45 + rnd() * 0.2) * 10) / 10;
        var g1 = z + T + Math.round(rnd() * (h - 2 * T - gap) * 10) / 10;
        seg(ix, z + T, T, g1 - (z + T)); seg(ix, g1 + gap, T, (z + h - T) - (g1 + gap));
      } else {
        var iz = z + Math.round(h * (0.45 + rnd() * 0.2) * 10) / 10;
        var g2 = x + T + Math.round(rnd() * (w - 2 * T - gap) * 10) / 10;
        seg(x + T, iz, g2 - (x + T), T); seg(g2 + gap, iz, (x + w - T) - (g2 + gap), T);
      }
    }
  }

  function generate(seed) {
    var rnd = mulberry32(seed);
    var walls = [], doors = [], trees = [], fuses = [], waypoints = [], buildings = [];
    var plaza = { x: SIZE / 2, z: SIZE / 2, r: 30 };
    var fOff = rnd() * 100;

    /* two villages */
    var villages = [
      { x: SIZE * 0.26 + rnd() * 40, z: SIZE * 0.3 + rnd() * 40 },
      { x: SIZE * 0.74 - rnd() * 40, z: SIZE * 0.68 - rnd() * 40 }
    ];

    function houseAt(x, z, minW, maxW) {
      var bw = minW + rnd() * (maxW - minW), bh = minW - 1 + rnd() * (maxW - minW);
      var b = { x: +x.toFixed(1), z: +z.toFixed(1), w: +bw.toFixed(1), h: +bh.toFixed(1), i: buildings.length };
      var cx = b.x + b.w / 2, cz = b.z + b.h / 2;
      if (Math.min(Math.abs(cx - roadX(cz)), Math.abs(cz - roadZ(cx))) < 14) return null;
      if (Math.hypot(cx - plaza.x, cz - plaza.z) < 70) return null;
      for (var k = 0; k < buildings.length; k++) if (rectsOverlap(b, buildings[k], 10)) return null;
      for (var v = 0; v < villages.length; v++) if (Math.hypot(cx - villages[v].x, cz - villages[v].z) < 12) return null;
      buildings.push(b);
      buildWalls(b, rnd, walls, doors);
      return b;
    }

    /* village houses in a loose ring */
    villages.forEach(function (v) {
      var nH = 6 + ((rnd() * 2) | 0);
      for (var i = 0; i < nH; i++) {
        var a = (i / nH) * 6.283 + rnd() * 0.5;
        var r = 16 + rnd() * 12;
        houseAt(v.x + Math.cos(a) * r, v.z + Math.sin(a) * r, 6, 11);
      }
      waypoints.push({ x: v.x, z: v.z });
    });
    /* scattered abandoned farmhouses */
    for (var i = 0; i < 90 && buildings.length < 40; i++) {
      houseAt(70 + rnd() * (SIZE - 140), 70 + rnd() * (SIZE - 140), 6, 13);
    }

    /* crashed plane in a clearing */
    var plane = null;
    for (var pt = 0; pt < 80 && !plane; pt++) {
      var px = 140 + rnd() * (SIZE - 280), pz = 140 + rnd() * (SIZE - 280);
      if (forestN(px, pz, fOff) > 0.48) continue;
      if (Math.hypot(px - plaza.x, pz - plaza.z) < 90) continue;
      if (Math.min(Math.abs(px - roadX(pz)), Math.abs(pz - roadZ(px))) < 18) continue;
      var okP = true;
      for (var b2 = 0; b2 < buildings.length; b2++) if (pointInRect(px, pz, buildings[b2], 26)) { okP = false; break; }
      for (var v2 = 0; v2 < villages.length; v2++) if (Math.hypot(px - villages[v].x, pz - villages[v].z) < 60) okP = false;
      if (okP) plane = { x: +px.toFixed(1), z: +pz.toFixed(1), rot: +(rnd() * 6.283).toFixed(2) };
    }
    if (plane) waypoints.push({ x: plane.x, z: plane.z });

    /* fuses: one at the wreck, rest in houses */
    var chosen = shuffle(buildings.slice(), rnd).slice(0, 4);
    fuses.push({ id: 0, x: plane ? +(plane.x + 4).toFixed(1) : plaza.x, z: plane ? +(plane.z + 3).toFixed(1) : plaza.z, b: -1 });
    for (var fi = 0; fi < chosen.length; fi++) {
      var bb = chosen[fi], fp = null;
      for (var t2 = 0; t2 < 16 && !fp; t2++) {
        var fx = bb.x + 1.2 + rnd() * (bb.w - 2.4), fz = bb.z + 1.2 + rnd() * (bb.h - 2.4), clear = true;
        for (var wi = 0; wi < walls.length; wi++) if (pointInRect(fx, fz, walls[wi], 0.8)) { clear = false; break; }
        if (clear) fp = { x: +fx.toFixed(1), z: +fz.toFixed(1) };
      }
      if (fp) fuses.push({ id: fi + 1, x: fp.x, z: fp.z, b: bb.i });
    }

    for (var di = 0; di < doors.length; di++) {
      var dr = doors[di], dcx = dr.x + dr.w / 2, dcz = dr.z + dr.h / 2, o = 2;
      var wx = dcx, wz = dcz;
      if (dr.side === 0) wz = dr.z - o; else if (dr.side === 2) wz = dr.z + dr.h + o;
      else if (dr.side === 3) wx = dr.x - o; else wx = dr.x + dr.w + o;
      waypoints.push({ x: +wx.toFixed(1), z: +wz.toFixed(1) });
    }
    for (var wp = 0; wp < 40; wp++) {
      var wpx = 60 + rnd() * (SIZE - 120), wpz = 60 + rnd() * (SIZE - 120), inside = false;
      for (var bi = 0; bi < buildings.length; bi++) if (pointInRect(wpx, wpz, buildings[bi], 4)) { inside = true; break; }
      if (!inside) waypoints.push({ x: +wpx.toFixed(1), z: +wpz.toFixed(1) });
    }
    var spawn = { x: plaza.x, z: plaza.z + plaza.r + 12 };

    /* forest-patch trees */
    for (var ti = 0; ti < 6000 && trees.length < 950; ti++) {
      var tx = 40 + rnd() * (SIZE - 80), tz = 40 + rnd() * (SIZE - 80);
      var fn = forestN(tx, tz, fOff);
      if (fn < 0.42 && rnd() > 0.06) continue;               // dense woods + sparse field trees
      if (fn > 0.42 && fn < 0.55 && rnd() > 0.35) continue;
      var bad = false;
      if (Math.min(Math.abs(tx - roadX(tz)), Math.abs(tz - roadZ(tx))) < 7) bad = true;
      if (!bad && Math.hypot(tx - plaza.x, tz - plaza.z) < 45) bad = true;
      if (!bad && plane && Math.hypot(tx - plane.x, tz - plane.z) < 24) bad = true;
      if (!bad) for (var bi2 = 0; bi2 < buildings.length; bi2++) if (pointInRect(tx, tz, buildings[bi2], 3)) { bad = true; break; }
      if (!bad) for (var vv = 0; vv < villages.length; vv++) if (Math.hypot(tx - villages[vv].x, tz - villages[vv].z) < 14) bad = true;
      if (!bad) { var dsx = tx - spawn.x, dsz = tz - spawn.z; if (dsx * dsx + dsz * dsz < 400) bad = true; }
      if (!bad) trees.push({ x: +tx.toFixed(1), z: +tz.toFixed(1), r: 0.35, cr: +(2.2 + rnd() * 2.0).toFixed(1) });
    }

    return { seed: seed, size: SIZE, plaza: plaza, villages: villages, plane: plane, buildings: buildings,
             walls: walls, doors: doors, trees: trees, fuses: fuses, waypoints: waypoints, spawn: spawn, fOff: fOff };
  }

  return { SIZE: SIZE, WALL_T: WALL_T, DOOR_W: DOOR_W, PR: PR, CR: CR, NIGHT: NIGHT, DAY: DAY,
           generate: generate, mulberry32: mulberry32, resolveCircle: resolveCircle, pointInRect: pointInRect,
           height: height, roadX: roadX, roadZ: roadZ, vnoise: vnoise, forestN: forestN, clamp: clamp };
});
