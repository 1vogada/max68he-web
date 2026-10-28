// Key action engine 5: `if: { notHeld }` (a condition key byte with bit 7 set = that slot must NOT
// be held). Parse / bytes / refusals / summary, older engines refused before any write, Ivo's tilde
// mode (tests/fixtures/ka-tilde-mode.json) -> exactly tests/fixtures/ka-tilde-mode.hex (the firmware's
// test_katilde replays it), read back, backup round trip, kbcode and Blocks.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const K = require('../src/key-actions');
const M = require('../src/key-modes');
const { fakeKeyboard } = require('./fixtures/ka-fake');
const { MAX68HE_KEYS } = require('./fixtures/max68he-keys');
const { fixturePackets, toHex } = require('../scripts/ka-fixture');

const TILDE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'ka-tilde-mode.json'), 'utf8'));
const kb = (engine = 5) => fakeKeyboard({ engine, entries: 32, keys: MAX68HE_KEYS });
const writes = (f) => f.sent.filter((p) => p[0] === 0xee && [2, 5, 7].includes(p[1]));
const badIf = (c, re) => assert.throws(() => K.parseSpec({ key: 'W', rules: [{ when: 'press', if: c, do: { gamepad: 'A' } }] }),
  (e) => e.status === 400 && re.test(e.message), `${JSON.stringify(c)} -> ${re}`);

test('notHeld: entry bytes (held first, then not held | 0x80), refusals, read back', () => {
  const ctx = { slotOf: (k) => ({ Fn: 65, LCtrl: 5, LShift: 4 })[k], modeOf: (m) => (m === 'Tilde' ? 2 : m), self: 14 };
  const need = K.parseSpec({ key: 'W', rules: [{ when: 'press', if: { held: ['LCtrl'], notHeld: ['Fn', 'LShift'], mode: 'Tilde' }, do: { gamepad: 'A' } }] }, ctx).rules[0].need;
  assert.deepStrictEqual(need, { keys: [5], notKeys: [65, 4], on: [2], off: [] });
  assert.deepStrictEqual(M.condEntry(need), [5, 0xc1, 0x84, 2]);
  assert.deepStrictEqual(M.needOf([5, 0xc1, 0x84, 2]), need, 'read back');
  assert.deepStrictEqual(M.ifJson(M.needOf([0xc1, 0xff, 0xff, 2]), { keyName: (s) => (s === 65 ? 'Fn' : null), modeName: () => 'Tilde' }), { notHeld: ['Fn'], mode: 'Tilde' });
  assert.strictEqual(M.entryProblem([0xc1, 0xff, 0xff, 2]), null);
  assert.match(M.entryProblem([0x41, 0xc1, 0xff, 0]), /distinct/, 'a slot held and not held');
  assert.strictEqual(M.entryProblem([0xc1, 0xff, 0xff, 0]), null, 'not held alone is a condition');
  badIf({ notHeld: [] }, /notHeld is a list of 1..3 keys/);
  badIf({ notHeld: 'Fn' }, /notHeld is a list/);
  badIf({ notHeld: ['Fn', 'fn'] }, /notHeld names a key twice/);
  badIf({ held: ['Fn', 'LCtrl'], notHeld: ['LAlt', 'LShift'] }, /held and notHeld together name at most 3 keys/);
  badIf({ held: ['Fn'], notHeld: ['fn'] }, /both held and notHeld/);
  badIf({ notHeld: ['W'] }, /condition of its own rule/);
});

test('notHeld summary sentences combine with held and modes', () => {
  const s = (c) => M.summary({ rules: [{ when: 'press', if: c, do: { key: 'Esc' } }] })[0];
  assert.strictEqual(s({ mode: 'Tilde', notHeld: ['Fn'] }), 'In mode Tilde, while Fn is not held, press: Esc (until released)');
  assert.strictEqual(s({ notHeld: ['Fn'] }), 'While Fn is not held, press: Esc (until released)');
  assert.strictEqual(s({ held: ['LCtrl'], notHeld: ['Fn', 'LShift'] }), 'While Left Ctrl is held and Fn + Left Shift are not held, press: Esc (until released)');
});

test('engine 4 firmware: notHeld refused before anything is written; the fake refuses the bytes too', async () => {
  const f = kb(4);
  await assert.rejects(f.kb.setKeyActionsBatch(TILDE), (e) => e.status === 400 && /notHeld need a newer open firmware \(key action engine 5\)/.test(e.message));
  await assert.rejects(f.kb.setKeyActions({ key: 'Esc', rules: [{ when: 'press', if: { notHeld: ['Fn'] }, do: { key: 'A' } }] }), /key action engine 5/);
  assert.deepStrictEqual(writes(f), [], 'nothing written');
  await assert.rejects(f.kb._kaSetCond(1, [0xc1, 0xff, 0xff, 2]), /bad/);
});

