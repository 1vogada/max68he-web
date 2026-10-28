// Key action engine 6 (caps 'kaPool'): parts, condition banks, 12-byte conditions for modes 4..32, INFO v6,
// mode flash in the mode record, the memory bar's key map pool.
const test = require('node:test');
const assert = require('node:assert');
const P = require('../src/protocol');
const M = require('../src/key-modes');
const { parseSpec, splitParts, toRecords, mergeParts, fromRecord } = require('../src/key-actions');
const MemBar = require('../web/mem-bar');

test('records: part and bank bytes, a rule names entry bank * 15 + nibble', () => {
  const rec = P.encodeKaRecord({ slot: 40, part: 2, bank: 1, rules: [{ trigger: 5, mode: 1, tval: 0, output: 1, a: 0, b: 0x1b, cond: 20 }] });
  assert.deepStrictEqual(rec.slice(0, 9), [40, 1, 0, 0, 0, 0, 2, 1, 5 | (5 << 4)]);
  const d = P.decodeKaRecord(rec);
  assert.strictEqual(d.part, 2);
  assert.strictEqual(d.bank, 1);
  assert.strictEqual(d.rules[0].cond, 20);
  assert.throws(() => P.encodeKaRecord({ slot: 1, bank: 1, rules: [{ trigger: 5, mode: 1, tval: 0, output: 1, a: 0, b: 4, cond: 3 }] }), /not in bank 1/);
  assert.deepStrictEqual(Object.keys(P.decodeKaRecord(P.encodeKaRecord({ slot: 1 }))).sort(), ['flags', 'gap', 'press', 'rules', 'slot']);
});

test('INFO v6: sizes, active modes u32, pool', () => {
  const r = new Array(64).fill(0);
  Object.assign(r, { 8: 105, 9: 6, 10: 3, 11: 56, 12: 6, 13: 105, 14: 32, 15: 0x40, 16: 0x40, 18: 0x01, 20: 105, 22: 3, 24: 105, 26: 15, 27: 255,
    28: 0x90, 29: 0x64, 32: 0x10, 33: 0x03, 36: 0xf8, 37: 0x1e });
  const i = P.parseKaInfo(r);
  assert.strictEqual(i.engine, 6);
  assert.strictEqual(i.entries, 105);
  assert.strictEqual(i.modes, 32);
  assert.strictEqual(i.activeModes, 0x10040);
  assert.deepStrictEqual(i.pool, { bytes: 0x6490, used: 0x310 });
  assert.strictEqual(i.imageBytes, 0x1ef8);
  assert.strictEqual(P.parseKaInfo(Object.assign(new Array(64).fill(0), { 8: 16, 12: 5, 13: 15, 14: 3 })).entries, 16);
});

test('conditions: 4 bytes for modes 1..3, 12 for modes 4..32; packets in the shortest form', () => {
  assert.deepStrictEqual(M.condEntry({ keys: [65], on: [1], off: [3] }), [65, 0xff, 0xff, 0x41]);
  const e = M.condEntry({ keys: [], on: [7], off: [32] });
  assert.deepStrictEqual(e, [0xff, 0xff, 0xff, 0, 0x40, 0, 0, 0, 0, 0, 0, 0x80]);
  assert.deepStrictEqual(M.needOf(e), { keys: [], on: [7], off: [32] });
  assert.ok(M.sameEntry(P.wideCond([65, 0xff, 0xff, 0x41]), [65, 0xff, 0xff, 0x41]));
  assert.ok(M.isFree(P.wideCond(P.KA_COND_FREE)));
  assert.strictEqual(M.entryProblem(e), null);
  const small = P.kaCondSetPacket(1, [65, 0xff, 0xff, 0x41]);
  assert.deepStrictEqual([...small.slice(8, 20)], [65, 0xff, 0xff, 0x41, 0, 0, 0, 0, 0, 0, 0, 0]);
  const big = P.kaCondSetPacket(200, e);
  assert.deepStrictEqual([...big.slice(0, 3), ...big.slice(8, 20)], [0xee, 5, 200, 0xff, 0xff, 0xff, 0, 0x40, 0, 0, 0, 0, 0, 0, 0x80]);
  const got = P.parseKaCond(Object.assign(new Array(64).fill(0), { 3: 200, 8: 0xff, 9: 0xff, 10: 0xff, 12: 0x40, 19: 0x80 }));
  assert.deepStrictEqual(got.entry, e);
  assert.ok(M.usesHighModes({ rules: [{ trigger: 5, output: M.OUT.MODE, a: 7 }] }));
  assert.ok(!M.usesHighModes({ rules: [{ trigger: 5, output: M.OUT.MODE, a: 3 }] }));
});

