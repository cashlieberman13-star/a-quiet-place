'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const WG = require('./shared/worldgen.js');

const PORT = process.env.PORT || 3000;
const TICK = 1 / 30, BCAST_EVERY = 2, MAX_PLAYERS = 8, GRACE = 12;
const COLORS = ['#c9b27c','#8fae7e','#7d9dc4','#c48a8a','#a98fc4','#7fbcb2','#c49c7d','#9aa8b8'];
const SPEEDS = { roam: 46, investigate: 100, search: 72, hunt: 192 };
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

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const R = v => Math.round(v);

function makeGame() {
  const seed = (Math.random() * 0xffffffff) >>> 0;
  const world = WG.generate(seed);
  const far = world.waypoints.reduce((b, w) => dist(w, world.spawn) > dist(b, world.spawn) ? w : b, world.waypoints[0]);
  return {
    seed, world, time: 0, roundT: 0, phase: 'play', phaseT: 0,
    doors: world.doors.map(rect => ({ rect, open: false, breachT: 0 })),
    fuses: world.fuses.map(f => ({ id: f.id, x: f.x, y: f.y, st: 'ground', heldBy: null })),
    genN: 0, genTotal: world.fuses.length,
    creature: { x: far.x, y: far.y, dir: 0, state: 'roam', goal: null, target: null, lastKnown: null,
      huntT: 0, searchT: 0, subT: 0, searchC: null, idleT: 0, attackCd: 0, execT: 0, pauseT: 0,
      stuckT: 0, detourT: 0, detourSign: 1, senseT: 0, shriekCd: 0 },
    rocksAir: [], events: [], solidsCache: null, solidsDirty: false
  };
}

