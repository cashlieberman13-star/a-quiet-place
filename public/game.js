'use strict';
/* A QUIET PLACE v3 — realistic pass: textures, ACES, black fog, volumetric flashlight,
   grass wind sway, villages/plane landmarks, jumpscares, 2-hit, auto-quality. */
const WG = window.WorldGen;
const $ = id => document.getElementById(id);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const INTERP = 110;

const cv = $('cv');
let renderer, scene, camera, sun, hemi, spot, spotTarget, genLight, vm, vmLens, beamCone, dustPts, stars, moonSpr;
let W = 0, H = 0;

const NET = { ws: null, id: -1, open: false, wasInGame: false, send(m) { if (this.open && this.ws.readyState === 1) this.ws.send(JSON.stringify(m)); } };
const roster = new Map();
let WORLD = null, solidsCache = null, solidsKey = '';
let snaps = [], doorsOpen = [];
let phase = 'title', phaseT = 0, graceT = 0, genN = 0, genTotal = 5;
let cyc = 'night', cycT = WG.NIGHT;
let myColor = '#c9b27c', myName = '', ROOM = '', joinRoom = '', night = 1, wasDead = false, prevHunt = false;
let shake = 0, redPulse = 0, creatureDist = 1e9;
let yaw = 0, pitch = 0, tYaw = 0, tPitch = 0, locked = false, lastRunning = false;
const keys = {};
let stamina = 100, stamBroken = false, flashOn = false;
const local = { x: 0, z: 0, y: 1.62, init: false, stepAcc: 0, bob: 0 };
let view = null;
let groundMesh, houseMesh, roofMesh, doorMeshes = [], treeTrunks, treeCans, planeMesh, grassChunks = new Map();
let creature = null, cPhase = 0;
const playerObjs = new Map();
const fuseMeshes = new Map(), ringPool = [], rings = [], pebbles = [], pebbleMeshes = [];
let dayF = 0;

/* auto quality */
let qLevel = 2, qAcc = 0, qN = 0, qT = 0, GRASS_R = 2;
function applyQuality() {
  if (qLevel === 2) { renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5)); renderer.shadowMap.enabled = true; GRASS_R = 2; }
  else if (qLevel === 1) { renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.25)); renderer.shadowMap.enabled = true; GRASS_R = 2; }
  else { renderer.setPixelRatio(1); renderer.shadowMap.enabled = false; GRASS_R = 1; }
}

/* ================= textures (all procedural) ================= */
const TEX = {};
function cnv(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h || w; return c; }
function srgb(t) { t.encoding = THREE.sRGBEncoding; return t; }
function buildTextures() {
  // grass blade cluster (alpha tested)
  {
    const c = cnv(128), g = c.getContext('2d');
    g.clearRect(0, 0, 128, 128);
    for (let i = 0; i < 16; i++) {
      const x = 8 + Math.random() * 112, h = 50 + Math.random() * 70, bend = (Math.random() - 0.5) * 40;
      const gr = g.createLinearGradient(x, 128, x + bend, 128 - h);
      gr.addColorStop(0, '#243d18'); gr.addColorStop(0.6, '#3f6127'); gr.addColorStop(1, '#5d8433');
      g.strokeStyle = gr; g.lineWidth = 2 + Math.random() * 2.5; g.lineCap = 'round';
      g.beginPath(); g.moveTo(x, 128); g.quadraticCurveTo(x + bend * 0.3, 128 - h * 0.6, x + bend, 128 - h); g.stroke();
    }
    TEX.grass = srgb(new THREE.CanvasTexture(c));
  }
  // brick
  {
    const c = cnv(256), g = c.getContext('2d');
    g.fillStyle = '#57493c'; g.fillRect(0, 0, 256, 256);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 8; x++) {
      const off = (y % 2) * 16;
      g.fillStyle = `hsl(${18 + Math.random() * 10},${22 + Math.random() * 12}%,${24 + Math.random() * 12}%)`;
      g.fillRect(x * 32 + off - 16 + 1, y * 16 + 1, 30, 14);
    }
    g.globalAlpha = 0.25; g.fillStyle = '#000';
    for (let i = 0; i < 40; i++) g.fillRect(Math.random() * 256, Math.random() * 256, 2 + Math.random() * 30, 1 + Math.random() * 8);
    g.globalAlpha = 1;
    TEX.brick = srgb(new THREE.CanvasTexture(c)); TEX.brick.wrapS = TEX.brick.wrapT = THREE.RepeatWrapping;
  }
  // shingles
  {
    const c = cnv(128), g = c.getContext('2d');
    g.fillStyle = '#2b2b2e'; g.fillRect(0, 0, 128, 128);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      g.fillStyle = `hsl(240,6%,${12 + Math.random() * 10}%)`;
      g.fillRect(x * 16 + ((y % 2) * 8) - 8, y * 16, 15, 15);
    }
    TEX.roof = srgb(new THREE.CanvasTexture(c)); TEX.roof.wrapS = TEX.roof.wrapT = THREE.RepeatWrapping;
  }
  // scratched metal
  {
    const c = cnv(256), g = c.getContext('2d');
    g.fillStyle = '#767d80'; g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 300; i++) { g.fillStyle = `rgba(${40 + Math.random() * 60},${44 + Math.random() * 60},${46 + Math.random() * 60},.5)`; g.fillRect(Math.random() * 256, Math.random() * 256, 1 + Math.random() * 40, 1); }
    g.fillStyle = 'rgba(122,74,42,.55)';
    for (let i = 0; i < 26; i++) { g.beginPath(); g.arc(Math.random() * 256, Math.random() * 256, 3 + Math.random() * 14, 0, 7); g.fill(); }
    g.fillStyle = '#3d4245';
    for (let x = 8; x < 256; x += 32) for (let y = 8; y < 256; y += 32) { g.beginPath(); g.arc(x, y, 2, 0, 7); g.fill(); }
    TEX.metal = srgb(new THREE.CanvasTexture(c));
  }
}

