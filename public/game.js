'use strict';
/* A QUIET PLACE — client. Rendering, procedural audio, real-mic threat vector, rooms. */
const WG = window.WorldGen;
const $ = id => document.getElementById(id);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;

const INTERP = 110;
const PR = WG.PR;
const cv = $('cv'), ctx = cv.getContext('2d');
const dark = document.createElement('canvas'), dctx = dark.getContext('2d');
let W = 0, H = 0, DPR = 1;

/* ---------------- state ---------------- */
const NET = { ws: null, id: -1, open: false, wasInGame: false };
const roster = new Map();
let WORLD = null, DECOR = [], terrainPat = null, grainPat = [], grainI = 0, vign = null;
let snaps = [], doorsOpen = [], solidsCache = null, solidsKey = '';
let phase = 'title', phaseT = 0, graceT = 0, genN = 0, genTotal = 5;
let myColor = '#c9b27c', myName = '', ROOM = '', joinRoom = '', night = 1, wasDead = false, prevHunt = false;
let cam = { x: WG.SIZE / 2, y: WG.SIZE / 2 }, shake = 0, redPulse = 0;
let mouse = { x: 0, y: 0 }, keys = {};
const ripples = [], flashes = [], pebbles = [], dusts = [], ash = [];
let creatureDist = 1e9;
const local = { x: 0, y: 0, init: false, stepAcc: 0 };
let view = null;

/* ---------------- audio ---------------- */
let ac = null, master = null, noiseBuf = null, growlGain = null;
function audioInit() {
  if (ac) return;
  ac = new (window.AudioContext || window.webkitAudioContext)();
  const comp = ac.createDynamicsCompressor();
  master = ac.createGain(); master.gain.value = 0.9;
  master.connect(comp).connect(ac.destination);
  noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  startAmbience();
}
function startAmbience() {
  const src = ac.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
  const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 300; bp.Q.value = 0.5;
  const g = ac.createGain(); g.gain.value = 0.045;
  const lfo = ac.createOscillator(); lfo.frequency.value = 0.07;
  const lg = ac.createGain(); lg.gain.value = 130;
  lfo.connect(lg).connect(bp.frequency);
  const lfo2 = ac.createOscillator(); lfo2.frequency.value = 0.045;
  const lg2 = ac.createGain(); lg2.gain.value = 0.02;
  lfo2.connect(lg2).connect(g.gain);
  src.connect(bp).connect(g).connect(master);
  src.start(); lfo.start(); lfo2.start();
  [48, 48.8].forEach(f => {
    const o = ac.createOscillator(); o.type = 'triangle'; o.frequency.value = f;
    const og = ac.createGain(); og.gain.value = 0.016;
    o.connect(og).connect(master); o.start();
  });
  const o = ac.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 46;
  const ws2 = ac.createWaveShaper(); const curve = new Float32Array(256);
  for (let i = 0; i < 256; i++) curve[i] = Math.tanh((i / 128 - 1) * 3);
  ws2.curve = curve;
  growlGain = ac.createGain(); growlGain.gain.value = 0;
  o.connect(ws2).connect(growlGain).connect(master); o.start();
}
function pan(g, x, y) {
  if (!ac.createStereoPanner) return g.connect(master);
  const p = ac.createStereoPanner();
  const me = view && view.me;
  p.pan.value = me ? clamp((x - me.x) / 420, -1, 1) : 0;
  return g.connect(p).connect(master);
}
function noiseHit(t, dur, freq, q, vol, x, y) {
  const s = ac.createBufferSource(); s.buffer = noiseBuf; s.playbackRate.value = 0.9 + Math.random() * 0.2;
  const f = ac.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(Math.max(0.001, vol), t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f).connect(g); pan(g, x, y); s.start(t); s.stop(t + dur + 0.05);
}
function tone(t, type, f0, f1, dur, vol, x, y) {
  const o = ac.createOscillator(); o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(Math.max(0.001, vol), t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); pan(g, x, y); o.start(t); o.stop(t + dur + 0.05);
  return o;
}
const sfx = {
  step(v, x, y) { const t = ac.currentTime; noiseHit(t, 0.08, 260 + Math.random() * 300, 1.4, v, x, y); tone(t, 'sine', 88, 60, 0.05, v * 0.5, x, y); },
  door(v, x, y) { const t = ac.currentTime; const o = tone(t, 'sawtooth', 96, 68, 0.55, v * 0.35, x, y);
    const lfo = ac.createOscillator(); lfo.frequency.value = 11; const lg = ac.createGain(); lg.gain.value = v * 0.2;
    lfo.connect(lg).connect(o.frequency); lfo.start(t); lfo.stop(t + 0.6); },
  breach(v, x, y) { const t = ac.currentTime; noiseHit(t, 0.4, 240, 0.7, v, x, y); tone(t, 'sine', 90, 34, 0.35, v, x, y); },
  shriek(v, x, y) {
    const t = ac.currentTime;
    const dl = ac.createDelay(); dl.delayTime.value = 0.11; const fb = ac.createGain(); fb.gain.value = 0.3;
    dl.connect(fb).connect(dl); const out = ac.createGain(); out.gain.value = 1; dl.connect(out); pan(out, x, y);
    [[950, 240, 'sawtooth'], [1400, 310, 'square']].forEach(pr => {
      const o = ac.createOscillator(); o.type = pr[2];
      o.frequency.setValueAtTime(pr[0], t); o.frequency.exponentialRampToValueAtTime(pr[1], t + 0.85);
      const g = ac.createGain(); g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(v * 0.28, t + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.95);
      o.connect(g); g.connect(master); g.connect(dl); o.start(t); o.stop(t + 1);
    });
    noiseHit(t, 0.7, 1900, 0.8, v * 0.5, x, y);
  },
  scream(v, x, y) { const t = ac.currentTime; tone(t, 'sawtooth', 700, 190, 0.5, v * 0.4, x, y); noiseHit(t, 0.35, 1200, 1, v * 0.3, x, y); },
  boom(v, x, y) { const t = ac.currentTime; tone(t, 'sine', 70, 26, 0.9, v, x, y); noiseHit(t, 0.6, 160, 0.6, v * 0.5, x, y); },
  chime(v, x, y) { const t = ac.currentTime; tone(t, 'sine', 660, 0, 0.3, v * 0.3, x, y); tone(t + 0.09, 'sine', 990, 0, 0.4, v * 0.25, x, y); },
  install(v, x, y) { const t = ac.currentTime; tone(t, 'square', 220, 180, 0.12, v * 0.3, x, y); noiseHit(t, 0.06, 2400, 2, v * 0.25, x, y);
    tone(t + 0.15, 'sawtooth', 55, 60, 1.6, v * 0.12, x, y); },
  revive(v, x, y) { const t = ac.currentTime; tone(t, 'triangle', 220, 0, 0.5, v * 0.3, x, y); tone(t + 0.12, 'triangle', 277, 0, 0.6, v * 0.3, x, y); },
  thud(v, x, y) { const t = ac.currentTime; noiseHit(t, 0.1, 500, 1, v * 0.5, x, y); tone(t, 'sine', 140, 70, 0.09, v * 0.4, x, y); },
  win(v) { const t = ac.currentTime; [220, 330, 440, 660].forEach((f, i) => tone(t + i * 0.16, 'triangle', f, 0, 0.8, v * 0.25, WG.SIZE / 2, WG.SIZE / 2)); },
  lose(v) { const t = ac.currentTime; tone(t, 'sawtooth', 110, 40, 2.4, v * 0.3, WG.SIZE / 2, WG.SIZE / 2); tone(t, 'sawtooth', 113, 42, 2.4, v * 0.3, WG.SIZE / 2, WG.SIZE / 2); },
  click(v, x, y) { noiseHit(ac.currentTime, 0.03, 2600 + Math.random() * 900, 6, v * 0.4, x, y); },
  tinnitus() { tone(ac.currentTime, 'sine', 3900, 3600, 2.2, 0.05, local.x, local.y); }
};
let hbNext = 0;
function heartbeat(v) {
  const t = ac.currentTime;
  [[0, v], [0.17, v * 0.75]].forEach(b => {
    const o = ac.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(58, t + b[0]); o.frequency.exponentialRampToValueAtTime(34, t + b[0] + 0.12);
    const g = ac.createGain(); g.gain.setValueAtTime(0.0001, t + b[0]);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, b[1]), t + b[0] + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + b[0] + 0.17);
    o.connect(g).connect(master); o.start(t + b[0]); o.stop(t + b[0] + 0.22);
  });
}

