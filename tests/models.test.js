// Keyboard models: which one opens, the board id check per model, one lock per model.
const test = require('node:test');
const assert = require('node:assert');
const models = require('../src/models');
const lock = require('../src/lock');
const { Keyboard } = require('../src/keyboard');

const node = (pid) => ({ vendorId: 0x3151, productId: pid, usagePage: 0xffff, usage: 2 });
const MAX = node(0x502d), X82 = node(0x502f);

test('pick: asked for, else the first plugged in (MAX68HE first), else the MAX68HE', () => {
  assert.strictEqual(models.pick('x82he', [MAX]).key, 'x82he');
  assert.strictEqual(models.pick(undefined, [X82]).key, 'x82he');
  assert.strictEqual(models.pick(undefined, [X82, MAX]).key, 'max68he');
  assert.strictEqual(models.pick(undefined, []).key, 'max68he');
  assert.throws(() => models.pick('k100', []), /unknown keyboard "k100"/);
  // other interfaces of the board are not its settings interface
  assert.deepStrictEqual(models.plugged([{ ...X82, usage: 1 }]), []);
});

// IDENTIFY reply: board id at 1..2, open-firmware diagnostics at 3..6, revision at 7..8.
const identifyReply = (boardId, diag = 0) => {
  const r = new Array(64).fill(0);
  r[0] = 0x8f; r[1] = boardId & 0xff; r[2] = boardId >> 8; r[3] = diag; r[7] = 0x01; r[8] = 0x04;
  return r;
};
const kbWith = (model, reply) => new Keyboard({ query: async () => reply, close() {} }, model);

test('identify checks the board id of the model it opened', async () => {
  const info = await kbWith(models.byKey('x82he'), identifyReply(2356)).identify();
  assert.strictEqual(info.model, 'x82he');
  assert.strictEqual(info.modelName, 'X82HE Pro');
  assert.strictEqual(info.unitMm, 0.01);
  await assert.rejects(kbWith(models.byKey('x82he'), identifyReply(2755)).identify(), /not the X82HE Pro \(2356\)/);
  await assert.rejects(kbWith(models.byKey('max68he'), identifyReply(2356)).identify(), /not the MAX68HE \(2755\)/);
});

test('only the MAX68HE counts as running the open firmware', async () => {
  assert.strictEqual((await kbWith(models.byKey('max68he'), identifyReply(2755, 3)).identify()).custom, true);
  assert.strictEqual((await kbWith(models.byKey('x82he'), identifyReply(2356, 3)).identify()).custom, false);
});

test('one lock file per model; the MAX68HE keeps the original one', () => {
  assert.strictEqual(lock.fileFor('max68he'), lock.FILE);
  assert.notStrictEqual(lock.fileFor('x82he'), lock.FILE);
  assert.match(lock.fileFor('x82he'), /-x82he\.lock$/);
});

test('every X82HE Pro layout key sits on a distinct slot that its stock keymap uses', () => {
  global.window = {};
  require('../web/layout.js');
  const keys = window.LAYOUTS.x82he.flat().map(([spec]) => spec);
  const slots = keys.map((k) => k.slot);
  assert.strictEqual(new Set(slots).size, slots.length);
  assert.strictEqual(keys.length, 84);   // 83 keys and the knob press
  // a few anchors from the board's keymap read
  const at = Object.fromEntries(keys.map((k) => [k.name, k.slot]));
  assert.deepStrictEqual([at.Esc, at.F12, at['='], at[']'], at["'"], at['/'], at.Space, at.Right, at.Knob],
    [0, 72, 73, 74, 69, 70, 41, 89, 92]);
  // 16 units per row, like the MAX68HE
  for (const row of window.LAYOUTS.x82he) assert.strictEqual(row.reduce((n, [, w = 1]) => n + w, 0), 16);
  delete global.window;
});
