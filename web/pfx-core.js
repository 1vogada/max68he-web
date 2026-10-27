// Port of the open firmware's pressure effects (pfx.c, pfx2.c), line for line, for
// the Effects preview. Checked against frames from the C code in tests/fx-port.test.js.
(function (root) {
  const F = typeof module !== 'undefined' && module.exports ? require('./fx-core') : root.FxCore;
  const { DAZZLE, clamp01, u8, hueRgb, rnd, rndf, put } = F;
  const BRI = [40, 90, 140, 195, 255], SPD = [0.35, 0.6, 1.0, 1.6, 2.5];
  const GW = 16, GH = 8, SPARKS = 40, RINGS = 12, BLOBS = 8, BOLT_PTS = 48;
  const PRESS = 0.25, RELEASE = 0.15;
  const handles = (m) => m >= 0x4c && m <= 0x59;
  const grid = (f) => Array.from({ length: GH }, () => Array.from({ length: GW }, f));

  function create() {
    return { mode: -1, started: 0, lastMs: 0, rng: 0, n: 0 };
  }
  function reset(s, n, tMs, mode) {
    const rng = s.rng;
    const z = () => new Array(n).fill(0);
    Object.assign(s, {
      mode, started: 1, lastMs: tMs, rng: (rng ^ ((0xa5a5f00d + tMs) >>> 0)) >>> 0, n,
      down: z(), bottom: z(), wasOn: z(), hue: z(), glow: z(), glow2: z(), charge: z(), ice: new Array(n).fill(1),
      paint: Array.from({ length: n }, () => [0, 0, 0]),
      u: grid(() => 0), v: grid(() => 0), dye: grid(() => [0, 0, 0]),
      spark: Array.from({ length: SPARKS }, () => ({ x: 0, y: 0, vx: 0, vy: 0, life: 0, hue: 0 })),
      ring: Array.from({ length: RINGS }, () => ({ x: 0, y: 0, strength: 0, t0: 0, hue: 0, on: 0, white: 0 })),
      blob: Array.from({ length: BLOBS }, () => ({ x: 0, y: 0, r: 0, heat: 0, vy: 0, seed: 0, on: 0 })),
      bolt: [], boltI: [], boltN: 0, boltT: 0, level: 0,
    });
  }

  function colour(p, h, def) {
    if (p.flag === DAZZLE) return hueRgb(h);
    if (!(p.r | p.g | p.b)) return def.slice();
    return [p.r / 255, p.g / 255, p.b / 255];
  }
  const dist2 = (c, i, x, y) => { const dx = c.col[i] - x, dy = c.row[i] - y; return dx * dx + dy * dy; };
  const vnorm = (v) => clamp01((v - 2) / 38);
  const cell = (c, i) => [c.col[i] < GW ? c.col[i] : GW - 1, c.row[i] < GH ? c.row[i] : GH - 1];
  const addOut = (out, c, acc) => { for (let i = 0; i < c.n; i++) put(out[i], acc[i][0], acc[i][1], acc[i][2], c.bri); };
  const zeroAcc = (n) => Array.from({ length: n }, () => [0, 0, 0]);

  function spawnRing(s, x, y, strength, t0, hue, white) {
    let k, oldest = 0;
    for (k = 0; k < RINGS; k++) {
      if (!s.ring[k].on) break;
      if (s.ring[k].t0 < s.ring[oldest].t0) oldest = k;
    }
    if (k === RINGS) k = oldest;
    Object.assign(s.ring[k], { x, y, strength, t0, hue, on: 1, white });
  }

  function rings(s, c, acc) {
    for (const r of s.ring) {
      if (!r.on) continue;
      const age = ((c.tMs - r.t0) >>> 0) / 1000;
      const vel = (5 + 14 * r.strength) * (0.6 + 0.4 * c.spd), reach = 1.5 + 15 * r.strength, rad = age * vel;
      if (rad > reach + 1) { r.on = 0; continue; }
      const fade = (1 - rad / (reach + 1)) * (0.35 + 0.65 * r.strength);
      const rgb = r.white ? [1, 0.95, 0.85] : colour(c.p, r.hue, [1, 0.55, 0.2]);
      for (let i = 0; i < c.n; i++) {
        const d = Math.abs(Math.sqrt(dist2(c, i, r.x, r.y)) - rad);
        if (d >= 1) continue;
        const v = (1 - d) * fade;
        acc[i][0] += rgb[0] * v; acc[i][1] += rgb[1] * v; acc[i][2] += rgb[2] * v;
      }
    }
  }

  // ---- pfx.c ----------------------------------------------------------------
  function trampoline(s, c, out) {
    const k2 = 36 * (0.5 + 0.5 * c.spd), h = c.dt / 3;
    const pin = grid(() => 0), tgt = grid(() => 0);
    for (let i = 0; i < c.n; i++) {
      if (c.depth[i] < 0.04) continue;
      const [x, y] = cell(c, i);
      pin[y][x] = 1; tgt[y][x] = -c.depth[i];
    }
    for (let step = 0; step < 3; step++) {
      const a = grid(() => 0);
      for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
        const u = s.u[y][x];
        const l = x ? s.u[y][x - 1] : u, r = x + 1 < GW ? s.u[y][x + 1] : u;
        const t = y ? s.u[y - 1][x] : u, b = y + 1 < GH ? s.u[y + 1][x] : u;
        a[y][x] = k2 * (l + r + t + b - 4 * u) - 2.2 * s.v[y][x] - 1.5 * u;
      }
      for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
        if (pin[y][x]) {
          const nu = s.u[y][x] + (tgt[y][x] - s.u[y][x]) * 0.5;
          s.v[y][x] = (nu - s.u[y][x]) / h;
          s.u[y][x] = nu;
        } else {
          s.v[y][x] += a[y][x] * h;
          s.u[y][x] += s.v[y][x] * h;
        }
        if (s.u[y][x] > 1.5) s.u[y][x] = 1.5;
        if (s.u[y][x] < -1.5) s.u[y][x] = -1.5;
      }
    }
    for (let i = 0; i < c.n; i++) {
      const [x, y] = cell(c, i), u = s.u[y][x], hb = u8(150 + c.t * 6);
      const dn = colour(c.p, hb, [0.15, 0.45, 1]);
      const up = c.p.flag !== DAZZLE ? [1, 0.9, 0.75] : hueRgb((hb + 110) & 255);
      const col = u < 0 ? dn : up;
      put(out[i], col[0], col[1], col[2], c.bri * (0.06 + clamp01(Math.abs(u) * 1.4)));
    }
  }

  function dye(s, c, out) {
    for (let i = 0; i < c.n; i++) {
      if (c.edge[i]) s.hue[i] = u8(c.col[i] * 15 + c.row[i] * 45 + c.t * 8);
      if (c.depth[i] < 0.04) continue;
      const [x, y] = cell(c, i);
      let rgb = colour(c.p, s.hue[i], hueRgb(s.hue[i]));
      if (c.p.flag !== DAZZLE && !(c.p.r | c.p.g | c.p.b)) rgb = hueRgb(s.hue[i]);
      const k = c.depth[i] * c.dt * 5;
      for (let ch = 0; ch < 3; ch++) s.dye[y][x][ch] = Math.min(s.dye[y][x][ch] + rgb[ch] * k, 1.6);
    }
    let kd = c.dt * 2.5 * c.spd;
    if (kd > 0.22) kd = 0.22;
    const nd = grid(() => [0, 0, 0]);
    for (let y = 0; y < GH; y++) {
      let sx = 1.2 * Math.sin(c.t * 0.4 + y * 1.3) * c.spd * c.dt;
      sx = Math.max(-0.9, Math.min(0.9, sx));
      for (let x = 0; x < GW; x++) for (let ch = 0; ch < 3; ch++) {
        const d = s.dye[y][x][ch];
        const l = x ? s.dye[y][x - 1][ch] : d, r = x + 1 < GW ? s.dye[y][x + 1][ch] : d;
        const t = y ? s.dye[y - 1][x][ch] : d, b = y + 1 < GH ? s.dye[y + 1][x][ch] : d;
        const src = sx > 0 ? l : r, fs = Math.abs(sx);
        nd[y][x][ch] = (d + kd * (l + r + t + b - 4 * d) + fs * (src - d)) * Math.exp(-c.dt * 0.22 * c.spd);
      }
    }
    s.dye = nd;
    for (let i = 0; i < c.n; i++) { const [x, y] = cell(c, i); put(out[i], s.dye[y][x][0], s.dye[y][x][1], s.dye[y][x][2], c.bri); }
  }

  function frost(s, c, out) {
    for (let j = 0; j < c.n; j++) s.ice[j] = clamp01(s.ice[j] + c.dt * 0.07 * c.spd);
    for (let i = 0; i < c.n; i++) {
      const d = c.depth[i];
      if (d < 0.04) continue;
      const r = 0.6 + d * 3.2;
      for (let j = 0; j < c.n; j++) {
        const q = Math.sqrt(dist2(c, j, c.col[i], c.row[i]));
        if (q < r) s.ice[j] = clamp01(s.ice[j] - c.dt * 7 * d * (1 - q / r));
      }
    }
    for (let i = 0; i < c.n; i++) {
      const tw = 0.7 + 0.3 * Math.sin(c.t * (2 + (i % 7) * 0.4) + i * 1.7);
      const melt = colour(c.p, u8(c.t * 12 + c.col[i] * 10), [1, 0.4, 0.08]);
      const ice = s.ice[i], m = 1 - ice;
      put(out[i], ice * 0.55 * tw + m * melt[0], ice * 0.8 * tw + m * melt[1], ice * tw + m * melt[2], c.bri * (0.35 + 0.65 * (ice * 0.6 + m)));
    }
  }

  function lavaSpawn(s, x, y, heat) {
    for (const b of s.blob) if (!b.on) { Object.assign(b, { x, y, r: 0.9 + 0.5 * rndf(s), heat, vy: 0, seed: rndf(s) * 6.28, on: 1 }); return; }
  }
  function lava(s, c, out) {
    let bottom = 1;
    for (let i = 0; i < c.n; i++) if (c.row[i] > bottom) bottom = c.row[i];
    if (s.blob.filter((b) => b.on).length < 2) lavaSpawn(s, 2 + rndf(s) * 11, bottom + 0.8, 0.75);
    for (let i = 0; i < c.n; i++) {
      const d = c.depth[i];
      if (d < 0.04) continue;
      let best = 99, bk = -1;
      s.blob.forEach((b, k) => { if (!b.on) return; const dx = b.x - c.col[i], dy = b.y - c.row[i], q = dx * dx + dy * dy; if (q < best) { best = q; bk = k; } });
      if (bk >= 0 && best < 2.5) s.blob[bk].heat = clamp01(s.blob[bk].heat + d * c.dt * 2);
      else if (c.edge[i]) lavaSpawn(s, c.col[i], c.row[i], 0.5 + 0.5 * d);
    }
    for (const b of s.blob) {
      if (!b.on) continue;
      b.vy += -(b.heat - 0.45) * 3 * c.dt * c.spd;
      b.vy *= Math.exp(-c.dt * 1.6);
      b.y += b.vy * c.dt;
      b.x += Math.sin(c.t * 0.7 + b.seed) * 0.35 * c.dt * c.spd;
      b.heat -= c.dt * (b.y < 1.2 ? 0.35 : 0.08) * c.spd;
      if (b.heat < 0) b.heat = 0;
      if (b.y > bottom + 1.5 || b.y < -2) b.on = 0;
    }
    for (let i = 0; i < c.n; i++) {
      let f = 0, hs = 0;
      for (const b of s.blob) { if (!b.on) continue; const w = (b.r * b.r) / (dist2(c, i, b.x, b.y) + 0.15); f += w; hs += w * b.heat; }
      const heat = f > 0 ? hs / f : 0, v = clamp01((f - 0.45) / 0.8);
      let r = 0.12 + v * 0.88, g = v * (0.15 + 0.65 * heat * v), b = 0.16 * (1 - v);
      if (c.p.flag === DAZZLE) { const hc = hueRgb(u8(c.t * 5 + heat * 60)); r = 0.1 + v * hc[0]; g = v * hc[1]; b = 0.12 * (1 - v) + v * hc[2]; }
      put(out[i], r, g, b, c.bri);
    }
  }

  function gravity(c, out) {
    for (let i = 0; i < c.n; i++) {
      let x = c.col[i], y = c.row[i], well = 0;
      for (let k = 0; k < c.n; k++) {
        const d = c.depth[k];
        if (d < 0.04) continue;
        const dx = c.col[k] - x, dy = c.row[k] - y, q = dx * dx + dy * dy;
        const pull = (d * 2.2) / (1 + q * 0.35), ang = (d * 2.5) / (1 + q * 0.25), ca = Math.cos(ang), sa = Math.sin(ang);
        const rx = -dx * ca + dy * sa, ry = -dx * sa - dy * ca, keep = 1 - clamp01(pull * 0.4);
        x = c.col[k] + rx * keep; y = c.row[k] + ry * keep;
        well += d / (1 + q * 0.5);
      }
      const rgb = hueRgb(Math.floor(c.t * 25 * c.spd + x * 11 + y * 23) & 255);   // pfx_hue8: wraps
      put(out[i], rgb[0] + well * 0.5, rgb[1] + well * 0.5, rgb[2] + well * 0.5, c.bri * (0.45 + 0.55 * clamp01(well)));
    }
  }

  function squeeze(s, c, out) {
    let tot = 0, cx = 0, cy = 0;
    for (let i = 0; i < c.n; i++) { tot += c.depth[i]; cx += c.depth[i] * c.col[i]; cy += c.depth[i] * c.row[i]; }
    if (tot > 0) { cx /= tot; cy /= tot; }
    s.level += (clamp01(tot / 3) - s.level) * (1 - Math.exp(-c.dt * 8));
    const L = s.level;
    let rgb = colour(c.p, u8(170 - 170 * L), [0.2, 0.4, 1]);
    if (c.p.flag !== DAZZLE && !(c.p.r | c.p.g | c.p.b)) rgb = hueRgb(u8(170 - 170 * L));
    const wh = clamp01((L - 0.8) * 5);
    rgb = rgb.map((k) => k + (1 - k) * wh);
    for (let i = 0; i < c.n; i++) {
      const near = tot > 0 ? 1 - 0.35 * clamp01(Math.sqrt(dist2(c, i, cx, cy)) / 10) : 1;
      put(out[i], rgb[0], rgb[1], rgb[2], c.bri * ((0.04 + 0.96 * L) * near + c.depth[i] * 0.5));
    }
  }

  function spotlight(s, c, out) {
    const acc = zeroAcc(c.n);
    for (let i = 0; i < c.n; i++) {
      const d = c.depth[i];
      if (c.edge[i]) s.hue[i] = rnd(s) & 255;
      if (d < 0.03) continue;
      const R = 0.8 + 3.4 * d, rgb = colour(c.p, s.hue[i], [1, 0.72, 0.38]);
      for (let j = 0; j < c.n; j++) {
        const q = dist2(c, j, c.col[i], c.row[i]) / (R * R);
        if (q >= 1) continue;
        const f = (1 - q) * (1 - q) * (0.4 + 0.6 * d);
        for (let k = 0; k < 3; k++) acc[j][k] += rgb[k] * f;
      }
    }
    for (let j = 0; j < c.n; j++) {
      let m = Math.max(acc[j][0], acc[j][1], acc[j][2]);
      if (m > 1) for (let k = 0; k < 3; k++) acc[j][k] /= m;
      const lvl = m > 1 ? 1 : m;
      if (lvl >= s.glow[j]) { s.glow[j] = lvl; s.paint[j] = acc[j].slice(); }
      else { const k = Math.exp(-c.dt * 2.2 * c.spd); s.glow[j] *= k; s.paint[j] = s.paint[j].map((x) => x * k); }
      put(out[j], s.paint[j][0], s.paint[j][1], s.paint[j][2], c.bri * (0.93 + 0.07 * Math.sin(c.t * 13 + j * 2.1)));
    }
  }

  // ---- pfx2.c ---------------------------------------------------------------
  function charge(s, c, out) {
    const acc = zeroAcc(c.n);
    for (let i = 0; i < c.n; i++) {
      if (c.edge[i]) s.hue[i] = rnd(s) & 255;
      if (c.depth[i] > 0.15) s.charge[i] = clamp01(s.charge[i] + c.dt * c.depth[i] * 0.7 * c.spd);
      else if (s.charge[i] > 0.04) { spawnRing(s, c.col[i], c.row[i], s.charge[i], c.tMs, s.hue[i], 0); s.charge[i] = 0; }
      else s.charge[i] = 0;
      const q = s.charge[i];
      if (q > 0) {
        const rgb = colour(c.p, s.hue[i], [0.2, 0.55, 1]), full = q >= 1 ? 0.8 + 0.2 * Math.sin(c.t * 40) : 1;
        for (let k = 0; k < 3; k++) acc[i][k] += (rgb[k] + (1 - rgb[k]) * q * q) * (0.25 + 0.75 * q) * full;
      }
    }
    rings(s, c, acc);
    addOut(out, c, acc);
  }

  function impact(s, c, out) {
    const acc = zeroAcc(c.n);
    for (let i = 0; i < c.n; i++) {
      if (c.edge[i]) s.glow2[i] = 0;
      if (c.vdown[i] > s.glow2[i]) s.glow2[i] = c.vdown[i];
      const b = s.bottom[i] ? c.depth[i] > 0.7 : c.depth[i] >= 0.85;
      if (b && !s.bottom[i]) {
        const hit = vnorm(s.glow2[i]);
        if (hit > 0.05) { spawnRing(s, c.col[i], c.row[i], hit, c.tMs, rnd(s) & 255, 1); s.glow[i] = 0.5 + 0.5 * hit; }
      }
      s.bottom[i] = b ? 1 : 0;
      s.glow[i] *= Math.exp(-c.dt * 6);
      const rgb = colour(c.p, (c.col[i] * 12) & 255, [1, 0.35, 0.1]), soft = c.depth[i] * 0.3;
      for (let k = 0; k < 3; k++) acc[i][k] += rgb[k] * soft + s.glow[i];
    }
    rings(s, c, acc);
    addOut(out, c, acc);
  }

  function sparks(s, c, out) {
    const acc = zeroAcc(c.n);
    for (let i = 0; i < c.n; i++) {
      const rgb = colour(c.p, u8(c.t * 20 + c.col[i] * 9), [1, 0.5, 0.12]);
      for (let k = 0; k < 3; k++) acc[i][k] += rgb[k] * c.depth[i] * 0.35;
      if (!c.edge[i]) continue;
      const v = vnorm(c.vdown[i]), count = Math.floor(v * 9);
      for (let m = 0; m < count; m++) {
        const k = s.spark.findIndex((p) => !(p.life > 0));
        if (k < 0) break;
        const a = rndf(s) * 6.2832, sp = (2.5 + 11 * v) * (0.5 + 0.5 * rndf(s));
        Object.assign(s.spark[k], { x: c.col[i], y: c.row[i], vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 3 * v, life: 0.35 + 0.55 * rndf(s), hue: rnd(s) & 255 });
      }
    }
    for (const p of s.spark) {
      if (p.life <= 0) continue;
      p.vy += 9 * c.dt; p.x += p.vx * c.dt; p.y += p.vy * c.dt;
      p.vx *= Math.exp(-c.dt * 0.8);
      p.life -= c.dt * c.spd;
      if (p.life <= 0) continue;
      const hot = clamp01(p.life * 2);
      const rgb = c.p.flag === DAZZLE ? hueRgb(p.hue) : [1, 0.45 + 0.5 * hot, 0.15 + 0.6 * hot * hot];
      for (let i = 0; i < c.n; i++) {
        const q = dist2(c, i, p.x, p.y);
        if (q >= 1) continue;
        const w = (1 - Math.sqrt(q)) * clamp01(p.life * 2.5);
        for (let ch = 0; ch < 3; ch++) acc[i][ch] += rgb[ch] * w;
      }
    }
    addOut(out, c, acc);
  }

  function segDist2(px, py, a, b) {
    const vx = b[0] - a[0], vy = b[1] - a[1], wx = px - a[0], wy = py - a[1], l = vx * vx + vy * vy;
    const t = clamp01(l > 0 ? (wx * vx + wy * vy) / l : 0), dx = wx - t * vx, dy = wy - t * vy;
    return dx * dx + dy * dy;
  }
  function lightning(s, c, out) {
    const key = [];
    for (let i = 0; i < c.n; i++) {
      if (c.depth[i] < PRESS) continue;
      if (key.length < 6) key.push(i);
      else {
        let w = 0;
        for (let k = 1; k < 6; k++) if (c.depth[key[k]] < c.depth[key[w]]) w = k;
        if (c.depth[i] > c.depth[key[w]]) key[w] = i;
      }
    }
    for (let a = 1; a < key.length; a++) for (let b = a; b > 0 && c.col[key[b]] < c.col[key[b - 1]]; b--) [key[b], key[b - 1]] = [key[b - 1], key[b]];
    const nk = key.length;
    if (((c.tMs - s.boltT) >>> 0) >= Math.trunc(70 / c.spd) || s.boltN === 0) {
      s.boltT = c.tMs; s.boltN = 0; s.bolt = []; s.boltI = [];
      for (let k = 0; k + 1 < nk; k++) {
        const ax = c.col[key[k]], ay = c.row[key[k]], dx = c.col[key[k + 1]] - ax, dy = c.row[key[k + 1]] - ay, len = Math.sqrt(dx * dx + dy * dy);
        const steps = Math.trunc(len * 1.5) + 2;
        if (s.boltN + steps + 1 > BOLT_PTS) break;
        for (let m = 0; m <= steps; m++) {
          const t = m / steps, j = m === 0 || m === steps ? 0 : (rndf(s) - 0.5) * 1.4;
          s.bolt[s.boltN] = [ax + dx * t - (dy / (len + 0.01)) * j, ay + dy * t + (dx / (len + 0.01)) * j];
          s.boltI[s.boltN] = m === 0 ? -1 : 1;
          s.boltN++;
        }
      }
    }
    const flick = 0.6 + 0.4 * rndf(s), rgb = colour(c.p, u8(160 + c.t * 30), [0.55, 0.65, 1]);
    const arcI = [0, 0, 0, 0, 0, 0];
    for (let k = 0; k + 1 < nk; k++) arcI[k] = Math.min(c.depth[key[k]], c.depth[key[k + 1]]);
    for (let i = 0; i < c.n; i++) {
      let best = 0, arc = 0;
      for (let m = 0; m < s.boltN; m++) {
        if (s.boltI[m] < 0) { if (m) arc++; continue; }
        const d2 = segDist2(c.col[i], c.row[i], s.bolt[m - 1], s.bolt[m]);
        if (d2 < 0.6) { const v = (1 - Math.sqrt(d2 / 0.6)) * (0.4 + 0.6 * arcI[Math.min(arc, 5)]); if (v > best) best = v; }
      }
      const glow = c.depth[i] * 0.6;
      if (nk === 1 && c.depth[i] < 0.05 && dist2(c, i, c.col[key[0]], c.row[key[0]]) < 2.5 && rndf(s) < 0.25 * c.depth[key[0]]) best = 0.7;
      const v = best * flick;
      put(out[i], rgb[0] * v + glow + v * 0.3, rgb[1] * v + glow + v * 0.3, rgb[2] * v + glow, c.bri);
    }
  }

  function trainer(s, c, out) {
    for (let i = 0; i < c.n; i++) {
      const act = c.act[i] > 0.02 ? c.act[i] : 0.02, rel = clamp01(c.depth[i] / act);
      if (c.on[i] && !s.wasOn[i]) s.glow[i] = 1;
      if (!c.on[i] && s.wasOn[i] && c.depth[i] > 0.08) s.glow2[i] = 1;
      s.wasOn[i] = c.on[i] ? 1 : 0;
      s.glow[i] *= Math.exp(-c.dt * 9); s.glow2[i] *= Math.exp(-c.dt * 7);
      let r, g, b;
      if (c.on[i]) { r = 0.05; g = 1; b = 0.15; }
      else { const w = clamp01((rel - 0.6) / 0.4), v = 0.08 + 0.92 * rel * rel; r = w * v; g = (0.25 + 0.6 * w) * v; b = (1 - w) * v; }
      put(out[i], r + s.glow[i] + s.glow2[i], g + s.glow[i] + s.glow2[i] * 0.5, b + s.glow[i], c.bri);
    }
  }

  function gauge(c, out) {
    for (let i = 0; i < c.n; i++) {
      if (!c.gauge[i]) { out[i][0] = out[i][1] = out[i][2] = 0; continue; }
      const d = c.depth[i];
      if (d < 0.02) { put(out[i], 1, 1, 1, c.bri * 0.1); continue; }
      const rgb = hueRgb(u8(85 * (1 - d)));
      put(out[i], rgb[0], rgb[1], rgb[2], c.bri * (0.15 + 0.85 * Math.pow(d, 0.7)));
    }
  }

  function paint(s, c, out) {
    for (let i = 0; i < c.n; i++) {
      if (c.edge[i]) { s.hue[i] = u8(160 * (1 - vnorm(c.vdown[i]))); s.glow2[i] = 0; }
      if (c.vdown[i] > s.glow2[i] && s.down[i]) {
        s.glow2[i] = c.vdown[i];
        const h = u8(160 * (1 - vnorm(c.vdown[i])));
        if (h < s.hue[i]) s.hue[i] = h;
      }
    }
    const fade = Math.exp(-c.dt * 0.09 * c.spd);
    for (const p of s.paint) for (let k = 0; k < 3; k++) p[k] *= fade;
    for (let i = 0; i < c.n; i++) {
      const d = c.depth[i];
      if (d < 0.04) continue;
      const R = 0.5 + 2.6 * d;
      let rgb = colour(c.p, s.hue[i], hueRgb(s.hue[i]));
      if (c.p.flag === DAZZLE) rgb = hueRgb(s.hue[i]);
      for (let j = 0; j < c.n; j++) {
        const q = Math.sqrt(dist2(c, j, c.col[i], c.row[i]));
        if (q >= R) continue;
        const a = clamp01(c.dt * 5 * d * (1 - q / R));
        for (let k = 0; k < 3; k++) s.paint[j][k] += (rgb[k] - s.paint[j][k]) * a;
      }
    }
    for (let j = 0; j < c.n; j++) { const hi = c.depth[j] * 0.3; put(out[j], s.paint[j][0] + hi, s.paint[j][1] + hi, s.paint[j][2] + hi, c.bri); }
  }

  // in = { depth, vdown, vup, act, on, gauge } arrays (any may be missing)
  function render(s, p, input, col, row, n, tMs, out) {
    if (!s.started || s.mode !== p.mode || s.n !== n) reset(s, n, tMs, p.mode);
    let dt = ((tMs - s.lastMs) >>> 0) / 1000;
    if (dt > 0.1) dt = 0.1;
    s.lastMs = tMs;
    const get = (k, i, def) => (input && input[k] ? input[k][i] : def);
    const c = { p, col, row, n, tMs, t: (tMs % 3600000) / 1000, dt, bri: BRI[Math.min(p.brightness, 4)] / 255, spd: SPD[Math.min(p.speed, 4)],
      depth: [], vdown: [], vup: [], act: [], on: [], gauge: [], edge: [] };
    for (let i = 0; i < n; i++) {
      c.depth[i] = clamp01(get('depth', i, 0)); c.vdown[i] = get('vdown', i, 0); c.vup[i] = get('vup', i, 0);
      c.act[i] = get('act', i, 0.5); c.on[i] = get('on', i, 0) ? 1 : 0; c.gauge[i] = get('gauge', i, 0) ? 1 : 0;
      const now = s.down[i] ? c.depth[i] > RELEASE : c.depth[i] >= PRESS;
      c.edge[i] = now && !s.down[i];
      s.down[i] = now ? 1 : 0;
    }
    const fn = { 0x4c: trampoline, 0x4d: dye, 0x4e: frost, 0x4f: lava, 0x50: charge, 0x51: impact, 0x52: sparks, 0x53: lightning,
      0x55: squeeze, 0x56: trainer, 0x58: spotlight, 0x59: paint }[p.mode];
    if (fn) fn(s, c, out);
    else if (p.mode === 0x54) gravity(c, out);
    else if (p.mode === 0x57) gauge(c, out);
    else for (let i = 0; i < n; i++) out[i][0] = out[i][1] = out[i][2] = 0;
  }

  const api = { handles, create, render };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PfxCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