/* ---------------- microphone ---------------- */
const MIC = { on: false, analyser: null, data: null, lvl: 0, thr: 0.012, calib: false, calibT: 0, samples: [], lastSend: 0 };
async function micStart() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false } });
    const src = ac.createMediaStreamSource(stream);
    MIC.analyser = ac.createAnalyser(); MIC.analyser.fftSize = 1024;
    MIC.data = new Float32Array(MIC.analyser.fftSize);
    src.connect(MIC.analyser);
    MIC.on = true; MIC.calib = true; MIC.calibT = 0; MIC.samples = [];
    $('mcStatus').textContent = 'LISTENING FOR ROOM TONE — STAY SILENT';
  } catch (e) {
    MIC.on = false; MIC.calib = false;
    $('mcStatus').textContent = 'MICROPHONE DENIED — YOU WILL PLAY MUTE';
    $('skipMic').textContent = 'continue without a mic';
  }
}
function micTick(dt) {
  if (!MIC.on || !MIC.analyser) return;
  MIC.analyser.getFloatTimeDomainData(MIC.data);
  let sum = 0;
  for (let i = 0; i < MIC.data.length; i += 2) sum += MIC.data[i] * MIC.data[i];
  const rms = Math.sqrt(sum / (MIC.data.length / 2));
  MIC.lvl = Math.max(rms, MIC.lvl * 0.86);
  if (MIC.calib) {
    MIC.samples.push(rms); MIC.calibT += dt;
    $('mcFill').style.width = clamp(rms / 0.05 * 100, 0, 100) + '%';
    if (MIC.calibT > 1.6) {
      MIC.samples.sort((a, b) => a - b);
      const floor = MIC.samples[Math.floor(MIC.samples.length * 0.9)] || 0.003;
      MIC.thr = floor * 1.9 + 0.004;
      MIC.calib = false;
      $('mcStatus').textContent = 'ROOM TONE CAPTURED — CROSS THE RED LINE AND IT HEARS YOU';
      $('skipMic').textContent = 'begin';
    }
  }
}
function micSend() {
  if (!MIC.on || MIC.calib || !NET.open) return;
  if (MIC.lvl > MIC.thr) {
    const v = clamp((MIC.lvl - MIC.thr) / 0.085, 0.05, 1);
    const now = performance.now();
    if (now - MIC.lastSend > 110) { MIC.lastSend = now; NET.ws.send(JSON.stringify({ t: 'noise', v })); }
  }
}

/* ---------------- networking ---------------- */
function connect() {
  if (NET.ws && (NET.ws.readyState === 0 || NET.ws.readyState === 1)) return;
  const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
  NET.ws = new WebSocket(url);
  NET.ws.onopen = () => { NET.open = true; NET.ws.send(JSON.stringify({ t: 'join', name: myName, room: joinRoom })); };
  NET.ws.onclose = () => {
    NET.open = false;
    if (NET.wasInGame) { banner('SIGNAL LOST — RECONNECTING', true); setTimeout(connect, 1600); }
  };
  NET.ws.onmessage = e => onMsg(JSON.parse(e.data));
}
function onMsg(m) {
  switch (m.t) {
    case 'full': banner('THAT ROOM IS FULL — 8 SURVIVORS MAX', true); NET.ws.close(); break;
    case 'welcome':
      NET.id = m.id; myColor = m.color; ROOM = m.room; joinRoom = m.room;
      roster.clear(); m.roster.forEach(r => roster.set(r.id, r));
      try { history.replaceState(null, '', '?room=' + ROOM); } catch (e) {}
      initWorld(m.world);
      $('title').classList.add('hidden'); $('miccheck').classList.add('hidden');
      $('hud').classList.remove('hidden'); NET.wasInGame = true;
      banner('ROOM ' + ROOM + ' — NIGHT ' + night + ' — MAKE NO SOUND');
      log('ROOM ' + ROOM + ' — SHARE YOUR LINK TO INVITE', 'good');
      break;
    case 'reset':
      night++; initWorld(m.world); snaps = [];
      banner('NIGHT ' + night + ' — IT IS STILL HUNGRY');
      break;
    case 'peer': roster.set(m.id, { name: m.name, color: m.color }); log(m.name + ' ARRIVED'); break;
    case 'leave': { const r = roster.get(m.id); if (r) log(r.name + ' IS GONE'); roster.delete(m.id); break; }
    case 'state': onState(m); break;
  }
}
function onState(d) {
  snaps.push({ t: performance.now(), d });
  if (snaps.length > 12) snaps.shift();
  phase = d.ph; phaseT = d.pt; graceT = d.gr; genN = d.gn; genTotal = d.gt;
  const key = d.dn.join('');
  if (key !== solidsKey) { doorsOpen = d.dn; solidsKey = key; rebuildSolids(); }
  handleEvents(d.ev);
  const rawMe = d.p.find(q => q.id === NET.id);
  if (rawMe && local.init) {
    const err = Math.hypot(rawMe.x - local.x, rawMe.y - local.y);
    if (err > 70) { local.x = rawMe.x; local.y = rawMe.y; }
    else { local.x += (rawMe.x - local.x) * 0.25; local.y += (rawMe.y - local.y) * 0.25; }
  }
  if (rawMe && rawMe.s === 0) wasDead = false;
}

