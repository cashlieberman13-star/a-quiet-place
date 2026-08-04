import http from 'http';
import fs from 'fs';
import path from 'path';
import { WebSocketServer } from 'ws';
import * as W from './shared/worldgen.js';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 8080;
const HOST = process.argv.includes('--host') ? process.argv[process.argv.indexOf('--host') + 1] : '127.0.0.1';

const TICK_HZ = 20, SNAP_HZ = 12;
const MAX_PLAYERS = 8;

const CANS_REQUIRED = 4;
const FUEL_TIME = 60;    // seconds the truck needs
const BLEED_TIME = 75;   // seconds until a downed player dies
const REVIVE_TIME = 6;

// ------------------------------------------------------------- static files
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.ico': 'image/x-icon',
};
const ROOT = __dirname;


const server = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') url = '/public/index.html';
  else if (!url.startsWith('/shared/') && !url.startsWith('/public/')) url = '/public' + url;
  const file = path.normalize(path.join(ROOT, url));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
});

// ------------------------------------------------------------------- utils
const now = () => Date.now();
const rnd = (a, b) => a + Math.random() * (b - a);
const dist2 = (ax, az, bx, bz) => (ax - bx) ** 2 + (az - bz) ** 2;

function walkableNear(x, z, seed, tries = 24) {
  for (let i = 0; i < tries; i++) {
    const a = Math.random() * Math.PI * 2, r = Math.random() * 90;
    const nx = W.clamp(x + Math.cos(a) * r, -W.HALF + 40, W.HALF - 40);
    const nz = W.clamp(z + Math.sin(a) * r, -W.HALF + 40, W.HALF - 40);
    if (W.isWalkable(nx, nz, seed)) return { x: nx, z: nz };
  }
  return { x: W.TRUCK.x, z: W.TRUCK.z };
}

// ------------------------------------------------------------- the creature
const ST = { PATROL: 'patrol', INVESTIGATE: 'investigate', STALK: 'stalk', CHARGE: 'charge', STUNNED: 'stunned' };
const SPEED = { patrol: 3.4, investigate: 7.2, stalk: 5.0, charge: 15.2, stunned: 0 };

let creatureSeq = 1;
function makeCreature(seed, i) {
  const p = walkableNear(rnd(-700, 700), rnd(-700, 700), seed);
  return {
    id: 'c' + (creatureSeq++),
    x: p.x, z: p.z, y: W.heightAt(p.x, p.z, seed), yaw: Math.random() * 6.28,
    state: ST.PATROL, speed: 0,
    tx: p.x, tz: p.z,          // current point of interest
    attention: 0,              // 0..1 confidence it knows where you are
    lastHeard: 0,
    stunUntil: 0,
    screechAt: 0,
    lungeAt: 0,
    idle: 0,
  };
}

/** Distance a noise carries, and how strongly it registers here. */
function hearing(cre, x, z, loud) {
  const range = 34 + loud * 560;
  const d = Math.sqrt(dist2(cre.x, cre.z, x, z));
  if (d > range) return 0;
  const falloff = 1 - d / range;
  return loud * falloff * falloff;
}

// -------------------------------------------------------------------- room
class Room {
  constructor(code) {
    this.code = code;
    this.seed = W.seedFromString(code);
    this.players = new Map();
    this.creatures = [];
    this.phase = 'lobby';
    this.tick = 0;
    this.snapAcc = 0;
    this.reset();
  }

  reset() {
    this.phase = 'lobby';
    this.fuelDelivered = 0;
    this.fuelTimer = FUEL_TIME;
    this.escaped = 0;
    this.startedAt = 0;
    this.endsAt = 0;
    this.spawnIndex = 0;
    this.creatures = [];

    // Pick which fuel spots are live this run.
    const spots = W.FUEL_SPOTS.slice();
    for (let i = spots.length - 1; i > 0; i--) {
      const j = Math.floor(W.hash(i, 3, this.seed) * (i + 1));
      [spots[i], spots[j]] = [spots[j], spots[i]];
    }
    this.cans = spots.slice(0, CANS_REQUIRED).map(s => ({
      id: s.id, x: s.x, z: s.z, y: W.heightAt(s.x, s.z, this.seed) + 0.35,
      label: s.label, held: null, delivered: false,
    }));

    this.tower = { active: false, cooldown: 0 };
    for (const p of this.players.values()) this.respawn(p);
  }

