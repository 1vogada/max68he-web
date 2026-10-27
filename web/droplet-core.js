// Droplet effect maths, a line-for-line port of firmware common/droplet.c so the
// browser preview matches what the keyboard renders. Usable in the page and in Node tests.
(function (root) {
  const DRAIN_MS = 180;
  const EDGE_LO = 0.25;
  const EDGE_HI = 0.9;
  const WHITE_MAX = 0.7;
  const MIN_LEVEL = 0.01;
  const HOT_FROM = 0.8;

  const smoothstep = (a, b, x) => {
    const t = (x - a) / (b - a);
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return t * t * (3 - 2 * t);
  };

  function createState(n) {
    return { level: new Float32Array(n), lastMs: 0, started: false };
  }

  // depth[i] 0..1, pos[i] = { col, row } in key units, base = [r, g, b], bright 0..4.
  // Returns an array of [r, g, b] per LED.
  function render(s, depth, pos, base, bright, tMs) {
    const n = depth.length;
    let dt = s.started ? tMs - s.lastMs : 0;
    if (dt > 100) dt = 100;
    s.lastMs = tMs;
    s.started = true;
    const drain = 1 / (1 + dt / DRAIN_MS);
    for (let i = 0; i < n; i++) {
      const d = Math.min(Math.max(depth[i], 0), 1);
      const held = s.level[i] * drain;
      s.level[i] = d > held ? d : held;
      if (s.level[i] < MIN_LEVEL) s.level[i] = 0;
    }
    const c = base[0] | base[1] | base[2] ? base : [0x00, 0x8c, 0xff];
    const scale = (Math.min(bright, 4) + 1) / 5;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      let f = 0;
      for (let j = 0; j < n; j++) {
        const l = s.level[j];
        if (l <= 0) continue;
        const r = 0.6 + 1.4 * l;
        const dx = pos[i].col - pos[j].col;
        const dy = pos[i].row - pos[j].row;
        f += (l * r * r) / (dx * dx + dy * dy + r * r);
      }
      const inten = smoothstep(EDGE_LO, EDGE_HI, f) * scale;
      const hot = f > HOT_FROM ? Math.min(f - HOT_FROM, 1) * WHITE_MAX : 0;
      out[i] = c.map((ch) => {
        let v = ch * inten;
        v += (255 * inten - v) * hot;
        return Math.max(0, Math.min(255, Math.floor(v)));
      });
    }
    return out;
  }

  const api = { createState, render };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DropletCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
