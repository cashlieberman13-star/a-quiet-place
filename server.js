'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const WG = require('./shared/worldgen.js');

const PORT = process.env.PORT || 3000;
const TICK = 1 / 30, BCAST_EVERY = 2, MAX_PLAYERS = 8, GRACE = 12;
const COLORS = ['#c9b27c', '#8fae7e', '#7d9dc4', '#c48a8a', '#a98fc4', '#7fbcb2', '#c49c7d', '#9aa8b8'];
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
const players = new Map();
let idSeq = 0;

function makeGame() {
  const seed = (Math.random() * 0xffffffff) >>> 0;
  const world = WG.generate(seed);
  const far = world.waypoints.reduce((best, w) => dist(w, world.spawn) > dist(best, world.spawn) ? w : best, world.waypoints[0]);
  return {
    seed, world, time: 0, roundT: 0, phase: 'play', phaseT: 0,
    doors: world.doors.map(rect => ({ rect, open: false, breachT: 0 })),
    fuses: world.fuses.map(f => ({ id: f.id, x: f.x, y: f.y, st: 'ground', heldBy: null })),
    genN: 0, genTotal: world.fuses.length,
    creature: { x: far.x, y: far.y, dir: 0, state: 'roam', goal: null, target: null, lastKnown: null,
                huntT: 0, searchT: 0, subT: 0, searchC: null, idleT: 0, attackCd: 0, execT: 0,
                pauseT: 0, stuckT: 0, detourT: 0, detourSign: 1, senseT: 0, shriekCd: 0 },
    rocksAir: [], events: [], solidsCache: null, solidsDirty: false
  };
}
let game = makeGame();
const playersArr = () => [...players.values()];

function solids() {
  if (game.solidsCache && !game.solidsDirty) return game.solidsCache;
  const arr = game.world.walls.slice();
  for (const d of game.doors) if (!d.open) { const r = Object.assign({}, d.rect); r.door = d; arr.push(r); }
  game.solidsCache = arr; game.solidsDirty = false;
  return arr;
}
function buildingAt(pt) { for (const b of game.world.buildings) if (WG.pointInRect(pt.x, pt.y, b)) return b; return null; }
function ev(k, x, y, i, id, a) { game.events.push({ k, x: R(x), y: R(y), i: +(i || 0).toFixed(2), id: id == null ? -1 : id, a: a == null ? -1 : a }); }

function nearestAlive(x, y) {
  let best = null, bd = Infinity;
  for (const p of playersArr()) if (p.state === 'alive') { const d = Math.hypot(p.x - x, p.y - y); if (d < bd) { bd = d; best = p; } }
  return best;
}

function hear(x, y, i, src) {
  if (game.phase !== 'play' || game.roundT < GRACE) return;
  const c = game.creature;
  if (src && src.state === 'down') i *= 1.35;
  const range = (90 + i * 250) * (c.state === 'hunt' ? 1.3 : 1);
  const d = Math.hypot(c.x - x, c.y - y);
  if (d > range || (i < 0.14 && d > 140)) return;
  c.lastKnown = { x, y };
  if (c.state === 'hunt') {
    const tp = c.target;
    if (tp && !tp.gone && tp.state !== 'dead' && (tp === src || Math.hypot(tp.x - x, tp.y - y) < 320)) c.huntT = 0;
    if (src && src.state === 'alive' && i >= 0.9) {
      if (!tp || tp === src || dist(c, src) < dist(c, tp)) {
        if (c.target !== src) { c.target = src; c.huntT = 0; if (c.shriekCd <= 0) { ev('shriek', c.x, c.y, 2.4); c.shriekCd = 7; } }
      }
    }
    return;
  }
  c.goal = { x, y }; c.state = 'investigate';
  if (i >= 1.25 || d < 170) {
    const near = nearestAlive(x, y);
    if (near) { c.target = near; c.state = 'hunt'; c.huntT = 0; if (c.shriekCd <= 0) { ev('shriek', c.x, c.y, 2.4); c.shriekCd = 7; } }
  }
}
const emitNoise = (x, y, i, kind, src) => { ev('noise', x, y, i, src ? src.id : -1, kind); hear(x, y, i, src || null); };

