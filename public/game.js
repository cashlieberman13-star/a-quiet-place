import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const W = globalThis.QPWorld;
const { clamp, lerp } = W;
const $ = s => document.querySelector(s);
const TAU = Math.PI * 2;

/* ==========================================================================
   MICROPHONE  — the real input device
   ========================================================================== */
class Mic {
  constructor() {
    this.ready = false; this.level = 0; this.db = -100;
    this.floor = -70; this.gain = 1; this.threshold = 28;
    this.held = false;
  }
  async enable() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = this.ctx.createMediaStreamSource(stream);
    const hp = this.ctx.createBiquadFilter();          // kill rumble/DC
    hp.type = 'highpass'; hp.frequency.value = 80;
    this.an = this.ctx.createAnalyser();
    this.an.fftSize = 1024; this.an.smoothingTimeConstant = 0.35;
    src.connect(hp); hp.connect(this.an);
    this.buf = new Float32Array(this.an.fftSize);
    this.ready = true;
    this.calibrate();
    return true;
  }
  /** Learn the room's noise floor over 1.2s of (hopefully) silence. */
  calibrate() {
    let n = 0, sum = 0;
    const t = setInterval(() => {
      this.sample();
      sum += this.db; n++;
      if (n >= 24) { clearInterval(t); this.floor = sum / n + 6; }
    }, 50);
  }
  sample() {
    if (!this.ready) return 0;
    this.an.getFloatTimeDomainData(this.buf);
    let s = 0;
    for (let i = 0; i < this.buf.length; i++) s += this.buf[i] * this.buf[i];
    const rms = Math.sqrt(s / this.buf.length) * this.gain;
    this.db = 20 * Math.log10(Math.max(rms, 1e-7));
    const span = -6 - this.floor;
    const raw = clamp((this.db - this.floor) / (span || 1), 0, 1);
    const target = this.held ? 0 : Math.pow(raw, 0.7) * 100;
    // fast attack, slow release — matches how a listener perceives a spike
    this.level = target > this.level ? target : this.level + (target - this.level) * 0.25;
    return this.level;
  }
  /** 0..1 noise emitted this instant, or 0 if under threshold. */
  emission() {
    if (this.level <= this.threshold) return 0;
    return Math.pow((this.level - this.threshold) / (100 - this.threshold), 0.85);
  }
}

/* ==========================================================================
   SFX  — everything synthesised, no audio files
   ========================================================================== */
class Sfx {
  init(ctx) {
    this.ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    this.master = this.ctx.createGain(); this.master.gain.value = 0.85;
    this.master.connect(this.ctx.destination);
    this.listener = this.ctx.listener;
    this.noise = this.makeNoise(3);
    this.wind();
    this.heartGain = this.ctx.createGain(); this.heartGain.gain.value = 0;
    this.heartGain.connect(this.master);
  }
  makeNoise(sec) {
    const n = this.ctx.sampleRate * sec, b = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = b.getChannelData(0);
    let last = 0;
    for (let i = 0; i < n; i++) { const wn = Math.random() * 2 - 1; last = (last + 0.02 * wn) / 1.02; d[i] = last * 3.2; }
    return b;
  }
  panner(x, y, z) {
    const p = this.ctx.createPanner();
    p.panningModel = 'equalpower'; p.distanceModel = 'exponential';
    p.refDistance = 4; p.rolloffFactor = 1.6; p.maxDistance = 400;
    p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z;
    p.connect(this.master); return p;
  }
  env(node, peak, a, d) {
    const t = this.ctx.currentTime, g = node.gain;
    g.setValueAtTime(0.0001, t);
    g.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
    g.exponentialRampToValueAtTime(0.0001, t + a + d);
  }
  burst(dest, { freq = 1200, q = 1, peak = 0.3, a = 0.005, d = 0.15, rate = 1, type = 'lowpass' }) {
    const s = this.ctx.createBufferSource(); s.buffer = this.noise;
    s.playbackRate.value = rate; s.loop = false;
    s.start(this.ctx.currentTime, Math.random() * 2, a + d + 0.05);
    const f = this.ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = this.ctx.createGain(); this.env(g, peak, a, d);
    s.connect(f); f.connect(g); g.connect(dest);
  }
  wind() {
    const s = this.ctx.createBufferSource(); s.buffer = this.noise; s.loop = true;
    const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 380;
    const g = this.ctx.createGain(); g.gain.value = 0.055;
    const lfo = this.ctx.createOscillator(); lfo.frequency.value = 0.07;
    const lg = this.ctx.createGain(); lg.gain.value = 0.035;
    lfo.connect(lg); lg.connect(g.gain);
    s.connect(f); f.connect(g); g.connect(this.master);
    s.start(); lfo.start();
  }
  step(x, y, z, ground, loud) {
    const p = this.panner(x, y, z);
    const map = { grass: 700, sand: 480, asphalt: 2400, rock: 2900, snow: 900, water: 1600 };
    this.burst(p, { freq: map[ground] || 900, peak: 0.10 + loud * 0.32, a: 0.004, d: 0.07 + loud * 0.06, rate: 0.8 + Math.random() * 0.4 });
  }
  glass(x, y, z) {
    const p = this.panner(x, y, z);
    for (let i = 0; i < 6; i++) setTimeout(() =>
      this.burst(p, { type: 'bandpass', freq: 2600 + Math.random() * 4200, q: 6, peak: 0.4, a: 0.002, d: 0.09 }), i * 34);
  }
  metal(x, y, z) {
    const p = this.panner(x, y, z);
    [520, 790, 1310].forEach((f, i) => {
      const o = this.ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = f;
      const g = this.ctx.createGain(); this.env(g, 0.12 / (i + 1), 0.003, 0.5);
      o.connect(g); g.connect(p); o.start(); o.stop(this.ctx.currentTime + 0.6);
    });
  }
  screech(x, y, z) {
    const t = this.ctx.currentTime, p = this.panner(x, y, z);
    p.rolloffFactor = 0.9; p.maxDistance = 900;
    const shaper = this.ctx.createWaveShaper();
    const c = new Float32Array(256);
    for (let i = 0; i < 256; i++) { const v = i / 128 - 1; c[i] = Math.tanh(v * 3.4); }
    shaper.curve = c; shaper.connect(p);

    const o = this.ctx.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(1150, t);
    o.frequency.exponentialRampToValueAtTime(190, t + 0.85);
    const og = this.ctx.createGain(); this.env(og, 0.5, 0.02, 0.9);
    o.connect(og); og.connect(shaper); o.start(t); o.stop(t + 1.1);

    const sub = this.ctx.createOscillator(); sub.type = 'sine'; sub.frequency.value = 58;
    const sg = this.ctx.createGain(); this.env(sg, 0.55, 0.05, 1.2);
    sub.connect(sg); sg.connect(p); sub.start(t); sub.stop(t + 1.4);

    const ns = this.ctx.createBufferSource(); ns.buffer = this.noise;
    const bf = this.ctx.createBiquadFilter(); bf.type = 'bandpass'; bf.Q.value = 3.5;
    bf.frequency.setValueAtTime(3200, t);
    bf.frequency.exponentialRampToValueAtTime(600, t + 0.9);
    const ng = this.ctx.createGain(); this.env(ng, 0.35, 0.02, 1.0);
    ns.connect(bf); bf.connect(ng); ng.connect(shaper);
    ns.start(t, 0, 1.2);
  }
  thud(x, y, z, big) {
    const p = this.panner(x, y, z);
    const o = this.ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(big ? 95 : 150, this.ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(38, this.ctx.currentTime + 0.18);
    const g = this.ctx.createGain(); this.env(g, big ? 0.5 : 0.22, 0.005, 0.22);
    o.connect(g); g.connect(p); o.start(); o.stop(this.ctx.currentTime + 0.3);
    this.burst(p, { freq: 400, peak: big ? 0.2 : 0.08, d: 0.12 });
  }
  feedback() {
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(2100, t);
    o.frequency.linearRampToValueAtTime(7400, t + 1.6);
    o.frequency.linearRampToValueAtTime(3000, t + 3.2);
    const g = this.ctx.createGain(); this.env(g, 0.28, 0.15, 3.2);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + 3.6);
  }
  blip(up) {
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(); o.type = 'square';
    o.frequency.setValueAtTime(up ? 660 : 330, t);
    o.frequency.setValueAtTime(up ? 990 : 220, t + 0.07);
    const g = this.ctx.createGain(); this.env(g, 0.06, 0.005, 0.12);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + 0.2);
  }
  heartbeat(intensity) {
    if (!this._nextBeat) this._nextBeat = 0;
    const t = performance.now();
    if (intensity < 0.05 || t < this._nextBeat) return;
    this._nextBeat = t + lerp(1100, 420, intensity);
    const bump = d => {
      const o = this.ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 52;
      const g = this.ctx.createGain(); this.env(g, 0.10 + intensity * 0.4, 0.01, 0.16);
      o.connect(g); g.connect(this.master);
      o.start(this.ctx.currentTime + d); o.stop(this.ctx.currentTime + d + 0.25);
    };
    bump(0); bump(0.19);
  }
  moveListener(cam) {
    const l = this.listener, p = cam.position;
    const f = new THREE.Vector3(); cam.getWorldDirection(f);
    if (l.positionX) {
      l.positionX.value = p.x; l.positionY.value = p.y; l.positionZ.value = p.z;
      l.forwardX.value = f.x; l.forwardY.value = f.y; l.forwardZ.value = f.z;
      l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
    } else { l.setPosition(p.x, p.y, p.z); l.setOrientation(f.x, f.y, f.z, 0, 1, 0); }
  }
}

/* ==========================================================================
   MATERIALS
   ========================================================================== */