  begin() {
    if (this.phase !== 'lobby') return;
    this.phase = 'active';
    this.startedAt = now();
    const n = Math.max(1, Math.min(3, Math.ceil(this.alive().length / 3)));
    for (let i = 0; i < n; i++) this.creatures.push(makeCreature(this.seed, i));
    this.broadcast({ t: 'event', kind: 'begin', creatures: this.creatures.length });
    this.log('Silence protocol active. Find ' + CANS_REQUIRED + ' fuel cans. Do not make a sound.');
  }

  respawn(p) {
    const s = W.spawnPoint(this.seed, this.spawnIndex++);
    p.x = s.x; p.z = s.z; p.y = s.y;
    p.hp = 100; p.down = false; p.dead = false; p.downT = BLEED_TIME;
    p.reviveP = 0; p.carrying = null; p.escapedAt = 0;
  }

  alive() { return [...this.players.values()].filter(p => !p.dead); }
  active() { return [...this.players.values()].filter(p => !p.dead && !p.down && !p.escapedAt); }

  log(text, tone = 'info') { this.broadcast({ t: 'event', kind: 'log', text, tone }); }

  broadcast(msg, except) {
    const s = JSON.stringify(msg);
    for (const p of this.players.values()) if (p !== except && p.ws.readyState === 1) p.ws.send(s);
  }

  // ------------------------------------------------------------ noise input
  onNoise(from, x, z, loud, kind) {
    if (this.phase === 'lobby' || this.phase === 'over') return;
    loud = W.clamp(loud, 0, 1);
    if (loud < 0.015) return;

    this.broadcast({ t: 'pulse', x, z, loud, kind, by: from ? from.id : null });

    for (const c of this.creatures) {
      if (c.state === ST.STUNNED) continue;
      const g = hearing(c, x, z, loud);
      if (g <= 0.004) continue;

      // A louder, closer sound overrides a stale bearing.
      const stale = (now() - c.lastHeard) / 1000;
      if (g > c.attention * (0.55 + Math.min(0.4, stale * 0.06))) {
        c.tx = x + rnd(-2, 2) * (1 - g);
        c.tz = z + rnd(-2, 2) * (1 - g);
        c.attention = Math.max(c.attention, g);
        c.lastHeard = now();
        c.idle = 0;

        if (g > 0.52) {
          if (c.state !== ST.CHARGE) this.screech(c, 1);
          c.state = ST.CHARGE;
        } else if (g > 0.16) {
          c.state = ST.INVESTIGATE;
        } else if (c.state === ST.PATROL) {
          c.state = ST.STALK;
        }
      }
    }
  }

  screech(c, force) {
    if (now() - c.screechAt < 3500 && !force) return;
    c.screechAt = now();
    this.broadcast({ t: 'event', kind: 'screech', x: c.x, y: c.y, z: c.z, id: c.id });
  }

  // ---------------------------------------------------------------- objects
  tryPickup(p) {
    if (p.carrying || p.down || p.dead) return;
    for (const can of this.cans) {
      if (can.delivered || can.held) continue;
      if (dist2(p.x, p.z, can.x, can.z) < 3.5 * 3.5) {
        can.held = p.id; p.carrying = can.id;
        this.broadcast({ t: 'event', kind: 'log', tone: 'good', text: `${p.name} recovered a fuel can (${can.label}).` });
        this.onNoise(p, p.x, p.z, 0.22, 'metal');
        return;
      }
    }
  }

  tryDeliver(p) {
    if (!p.carrying) return;
    if (dist2(p.x, p.z, W.TRUCK.x, W.TRUCK.z) > 6 * 6) return;
    const can = this.cans.find(c => c.id === p.carrying);
    if (!can) return;
    can.delivered = true; can.held = null; p.carrying = null;
    this.fuelDelivered++;
    this.onNoise(p, p.x, p.z, 0.30, 'metal');
    this.log(`Fuel loaded — ${this.fuelDelivered}/${CANS_REQUIRED}.`, 'good');
    if (this.fuelDelivered >= CANS_REQUIRED && this.phase === 'active') {
      this.phase = 'fueling';
      this.log('Truck is fueling. It is going to be loud. Stay near it and stay alive.', 'warn');
      this.onNoise(null, W.TRUCK.x, W.TRUCK.z, 0.9, 'engine');
    }
  }

