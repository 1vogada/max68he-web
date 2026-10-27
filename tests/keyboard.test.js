// Keyboard API against a fake transport that emulates the hall columns.
const test = require('node:test');
const assert = require('node:assert');
const P = require('../src/protocol');
const { Keyboard } = require('../src/keyboard');

// Holds raw column values per sub-op; answers 0xE5 pages, records 0x65 writes.
// keys: slot -> base-layer value (keymap pages of 16 slots); the profile is 0.
function fakeTransport(columns, keys = {}) {
  const written = [];
  return {
    written,
    async query(pkt) { return [pkt[0], 0, 0, 0, 0, 0, 0, 0]; },
    async queryPage(pkt) {
      if (pkt[0] === P.OP.GET_KEYMAP) {
        const out = new Array(64).fill(0);
        for (const [slot, v] of Object.entries(keys)) {
          if (Math.floor(slot / 16) === pkt[3] && pkt[4] === 0) v.forEach((b, i) => { out[(slot % 16) * 4 + i] = b; });
        }
        return out;
      }
      const [, subop, , page] = pkt;
      const vals = columns[subop];
      const out = new Array(64).fill(0);
      if (P.WIDE.has(subop)) {
        for (let i = 0; i < 32; i++) { const v = vals[page * 32 + i] ?? 0; out[i * 2] = v & 0xff; out[i * 2 + 1] = v >> 8; }
      } else {
        for (let i = 0; i < 64; i++) out[i] = vals[page * 64 + i] ?? 0;
      }
      return out;
    },
    async flash(packets) { written.push(...packets); },
    close() {},
  };
}

// Rebuilds the column values a bulk write sent for one sub-op.
function bulkValues(packets, subop) {
  const bytes = packets.filter((p) => p[1] === subop).sort((a, b) => a[3] - b[3]).flatMap((p) => p.slice(8));
  return P.WIDE.has(subop)
    ? Array.from({ length: 128 }, (_, s) => bytes[s * 2] | (bytes[s * 2 + 1] << 8))
    : bytes.slice(0, 128);
}

function board() {
  const cols = {};
  for (const sub of [0, 1, 2, 3, 6]) cols[sub] = new Array(128).fill(0);
  cols[7] = new Array(128).fill(0);
  cols[0][8] = 446; cols[1][8] = 446; cols[2][8] = 40; cols[3][8] = 40; cols[6][8] = 60; cols[7][8] = 0x80; // Q
  cols[0][14] = 446; cols[1][14] = 446; cols[2][14] = 40; cols[3][14] = 40; cols[7][14] = 0x80 | 3; // W: mod-tap kind
  const t = fakeTransport(cols, { 8: [0, 0, 0x14, 0], 14: [0, 0, 0x1a, 0] });
  const kb = new Keyboard(t);
  kb.info = { unitMm: 0.005 };
  return { kb, t, cols };
}

// Answers the first `times` reads of one hall column with an empty page, as during a save.
function emptyReads(t, subop, times) {
  const real = t.queryPage;
  t.queryPage = async (pkt) => (pkt[0] === P.OP.GET_HALL && pkt[1] === subop && times-- > 0 ? new Array(64).fill(0) : real(pkt));
}

test('bulk write leaves untouched slots at their exact raw values', async () => {
  const { kb, t } = board();
  await kb.setAllSwitches({ actuation: 0.5 }, [8]);
  const act = bulkValues(t.written, P.HALL.ACTUATION);
  assert.strictEqual(act[8], 100);
  assert.strictEqual(act[0], 0, 'empty slot must not be clamped up to 0.1 mm');
  assert.strictEqual(act[14], 446);
  assert.deepStrictEqual(bulkValues(t.written, P.HALL.RELEASE).slice(0, 9), [0, 0, 0, 0, 0, 0, 0, 0, 446]);
});

test('bulk write keeps advanced key kinds and commits once', async () => {
  const { kb, t } = board();
  await kb.setAllSwitches({ rapidTrigger: false });
  const mode = bulkValues(t.written, P.HALL.MODE);
  assert.strictEqual(mode[8], 0);
  assert.strictEqual(mode[14], 3, 'mod-tap kind kept, RT bit cleared');
  assert.strictEqual(t.written.filter((p) => p[4] === 1).length, 1);
  assert.strictEqual(t.written.at(-1)[4], 1, 'commit flag on the final packet');
});

test('single-key write changes only the requested field', async () => {
  const { kb, t } = board();
  await kb.setSwitch(8, { actuation: 1.2 });
  const bySub = Object.fromEntries(t.written.map((p) => [p[1], p[8] | (P.WIDE.has(p[1]) ? p[9] << 8 : 0)]));
  assert.deepStrictEqual(bySub, { 0: 240, 1: 446, 2: 40, 3: 40, 6: 60, 7: 0x80 });
  assert.ok(t.written.every((p) => p[3] === 8));
});

test('showPicture switches the lighting to mode 13 with the picture as option', async () => {
  let led = [0x87, 1, 2, 3, 0x07, 10, 20, 30];   // static, brightness 3
  const sent = [];
  const kb = new Keyboard({
    async query() { return led; },
    async writeSetting(pkt) { sent.push(pkt); led = [0x87, ...pkt.slice(1, 8)]; },
  });
  kb.info = { custom: false };
  const now = await kb.showPicture(2);
  assert.strictEqual(sent.length, 1);
  assert.deepStrictEqual([now.mode, now.option, now.brightness], [13, 2, 3]);
  await assert.rejects(kb.showPicture(7), /picture 0..4/);
});

test('user and Fn layer writes refuse an out-of-range macro or text index before any I/O', async () => {
  const kb = new Keyboard({ async query() { throw new Error('no I/O expected'); } });
  kb.info = { custom: true };
  await assert.rejects(kb.setLayerKey(1, 8, [9, 0, 16, 0]), /macro index is 0..15/);
  await assert.rejects(kb.setFnLayerKey(2, 8, [11, 0, 64, 0]), /text slot is 0..63/);
});

test('switch write: an empty page read is read again before anything is written', async () => {
  const { kb, t } = board();
  emptyReads(t, P.HALL.ACTUATION, 2);   // the first read's pages 0-1 (Q and W) come back empty
  await kb.setAllSwitches({ rapidTrigger: true });
  assert.strictEqual(bulkValues(t.written, P.HALL.ACTUATION)[8], 446, 'written back from the good read');
});

test('switch write is refused when the read stays wrong, and nothing is written', async () => {
  const { kb, t, cols } = board();
  emptyReads(t, P.HALL.RELEASE, 100);
  await assert.rejects(kb.setSwitch(8, { actuation: 1 }), /read back wrong twice \(slot 8 release 0 mm\); nothing written/);
  cols[1][8] = 2000;   // 10 mm: not something the board holds
  t.queryPage = fakeTransport(cols, { 8: [0, 0, 0x14, 0] }).queryPage;
  await assert.rejects(kb.setAllSwitches({ actuation: 1 }), /slot 8 release 10 mm/);
  cols[1][8] = 446;
  t.queryPage = fakeTransport(cols, {}).queryPage;   // empty keymap: the read is not trusted either
  await assert.rejects(kb.setAllSwitches({ actuation: 1 }), /no keys in the keymap/);
  assert.deepStrictEqual(t.written, []);
});