function spawnPos() { const a = Math.random() * Math.PI * 2, r = 20 + Math.random() * 50; return { x: game.world.spawn.x + Math.cos(a) * r, y: game.world.spawn.y + Math.sin(a) * r }; }
function respawn(p) {
  const s = spawnPos();
  Object.assign(p, { x: s.x, y: s.y, dir: -Math.PI / 2, state: 'alive', rv: 0, rvActive: false, fuse: null, rocks: 3, rockT: 0, stepAcc: 0, micCd: 0, pe: false, gait: 'walk' });
}
function dropFuse(p) {
  if (p.fuse == null) return;
  const f = game.fuses.find(f => f.id === p.fuse);
  if (f) { f.st = 'ground'; f.x = p.x; f.y = p.y; f.heldBy = null; }
  p.fuse = null;
}
function downPlayer(p) { p.state = 'down'; p.rv = 0; ev('down', p.x, p.y, 0.9, p.id); hear(p.x, p.y, 0.9, p); }
function killPlayer(p) { p.state = 'dead'; dropFuse(p); ev('dead', p.x, p.y, 0.6, p.id); }

function movePlayer(p, dt) {
  if (p.state === 'dead') return;
  const inp = p.input;
  let vx = (inp.r ? 1 : 0) - (inp.l ? 1 : 0), vy = (inp.d ? 1 : 0) - (inp.u ? 1 : 0);
  if (!vx && !vy) { p.gait = 'idle'; return; }
  const len = Math.hypot(vx, vy); vx /= len; vy /= len;
  const gait = inp.sneak ? 'sneak' : (inp.run ? 'run' : 'walk');
  p.gait = gait;
  let spd = gait === 'run' ? 205 : gait === 'walk' ? 130 : 62;
  if (p.state === 'down') spd = 30;
  if (p.fuse != null && gait === 'run') spd = 170;
  const res = WG.resolveCircle(p.x + vx * spd * dt, p.y + vy * spd * dt, WG.PR, solids(), game.world.trees, WG.SIZE);
  p.x = res.x; p.y = res.y; p.dir = Math.atan2(vy, vx);
  p.stepAcc += Math.hypot(res.x - p.x, res.y - p.y) || 0;
  p.stepAcc = Math.min(p.stepAcc, 60);
  const stride = gait === 'run' ? 46 : gait === 'sneak' ? 30 : 36;
  if (p.stepAcc >= stride) {
    p.stepAcc = 0;
    emitNoise(p.x, p.y, p.state === 'down' ? 0.15 : gait === 'run' ? 1.1 : gait === 'walk' ? 0.42 : 0.1, 'step', p);
  }
}
const doorCenter = r => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

function interact(p) {
  for (const f of game.fuses) if (f.st === 'ground' && dist(p, f) < 34) {
    f.st = 'held'; f.heldBy = p.id; p.fuse = f.id; ev('pickup', f.x, f.y, 0.4, p.id); return;
  }
  if (p.fuse != null && dist(p, game.world.plaza) < 70) {
    const f = game.fuses.find(f => f.id === p.fuse);
    f.st = 'in'; p.fuse = null; game.genN++;
    ev('install', game.world.plaza.x, game.world.plaza.y, 0.8, p.id);
    emitNoise(game.world.plaza.x, game.world.plaza.y, 0.8, 'clank', p);
    if (game.genN >= game.genTotal) { game.phase = 'won'; game.phaseT = 12; ev('win', game.world.plaza.x, game.world.plaza.y, 0); }
    return;
  }
  let best = null, bd = 44 * 44;
  for (const d of game.doors) { const dd = dist(p, doorCenter(d.rect)) ** 2; if (dd < bd) { bd = dd; best = d; } }
  if (best) {
    best.open = !best.open; best.breachT = 0; game.solidsDirty = true;
    const c = doorCenter(best.rect);
    ev('door', c.x, c.y, best.open ? 1.0 : 0.45, p.id);
    emitNoise(c.x, c.y, best.open ? 1.0 : 0.45, 'door', p);
  }
}
function reviveHold(p, dt) {
  if (p.state !== 'alive') return;
  for (const q of playersArr()) if (q !== p && q.state === 'down' && dist(p, q) < 48) {
    q.rv = Math.min(1, q.rv + dt / 3.2); q.rvActive = true;
    if (q.rv >= 1) { q.state = 'alive'; q.rv = 0; ev('revive', q.x, q.y, 0.4, q.id, p.id); }
    return;
  }
}