/* ---------------- world ---------------- */
function rebuildSolids() {
  if (!WORLD) return;
  const arr = WORLD.walls.slice();
  WORLD.doors.forEach((dr, i) => { if (!doorsOpen[i]) arr.push(dr); });
  solidsCache = arr;
}
function clientSolids() { return solidsCache || (rebuildSolids(), solidsCache); }
function initWorld(world) {
  WORLD = world; doorsOpen = world.doors.map(() => 0); solidsKey = '';
  rebuildSolids(); buildTerrain(); buildDecor();
  cam.x = world.spawn.x; cam.y = world.spawn.y;
  local.init = false; genTotal = world.fuses.length;
  ripples.length = flashes.length = pebbles.length = dusts.length = 0;
  ash.length = 0;
  for (let i = 0; i < 70; i++) ash.push({ x: Math.random() * 2000, y: Math.random() * 1200, z: 0.3 + Math.random() * 0.7 });
}
function buildTerrain() {
  const t = document.createElement('canvas'); t.width = t.height = 384;
  const g = t.getContext('2d'), rnd = WG.mulberry32(WORLD.seed ^ 0x9e37);
  g.fillStyle = '#0c1209'; g.fillRect(0, 0, 384, 384);
  const shades = ['#101809', '#0a100a', '#121a0d', '#0d150b', '#0e130a'];
  for (let i = 0; i < 1500; i++) {
    g.fillStyle = shades[(rnd() * shades.length) | 0];
    g.globalAlpha = 0.25 + rnd() * 0.5;
    g.fillRect(rnd() * 384, rnd() * 384, 1 + rnd() * 2.5, 1 + rnd() * 2.5);
  }
  g.globalAlpha = 0.14; g.fillStyle = '#191510';
  for (let i = 0; i < 7; i++) { g.beginPath(); g.arc(rnd() * 384, rnd() * 384, 12 + rnd() * 26, 0, 7); g.fill(); }
  g.globalAlpha = 1;
  terrainPat = ctx.createPattern(t, 'repeat');
  grainPat = [];
  for (let n = 0; n < 3; n++) {
    const gc = document.createElement('canvas'); gc.width = gc.height = 160;
    const gg = gc.getContext('2d'), id = gg.createImageData(160, 160);
    for (let i = 0; i < id.data.length; i += 4) {
      const v = Math.random() * 255;
      id.data[i] = id.data[i + 1] = id.data[i + 2] = v;
      id.data[i + 3] = Math.random() < 0.5 ? 14 : 0;
    }
    gg.putImageData(id, 0, 0);
    grainPat.push(ctx.createPattern(gc, 'repeat'));
  }
}
function buildDecor() {
  DECOR = [];
  const rnd = WG.mulberry32(WORLD.seed ^ 0x51ab);
  for (let i = 0; i < 240; i++) {
    const x = 40 + rnd() * (WG.SIZE - 80), y = 40 + rnd() * (WG.SIZE - 80);
    let bad = false;
    for (const b of WORLD.buildings) if (WG.pointInRect(x, y, b, 20)) { bad = true; break; }
    if (bad) continue;
    DECOR.push({ x, y, k: rnd() < 0.4 ? 'stone' : 'tuft', s: 0.6 + rnd() * 0.9, a: rnd() * 6.28 });
  }
}

/* ---------------- events ---------------- */
function mePos() { return (view && view.me) ? view.me : { x: local.x, y: local.y }; }
function audVol(x, y, range) {
  const m = mePos(); const d = Math.hypot(x - m.x, y - m.y);
  return d > range ? 0 : 1 - d / range;
}
function name(id) { return id === NET.id ? myName : (roster.get(id) || { name: '???' }).name; }
function handleEvents(evs) {
  for (const e of evs) {
    const v = audVol(e.x, e.y, 900);
    switch (e.k) {
      case 'noise':
        if (e.i >= 0.2) ripples.push({ x: e.x, y: e.y, i: e.i, kd: e.a, t: performance.now() });
        if (e.i >= 0.4) flashes.push({ x: e.x, y: e.y, r: 70 + e.i * 90, until: performance.now() + 450 });
        if (e.a === 'land') { dusts.push({ x: e.x, y: e.y, t: performance.now() }); if (v > 0) sfx.thud(v, e.x, e.y); }
        break;
      case 'step': if (e.id !== NET.id && v > 0) sfx.step(v * 0.5, e.x, e.y); break;
      case 'door': if (v > 0) sfx.door(v, e.x, e.y); break;
      case 'breach': if (v > 0) sfx.breach(v, e.x, e.y); shake = Math.max(shake, 10 * v); log('IT BROKE A DOOR DOWN', 'bad'); break;
      case 'shriek': sfx.shriek(0.3 + v * 0.7, e.x, e.y); shake = Math.max(shake, 14); break;
      case 'down':
        if (v > 0) sfx.scream(v, e.x, e.y);
        log(name(e.id) + ' IS DOWN', 'bad');
        if (e.id === NET.id) redPulse = 1;
        break;
      case 'dead':
        sfx.boom(0.4, e.x, e.y);
        log(name(e.id) + " DIDN'T MAKE IT", 'bad');
        if (e.id === NET.id) { wasDead = true; banner('YOU ARE SILENT NOW — SPECTATING', true); sfx.tinnitus(); }
        break;
      case 'revive': sfx.revive(0.7, e.x, e.y); log(name(e.id) + ' IS BACK UP', 'good'); break;
      case 'pickup': sfx.chime(0.6, e.x, e.y); log(name(e.id) + ' HAS A FUSE', 'good'); break;
      case 'install': sfx.install(0.8, e.x, e.y); log('FUSE INSTALLED — ' + genN + '/' + genTotal, 'good'); banner('FUSE ' + genN + ' OF ' + genTotal); break;
      case 'thrown': if (e.dx != null) pebbles.push({ x: e.x, y: e.y, vx: e.dx * 420, vy: e.dy * 420, life: 0.62 }); break;
      case 'win': sfx.win(0.8); break;
      case 'lose': sfx.lose(0.8); break;
    }
  }
}