/* ================= audio ================= */
let ac = null, master = null, noiseBuf = null, growlGain = null;
function audioInit() {
  if (ac) return;
  ac = new (window.AudioContext || window.webkitAudioContext)();
  master = ac.createGain(); master.gain.value = 0.9;
  master.connect(ac.createDynamicsCompressor()).connect(ac.destination);
  noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
  const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 300; bp.Q.value = 0.5;
  const g = ac.createGain(); g.gain.value = 0.04;
  const lfo = ac.createOscillator(); lfo.frequency.value = 0.07;
  const lg = ac.createGain(); lg.gain.value = 120;
  lfo.connect(lg).connect(bp.frequency);
  src.connect(bp).connect(g).connect(master); src.start(); lfo.start();
  [48, 48.8].forEach(f => { const o = ac.createOscillator(); o.type = 'triangle'; o.frequency.value = f;
    const og = ac.createGain(); og.gain.value = 0.014; o.connect(og).connect(master); o.start(); });
  const go = ac.createOscillator(); go.type = 'sawtooth'; go.frequency.value = 46;
  const ws2 = ac.createWaveShaper(); const curve = new Float32Array(256);
  for (let i = 0; i < 256; i++) curve[i] = Math.tanh((i / 128 - 1) * 3);
  ws2.curve = curve;
  growlGain = ac.createGain(); growlGain.gain.value = 0;
  go.connect(ws2).connect(growlGain).connect(master); go.start();
}
function panNode(x, z) {
  if (!ac.createStereoPanner) return master;
  const p = ac.createStereoPanner();
  const ang = Math.atan2(x - local.x, z - local.z) - yaw;
  p.pan.value = clamp(-Math.sin(ang), -1, 1);
  p.connect(master); return p;
}
function noiseHit(t, dur, freq, q, vol, x, z) {
  const s = ac.createBufferSource(); s.buffer = noiseBuf; s.playbackRate.value = 0.9 + Math.random() * 0.2;
  const f = ac.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(Math.max(0.001, vol), t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f).connect(g).connect(panNode(x, z)); s.start(t); s.stop(t + dur + 0.05);
}
function tone(t, type, f0, f1, dur, vol, x, z) {
  const o = ac.createOscillator(); o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(Math.max(0.001, vol), t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(panNode(x, z)); o.start(t); o.stop(t + dur + 0.05);
  return o;
}
const sfx = {
  step(v, x, z, hard) { const t = ac.currentTime;
    noiseHit(t, 0.07, hard ? 700 + Math.random() * 400 : 240 + Math.random() * 260, 1.3, v, x, z);
    tone(t, 'sine', hard ? 140 : 85, 55, 0.05, v * 0.5, x, z); },
  cstep(v, x, z) { noiseHit(ac.currentTime, 0.05, 180 + Math.random() * 120, 1.5, v, x, z); },
  door(v, x, z) { const t = ac.currentTime; const o = tone(t, 'sawtooth', 96, 68, 0.55, v * 0.35, x, z);
    const lfo = ac.createOscillator(); lfo.frequency.value = 11; const lg = ac.createGain(); lg.gain.value = v * 0.2;
    lfo.connect(lg).connect(o.frequency); lfo.start(t); lfo.stop(t + 0.6); },
  breach(v, x, z) { const t = ac.currentTime; noiseHit(t, 0.4, 240, 0.7, v, x, z); tone(t, 'sine', 90, 34, 0.35, v, x, z); },
  shriek(v, x, z) {
    const t = ac.currentTime;
    const dl = ac.createDelay(); dl.delayTime.value = 0.11; const fb = ac.createGain(); fb.gain.value = 0.3;
    dl.connect(fb).connect(dl); const out = ac.createGain(); dl.connect(out); out.connect(panNode(x, z));
    [[950, 240, 'sawtooth'], [1400, 310, 'square']].forEach(pr => {
      const o = ac.createOscillator(); o.type = pr[2];
      o.frequency.setValueAtTime(pr[0], t); o.frequency.exponentialRampToValueAtTime(pr[1], t + 0.85);
      const g = ac.createGain(); g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(v * 0.28, t + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.95);
      o.connect(g); g.connect(master); g.connect(dl); o.start(t); o.stop(t + 1);
    });
    noiseHit(t, 0.7, 1900, 0.8, v * 0.5, x, z);
  },
  roar(v, x, z) {
    const t = ac.currentTime;
    tone(t, 'sawtooth', 320, 70, 1.2, v * 0.5, x, z);
    tone(t, 'square', 210, 55, 1.2, v * 0.35, x, z);
    noiseHit(t, 1.0, 500, 0.7, v * 0.4, x, z);
  },
  scream(v, x, z) { const t = ac.currentTime; tone(t, 'sawtooth', 700, 190, 0.5, v * 0.4, x, z); noiseHit(t, 0.35, 1200, 1, v * 0.3, x, z); },
  boom(v, x, z) { const t = ac.currentTime; tone(t, 'sine', 70, 26, 0.9, v, x, z); noiseHit(t, 0.6, 160, 0.6, v * 0.5, x, z); },
  chime(v, x, z) { const t = ac.currentTime; tone(t, 'sine', 660, 0, 0.3, v * 0.3, x, z); tone(t + 0.09, 'sine', 990, 0, 0.4, v * 0.25, x, z); },
  install(v, x, z) { const t = ac.currentTime; tone(t, 'square', 220, 180, 0.12, v * 0.3, x, z); noiseHit(t, 0.06, 2400, 2, v * 0.25, x, z); },
  revive(v, x, z) { const t = ac.currentTime; tone(t, 'triangle', 220, 0, 0.5, v * 0.3, x, z); tone(t + 0.12, 'triangle', 277, 0, 0.6, v * 0.3, x, z); },
  thud(v, x, z) { const t = ac.currentTime; noiseHit(t, 0.1, 500, 1, v * 0.5, x, z); tone(t, 'sine', 140, 70, 0.09, v * 0.4, x, z); },
  cfoot(v, x, z) { const t = ac.currentTime; tone(t, 'sine', 52, 28, 0.16, v * 1.0, x, z); noiseHit(t, 0.09, 140, 0.8, v * 0.5, x, z); },
  win(v) { const t = ac.currentTime; [220, 330, 440, 660].forEach((f, i) => tone(t + i * 0.16, 'triangle', f, 0, 0.8, v * 0.25, local.x, local.z)); },
  lose(v) { const t = ac.currentTime; tone(t, 'sawtooth', 110, 40, 2.4, v * 0.3, local.x, local.z); },
  click(v, x, z) { noiseHit(ac.currentTime, 0.03, 2600 + Math.random() * 900, 6, v * 0.4, x, z); },
  tinnitus() { tone(ac.currentTime, 'sine', 3900, 3600, 2.2, 0.05, local.x, local.z); }
};
let hbNext = 0, breathNext = 0, cStepNext = 0;
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
function breath(v) {
  const t = ac.currentTime;
  noiseHit(t, 0.5, 600, 0.6, v * 0.5, local.x, local.z);
  noiseHit(t + 0.65, 0.7, 420, 0.6, v * 0.65, local.x, local.z);
}

/* ================= mic ================= */
const MIC = { on: false, analyser: null, data: null, lvl: 0, thr: 0.012, calib: false, calibT: 0, samples: [], lastSend: 0, stream: null };
async function micStart() {
  try {
    MIC.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false } });
    const src = ac.createMediaStreamSource(MIC.stream);
    MIC.analyser = ac.createAnalyser(); MIC.analyser.fftSize = 1024;
    MIC.data = new Float32Array(MIC.analyser.fftSize);
    src.connect(MIC.analyser);
    MIC.on = true; MIC.calib = true; MIC.calibT = 0; MIC.samples = [];
    $('mcStatus').textContent = 'LISTENING FOR ROOM TONE — STAY SILENT';
  } catch (e) {
    MIC.on = false; MIC.calib = false;
    $('mcStatus').textContent = 'MICROPHONE DENIED — MUTE & NO VOICE CHAT';
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
    if (now - MIC.lastSend > 110) { MIC.lastSend = now; NET.send({ t: 'noise', v }); }
  }
}

/* ================= voice ================= */
const VC = { pcs: new Map(), nodes: new Map() };
function vcDrop(id) {
  const pc = VC.pcs.get(id); if (pc) { try { pc.close(); } catch (e) {} VC.pcs.delete(id); }
  const n = VC.nodes.get(id); if (n) { try { n.src.disconnect(); } catch (e) {} VC.nodes.delete(id); }
}
function vcEnsurePeer(id) {
  if (!MIC.stream || VC.pcs.has(id) || id === NET.id) return;
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  VC.pcs.set(id, pc);
  MIC.stream.getAudioTracks().forEach(tr => pc.addTrack(tr, MIC.stream));
  pc.onicecandidate = e => { if (e.candidate) NET.send({ t: 'rtc', to: id, c: { cand: e.candidate } }); };
  pc.ontrack = e => {
    const src = ac.createMediaStreamSource(e.streams[0]);
    const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 9000;
    const g = ac.createGain(); g.gain.value = 0;
    let pan = null;
    if (ac.createStereoPanner) { pan = ac.createStereoPanner(); src.connect(f).connect(g).connect(pan).connect(master); }
    else src.connect(f).connect(g).connect(master);
    VC.nodes.set(id, { src, f, g, pan });
  };
  pc.onconnectionstatechange = () => { if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) vcDrop(id); };
  if (NET.id < id) pc.createOffer().then(o => pc.setLocalDescription(o)).then(() => NET.send({ t: 'rtc', to: id, c: { sdp: pc.localDescription } }));
}
function vcSignal(from, c) {
  vcEnsurePeer(from);
  const pc = VC.pcs.get(from); if (!pc) return;
  if (c.sdp) {
    if (c.sdp.type === 'offer') pc.setRemoteDescription(c.sdp).then(() => pc.createAnswer()).then(a => pc.setLocalDescription(a)).then(() => NET.send({ t: 'rtc', to: from, c: { sdp: pc.localDescription } }));
    else pc.setRemoteDescription(c.sdp).catch(() => {});
  } else if (c.cand) pc.addIceCandidate(c.cand).catch(() => {});
}
function vcFrame() {
  if (!ac || !view) return;
  const me = view.me;
  for (const [id, n] of VC.nodes) {
    const pl = view.p.find(q => q.id === id);
    let g = 0;
    if (pl && pl.s < 3 && me && me.s < 3) {
      const d = Math.hypot(pl.x - local.x, pl.z - local.z);
      if (d < 28) g = Math.pow(1 - d / 28, 1.6) * 1.5;
      if (n.pan) {
        const ang = Math.atan2(pl.x - local.x, pl.z - local.z) - yaw;
        n.pan.pan.setTargetAtTime(clamp(-Math.sin(ang), -1, 1), ac.currentTime, 0.1);
      }
      n.f.frequency.setTargetAtTime(lerp(9000, 900, clamp(d / 28, 0, 1)), ac.currentTime, 0.1);
    }
    n.g.gain.setTargetAtTime(g, ac.currentTime, 0.09);
  }
}

/* ================= net ================= */
function connect() {
  if (NET.ws && (NET.ws.readyState === 0 || NET.ws.readyState === 1)) return;
  const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
  NET.ws = new WebSocket(url);
  NET.ws.onopen = () => { NET.open = true; NET.send({ t: 'join', name: myName, room: joinRoom }); };
  NET.ws.onclose = () => { NET.open = false; if (NET.wasInGame) { banner('SIGNAL LOST — RECONNECTING', true); setTimeout(connect, 1600); } };
  NET.ws.onmessage = e => onMsg(JSON.parse(e.data));
}
function onMsg(m) {
  switch (m.t) {
    case 'full': banner('THAT ROOM IS FULL — 8 MAX', true); NET.ws.close(); break;
    case 'welcome':
      NET.id = m.id; myColor = m.color; ROOM = m.room; joinRoom = m.room;
      roster.clear(); m.roster.forEach(r => { roster.set(r.id, r); vcEnsurePeer(r.id); });
      try { history.replaceState(null, '', '?room=' + ROOM); } catch (e) {}
      initWorld(m.world);
      $('title').classList.add('hidden'); $('miccheck').classList.add('hidden');
      $('hud').classList.remove('hidden'); NET.wasInGame = true;
      $('lock').classList.remove('hidden');
      banner('ROOM ' + ROOM + ' — NIGHT ' + night + ' — MAKE NO SOUND');
      break;
    case 'reset': night++; initWorld(m.world); snaps = []; banner('NIGHT ' + night + ' — IT IS STILL HUNGRY'); break;
    case 'peer': roster.set(m.id, { name: m.name, color: m.color }); vcEnsurePeer(m.id); log(m.name + ' ARRIVED'); break;
    case 'leave': { const r = roster.get(m.id); if (r) log(r.name + ' IS GONE'); roster.delete(m.id); vcDrop(m.id); disposePlayer(m.id); break; }
    case 'rtc': vcSignal(m.from, m.c); break;
    case 'state': onState(m); break;
  }
}
function onState(d) {
  snaps.push({ t: performance.now(), d });
  if (snaps.length > 12) snaps.shift();
  phase = d.ph; phaseT = d.pt; graceT = d.gr; genN = d.gn; genTotal = d.gt;
  cyc = d.cyc.c; cycT = d.cyc.t;
  const key = d.dn.join('');
  if (key !== solidsKey) { doorsOpen = d.dn; solidsKey = key; rebuildSolids(); }
  handleEvents(d.ev);
  const rawMe = d.p.find(q => q.id === NET.id);
  if (rawMe && local.init) {
    const err = Math.hypot(rawMe.x - local.x, rawMe.z - local.z);
    if (err > 3) { local.x = rawMe.x; local.z = rawMe.z; }
    else { local.x += (rawMe.x - local.x) * 0.25; local.z += (rawMe.z - local.z) * 0.25; }
  }
  if (rawMe && rawMe.s === 0) wasDead = false;
}