function routeViaDoor(c, goal) {
  const bGoal = buildingAt(goal), bC = buildingAt(c);
  const need = (bGoal && bGoal !== bC) ? bGoal : (!bGoal && bC ? bC : null);
  if (!need) return goal;
  let best = null, bd = Infinity;
  for (const d of game.doors) {
    if (d.rect.b !== need.i) continue;
    const cc = doorCenter(d.rect), dd = dist(c, cc);
    if (dd < bd) { bd = dd; best = cc; }
  }
  return (best && bd > 30) ? best : goal;
}

function attackCheck(dt) {
  const c = game.creature;
  for (const p of playersArr()) if (p.state === 'down' && dist(p, c) < 24) {
    c.execT += dt; c.pauseT = Math.max(c.pauseT, 0.06);
    if (c.execT > 0.9) { killPlayer(p); c.execT = 0; c.pauseT = 1.3; }
    return;
  }
  c.execT = 0;
  if (c.attackCd > 0) return;
  for (const p of playersArr()) if (p.state === 'alive' && dist(p, c) < 26) {
    downPlayer(p); c.attackCd = 1.7; c.pauseT = 0.8; return;
  }
}

function updateCreature(dt) {
  const c = game.creature;
  c.attackCd = Math.max(0, c.attackCd - dt);
  c.shriekCd = Math.max(0, c.shriekCd - dt);
  if (game.phase !== 'play' || c.pauseT > 0) { c.pauseT -= dt; return; }
  c.senseT -= dt;
  if (c.senseT <= 0) { c.senseT = 0.55; for (const p of playersArr()) if (p.state === 'alive' && dist(p, c) < 70) { hear(p.x, p.y, 0.32, p); break; } }
  switch (c.state) {
    case 'roam':
      if (c.idleT > 0) { c.idleT -= dt; c.goal = null; break; }
      if (!c.goal || dist(c, c.goal) < 24) {
        if (Math.random() < 0.4) { c.idleT = 0.8 + Math.random() * 1.8; c.goal = null; }
        else { const wp = game.world.waypoints[(Math.random() * game.world.waypoints.length) | 0]; c.goal = { x: wp.x, y: wp.y }; }
      }
      break;
    case 'investigate':
      if (!c.goal) { c.state = 'roam'; break; }
      if (dist(c, c.goal) < 22) { c.state = 'search'; c.searchT = 4.5; c.subT = 0; c.searchC = { x: c.goal.x, y: c.goal.y }; c.goal = null; }
      break;
    case 'search':
      c.searchT -= dt; c.subT -= dt;
      if (c.searchT <= 0) { c.state = 'roam'; c.goal = null; break; }
      if (c.subT <= 0) { c.subT = 1.1; const a = Math.random() * Math.PI * 2, rr = 40 + Math.random() * 130; c.goal = { x: c.searchC.x + Math.cos(a) * rr, y: c.searchC.y + Math.sin(a) * rr }; }
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
  attackCheck(dt);
  let goal = c.state === 'hunt' && c.target ? c.goal : (c.goal || null);
  if (!goal) return;
  goal = routeViaDoor(c, goal);
  const d = dist(c, goal) || 1;
  let dirx = (goal.x - c.x) / d, diry = (goal.y - c.y) / d;
  if (c.detourT > 0) { c.detourT -= dt; const a = Math.atan2(diry, dirx) + c.detourSign * 1.1; dirx = Math.cos(a); diry = Math.sin(a); }
  const spd = SPEEDS[c.state] || 50;
  const res = WG.resolveCircle(c.x + dirx * spd * dt, c.y + diry * spd * dt, WG.CR, solids(), game.world.trees, WG.SIZE);
  const moved = Math.hypot(res.x - c.x, res.y - c.y);
  c.x = res.x; c.y = res.y; c.dir = Math.atan2(diry, dirx);
  if (moved < spd * dt * 0.3 && spd > 10) {
    const doorHit = res.hits.find(h => h.door && !h.door.open);
    if (doorHit && c.state !== 'roam') {
      doorHit.door.breachT += dt;
      if (doorHit.door.breachT > 0.9) {
        doorHit.door.open = true; doorHit.door.breachT = 0; game.solidsDirty = true;
        const dc = doorCenter(doorHit.door.rect);
        ev('breach', dc.x, dc.y, 2.2); emitNoise(dc.x, dc.y, 2.2, 'breach', null);
      }
    } else { c.stuckT += dt; if (c.stuckT > 0.35) { c.stuckT = 0; c.detourT = 0.7; c.detourSign = Math.random() < 0.5 ? 1 : -1; } }
  } else c.stuckT = 0;
}

function updateRocks(dt) {
  for (let i = game.rocksAir.length - 1; i >= 0; i--) {
    const r = game.rocksAir[i];
    r.x += r.vx * dt; r.y += r.vy * dt;
    r.vx *= (1 - 2.2 * dt); r.vy *= (1 - 2.2 * dt);
    r.life -= dt;
    const res = WG.resolveCircle(r.x, r.y, 3, solids(), game.world.trees, WG.SIZE);
    if (res.hits.length) { r.x = res.x; r.y = res.y; r.life = Math.min(r.life, 0.05); }
    if (r.life <= 0) { emitNoise(r.x, r.y, 1.6, 'land', null); game.rocksAir.splice(i, 1); }
  }
}

function resetRound() {
  game = makeGame();
  for (const p of playersArr()) respawn(p);
  sendAll({ t: 'reset', seed: game.seed, world: game.world });
}
function sendAll(msg) { const s = JSON.stringify(msg); for (const ws of players.keys()) if (ws.readyState === 1) ws.send(s); }

function broadcast() {
  const c = game.creature;
  const msg = {
    t: 'state', ph: game.phase, pt: Math.ceil(Math.max(0, game.phaseT)), gr: Math.max(0, Math.ceil(GRACE - game.roundT)),
    c: { x: R(c.x), y: R(c.y), d: +c.dir.toFixed(2), s: c.state, tg: c.target ? c.target.id : -1 },
    p: playersArr().map(p => ({ id: p.id, x: R(p.x), y: R(p.y), d: +p.dir.toFixed(2),
      s: p.state === 'alive' ? 0 : p.state === 'down' ? 1 : 2, f: p.fuse != null ? 1 : 0, r: p.rocks, rv: +p.rv.toFixed(2), g: GAITS[p.gait] || 0 })),
    fu: game.fuses.map(f => f.st === 'ground' ? [f.id, R(f.x), R(f.y)] : f.st === 'held' ? [f.id, 'h'] : [f.id, 'i']),
    dn: game.doors.map(d => d.open ? 1 : 0),
    gn: game.genN, gt: game.genTotal,
    ev: game.events.splice(0)
  };
  const s = JSON.stringify(msg);
  for (const ws of players.keys()) if (ws.readyState === 1) ws.send(s);
}

let tickN = 0;
setInterval(() => {
  const dt = TICK;
  game.time += dt; game.roundT += dt;
  if (game.phase === 'play') {
    for (const p of playersArr()) p.rvActive = false;
    for (const p of playersArr()) {
      if (p.gone) continue;
      const edge = p.input.e && !p.pe; p.pe = p.input.e;
      movePlayer(p, dt);
      if (edge && p.state !== 'dead') interact(p);
      if (p.input.e) reviveHold(p, dt);
      if (p.rocks < 3) { p.rockT += dt; if (p.rockT >= 22) { p.rockT = 0; p.rocks++; } }
    }
    for (const p of playersArr()) if (p.state === 'down' && !p.rvActive) p.rv = Math.max(0, p.rv - dt * 0.08);
    updateRocks(dt);
    updateCreature(dt);
    const ps = playersArr();
    if (ps.length && ps.every(p => p.state === 'dead')) { game.phase = 'lost'; game.phaseT = 10; ev('lose', 0, 0, 0); }
  } else { game.phaseT -= dt; if (game.phaseT <= 0) resetRound(); }
  if (++tickN % BCAST_EVERY === 0) broadcast();
}, TICK * 1000);

wss.on('connection', ws => {
  if (players.size >= MAX_PLAYERS) { ws.send(JSON.stringify({ t: 'full' })); ws.close(); return; }
  ws.isAlive = true;
  ws.on('pong', () => ws.isAlive = true);
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const p = players.get(ws);
    if (m.t === 'join') {
      if (p) return;
      const name = String(m.name || 'SURVIVOR').replace(/[^\w \-]/g, '').slice(0, 14).toUpperCase() || 'SURVIVOR';
      const used = new Set(playersArr().map(q => q.color));
      const color = COLORS.find(c => !used.has(c)) || COLORS[players.size % COLORS.length];
      const np = { id: ++idSeq, name, color, ws, input: { u: 0, d: 0, l: 0, r: 0, run: 0, sneak: 0, e: 0 } };
      players.set(ws, np); respawn(np);
      ws.send(JSON.stringify({ t: 'welcome', id: np.id, color, seed: game.seed, world: game.world, grace: GRACE, phase: game.phase,
        roster: playersArr().filter(q => q !== np).map(q => ({ id: q.id, name: q.name, color: q.color })) }));
      for (const [ws2, q] of players) if (q !== np && ws2.readyState === 1) ws2.send(JSON.stringify({ t: 'peer', id: np.id, name, color }));
      return;
    }
    if (!p) return;
    if (m.t === 'input') Object.assign(p.input, { u: !!m.u, d: !!m.d, l: !!m.l, r: !!m.r, run: !!m.run, sneak: !!m.sneak, e: !!m.e });
    else if (m.t === 'noise') {
      if (p.state === 'dead' || game.phase !== 'play' || p.micCd > game.time) return;
      p.micCd = game.time + 0.15;
      emitNoise(p.x, p.y, 0.45 + Math.min(1, Math.max(0, +m.v || 0)) * 2.3, 'voice', p);
    } else if (m.t === 'throw') {
      if (p.state !== 'alive' || p.rocks <= 0) return;
      const len = Math.hypot(m.dx, m.dy) || 1, dx = m.dx / len, dy = m.dy / len;
      p.rocks--; p.rockT = 0;
      game.rocksAir.push({ x: p.x + dx * 14, y: p.y + dy * 14, vx: dx * 420, vy: dy * 420, life: 0.62 });
      ev('thrown', p.x, p.y, 0.2, p.id);
      const e = game.events[game.events.length - 1]; e.dx = +dx.toFixed(2); e.dy = +dy.toFixed(2);
    }
  });
  ws.on('close', () => {
    const p = players.get(ws);
    if (!p) return;
    p.gone = true; dropFuse(p); players.delete(ws);
    if (game.creature.target === p) game.creature.target = null;
    sendAll({ t: 'leave', id: p.id });
  });
});
setInterval(() => { for (const ws of players.keys()) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); } }, 25000);

netServer.listen(PORT, () => console.log('a quiet place → http://localhost:' + PORT));
