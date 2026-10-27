// Port of the open firmware's lighting code, line for line, so the Effects preview
// draws what the keyboard draws: led_effects.c (stock-numbered modes) and fx.c
// (Neon, Ripple, Reactive .. Splash). pfx-core.js has the pressure effects.
// Checked against frames from the C code in tests/fx-port.test.js. Usable in the
// page and in Node tests.
(function (root) {
  const DAZZLE = 8;
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  // C (uint8_t)(float): truncate, wrap to 0..255 (the board's ARM cores clamp negatives to 0)
  const u8 = (x) => (x <= 0 || !Number.isFinite(x) ? 0 : Math.trunc(x) & 255);

  function hsv(h, s, v) {                          // led_hsv2rgb, integer maths
    h &= 255;
    const region = Math.floor(h / 43), rem = ((h - region * 43) * 6) & 255;
    const p = Math.floor((v * (255 - s)) / 255);
    const q = Math.floor((v * (255 - Math.floor((s * rem) / 255))) / 255);
    const t = Math.floor((v * (255 - Math.floor((s * (255 - rem)) / 255))) / 255);
    switch (region) {
      case 0: return [v, t, p];
      case 1: return [q, v, p];
      case 2: return [p, v, t];
      case 3: return [p, q, v];
      case 4: return [t, p, v];
      default: return [v, p, q];
    }
  }
  const scale8 = (c, b) => Math.floor((c * b + 128) / 255);
  const hueRgb = (h) => hsv(h, 255, 255).map((x) => x / 255);

  // xorshift32 on state.rng, as the firmware
  function rnd(s) {
    let x = s.rng >>> 0 || 0x9e3779b9;
    x = (x ^ (x << 13)) >>> 0; x = (x ^ (x >>> 17)) >>> 0; x = (x ^ (x << 5)) >>> 0;
    return (s.rng = x);
  }
  const rndf = (s) => (rnd(s) >>> 8) / 16777216;

  function put(o, r, g, b, v) {
    o[0] = Math.floor(clamp01(r * v) * 255 + 0.5);
    o[1] = Math.floor(clamp01(g * v) * 255 + 0.5);
    o[2] = Math.floor(clamp01(b * v) * 255 + 0.5);
  }

  // ---- led_effects.c --------------------------------------------------------
  const K_BRIGHT = [40, 90, 140, 195, 255];
  const K_SPEED_Q8 = [8, 16, 32, 64, 128];
  const phase8 = (tMs, speed) => Math.floor(((tMs * K_SPEED_Q8[Math.min(speed, 4)]) >>> 0) / 256) & 255;
  const triangle8 = (ph) => (ph < 128 ? ph * 2 : (255 - ph) * 2);

  // p = { mode, speed, brightness, direction, flag, r, g, b }; col/row/maxCol/maxRow = LED geometry
  function ledEffects(p, tMs, n, geo, out) {
    const bri = K_BRIGHT[Math.min(p.brightness, 4)];
    const fill = (rgb) => { for (let i = 0; i < n; i++) { out[i][0] = rgb[0]; out[i][1] = rgb[1]; out[i][2] = rgb[2]; } };
    switch (p.mode) {
      case 0: return fill([0, 0, 0]);
      case 2: {
        const ph = phase8(tMs, p.speed), v = scale8(bri, triangle8(ph));
        return fill(p.flag === DAZZLE ? hsv(ph, 255, v) : [scale8(p.r, v), scale8(p.g, v), scale8(p.b, v)]);
      }
      case 4: {
        const ph = phase8(tMs, p.speed);
        for (let i = 0; i < n; i++) {
          const pos = p.direction & 2 ? Math.floor((geo.row[i] * 255) / geo.maxRow) & 255 : Math.floor((geo.col[i] * 255) / geo.maxCol) & 255;
          const hue = p.direction & 1 ? (ph - pos) & 255 : (ph + pos) & 255;
          const c = hsv(hue, 255, bri);
          out[i][0] = c[0]; out[i][1] = c[1]; out[i][2] = c[2];
        }
        return;
      }
      case 16: return fill(hsv(phase8(tMs, p.speed), 255, bri));
      case 0x40:
        for (let i = 0; i < n; i++) {
          const h = Math.imul(i, 2654435761) >>> 0;
          const start = h >>> 24, rate = 3 + ((h >>> 8) & 3);
          const c = hsv((start + phase8(Math.floor((tMs * rate) / 4), p.speed)) & 255, 255, bri);
          out[i][0] = c[0]; out[i][1] = c[1]; out[i][2] = c[2];
        }
        return;
      default: return fill([scale8(p.r, bri), scale8(p.g, bri), scale8(p.b, bri)]);   // static (and not-yet-drawn modes)
    }
  }

  // ---- fx.c ---------------------------------------------------------------
  const FX_BRI = [40, 90, 140, 195, 255];
  const FX_SPD = [0.35, 0.6, 1.0, 1.6, 2.5];
  const FX_MAX_RIPPLES = 10, FX_MAX_COLS = 24, FX_PRESS_LEVEL = 0.35;
  const FX_MODES = [3, 5, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x4b];
  const fxHandles = (m) => FX_MODES.includes(m);

  function fxCreate(n) {
    return { glow: new Array(n).fill(0), heat: new Array(n).fill(0), hue: new Array(n).fill(0), down: new Array(n).fill(0),
      rip: Array.from({ length: FX_MAX_RIPPLES }, () => ({ x: 0, y: 0, t0: 0, hue: 0, on: 0 })),
      drop: new Array(FX_MAX_COLS).fill(0), dropV: new Array(FX_MAX_COLS).fill(0), rng: 0, lastMs: 0, started: 0 };
  }

  function colour(p, h) {
    if (p.flag !== DAZZLE) {
      if (!(p.r | p.g | p.b)) return [1, 1, 1];
      return [p.r / 255, p.g / 255, p.b / 255];
    }
    return hueRgb(h);
  }
  const heatRgb = (v) => hueRgb(u8(170 * (1 - clamp01(v))));

  function spawnRipple(s, x, y, t, hue) {
    let k, oldest = 0;
    for (k = 0; k < FX_MAX_RIPPLES; k++) {
      if (!s.rip[k].on) break;
      if (s.rip[k].t0 < s.rip[oldest].t0) oldest = k;
    }
    if (k === FX_MAX_RIPPLES) k = oldest;
    Object.assign(s.rip[k], { x, y, t0: t, hue, on: 1 });
  }

  function fxRender(s, p, depth, col, row, n, tMs, out) {
    const bri = FX_BRI[Math.min(p.brightness, 4)] / 255, spd = FX_SPD[Math.min(p.speed, 4)];
    if (!s.started) { s.started = 1; s.lastMs = tMs; s.rng = (s.rng ^ ((0xa5a5f00d + tMs) >>> 0)) >>> 0; }
    let dt = ((tMs - s.lastMs) >>> 0) / 1000;
    if (dt > 0.25) dt = 0.25;
    s.lastMs = tMs;
    const t = (tMs % 3600000) / 1000;
    const edge = new Array(n);
    for (let i = 0; i < n; i++) {
      const d = depth ? depth[i] : 0;
      const now = s.down[i] ? d > FX_PRESS_LEVEL * 0.6 : d >= FX_PRESS_LEVEL;
      edge[i] = now && !s.down[i];
      s.down[i] = now ? 1 : 0;
    }
    switch (p.mode) {
      case 3:
        for (let i = 0; i < n; i++) {
          const h = u8(t * 20 * spd + row[i] * 10);
          const c = hueRgb(h);                     // neon always drifts
          put(out[i], c[0], c[1], c[2], bri * (0.75 + 0.25 * Math.sin(t * 1.7 * spd + col[i] * 0.25)));
        }
        return;
      case 0x43:
        for (let i = 0; i < n; i++) {
          if (edge[i]) { s.glow[i] = 1; s.hue[i] = rnd(s) & 255; }
          if (s.down[i]) s.glow[i] = 1;
          else s.glow[i] *= Math.exp(-dt * 3 * spd);
          const c = colour(p, s.hue[i]);
          put(out[i], c[0], c[1], c[2], bri * s.glow[i]);
        }
        return;
      case 5: case 0x44: case 0x4b: {
        const splash = p.mode === 0x4b;
        for (let i = 0; i < n; i++) if (edge[i]) spawnRipple(s, col[i], row[i], tMs, rnd(s) & 255);
        const vel = 9 * spd, life = (16 / vel + 0.3) * (splash ? 1.6 : 1);
        for (let i = 0; i < n; i++) {
          let ar = 0, ag = 0, ab = 0;
          for (const r of s.rip) {
            if (!r.on) continue;
            const age = ((tMs - r.t0) >>> 0) / 1000;
            if (age > life) { r.on = 0; continue; }
            const dx = col[i] - r.x, dy = (row[i] - r.y) * 1.1;
            const dist = Math.sqrt(dx * dx + dy * dy), rad = age * vel;
            const fade = 1 - (age / life) * (age / life);
            const ring = Math.exp(-(dist - rad) * (dist - rad) * 1.2) * fade;
            if (ring <= 0.01) continue;
            const c = colour(p, splash ? u8(r.hue + dist * 18) : r.hue);
            ar += c[0] * ring; ag += c[1] * ring; ab += c[2] * ring;
          }
          if (s.down[i]) { const c = colour(p, 0); ar += c[0]; ag += c[1]; ab += c[2]; }
          put(out[i], ar, ag, ab, bri);
        }
        return;
      }
      case 0x45: {
        let mx = 1;
        for (let i = 0; i < n; i++) {
          if (edge[i]) s.heat[i] += 1;
          s.heat[i] *= Math.exp(-dt * 0.03 * spd);
          if (s.heat[i] > mx) mx = s.heat[i];
        }
        for (let i = 0; i < n; i++) {
          if (s.heat[i] < 0.05) { put(out[i], 0, 0, 0.15, bri); continue; }
          const c = heatRgb(s.heat[i] / mx);
          put(out[i], c[0], c[1], c[2], bri);
        }
        return;
      }
      case 0x46:
        for (let i = 0; i < n; i++) {
          const d = depth ? clamp01(depth[i]) : 0;
          if (d < 0.02) { put(out[i], 0.05, 0.05, 0.08, bri); continue; }
          const c = p.flag === DAZZLE || !(p.r | p.g | p.b) ? hueRgb(u8(85 * (1 - d))) : colour(p, 0);
          put(out[i], c[0], c[1], c[2], bri * (0.25 + 0.75 * d));
        }
        return;
      case 0x47:
        for (let i = 0; i < n; i++) {
          if (s.glow[i] < 0.02 && rndf(s) < dt * 0.35 * spd) { s.glow[i] = 1; s.hue[i] = rnd(s) & 255; }
          s.glow[i] *= Math.exp(-dt * 1.8 * spd);
          if (edge[i]) { s.glow[i] = 1; s.hue[i] = rnd(s) & 255; }
          const c = colour(p, s.hue[i]), tw = s.glow[i] * s.glow[i];
          put(out[i], c[0], c[1], c[2], bri * (0.04 + 0.96 * tw));
        }
        return;
      case 0x48: {
        let maxc = 0, maxr = 0;
        for (let i = 0; i < n; i++) { if (col[i] > maxc) maxc = col[i]; if (row[i] > maxr) maxr = row[i]; }
        if (maxc >= FX_MAX_COLS) maxc = FX_MAX_COLS - 1;
        for (let c = 0; c <= maxc; c++) {
          if (s.dropV[c] <= 0) { s.drop[c] = -rndf(s) * 6; s.dropV[c] = 3 + rndf(s) * 4; }
          s.drop[c] += dt * s.dropV[c] * spd;
          if (s.drop[c] > maxr + 4) { s.drop[c] = -rndf(s) * 5; s.dropV[c] = 3 + rndf(s) * 4; }
        }
        for (let i = 0; i < n; i++) {
          const c = col[i] < FX_MAX_COLS ? col[i] : FX_MAX_COLS - 1;
          const behind = s.drop[c] - row[i];
          let v = behind < -0.5 ? 0 : behind < 0.5 ? 1 : Math.exp(-behind * 1.1);
          let rgb = p.flag === DAZZLE || !(p.r | p.g | p.b) ? [0.1, 1, 0.25] : colour(p, 0);
          if (behind >= -0.5 && behind < 0.5) rgb = rgb.map((x) => x * 0.5 + 0.5);
          if (s.down[i]) v = 1;
          put(out[i], rgb[0], rgb[1], rgb[2], bri * v);
        }
        return;
      }
      case 0x49: {
        let maxr = 0;
        for (let i = 0; i < n; i++) if (row[i] > maxr) maxr = row[i];
        for (let i = 0; i < n; i++) {
          const base = 1 - (maxr - row[i]) * 0.22;
          const flick = 0.6 + 0.4 * Math.sin(t * 7 * spd + col[i] * 1.3 + rndf(s) * 1.5);
          const target = clamp01(base * flick + (s.down[i] ? 0.6 : 0));
          s.heat[i] += (target - s.heat[i]) * clamp01(dt * 8);
          const h = s.heat[i];
          put(out[i], 1, clamp01(h * h * 1.3), clamp01((h - 0.75) * 2), bri * clamp01(h * 1.4));
        }
        return;
      }
      case 0x4a:
        for (let i = 0; i < n; i++) {
          const x = col[i], y = row[i];
          const v = Math.sin(x * 0.45 + t * 0.8 * spd) + Math.sin(y * 0.9 - t * 0.6 * spd) + Math.sin((x + y) * 0.3 + t * 0.5 * spd);
          const c = hueRgb(u8(100 + v * 28));
          const lvl = s.down[i] ? 1 : 0.55 + 0.45 * Math.sin(v * 1.3 + t * spd);
          put(out[i], c[0], c[1], c[2], bri * lvl);
        }
        return;
      default:
        for (let i = 0; i < n; i++) out[i][0] = out[i][1] = out[i][2] = 0;
    }
  }

  const api = { DAZZLE, clamp01, u8, hsv, hueRgb, rnd, rndf, put, ledEffects, fxHandles, fxCreate, fxRender };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FxCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