/* ================= jumpscare ================= */
let scareFace = null;
function buildScareFace() {
  const c = cnv(640, 360), g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, 640, 360);
  const cx = 320, cy = 185;
  const skull = g.createRadialGradient(cx, cy, 20, cx, cy, 210);
  skull.addColorStop(0, '#d6cbb2'); skull.addColorStop(0.65, '#8a7d63'); skull.addColorStop(1, 'rgba(10,8,5,0)');
  g.fillStyle = skull;
  g.beginPath(); g.ellipse(cx, cy, 150, 195, 0, 0, 7); g.fill();
  const eye = (x, y) => {
    const e = g.createRadialGradient(x, y, 4, x, y, 62);
    e.addColorStop(0, '#000'); e.addColorStop(0.7, '#000'); e.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = e; g.beginPath(); g.ellipse(x, y, 46, 66, 0.15, 0, 7); g.fill();
  };
  eye(262, 140); eye(382, 138);
  const mouth = g.createRadialGradient(cx, 300, 8, cx, 300, 130);
  mouth.addColorStop(0, '#000'); mouth.addColorStop(0.75, '#000'); mouth.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = mouth; g.beginPath(); g.ellipse(cx, 300, 74, 110, 0, 0, 7); g.fill();
  g.fillStyle = '#cfc4aa';
  for (let i = -3; i <= 3; i++) {
    g.beginPath(); g.moveTo(cx + i * 18 - 7, 218); g.lineTo(cx + i * 18 + 7, 218); g.lineTo(cx + i * 18, 244 - Math.abs(i) * 4); g.fill();
  }
  g.strokeStyle = 'rgba(30,24,16,.8)'; g.lineWidth = 2;
  for (let i = 0; i < 14; i++) {
    g.beginPath();
    const a = Math.random() * 6.28, r0 = 60 + Math.random() * 60;
    g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0 * 1.2);
    g.lineTo(cx + Math.cos(a) * (r0 + 30 + Math.random() * 50), cy + Math.sin(a) * (r0 + 40) * 1.2);
    g.stroke();
  }
  g.globalAlpha = 0.16;
  for (let i = 0; i < 900; i++) { g.fillStyle = Math.random() < 0.5 ? '#000' : '#e8e0cc'; g.fillRect(Math.random() * 640, Math.random() * 360, 1, 2 + Math.random() * 14); }
  g.globalAlpha = 1;
  scareFace = c;
}
let scareT = 0;
function jumpscare(dur) {
  if (!scareFace) buildScareFace();
  $('scareCv').getContext('2d').drawImage(scareFace, 0, 0);
  $('scare').classList.add('on');
  shake = Math.max(shake, 1.4);
  clearTimeout(scareT);
  scareT = setTimeout(() => $('scare').classList.remove('on'), dur);
}