const MAT = {
  wood:     new THREE.MeshStandardMaterial({ color: 0x3b3229, roughness: 0.92 }),
  woodDark: new THREE.MeshStandardMaterial({ color: 0x241e18, roughness: 0.95 }),
  plaster:  new THREE.MeshStandardMaterial({ color: 0x6b675e, roughness: 0.9 }),
  brick:    new THREE.MeshStandardMaterial({ color: 0x4a352d, roughness: 0.95 }),
  roof:     new THREE.MeshStandardMaterial({ color: 0x24262a, roughness: 0.85 }),
  metal:    new THREE.MeshStandardMaterial({ color: 0x555c60, roughness: 0.55, metalness: 0.75 }),
  rust:     new THREE.MeshStandardMaterial({ color: 0x6b3a24, roughness: 0.95, metalness: 0.25 }),
  fuselage: new THREE.MeshStandardMaterial({ color: 0x9aa2a6, roughness: 0.45, metalness: 0.65 }),
  glass:    new THREE.MeshStandardMaterial({ color: 0x1a2428, roughness: 0.1, metalness: 0.2,
              transparent: true, opacity: 0.35 }),
  concrete: new THREE.MeshStandardMaterial({ color: 0x5b5f61, roughness: 0.95 }),
  bark:     new THREE.MeshStandardMaterial({ color: 0x2b231c, roughness: 1 }),
  leaf:     new THREE.MeshStandardMaterial({ color: 0x1d2a1a, roughness: 1 }),
  corn:     new THREE.MeshStandardMaterial({ color: 0x6d6134, roughness: 1 }),
  stone:    new THREE.MeshStandardMaterial({ color: 0x4c4f52, roughness: 1 }),
  glow:     new THREE.MeshBasicMaterial({ color: 0xffd27a }),
  canMat:   new THREE.MeshStandardMaterial({ color: 0xb8342a, roughness: 0.6, metalness: 0.3,
              emissive: 0x3a0d08, emissiveIntensity: 0.6 }),
};

/* ==========================================================================
   BUILDER — batches geometry per material and collects colliders
   ========================================================================== */
class Builder {
  constructor() { this.buckets = new Map(); this.colliders = []; this.extras = new THREE.Group(); }
  push(key, geo, m) {
    geo = geo.clone(); geo.applyMatrix4(m);
    if (!this.buckets.has(key)) this.buckets.set(key, []);
    this.buckets.get(key).push(geo);
  }
  box(key, w, h, d, x, y, z, ry = 0, collide = false) {
    const m = new THREE.Matrix4().makeRotationY(ry).setPosition(x, y, z);
    this.push(key, new THREE.BoxGeometry(w, h, d), m);
    if (collide) this.colliders.push({ x, z, hw: w / 2, hd: d / 2, rot: ry, top: y + h / 2 });
  }
  cyl(key, rt, rb, h, seg, x, y, z, rx = 0, ry = 0, rz = 0, collide = false) {
    const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz)).setPosition(x, y, z);
    this.push(key, new THREE.CylinderGeometry(rt, rb, h, seg), m);
    if (collide) this.colliders.push({ x, z, hw: Math.max(rt, rb), hd: Math.max(rt, rb), rot: 0, top: y + h / 2 });
  }
  finish(scene) {
    for (const [key, list] of this.buckets) {
      if (!list.length) continue;
      const merged = mergeGeometries(list, false);
      if (!merged) continue;
      merged.computeVertexNormals();
      const mesh = new THREE.Mesh(merged, MAT[key]);
      mesh.castShadow = false; mesh.receiveShadow = false;
      mesh.frustumCulled = true;
      scene.add(mesh);
      list.forEach(g => g.dispose());
    }
    scene.add(this.extras);
    this.buckets.clear();
  }
}

/* ==========================================================================
   WORLD
   ========================================================================== */
class World {
  constructor(scene, seed) {
    this.scene = scene; this.seed = seed;
    this.colliders = [];
    this.noiseProps = [];   // bottles, branches — step here and it's loud
    this.h = (x, z) => W.heightAt(x, z, seed);
    this.rngI = 0;
  }
  rnd() { return W.hash(this.rngI++, 91, this.seed); }
  rr(a, b) { return a + this.rnd() * (b - a); }

  build() {
    this.terrain();
    this.water();
    this.roads();
    const b = new Builder();
    for (const p of W.POIS) {
      const f = { village: 'village', gas: 'gasStation', plane: 'planeWreck', farm: 'farm',
                  tower: 'radioTower', chapel: 'chapel', yard: 'railYard', quarry: 'quarry' }[p.type];
      if (f) this[f](b, p);
    }
    this.truck(b);
    b.finish(this.scene);
    this.colliders = b.colliders;
    this.vegetation();
    this.scatterNoiseProps();
  }

