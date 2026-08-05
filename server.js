'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const WG = require('./shared/worldgen.js');

const PORT = process.env.PORT || 3000;
const TICK = 1 / 30, BCAST_EVERY = 2, MAX_PLAYERS = 8, GRACE = 12;
const COLORS = ['#c9b27c','#8fae7e','#7d9dc4','#c48a8a','#a98fc4','#7fbcb2','#c49c7d','#9aa8b8'];
const CSPD = { roam: 1.2, investigate: 2.8, search: 2.1, hunt: 5.5 };
const GAITS = { sneak: 1, walk: 2, run: 3 };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

const netServer = http.createServer((req, res) => {
  const p = req.url.split('?')[0];
  let file = null;
  if (p === '/') file = 'public/index.html';
  else if (p === '/worldgen.js') file = 'shared/worldgen.js';
  else if (p === '/game.js') file = 'public/game.js';
  if (!file) { res.writeHead(404); return res.end('404'); }
  fs.readFile(path.join(__dirname, file), (err, data) => {
    if (err) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});
const wss = new WebSocketServer({ server: netServer });

const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const R = v => Math.round(v * 10) / 10;
const clampN = v => Math.max(-1, Math.min(1, v));

function makeGame() {
  const seed = (Math.random() * 0xffffffff) >>> 0;
  const world = WG.generate(seed);
  const far = world.waypoints.reduce((b, w) => dist(w, world.spawn) > dist(b, world.spawn) ? w : b, world.waypoints[0]);
  return {
    seed, world, time: 0, roundT: 0, phase: 'play', phaseT: 0,
    cyc: 'night', cycT: WG.NIGHT,
    doors: world.doors.map(rect => ({ rect, open: false, breachT: 0 })),
    fuses: world.fuses.map(f => ({ id: f.id, x: f.x, z: f.z, st: 'ground', heldBy: null })),
    genN: 0, genTotal: world.fuses.length,
    creature: { x: far.x, z: far.z, dir: 0, state: 'roam', goal: null, target: null, lastKnown: null,
      huntT: 0, searchT: 0, subT: 0, searchC: null, idleT: 0, attackCd: 0, execT: 0, pauseT: 0,
      stuckT: 0, detourT: 0, detourSign: 1, senseT: 0, shriekCd: 0, roarT: 0 },
    rocksAir: [], events: [], solidsCache: null, solidsDirty: false
  };
}

/* ---------------- rooms ---------------- */
const rooms = new Map();
const CH = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function genCode() { let c; do { c = ''; for (let i = 0; i < 4; i++) c += CH[(Math.random() * CH.length) | 0]; } while (rooms.has(c)); return c; }
function createRoom(code) {
  const rm = { code, game: makeGame(), players: new Map(), idSeq: 0, tickN: 0, emptyAt: Date.now() };
  rm.timer = setInterval(() => tick(rm), TICK * 1000);
  return rm;
}
setInterval(() => {
  const now = Date.now();
  for (const [code, rm] of rooms) if (!rm.players.size && now - rm.emptyAt > 60000) { clearInterval(rm.timer); rooms.delete(code); }
}, 30000);

const pArr = rm => [...rm.players.values()];
function solids(rm) {
  const g = rm.game;
  if (g.solidsCache && !g.solidsDirty) return g.solidsCache;
  const arr = g.world.walls.slice();
  for (const d of g.doors) if (!d.open) { const r = Object.assign({}, d.rect); r.door = d; arr.push(r); }
  g.solidsCache = arr; g.solidsDirty = false;
  return arr;
}
function buildingAt(rm, pt) { for (const b of rm.game.world.buildings) if (WG.pointInRect(pt.x, pt.z, b)) return b; return null; }
function ev(rm, k, x, z, i, id, a) { rm.game.events.push({ k, x: R(x), z: R(z), i: +(i || 0).toFixed(2), id: id == null ? -1 : id, a: a == null ? -1 : a }); }
function nearestAlive(rm, x, z) {
  let best = null, bd = 1e18;
  for (const p of pArr(rm)) if (p.state === 'alive') { const d = Math.hypot(p.x - x, p.z - z); if (d < bd) { bd = d; best = p; } }
  return best;
}

function hear(rm, x, z, i, src) {
  const g = rm.game;
  if (g.phase !== 'play' || g.time < GRACE) return;
  const c = g.creature;
  if (g.cyc === 'day' && !(i >= 1.4 && Math.hypot(c.x - x, c.z - z) < 10)) return;
  if (src && src.state === 'down') i *= 1.35;
  const range = (4 + i * 9) * (c.state === 'hunt' ? 1.3 : 1);
  const d = Math.hypot(c.x - x, c.z - z);
  if (d > range || (i < 0.14 && d > 5)) return;
  c.lastKnown = { x, z };
  if (c.state === 'hunt') {
    const tp = c.target;
    if (tp && !tp.gone && tp.state !== 'dead' && (tp === src || Math.hypot(tp.x - x, tp.z - z) < 12)) c.huntT = 0;
    if (src && src.state === 'alive' && i >= 0.9 && (!tp || tp === src || dist(c, src) < dist(c, tp))) {
      if (c.target !== src) { c.target = src; c.huntT = 0; if (c.shriekCd <= 0) { ev(rm, 'shriek', c.x, c.z, 2.4); c.shriekCd = 7; } }
    }
    return;
  }
  c.goal = { x, z }; c.state = 'investigate';
  if (i >= 1.25 || d < 7) {
    const near = nearestAlive(rm, x, z);
    if (near) { c.target = near; c.state = 'hunt'; c.huntT = 0; if (c.shriekCd <= 0) { ev(rm, 'shriek', c.x, c.z, 2.4); c.shriekCd = 7; } }
  }
}
const emitNoise = (rm, x, z, i, kind, src) => { ev(rm, 'noise', x, z, i, src ? src.id : -1, kind); hear(rm, x, z, i, src || null); };

function respawn(rm, p) {
  const s = rm.game.world.spawn, a = Math.random() * 6.283, r = 1 + Math.random() * 3;
  Object.assign(p, { x: s.x + Math.cos(a) * r, z: s.z + Math.sin(a) * r, dir: -Math.PI / 2, state: 'alive',
    rv: 0, rvActive: false, fuse: null, rocks: 3, rockT: 0, stepAcc: 0, micCd: 0, pe: false, gait: 'walk' });
}
function dropFuse(rm, p) {
  if (p.fuse == null) return;
  const f = rm.game.fuses.find(f => f.id === p.fuse);
  if (f) { f.st = 'ground'; f.x = p.x; f.z = p.z; f.heldBy = null; }
  p.fuse = null;
}
function killPlayer(rm, p) { p.state = 'dead'; dropFuse(rm, p); ev(rm, 'dead', p.x, p.z, 0.6, p.id); }

function movePlayer(rm, p, dt) {
  if (p.state === 'dead') return;
  const g = rm.game, inp = p.input;
  let vx = inp.mx || 0, vz = inp.mz || 0;
  const len0 = Math.hypot(vx, vz);
  if (len0 < 0.01) { p.gait = 'idle'; return; }
  if (len0 > 1) { vx /= len0; vz /= len0; }
  const gait = inp.sneak ? 'sneak' : inp.run ? 'run' : 'walk';
  p.gait = gait;
  let spd = gait === 'run' ? 5.2 : gait === 'walk' ? 2.2 : 1.1;
  if (p.state === 'down') spd = 0.5;
  if (p.state === 'hurt') spd *= 0.8;
  if (p.fuse != null && gait === 'run') spd = 4.4;
  const res = WG.resolveCircle(p.x + vx * spd * dt, p.z + vz * spd * dt, WG.PR, solids(rm), g.world.trees, WG.SIZE);
  const moved = Math.hypot(res.x - p.x, res.z - p.z);
  p.x = res.x; p.z = res.z;
  if (moved > 0.0001) p.dir = Math.atan2(-vx, -vz);
  p.stepAcc = Math.min(3, p.stepAcc + moved);
  const stride = gait === 'run' ? 2.3 : gait === 'walk' ? 1.7 : 1.2;
  if (p.stepAcc >= stride) {
    p.stepAcc = 0;
    emitNoise(rm, p.x, p.z, p.state === 'down' ? 0.15 : gait === 'run' ? 1.1 : gait === 'walk' ? 0.42 : 0.1, 'step', p);
  }
}
const doorCenter = r => ({ x: r.x + r.w / 2, z: r.z + r.h / 2 });

function interact(rm, p) {
  const g = rm.game;
  for (const f of g.fuses) if (f.st === 'ground' && dist(p, f) < 1.7) {
    if (g.cyc !== 'night') return;
    if (p.fuse != null) return;
    f.st = 'held'; f.heldBy = p.id; p.fuse = f.id;
    ev(rm, 'pickup', f.x, f.z, 0.4, p.id);
    return;
  }
  if (p.fuse != null && dist(p, g.world.plaza) < 4) {
    const f = g.fuses.find(f => f.id === p.fuse);
    f.st = 'in'; p.fuse = null; g.genN++;
    ev(rm, 'install', g.world.plaza.x, g.world.plaza.z, 0.8, p.id);
    emitNoise(rm, g.world.plaza.x, g.world.plaza.z, 0.8, 'clank', p);
    if (g.genN >= g.genTotal) { g.phase = 'won'; g.phaseT = 12; ev(rm, 'win', g.world.plaza.x, g.world.plaza.z, 0); }
    return;
  }
  let best = null, bd = 2.2 * 2.2;
  for (const d of g.doors) { const dd = dist(p, doorCenter(d.rect)) ** 2; if (dd < bd) { bd = dd; best = d; } }
  if (best) {
    best.open = !best.open; best.breachT = 0; g.solidsDirty = true;
    const c = doorCenter(best.rect);
    ev(rm, 'door', c.x, c.z, best.open ? 1.0 : 0.45, p.id);
    emitNoise(rm, c.x, c.z, best.open ? 1.0 : 0.45, 'door', p);
  }
}

function careHold(rm, p, dt) {
  if (p.state === 'alive') {
    for (const q of pArr(rm)) if (q !== p && (q.state === 'down' || q.state === 'hurt') && dist(p, q) < 2) {
      q.rv = Math.min(1, q.rv + dt / (q.state === 'down' ? 3.2 : 2)); q.rvActive = true;
      if (q.rv >= 1) { const was = q.state; q.state = 'alive'; q.rv = 0; ev(rm, was === 'down' ? 'revive' : 'heal', q.x, q.z, 0.4, q.id, p.id); }
      return;
    }
  } else if (p.state === 'hurt' && p.input.e) {
    p.rv = Math.min(1, p.rv + dt / 4); p.rvActive = true;
    if (p.rv >= 1) { p.state = 'alive'; p.rv = 0; ev(rm, 'heal', p.x, p.z, 0.4, p.id, p.id); }
  }
}

function routeViaDoor(rm, c, goal) {
  const bG = buildingAt(rm, goal), bC = buildingAt(rm, c);
  const need = (bG && bG !== bC) ? bG : (!bG && bC ? bC : null);
  if (!need) return goal;
  let best = null, bd = 1e18;
  for (const d of rm.game.doors) {
    if (d.rect.b !== need.i) continue;
    const cc = doorCenter(d.rect), dd = dist(c, cc);
    if (dd < bd) { bd = dd; best = cc; }
  }
  return (best && bd > 1.2) ? best : goal;
}

function attackCheck(rm, dt) {
  const c = rm.game.creature;
  for (const p of pArr(rm)) if (p.state === 'down' && dist(p, c) < 1.0) {
    c.execT += dt; c.pauseT = Math.max(c.pauseT, 0.06);
    if (c.execT > 0.9) { killPlayer(rm, p); c.execT = 0; c.pauseT = 1.3; }
    return;
  }
  c.execT = 0;
  if (c.attackCd > 0) return;
  for (const p of pArr(rm)) if ((p.state === 'alive' || p.state === 'hurt') && dist(p, c) < 1.1) {
    if (p.state === 'alive') { p.state = 'hurt'; p.rv = 0; ev(rm, 'hit', p.x, p.z, 0.9, p.id); hear(rm, p.x, p.z, 0.9, p); }
    else { p.state = 'down'; p.rv = 0; ev(rm, 'down', p.x, p.z, 0.9, p.id); hear(rm, p.x, p.z, 0.9, p); }
    c.attackCd = 1.7; c.pauseT = 0.8;
    return;
  }
}

function updateCreature(rm, dt) {
  const g = rm.game, c = g.creature;
  c.attackCd = Math.max(0, c.attackCd - dt);
  c.shriekCd = Math.max(0, c.shriekCd - dt);
  if (g.phase !== 'play' || c.pauseT > 0) { c.pauseT -= dt; return; }
  if (g.cyc === 'day' && c.state === 'hunt') { c.state = 'roam'; c.goal = null; c.target = null; }
  c.senseT -= dt;
  if (c.senseT <= 0) { c.senseT = 0.55; for (const p of pArr(rm)) if (p.state === 'alive' && dist(p, c) < 2.5) { hear(rm, p.x, p.z, 0.32, p); break; } }
  switch (c.state) {
    case 'roam':
      if (c.idleT > 0) { c.idleT -= dt; c.goal = null; break; }
      if (!c.goal || dist(c, c.goal) < 1) {
        if (Math.random() < 0.4) { c.idleT = 0.8 + Math.random() * 1.8; c.goal = null; }
        else { const wp = g.world.waypoints[(Math.random() * g.world.waypoints.length) | 0]; c.goal = { x: wp.x, z: wp.z }; }
      }
      break;
    case 'investigate':
      if (!c.goal) { c.state = 'roam'; break; }
      if (dist(c, c.goal) < 1) { c.state = 'search'; c.searchT = 4.5; c.subT = 0; c.searchC = { x: c.goal.x, z: c.goal.z }; c.goal = null; }
      break;
    case 'search':
      c.searchT -= dt; c.subT -= dt;
      if (c.searchT <= 0) { c.state = 'roam'; c.goal = null; break; }
      if (c.subT <= 0) { c.subT = 1.1; const a = Math.random() * 6.283, rr = 2 + Math.random() * 6; c.goal = { x: c.searchC.x + Math.cos(a) * rr, z: c.searchC.z + Math.sin(a) * rr }; }
      break;
    case 'hunt': {
      const tp = c.target;
      if (!tp || tp.gone || tp.state === 'dead') { c.state = 'search'; c.searchC = c.lastKnown || { x: c.x, z: c.z }; c.searchT = 4; c.target = null; break; }
      c.huntT += dt;
      if (c.huntT > 3 && dist(tp, c) > 9) { c.state = 'search'; c.searchC = { x: tp.x, z: tp.z }; c.searchT = 5; c.target = null; break; }
      c.goal = { x: tp.x, z: tp.z };
      c.roarT = (c.roarT || 0) - dt;
      if (c.roarT <= 0) { c.roarT = 5 + Math.random() * 4; ev(rm, 'roar', c.x, c.z, 2.6); }
      break;
    }
  }
  attackCheck(rm, dt);
  let goal = c.state === 'hunt' && c.target ? c.goal : (c.goal || null);
  if (!goal) return;
  goal = routeViaDoor(rm, c, goal);
  const d = dist(c, goal) || 1;
  let dx = (goal.x - c.x) / d, dz = (goal.z - c.z) / d;
  if (c.detourT > 0) { c.detourT -= dt; const a = Math.atan2(dz, dx) + c.detourSign * 1.1; dx = Math.cos(a); dz = Math.sin(a); }
  let spd = CSPD[c.state] || 1.5;
  if (g.cyc === 'day') spd = Math.min(spd, 0.9);
  const res = WG.resolveCircle(c.x + dx * spd * dt, c.z + dz * spd * dt, WG.CR, solids(rm), g.world.trees, WG.SIZE);
  const moved = Math.hypot(res.x - c.x, res.z - c.z);
  c.x = res.x; c.z = res.z; c.dir = Math.atan2(dx, dz);
  c.moving = moved > spd * dt * 0.4;
  if (moved < spd * dt * 0.3 && spd > 0.2) {
    const hit = res.hits.find(h => h.door && !h.door.open);
    if (hit && c.state !== 'roam') {
      hit.door.breachT += dt;
      if (hit.door.breachT > 0.9) {
        hit.door.open = true; hit.door.breachT = 0; g.solidsDirty = true;
        const dc = doorCenter(hit.door.rect);
        ev(rm, 'breach', dc.x, dc.z, 2.2); emitNoise(rm, dc.x, dc.z, 2.2, 'breach', null);
      }
    } else { c.stuckT += dt; if (c.stuckT > 0.35) { c.stuckT = 0; c.detourT = 0.7; c.detourSign = Math.random() < 0.5 ? 1 : -1; } }
  } else c.stuckT = 0;
}

function updateRocks(rm, dt) {
  const g = rm.game;
  for (let i = g.rocksAir.length - 1; i >= 0; i--) {
    const r = g.rocksAir[i];
    r.x += r.vx * dt; r.z += r.vz * dt; r.vx *= (1 - 2.2 * dt); r.vz *= (1 - 2.2 * dt); r.life -= dt;
    const res = WG.resolveCircle(r.x, r.z, 0.1, solids(rm), g.world.trees, WG.SIZE);
    if (res.hits.length) { r.x = res.x; r.z = res.z; r.life = Math.min(r.life, 0.05); }
    if (r.life <= 0) { emitNoise(rm, r.x, r.z, 1.6, 'land', null); g.rocksAir.splice(i, 1); }
  }
}
function resetRound(rm) {
  rm.game = makeGame();
  for (const p of pArr(rm)) respawn(rm, p);
  sendAll(rm, { t: 'reset', seed: rm.game.seed, world: rm.game.world });
}
function sendAll(rm, msg) { const s = JSON.stringify(msg); for (const ws of rm.players.keys()) if (ws.readyState === 1) ws.send(s); }
function broadcast(rm) {
  const g = rm.game, c = g.creature;
  sendAll(rm, {
    t: 'state', ph: g.phase, pt: Math.ceil(Math.max(0, g.phaseT)), gr: Math.max(0, Math.ceil(GRACE - g.time)),
    cyc: { c: g.cyc, t: Math.ceil(g.cycT) },
    c: { x: R(c.x), z: R(c.z), d: +c.dir.toFixed(2), s: c.state, tg: c.target ? c.target.id : -1, m: c.moving ? 1 : 0 },
    p: pArr(rm).map(p => ({ id: p.id, x: R(p.x), z: R(p.z), d: +p.dir.toFixed(2),
      s: p.state === 'alive' ? 0 : p.state === 'hurt' ? 1 : p.state === 'down' ? 2 : 3,
      f: p.fuse != null ? 1 : 0, r: p.rocks, rv: +p.rv.toFixed(2), g: GAITS[p.gait] || 0, l: p.input.f ? 1 : 0 })),
    fu: g.fuses.map(f => f.st === 'ground' ? [f.id, R(f.x), R(f.z)] : f.st === 'held' ? [f.id, 'h'] : [f.id, 'i']),
    dn: g.doors.map(d => d.open ? 1 : 0), gn: g.genN, gt: g.genTotal, ev: g.events.splice(0)
  });
}
function tick(rm) {
  const dt = TICK, g = rm.game;
  g.time += dt; g.roundT += dt;
  if (g.phase === 'play') {
    g.cycT -= dt;
    if (g.cycT <= 0) {
      if (g.cyc === 'night') { g.cyc = 'day'; g.cycT = WG.DAY; ev(rm, 'dawn', 0, 0, 0); }
      else { g.cyc = 'night'; g.cycT = WG.NIGHT; ev(rm, 'dusk', 0, 0, 0); }
    }
    for (const p of pArr(rm)) p.rvActive = false;
    for (const p of pArr(rm)) {
      if (p.gone) continue;
      const edge = p.input.e && !p.pe; p.pe = p.input.e;
      movePlayer(rm, p, dt);
      if (edge && p.state !== 'dead') interact(rm, p);
      if (p.input.e || p.state === 'hurt') careHold(rm, p, dt);
      if (p.rocks < 3) { p.rockT += dt; if (p.rockT >= 22) { p.rockT = 0; p.rocks++; } }
    }
    for (const p of pArr(rm)) if ((p.state === 'down' || p.state === 'hurt') && !p.rvActive) p.rv = Math.max(0, p.rv - dt * 0.08);
    updateRocks(rm, dt); updateCreature