  tryTower(p) {
    if (this.tower.cooldown > 0 || dist2(p.x, p.z, 320, -780) > 8 * 8) return;
    this.tower.cooldown = 150;
    this.broadcast({ t: 'event', kind: 'feedback' });
    this.log(`${p.name} pushed the transmitter to feedback. The creatures are screaming.`, 'good');
    for (const c of this.creatures) {
      c.state = ST.STUNNED;
      c.stunUntil = now() + 20000;
      c.attention = 0;
    }
  }

  // ------------------------------------------------------------------- loop
  step(dt) {
    // fueling / extraction timers
    if (this.phase === 'fueling') {
      this.fuelTimer -= dt;
      // The engine is a beacon. It draws everything.
      if (Math.random() < dt * 1.4) this.onNoise(null, W.TRUCK.x, W.TRUCK.z, 0.55, 'engine');
      if (this.fuelTimer <= 0) {
        this.phase = 'extract';
        this.log('Truck is running. Get in. Now.', 'good');
      }
    }

    // players: bleed-out, escape check
    for (const p of this.players.values()) {
      if (p.down && !p.dead) {
        p.downT -= dt;
        if (Math.random() < dt * 0.5) this.onNoise(p, p.x, p.z, 0.10, 'gasp');
        if (p.downT <= 0) {
          p.dead = true; p.down = false;
          if (p.carrying) this.dropCan(p);
          this.log(`${p.name} bled out.`, 'bad');
        }
      }
      if (this.phase === 'extract' && !p.escapedAt && !p.dead && !p.down) {
        if (dist2(p.x, p.z, W.TRUCK.x, W.TRUCK.z) < 6 * 6) {
          p.escapedAt = now(); this.escaped++;
          this.log(`${p.name} made it into the truck.`, 'good');
        }
      }
    }

    if (this.tower.cooldown > 0) this.tower.cooldown -= dt;

    // creatures
    for (const c of this.creatures) this.stepCreature(c, dt);

    // win / lose
    if (this.phase !== 'lobby' && this.phase !== 'over') {
      const survivors = this.alive();
      if (survivors.length === 0) this.finish(false, 'Everyone is gone. It was listening the whole time.');
      else if (this.phase === 'extract' && survivors.every(p => p.escapedAt || p.dead) && this.escaped > 0)
        this.finish(true, `${this.escaped} survivor(s) drove out of the valley.`);
    }
  }

  dropCan(p) {
    const can = this.cans.find(c => c.id === p.carrying);
    if (can) { can.held = null; can.x = p.x; can.z = p.z; can.y = W.heightAt(p.x, p.z, this.seed) + 0.35; }
    p.carrying = null;
  }

  finish(won, text) {
    this.phase = 'over';
    this.endsAt = now() + 14000;
    this.broadcast({ t: 'event', kind: 'over', won, text });
  }