  // ---------------------------------------------------------------- terrain
  terrain() {
    const SEG = 320;
    const geo = new THREE.PlaneGeometry(W.SIZE, W.SIZE, SEG, SEG);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const col = new Float32Array(pos.count * 3);
    const C = {
      grass: [0.09, 0.12, 0.07], sand: [0.34, 0.30, 0.22], asphalt: [0.10, 0.10, 0.11],
      rock: [0.17, 0.17, 0.18], snow: [0.62, 0.65, 0.70], water: [0.05, 0.08, 0.09],
    };
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const h = this.h(x, z);
      pos.setY(i, h);
      const g = W.groundAt(x, z, this.seed, h);
      const v = C[g] || C.grass;
      const n = 0.82 + W.vnoise(x * 0.35, z * 0.35, this.seed) * 0.36;
      col[i * 3] = v[0] * n; col[i * 3 + 1] = v[1] * n; col[i * 3 + 2] = v[2] * n;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 1, metalness: 0,
    }));
    this.scene.add(mesh);
  }

  water() {
    const g = new THREE.PlaneGeometry(W.LAKE.r * 2.3, W.LAKE.r * 2.3, 1, 1);
    g.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
      color: 0x0a1417, roughness: 0.08, metalness: 0.85, transparent: true, opacity: 0.85,
    }));
    m.position.set(W.LAKE.x, W.WATER, W.LAKE.z);
    this.scene.add(m);
  }

  roads() {
    const verts = [], cols = [];
    const lay = (lines, width, color) => {
      for (const line of lines) {
        for (let i = 0; i < line.length - 1; i++) {
          const [ax, az] = line[i], [bx, bz] = line[i + 1];
          const steps = Math.max(2, Math.ceil(Math.hypot(bx - ax, bz - az) / 8));
          let prev = null;
          for (let s = 0; s <= steps; s++) {
            const t = s / steps;
            const x = lerp(ax, bx, t), z = lerp(az, bz, t);
            const dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz) || 1;
            const nx = -dz / l * width, nz = dx / l * width;
            const L = [x + nx, this.h(x + nx, z + nz) + 0.06, z + nz];
            const R = [x - nx, this.h(x - nx, z - nz) + 0.06, z - nz];
            if (prev) {
              verts.push(...prev[0], ...prev[1], ...L, ...prev[1], ...R, ...L);
              for (let k = 0; k < 6; k++) cols.push(...color);
            }
            prev = [L, R];
          }
        }
      }
    };
    lay(W.ROADS, 6.5, [0.055, 0.055, 0.06]);
    lay(W.PATHS, 4.0, [0.30, 0.26, 0.19]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    g.computeVertexNormals();
    this.scene.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -2,
    })));
  }

  // ------------------------------------------------------------- structures
  /** Walls with a doorway gap, so every building is enterable. */
  room(b, key, w, d, hgt, cx, cy, cz, rot, doorSide = 0, doorW = 1.6) {
    const t = 0.22;
    const sides = [
      { len: w, ox: 0, oz: -d / 2, r: 0 },
      { len: w, ox: 0, oz: d / 2, r: 0 },
      { len: d, ox: -w / 2, oz: 0, r: Math.PI / 2 },
      { len: d, ox: w / 2, oz: 0, r: Math.PI / 2 },
    ];
    sides.forEach((s, i) => {
      const c = Math.cos(rot), sn = Math.sin(rot);
      const wx = cx + s.ox * c - s.oz * sn, wz = cz + s.ox * sn + s.oz * c;
      const wr = rot + s.r;
      if (i === doorSide) {
        const seg = (s.len - doorW) / 2;
        [-1, 1].forEach(sg => {
          const ox = sg * (doorW / 2 + seg / 2);
          b.box(key, seg, hgt, t, wx + Math.cos(wr) * ox, cy + hgt / 2, wz + Math.sin(wr) * ox, wr, true);
        });
        b.box(key, doorW, hgt - 2.1, t, wx, cy + 2.1 + (hgt - 2.1) / 2, wz, wr, false);
      } else {
        b.box(key, s.len, hgt, t, wx, cy + hgt / 2, wz, wr, true);
      }
    });
    b.box('roof', w + 0.7, 0.28, d + 0.7, cx, cy + hgt + 0.14, cz, rot, false);
  }

  house(b, x, z, rot, scale = 1) {
    const y = this.h(x, z);
    const w = 8 * scale, d = 6.5 * scale, hgt = 3.1;
    b.box('concrete', w + 1, 0.5, d + 1, x, y - 0.1, z, rot);
    this.room(b, this.rnd() < 0.5 ? 'plaster' : 'wood', w, d, hgt, x, y + 0.15, z, rot, Math.floor(this.rnd() * 4) | 0);
    // gable
    for (let i = 0; i < 5; i++) {
      const t = i / 4, sw = (w + 0.7) * (1 - t * 0.86);
      b.box('roof', sw, 0.42, d + 0.9, x, y + hgt + 0.35 + i * 0.4, z, rot);
    }
    // porch + broken windows
    const c = Math.cos(rot), s = Math.sin(rot);
    b.box('wood', w * 0.7, 0.16, 1.8, x + (d / 2 + 0.9) * -s, y + 0.22, z + (d / 2 + 0.9) * c, rot);
    if (this.rnd() < 0.7) {
      b.cyl('wood', 0.1, 0.1, 2.6, 5, x - s * (d / 2 + 1.6) + c * w * 0.3, y + 1.3, z + c * (d / 2 + 1.6) + s * w * 0.3, 0, 0, 0);
    }
    // an interior floorboard that creaks (noise prop)
    this.noiseProps.push({ x: x + this.rr(-2, 2), z: z + this.rr(-2, 2), r: 1.1, loud: 0.34, kind: 'creak', used: false });
  }

  village(b, p) {
    const n = Math.round(p.r / 14);
    for (let i = 0; i < n; i++) {
      const a = this.rr(0, TAU), r = this.rr(p.r * 0.22, p.r * 0.9);
      const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
      if (W.roadDist(x, z) < 11) continue;
      this.house(b, x, z, this.rr(0, TAU), this.rr(0.85, 1.35));
    }
    // fences
    for (let i = 0; i < 90; i++) {
      const a = i / 90 * TAU, r = p.r * this.rr(0.94, 1.02);
      const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
      if (W.roadDist(x, z) < 9) continue;
      b.box('woodDark', 0.12, 1.3, 1.6, x, this.h(x, z) + 0.6, z, a);
    }
    // streetlights (dead) + one flickering
    for (let i = 0; i < 5; i++) {
      const a = this.rr(0, TAU), r = p.r * 0.6;
      const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r, y = this.h(x, z);
      b.cyl('metal', 0.13, 0.16, 7, 6, x, y + 3.5, z, 0, 0, 0, true);
      b.box('metal', 1.6, 0.2, 0.3, x + 0.7, y + 7, z, 0);
    }
    this.abandonedCars(b, p, 4);
    this.wreckedProps(b, p);
  }

  chapel(b, p) {
    const y = this.h(p.x, p.z);
    this.room(b, 'brick', 13, 22, 6.2, p.x, y, p.z, p.rot, 0, 2.6);
    for (let i = 0; i < 7; i++) {
      const t = i / 6;
      b.box('roof', 13.6 * (1 - t * 0.9), 0.5, 22.6, p.x, y + 6.4 + i * 0.55, p.z, p.rot);
    }
    // steeple
    const c = Math.cos(p.rot), s = Math.sin(p.rot);
    const sx = p.x - s * 9, sz = p.z + c * 9;
    b.box('brick', 4, 12, 4, sx, y + 6, sz, p.rot, true);
    b.cyl('roof', 0, 3, 6, 4, sx, y + 15, sz, 0, p.rot, 0);
    b.cyl('metal', 0.1, 0.1, 2.2, 4, sx, y + 19, sz);
    b.box('metal', 1.4, 0.12, 0.12, sx, y + 18.7, sz, p.rot);
    // pews
    for (let i = 0; i < 8; i++) {
      const oz = -8 + i * 2.2;
      [-3, 3].forEach(ox => {
        const wx = p.x + ox * c - oz * s, wz = p.z + ox * s + oz * c;
        b.box('woodDark', 4.4, 0.9, 0.6, wx, y + 0.6, wz, p.rot, true);
      });
    }
    this.noiseProps.push({ x: p.x, z: p.z, r: 3, loud: 0.5, kind: 'glass', used: false });
  }

  gasStation(b, p) {
    const y = this.h(p.x, p.z), c = Math.cos(p.rot), s = Math.sin(p.rot);
    const at = (ox, oz) => [p.x + ox * c - oz * s, p.z + ox * s + oz * c];
    // forecourt
    b.box('concrete', 46, 0.35, 34, p.x, y - 0.05, p.z, p.rot);
    // shop
    const [shx, shz] = at(0, -13);
    this.room(b, 'plaster', 18, 9, 3.8, shx, y + 0.18, shz, p.rot, 1, 2.4);
    b.box('roof', 20, 0.9, 11, shx, y + 4.4, shz, p.rot);
    b.box('glass', 16, 2.4, 0.15, ...(() => { const [a, d] = at(0, -8.4); return [a, y + 1.9, d]; })(), p.rot);
    // canopy + pumps
    const [cx, cz] = at(0, 6);
    b.box('roof', 24, 1.1, 15, cx, y + 6.2, cz, p.rot);
    b.box('glow', 20, 0.35, 12, cx, y + 5.6, cz, p.rot);
    [[-9, 1], [-9, 11], [9, 1], [9, 11]].forEach(([ox, oz]) => {
      const [px, pz] = at(ox, oz);
      b.cyl('metal', 0.35, 0.35, 6, 8, px, y + 3, pz, 0, 0, 0, true);
    });
    [[-4.5, 6], [4.5, 6]].forEach(([ox, oz]) => {
      const [px, pz] = at(ox, oz);
      b.box('rust', 1.1, 1.9, 0.8, px, y + 1.1, pz, p.rot, true);
      b.box('metal', 1.2, 0.5, 0.9, px, y + 2.3, pz, p.rot);
      b.box('glow', 0.55, 0.35, 0.1, px, y + 2.3, pz + 0.5, p.rot);
    });
    // price sign
    const [sx2, sz2] = at(19, -4);
    b.cyl('metal', 0.3, 0.3, 11, 6, sx2, y + 5.5, sz2, 0, 0, 0, true);
    b.box('plaster', 5, 4, 0.4, sx2, y + 11, sz2, p.rot);
    this.abandonedCars(b, p, 6);
    this.noiseProps.push({ x: shx, z: shz, r: 3.4, loud: 0.62, kind: 'glass', used: false });
  }

  planeWreck(b, p) {
    const y = this.h(p.x, p.z), c = Math.cos(p.rot), s = Math.sin(p.rot);
    const at = (ox, oz) => [p.x + ox * c - oz * s, p.z + ox * s + oz * c];

    // gouge in the earth
    for (let i = 0; i < 22; i++) {
      const [gx, gz] = at(this.rr(-6, 6), -110 + i * 5);
      b.box('stone', this.rr(6, 16), this.rr(0.5, 1.6), this.rr(5, 13), gx, this.h(gx, gz) + 0.3, gz, this.rr(0, TAU));
    }
    // forward fuselage, nose-down
    const [fx, fz] = at(0, -14);
    b.cyl('fuselage', 4.1, 4.4, 34, 14, fx, y + 4.6, fz, Math.PI / 2 - 0.22, p.rot, 0, true);
    b.cyl('fuselage', 2.0, 4.1, 8, 12, ...(() => { const [a, d] = at(0, -34); return [a, y + 2.2, d]; })(), Math.PI / 2 - 0.5, p.rot, 0, true);
    // torn-open aft section, rolled onto its side
    const [ax, az] = at(16, 46);
    b.cyl('fuselage', 4.2, 4.2, 26, 14, ax, y + 4.0, az, Math.PI / 2, p.rot + 0.9, 0.35, true);
    // tailfin
    b.box('fuselage', 0.6, 13, 9, ...(() => { const [a, d] = at(24, 60); return [a, y + 7, d]; })(), p.rot + 0.9);
    b.box('fuselage', 11, 0.5, 4, ...(() => { const [a, d] = at(24, 62); return [a, y + 11, d]; })(), p.rot + 0.9);
    // wings, sheared off
    const [w1x, w1z] = at(-26, 4);
    b.box('fuselage', 34, 0.9, 11, w1x, y + 1.2, w1z, p.rot - 0.35);
    b.cyl('rust', 2.6, 2.6, 6, 12, ...(() => { const [a, d] = at(-32, 10); return [a, y + 2.4, d]; })(), Math.PI / 2, p.rot - 0.35, 0, true);
    const [w2x, w2z] = at(34, -30);
    b.box('fuselage', 28, 0.9, 10, w2x, y + 1.0, w2z, p.rot + 1.5);
    // seat rows spilled out
    for (let i = 0; i < 16; i++) {
      const [sx, sz] = at(this.rr(-30, 40), this.rr(-40, 60));
      b.box('woodDark', 1.5, 1.1, 1.4, sx, this.h(sx, sz) + 0.55, sz, this.rr(0, TAU), true);
    }
    // debris + luggage
    for (let i = 0; i < 60; i++) {
      const [dx, dz] = at(this.rr(-70, 70), this.rr(-90, 90));
      b.box(this.rnd() < 0.6 ? 'fuselage' : 'rust', this.rr(0.6, 3.4), this.rr(0.2, 0.9), this.rr(0.6, 3),
        dx, this.h(dx, dz) + 0.2, dz, this.rr(0, TAU));
    }
    for (let i = 0; i < 5; i++) {
      const [gx, gz] = at(this.rr(-40, 40), this.rr(-50, 60));
      this.noiseProps.push({ x: gx, z: gz, r: 4, loud: 0.7, kind: 'metal', used: false });
    }
  }

  farm(b, p) {
    const y = this.h(p.x, p.z), c = Math.cos(p.rot), s = Math.sin(p.rot);
    const at = (ox, oz) => [p.x + ox * c - oz * s, p.z + ox * s + oz * c];
    // barn
    const [bx, bz] = at(0, 0);
    this.room(b, 'brick', 22, 15, 7, bx, y, bz, p.rot, 0, 4.5);
    for (let i = 0; i < 6; i++) {
      const t = i / 5;
      b.box('roof', 23 * (1 - t * 0.75), 0.6, 15.6, bx, y + 7.3 + i * 0.75, bz, p.rot);
    }
    // silo
    const [sx, sz] = at(19, -9);
    b.cyl('concrete', 5, 5, 26, 16, sx, y + 13, sz, 0, 0, 0, true);
    b.cyl('metal', 0, 5.3, 4.5, 16, sx, y + 28, sz);
    // farmhouse
    const [hx, hz] = at(-26, 16);
    this.house(b, hx, hz, p.rot + 0.4, 1.4);
    // water tower
    const [tx, tz] = at(-8, -30);
    [[-3, -3], [3, -3], [-3, 3], [3, 3]].forEach(([ox, oz]) =>
      b.cyl('metal', 0.2, 0.2, 14, 5, tx + ox, y + 7, tz + oz, 0, 0, 0, true));
    b.cyl('rust', 4.5, 4.5, 6, 12, tx, y + 16, tz);
    b.cyl('rust', 0, 4.8, 2.5, 12, tx, y + 20, tz);
    // tractor
    const [trx, trz] = at(12, 20);
    b.box('rust', 3.4, 1.6, 2, trx, y + 1.4, trz, p.rot, true);
    b.cyl('woodDark', 1.5, 1.5, 0.6, 12, trx - 1.2, y + 1.4, trz, 0, 0, Math.PI / 2);
    b.cyl('woodDark', 1.5, 1.5, 0.6, 12, trx - 1.2, y + 1.4, trz, 0, 0, Math.PI / 2);
    // fence lines
    for (let i = 0; i < 120; i++) {
      const [fx, fz] = at(-p.r + i * (p.r * 2 / 120), p.r * 0.85);
      b.box('woodDark', 0.14, 1.2, 1.7, fx, this.h(fx, fz) + 0.6, fz, p.rot);
    }
    this.cornfields = this.cornfields || [];
    this.cornfields.push({ x: p.x + c * 0 - 70 * s, z: p.z + 0 + 70 * c, w: 130, d: 90, rot: p.rot });
  }

  radioTower(b, p) {
    const y = this.h(p.x, p.z);
    b.box('concrete', 14, 0.6, 14, p.x, y, p.z, 0);
    const legs = [[-4.5, -4.5], [4.5, -4.5], [-4.5, 4.5], [4.5, 4.5]];
    const H = 68;
    legs.forEach(([ox, oz]) => {
      const tilt = 0.055;
      b.cyl('metal', 0.28, 0.42, H, 6, p.x + ox * (1 - tilt), y + H / 2, p.z + oz * (1 - tilt),
        oz * 0.001, 0, -ox * 0.001, true);
    });
    for (let i = 0; i < 14; i++) {
      const yy = y + 3 + i * (H / 14), sc = 1 - i / 18;
      b.box('metal', 9 * sc, 0.18, 0.18, p.x, yy, p.z - 4.5 * sc, 0);
      b.box('metal', 9 * sc, 0.18, 0.18, p.x, yy, p.z + 4.5 * sc, 0);
      b.box('metal', 0.18, 0.18, 9 * sc, p.x - 4.5 * sc, yy, p.z, 0);
      b.box('metal', 0.18, 0.18, 9 * sc, p.x + 4.5 * sc, yy, p.z, 0);
      b.box('metal', 12 * sc, 0.12, 0.12, p.x, yy + 2.4, p.z, i % 2 ? 0.6 : -0.6);
    }
    b.cyl('metal', 0.12, 0.12, 10, 4, p.x, y + H + 5, p.z);
    // shack with the transmitter
    this.room(b, 'plaster', 7, 6, 3.2, p.x + 12, y, p.z + 8, 0.3, 2, 1.9);
    b.box('metal', 1.6, 1.9, 0.9, p.x + 12, y + 1, p.z + 8, 0.3, true);
    // beacon
    const beacon = new THREE.PointLight(0xff3b2f, 0, 60);
    beacon.position.set(p.x, y + H + 9, p.z);
    b.extras.add(beacon);
    this.beacon = beacon;
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xff3b2f }));
    bulb.position.copy(beacon.position); b.extras.add(bulb);
    this.beaconBulb = bulb;
  }

  railYard(b, p) {
    const y = this.h(p.x, p.z), c = Math.cos(p.rot), s = Math.sin(p.rot);
    const at = (ox, oz) => [p.x + ox * c - oz * s, p.z + ox * s + oz * c];
    // rails
    for (let t = 0; t < 3; t++) {
      const ox = -22 + t * 22;
      for (let i = 0; i < 60; i++) {
        const [tx, tz] = at(ox, -95 + i * 3.2);
        b.box('woodDark', 5.2, 0.24, 1.1, tx, this.h(tx, tz) + 0.12, tz, p.rot);
      }
      [-1, 1].forEach(sg => {
        const [rx, rz] = at(ox + sg * 1.8, 0);
        b.box('metal', 0.22, 0.28, 190, rx, y + 0.34, rz, p.rot);
      });
    }
    // carriages + tanker
    for (let i = 0; i < 7; i++) {
      const ox = -22 + (i % 3) * 22, oz = -70 + i * 21;
      const [wx, wz] = at(ox, oz);
      const yy = this.h(wx, wz);
      if (i === 3) {
        b.cyl('rust', 3, 3, 17, 14, wx, yy + 3.6, wz, Math.PI / 2, p.rot, 0, true);
        b.box('metal', 17, 1, 3.4, wx, yy + 1.2, wz, p.rot);
      } else {
        b.box(i % 2 ? 'rust' : 'metal', 4.4, 4.6, 17, wx, yy + 2.8, wz, p.rot + this.rr(-0.06, 0.06), true);
        b.box('roof', 4.8, 0.3, 17.4, wx, yy + 5.2, wz, p.rot);
      }
    }
    // toppled carriage
    const [ox2, oz2] = at(30, 40);
    b.box('rust', 4.6, 17, 4.4, ox2, this.h(ox2, oz2) + 2.3, oz2, p.rot + 0.4, true);
    // water tower + shed
    this.room(b, 'brick', 12, 9, 4.2, ...(() => { const [a, d] = at(-44, -20); return [a, this.h(a, d), d]; })(), p.rot, 3, 2.2);
    for (let i = 0; i < 6; i++) {
      const [gx, gz] = at(this.rr(-40, 40), this.rr(-80, 80));
      this.noiseProps.push({ x: gx, z: gz, r: 3.5, loud: 0.66, kind: 'metal', used: false });
    }
  }

  quarry(b, p) {
    for (let i = 0; i < 70; i++) {
      const a = this.rr(0, TAU), r = this.rr(0, p.r);
      const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
      const sc = this.rr(1.5, 8);
      b.box('stone', sc, sc * this.rr(0.5, 1.3), sc * this.rr(0.7, 1.3),
        x, this.h(x, z) + sc * 0.3, z, this.rr(0, TAU), sc > 3);
    }
    // conveyor + shed
    const y = this.h(p.x, p.z);
    b.box('metal', 3, 0.6, 40, p.x, y + 7, p.z, 0.5);
    for (let i = 0; i < 6; i++)
      b.cyl('metal', 0.25, 0.25, 14, 6, p.x - 18 + i * 7, y + 3.5, p.z - 16 + i * 6, 0, 0, 0, true);
    this.room(b, 'metal', 10, 8, 4, p.x + 24, y, p.z - 18, 0.2, 0, 2.2);
    this.noiseProps.push({ x: p.x + 24, z: p.z - 18, r: 4, loud: 0.6, kind: 'metal', used: false });
  }

  abandonedCars(b, p, n) {
    for (let i = 0; i < n; i++) {
      const a = this.rr(0, TAU), r = this.rr(p.r * 0.3, p.r * 1.1);
      const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
      const y = this.h(x, z), rot = this.rr(0, TAU);
      b.box('rust', 4.4, 1.0, 1.9, x, y + 0.75, z, rot, true);
      b.box('rust', 2.4, 0.85, 1.75, x, y + 1.6, z, rot);
      b.box('glass', 2.2, 0.7, 1.6, x, y + 1.65, z, rot);
      [[-1.5, -0.95], [1.5, -0.95], [-1.5, 0.95], [1.5, 0.95]].forEach(([ox, oz]) => {
        const c = Math.cos(rot), s = Math.sin(rot);
        b.cyl('woodDark', 0.42, 0.42, 0.3, 8, x + ox * c - oz * s, y + 0.42, z + ox * s + oz * c, 0, 0, Math.PI / 2);
      });
      this.noiseProps.push({ x, z, r: 3.6, loud: 0.55, kind: 'glass', used: false });
    }
  }

  wreckedProps(b, p) {
    for (let i = 0; i < 22; i++) {
      const a = this.rr(0, TAU), r = this.rr(0, p.r);
      const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r, y = this.h(x, z);
      if (this.rnd() < 0.5) b.box('woodDark', this.rr(0.4, 2.6), 0.25, this.rr(0.3, 0.5), x, y + 0.15, z, this.rr(0, TAU));
      else b.cyl('rust', 0.5, 0.5, 1.1, 10, x, y + 0.55, z, 0, 0, this.rnd() < 0.4 ? Math.PI / 2 : 0, false);
    }
  }

  truck(b) {
    const t = W.TRUCK, y = this.h(t.x, t.z);
    b.box('rust', 6.2, 1.4, 2.4, t.x, y + 1.1, t.z, 0.3, true);
    b.box('rust', 2.6, 1.5, 2.3, t.x + 1.6, y + 2.4, t.z + 0.5, 0.3);
    b.box('glass', 2.3, 1.0, 2.1, t.x + 1.6, y + 2.6, t.z + 0.5, 0.3);
    b.box('woodDark', 3.4, 1.0, 2.3, t.x - 1.6, y + 2.2, t.z - 0.5, 0.3, true);
    [[-2, -1.2], [2, -1.2], [-2, 1.2], [2, 1.2]].forEach(([ox, oz]) => {
      const c = Math.cos(0.3), s = Math.sin(0.3);
      b.cyl('woodDark', 0.62, 0.62, 0.42, 10, t.x + ox * c - oz * s, y + 0.62, t.z + ox * s + oz * c, 0, 0, Math.PI / 2);
    });
    this.truckLight = new THREE.PointLight(0xffe0a0, 0, 30);
    this.truckLight.position.set(t.x + 3.4, y + 1.6, t.z + 1.2);
    b.extras.add(this.truckLight);
  }

  // ------------------------------------------------------------- vegetation
  vegetation() {
    const trunkG = new THREE.CylinderGeometry(0.22, 0.42, 9, 5);
    trunkG.translate(0, 4.5, 0);
    const crownG = new THREE.ConeGeometry(2.6, 9, 6);
    crownG.translate(0, 10, 0);
    const rockG = new THREE.DodecahedronGeometry(1, 0);

    const N = 3200, M = 900, K = 7000;
    const trunk = new THREE.InstancedMesh(trunkG, MAT.bark, N);
    const crown = new THREE.InstancedMesh(crownG, MAT.leaf, N);
    const rocks = new THREE.InstancedMesh(rockG, MAT.stone, M);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sv = new THREE.Vector3(), pv = new THREE.Vector3();

    let t = 0, r = 0;
    for (let i = 0; i < N * 4 && t < N; i++) {
      const x = this.rr(-W.HALF + 30, W.HALF - 30), z = this.rr(-W.HALF + 30, W.HALF - 30);
      const h = this.h(x, z);
      if (h < W.WATER + 2 || h > 200) continue;
      if (W.slopeAt(x, z, this.seed) > 0.38) continue;
      if (W.roadDist(x, z) < 10 || W.pathDist(x, z) < 8) continue;
      let inPoi = false;
      for (const p of W.POIS) if (Math.hypot(x - p.x, z - p.z) < p.r * 0.95) { inPoi = true; break; }
      if (inPoi) continue;
      // clumping
      const dens = W.fbm(x * 0.004, z * 0.004, this.seed + 5, 3);
      if (dens < 0.44) continue;
      const s = this.rr(0.7, 1.5);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.rr(0, TAU));
      m.compose(pv.set(x, h, z), q, sv.set(s, s * this.rr(0.85, 1.3), s));
      trunk.setMatrixAt(t, m); crown.setMatrixAt(t, m); t++;
      if (this.rnd() < 0.05)
        this.noiseProps.push({ x, z, r: 1.4, loud: 0.3, kind: 'branch', used: false });
    }
    for (let i = 0; i < M * 4 && r < M; i++) {
      const x = this.rr(-W.HALF, W.HALF), z = this.rr(-W.HALF, W.HALF);
      const h = this.h(x, z);
      if (h < W.WATER) continue;
      const s = this.rr(0.5, 3.4);
      q.setFromEuler(new THREE.Euler(this.rr(0, 3), this.rr(0, 6), this.rr(0, 3)));
      m.compose(pv.set(x, h + s * 0.2, z), q, sv.set(s, s * 0.7, s));
      rocks.setMatrixAt(r++, m);
    }
    trunk.count = t; crown.count = t; rocks.count = r;
    trunk.instanceMatrix.needsUpdate = crown.instanceMatrix.needsUpdate = rocks.instanceMatrix.needsUpdate = true;
    this.scene.add(trunk, crown, rocks);

    // corn — dense, blind, and it rustles
    if (this.cornfields) {
      const stalkG = new THREE.BoxGeometry(0.09, 2.5, 0.09);
      stalkG.translate(0, 1.25, 0);
      const corn = new THREE.InstancedMesh(stalkG, MAT.corn, K);
      let k = 0;
      for (const f of this.cornfields) {
        const c = Math.cos(f.rot), s = Math.sin(f.rot);
        for (let i = 0; i < K && k < K; i++) {
          const ox = this.rr(-f.w / 2, f.w / 2), oz = this.rr(-f.d / 2, f.d / 2);
          const x = f.x + ox * c - oz * s, z = f.z + ox * s + oz * c;
          const h = this.h(x, z);
          if (h < W.WATER + 1) continue;
          q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.rr(0, TAU));
          const sc = this.rr(0.8, 1.25);
          m.compose(pv.set(x, h, z), q, sv.set(sc, sc, sc));
          corn.setMatrixAt(k++, m);
        }
        // walking through corn is loud
        this.noiseProps.push({ x: f.x, z: f.z, r: Math.min(f.w, f.d) * 0.45, loud: 0.42, kind: 'rustle', used: false, repeat: true });
      }
      corn.count = k; corn.instanceMatrix.needsUpdate = true;
      this.scene.add(corn);
    }
  }

  scatterNoiseProps() {
    // bottles along the roads — the classic trap
    for (let i = 0; i < 140; i++) {
      const x = this.rr(-W.HALF, W.HALF), z = this.rr(-W.HALF, W.HALF);
      if (W.roadDist(x, z) > 9) continue;
      const h = this.h(x, z);
      if (h < W.WATER) continue;
      this.noiseProps.push({ x, z, r: 1.2, loud: 0.58, kind: 'glass', used: false });
      const g = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.34, 6), MAT.glass);
      g.position.set(x, h + 0.17, z); g.rotation.z = Math.PI / 2;
      this.scene.add(g);
    }
  }

  // ------------------------------------------------------------- collisions
  resolve(pos, radius) {
    for (const c of this.colliders) {
      const dx = pos.x - c.x, dz = pos.z - c.z;
      if (Math.abs(dx) > c.hw + radius + 3 || Math.abs(dz) > c.hd + radius + 3) continue;
      const co = Math.cos(c.rot), si = Math.sin(c.rot);
      let lx = dx * co + dz * si, lz = -dx * si + dz * co;
      const px = clamp(lx, -c.hw, c.hw), pz = clamp(lz, -c.hd, c.hd);
      let ox = lx - px, oz = lz - pz, d2 = ox * ox + oz * oz;
      if (d2 >= radius * radius) continue;
      let nx, nz, pen;
      if (d2 > 1e-8) { const d = Math.sqrt(d2); nx = ox / d; nz = oz / d; pen = radius - d; }
      else {
        const ex = c.hw - Math.abs(lx), ez = c.hd - Math.abs(lz);
        if (ex < ez) { nx = Math.sign(lx) || 1; nz = 0; pen = ex + radius; }
        else { nx = 0; nz = Math.sign(lz) || 1; pen = ez + radius; }
      }
      lx += nx * pen; lz += nz * pen;
      pos.x = c.x + lx * co - lz * si;
      pos.z = c.z + lx * si + lz * co;
    }
  }
}

