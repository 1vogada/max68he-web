// Advanced keys and options against a fake transport.
const test = require('node:test');
const assert = require('node:assert');
const P = require('../src/protocol');
const { Keyboard } = require('../src/keyboard');

// Answers hall column GETs from `cols`, keymap GETs from `layers`; records writes.
function fakeBoard() {
  const cols = {};
  for (const sub of [0, 1, 2, 3, 4, 6]) cols[sub] = new Array(128).fill(100);
  for (const sub of [5, 7, 9]) cols[sub] = new Array(128).fill(0);
  cols[9].fill(0xff);
  cols[7][9] = 0x80; // A: rapid trigger on
  const layers = [0, 1, 2, 3].map(() => Array.from({ length: 128 }, () => [0, 0, 0, 0]));
  layers[0][9] = [0, 0, 0x04, 0];
  const writes = [];
  const t = {
    async queryPage(pkt) {
      const out = new Array(64).fill(0);
      if (pkt[0] === 0x8a) {
        const [, , , page, sub] = pkt;
        layers[sub].slice(page * 16, page * 16 + 16).flat().forEach((b, i) => { out[i] = b; });
      } else if (pkt[0] === 0xe5) {
        const [, sub, , page] = pkt;
        if (sub === 10) return out; // DKS actions: none
        const vals = cols[sub];
        if (P.WIDE.has(sub)) for (let i = 0; i < 32; i++) { const v = vals[page * 32 + i]; out[i * 2] = v & 0xff; out[i * 2 + 1] = v >> 8; }
        else for (let i = 0; i < 64; i++) out[i] = vals[page * 64 + i];
      }
      return out;
    },
    async query(pkt) { return pkt[0] === 0x84 ? [0x84, 0] : [pkt[0], 0, 0, 1, 2, 1, 0, 0]; },
    async writeSetting(pkt) {
      writes.push(pkt);
      if (pkt[0] === 0x0a) layers[pkt[6]][pkt[2]] = pkt.slice(8, 12);
    },
    async flash(pkts) { writes.push(...pkts); },
    close() {},
  };
  const kb = new Keyboard(t);
  kb.info = { unitMm: 0.005 };
  return { kb, writes, layers };
}

const hall = (writes) => writes.filter((p) => p[0] === 0x65).map((p) => [p[1], p[3], p[8], p[4]]);

test('snap tap: both keys kind 7 (keeping RT), partners cross-linked, one commit', async () => {
  const { kb, writes } = fakeBoard();
  await kb.setSnap(9, 21);
  // [subop, slot, value, commit]
  assert.deepStrictEqual(hall(writes), [[7, 9, 0x87, 0], [7, 21, 7, 0], [9, 9, 21, 0], [9, 21, 9, 1]]);
});

test('mod-tap: hold on sub-layer 0, tap on 1, time in 10 ms units', async () => {
  const { kb, writes, layers } = fakeBoard();
  await kb.setModTap(9, [0, 0, 0xe0, 0], [0, 0, 0x04, 0], 250);
  assert.deepStrictEqual(layers[0][9], [0, 0, 0xe0, 0]);
  assert.deepStrictEqual(layers[1][9], [0, 0, 0x04, 0]);
  assert.deepStrictEqual(hall(writes), [[5, 9, 25, 0], [7, 9, 0x83, 1]]);
});

test('DKS: four cells packed low-first, points written, kind last', async () => {
  const { kb, writes } = fakeBoard();
  await kb.setDks(9, {
    firstPointMm: 0.5,
    secondPointMm: 2.0,
    bindings: [{ key: [0, 0, 4, 0], cells: [3, 2, 0, 0] }, { key: [0, 0, 5, 0], cells: [0, 1, 0, 0] }],
  });
  const dks = writes.find((p) => p[0] === 0x65 && p[1] === 8);
  assert.deepStrictEqual(dks.slice(8, 12), [3 | (2 << 2), 1 << 2, 0, 0]);
  assert.deepStrictEqual(hall(writes).map((h) => h[0]), [4, 0, 8, 7]);
  await assert.rejects(kb.setDks(9, { firstPointMm: 2, secondPointMm: 1, bindings: [{ key: [0, 0, 4, 0], cells: [1, 0, 0, 0] }] }));
});

test('options round-trip keeps fnIndex and validates RT stability', async () => {
  assert.deepStrictEqual(P.parseOptions([0x89, 0, 0, 1, 2, 1]), { os: 'win', fnIndex: 0, antiMistouch: true, rtStability: 50, wasdSwap: true });
  assert.deepStrictEqual(P.optionsPacket({ fnIndex: 0, antiMistouch: true, rtStability: 50, wasdSwap: false }).slice(0, 6), [0x09, 0, 0, 1, 2, 0]);
  assert.throws(() => P.optionsPacket({ fnIndex: 0, antiMistouch: false, rtStability: 30, wasdSwap: false }));
});