test('parts: more than 6 rule slots split into records, a mouse keys rule stays with its ARG', () => {
  const rules = Array.from({ length: 9 }, (_, i) => ({ when: 'press', do: { key: String.fromCharCode(65 + i) } }));
  assert.throws(() => parseSpec({ slot: 40, rules }), /at most 6 rules per key/);
  const wire = parseSpec({ slot: 40, rules }, { ...M.LOOSE, parts: true });
  assert.deepStrictEqual(splitParts(wire.rules).map((p) => p.length), [6, 3]);
  const mk = [{ trigger: 5 }, { trigger: 5 }, { trigger: 5 }, { trigger: 5 }, { trigger: 5, output: 9 }, { trigger: 15 }, { trigger: 15 }, { trigger: 5 }];
  assert.deepStrictEqual(splitParts(mk).map((p) => p.length), [4, 4]);
  const recs = toRecords(wire, 40);
  assert.deepStrictEqual(recs.map((r) => [r[1], r[6]]), [[6, 0], [3, 1]]);
  const back = fromRecord(mergeParts([recs[1], recs[0]]), 'B');
  assert.strictEqual(back.rules.length, 9);
  assert.deepStrictEqual(back.rules.map((r) => r.do.key), rules.map((r) => r.do.key));
});

test('mode records: flash settings in [24..31], read back only when bit 7 is set', () => {
  const p = P.kaModeSetPacket(7, 'Seven', { enter: true, enterColor: [10, 20, 30], leave: false, leaveColor: [0, 0, 0] });
  assert.deepStrictEqual([...p.slice(0, 3)], [0xee, 7, 7]);
  assert.deepStrictEqual([...p.slice(24, 32)], [0x82, 10, 20, 30, 0, 0, 0, 0]);
  assert.deepStrictEqual([...P.kaModeSetPacket(32, 'x').slice(24, 32)], [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.throws(() => P.kaModeSetPacket(33, 'x'), /1..32/);
  const r = Object.assign(new Array(64).fill(0), { 3: 7, 8: 83, 24: 0x82, 25: 10, 26: 20, 27: 30 });
  assert.deepStrictEqual(P.parseKaMode(r).flash, { enter: true, enterColor: [10, 20, 30], leave: false, leaveColor: [0, 0, 0] });
  assert.strictEqual(P.parseKaMode(Object.assign(new Array(64).fill(0), { 3: 1 })).flash, null);
});

test('memory bar: a third bar for the key map pool (engine 6)', () => {
  const mem = { flashUsed: 119400, flashSize: 132608, ramStatic: 71000, ramReserved: 5120, ramSize: 104448, stackPeak: 700 };
  assert.strictEqual(MemBar.view(mem).bars.length, 2);
  const v = MemBar.view({ ...mem, kaPool: { bytes: 25600, used: 6400 } });
  assert.deepStrictEqual(v.bars.map((b) => b.text), ['Flash 90 %', 'RAM 73 %', 'Maps 25 %']);
  assert.match(v.tip, /Key maps: 6\.3 KB of the 25\.0 KB left for them/);
});