test('engine 5: the tilde example writes the committed .hex, reads back, rewrites nothing new', async () => {
  const f = kb();
  const r = await f.kb.setKeyActionsBatch(TILDE);
  assert.strictEqual(toHex(await fixturePackets('ka-tilde-mode')), fs.readFileSync(path.join(__dirname, 'fixtures', 'ka-tilde-mode.hex'), 'utf8'),
    'regenerate: node scripts/ka-fixture.js');
  assert.deepStrictEqual(f.conds.slice(0, 4), [[65, 5, 0xff, 0], [0xff, 0xff, 0xff, 1], [0xc1, 0xff, 0xff, 2], [65, 0xff, 0xff, 2]]);
  const esc = r.maps.find((m) => m.key === 'Esc');
  assert.deepStrictEqual(esc.summary.slice(1, 3), ['In mode Tilde, while Fn is not held, quick tap (let go within 3.00 s): tap `',
    'In mode Tilde, while Fn is not held, hold 3.00 s: leave mode Tilde']);
  const back = await f.kb.getKeyActions('Esc');
  assert.deepStrictEqual(back.rules.map((x) => x.if), TILDE.maps[1].rules.map((x) => x.if));
  f.sent.length = 0;
  await f.kb.setKeyActionsBatch(TILDE);
  assert.deepStrictEqual(writes(f).filter((p) => p[1] !== 2), [], 'names and conditions already there');
});

test('backup / restore keeps notHeld conditions (raw records)', async () => {
  const KM = require('../src/key-map-backup');
  const a = kb();
  await a.kb.setKeyActionsBatch(TILDE);
  const t = JSON.parse(JSON.stringify(await KM.readTable(a.kb)));
  const b = kb();
  assert.deepStrictEqual(await KM.restoreMaps(b.kb, t), { restored: 2, problems: [] });
  assert.deepStrictEqual(b.conds, a.conds);
  assert.deepStrictEqual([...b.table].sort(), [...a.table].sort());
});

test('kbcode: if({ notHeld }) compiles, engine 4 is refused', async () => {
  const C = require('../src/kbcode-core');
  const KB = require('../src/kbcode');
  const state = (engine) => ({ model: 'max68he', open: true, features: ['keyActions'], engine, entries: 16, hostApi: 3, openModes: [0x40, 0x42, 0x46],
    modes: [{ id: 1, name: '' }, { id: 2, name: 'Tilde' }, { id: 3, name: '' }], profile: 0, unitMm: 0.005 });
  const code = "kb.key('Esc').when('tap', 3000).if({ mode: 'Tilde' }).if({ notHeld: 'Fn' }).do(kb.send('`'));";
  const r = await C.compile(code, { state: state(5), run: KB.runScript });
  assert.deepStrictEqual(r.errors, []);
  assert.deepStrictEqual(r.plan.keyActions.maps[0].rules[0].if, { mode: 'Tilde', notHeld: ['Fn'] });
  const old = await C.compile(code, { state: state(4), run: KB.runScript });
  assert.match(old.errors.map((e) => e.message).join('\n'), /notHeld need a newer open firmware \(key action engine 5\)/);
});

test('Blocks: <[key] not held> and not <[key] held> compile to notHeld; decompile shows the block; engine 4 warns', () => {
  const B = require('../web/key-blocks-compile');
  const KB = require('../web/key-blocks-core');
  const MODES = [{ id: 1, name: 'Mouse' }, { id: 2, name: 'Tilde' }, { id: 3, name: '' }];
  let n = 0;
  const blk = (type, fields = {}, extra = {}) => ({ type, id: `b${++n}`, fields, ...extra });
  const ws = (cond) => {
    const hat = blk('kb_when_pressed', { KEY: 'Esc' }, { x: 0, y: 0 });
    const both = blk('kb_and', {}, { inputs: { A: { block: blk('kb_mode_active', { MODE: '2' }) }, B: { block: cond } } });
    hat.next = { block: blk('kb_if', {}, { inputs: { COND: { block: both }, DO: { block: blk('kb_key', { OP: 'press', KEY: 'Esc' }) } } }) };
    return { blocks: { blocks: [hat] } };
  };
  for (const cond of [blk('kb_not_held', { KEY: 'Fn' }), blk('kb_not', {}, { inputs: { X: { block: blk('kb_held', { KEY: 'Fn' }) } } })]) {
    const r = B.compile(ws(cond), { modes: MODES, engine: 5 });
    assert.deepStrictEqual(r.warnings, {}, cond.type);
    assert.deepStrictEqual(r.batch().maps[0].rules[0].if, { notHeld: ['Fn'], mode: 'Tilde' });
    assert.strictEqual(KB.condText(r.blocks[0], MODES), 'In mode Tilde, while Fn is not held');
  }
  const old = B.compile(ws(blk('kb_not_held', { KEY: 'Fn' })), { modes: MODES, engine: 4 });
  assert.match(Object.values(old.warnings).flat().join('\n'), /key action engine 5/);
  const both = B.compile(ws(blk('kb_and', {}, { inputs: { A: { block: blk('kb_held', { KEY: 'Fn' }) }, B: { block: blk('kb_not_held', { KEY: 'Fn' }) } } })), { modes: MODES });
  assert.match(Object.values(both.warnings).flat().join('\n'), /held and not held at once/);
  const dec = JSON.stringify(B.decompile([{ key: 'Esc', rules: [{ when: 'press', if: { mode: 'Tilde', notHeld: ['Fn'] }, do: { key: 'Esc' } }] }], MODES));
  assert.match(dec, /"type":"kb_not_held","id":"[^"]+","fields":\{"KEY":"Fn"\}/);
});