/* ================= world build ================= */
function rebuildSolids() {
  if (!WORLD) return;
  const arr = WORLD.walls.slice();
  WORLD.doors.forEach((dr, i) => { if (!doorsOpen[i]) arr.push(dr); });
  solidsCache = arr;
}
function clientSolids() { return solidsCache || (rebuildSolids(), solidsCache); }
function mergeGeoms(geoms) {
  geoms = geoms.map(g => {
    if (g.index === null || g.index === undefined) {   // ExtrudeGeometry is non-indexed
      const n = g.attributes.position.count;
      const arr = new Uint32Array(n);
      for (let i = 0; i < n; i++) arr[i] = i;
      g.setIndex(new THREE.BufferAttribute(arr, 1));
    }
    return g;
  });
  let vc = 0, ic = 0;
  geoms.forEach(g => { vc += g.attributes.position.count; ic += g.index.count; });
  const pos = new Float32Array(vc * 3), nor = new Float32Array(vc * 3), uv = new Float32Array(vc * 2), idx = new Uint32Array(ic);
  let vo = 0, io = 0;
  geoms.forEach(g => {
    pos.set(g.attributes.position.array, vo * 3);
    nor.set(g.attributes.normal.array, vo * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array, vo * 2);
    const gi = g.index.array;
    for (let i = 0; i < gi.length; i++) idx[io + i] = gi[i] + vo;
    io += gi.length; vo += g.attributes.position.count;
  });
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}
function boxAt(x, y, z, sx, sy, sz) { const g = new THREE.BoxGeometry(sx, sy, sz); g.translate(x, y, z); return g; }
function roofGeo(w, h, d) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, 0); s.lineTo(0, h); s.lineTo(w / 2, 0); s.lineTo(-w / 2, 0);
  const g = new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: false });
  g.translate(0, 0, -d / 2);
  return g;
}
function groundTexture() {
  const S = 2048, c = cnv(S), g = c.getContext('2d'), rnd = WG.mulberry32(WORLD.seed ^ 0x77aa);
  const sc = S / WG.SIZE;
  g.fillStyle = '#3d5231'; g.fillRect(0, 0, S, S);
  for (let i = 0; i < 30000; i++) {
    g.fillStyle = ['#35492b', '#465c36', '#2e4026', '#4a613a', '#3a4f2e', '#2a3a22'][(rnd() * 6) | 0];
    g.globalAlpha = 0.3 + rnd() * 0.5;
    g.fillRect(rnd() * S, rnd() * S, 1 + rnd() * 3, 1 + rnd() * 3);
  }
  g.globalAlpha = 1;
  // forest floor darkening
  for (let i = 0; i < 9000; i++) {
    const x = rnd() * WG.SIZE, z = rnd() * WG.SIZE;
    if (WG.forestN(x, z, WORLD.fOff) > 0.55) { g.fillStyle = 'rgba(14,20,10,.5)'; g.fillRect(x * sc, z * sc, 3, 3); }
  }
  // roads
  g.strokeStyle = '#565a58'; g.lineCap = 'round'; g.lineWidth = 8 * sc;
  g.beginPath();
  for (let z = 0; z <= WG.SIZE; z += 8) { const x = WG.roadX(z); z === 0 ? g.moveTo(x * sc, z * sc) : g.lineTo(x * sc, z * sc); }
  g.stroke();
  g.beginPath();
  for (let x = 0; x <= WG.SIZE; x += 8) { const z = WG.roadZ(x); x === 0 ? g.moveTo(x * sc, z * sc) : g.lineTo(x * sc, z * sc); }
  g.stroke();
  g.strokeStyle = 'rgba(30,30,30,.5)'; g.lineWidth = 1.2 * sc;
  for (let i = 0; i < 60; i++) { const z = rnd() * WG.SIZE, x = WG.roadX(z); g.beginPath(); g.moveTo(x * sc - 10, z * sc); g.lineTo(x * sc + 10, (z + 6) * sc); g.stroke(); }
  // dirt paths: villages & plane to nearest road
  g.strokeStyle = '#5d584a'; g.lineWidth = 2.6 * sc; g.setLineDash([]);
  const path = (x1, z1, x2, z2) => { g.beginPath(); g.moveTo(x1 * sc, z1 * sc); g.quadraticCurveTo(((x1 + x2) / 2 + 20) * sc, ((z1 + z2) / 2) * sc, x2 * sc, z2 * sc); g.stroke(); };
  WORLD.villages.forEach(v => path(v.x, v.z, WG.roadX(v.z), v.z));
  if (WORLD.plane) path(WORLD.plane.x, WORLD.plane.z, WORLD.plane.x, WG.roadZ(WORLD.plane.x));
  // plaza + village squares
  const dirt = (x, z, r) => { const rg = g.createRadialGradient(x * sc, z * sc, 2, x * sc, z * sc, r * sc); rg.addColorStop(0, '#6b6455'); rg.addColorStop(1, 'rgba(107,100,85,0)'); g.fillStyle = rg; g.beginPath(); g.arc(x * sc, z * sc, r * sc, 0, 7); g.fill(); };
  dirt(WORLD.plaza.x, WORLD.plaza.z, 40);
  WORLD.villages.forEach(v => dirt(v.x, v.z, 26));
  // plane scorch
  if (WORLD.plane) { const p = WORLD.plane; const rg = g.createRadialGradient(p.x * sc, p.z * sc, 2, p.x * sc, p.z * sc, 26 * sc); rg.addColorStop(0, 'rgba(8,8,8,.9)'); rg.addColorStop(1, 'rgba(8,8,8,0)'); g.fillStyle = rg; g.beginPath(); g.arc(p.x * sc, p.z * sc, 26 * sc, 0, 7); g.fill(); }
  g.fillStyle = '#4a443c';
  for (const b of WORLD.buildings) g.fillRect(b.x * sc, b.z * sc, b.w * sc, b.h * sc);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return srgb(tex);
}
function buildWorld3D() {
  const seg = 180;
  const gg = new THREE.PlaneGeometry(WG.SIZE, WG.SIZE, seg, seg);
  gg.rotateX(-Math.PI / 2);
  const pa = gg.attributes.position;
  for (let i = 0; i < pa.count; i++) pa.setY(i, WG.height(pa.getX(i) + WG.SIZE / 2, pa.getZ(i) + WG.SIZE / 2));
  gg.computeVertexNormals();
  groundMesh = new THREE.Mesh(gg, new THREE.MeshLambertMaterial({ map: groundTexture() }));
  groundMesh.position.set(WG.SIZE / 2, 0, WG.SIZE / 2);
  groundMesh.receiveShadow = true;
  scene.add(groundMesh);

  const WH = 2.8, wallParts = [], roofParts = [];
  for (const w of WORLD.walls) {
    const y = WG.height(w.x + w.w / 2, w.z + w.h / 2);
    wallParts.push(boxAt(w.x + w.w / 2, y + WH / 2, w.z + w.h / 2, w.w, WH, w.h));
  }
  for (const b of WORLD.buildings) {
    const y = WG.height(b.x + b.w / 2, b.z + b.h / 2);
    const rg = roofGeo(b.w + 0.7, 1.5, b.h + 0.7);
    rg.translate(b.x + b.w / 2, y + WH, b.z + b.h / 2);
    roofParts.push(rg);
    if (rnd01(b.x) < 0.5) wallParts.push(boxAt(b.x + b.w * 0.3, y + WH + 0.7, b.z + b.h * 0.3, 0.5, 1.4, 0.5)); // chimney
  }
  houseMesh = new THREE.Mesh(mergeGeoms(wallParts), new THREE.MeshLambertMaterial({ map: TEX.brick }));
  houseMesh.castShadow = true; houseMesh.receiveShadow = true;
  scene.add(houseMesh);
  roofMesh = new THREE.Mesh(mergeGeoms(roofParts), new THREE.MeshLambertMaterial({ map: TEX.roof }));
  roofMesh.castShadow = true;
  scene.add(roofMesh);

  doorMeshes = WORLD.doors.map(dr => {
    const horiz = dr.w > dr.h;
    const len = horiz ? dr.w : dr.h;
    const g = new THREE.BoxGeometry(len, 2.2, 0.1);
    g.translate(len / 2, 1.1, 0);
    const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: 0x4a3a26 }));
    const hx = horiz ? dr.x : dr.x + dr.w / 2;
    const hz = horiz ? dr.z + dr.h / 2 : dr.z;
    m.position.set(hx, WG.height(hx, hz), hz);
    m.rotation.y = (horiz ? 0 : Math.PI / 2) + (rnd01(dr.x) < 0.3 ? 0.5 : 0); // some hang ajar
    m.castShadow = true;
    scene.add(m);
    return m;
  });

  const n = WORLD.trees.length;
  const tg = new THREE.CylinderGeometry(0.12, 0.22, 2.4, 5); tg.translate(0, 1.2, 0);
  treeTrunks = new THREE.InstancedMesh(tg, new THREE.MeshLambertMaterial({ color: 0x3a2c1c }), n);
  treeTrunks.castShadow = true; treeTrunks.frustumCulled = false;
  const c1 = new THREE.ConeGeometry(1.4, 3.4, 6); c1.translate(0, 3.2, 0);
  const c2 = new THREE.ConeGeometry(1.0, 2.4, 6); c2.translate(0, 4.6, 0);
  const c3 = new THREE.ConeGeometry(0.6, 1.6, 6); c3.translate(0, 5.8, 0);
  treeCans = new THREE.InstancedMesh(mergeGeoms([c1, c2, c3]), new THREE.MeshLambertMaterial({ color: 0x1c3018 }), n);
  treeCans.castShadow = true; treeCans.frustumCulled = false;
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler(), P = new THREE.Vector3(), SC = new THREE.Vector3();
  const col = new THREE.Color();
  WORLD.trees.forEach((tr, i) => {
    const y = WG.height(tr.x, tr.z);
    E.set(0, (tr.x * 7.3) % 6.28, 0); Q.setFromEuler(E);
    P.set(tr.x, y, tr.z); SC.set(1, 1, 1);
    M.compose(P, Q, SC); treeTrunks.setMatrixAt(i, M);
    const s = tr.cr / 2.2;
    SC.set(s, s * (0.9 + ((tr.x * 13.7) % 0.35)), s);
    M.compose(P, Q, SC); treeCans.setMatrixAt(i, M);
    col.setHSL(0.3 + ((tr.z * 3.1) % 0.05), 0.45, 0.12 + ((tr.x * 1.7) % 0.07));
    treeCans.setColorAt(i, col);
  });
  if (treeCans.instanceColor) treeCans.instanceColor.needsUpdate = true;
  scene.add(treeTrunks, treeCans);

  /* crashed plane */
  if (WORLD.plane) {
    const p = WORLD.plane, y = WG.height(p.x, p.z);
    const parts = [];
    const fus = new THREE.CylinderGeometry(1.4, 1.7, 14, 10); fus.rotateZ(Math.PI / 2); fus.rotateY(0.12);
    parts.push(fus);
    const tail = new THREE.BoxGeometry(0.3, 3.4, 2.6); tail.translate(-6.6, 1.6, 0); tail.rotateY(0.12); parts.push(tail);
    const wingL = new THREE.BoxGeometry(3.4, 0.15, 9); wingL.translate(0.5, -0.4, 5.4); wingL.rotateY(-0.2); parts.push(wingL);
    const wingR = new THREE.BoxGeometry(3.0, 0.15, 6); wingR.translate(1.2, -0.8, -4); wingR.rotateY(0.6); wingR.rotateZ(0.3); parts.push(wingR);
    for (let i = 0; i < 7; i++) { const d = new THREE.BoxGeometry(0.6 + rnd01(i) * 1.4, 0.4, 0.6 + rnd01(i + 9) * 1.4); d.translate((rnd01(i + 3) - 0.5) * 22, -1.1, (rnd01(i + 5) - 0.5) * 18); parts.push(d); }
    planeMesh = new THREE.Mesh(mergeGeoms(parts), new THREE.MeshLambertMaterial({ map: TEX.metal }));
    planeMesh.position.set(p.x, y + 1.5, p.z);
    planeMesh.rotation.y = p.rot;
    planeMesh.rotation.z = 0.1;
    planeMesh.castShadow = true;
    scene.add(planeMesh);
  }

  const gp = WORLD.plaza, gy = WG.height(gp.x, gp.z);
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.9, 7, 8), new THREE.MeshLambertMaterial({ color: 0x3a4048 }));
  tower.position.set(gp.x, gy + 3.5, gp.z); tower.castShadow = true; scene.add(tower);
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.45, 10, 10), new THREE.MeshBasicMaterial({ color: 0x7e2a2f }));
  lamp.position.set(gp.x, gy + 7.3, gp.z); lamp.name = 'lamp'; scene.add(lamp);
  genLight = new THREE.PointLight(0xffb84d, 0, 30, 1.5);
  genLight.position.set(gp.x, gy + 7.3, gp.z); scene.add(genLight);

  WORLD.fuses.forEach(f => {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.16, 0.16), new THREE.MeshBasicMaterial({ color: 0xffbf5e }));
    const glow = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 8), new THREE.MeshBasicMaterial({ color: 0xe8a33d, transparent: true, opacity: 0.22 }));
    body.position.y = 0.25; glow.position.y = 0.25;
    g.add(body, glow);
    g.position.set(f.x, WG.height(f.x, f.z), f.z);
    scene.add(g);
    fuseMeshes.set(f.id, g);
  });

  for (let i = 0; i < 14; i++) {
    const m = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 40), new THREE.MeshBasicMaterial({ color: 0xd8d4c8, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
    m.rotation.x = -Math.PI / 2; m.visible = false;
    scene.add(m); ringPool.push(m);
  }
  for (let i = 0; i < 8; i++) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 6), new THREE.MeshLambertMaterial({ color: 0x8f8a80 }));
    m.visible = false; scene.add(m); pebbleMeshes.push(m);
  }
  buildCreature3D();
  buildSky();
}
function rnd01(n) { const x = Math.sin(n * 127.1) * 43758.5453; return x - Math.floor(x); }
function buildSky() {
  const sg = new THREE.BufferGeometry();
  const pos = new Float32Array(900 * 3);
  for (let i = 0; i < 900; i++) {
    const a = Math.random() * 6.28, e = Math.random() * 1.4 + 0.15, r = 380;
    pos[i * 3] = Math.cos(a) * Math.cos(e) * r;
    pos[i * 3 + 1] = Math.sin(e) * r;
    pos[i * 3 + 2] = Math.sin(a) * Math.cos(e) * r;
  }
  sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xcdd6e4, size: 0.9, transparent: true, opacity: 0.9, fog: false }));
  scene.add(stars);
  const mc = cnv(64), mg = mc.getContext('2d');
  const mgr = mg.createRadialGradient(32, 32, 4, 32, 32, 30);
  mgr.addColorStop(0, 'rgba(230,235,245,1)'); mgr.addColorStop(0.4, 'rgba(200,210,230,.5)'); mgr.addColorStop(1, 'rgba(200,210,230,0)');
  mg.fillStyle = mgr; mg.fillRect(0, 0, 64, 64);
  moonSpr = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(mc), transparent: true, fog: false }));
  moonSpr.scale.set(46, 46, 1);
  moonSpr.position.set(180, 220, -260);
  scene.add(moonSpr);
}
function buildCreature3D() {
  const g = new THREE.Group();
  const dark = new THREE.MeshLambertMaterial({ color: 0x0b0b0e });
  const pale = new THREE.MeshLambertMaterial({ color: 0xcfc8b6 });
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.9, 0.3), dark); torso.position.y = 1.55; torso.rotation.x = 0.35;
  const pelvis = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.3, 0.25), dark); pelvis.position.y = 1.05;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 10), pale);
  head.scale.set(0.8, 1.0, 1.5); head.position.set(0, 2.15, 0.25);
  const limbs = {};
  [['la', 1], ['ra', -1], ['ll', 1], ['rl', -1]].forEach(([k, s]) => {
    const arm = k[0] === 'a';
    const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, arm ? 1.0 : 1.1, 5), dark);
    const lower = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.06, arm ? 0.95 : 1.0, 5), dark);
    const pivot = new THREE.Group();
    upper.position.y = -(arm ? 0.5 : 0.55);
    const p2 = new THREE.Group(); p2.position.y = -(arm ? 1.0 : 1.1);
    lower.position.y = -(arm ? 0.45 : 0.5);
    p2.add(lower); pivot.add(upper, p2);
    pivot.position.set(s * (arm ? 0.33 : 0.16), arm ? 1.95 : 1.0, 0);
    g.add(pivot);
    limbs[k] = { pivot, p2, arm };
  });
  const blob = new THREE.Mesh(new THREE.CircleGeometry(0.7, 16), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.4 }));
  blob.rotation.x = -Math.PI / 2; blob.position.y = 0.03;
  g.add(torso, pelvis, head, blob);
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  scene.add(g);
  creature = { g, limbs, head, torso };
}
function makePlayerObj(id) {
  const r = roster.get(id) || { color: '#999', name: '' };
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.95, 0.3), new THREE.MeshLambertMaterial({ color: new THREE.Color(r.color) }));
  body.position.y = 1.15;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 8, 8), new THREE.MeshLambertMaterial({ color: 0xd8c9a8 }));
  head.position.y = 1.8;
  const blob = new THREE.Mesh(new THREE.CircleGeometry(0.4, 12), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.4 }));
  blob.rotation.x = -Math.PI / 2; blob.position.y = 0.03;
  const beam = new THREE.Mesh(new THREE.ConeGeometry(0.7, 5, 12, 1, true), new THREE.MeshBasicMaterial({ color: 0xffe9b0, transparent: true, opacity: 0.09, depthWrite: false }));
  beam.rotation.x = -Math.PI / 2; beam.position.set(0, 1.4, -2.6); beam.visible = false;
  const cnv2 = cnv(256, 64), cg = cnv2.getContext('2d');
  cg.font = '28px monospace'; cg.fillStyle = 'rgba(216,212,200,0.9)'; cg.textAlign = 'center';
  cg.fillText(id === NET.id ? r.name + ' · YOU' : r.name, 128, 40);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cnv2), depthWrite: false }));
  spr.scale.set(2.4, 0.6, 1); spr.position.y = 2.25;
  g.add(body, head, blob, beam, spr);
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  scene.add(g);
  playerObjs.set(id, { g, beam });
}
function disposePlayer(id) { const o = playerObjs.get(id); if (o) { scene.remove(o.g); playerObjs.delete(id); } }
function initWorld(world) {
  if (scene) {
    scene.clear();
    grassChunks.forEach(m => m.geometry.dispose());
    grassChunks.clear();
    playerObjs.clear(); fuseMeshes.clear(); ringPool.length = 0; pebbleMeshes.length = 0;
  }
  WORLD = world; doorsOpen = world.doors.map(() => 0); solidsKey = '';
  rebuildSolids();
  snaps = []; rings.length = 0; pebbles.length = 0;
  local.init = false; genTotal = world.fuses.length;
  buildWorld3D();
  buildViewModel();
  roster.forEach((r, id) => makePlayerObj(id));
}