/* ==========================================================================
   THE CREATURE
   ========================================================================== */
function buildCreature() {
  const g = new THREE.Group();
  const hide = new THREE.MeshStandardMaterial({ color: 0x050608, roughness: 0.62, metalness: 0.12 });
  const wet = new THREE.MeshStandardMaterial({ color: 0x0a0b0f, roughness: 0.24, metalness: 0.42 });
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0xa8ff45 });

  const body = new THREE.Group(); g.add(body);

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.55, 1.7, 6, 14), wet);
  torso.rotation.x = Math.PI / 2; torso.position.set(0, 1.55, 0.15);
  body.add(torso);
  const hump = new THREE.Mesh(new THREE.SphereGeometry(0.62, 12, 10), hide);
  hump.scale.set(1.05, 0.85, 1.25); hump.position.set(0, 1.9, -0.75);
  body.add(hump);
  // spine ridge
  for (let i = 0; i < 9; i++) {
    const s = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.42 - i * 0.02, 4), hide);
    s.position.set(0, 2.02 - i * 0.02, -1.15 + i * 0.28);
    s.rotation.x = -0.55; body.add(s);
  }

  // ---- head
  const neck = new THREE.Group(); neck.position.set(0, 1.85, -1.25); body.add(neck);
  const nk = new THREE.Mesh(new THREE.CapsuleGeometry(0.19, 0.62, 4, 8), wet);
  nk.rotation.x = 1.15; nk.position.set(0, 0.02, -0.3); neck.add(nk);

  const head = new THREE.Group(); head.position.set(0, 0.02, -0.72); neck.add(head);
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.33, 14, 10), wet);
  skull.scale.set(0.9, 0.78, 1.55); head.add(skull);
  const snout = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.55, 8), hide);
  snout.rotation.x = -Math.PI / 2; snout.position.set(0, -0.04, -0.52); head.add(snout);

  // jaw that hinges open when it screams
  const jaw = new THREE.Group(); jaw.position.set(0, -0.12, -0.1); head.add(jaw);
  const jm = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.5, 6), hide);
  jm.rotation.x = -Math.PI / 2; jm.position.set(0, -0.05, -0.4); jaw.add(jm);
  for (let i = 0; i < 8; i++) {
    const t = new THREE.Mesh(new THREE.ConeGeometry(0.028, 0.14, 4), new THREE.MeshStandardMaterial({ color: 0xd8d2c4, roughness: 0.5 }));
    t.position.set((i % 2 ? 1 : -1) * (0.055 + (i >> 1) * 0.012), 0.02, -0.24 - (i >> 1) * 0.1);
    t.rotation.x = 2.9; jaw.add(t);
  }

  // the peeled-back armour plates around the ears
  const plates = new THREE.Group(); head.add(plates);
  for (let i = 0; i < 8; i++) {
    const side = i < 4 ? -1 : 1, k = i % 4;
    const p = new THREE.Mesh(new THREE.ConeGeometry(0.13 - k * 0.015, 0.62 + k * 0.14, 4), hide);
    p.position.set(side * (0.22 + k * 0.045), 0.14 - k * 0.06, 0.16 + k * 0.1);
    p.rotation.set(-0.9 - k * 0.12, side * (0.5 + k * 0.2), side * (0.7 + k * 0.15));
    plates.add(p);
  }

  const eyes = [];
  [-1, 1].forEach(s => {
    const e = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), eyeMat);
    e.position.set(s * 0.16, 0.07, -0.24); head.add(e); eyes.push(e);
    const socket = new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 6), hide);
    socket.position.copy(e.position); socket.position.z += 0.05; head.add(socket);
  });
  const eyeLight = new THREE.PointLight(0xa8ff45, 1.6, 16, 2);
  eyeLight.position.set(0, 0.07, -0.35); head.add(eyeLight);

  // ---- legs: reverse-knee, unnaturally long
  const legs = [];
  const legDefs = [[-0.44, 1.42, -0.62, 1], [0.44, 1.42, -0.62, 1], [-0.48, 1.38, 0.78, -1], [0.48, 1.38, 0.78, -1]];
  legDefs.forEach(([lx, ly, lz, front]) => {
    const hip = new THREE.Group(); hip.position.set(lx, ly, lz); body.add(hip);
    const upper = new THREE.Group(); hip.add(upper);
    const um = new THREE.Mesh(new THREE.CapsuleGeometry(0.11, 0.85, 4, 7), hide);
    um.position.y = -0.48; upper.add(um);
    const knee = new THREE.Group(); knee.position.y = -0.96; upper.add(knee);
    const lm = new THREE.Mesh(new THREE.CapsuleGeometry(0.082, 0.95, 4, 7), hide);
    lm.position.y = -0.52; knee.add(lm);
    const ankle = new THREE.Group(); ankle.position.y = -1.02; knee.add(ankle);
    const fm = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.34, 4, 6), hide);
    fm.position.y = -0.2; ankle.add(fm);
    const foot = new THREE.Group(); foot.position.y = -0.4; ankle.add(foot);
    for (let c = 0; c < 3; c++) {
      const cl = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.26, 4), hide);
      cl.position.set((c - 1) * 0.075, -0.02, -0.11);
      cl.rotation.x = -1.9; foot.add(cl);
    }
    legs.push({ hip, upper, knee, ankle, foot, front });
  });

  // ---- tail
  const tail = [];
  let parent = body, py = 1.6, pz = 0.95;
  for (let i = 0; i < 8; i++) {
    const seg = new THREE.Group();
    seg.position.set(0, i === 0 ? py : 0, i === 0 ? pz : 0.34);
    const r = 0.13 - i * 0.014;
    const sm = new THREE.Mesh(new THREE.CapsuleGeometry(Math.max(0.02, r), 0.3, 3, 6), hide);
    sm.rotation.x = Math.PI / 2; sm.position.z = 0.17; seg.add(sm);
    parent.add(seg); parent = seg; tail.push(seg);
  }

  g.scale.setScalar(1.28);
  return { root: g, body, neck, head, jaw, plates, eyes, eyeLight, legs, tail, eyeMat, phase: Math.random() * 10 };
}

