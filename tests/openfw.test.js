// Open-firmware-only switch and macro features against a fake transport.
const test = require('node:test');
const assert = require('node:assert');
const P = require('../src/protocol');
const { Keyboard } = require('../src/keyboard');

// Hall columns from `cols`, macro pages from `macros` (open-firmware GET mapping); records writes.
function fakeBoard(custom) {
  const cols = {};
  for (const sub of [0, 1, 2, 3, 4, 6]) cols[sub] = new Array(128).fill(100);
  for (const sub of [5, 7, 9]) cols[sub] = new Array(128).fill(0);
  cols[7][9] = 0x80 | 0x40 | P.KIND.snap; // continuous RT + snap
  const macros = Array.from({ length: 16 }, (_, n) => [1, 0, 0x04 + n, 0x81, 0x04 + n, 0x01]);
  const writes = [];
  const t = {
    async queryPage(pkt) {
      const out = new Array(64).fill(0);
      if (pkt[0] === 0xe5) {
        const [, sub, , page] = pkt;
        const vals = cols[sub];
        if (P.WIDE.has(sub)) for (let i = 0; i < 32; i++) { const v = vals[page * 32 + i]; out[i * 2] = v & 0xff; out[i * 2 + 1] = v >> 8; }
        else for (let i = 0; i < 64; i++) out[i] = vals[page * 64 + i];
      } else if (pkt[0] === 0x8a && pkt[3] === 0 && pkt[4] === 0) {   // keys on slots 9 and 10
        out[9 * 4 + 2] = 0x04; out[10 * 4 + 2] = 0x05;
      } else if (pkt[0] === 0x8b) {
        const [, idx, page] = pkt;
        const m = idx < 8 ? idx * 2 : (idx - 8) * 2 + 1;
        if (page === 0) macros[m].forEach((b, i) => { out[i] = b; });
      }
      return out;
    },
    async query() { return [0, 0, 0, 0, 0, 0, 0, 0]; },
    async writeSetting(pkt) { writes.push(pkt); },
    async flash(pkts) { writes.push(...pkts); },
    close() {},
  };
  const kb = new Keyboard(t);
  kb.info = { unitMm: 0.005, custom };
  return { kb, writes };
}

const modeWrites = (writes) => writes.filter((p) => p[0] === 0x65 && p[1] === P.HALL.MODE).map((p) => [p[3], p[8]]);

test('getSwitches reports continuous RT and the kind without bit 6', async () => {
  const { kb } = fakeBoard(true);
  const s = (await kb.getSwitches())[9];
  assert.strictEqual(s.rapidTrigger, true);
  assert.strictEqual(s.continuousRt, true);
  assert.strictEqual(s.kind, P.KIND.snap);
});

test('setSwitch writes continuous RT on the open firmware, keeping the kind', async () => {
  const { kb, writes } = fakeBoard(true);
  await kb.setSwitch(10, { rapidTrigger: true, continuousRt: true });
  assert.deepStrictEqual(modeWrites(writes), [[10, 0xc0]]);
});

test('continuous RT is never sent to stock firmware', async () => {
  const { kb, writes } = fakeBoard(false);
  await kb.setSwitch(10, { rapidTrigger: true, continuousRt: true });
  assert.deepStrictEqual(modeWrites(writes), [[10, 0x80]]);
});

test('advanced keys keep both RT bits when the kind changes', async () => {
  const { kb, writes } = fakeBoard(true);
  await kb.clearAdvanced(9);
  assert.deepStrictEqual(modeWrites(writes).pop(), [9, 0xc0]);
});

test('odd macros read back on the open firmware, not on stock', async () => {
  const open = fakeBoard(true).kb;
  assert.deepStrictEqual((await open.getMacro(5)).steps[0], { usage: 0x09, down: true, delayMs: 1 });
  assert.deepStrictEqual((await open.getMacro(4)).steps[0].usage, 0x08);
  assert.strictEqual(await fakeBoard(false).kb.getMacro(5), null);
});

test('scan timing packets and stats parse', () => {
  const p = P.scanTunePacket({ settleUs: 8, adcDiv: 2, sample: 3, background: true, resetMax: true });
  assert.deepEqual([...p.slice(0, 7)], [0xfe, 7, 8, 2, 3, 1, 1]);
  assert.throws(() => P.scanTunePacket({ settleUs: 300 }));
  const r = new Array(64).fill(0);
  r[8] = 0x10; r[9] = 0x27;                    // 10000 frames
  r[16] = 0xa0; r[17] = 0x86; r[18] = 0x01;    // 100000 ns = 100 us
  r[28] = 250;                                 // 2.5 frames per pass
  r[32] = 20; r[33] = 6; r[34] = 3; r[35] = 1;
  const s = P.parseScanStats(r);
  assert.equal(s.frames, 10000);
  assert.equal(s.passAvgUs, 100);
  assert.equal(s.framesPerPass, 2.5);
  assert.equal(s.adcMHz, 27);
  assert.equal(s.sampleCycles, 28.5);
  assert.equal(s.background, true);
});

test('pressure effects only offered on host API 3+', () => {
  const v2 = P.openModesFor({ api: 2, features: ['fxEffects'] });
  const v3 = P.openModesFor({ api: 3, features: ['fxEffects'] });
  assert.ok(v2[0x4b] && !v2[0x4c] && !v2[0x59]);
  assert.equal(v3[0x4c], 'Trampoline');
  assert.equal(v3[0x59], 'Pressure paint');
  assert.deepEqual(Object.keys(P.openModesFor(null)).map(Number), [0x40, 0x42]);
  assert.doesNotThrow(() => P.ledPacket({ mode: 0x56, speed: 2, brightness: 4 }));
});