/* grass with wind sway shader */
function grassMaterial() {
  const m = new THREE.MeshLambertMaterial({ map: TEX.grass, alphaTest: 0.45, side: THREE.DoubleSide });
  m.onBeforeCompile = sh => {
    sh.uniforms.uT = { value: 0 };
    grassTimeUniforms.push(sh.uniforms.uT);
    sh.vertexShader = 'uniform float uT;\n' + sh.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       float wsw = sin(uT*1.7 + (instanceMatrix[3][0] + instanceMatrix[3][2])*0.35);
       transformed.x += wsw * 0.09 * (position.y/0.7);
       transformed.z += cos(uT*1.3 + instanceMatrix[3][0]*0.22) * 0.06 * (position.y/0.7);`
    );
  };
  return m;
}
const grassTimeUniforms = [];
function ensureGrass() {
  const CS = 60;
  const cx = Math.floor(local.x / CS), cz = Math.floor(local.z / CS);
  const want = new Set();
  for (let x = cx - GRASS_R; x <= cx + GRASS_R; x++) for (let z = cz - GRASS_R; z <= cz + GRASS_R; z++) want.add(x + ',' + z);
  for (const [key, mesh] of grassChunks) if (!want.has(key)) { scene.remove(mesh); mesh.geometry.dispose(); grassChunks.delete(key); }
  const blade = (() => {
    const p1 = new THREE.PlaneGeometry(0.5, 0.7); p1.translate(0, 0.35, 0);
    const p2 = p1.clone(); p2.rotateY(Math.PI / 2);
    return mergeGeoms([p1, p2]);
  })();
  for (const key of want) if (!grassChunks.has(key)) {
    const [x, z] = key.split(',').map(Number);
    if (x < 0 || z < 0 || x >= WG.SIZE / CS || z >= WG.SIZE / CS) continue;
    const rnd = WG.mulberry32((x * 73856093) ^ (z * 19349663) ^ WORLD.seed);
    const count = 300;
    const im = new THREE.InstancedMesh(blade, grassMaterial(), count);
    im.frustumCulled = false;
    im.receiveShadow = qLevel === 2;
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler(), P = new THREE.Vector3(), SC = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      const wx = x * CS + rnd() * CS, wz = z * CS + rnd() * CS;
      E.set(0, rnd() * 6.28, (rnd() - 0.5) * 0.2); Q.setFromEuler(E);
      P.set(wx, WG.height(wx, wz), wz);
      const s = 0.7 + rnd() * 1.0; SC.set(s, s * (0.8 + rnd() * 0.7), s);
      M.compose(P, Q, SC); im.setMatrixAt(i, M);
    }
    scene.add(im);
    grassChunks.set(key, im);
  }
}

/* three init */
function threeInit() {
  renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x000000, 0.024);   // black night fog the flashlight cuts
  camera = new THREE.PerspectiveCamera(72, 1, 0.08, 460);
  camera.rotation.order = 'YXZ';
  scene.add(camera);
  hemi = new THREE.HemisphereLight(0x24304a, 0x101508, 0.12);
  scene.add(hemi);
  sun = new THREE.DirectionalLight(0x8899bb, 0.06);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  const sc = sun.shadow.camera;
  sc.left = -45; sc.right = 45; sc.top = 45; sc.bottom = -45; sc.near = 1; sc.far = 220;
  sc.updateProjectionMatrix();
  sun.shadow.bias = -0.0006;
  scene.add(sun); scene.add(sun.target);
  spot = new THREE.SpotLight(0xfff2d0, 0, 38, 0.46, 0.55, 1.1);
  spot.castShadow = true;
  spot.shadow.mapSize.set(512, 512);
  spot.shadow.bias = -0.001;
  camera.add(spot); spot.position.set(0.18, -0.22, 0.05);
  spotTarget = new THREE.Object3D(); spotTarget.position.set(0, -0.12, -1);
  camera.add(spotTarget); spot.target = spotTarget;
  // volumetric beam + dust
  beamCone = new THREE.Mesh(new THREE.ConeGeometry(3.1, 13, 20, 1, true), new THREE.MeshBasicMaterial({ color: 0xffe9b0, transparent: true, opacity: 0.05, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
  beamCone.rotation.x = -Math.PI / 2; beamCone.position.set(0.18, -0.2, -6.6);
  camera.add(beamCone);
  const dg = new THREE.BufferGeometry();
  const dp = new Float32Array(36 * 3);
  for (let i = 0; i < 36; i++) { dp[i * 3] = (Math.random() - 0.5) * 2.4; dp[i * 3 + 1] = (Math.random() - 0.5) * 2.4; dp[i * 3 + 2] = -Math.random() * 12; }
  dg.setAttribute('position', new THREE.BufferAttribute(dp, 3));
  dustPts = new THREE.Points(dg, new THREE.PointsMaterial({ color: 0xffe9b0, size: 0.035, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending }));
  camera.add(dustPts);
  buildTextures();
  resize();
}
function buildViewModel() {
  if (vm) camera.remove(vm);
  vm = new THREE.Group();
  const bodyM = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.22, 10), new THREE.MeshLambertMaterial({ color: 0x1a1a1f }));
  bodyM.rotation.x = Math.PI / 2;
  vmLens = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.02, 10), new THREE.MeshBasicMaterial({ color: 0x222218 }));
  vmLens.rotation.x = Math.PI / 2; vmLens.position.z = -0.12;
  vm.add(bodyM, vmLens);
  vm.position.set(0.24, -0.22, -0.4);
  camera.add(vm);
}
function resize() {
  W = innerWidth; H = innerHeight;
  renderer.setSize(W, H);
  camera.aspect = W / H; camera.updateProjectionMatrix();
}
addEventListener('resize', resize);

/* controls */
addEventListener('keydown', e => {
  if (e.code === 'Tab') e.preventDefault();
  keys[e.code] = true;
  if (e.code === 'KeyF' && locked && view && view.me && view.me.s < 2) flashOn = !flashOn;
  sendInput();
});
addEventListener('keyup', e => { keys[e.code] = false; sendInput(); });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; sendInput(); });
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === cv;
  $('lock').classList.toggle('hidden', locked || !NET.wasInGame);
});
$('lock').addEventListener('click', () => cv.requestPointerLock());
cv.addEventListener('click', () => { if (NET.wasInGame && !locked) cv.requestPointerLock(); });
let lastLookSend = 0;
addEventListener('mousemove', e => {
  if (!locked) return;
  tYaw -= e.movementX * 0.0021;
  tPitch = clamp(tPitch - e.movementY * 0.0021, -1.45, 1.45);
  const now = performance.now();
  if (now - lastLookSend > 60) { lastLookSend = now; sendInput(); }
});
addEventListener('mousedown', e => {
  if (!locked || !NET.open || phase !== 'play' || !view || !view.me || view.me.s >= 2 || e.button !== 0) return;
  const dx = -Math.sin(yaw) * Math.cos(pitch), dz = -Math.cos(yaw) * Math.cos(pitch);
  NET.send({ t: 'throw', dx, dz });
});
function moveVec() {
  const f = (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0);
  const s = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0);
  if (!f && !s) return { mx: 0, mz: 0 };
  const sy = Math.sin(yaw), cy = Math.cos(yaw);
  const mx = (-sy) * f + cy * s, mz = (-cy) * f + (-sy) * s;
  const l = Math.hypot(mx, mz) || 1;
  return { mx: mx / l, mz: mz / l };
}
function inputState() {
  const mv = moveVec();
  return Object.assign(mv, {
    run: !!(keys.ShiftLeft || keys.ShiftRight) && stamina > 0 && !stamBroken,
    sneak: !!keys.KeyC, e: !!keys.KeyE, f: flashOn
  });
}
function sendInput() { NET.send(Object.assign({ t: 'input' }, inputState())); }
setInterval(sendInput, 100);

function predict(dt) {
  if (!view || !view.me || view.me.s >= 2) return;
  if (!local.init) { local.x = view.me.x; local.z = view.me.z; local.y = WG.height(local.x, local.z) + 1.62; local.init = true; }
  const inp = inputState();
  let vx = inp.mx, vz = inp.mz;
  const len = Math.hypot(vx, vz);
  const moving = len > 0.01;
  if (inp.run && moving) { stamina = clamp(stamina - dt * 11, 0, 100); if (stamina <= 0) stamBroken = true; }
  else { stamina = clamp(stamina + dt * 8, 0, 100); if (stamina > 25) stamBroken = false; }
  lastRunning = inp.run && moving && !stamBroken;
  if (!moving) return;
  if (len > 1) { vx /= len; vz /= len; }
  const gait = inp.sneak ? 'sneak' : lastRunning ? 'run' : 'walk';
  let spd = gait === 'run' ? 5.2 : gait === 'walk' ? 2.2 : 1.1;
  if (view.me.s === 2) spd = 0.5;
  if (view.me.s === 1) spd *= 0.8;
  if (view.me.f && gait === 'run') spd = 4.4;
  const res = WG.resolveCircle(local.x + vx * spd * dt, local.z + vz * spd * dt, WG.PR, clientSolids(), WORLD.trees, WG.SIZE);
  local.x = res.x; local.z = res.z;
  local.bob += spd * dt * (gait === 'run' ? 1.35 : 1);
  local.stepAcc += spd * dt;
  const stride = gait === 'run' ? 2.3 : gait === 'walk' ? 1.7 : 1.2;
  if (local.stepAcc >= stride) {
    local.stepAcc = 0;
    if (view.me.s < 2) {
      const hard = Math.abs(local.x - WG.roadX(local.z)) < 4.5 || Math.abs(local.z - WG.roadZ(local.x)) < 4.5;
      if (gait === 'sneak') sfx.cstep(0.12, local.x, local.z);
      else sfx.step(gait === 'run' ? 0.5 : 0.26, local.x, local.z, hard);
    }
  }
}

function buildView() {
  if (!snaps.length) return null;
  const at = performance.now() - INTERP;
  let a = snaps[0], b = null;
  for (let i = snaps.length - 1; i >= 0; i--) if (snaps[i].t <= at) { a = snaps[i]; b = snaps[i + 1] || null; break; }
  const f = b ? clamp((at - a.t) / (b.t - a.t || 1), 0, 1) : 0;
  const ps = a.d.p.map(pa => {
    const pb = b && b.d.p.find(q => q.id === pa.id);
    return Object.assign({}, pa, { x: pb ? lerp(pa.x, pb.x, f) : pa.x, z: pb ? lerp(pa.z, pb.z, f) : pa.z },
      pb ? { s: pb.s, f: pb.f, r: pb.r, rv: pb.rv, g: pb.g, d: pb.d, l: pb.l } : {});
  });
  const c0 = a.d.c, c1 = b ? b.d.c : c0;
  const c = Object.assign({}, c0, { x: lerp(c0.x, c1.x, f), z: lerp(c0.z, c1.z, f), s: c1.s, tg: c1.tg, d: c1.d, m: c1.m });
  return { p: ps, c, me: ps.find(q => q.id === NET.id) || null };
}

function audVol(x, z, range) { const d = Math.hypot(x - local.x, z - local.z); return d > range ? 0 : 1 - d / range; }
function name(id) { return id === NET.id ? myName : (roster.get(id) || { name: '???' }).name; }
function spawnRing(x, z, i, voice) {
  const m = ringPool.find(m => !m.visible);
  if (!m) return;
  m.visible = true;
  m.position.set(x, WG.height(x, z) + 0.1, z);
  m.material.color.set(voice ? 0xe8a33d : 0xd8d4c8);
  m.userData = { t: performance.now(), max: 4 + i * 9 };
  rings.push(m);
}
function handleEvents(evs) {
  for (const e of evs) {
    const v = audVol(e.x, e.z, 120);
    switch (e.k) {
      case 'noise':
        if (e.i >= 0.2) spawnRing(e.x, e.z, e.i, e.a === 'voice');
        if (e.a === 'land' && v > 0) sfx.thud(v, e.x, e.z);
        break;
      case 'step': if (e.id !== NET.id && v > 0) sfx.step(v * 0.5, e.x, e.z, false); break;
      case 'door': if (v > 0) sfx.door(v, e.x, e.z); break;
      case 'breach': if (v > 0) sfx.breach(v, e.x, e.z); shake = Math.max(shake, 0.5 * v); log('IT BROKE A DOOR DOWN', 'bad'); break;
      case 'shriek': sfx.shriek(0.3 + v * 0.7, e.x, e.z); shake = Math.max(shake, 0.6); break;
      case 'roar': sfx.roar(0.25 + v * 0.75, e.x, e.z); if (v > 0.4) shake = Math.max(shake, 0.3); break;
      case 'hit':
        if (v > 0) sfx.scream(v, e.x, e.z);
        if (e.id === NET.id) { jumpscare(750); redPulse = 1; log('IT GOT YOU — ONE MORE HIT AND YOU DROP', 'bad'); }
        else log(name(e.id) + ' WAS HIT', 'bad');
        break;
      case 'down':
        if (v > 0) sfx.scream(v, e.x, e.z);
        if (e.id === NET.id) { jumpscare(1200); redPulse = 1; log('YOU ARE DOWN — CRAWL. WAIT FOR HELP.', 'bad'); }
        else log(name(e.id) + ' IS DOWN', 'bad');
        break;
      case 'dead':
        sfx.boom(0.4, e.x, e.z); log(name(e.id) + " DIDN'T MAKE IT", 'bad');
        if (e.id === NET.id) { jumpscare(1600); wasDead = true; sfx.tinnitus(); document.exitPointerLock(); }
        break;
      case 'revive': sfx.revive(0.7, e.x, e.z); log(name(e.id) + ' IS BACK UP', 'good'); break;
      case 'heal': sfx.revive(0.6, e.x, e.z); log(name(e.id) + ' PATCHED UP', 'good'); break;
      case 'pickup': sfx.chime(0.6, e.x, e.z); log(name(e.id) + ' HAS A FUSE', 'good'); break;
      case 'install': sfx.install(0.8, e.x, e.z); log('FUSE INSTALLED — ' + genN + '/' + genTotal, 'good'); banner('FUSE ' + genN + ' OF ' + genTotal); break;
      case 'thrown': if (e.dx != null) pebbles.push({ x: e.x, z: e.z, dx: e.dx, dz: e.dz, t: 0 }); break;
      case 'dawn': banner('DAY — IT SLEEPS. MOVE.', false); log('DAWN. FUSES SINK UNTIL NIGHTFALL.', 'good'); break;
      case 'dusk': banner('NIGHT FALLS — FUSES SURFACE', true); log('NIGHT. IT HUNTS.', 'bad'); break;
      case 'win': sfx.win(0.8); break;
      case 'lose': sfx.lose(0.8); jumpscare(1600); document.exitPointerLock(); break;
    }
  }
}
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
function fmt(t) { const m = Math.floor(t / 60), s = Math.floor(t % 60); return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s; }
function updateHUD() {
  $('obj').innerHTML =
    '<span class="room">ROOM ' + ROOM + '</span> · SURVIVORS <b>' + view.p.filter(q => q.s < 3).length + '</b><br>' +
    'FUSES <b>' + genN + '/' + genTotal + '</b> · POWER THE TOWER' +
    (graceT > 0 ? '<br><span class="wake">IT WAKES IN ' + graceT + 's</span>' : '') +
    (view.me && view.me.s === 1 ? '<br><span class="wake">YOU ARE HURT — HOLD E TO BANDAGE</span>' : '');
  const ck = $('clock');
  ck.className = cyc; ck.textContent = (cyc === 'night' ? '☾ NIGHT ' : '☀ DAY ') + fmt(cycT);
  $('warn').classList.toggle('on', creatureDist < 25 || (view.c.s === 'hunt' && view.c.tg === NET.id));
  $('stamFill').style.width = stamina + '%';
  $('mic').classList.toggle('hot', MIC.lvl > MIC.thr);
  $('micFill').style.width = MIC.on ? clamp(MIC.lvl / (MIC.thr * 4) * 100, 0, 100) + '%' : '0%';
  $('fsInd').className = flashOn ? 'on' : '';
  $('fsInd').textContent = flashOn ? '[F] FLASHLIGHT · ON' : '[F] FLASHLIGHT';
  const me = view.me;
  document.querySelectorAll('#rocksHud i').forEach((d, i) => { d.className = me && i < me.r ? 'full' : ''; });
  let prompt = '';
  if (me && me.s < 2 && WORLD) {
    const last = snaps[snaps.length - 1];
    if (last) {
      for (const f of last.d.fu) if (f[1] !== 'h' && f[1] !== 'i' && Math.hypot(f[1] - local.x, f[2] - local.z) < 1.7) {
        prompt = cyc !== 'night' ? 'FUSES SURFACE AT NIGHT' : (me.f ? 'HANDS FULL — INSERT CURRENT FUSE' : 'E — TAKE THE FUSE');
        break;
      }
      if (!prompt && me.f && Math.hypot(WORLD.plaza.x - local.x, WORLD.plaza.z - local.z) < 4) prompt = 'E — INSERT FUSE';
      if (!prompt) for (let i = 0; i < WORLD.doors.length; i++) {
        const dr = WORLD.doors[i], cx = dr.x + dr.w / 2, cz = dr.z + dr.h / 2;
        if (Math.hypot(cx - local.x, cz - local.z) < 2.2) { prompt = (doorsOpen[i] ? 'E — CLOSE DOOR' : 'E — OPEN DOOR') + ' · CREAKS'; break; }
      }
      if (!prompt && me.s === 0) for (const q of view.p)
        if (q.id !== NET.id && q.s === 2 && Math.hypot(q.x - local.x, q.z - local.z) < 2) { prompt = 'HOLD E — REVIVE ' + name(q.id); break; }
      if (!prompt && me.s === 0) for (const q of view.p)
        if (q.id !== NET.id && q.s === 1 && Math.hypot(q.x - local.x, q.z - local.z) < 2) { prompt = 'HOLD E — PATCH ' + name(q.id); break; }
    }
  }
  $('prompt').textContent = prompt;
  const end = $('end');
  if (phase === 'won' || phase === 'lost') {
    end.classList.remove('hidden');
    $('endTitle').textContent = phase === 'won' ? 'THE TOWER SINGS — RESCUED' : 'IT TOOK YOU ALL';
    $('endTitle').className = phase === 'won' ? 'amber' : 'red';
    $('endSub').textContent = 'room ' + ROOM + ' · ' + (phase === 'won' ? 'you escaped the quiet' : 'the quiet keeps you');
  } else end.classList.add('hidden');
}
function drawMinimap() {
  if (!WORLD) return;
  const mc = $('mini').getContext('2d'), s = 150 / WG.SIZE;
  mc.clearRect(0, 0, 150, 150);
  mc.fillStyle = 'rgba(10,12,18,0.78)'; mc.fillRect(0, 0, 150, 150);
  mc.fillStyle = 'rgba(20,32,18,0.8)';
  for (let x = 0; x < WG.SIZE; x += 28) for (let z = 0; z < WG.SIZE; z += 28)
    if (WG.forestN(x, z, WORLD.fOff) > 0.55) mc.fillRect(x * s, z * s, 28 * s + 1, 28 * s + 1);
  mc.strokeStyle = 'rgba(120,124,120,0.5)'; mc.lineWidth = 1.4;
  mc.beginPath();
  for (let z = 0; z <= WG.SIZE; z += 20) { const x = WG.roadX(z); z === 0 ? mc.moveTo(x * s, z * s) : mc.lineTo(x * s, z * s); }
  mc.stroke();
  mc.beginPath();
  for (let x = 0; x <= WG.SIZE; x += 20) { const z = WG.roadZ(x); x === 0 ? mc.moveTo(x * s, z * s) : mc.lineTo(x * s, z * s); }
  mc.stroke();
  mc.fillStyle = '#3a3f4a';
  for (const b of WORLD.buildings) mc.fillRect(b.x * s, b.z * s, Math.max(1.5, b.w * s), Math.max(1.5, b.h * s));
  if (WORLD.plane) { mc.fillStyle = '#767d80'; mc.fillRect(WORLD.plane.x * s - 2, WORLD.plane.z * s - 1, 5, 2.5); }
  mc.strokeStyle = 'rgba(232,163,61,0.6)';
  mc.beginPath(); mc.arc(WORLD.plaza.x * s, WORLD.plaza.z * s, 4, 0, 7); mc.stroke();
  if (cyc === 'night') {
    const last = snaps[snaps.length - 1];
    if (last) for (const f of last.d.fu) if (f[1] !== 'h' && f[1] !== 'i') {
      mc.fillStyle = '#e8a33d'; mc.fillRect(f[1] * s - 1, f[2] * s - 1, 2.5, 2.5);
    }
  }
  for (const p of view.p) {
    if (p.s === 3) continue;
    mc.fillStyle = p.s === 2 ? '#c22b33' : p.s === 1 ? '#e8a33d' : (p.id === NET.id ? '#fff' : (roster.get(p.id) || { color: '#aaa' }).color);
    const px = (p.id === NET.id ? local.x : p.x) * s, pz = (p.id === NET.id ? local.z : p.z) * s;
    mc.beginPath(); mc.arc(px, pz, p.id === NET.id ? 3 : 2.2, 0, 7); mc.fill();
  }
}

function applyCycle(t) {
  const target = cyc === 'day' ? 1 : 0;
  dayF += (target - dayF) * 0.015;
  const df = dayF;
  scene.background = new THREE.Color().lerpColors(new THREE.Color(0x000000), new THREE.Color(0x9fc3e8), df);
  scene.fog.color.copy(scene.background).multiplyScalar(0.35);
  scene.fog.density = lerp(0.024, 0.0035, df);
  hemi.intensity = lerp(0.09, 0.85, df);
  sun.intensity = lerp(0.05, 1.0, df);
  sun.color.lerpColors(new THREE.Color(0x7788aa), new THREE.Color(0xfff2d0), df);
  sun.position.set(local.x + 40, 70, local.z + 25);
  sun.target.position.set(local.x, 0, local.z);
  if (stars) { stars.material.opacity = (1 - df) * 0.9; stars.visible = df < 0.6; }
  if (moonSpr) moonSpr.material.opacity = 1 - df;
  const flick = creatureDist < 12 ? (Math.random() < 0.14 ? 0.35 : 1) : 1;
  const on = flashOn && view && view.me && view.me.s < 2;
  spot.intensity = on ? 2.6 * flick * (1 - df * 0.85) : 0;
  beamCone.visible = on && df < 0.5;
  beamCone.material.opacity = 0.05 * (1 - df) * flick;
  dustPts.visible = on && df < 0.5;
  if (vmLens) vmLens.material.color.set(flashOn ? 0xfff2c0 : 0x222218);
  const lamp = scene.getObjectByName('lamp');
  if (lamp) {
    const active = genN >= genTotal;
    lamp.material.color.set(active ? 0xffd98a : (Math.sin(t * 2.4) > 0.5 ? 0x7e2a2f : 0x3a1518));
    genLight.intensity = active ? 2.2 : 0;
  }
}
function updateCreature3D(dt, t) {
  const c = view.c;
  creature.g.position.set(c.x, WG.height(c.x, c.z), c.z);
  creature.g.rotation.y = c.d;
  const hunt = c.s === 'hunt';
  const spd = hunt ? 5.5 : c.s === 'roam' ? 1.2 : 2.6;
  if (c.m) cPhase += dt * spd * 2.4;
  const sw = Math.sin(cPhase), sw2 = Math.sin(cPhase + Math.PI);
  const L = creature.limbs;
  L.ll.pivot.rotation.x = sw * 0.7; L.ll.p2.rotation.x = Math.max(0, -sw) * 0.9;
  L.rl.pivot.rotation.x = sw2 * 0.7; L.rl.p2.rotation.x = Math.max(0, -sw2) * 0.9;
  const armR = hunt ? -2.4 : -0.5;
  L.la.pivot.rotation.x = hunt ? armR + sw * 0.3 : sw2 * 0.5;
  L.ra.pivot.rotation.x = hunt ? armR + sw2 * 0.3 : sw * 0.5;
  L.la.p2.rotation.x = hunt ? -0.5 : 0.2;
  L.ra.p2.rotation.x = hunt ? -0.5 : 0.2;
  creature.torso.rotation.x = 0.35 + (hunt ? 0.25 : 0);
  creature.head.rotation.y = hunt ? (Math.random() - 0.5) * 0.5 : Math.sin(t * 0.7) * 0.3;
}
function animateDoors(dt) {
  doorMeshes.forEach((m, i) => {
    const horiz = WORLD.doors[i].w > WORLD.doors[i].h;
    const base = horiz ? 0 : Math.PI / 2;
    const ajar = rnd01(WORLD.doors[i].x) < 0.3 ? 0.5 : 0;
    const target = base + (doorsOpen[i] ? 1.9 : ajar);
    m.rotation.y += (target - m.rotation.y) * Math.min(1, dt * 5);
  });
}
function updatePlayers3D() {
  for (const p of view.p) {
    if (p.id === NET.id) continue;
    let o = playerObjs.get(p.id);
    if (!o) { makePlayerObj(p.id); o = playerObjs.get(p.id); }
    if (p.s === 3) { o.g.visible = false; continue; }
    o.g.visible = true;
    o.g.position.set(p.x, WG.height(p.x, p.z), p.z);
    o.g.rotation.y = p.d;
    if (p.s === 2) { o.g.rotation.z = Math.PI / 2; o.g.position.y += 0.5; }
    else if (p.s === 1) o.g.rotation.z = 0.18;
    else o.g.rotation.z = 0;
    o.beam.visible = cyc !== 'day' && p.s === 0 && !!p.l;
  }
  const last = snaps[snaps.length - 1];
  if (last) for (const f of last.d.fu) {
    const m = fuseMeshes.get(f[0]); if (!m) continue;
    m.visible = f[1] !== 'h' && f[1] !== 'i' && cyc === 'night';
  }
}

let lastT = performance.now(), clickT = 0, ambientT = 5;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - lastT) / 1000); lastT = now;
  const t = now / 1000;
  /* auto quality */
  qAcc += dt; qN++; qT += dt;
  if (qT > 3) {
    const avg = qAcc / qN;
    if (avg > 0.026 && qLevel > 0) { qLevel--; applyQuality(); }
    else if (avg < 0.014 && qLevel < 2) { qLevel++; applyQuality(); }
    qAcc = qN = 0; qT = 0;
  }
  micTick(dt); micSend(); vcFrame();
  grassTimeUniforms.forEach(u => { u.value = t; });
  if (!WORLD || !snaps.length || !renderer) return;

  view = buildView(); if (!view) return;
  const k = 1 - Math.exp(-dt * 28);
  yaw += (tYaw - yaw) * k;
  pitch += (tPitch - pitch) * k;
  predict(dt);

  const me = view.me;
  creatureDist = me ? Math.hypot(view.c.x - local.x, view.c.z - local.z) : 1e9;

  const eye = keys.KeyC ? 1.05 : 1.62;
  local.y += ((WG.height(local.x, local.z) + eye) - local.y) * Math.min(1, dt * 10);
  const bobY = Math.sin(local.bob * 1.9) * 0.035;
  if (me && me.s < 3) {
    camera.position.set(local.x, local.y + bobY, local.z);
    camera.rotation.set(pitch, yaw, 0);
  } else {
    const cy = WG.height(view.c.x, view.c.z) + 3;
    camera.position.lerp(new THREE.Vector3(view.c.x, cy, view.c.z), Math.min(1, dt * 3));
    camera.lookAt(view.c.x, cy - 1.5, view.c.z);
  }
  const targetFov = lastRunning ? 78 : 72;
  if (Math.abs(camera.fov - targetFov) > 0.1) { camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 6); camera.updateProjectionMatrix(); }
  if (vm) {
    vm.position.x = 0.24 + Math.sin(local.bob * 1.9) * 0.01;
    vm.position.y = -0.22 + Math.abs(Math.cos(local.bob * 1.9)) * 0.012;
  }
  if (dustPts.visible) {
    const dp = dustPts.geometry.attributes.position;
    for (let i = 0; i < dp.count; i++) {
      let z = dp.getZ(i) + dt * 0.6;
      if (z > 0) z = -12;
      dp.setZ(i, z);
      dp.setX(i, dp.getX(i) + Math.sin(t * 2 + i) * dt * 0.08);
    }
    dp.needsUpdate = true;
  }
  shake = Math.max(0, shake - dt * 1.6);
  if (shake > 0) { camera.position.x += (Math.random() - 0.5) * shake * 0.1; camera.position.y += (Math.random() - 0.5) * shake * 0.1; }
  redPulse = Math.max(0, redPulse - dt * 0.7);

  ensureGrass();
  applyCycle(t);
  updateCreature3D(dt, t);
  updatePlayers3D();
  animateDoors(dt);

  for (let i = rings.length - 1; i >= 0; i--) {
    const m = rings[i], age = (now - m.userData.t) / 1000, r = age * 10;
    if (r > m.userData.max) { m.visible = false; rings.splice(i, 1); continue; }
    m.scale.set(r, r, r);
    m.material.opacity = (1 - r / m.userData.max) * 0.5;
  }
  pebbles.forEach(pb => { pb.t += dt; });
  pebbleMeshes.forEach((m, i) => {
    const pb = pebbles[i];
    if (!pb || pb.t > 0.7) { m.visible = false; return; }
    m.visible = true;
    const d = pb.t * 13 * (1 - pb.t * 0.9);
    const x = pb.x + pb.dx * d, z = pb.z + pb.dz * d;
    m.position.set(x, WG.height(x, z) + 1.4 * Math.sin(Math.PI * pb.t / 0.7), z);
  });
  for (let i = pebbles.length - 1; i >= 0; i--) if (pebbles[i].t > 0.7) pebbles.splice(i, 1);

  if (ac) {
    if (growlGain) {
      const gv = view.c.s === 'hunt' && creatureDist < 40 && me && me.s < 2 ? clamp(1 - creatureDist / 40, 0, 1) * 0.16 : 0;
      growlGain.gain.setTargetAtTime(gv, ac.currentTime, 0.2);
    }
    if (me && me.s < 2) {
      if (creatureDist < 22) {
        const iv = lerp(0.34, 1.15, clamp(creatureDist / 22, 0, 1));
        if (t >= hbNext) { heartbeat(lerp(0.5, 0.14, creatureDist / 22)); hbNext = t + iv; }
      }
      const fear = clamp(1 - creatureDist / 18, 0, 1);
      if (fear > 0.15 && t >= breathNext) { breath(fear * 0.22); breathNext = t + lerp(3.0, 1.1, fear); }
    }
    if (view.c.m && creatureDist < 60 && t >= cStepNext) {
      cStepNext = t + (view.c.s === 'hunt' ? 0.38 : 0.72);
      sfx.cfoot(clamp(1 - creatureDist / 60, 0, 1) * 0.9, view.c.x, view.c.z);
      if (creatureDist < 12) shake = Math.max(shake, 0.2);
    }
    if ((view.c.s === 'search' || view.c.s === 'investigate') && creatureDist < 30 && t > clickT) {
      clickT = t + 0.7 + Math.random();
      sfx.click(clamp(1 - creatureDist / 30, 0, 1), view.c.x, view.c.z);
    }
    if (view.c.s === 'hunt' && !prevHunt && creatureDist < 40 && me && me.s < 2) shake = Math.max(shake, 0.4);
    prevHunt = view.c.s === 'hunt';
    ambientT -= dt;
    if (ambientT < 0) { ambientT = 8 + Math.random() * 14; noiseHit(ac.currentTime, 1.4, 500 + Math.random() * 600, 0.5, 0.03, local.x + 40, local.z + 40); }
  }

  const hurtBase = me && me.s === 1 ? 0.45 + Math.sin(t * 3) * 0.08 : 0;
  $('hurtVig').style.opacity = clamp(Math.max(redPulse, hurtBase) + (creatureDist < 6 && me && me.s < 2 ? (1 - creatureDist / 6) * 0.5 : 0), 0, 1);
  $('pulse').style.opacity = $('hurtVig').style.opacity;

  renderer.render(scene, camera);
  updateHUD();
  drawMinimap();
}

/* boot */
threeInit();
applyQuality();
joinRoom = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
$('room').value = joinRoom;
$('menuBtn').addEventListener('click', () => { location.href = location.pathname + '?room=' + ROOM; });
$('begin').addEventListener('click', async () => {
  myName = $('name').value.trim() || 'SURVIVOR';
  joinRoom = $('room').value.trim().toUpperCase() || joinRoom;
  audioInit();
  if (ac.state === 'suspended') await ac.resume();
  $('title').classList.add('hidden');
  $('miccheck').classList.remove('hidden');
  await micStart();
  connect();
});
$('skipMic').addEventListener('click', () => { MIC.calib = false; connect(); });
[$('name'), $('room')].forEach(el => el.addEventListener('keydown', e => {
  if (e.key === 'Enter') $('begin').click();
  e.stopPropagation();
}));
requestAnimationFrame(frame);