/* ---------------- input ---------------- */
addEventListener('keydown', e => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  keys[e.code] = true; sendInput();
});
addEventListener('keyup', e => { keys[e.code] = false; sendInput(); });
addEventListener('blur', () => { keys = {}; sendInput(); });
addEventListener('mousemove', e => { mouse.x = e.clientX; mouse.y = e.clientY; });
addEventListener('mousedown', () => {
  if (!NET.open || phase !== 'play' || !view || !view.me || view.me.s !== 0) return;
  const m = worldMouse();
  const dx = m.x - local.x, dy = m.y - local.y, len = Math.hypot(dx, dy) || 1;
  NET.ws.send(JSON.stringify({ t: 'throw', dx: dx / len, dy: dy / len }));
});
cv.addEventListener('contextmenu', e => e.preventDefault());
function worldMouse() { return { x: mouse.x - W / 2 + cam.x, y: mouse.y - H / 2 + cam.y }; }
function inputState() {
  return {
    u: !!(keys.KeyW || keys.ArrowUp), d: !!(keys.KeyS || keys.ArrowDown),
    l: !!(keys.KeyA || keys.ArrowLeft), r: !!(keys.KeyD || keys.ArrowRight),
    run: !!(keys.ShiftLeft || keys.ShiftRight), sneak: !!keys.KeyC, e: !!keys.KeyE
  };
}
function sendInput() { if (NET.open && NET.ws.readyState === 1) NET.ws.send(JSON.stringify(Object.assign({ t: 'input' }, inputState()))); }
setInterval(sendInput, 250);

/* ---------------- prediction ---------------- */
function predict(dt) {
  if (!view || !view.me || view.me.s === 2) return;
  if (!local.init) { local.x = view.me.x; local.y = view.me.y; local.init = true; }
  const inp = inputState();
  let vx = (inp.r ? 1 : 0) - (inp.l ? 1 : 0), vy = (inp.d ? 1 : 0) - (inp.u ? 1 : 0);
  if (!vx && !vy) return;
  const len = Math.hypot(vx, vy); vx /= len; vy /= len;
  const gait = inp.sneak ? 'sneak' : inp.run ? 'run' : 'walk';
  let spd = gait === 'run' ? 205 : gait === 'walk' ? 130 : 62;
  if (view.me.s === 1) spd = 30;
  if (view.me.f && gait === 'run') spd = 170;
  const res = WG.resolveCircle(local.x + vx * spd * dt, local.y + vy * spd * dt, PR, clientSolids(), WORLD.trees, WG.SIZE);
  local.x = res.x; local.y = res.y;
  local.stepAcc += Math.hypot(vx * spd * dt, vy * spd * dt);
  const stride = gait === 'run' ? 46 : gait === 'sneak' ? 30 : 36;
  if (local.stepAcc >= stride) {
    local.stepAcc = 0;
    if (view.me.s === 0) sfx.step(gait === 'run' ? 0.5 : gait === 'walk' ? 0.28 : 0.1, local.x, local.y);
  }
}

/* ---------------- interpolation ---------------- */
function buildView() {
  if (!snaps.length) return null;
  const at = performance.now() - INTERP;
  let a = snaps[0], b = null;
  for (let i = snaps.length - 1; i >= 0; i--) if (snaps[i].t <= at) { a = snaps[i]; b = snaps[i + 1] || null; break; }
  const f = b ? clamp((at - a.t) / (b.t - a.t || 1), 0, 1) : 0;
  const ps = a.d.p.map(pa => {
    const pb = b && b.d.p.find(q => q.id === pa.id);
    const x = pb ? lerp(pa.x, pb.x, f) : pa.x, y = pb ? lerp(pa.y, pb.y, f) : pa.y;
    return Object.assign({}, pa, { x, y }, pb ? { s: pb.s, f: pb.f, r: pb.r, rv: pb.rv, g: pb.g, d: pb.d } : {});
  });
  const c0 = a.d.c, c1 = b ? b.d.c : c0;
  const c = Object.assign({}, c0, { x: lerp(c0.x, c1.x, f), y: lerp(c0.y, c1.y, f), s: c1.s, tg: c1.tg, d: c1.d });
  return { p: ps, c, me: ps.find(q => q.id === NET.id) || null };
}

