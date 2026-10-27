// The web preview's effect code (web/fx-core.js, web/pfx-core.js) against frames
// rendered by the firmware's C code (x68max-firmware: make PROFILE=2755 golden).
// Same press script as firmware/common/test/gen_fx_golden.c.
const test = require('node:test');
const assert = require('node:assert');
const G = require('./fixtures/fx-golden.json');
const F = require('../web/fx-core');
const PF = require('../web/pfx-core');

const FRAMES = 120;
const TOL = 3;                 // per channel: float32 (board) vs double (JS) rounding

function script(f) {
  const n = G.n, k = G.keys;
  const depth = new Array(n).fill(0), vdown = new Array(n).fill(0), act = new Array(n).fill(0.4);
  if (f >= 5 && f < 40) { depth[k[0]] = Math.min((f - 5) / 20, 1); if (f === 5) vdown[k[0]] = 3; }
  if (f >= 20 && f < 80) { depth[k[1]] = 0.7; if (f === 20) vdown[k[1]] = 8; }
  if (f >= 45 && f < 50) { depth[k[2]] = 1; if (f === 45) vdown[k[2]] = 30; }
  if (f >= 60 && f < 110) { depth[k[3]] = (((f * 7) % 10) / 10) * 0.8 + 0.2; if (f === 60) vdown[k[3]] = 8; }
  if (f >= 85 && f < 100) { depth[k[4]] = 1; if (f === 85) vdown[k[4]] = 30; }
  const on = depth.map((d, i) => (Math.fround(d) >= Math.fround(act[i]) ? 1 : 0));
  const gauge = new Array(n).fill(0); gauge[k[0]] = gauge[k[1]] = 1;
  return { depth, vdown, vup: new Array(n).fill(0), act, on, gauge };
}

for (const run of G.runs) {
  const name = `mode 0x${run.mode.toString(16)} flag ${run.flag}${run.rgb[0] ? ' coloured' : ''}`;
  test(`preview matches firmware: ${name}`, () => {
    const p = { mode: run.mode, speed: 2, brightness: 4, direction: 0, flag: run.flag, r: run.rgb[0], g: run.rgb[1], b: run.rgb[2] };
    const geo = { col: G.col, row: G.row, maxCol: G.maxCol, maxRow: G.maxRow };
    const fs = F.fxCreate(G.n), ps = PF.create();
    const out = Array.from({ length: G.n }, () => [0, 0, 0]);
    let cp = 0, worst = 0, bad = 0;
    for (let f = 0; f < FRAMES; f++) {
      const t = 1000 + f * 16, s = script(f);
      if (PF.handles(p.mode)) PF.render(ps, p, s, G.col, G.row, G.n, t, out);
      else if (F.fxHandles(p.mode)) F.fxRender(fs, p, s.depth, G.col, G.row, G.n, t, out);
      else F.ledEffects(p, t, G.n, geo, out);
      if (f !== G.checkpoints[cp]) continue;
      const ref = Buffer.from(run.frames[cp++], 'base64');
      out.flat().forEach((v, i) => {
        const d = Math.abs(v - ref[i]);
        if (d > worst) worst = d;
        if (d > TOL) bad++;
      });
    }
    assert.equal(cp, 6);
    assert.equal(bad, 0, `${bad} channel values off by more than ${TOL} (worst ${worst})`);
  });
}