  stepCreature(c, dt) {
    if (c.state === ST.STUNNED) {
      if (now() >= c.stunUntil) {
        const p = walkableNear(c.x, c.z, this.seed);
        c.state = ST.PATROL; c.tx = p.x; c.tz = p.z;
      } else return;
    }

    c.attention *= Math.pow(0.72, dt);       // memory of the sound fades
    const arrived = dist2(c.x, c.z, c.tx, c.tz) < 9;

    if (c.attention < 0.05) {
      if (c.state !== ST.PATROL) { c.state = ST.PATROL; c.idle = rnd(1, 4); }
    } else if (c.state === ST.CHARGE && c.attention < 0.30) {
      c.state = ST.INVESTIGATE;
    }

    if (arrived) {
      if (c.state === ST.PATROL) {
        if ((c.idle -= dt) <= 0) {
          // Drift toward wherever people tend to be — roads and settlements.
          const poi = W.POIS[Math.floor(Math.random() * W.POIS.length)];
          const p = walkableNear(poi.x, poi.z, this.seed);
          c.tx = p.x; c.tz = p.z; c.idle = rnd(2, 7);
        }
      } else {
        // Lost the trail. Sweep the area, listening.
        c.state = ST.STALK;
        const p = walkableNear(c.tx, c.tz, this.seed, 16);
        c.tx = p.x; c.tz = p.z;
        c.attention *= 0.6;
        if (Math.random() < 0.35) this.screech(c, 0);
      }
    }

    // steer
    const want = Math.atan2(c.tx - c.x, c.tz - c.z);
    let d = ((want - c.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    const turn = (c.state === ST.CHARGE ? 4.2 : 2.4) * dt;
    c.yaw += W.clamp(d, -turn, turn);

    const target = SPEED[c.state] || 3;
    c.speed += (target - c.speed) * Math.min(1, dt * 3.5);

    let nx = c.x + Math.sin(c.yaw) * c.speed * dt;
    let nz = c.z + Math.cos(c.yaw) * c.speed * dt;
    if (!W.isWalkable(nx, nz, this.seed)) {
      c.yaw += rnd(1.4, 2.6) * (Math.random() < 0.5 ? -1 : 1);
      const p = walkableNear(c.x, c.z, this.seed);
      c.tx = p.x; c.tz = p.z;
    } else { c.x = nx; c.z = nz; }
    c.y = W.heightAt(c.x, c.z, this.seed);

    // contact
    if (now() - c.lungeAt > 900) {
      for (const p of this.players.values()) {
        if (p.dead || p.escapedAt) continue;
        const d2 = dist2(c.x, c.z, p.x, p.z);
        const reach = c.state === ST.CHARGE ? 2.9 : 2.2;
        if (d2 > reach * reach || Math.abs(c.y - p.y) > 4) continue;
        c.lungeAt = now();
        if (p.down) {
          p.dead = true; p.down = false;
          if (p.carrying) this.dropCan(p);
          this.log(`${p.name} was taken.`, 'bad');
        } else {
          p.down = true; p.downT = BLEED_TIME; p.hp = 0; p.reviveP = 0;
          if (p.carrying) this.dropCan(p);
          this.log(`${p.name} is down. Reach them quietly.`, 'bad');
        }
        this.broadcast({ t: 'event', kind: 'hit', target: p.id, x: c.x, y: c.y, z: c.z });
        this.screech(c, 1);
        // It backs off after a strike, then re-listens.
        c.attention = 0.35; c.state = ST.STALK;
        const away = walkableNear(c.x - Math.sin(c.yaw) * 40, c.z - Math.cos(c.yaw) * 40, this.seed);
        c.tx = away.x; c.tz = away.z;
        break;
      }
    }
  }

  snapshot() {
    return {
      t: 'snap', now: now(), phase: this.phase,
      fuel: this.fuelDelivered, need: CANS_REQUIRED,
      fuelTimer: Math.max(0, Math.round(this.fuelTimer)),
      towerCd: Math.max(0, Math.round(this.tower.cooldown)),
      players: [...this.players.values()].map(p => ({
        id: p.id, name: p.name, x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2),
        yaw: +p.yaw.toFixed(2), st: p.stance, mic: p.mic | 0, down: p.down, dead: p.dead,
        car: !!p.carrying, rev: +p.reviveP.toFixed(2), esc: !!p.escapedAt, sig: p.signal || 0,
        light: !!p.light, downT: Math.round(p.downT),
      })),
      creatures: this.creatures.map(c => ({
        id: c.id, x: +c.x.toFixed(2), y: +c.y.toFixed(2), z: +c.z.toFixed(2),
        yaw: +c.yaw.toFixed(2), sp: +c.speed.toFixed(2), st: c.state,
        att: +c.attention.toFixed(2), tx: +c.tx.toFixed(1), tz: +c.tz.toFixed(1),
      })),
      cans: this.cans.map(c => ({ id: c.id, x: c.x, y: c.y, z: c.z, held: c.held, del: c.delivered, label: c.label })),
    };
  }
}

// ------------------------------------------------------------------- server
const rooms = new Map();
function getRoom(code) {
  code = (code || 'QUIET').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'QUIET';
  if (!rooms.has(code)) rooms.set(code, new Room(code));
  return rooms.get(code);
}

const wss = new WebSocketServer({ server });
let pid = 1;

wss.on('connection', ws => {
  let room = null, me = null;

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }

    if (m.t === 'join') {
      if (me) return;
      room = getRoom(m.room);
      if (room.players.size >= MAX_PLAYERS) { ws.send(JSON.stringify({ t: 'full' })); return; }
      me = {
        ws, id: 'p' + (pid++), name: String(m.name || 'Survivor').slice(0, 16).replace(/[<>&]/g, ''),
        x: 0, y: 0, z: 0, yaw: 0, stance: 'stand', mic: 0, hp: 100,
        down: false, dead: false, downT: BLEED_TIME, reviveP: 0,
        carrying: null, signal: 0, light: false, escapedAt: 0, lastNoise: 0,
      };
      room.respawn(me);
      room.players.set(me.id, me);
      ws.send(JSON.stringify({
        t: 'welcome', you: me.id, seed: room.seed, room: room.code, phase: room.phase,
        spawn: { x: me.x, y: me.y, z: me.z }, tick: TICK_HZ,
      }));
      room.log(`${me.name} joined. (${room.players.size}/${MAX_PLAYERS})`);
      if (room.phase === 'lobby' && room.players.size >= 1) setTimeout(() => room.begin(), 4000);
      return;
    }

    if (!me || !room) return;

    switch (m.t) {
      case 'state':
        if (typeof m.x === 'number') { me.x = m.x; me.y = m.y; me.z = m.z; }
        me.yaw = m.yaw || 0;
        me.stance = m.st || 'stand';
        me.mic = m.mic || 0;
        me.light = !!m.light;
        break;

      case 'noise': {
        // Rate limit so a hot mic can't flood the sim.
        if (now() - me.lastNoise < 60) break;
        me.lastNoise = now();
        room.onNoise(me, m.x ?? me.x, m.z ?? me.z, m.loud, m.kind || 'mic');
        break;
      }

      case 'act':
        if (m.a === 'pickup') room.tryPickup(me);
        else if (m.a === 'deliver') room.tryDeliver(me);
        else if (m.a === 'tower') room.tryTower(me);
        else if (m.a === 'drop' && me.carrying) room.dropCan(me);
        break;

      case 'revive': {
        const t = room.players.get(m.id);
        if (!t || !t.down || t.dead || me.down || me.dead) break;
        if (dist2(me.x, me.z, t.x, t.z) > 3 * 3) break;
        t.reviveP += (m.dt || 0.05) / REVIVE_TIME;
        if (Math.random() < 0.10) room.onNoise(me, me.x, me.z, 0.13, 'cloth');
        if (t.reviveP >= 1) {
          t.down = false; t.reviveP = 0; t.hp = 55; t.downT = BLEED_TIME;
          room.log(`${me.name} got ${t.name} back on their feet.`, 'good');
        }
        break;
      }

      case 'signal':
        me.signal = m.id | 0;
        room.broadcast({ t: 'event', kind: 'signal', by: me.id, name: me.name, id: me.signal });
        setTimeout(() => { if (me.signal === (m.id | 0)) me.signal = 0; }, 2500);
        break;

      case 'chat':
        room.broadcast({ t: 'event', kind: 'chat', name: me.name, text: String(m.text || '').slice(0, 140) });
        break;
    }
  });

  ws.on('close', () => {
    if (!room || !me) return;
    if (me.carrying) room.dropCan(me);
    room.players.delete(me.id);
    room.log(`${me.name} disconnected.`);
    if (room.players.size === 0) rooms.delete(room.code);
  });
});

// global clock
let last = now();
setInterval(() => {
  const t = now(), dt = Math.min(0.25, (t - last) / 1000); last = t;
  for (const room of rooms.values()) {
    if (room.phase !== 'lobby') room.step(dt);
    if (room.phase === 'over' && t > room.endsAt) room.reset();
    room.snapAcc += dt;
    if (room.snapAcc >= 1 / SNAP_HZ) { room.snapAcc = 0; room.broadcast(room.snapshot()); }
  }
}, 1000 / TICK_HZ);

server.listen(PORT, HOST, () => {
  console.log(`\n  A QUIET PLACE — listening on http://${HOST}:${PORT}\n  Microphone requires localhost or HTTPS.\n`);
});