/* ---------------- HUD ---------------- */
let bannerT = 0;
function banner(txt, red) {
  const b = $('banner'); b.textContent = txt; b.className = 'show' + (red ? ' red' : '');
  clearTimeout(bannerT); bannerT = setTimeout(() => { b.className = ''; }, 3400);
}
function log(txt, cls) {
  const el = document.createElement('div'); el.textContent = txt;
  if (cls) el.className = cls;
  const l = $('log'); l.prepend(el);
  while (l.children.length > 6) l.lastChild.remove();
}
function updateHUD() {
  $('obj').innerHTML =
    '<span class="room">ROOM ' + ROOM + '</span> · SURVIVORS <b>' + view.p.filter(q => q.s !== 2).length + '</b><br>' +
    'OBJECTIVE — FUSES <b>' + genN + '/' + genTotal + '</b> · POWER THE RADIO TOWER' +
    (graceT > 0 ? '<br><span class="wake">IT WAKES IN ' + graceT + 's</span>' : '');
  const mic = $('mic');
  if (MIC.on) {
    mic.classList.toggle('hot', MIC.lvl > MIC.thr);
    mic.classList.remove('off');
    $('micFill').style.width = clamp(MIC.lvl / (MIC.thr * 4) * 100, 0, 100) + '%';
    $('micThr').style.left = '25%';
  } else {
    mic.classList.add('off');
    mic.querySelector('.lbl em').textContent = 'MIC OFFLINE — YOU ARE SILENT';
    $('micFill').style.width = '0%';
  }
  const me = view.me;
  document.querySelectorAll('#rocksHud i').forEach((d, i) => { d.className = me && i < me.r ? 'full' : ''; });
  let prompt = '';
  if (me && me.s !== 2 && WORLD) {
    const last = snaps[snaps.length - 1];
    if (last) {
      for (const f of last.d.fu) if (f[1] !== 'h' && f[1] !== 'i' && Math.hypot(f[1] - local.x, f[2] - local.y) < 36) { prompt = 'E — TAKE THE FUSE'; break; }
      if (!prompt && me.f && Math.hypot(WORLD.plaza.x - local.x, WORLD.plaza.y - local.y) < 76) prompt = 'E — INSERT FUSE';
      if (!prompt) for (let i = 0; i < WORLD.doors.length; i++) {
        const dr = WORLD.doors[i], cx = dr.x + dr.w / 2, cy = dr.y + dr.h / 2;
        if (Math.hypot(cx - local.x, cy - local.y) < 46) { prompt = (doorsOpen[i] ? 'E — CLOSE DOOR' : 'E — OPEN DOOR') + ' · CREAKS'; break; }
      }
      if (!prompt && me.s === 0) for (const q of view.p)
        if (q.id !== NET.id && q.s === 1 && Math.hypot(q.x - local.x, q.y - local.y) < 50) { prompt = 'HOLD E — REVIVE ' + name(q.id); break; }
    }
  }
  $('prompt').textContent = prompt;
  const end = $('end');
  if (phase === 'won' || phase === 'lost') {
    end.classList.remove('hidden');
    $('endTitle').textContent = phase === 'won' ? 'THE TOWER SINGS — RESCUED' : 'EVERYONE IS DEAD';
    $('endTitle').className = phase === 'won' ? 'amber' : 'red';
    $('endSub').textContent = 'room ' + ROOM + ' · world resets in ' + phaseT + 's';
  } else end.classList.add('hidden');
}

/* ---------------- rendering ---------------- */
function resize() {
  DPR = Math.min(devicePixelRatio || 1, 1.5);
  W = innerWidth; H = innerHeight;
  cv.width = W * DPR; cv.height = H * DPR;
  dark.width = W; dark.height = H;
  vign = document.createElement('canvas'); vign.width = W; vign.height = H;
  const g = vign.getContext('2d');
  const gr = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.36, W / 2, H / 2, Math.max(W, H) * 0.72);
  gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,0.62)');
  g.fillStyle = gr; g.fillRect(0, 0, W, H);
}
addEventListener('resize', resize); resize();

const w2sX = x => x - cam.x + W / 2, w2sY = y => y - cam.y + H / 2;
const inView = (x, y, pad) => x > cam.x - W / 2 - pad && x < cam.x + W / 2 + pad && y > cam.y - H / 2 - pad && y < cam.y + H / 2 + pad;