function animateCreature(c, dt, speed, state, screechT) {
  const gait = clamp(speed / 8, 0.15, 1.6);
  c.phase += dt * (2.4 + speed * 1.35);
  const charging = state === 'charge';

  c.legs.forEach((L, i) => {
    const off = [0, Math.PI, Math.PI * 1.05, 0.05][i];
    const s = Math.sin(c.phase + off), cs = Math.cos(c.phase + off);
    const sw = gait * (charging ? 1.25 : 1);
    L.upper.rotation.x = (L.front > 0 ? -0.28 : -0.42) + s * 0.85 * sw;
    L.knee.rotation.x = (L.front > 0 ? 1.35 : 1.5) - Math.max(0, cs) * 1.0 * sw;
    L.ankle.rotation.x = -0.95 + s * 0.5 * sw;
    L.foot.rotation.x = 0.4 - Math.min(0, s) * 0.5;
    L.hip.rotation.z = Math.sin(c.phase * 0.5 + i) * 0.05;
  });

  const bob = Math.abs(Math.sin(c.phase)) * 0.085 * gait;
  c.body.position.y = bob;
  c.body.rotation.z = Math.sin(c.phase) * 0.05 * gait;
  c.body.rotation.x = charging ? -0.14 - bob * 0.4 : Math.sin(c.phase * 2) * 0.02;

  // listening: the head sweeps in slow arcs when it has lost you
  const listening = state === 'stalk' || state === 'patrol';
  const t = performance.now() * 0.001;
  c.neck.rotation.y = listening ? Math.sin(t * 0.75) * 0.85 : Math.sin(t * 3) * 0.06;
  c.neck.rotation.x = listening ? 0.15 + Math.sin(t * 0.4) * 0.25 : (charging ? 0.35 : 0.05);
  c.head.rotation.z = listening ? Math.sin(t * 1.3) * 0.28 : 0;

  c.tail.forEach((s, i) => {
    s.rotation.y = Math.sin(c.phase * 0.85 - i * 0.55) * (0.14 + i * 0.022);
    s.rotation.x = Math.sin(c.phase * 0.6 - i * 0.4) * 0.05;
  });

  // screech pose
  const sc = clamp(1 - (performance.now() - screechT) / 900, 0, 1);
  c.jaw.rotation.x = sc * 0.85;
  c.plates.children.forEach((p, i) => { p.scale.setScalar(1 + sc * 0.5); });
  const glow = state === 'stunned' ? 0.12 : (0.7 + sc * 2.2 + (charging ? 0.9 : 0) + Math.sin(t * 9) * 0.12);
  c.eyeLight.intensity = 1.2 * glow;
  c.eyeMat.color.setRGB(0.55 * glow, 1.0 * Math.min(1, glow), 0.2 * glow);
}

