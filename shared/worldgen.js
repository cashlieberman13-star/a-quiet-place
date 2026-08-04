'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.QPWorld = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const SIZE = 2048, HALF = SIZE / 2, WATER = -5;

  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const lerp = (a, b, t) => a + (b - a) * t;
  function smoothstep(e0, e1, x) {
    const t = clamp((x - e0) / (e1 - e0 || 1e-6), 0, 1);
    return t * t * (3 - 2 * t);
  }

  function hash(x, y, seed) {
    let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 2246822519)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177) | 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  }
  function vnoise(x, y, seed) {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    return lerp(
      lerp(hash(xi, yi, seed), hash(xi + 1, yi, seed), u),
      lerp(hash(xi, yi + 1, seed), hash(xi + 1, yi + 1, seed), u), v);
  }
  function fbm(x, y, seed, oct) {
    let s = 0, a = 0.5, f = 1, n = 0;
    for (let i = 0; i < oct; i++) { s += vnoise(x * f, y * f, seed + i * 131) * a; n += a; a *= 0.5; f *= 2.03; }
    return s / n;
  }
  function ridged(x, y, seed, oct) {
    let s = 0, a = 0.5, f = 1, n = 0;
    for (let i = 0; i < oct; i++) {
      s += (1 - Math.abs(vnoise(x * f, y * f, seed + i * 197) * 2 - 1)) * a;
      n += a; a *= 0.5; f *= 2.11;
    }
    return s / n;
  }

  // ---------------------------------------------------------------- layout
  const POIS = [
    { id: 'ashfall',   name: 'Ashfall Village',       type: 'village', x: -280, z: -200, r: 135, rot: 0.18,  flat: 1.00 },
    { id: 'millbrook', name: 'Millbrook',             type: 'village', x:  430, z:  250, r: 125, rot: -0.55, flat: 1.00 },
    { id: 'hollow',    name: 'Grey Hollow',           type: 'village', x:   70, z:  660, r: 105, rot: 1.05,  flat: 1.00 },
    { id: 'gas',       name: 'Route 9 Gas Station',   type: 'gas',     x:  -30, z:   90, r:  78, rot: 0.00,  flat: 1.00 },
    { id: 'crash',     name: 'Flight 217 Crash Site', type: 'plane',   x:  640, z: -430, r: 165, rot: 0.42,  flat: 0.85 },
    { id: 'farm',      name: 'Weller Farm',           type: 'farm',    x: -580, z:  250, r: 150, rot: -0.28, flat: 1.00 },
    { id: 'tower',     name: 'Radio Tower KX-4',      type: 'tower',   x:  320, z: -780, r:  62, rot: 0.00,  flat: 0.90 },
    { id: 'chapel',    name: "St. Anne's Chapel",     type: 'chapel',  x: -740, z: -580, r:  58, rot: 0.75,  flat: 1.00 },
    { id: 'yard',      name: 'Rail Yard',             type: 'yard',    x: -160, z: -720, r: 110, rot: 0.10,  flat: 0.95 },
    { id: 'quarry',    name: 'Dry Quarry',            type: 'quarry',  x:  780, z:  540, r: 130, rot: 0.00,  flat: 0.50 },
  ];
  const LAKE = { x: 700, z: 60, r: 190 };

  const ROADS = [
    [[-980,-620],[-740,-580],[-460,-420],[-280,-200],[-150,-30],[-30,90],[180,260],[430,250],[640,400],[780,540]],
    [[-30,90],[10,300],[70,660],[120,900]],
    [[-280,-200],[-200,-460],[-160,-720],[-120,-940]],
    [[-30,90],[-260,150],[-580,250],[-880,300]],
    [[180,260],[300,-200],[320,-780]],
  ];
  // Sand trails — the family's muffled paths. Footsteps here are almost silent.
  const PATHS = [
    [[-30,90],[-120,-20],[-280,-200]],
    [[-30,90],[60,340],[70,660]],
    [[430,250],[540,-100],[640,-430]],
    [[-580,250],[-660,-160],[-740,-580]],
  ];

  const FUEL_SPOTS = [
    { id: 'f_farm',   poi: 'farm',      x: -545, z:  212, label: 'Weller Farm — barn' },
    { id: 'f_crash',  poi: 'crash',     x:  672, z: -398, label: 'Crash site — cargo hold' },
    { id: 'f_ash',    poi: 'ashfall',   x: -246, z: -238, label: 'Ashfall — garage' },
    { id: 'f_yard',   poi: 'yard',      x: -132, z: -688, label: 'Rail yard — tanker' },
    { id: 'f_mill',   poi: 'millbrook', x:  462, z:  284, label: 'Millbrook — workshop' },
    { id: 'f_quarry', poi: 'quarry',    x:  748, z:  508, label: 'Quarry — fuel shed' },
  ];

  const TRUCK = { x: 8, z: 132 };

  // ---------------------------------------------------------------- height
  function distToSeg(x, z, a, b) {
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const l2 = dx * dx + dz * dz || 1e-6;
    let t = ((x - a[0]) * dx + (z - a[1]) * dz) / l2;
    t = clamp(t, 0, 1);
    const px = a[0] + dx * t - x, pz = a[1] + dz * t - z;
    return Math.hypot(px, pz);
  }
  function polyDist(x, z, lines) {
    let best = 1e9;
    for (const line of lines)
      for (let i = 0; i < line.length - 1; i++) {
        const d = distToSeg(x, z, line[i], line[i + 1]);
        if (d < best) best = d;
      }
    return best;
  }
  const roadDist = (x, z) => polyDist(x, z, ROADS);
  const pathDist = (x, z) => polyDist(x, z, PATHS);

  function rawHeight(x, z, seed) {
    const d = Math.hypot(x, z) / HALF;
    let h = fbm(x * 0.0013, z * 0.0013, seed, 5) * 54 - 15;
    h += fbm(x * 0.0062, z * 0.0062, seed + 11, 3) * 9 - 4.5;
    const ring = smoothstep(0.46, 1.0, d);
    h += ring * (34 + ridged(x * 0.0021, z * 0.0021, seed + 77, 5) * 310 * ring);
    h *= 1 - 0.32 * smoothstep(0.45, 0.02, d);
    const ld = Math.hypot(x - LAKE.x, z - LAKE.z);
    h = lerp(h, -19, smoothstep(LAKE.r, LAKE.r * 0.42, ld));
    return h;
  }

  const _base = new Map();
  function poiBase(p, seed) {
    const k = p.id + '#' + seed;
    if (!_base.has(k)) _base.set(k, rawHeight(p.x, p.z, seed));
    return _base.get(k);
  }

  function heightAt(x, z, seed) {
    let h = rawHeight(x, z, seed);
    for (const p of POIS) {
      const d = Math.hypot(x - p.x, z - p.z);
      if (d > p.r * 1.9) continue;
      h = lerp(h, poiBase(p, seed), smoothstep(p.r * 1.9, p.r * 0.85, d) * p.flat);
    }
    return h;
  }

  function normalAt(x, z, seed, e = 1.6) {
    const hl = heightAt(x - e, z, seed), hr = heightAt(x + e, z, seed);
    const hd = heightAt(x, z - e, seed), hu = heightAt(x, z + e, seed);
    const nx = hl - hr, ny = 2 * e, nz = hd - hu;
    const l = Math.hypot(nx, ny, nz) || 1;
    return { x: nx / l, y: ny / l, z: nz / l };
  }
  function slopeAt(x, z, seed) { return 1 - normalAt(x, z, seed).y; }

  function groundAt(x, z, seed, h) {
    if (h === undefined) h = heightAt(x, z, seed);
    if (h < WATER + 0.5) return 'water';
    if (pathDist(x, z) < 5.5) return 'sand';
    if (roadDist(x, z) < 7.5) return 'asphalt';
    if (h > 215) return 'snow';
    if (slopeAt(x, z, seed) > 0.30) return 'rock';
    return 'grass';
  }

  // How loudly the ground reports your weight.
  const MUFFLE = { sand: 0.18, grass: 0.70, asphalt: 1.00, rock: 1.00, snow: 0.55, water: 1.35 };
  function muffleAt(x, z, seed) { return MUFFLE[groundAt(x, z, seed)] ?? 1; }

  function isWalkable(x, z, seed) {
    if (Math.abs(x) > HALF - 24 || Math.abs(z) > HALF - 24) return false;
    const h = heightAt(x, z, seed);
    return h > WATER - 2.5 && slopeAt(x, z, seed) < 0.46;
  }

  function spawnPoint(seed, i) {
    const a = (i * 2.399963) + hash(i, 7, seed) * 0.6;
    const rad = 26 + (i % 4) * 7;
    const x = TRUCK.x + Math.cos(a) * rad, z = TRUCK.z + Math.sin(a) * rad;
    return { x, z, y: heightAt(x, z, seed) };
  }

  function seedFromString(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0) % 1000000;
  }

  return {
    SIZE, HALF, WATER, POIS, LAKE, ROADS, PATHS, FUEL_SPOTS, TRUCK, MUFFLE,
    clamp, lerp, smoothstep, hash, vnoise, fbm, ridged,
    rawHeight, heightAt, normalAt, slopeAt, groundAt, muffleAt,
    roadDist, pathDist, polyDist, distToSeg, isWalkable, spawnPoint, seedFromString,
  };
});