function drawWorldBase(t) {
  ctx.fillStyle = terrainPat;
  ctx.fillRect(cam.x - W / 2, cam.y - H / 2, W, H);
  const pl = WORLD.plaza;
  if (inView(pl.x, pl.y, pl.r + 100)) {
    const g = ctx.createRadialGradient(pl.x, pl.y, 10, pl.x, pl.y, pl.r + 40);
    g.addColorStop(0, 'rgba(34,30,24,0.85)'); g.addColorStop(1, 'rgba(34,30,24,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(pl.x, pl.y, pl.r + 40, 0, 7); ctx.fill();
  }
  for (const d of DECOR) if (inView(d.x, d.y, 20)) {
    ctx.save(); ctx.translate(d.x, d.y); ctx.rotate(d.a);
    if (d.k === 'stone') { ctx.fillStyle = '#26292d'; ctx.beginPath(); ctx.ellipse(0, 0, 5 * d.s, 3.6 * d.s, 0, 0, 7); ctx.fill(); }
    else { ctx.strokeStyle = '#1d2b16'; ctx.lineWidth = 1.4; ctx.beginPath();
      for (let i = -1; i <= 1; i++) { ctx.moveTo(0, 0); ctx.lineTo(i * 3 * d.s, -7 * d.s); } ctx.stroke(); }
    ctx.restore();
  }
  for (const tr of WORLD.trees) if (inView(tr.x, tr.y, 60)) {
    ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.beginPath(); ctx.ellipse(tr.x + 4, tr.y + 5, tr.cr * 0.9, tr.cr * 0.5, 0, 0, 7); ctx.fill();
    ctx.fillStyle = '#1c1610'; ctx.beginPath(); ctx.arc(tr.x, tr.y, tr.r, 0, 7); ctx.fill();
    ctx.fillStyle = '#0e1a0c'; ctx.beginPath(); ctx.arc(tr.x, tr.y - 4, tr.cr, 0, 7); ctx.fill();
    ctx.fillStyle = '#122009'; ctx.beginPath(); ctx.arc(tr.x - tr.cr * 0.3, tr.y - tr.cr * 0.42, tr.cr * 0.55, 0, 7); ctx.fill();
  }
}
function drawBuildings() {
  const T = WG.WALL_T;
  for (const b of WORLD.buildings) if (inView(b.x + b.w / 2, b.y + b.h / 2, Math.max(b.w, b.h))) {
    ctx.fillStyle = '#161310'; ctx.fillRect(b.x + T, b.y + T, b.w - 2 * T, b.h - 2 * T);
    ctx.strokeStyle = 'rgba(255,240,200,0.035)'; ctx.lineWidth = 1;
    for (let x = b.x + T + 14; x < b.x + b.w - T; x += 18) {
      ctx.beginPath(); ctx.moveTo(x, b.y + T); ctx.lineTo(x, b.y + b.h - T); ctx.stroke();
    }
  }
  ctx.fillStyle = '#241c14';
  for (const w of WORLD.walls) if (inView(w.x + w.w / 2, w.y + w.h / 2, 40)) ctx.fillRect(w.x, w.y, w.w, w.h);
  ctx.strokeStyle = 'rgba(255,225,170,0.06)';
  for (const w of WORLD.walls) if (inView(w.x + w.w / 2, w.y + w.h / 2, 40)) { ctx.beginPath(); ctx.moveTo(w.x, w.y + 0.5); ctx.lineTo(w.x + w.w, w.y + 0.5); ctx.stroke(); }
  WORLD.doors.forEach((dr, i) => {
    if (!inView(dr.x + dr.w / 2, dr.y + dr.h / 2, 60)) return;
    if (!doorsOpen[i]) {
      ctx.fillStyle = '#3e3120'; ctx.fillRect(dr.x, dr.y, dr.w, dr.h);
      ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(dr.x, dr.y); ctx.lineTo(dr.x + dr.w, dr.y + dr.h);
      ctx.moveTo(dr.x + dr.w, dr.y); ctx.lineTo(dr.x, dr.y + dr.h); ctx.stroke();
    } else {
      ctx.strokeStyle = '#3e3120'; ctx.lineWidth = 5;
      const horiz = dr.w > dr.h;
      ctx.beginPath();
      if (horiz) { ctx.moveTo(dr.x, dr.y + dr.h / 2); ctx.lineTo(dr.x, dr.y + dr.h / 2 - dr.w * 0.8); }
      else { ctx.moveTo(dr.x + dr.w / 2, dr.y); ctx.lineTo(dr.x + dr.w / 2 + dr.h * 0.8, dr.y); }
      ctx.stroke();
    }
  });
}
function drawGenerator(t) {
  const pl = WORLD.plaza;
  if (!inView(pl.x, pl.y, 120)) return;
  const active = genN >= genTotal;
  ctx.fillStyle = '#1b1e22'; ctx.beginPath(); ctx.arc(pl.x, pl.y, 46, 0, 7); ctx.fill();
  ctx.fillStyle = '#262c33'; ctx.fillRect(pl.x - 24, pl.y - 14, 48, 30);
  ctx.strokeStyle = '#11151a'; ctx.lineWidth = 2;
  for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.moveTo(pl.x - 18, pl.y - 8 + i * 6); ctx.lineTo(pl.x + 2, pl.y - 8 + i * 6); ctx.stroke(); }
  ctx.strokeStyle = '#3a4048'; ctx.beginPath(); ctx.moveTo(pl.x + 16, pl.y - 14); ctx.lineTo(pl.x + 16, pl.y - 46); ctx.stroke();
  const lampOn = active || Math.sin(t * 2.4) > 0.55;
  ctx.fillStyle = active ? '#ffd98a' : (lampOn ? '#7e2a2f' : '#3a1518');
  ctx.beginPath(); ctx.arc(pl.x + 16, pl.y - 50, 5, 0, 7); ctx.fill();
  for (let i = 0; i < genTotal; i++) {
    ctx.fillStyle = i < genN ? '#ffb84d' : '#333a42';
    ctx.fillRect(pl.x - 20 + i * 9, pl.y + 18, 6, 4);
  }
}
function drawFuses(t) {
  const last = snaps[snaps.length - 1]; if (!last) return;
  for (const f of last.d.fu) {
    if (f[1] === 'h' || f[1] === 'i' || !inView(f[1], f[2], 30)) continue;
    const p = 0.6 + Math.sin(t * 3 + f[0]) * 0.4;
    ctx.fillStyle = 'rgba(232,163,61,' + (0.12 * p).toFixed(3) + ')'; ctx.beginPath(); ctx.arc(f[1], f[2], 14, 0, 7); ctx.fill();
    ctx.fillStyle = '#ffbf5e'; ctx.fillRect(f[1] - 6, f[2] - 3.5, 12, 7);
    ctx.fillStyle = '#8a6420'; ctx.fillRect(f[1] - 8, f[2] - 1.5, 2, 3); ctx.fillRect(f[1] + 6, f[2] - 1.5, 2, 3);
  }
}
function drawPlayer(p, t, isMe) {
  const x = isMe ? local.x : p.x, y = isMe ? local.y : p.y;
  if (!inView(x, y, 40)) return;
  const r = roster.get(p.id), col = isMe ? myColor : (r ? r.color : '#999');
  ctx.save(); ctx.translate(x, y);
  ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.beginPath(); ctx.ellipse(2, 4, 9, 5, 0, 0, 7); ctx.fill();
  if (p.s === 1) {
    ctx.save(); ctx.rotate(p.d + Math.PI / 2);
    ctx.fillStyle = col; ctx.beginPath(); ctx.ellipse(0, 0, 11, 6, 0, 0, 7); ctx.fill();
    ctx.fillStyle = '#d8c9a8'; ctx.beginPath(); ctx.arc(0, -10, 4, 0, 7); ctx.fill();
    ctx.restore();
    ctx.strokeStyle = 'rgba(194,43,51,' + (0.5 + Math.sin(t * 5) * 0.3).toFixed(3) + ')';
    ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, 15, 0, 7); ctx.stroke();
    if (p.rv > 0) { ctx.strokeStyle = '#e8a33d'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(0, 0, 19, -1.5708, -1.5708 + p.rv * 6.283); ctx.stroke(); }
  } else {
    ctx.save(); ctx.rotate(p.d);
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(0, 0, 8, 0, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = '#d8c9a8'; ctx.beginPath(); ctx.arc(3.5, 0, 4, 0, 7); ctx.fill();
    ctx.restore();
    if (p.f) { ctx.fillStyle = '#ffbf5e'; ctx.fillRect(-4, -20, 8, 5); }
  }
  ctx.restore();
  ctx.fillStyle = isMe ? 'rgba(216,212,200,0.85)' : 'rgba(216,212,200,0.5)';
  ctx.font = '9px ui-monospace,Consolas,monospace'; ctx.textAlign = 'center';
  ctx.fillText(isMe ? (myName + ' · YOU') : (r ? r.name : ''), x, y - 22);
}
function drawCreature(t) {
  const c = view.c;
  if (!inView(c.x, c.y, 80)) return;
  ctx.save(); ctx.translate(c.x, c.y);
  ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.beginPath(); ctx.ellipse(0, 6, 22, 11, 0, 0, 7); ctx.fill();
  const hunt = c.s === 'hunt', spdF = hunt ? 2.2 : 1;
  const tw = hunt ? (Math.random() - 0.5) * 2.4 : 0;
  ctx.rotate(c.d + tw * 0.02);
  ctx.strokeStyle = '#0a0a0e'; ctx.lineWidth = 2.6; ctx.lineCap = 'round';
  for (let side = -1; side <= 1; side += 2) for (let i = 0; i < 3; i++) {
    const bx = -14 + i * 10;
    const ph = Math.sin(t * 9 * spdF + i * 2.1 + (side > 0 ? 0 : Math.PI));
    const fx = bx + ph * 7, fy = side * (17 + Math.abs(ph) * 5);
    ctx.beginPath(); ctx.moveTo(bx, side * 5);
    ctx.quadraticCurveTo(bx + 4, side * (12 + Math.sin(t * 9 * spdF + i) * 2), fx, fy);
    ctx.stroke();
  }
  ctx.fillStyle = '#0c0c11'; ctx.beginPath(); ctx.ellipse(0, 0, 18, 8.5, 0, 0, 7); ctx.fill();
  ctx.fillStyle = '#111117'; ctx.beginPath(); ctx.ellipse(6, 0, 10, 6, 0, 0, 7); ctx.fill();
  ctx.save(); ctx.translate(20, tw * 0.6); ctx.rotate(tw * 0.05);
  ctx.fillStyle = '#cfc8b6'; ctx.beginPath(); ctx.ellipse(0, 0, 8.5, 4.6, 0, 0, 7); ctx.fill();
  ctx.strokeStyle = 'rgba(90,80,70,0.7)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(2, 3.4); ctx.lineTo(7, 2.2); ctx.stroke();
  ctx.restore();
  ctx.restore();
}
function drawDarkness() {
  const dim = phase === 'won' ? 0.55 : 0.93;
  dctx.globalCompositeOperation = 'source-over';
  dctx.clearRect(0, 0, W, H);
  dctx.fillStyle = 'rgba(3,5,13,' + dim + ')';
  dctx.fillRect(0, 0, W, H);
  dctx.globalCompositeOperation = 'destination-out';
  const lights = [];
  const me = view.me;
  if (me && me.s !== 2) lights.push({ x: local.x, y: local.y, r: me.s === 1 ? 120 : 195, i: 1 });
  for (const p of view.p) if (p.id !== NET.id && p.s !== 2) lights.push({ x: p.x, y: p.y, r: p.s === 1 ? 90 : 150, i: 0.85 });
  const pl = WORLD.plaza;
  lights.push({ x: pl.x, y: pl.y, r: genN >= genTotal ? 320 : 95, i: genN >= genTotal ? 1 : 0.55 });
  const now = performance.now();
  for (let i = flashes.length - 1; i >= 0; i--) {
    if (flashes[i].until < now) flashes.splice(i, 1);
    else lights.push({ x: flashes[i].x, y: flashes[i].y, r: flashes[i].r, i: 0.7 * (flashes[i].until - now) / 450 });
  }
  if (me && me.s === 2) lights.push({ x: view.c.x, y: view.c.y, r: 240, i: 0.5 });
  for (const L of lights) {
    const sx = w2sX(L.x), sy = w2sY(L.y);
    if (sx < -L.r || sx > W + L.r || sy < -L.r || sy > H + L.r) continue;
    const g = dctx.createRadialGradient(sx, sy, L.r * 0.12, sx, sy, L.r);
    g.addColorStop(0, 'rgba(0,0,0,' + L.i.toFixed(3) + ')'); g.addColorStop(1, 'rgba(0,0,0,0)');
    dctx.fillStyle = g; dctx.beginPath(); dctx.arc(sx, sy, L.r, 0, 7); dctx.fill();
  }
  ctx.drawImage(dark, 0, 0, W, H);
}
function drawRipples() {
  const now = performance.now();
  for (let i = ripples.length - 1; i >= 0; i--) {
    const rp = ripples[i], age = (now - rp.t) / 1000;
    const maxR = 90 + rp.i * 240;
    if (age * 300 > maxR) { ripples.splice(i, 1); continue; }
    const r = age * 300, a = (1 - r / maxR) * 0.5;
    ctx.strokeStyle = rp.kd === 'voice' ? 'rgba(232,163,61,' + a.toFixed(3) + ')' : 'rgba(216,212,200,' + (a * 0.8).toFixed(3) + ')';
    ctx.lineWidth = rp.kd === 'voice' ? 2 : 1.2;
    ctx.beginPath(); ctx.arc(w2sX(rp.x), w2sY(rp.y), r, 0, 7); ctx.stroke();
  }
  const me = view.me;
  if (me && me.s !== 2 && creatureDist < 210) {
    const a = (1 - creatureDist / 210) * (0.12 + Math.sin(now / 140) * 0.06);
    ctx.strokeStyle = 'rgba(194,43,51,' + Math.max(0, a).toFixed(3) + ')';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(w2sX(view.c.x), w2sY(view.c.y), 26 + Math.sin(now / 140) * 4, 0, 7); ctx.stroke();
  }
  for (let i = dusts.length - 1; i >= 0; i--) {
    const dp = dusts[i], age = (now - dp.t) / 600;
    if (age > 1) { dusts.splice(i, 1); continue; }
    ctx.fillStyle = 'rgba(160,150,130,' + (0.3 * (1 - age)).toFixed(3) + ')';
    for (let k = 0; k < 5; k++) {
      ctx.beginPath(); ctx.arc(w2sX(dp.x) + Math.cos(k * 1.3) * age * 14, w2sY(dp.y) + Math.sin(k * 1.3) * age * 10, 2.5 * (1 - age), 0, 7); ctx.fill();
    }
  }
  for (const pb of pebbles) {
    if (pb.life <= 0) continue;
    ctx.fillStyle = '#8f8a80';
    ctx.beginPath(); ctx.arc(w2sX(pb.x), w2sY(pb.y), 2.5, 0, 7); ctx.fill();
  }
  if (me && me.s === 0 && me.r > 0 && phase === 'play') {
    const m = worldMouse(), dx = m.x - local.x, dy = m.y - local.y, len = Math.hypot(dx, dy) || 1;
    ctx.strokeStyle = 'rgba(216,212,200,0.14)'; ctx.setLineDash([3, 7]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(w2sX(local.x), w2sY(local.y));
    ctx.lineTo(w2sX(local.x + dx / len * 240), w2sY(local.y + dy / len * 240)); ctx.stroke();
    ctx.setLineDash([]);
  }
}
function drawMinimap() {
  if (!WORLD) return;
  const mc = $('mini').getContext('2d'), s = 140 / WG.SIZE;
  mc.clearRect(0, 0, 140, 140);
  mc.fillStyle = 'rgba(10,12,18,0.75)'; mc.fillRect(0, 0, 140, 140);
  mc.fillStyle = '#3a3f4a';
  for (const b of WORLD.buildings) mc.fillRect(b.x * s, b.y * s, Math.max(2, b.w * s), Math.max(2, b.h * s));
  mc.strokeStyle = 'rgba(232,163,61,0.5)';
  mc.beginPath(); mc.arc(WORLD.plaza.x * s, WORLD.plaza.y * s, 6, 0, 7); mc.stroke();
  const last = snaps[snaps.length - 1];
  if (last) for (const f of last.d.fu) if (f[1] !== 'h' && f[1] !== 'i') {
    mc.fillStyle = '#e8a33d'; mc.fillRect(f[1] * s - 1, f[2] * s - 1, 2.5, 2.5);
  }
  for (const p of view.p) {
    if (p.s === 2) continue;
    mc.fillStyle = p.s === 1 ? '#c22b33' : (p.id === NET.id ? '#fff' : (roster.get(p.id) || { color: '#aaa' }).color);
    const px = (p.id === NET.id ? local.x : p.x) * s, py = (p.id === NET.id ? local.y : p.y) * s;
    mc.beginPath(); mc.arc(px, py, p.id === NET.id ? 3 : 2.2, 0, 7); mc.fill();
  }
}

/* ---------------- main loop ---------------- */
let lastT = performance.now(), clickT = 0, ambientT = 5;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - lastT) / 1000); lastT = now;
  const t = now / 1000;
  micTick(dt); micSend();
  if (!WORLD || !snaps.length) return;

  view = buildView(); if (!view) return;
  predict(dt);

  const me = view.me;
  creatureDist = me ? Math.hypot(view.c.x - local.x, view.c.y - local.y) : 1e9;

  const fx = me && me.s !== 2 ? local.x : view.c.x;
  const fy = me && me.s !== 2 ? local.y : view.c.y;
  cam.x += (fx - cam.x) * Math.min(1, dt * 6);
  cam.y += (fy - cam.y) * Math.min(1, dt * 6);
  shake = Math.max(0, shake - dt * 30);
  redPulse = Math.max(0, redPulse - dt * 0.7);

  for (const pb of pebbles) { pb.x += pb.vx * dt; pb.y += pb.vy * dt; pb.vx *= (1 - 2.2 * dt); pb.vy *= (1 - 2.2 * dt); pb.life -= dt; }

  if (ac) {
    if (growlGain) {
      const gv = view.c.s === 'hunt' && creatureDist < 700 && me && me.s !== 2 ? clamp(1 - creatureDist / 700, 0, 1) * 0.16 : 0;
      growlGain.gain.setTargetAtTime(gv, ac.currentTime, 0.2);
    }
    if (me && me.s === 0 && creatureDist < 640) {
      const iv = lerp(0.34, 1.15, clamp(creatureDist / 640, 0, 1));
      if (t >= hbNext) { heartbeat(lerp(0.5, 0.14, creatureDist / 640)); hbNext = t + iv; }
    }
    if ((view.c.s === 'search' || view.c.s === 'investigate') && creatureDist < 520 && t > clickT) {
      clickT = t + 0.7 + Math.random();
      sfx.click(clamp(1 - creatureDist / 520, 0, 1), view.c.x, view.c.y);
    }
    if (view.c.s === 'hunt' && !prevHunt && creatureDist < 560 && me && me.s !== 2) shake = Math.max(shake, 8);
    prevHunt = view.c.s === 'hunt';
    ambientT -= dt;
    if (ambientT < 0) {
      ambientT = 8 + Math.random() * 14;
      noiseHit(ac.currentTime, 1.4, 500 + Math.random() * 600, 0.5, 0.03, cam.x + (Math.random() - 0.5) * 900, cam.y + (Math.random() - 0.5) * 900);
    }
  }

  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = '#04050a'; ctx.fillRect(0, 0, W, H);
  const shx = (Math.random() - 0.5) * shake, shy = (Math.random() - 0.5) * shake;
  ctx.save();
  ctx.translate(-cam.x + W / 2 + shx, -cam.y + H / 2 + shy);
  drawWorldBase(t);
  drawBuildings();
  drawGenerator(t);
  drawFuses(t);
  drawCreature(t);
  for (const p of view.p) if (p.s !== 2) drawPlayer(p, t, p.id === NET.id);
  ctx.restore();

  drawDarkness();

  ctx.save(); ctx.translate(shx, shy);
  drawRipples();
  ctx.restore();

  ctx.fillStyle = 'rgba(200,195,185,0.16)';
  for (const a of ash) {
    a.x += dt * 12 * a.z; a.y += dt * 5 * a.z;
    if (a.x > W + 10) a.x = -10;
    if (a.y > H + 10) a.y = -10;
    ctx.fillRect(a.x, a.y, a.z * 1.8, a.z * 1.8);
  }
  grainI = (grainI + 1) % 3;
  ctx.save(); ctx.globalAlpha = 0.5;
  ctx.translate(-((Math.random() * 160) | 0), -((Math.random() * 160) | 0));
  ctx.fillStyle = grainPat[grainI]; ctx.fillRect(0, 0, W + 160, H + 160);
  ctx.restore();
  ctx.drawImage(vign, 0, 0);

  $('pulse').style.opacity = clamp(redPulse + (creatureDist < 150 && me && me.s !== 2 ? (1 - creatureDist / 150) * 0.5 : 0), 0, 1);

  updateHUD();
  drawMinimap();
}
requestAnimationFrame(frame);

/* ---------------- boot ---------------- */
joinRoom = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
$('room').value = joinRoom;
$('begin').addEventListener('click', async () => {
  myName = $('name').value.trim() || 'SURVIVOR';
  joinRoom = $('room').value.trim().toUpperCase() || joinRoom;
  audioInit();
  if (ac.state === 'suspended') await ac.resume();
  $('title').classList.add('hidden');
  $('miccheck').classList.remove('hidden');
  await micStart();
});
$('skipMic').addEventListener('click', () => { MIC.calib = false; connect(); });
[$('name'), $('room')].forEach(el => el.addEventListener('keydown', e => {
  if (e.key === 'Enter') $('begin').click();
  e.stopPropagation();
}));