/* ------------------------- rooms ------------------------- */
const rooms = new Map();
const CH = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function genCode() {
  let c;
  do { c = ''; for (let i = 0; i < 4; i++) c += CH[(Math.random() * CH.length) | 0]; } while (rooms.has(c));
  return c;
}
function createRoom(code) {
  const rm = { code, game: makeGame(), players: new Map(), idSeq: 0, tickN: 0, emptyAt: Date.now() };
  rm.timer = setInterval(() => tick(rm), TICK * 1000);
  return rm;
}
setInterval(() => {
  const now = Date.now();
  for (const [code, rm] of rooms) if (!rm.players.size && now - rm.emptyAt > 60000) {
    clearInterval(rm.timer); rooms.delete(code);
  }
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
function buildingAt(rm, pt) { for (const b of rm.game.world.buildings) if (WG.pointInRect(pt.x, pt.y, b)) return b; return null; }
function ev(rm, k, x, y, i, id, a) { rm.game.events.push({ k, x: R(x), y: R(y), i: +(i || 0).toFixed(2), id: id == null ? -1 : id, a: a == null ? -1 : a }); }
function nearestAlive(rm, x, y) {
  let best = null, bd = 1e18;
  for (const p of pArr(rm)) if (p.state === 'alive') { const d = Math.hypot(p.x - x, p.y - y); if (d < bd) { bd = d; best = p; } }
  return best;
}

function hear(rm, x, y, i, src) {
  const g = rm.game;
  if (g.phase !== 'play' || g.roundT < GRACE) return;
  const c = g.creature;
  if (src && src.state === 'down') i *= 1.35;
  const range = (90 + i * 250) * (c.state === 'hunt' ? 1.3 : 1);
  const d = Math.hypot(c.x - x, c.y - y);
  if (d > range || (i < 0.14 && d > 140)) return;
  c.lastKnown = { x, y };
  if (c.state === 'hunt') {
    const tp = c.target;
    if (tp && !tp.gone && tp.state !== 'dead' && (tp === src || Math.hypot(tp.x - x, tp.y - y) < 320)) c.huntT = 0;
    if (src && src.state === 'alive' && i >= 0.9 && (!tp || tp === src || dist(c, src) < dist(c, tp))) {
      if (c.target !== src) { c.target = src; c.huntT = 0; if (c.shriekCd <= 0) { ev(rm, 'shriek', c.x, c.y, 2.4); c.shriekCd = 7; } }
    }
    return;
  }
  c.goal = { x, y }; c.state = 'investigate';
  if (i >= 1.25 || d < 170) {
    const near = nearestAlive(rm, x, y);
    if (near) { c.target = near; c.state = 'hunt'; c.huntT = 0; if (c.shriekCd <= 0) { ev(rm, 'shriek', c.x, c.y, 2.4); c.shriekCd = 7; } }
  }
}
const emitNoise = (rm, x, y, i, kind, src) => { ev(rm, 'noise', x, y, i, src ? src.id : -1, kind); hear(rm, x, y, i, src || null); };

function respawn(rm, p) {
  const s = rm.game.world.spawn, a = Math.random() * 6.283, r = 20 + Math.random() * 50;
  Object.assign(p, { x: s.x + Math.cos(a) * r, y: s.y + Math.sin(a) * r, dir: -Math.PI / 2, state: 'alive',
    rv: 0, rvActive: false, fuse: null, rocks: 3, rockT: 0, stepAcc: 0, micCd: 0, pe: false, gait: 'walk' });
}
function dropFuse(rm, p) {
  if (p.fuse == null) return;
  const f = rm.game.fuses.find(f => f.id === p.fuse);
  if (f) { f.st = 'ground'; f.x = p.x; f.y = p.y; f.heldBy = null; }
  p.fuse = null;
}
function downPlayer(rm, p) { p.state = 'down'; p.rv = 0; ev(rm, 'down', p.x, p.y, 0.9, p.id); hear(rm, p.x, p.y, 0.9, p); }
function killPlayer(rm, p) { p.state = 'dead'; dropFuse(rm, p); ev(rm, 'dead', p.x, p.y, 0.6, p.id); }

function movePlayer(rm, p, dt) {
  if (p.state === 'dead') return;
  const g = rm.game, inp = p.input;
  let vx = (inp.r ? 1 : 0) - (inp.l ? 1 : 0), vy = (inp.d ? 1 : 0) - (inp.u ? 1 : 0);
  if (!vx && !vy) { p.gait = 'idle'; return; }
  const len = Math.hypot(vx, vy); vx /= len; vy /= len;
  const gait = inp.sneak ? 'sneak' : inp.run ? 'run' : 'walk';
  p.gait = gait;
  let spd = gait === 'run' ? 205 : gait === 'walk' ? 130 : 62;
  if (p.state === 'down') spd = 30;
  if (p.fuse != null && gait === 'run') spd = 170;
  const res = WG.resolveCircle(p.x + vx * spd * dt, p.y + vy * spd * dt, WG.PR, solids(rm), g.world.trees, WG.SIZE);
  const moved = Math.hypot(res.x - p.x, res.y - p.y);
  p.x = res.x; p.y = res.y; p.dir = Math.atan2(vy, vx);
  p.stepAcc = Math.min(60, p.stepAcc + moved);
  const stride = gait === 'run' ? 46 : gait === 'sneak' ? 30 : 36;
  if (p.stepAcc >= stride) {
    p.stepAcc = 0;
    emitNoise(rm, p.x, p.y, p.state === 'down' ? 0.15 : gait === 'run' ? 1.1 : gait === 'walk' ? 0.42 : 0.1, 'step', p);
  }
}
const doorCenter = r => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

function interact(rm, p) {
  const g = rm.game;
  for (const f of g.fuses) if (f.st === 'ground' && dist(p, f) < 34) {
    f.st = 'held'; f.heldBy = p.id; p.fuse = f.id; ev(rm, 'pickup', f.x, f.y, 0.4, p.id); return;
  }
  if (p.fuse != null && dist(p, g.world.plaza) < 70) {
    const f = g.fuses.find(f => f.id === p.fuse);
    f.st = 'in'; p.fuse = null; g.genN++;
    ev(rm, 'install', g.world.plaza.x, g.world.plaza.y, 0.8, p.id);
    emitNoise(rm, g.world.plaza.x, g.world.plaza.y, 0.8, 'clank', p);
    if (g.genN >= g.genTotal) { g.phase = 'won'; g.phaseT = 12; ev(rm, 'win', g.world.plaza.x, g.world.plaza.y, 0); }
    return;
  }
  let best = null, bd = 44 * 44;
  for (const d of g.doors) { const dd = dist(p, doorCenter(d.rect)) ** 2; if (dd < bd) { bd = dd; best = d; } }
  if (best) {
    best.open = !best.open; best.breachT = 0; g.solidsDirty = true;
    const c = doorCenter(best.rect);
    ev(rm, 'door', c.x, c.y, best.open ? 1.0 : 0.45, p.id);
    emitNoise(rm, c.x, c.y, best.open ? 1.0 : 0.45, 'door', p);
  }
}
function reviveHold(rm, p, dt) {
  if (p.state !== 'alive') return;
  for (const q of pArr(rm)) if (q !== p && q.state === 'down' && dist(p, q) < 48) {
    q.rv = Math.min(1, q.rv + dt / 3.2); q.rvActive = true;
    if (q.rv >= 1) { q.state = 'alive'; q.rv = 0; ev(rm, 'revive', q.x, q.y, 0.4, q.id, p.id); }
    return;
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
  return (best && bd > 30) ? best : goal;
}
function attackCheck(rm, dt) {
  const c = rm.game.creature;
  for (const p of pArr(rm)) if (p.state === 'down' && dist(p, c) < 24) {
    c.execT += dt; c.pauseT = Math.max(c.pauseT, 0.06);
    if (c.execT > 0.9) { killPlayer(rm, p); c.execT = 0; c.pauseT = 1.3; }
    return;
  }
  c.execT = 0;
  if (c.attackCd > 0) return;
  for (const p of pArr(rm)) if (p.state === 'alive' && dist(p, c) < 26) { downPlayer(rm, p); c.attackCd = 1.7; c.pauseT = 0.8; return; }
}
function updateCreature(rm, dt) {
  const g = rm.game, c = g.creature;
  c.attackCd = Math.max(0, c.attackCd - dt);
  c.shriekCd = Math.max(0, c.shriekCd - dt);
  if (g.phase !== 'play' || c.pauseT > 0) { c.pauseT -= dt; return; }
  c.senseT -= dt;
  if (c.senseT <= 0) { c.senseT = 0.55; for (const p of pArr(rm)) if (p.state === 'alive' && dist(p, c) < 70) { hear(rm, p.x, p.y, 0.32, p); break; } }
  switch (c.state) {
    case 'roam':
      if (c.idleT > 0) { c.idleT -= dt; c.goal = null; break; }
      if (!c.goal || dist(c, c.goal) < 24) {
        if (Math.random() < 0.4) { c.idleT = 0.8 + Math.random() * 1.8; c.goal = null; }
        else { const wp = g.world.waypoints[(Math.random() * g.world.waypoints.length) | 0]; c.goal = { x: wp.x, y: wp.y }; }
      }
      break;
    case 'investigate':
      if (!c.goal) { c.state = 'roam'; break; }
      if (dist(c, c.goal) < 22) { c.state = 'search'; c.searchT = 4.5; c.subT = 0; c.searchC = { x: c.goal.x, y: c.goal.y }; c.goal = null; }
      break;
    case 'search':
      c.searchT -= dt; c.subT -= dt;
      if (c.searchT <= 0) { c.state = 'roam'; c.goal = null; break; }
      if (c.subT <= 0) { c.subT = 1.1; const a = Math.random() * 6.283, rr = 40 + Math.random() * 130; c.goal = { x: c.searchC.x + Math.cos(a) * rr, y: c.searchC.y + Math.sin(a) * rr }; }
      break;
    case 'hunt': {
      const tp = c.target;
      if (!tp || tp.gone || tp.state === 'dead') { c.state = 'search'; c.searchC = c.lastKnown || { x: c.x, y: c.y }; c.searchT = 4; c.target = null; break; }
      c.huntT += dt;
      if (c.huntT > 2.6 && dist(tp, c) > 230) { c.state = 'search'; c.searchC = { x: tp.x, y: tp.y }; c.searchT = 5; c.target = null; break; }
      c.goal = { x: tp.x, y: tp.y };
      break;
    }
  }
  attackCheck(rm, dt);
  let goal = c.state === 'hunt' && c.target ? c.goal : (c.goal || null);
  if (!goal) return;
  goal = routeViaDoor(rm, c, goal);
  const d = dist(c, goal) || 1;
  let dx = (goal.x - c.x) / d, dy = (goal.y - c.y) / d;
  if (c.detourT > 0) { c.detourT -= dt; const a = Math.atan2(dy, dx) + c.detourSign * 1.1; dx = Math.cos(a); dy = Math.sin(a); }
  const spd = SPEEDS[c.state] || 50;
  const res = WG.resolveCircle(c.x + dx * spd * dt, c.y + dy * spd * dt, WG.CR, solids(rm), g.world.trees, WG.SIZE);
  const moved = Math.hypot(res.x - c.x, res.y - c.y);
  c.x = res.x; c.y = res.y; c.dir = Math.atan2(dy, dx);
  if (moved < spd * dt * 0.3 && spd > 10) {
    const hit = res.hits.find(h => h.door && !h.door.open);
    if (hit && c.state !== 'roam') {
      hit.door.breachT += dt;
      if (hit.door.breachT > 0.9) {
        hit.door.open = true; hit.door.breachT = 0; g.solidsDirty = true;
        const dc = doorCenter(hit.door.rect);
        ev(rm, 'breach', dc.x, dc.y, 2.2); emitNoise(rm, dc.x, dc.y, 2.2, 'breach', null);
      }
    } else { c.stuckT += dt; if (c.stuckT > 0.35) { c.stuckT = 0; c.detourT = 0.7; c.detourSign = Math.random() < 0.5 ? 1 : -1; } }
  } else c.stuckT = 0;
}
function updateRocks(rm, dt) {
  const g = rm.game;
  for (let i = g.rocksAir.length - 1; i >= 0; i--) {
    const r = g.rocksAir[i];
    r.x += r.vx * dt; r.y += r.vy * dt; r.vx *= (1 - 2.2 * dt); r.vy *= (1 - 2.2 * dt); r.life -= dt;
    const res = WG.resolveCircle(r.x, r.y, 3, solids(rm), g.world.trees, WG.SIZE);
    if (res.hits.length) { r.x = res.x; r.y = res.y; r.life = Math.min(r.life, 0.05); }
    if (r.life <= 0) { emitNoise(rm, r.x, r.y, 1.6, 'land', null); g.rocksAir.splice(i, 1); }
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
    t: 'state', ph: g.phase, pt: Math.ceil(Math.max(0, g.phaseT)), gr: Math.max(0, Math.ceil(GRACE - g.roundT)),
    c: { x: R(c.x), y: R(c.y), d: +c.dir.toFixed(2), s: c.state, tg: c.target ? c.target.id : -1 },
    p: pArr(rm).map(p => ({ id: p.id, x: R(p.x), y: R(p.y), d: +p.dir.toFixed(2),
      s: p.state === 'alive' ? 0 : p.state === 'down' ? 1 : 2, f: p.fuse != null ? 1 : 0, r: p.rocks, rv: +p.rv.toFixed(2), g: GAITS[p.gait] || 0 })),
    fu: g.fuses.map(f => f.st === 'ground' ? [f.id, R(f.x), R(f.y)] : f.st === 'held' ? [f.id, 'h'] : [f.id, 'i']),
    dn: g.doors.map(d => d.open ? 1 : 0), gn: g.genN, gt: g.genTotal, ev: g.events.splice(0)
  });
}
function tick(rm) {
  const dt = TICK, g = rm.game;
  g.time += dt; g.roundT += dt;
  if (g.phase === 'play') {
    for (const p of pArr(rm)) p.rvActive = false;
    for (const p of pArr(rm)) {
      if (p.gone) continue;
      const edge = p.input.e && !p.pe; p.pe = p.input.e;
      movePlayer(rm, p, dt);
      if (edge && p.state !== 'dead') interact(rm, p);
      if (p.input.e) reviveHold(rm, p, dt);
      if (p.rocks < 3) { p.rockT += dt; if (p.rockT >= 22) { p.rockT = 0; p.rocks++; } }
    }
    for (const p of pArr(rm)) if (p.state === 'down' && !p.rvActive) p.rv = Math.max(0, p.rv - dt * 0.08);
    updateRocks(rm, dt); updateCreature(rm, dt);
    const ps = pArr(rm);
    if (ps.length && ps.every(p => p.state === 'dead')) { g.phase = 'lost'; g.phaseT = 10; ev(rm, 'lose', 0, 0, 0); }
  } else { g.phaseT -= dt; if (g.phaseT <= 0) resetRound(rm); }
  if (++rm.tickN % BCAST_EVERY === 0) broadcast(rm);
}

/* ------------------------- websocket ------------------------- */
wss.on('connection', ws => {
  ws.on('message', raw => onMsg(ws, raw));
  ws.on('close', () => leave(ws));
});
setInterval(() => {
  for (const rm of rooms.values()) for (const ws of rm.players.keys()) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 25000);

function join(rm, ws, nameRaw) {
  const name = String(nameRaw || 'SURVIVOR').replace(/[^\w \-]/g, '').slice(0, 14).toUpperCase() || 'SURVIVOR';
  const used = new Set(pArr(rm).map(q => q.color));
  const color = COLORS.find(c => !used.has(c)) || COLORS[rm.players.size % COLORS.length];
  const p = { id: ++rm.idSeq, name, color, ws, input: { u: 0, d: 0, l: 0, r: 0, run: 0, sneak: 0, e: 0 } };
  rm.players.set(ws, p);
  ws.ctx = { rm, p }; ws.isAlive = true;
  ws.on('pong', () => ws.isAlive = true);
  respawn(rm, p); rm.emptyAt = 0;
  ws.send(JSON.stringify({
    t: 'welcome', id: p.id, color, room: rm.code, seed: rm.game.seed, world: rm.game.world,
    grace: GRACE, phase: rm.game.phase,
    roster: pArr(rm).filter(q => q !== p).map(q => ({ id: q.id, name: q.name, color: q.color }))
  }));
  for (const [ws2, q] of rm.players) if (q !== p && ws2.readyState === 1) ws2.send(JSON.stringify({ t: 'peer', id: p.id, name, color }));
}
function leave(ws) {
  const ctx = ws.ctx; if (!ctx) return;
  const { rm, p } = ctx;
  p.gone = true; dropFuse(rm, p); rm.players.delete(ws);
  if (rm.game.creature.target === p) rm.game.creature.target = null;
  sendAll(rm, { t: 'leave', id: p.id });
  if (!rm.players.size) rm.emptyAt = Date.now();
}
function onMsg(ws, raw) {
  let m; try { m = JSON.parse(raw); } catch { return; }
  if (m.t === 'join') {
    if (ws.ctx) return;
    let code = String(m.room || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    let rm = code ? rooms.get(code) : null;
    if (!rm) { code = code || genCode(); rm = createRoom(code); rooms.set(code, rm); }
    if (rm.players.size >= MAX_PLAYERS) { ws.send(JSON.stringify({ t: 'full' })); return; }
    join(rm, ws, m.name);
    return;
  }
  const ctx = ws.ctx; if (!ctx) return;
  const { rm, p } = ctx, g = rm.game;
  if (m.t === 'input') Object.assign(p.input, { u: !!m.u, d: !!m.d, l: !!m.l, r: !!m.r, run: !!m.run, sneak: !!m.sneak, e: !!m.e });
  else if (m.t === 'noise') {
    if (p.state === 'dead' || g.phase !== 'play' || p.micCd > g.time) return;
    p.micCd = g.time + 0.15;
    emitNoise(rm, p.x, p.y, 0.45 + Math.min(1, Math.max(0, +m.v || 0)) * 2.3, 'voice', p);
  } else if (m.t === 'throw') {
    if (p.state !== 'alive' || p.rocks <= 0) return;
    const len = Math.hypot(m.dx, m.dy) || 1, dx = m.dx / len, dy = m.dy / len;
    p.rocks--; p.rockT = 0;
    g.rocksAir.push({ x: p.x + dx * 14, y: p.y + dy * 14, vx: dx * 420, vy: dy * 420, life: 0.62 });
    ev(rm, 'thrown', p.x, p.y, 0.2, p.id);
    const e = g.events[g.events.length - 1]; e.dx = +dx.toFixed(2); e.dy = +dy.toFixed(2);
  }
}

netServer.listen(PORT, () => console.log('a quiet place → port ' + PORT));