/* ==========================================================================
   PLAYER AVATAR (remote)
   ========================================================================== */
function buildAvatar(name) {
  const g = new THREE.Group();
  const cloth = new THREE.MeshStandardMaterial({ color: 0x2e3338, roughness: 0.95 });
  const skin = new THREE.MeshStandardMaterial({ color: 0x8a6b56, roughness: 0.85 });
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.24, 0.6, 4, 8), cloth);
  torso.position.y = 1.15; g.add(torso);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), skin);
  head.position.y = 1.66; g.add(head);
  const legs = [];
  [-0.12, 0.12].forEach(x => {
    const l = new THREE.Group(); l.position.set(x, 0.82, 0); g.add(l);
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(0.09, 0.6, 4, 6), cloth);
    m.position.y = -0.34; l.add(m); legs.push(l);
  });
  const arms = [];
  [-0.3, 0.3].forEach(x => {
    const a = new THREE.Group(); a.position.set(x, 1.42, 0); g.add(a);
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.55, 4, 6), cloth);
    m.position.y = -0.32; a.add(m); arms.push(a);
  });
  const can = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.34, 0.18), MAT.canMat);
  can.position.set(0.34, 1.05, 0); can.visible = false; g.add(can);

  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 64;
  const cx = cv.getContext('2d');
  cx.font = '600 30px monospace'; cx.textAlign = 'center';
  cx.fillStyle = '#9dff4a'; cx.fillText(name, 128, 40);
  const tag = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(cv), transparent: true, depthTest: false, opacity: 0.75,
  }));
  tag.scale.set(2.4, 0.6, 1); tag.position.y = 2.15; g.add(tag);

  const lamp = new THREE.SpotLight(0xfff0cc, 0, 42, 0.42, 0.55, 1.4);
  lamp.position.set(0, 1.55, 0); lamp.target.position.set(0, 1.4, -3);
  g.add(lamp, lamp.target);

  const sig = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthTest: false }));
  sig.scale.set(0.7, 0.7, 1); sig.position.y = 2.55; g.add(sig);

  return { root: g, legs, arms, head, can, lamp, tag, sig, phase: 0 };
}

/* ==========================================================================
   NETWORK
   ========================================================================== */
class Net {
  constructor(onMsg) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}`);
    this.q = [];
    this.ws.onopen = () => { this.open = true; this.q.forEach(m => this.send(m)); this.q = []; };
    this.ws.onmessage = e => onMsg(JSON.parse(e.data));
    this.ws.onclose = () => { this.open = false; onMsg({ t: 'event', kind: 'log', tone: 'bad', text: 'Connection lost.' }); };
  }
  send(m) { if (this.open) this.ws.send(JSON.stringify(m)); else this.q.push(m); }
}

/* ==========================================================================
   GAME
   ========================================================================== */
class Game {
  constructor(cfg) {
    this.cfg = cfg;
        this.mic = cfg && cfg.mic ? cfg.mic : null;
    this.sfx = new Sfx(); 
    // Only pass the context if the microphone has been enabled and initialized
    if (this.mic && this.mic.ctx) {
      this.sfx.init(this.mic.ctx);
    } else {
      this.sfx.init(null);
    }


    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    document.body.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05070b);
    this.scene.fog = new THREE.FogExp2(0x070a0e, 0.0075);

    this.cam = new THREE.PerspectiveCamera(74, innerWidth / innerHeight, 0.1, 2600);
    this.scene.add(this.cam);

    const hemi = new THREE.HemisphereLight(0x24303f, 0x0a0c08, 0.30);
    const moon = new THREE.DirectionalLight(0x8fa8c8, 0.42);
    moon.position.set(-320, 420, 260);
    this.scene.add(hemi, moon);

    this.torch = new THREE.SpotLight(0xffeecc, 0, 55, 0.40, 0.5, 1.3);
    this.torchTarget = new THREE.Object3D();
    this.cam.add(this.torch, this.torchTarget);
    this.torch.position.set(0.18, -0.16, 0);
    this.torchTarget.position.set(0, 0, -6);
    this.torch.target = this.torchTarget;
    this.torchOn = false; this.battery = 100;

    // state
    this.players = new Map();
    this.creatures = new Map();
    this.canMeshes = new Map();
    this.pulses = [];
    this.snaps = [];
    this.phase = 'lobby';
    this.fuel = 0; this.need = 4; this.fuelTimer = 0; this.towerCd = 0;
    this.me = null; this.dead = false; this.down = false;
    this.stance = 'stand'; this.breath = 100; this.holding = false;
    this.vel = new THREE.Vector3();
    this.pos = new THREE.Vector3();
    this.yaw = 0; this.pitch = 0;
    this.stepAcc = 0; this.micAcc = 0; this.netAcc = 0;
    this.shake = 0; this.prompt = null; this.reviveTarget = null;
    this.logs = [];

    this.keys = {};
    this.bindInput();

    this.net = new Net(m => this.onMsg(m));
    this.net.send({ t: 'join', name: cfg.name, room: cfg.room });

    addEventListener('resize', () => {
      this.cam.aspect = innerWidth / innerHeight;
      this.cam.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
    });

    this.clock = new THREE.Clock();
    this.raycaster = new THREE.Raycaster();
    this.loop = this.loop.bind(this);
  }

  // ------------------------------------------------------------------ input
  bindInput() {
    const cv = this.renderer.domElement;
    cv.addEventListener('click', () => { if (!this.chatting) cv.requestPointerLock(); });
    document.addEventListener('mousemove', e => {
      if (document.pointerLockElement !== cv) return;
      this.yaw -= e.movementX * 0.0022;
      this.pitch = clamp(this.pitch - e.movementY * 0.0022, -1.45, 1.45);
    });
    addEventListener('keydown', e => {
      if (this.chatting) {
        if (e.key === 'Enter') this.sendChat();
        else if (e.key === 'Escape') this.closeChat();
        return;
      }
      this.keys[e.code] = true;
      if (e.code === 'KeyF') this.toggleTorch();
      if (e.code === 'KeyZ') this.setStance(this.stance === 'prone' ? 'stand' : 'prone');
      if (e.code === 'KeyE') this.interact();
      if (e.code === 'KeyQ') this.net.send({ t: 'act', a: 'drop' });
      if (e.code === 'KeyC') $('#wheel').style.display = 'grid';
      if (e.code === 'KeyT') this.openChat();
      if (/^Digit[1-4]$/.test(e.code) && $('#wheel').style.display === 'grid') {
        this.net.send({ t: 'signal', id: +e.code.slice(5) });
        $('#wheel').style.display = 'none';
      }
    });
    addEventListener('keyup', e => {
      this.keys[e.code] = false;
      if (e.code === 'KeyC') $('#wheel').style.display = 'none';
    });
    addEventListener('blur', () => { this.keys = {}; });
  }
  openChat() { this.chatting = true; $('#chat').style.display = 'block'; $('#chatIn').focus(); document.exitPointerLock(); }
  closeChat() { this.chatting = false; $('#chat').style.display = 'none'; $('#chatIn').value = ''; }
  sendChat() {
    const v = $('#chatIn').value.trim();
    if (v) this.net.send({ t: 'chat', text: v });
    this.closeChat();
  }
  toggleTorch() {
    if (this.battery <= 0) return;
    this.torchOn = !this.torchOn;
    this.torch.intensity = this.torchOn ? 3.2 : 0;
  }
  setStance(s) { this.stance = this.stance === s ? 'stand' : s; }

  interact() {
    if (this.dead) return;
    if (this.prompt?.kind === 'can') this.net.send({ t: 'act', a: 'pickup' });
    else if (this.prompt?.kind === 'truck') this.net.send({ t: 'act', a: 'deliver' });
    else if (this.prompt?.kind === 'tower') this.net.send({ t: 'act', a: 'tower' });
  }

  // -------------------------------------------------------------- messages
  onMsg(m) {
    switch (m.t) {
      case 'welcome':
        this.myId = m.you; this.seed = m.seed;
        this.world = new World(this.scene, m.seed);
        this.world.build();
        this.pos.set(m.spawn.x, m.spawn.y, m.spawn.z);
        $('#menu').style.display = 'none';
        this.log(`Room ${m.room}. Seed ${m.seed}. Keep quiet.`, 'warn');
        this.clock.start();
        requestAnimationFrame(this.loop);
        break;

      case 'snap':
        this.snaps.push(m);
        if (this.snaps.length > 12) this.snaps.shift();
        this.applySnap(m);
        break;

      case 'pulse':
        this.spawnPulse(m.x, m.z, m.loud, m.by === this.myId);
        if (m.by !== this.myId && m.kind !== 'mic') this.playKind(m.kind, m.x, m.z, m.loud);
        break;

      case 'event': this.onEvent(m); break;

      case 'full': this.log('Room is full.', 'bad'); break;
    }
  }

  playKind(kind, x, z, loud) {
    const y = this.world ? this.world.h(x, z) + 0.5 : 0;
    if (kind === 'glass') this.sfx.glass(x, y, z);
    else if (kind === 'metal') this.sfx.metal(x, y, z);
    else if (kind === 'engine') this.sfx.thud(x, y, z, true);
    else if (kind === 'creak' || kind === 'branch') this.sfx.step(x, y, z, 'grass', 0.6);
    else if (kind === 'rustle') this.sfx.step(x, y, z, 'sand', 0.5);
  }

  onEvent(m) {
    switch (m.kind) {
      case 'log': this.log(m.text, m.tone); break;
      case 'chat': this.log(`${m.name}: ${m.text}`, 'info'); break;
      case 'begin': this.log(`${m.creatures} contact${m.creatures > 1 ? 's' : ''} in the valley.`, 'bad'); break;
      case 'screech':
        this.sfx.screech(m.x, m.y + 1.5, m.z);
        this.shake = Math.max(this.shake, 0.55);
        const c = this.creatures.get(m.id); if (c) c.screechT = performance.now();
        break;
      case 'hit':
        this.sfx.thud(m.x, m.y + 1, m.z, true);
        this.sfx.screech(m.x, m.y + 1.5, m.z);
        if (m.target === this.myId) { this.flash(); this.shake = 1.4; }
        break;
      case 'feedback':
        this.sfx.feedback();
        if (this.world?.beacon) {
          this.world.beacon.intensity = 6;
          setTimeout(() => { if (this.world.beacon) this.world.beacon.intensity = 0; }, 20000);
        }
        break;
      case 'signal': {
        const names = ['', 'QUIET', 'FOLLOW ME', 'DANGER', 'HELP'];
        this.log(`${m.name} signals: ${names[m.id] || '?'}`, m.id === 3 || m.id === 4 ? 'warn' : 'info');
        this.sfx.blip(true);
        break;
      }
      case 'over':
        this.banner(m.won ? 'You got out' : 'Silence', m.text);
        break;
    }
  }

  applySnap(s) {
    this.phase = s.phase; this.fuel = s.fuel; this.need = s.need;
    this.fuelTimer = s.fuelTimer; this.towerCd = s.towerCd;

    const seen = new Set();
    for (const p of s.players) {
      seen.add(p.id);
      if (p.id === this.myId) {
        this.me = p;
        if (p.down && !this.down) { this.down = true; this.flash(); }
        if (!p.down) this.down = false;
        if (p.dead && !this.dead) { this.dead = true; this.banner('Taken', 'It found you.'); }
        continue;
      }
      let a = this.players.get(p.id);
      if (!a) { a = buildAvatar(p.name); this.scene.add(a.root); this.players.set(p.id, a); }
      a.target = p;
      if (!a.pos) { a.pos = new THREE.Vector3(p.x, p.y, p.z); }
    }
    for (const [id, a] of this.players)
      if (!seen.has(id)) { this.scene.remove(a.root); this.players.delete(id); }

    const cSeen = new Set();
    for (const c of s.creatures) {
      cSeen.add(c.id);
      let v = this.creatures.get(c.id);
      if (!v) {
        v = buildCreature(); v.screechT = -9999;
        v.pos = new THREE.Vector3(c.x, c.y, c.z); v.yaw = c.yaw;
        this.scene.add(v.root); this.creatures.set(c.id, v);
      }
      v.target = c;
    }
    for (const [id, v] of this.creatures)
      if (!cSeen.has(id)) { this.scene.remove(v.root); this.creatures.delete(id); }

    // fuel cans
    const canSeen = new Set();
    for (const c of s.cans) {
      canSeen.add(c.id);
      let m = this.canMeshes.get(c.id);
      if (!m) {
        m = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.42, 0.22), MAT.canMat);
        const l = new THREE.PointLight(0xff5a3c, 0.9, 7); m.add(l);
        this.scene.add(m); this.canMeshes.set(c.id, m);
      }
      m.visible = !c.delivered && !c.held;
      m.position.set(c.x, c.y, c.z);
      m.rotation.y += 0.01;
    }
    this.cans = s.cans;
  }

  // -------------------------------------------------------------- movement
  updateLocal(dt) {
    const walkable = !this.dead;
    const eye = { stand: 1.62, crouch: 0.95, prone: 0.42 }[this.stance];

    if (this.keys['ControlLeft'] || this.keys['ControlRight']) {
      if (this.stance === 'stand') this.stance = 'crouch';
    } else if (this.stance === 'crouch') this.stance = 'stand';

    // breath holding
    this.holding = !!this.keys['KeyV'] && this.breath > 0 && !this.dead;
    this.mic.held = this.holding;
    if (this.holding) {
      this.breath -= dt * 13;
      if (this.breath <= 0) {
        this.breath = 0; this.holding = false; this.mic.held = false;
        this.emitNoise(0.55, 'gasp');   // forced gasp — the worst possible moment
        this.log('You had to breathe.', 'bad');
      }
    } else this.breath = Math.min(100, this.breath + dt * 9);

    if (!walkable || this.down) {
      // crawling while down is slow and noisy
      if (this.down && !this.dead) {
        const f = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
        let mv = 0;
        if (this.keys['KeyW']) mv = 1; if (this.keys['KeyS']) mv = -1;
        if (mv) {
          this.pos.addScaledVector(f, -mv * 0.9 * dt);
          this.world.resolve(this.pos, 0.4);
          this.stepAcc += 0.9 * dt;
          if (this.stepAcc > 1.4) { this.stepAcc = 0; this.emitNoise(0.2, 'cloth'); }
        }
      }
      this.pos.y = this.world.h(this.pos.x, this.pos.z);
      this.applyCamera(this.down ? 0.5 : 0.3, dt);
      return;
    }

    const sprint = this.keys['ShiftLeft'] && this.stance === 'stand';
    const base = { stand: sprint ? 6.3 : 3.4, crouch: 1.9, prone: 0.8 }[this.stance];

    const f = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const r = new THREE.Vector3(-f.z, 0, f.x);
    const dir = new THREE.Vector3();
    if (this.keys['KeyW']) dir.add(f);
    if (this.keys['KeyS']) dir.sub(f);
    if (this.keys['KeyD']) dir.add(r);
    if (this.keys['KeyA']) dir.sub(r);
    const moving = dir.lengthSq() > 0;
    if (moving) dir.normalize();

    const want = dir.multiplyScalar(base);
    this.vel.lerp(want, Math.min(1, dt * 11));

    const nx = this.pos.x + this.vel.x * dt, nz = this.pos.z + this.vel.z * dt;
    if (W.isWalkable(nx, nz, this.seed)) { this.pos.x = nx; this.pos.z = nz; }
    else this.vel.multiplyScalar(0.2);
    this.pos.x = clamp(this.pos.x, -W.HALF + 20, W.HALF - 20);
    this.pos.z = clamp(this.pos.z, -W.HALF + 20, W.HALF - 20);
    this.world.resolve(this.pos, 0.42);
    this.pos.y = this.world.h(this.pos.x, this.pos.z);

    // ---- footstep noise
    const sp = Math.hypot(this.vel.x, this.vel.z);
    if (sp > 0.15) {
      this.stepAcc += sp * dt;
      const stride = { stand: sprint ? 1.9 : 2.3, crouch: 1.5, prone: 1.2 }[this.stance];
      if (this.stepAcc >= stride) {
        this.stepAcc = 0;
        const ground = W.groundAt(this.pos.x, this.pos.z, this.seed);
        const muffle = W.MUFFLE[ground] ?? 1;
        const stanceLoud = { stand: sprint ? 0.88 : 0.34, crouch: 0.12, prone: 0.045 }[this.stance];
        const loud = clamp(stanceLoud * muffle, 0, 1);
        this.sfx.step(this.pos.x, this.pos.y, this.pos.z, ground, loud);
        this.emitNoise(loud, 'step');
      }
    }

    // ---- noise props (bottles, corn, creaking boards)
    for (const np of this.world.noiseProps) {
      if (np.used && !np.repeat) continue;
      if ((this.pos.x - np.x) ** 2 + (this.pos.z - np.z) ** 2 > np.r * np.r) continue;
      if (np.repeat) {
        if (sp < 0.4) continue;
        np.cd = (np.cd || 0) - dt;
        if (np.cd > 0) continue;
        np.cd = 0.45;
      } else np.used = true;
      const l = np.loud * (this.stance === 'stand' ? 1 : this.stance === 'crouch' ? 0.55 : 0.3);
      this.emitNoise(l, np.kind);
      this.playKind(np.kind, np.x, this.pos.y, np.z, l);
      if (!np.repeat) this.log(np.kind === 'glass' ? 'Glass. Loud.' : 'Something gave under your weight.', 'bad');
    }

    if (this.torchOn) {
      this.battery -= dt * 0.55;
      if (this.battery <= 0) { this.battery = 0; this.toggleTorch(); }
    }

    this.applyCamera(eye, dt);
  }

  applyCamera(eye, dt) {
    const sp = Math.hypot(this.vel.x, this.vel.z);
    this.bobT = (this.bobT || 0) + dt * sp * 2.4;
    const bob = Math.sin(this.bobT) * 0.035 * Math.min(1, sp / 4);
    const roll = Math.cos(this.bobT * 0.5) * 0.012 * Math.min(1, sp / 5);
    this.shake = Math.max(0, this.shake - dt * 1.8);
    const sh = this.shake * 0.06;
    this.cam.position.set(
      this.pos.x + (Math.random() - 0.5) * sh,
      this.pos.y + eye + bob + (Math.random() - 0.5) * sh,
      this.pos.z + (Math.random() - 0.5) * sh);
    this.cam.rotation.set(this.pitch, this.yaw, roll + (Math.random() - 0.5) * sh * 0.4, 'YXZ');
  }

  emitNoise(loud, kind) {
    if (loud < 0.02) return;
    this.net.send({ t: 'noise', x: this.pos.x, z: this.pos.z, loud, kind });
  }

  // ----------------------------------------------------------------- pulses
  spawnPulse(x, z, loud, mine) {
    const geo = new THREE.RingGeometry(0.6, 0.9, 40);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      color: mine ? 0x9dff4a : 0xff8a4a, transparent: true, opacity: 0.5,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, this.world.h(x, z) + 0.4, z);
    this.scene.add(m);
    this.pulses.push({ m, t: 0, max: 12 + loud * 90 });
  }
  updatePulses(dt) {
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const p = this.pulses[i];
      p.t += dt;
      const k = p.t / 1.4;
      if (k >= 1) { this.scene.remove(p.m); p.m.geometry.dispose(); this.pulses.splice(i, 1); continue; }
      p.m.scale.setScalar(1 + k * p.max);
      p.m.material.opacity = 0.5 * (1 - k) ** 2;
    }
  }

  // ------------------------------------------------------------- interaction
  updatePrompt(dt) {
    this.prompt = null;
    let best = 99;
    // fuel can
    if (this.cans && !this.me?.car) {
      for (const c of this.cans) {
        if (c.delivered || c.held) continue;
        const d = Math.hypot(c.x - this.pos.x, c.z - this.pos.z);
        if (d < 3.5 && d < best) { best = d; this.prompt = { kind: 'can', text: '<b>E</b> take fuel can' }; }
      }
    }
    // truck
    const dt2 = Math.hypot(W.TRUCK.x - this.pos.x, W.TRUCK.z - this.pos.z);
    if (dt2 < 6) {
      if (this.me?.car) this.prompt = { kind: 'truck', text: '<b>E</b> load fuel into the truck' };
      else if (this.phase === 'extract') this.prompt = { kind: 'none', text: 'Get in the truck' };
      else if (this.phase === 'fueling') this.prompt = { kind: 'none', text: `Fueling — ${this.fuelTimer}s` };
      else this.prompt = { kind: 'none', text: `Truck needs ${this.need - this.fuel} more fuel can(s)` };
    }
    // radio tower
    if (Math.hypot(320 - this.pos.x, -780 - this.pos.z) < 8) {
      this.prompt = this.towerCd > 0
        ? { kind: 'none', text: `Transmitter recharging — ${Math.ceil(this.towerCd)}s` }
        : { kind: 'tower', text: '<b>E</b> trigger feedback (stuns them, 20s)' };
    }
    // revive
    this.reviveTarget = null;
    for (const [id, a] of this.players) {
      if (!a.target?.down || a.target.dead) continue;
      const d = Math.hypot(a.pos.x - this.pos.x, a.pos.z - this.pos.z);
      if (d < 3 && !this.down && !this.dead) {
        this.reviveTarget = a;
        this.prompt = { kind: 'revive', text: `<b>Hold E</b> help ${a.target.name} up`, prog: a.target.rev };
      }
    }
    if (this.reviveTarget && this.keys['KeyE'])
      this.net.send({ t: 'revive', id: this.reviveTarget.target.id, dt });
  }

  // ------------------------------------------------------------------- HUD
  log(text, tone = 'info') {
    const el = document.createElement('div');
    el.className = tone; el.textContent = text;
    $('#log').appendChild(el);
    setTimeout(() => el.remove(), 9000);
    while ($('#log').children.length > 8) $('#log').firstChild.remove();
  }
  flash() { const f = $('#flash'); f.style.transition = 'none'; f.style.opacity = 0.55; setTimeout(() => { f.style.transition = 'opacity .6s'; f.style.opacity = 0; }, 30); }
  banner(title, sub) {
    const b = $('#banner');
    b.innerHTML = title + '<small>' + (sub || '') + '</small>';
    b.style.opacity = 1;
    setTimeout(() => { b.style.opacity = 0; }, 7000);
  }

  updateHud() {
    const lvl = this.mic.level;
    $('#mic .fill').style.height = lvl + '%';
    $('#mic .thr').style.bottom = this.mic.threshold + '%';
    $('#micDb').textContent = (this.mic.db < -95 ? '-∞' : this.mic.db.toFixed(0)) + ' dB'
      + (this.holding ? '  HELD' : '');
    $('#stance').textContent = this.down ? 'DOWN — CRAWLING'
      : this.dead ? 'GONE' : { stand: this.keys['ShiftLeft'] ? 'SPRINTING (LOUD)' : 'STANDING', crouch: 'CROUCHED', prone: 'PRONE' }[this.stance];
    $('#stance').style.color = lvl > this.mic.threshold ? '#e2483c' : '#c9cfd2';
    $('#breath i').style.width = this.breath + '%';

    // objectives
    const done = this.fuel;
    const rows = [
      `<div class="o ${done >= this.need ? 'done' : ''}">Fuel cans to the truck — ${done}/${this.need}</div>`,
      this.phase === 'fueling' ? `<div class="o">Survive the fueling — ${this.fuelTimer}s</div>` : '',
      this.phase === 'extract' ? `<div class="o">Reach the truck</div>` : '',
      `<div class="o" style="opacity:.6">Battery ${this.batt}%</div>`
    ];
    
    // Inject the rows into the objectives UI container
    const objEl = $('#objectives');
    if (objEl) objEl.innerHTML = rows.join('');
  }
}

/* ==========================================================================
   BOOTSTRAP ENGINE CORE — Main Loop State Orchestrator
   ========================================================================== */
// Start your custom game engine cleanly once the DOM loads
// Remove immediate auto-initialization to stop early crashes
// Remove immediate auto-initialization to stop early crashes
window.addEventListener('DOMContentLoaded', () => {
  console.log("DOM loaded. Awaiting user interaction to initialize Game configuration.");
});


