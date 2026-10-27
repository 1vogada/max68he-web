// Keymap, Fn layer, polling rate, per-key colour and macro packets.
// Expected bytes follow the vendor app's gen2 class (5e635fe2.js).
const test = require('node:test');
const assert = require('node:assert');
const P = require('../src/protocol');
const { parseKey, slotName } = require('../src/keys');

test('base-layer key write: [0A, profile, slot, 0, 0, save, layer] + value at 8', () => {
  const pkt = P.keymapSetOne(1, 8, [0, 0, 0x1a, 0]);
  assert.deepStrictEqual(pkt.slice(0, 7), [0x0a, 1, 8, 0, 0, 1, 0]);
  assert.deepStrictEqual(pkt.slice(8, 12), [0, 0, 0x1a, 0]);
  assert.strictEqual(pkt[7], P.checksum(pkt, 7));
  assert.throws(() => P.keymapSetOne(0, 128, [0, 0, 4, 0]));
  assert.throws(() => P.keymapSetOne(0, 1, [0, 0, 4]));
});

test('Fn-layer key write and read: [10, os, profile, slot] / [90, os, profile, FF, page]', () => {
  assert.deepStrictEqual(P.fnSetOne(0, 1, [3, 0, 0xe9, 0], 'mac').slice(0, 4), [0x10, 1, 0, 1]);
  assert.deepStrictEqual(P.fnGetPage(2, 5).slice(0, 5), [0x90, 0, 2, 0xff, 5]);
  assert.throws(() => P.fnSetOne(0, 1, [0, 0, 4, 0], 'linux'));
});

test('polling rate codes follow the vendor table', () => {
  assert.deepStrictEqual(P.reportRatePacket(8000).slice(0, 3), [0x03, 0, 0]);
  assert.deepStrictEqual(P.reportRatePacket(1000).slice(0, 3), [0x03, 0, 3]);
  assert.throws(() => P.reportRatePacket(3000));
});

test('picture upload: 7 pages, 56 bytes then 42, final flag on page 6', () => {
  const rgb = [];
  rgb[0] = [1, 2, 3];
  rgb[125] = [7, 8, 9];
  const pages = P.userPicPages(4, rgb);
  assert.strictEqual(pages.length, 7);
  assert.deepStrictEqual(pages[0].slice(0, 6), [0x0c, 4, 0xff, 0, 56, 0]);
  assert.deepStrictEqual(pages[6].slice(0, 6), [0x0c, 4, 0xff, 6, 42, 1]);
  assert.deepStrictEqual(pages[0].slice(8, 11), [1, 2, 3]);
  assert.deepStrictEqual(pages[6].slice(8 + 375 - 336, 8 + 378 - 336), [7, 8, 9]);
  assert.throws(() => P.userPicPages(5, []));
});

test('macro encoding round-trips, short and long delays', () => {
  const steps = [
    { usage: 0x04, down: true, delayMs: 20 },
    { usage: 0x04, down: false, delayMs: 500 },
  ];
  const body = P.encodeMacro(steps, 3);
  assert.deepStrictEqual(body, [3, 0, 0x04, 0x80 | 20, 0x04, 0, 0xf4, 0x01]);
  assert.deepStrictEqual(P.decodeMacro([...body, 0, 0]), { repeat: 3, steps });
  const pages = P.macroPages(2, body);
  assert.strictEqual(pages.length, 1);
  assert.deepStrictEqual(pages[0].slice(0, 5), [0x0b, 2, 0, 56, 1]);
  assert.throws(() => P.encodeMacro(new Array(130).fill({ usage: 4, down: true, delayMs: 5 })));
});

test('firmware bound checks refuse out-of-range ids and chunks', () => {
  // macro id >= 16 overflows the stack in the v407 flash-save path
  assert.throws(() => P.macroPages(16, [1, 0]), /0\.\.15/);
  assert.doesNotThrow(() => P.macroPages(15, [1, 0]));
  assert.throws(() => P.keymapSetOne(4, 1, [0, 0, 4, 0]), /profile/);
  assert.throws(() => P.keymapSetOne(0, 1, [0, 0, 4, 0], 6), /layer/);
  assert.throws(() => P.fnSetOne(7, 1, [0, 0, 4, 0]), /profile/);
  assert.throws(() => P.packet(0x0c, [0, 0xff, 10, 56, 0]), /chunk/);
  assert.throws(() => P.packet(0x0b, [0, 10, 56, 0]), /chunk/);
  assert.doesNotThrow(() => P.packet(0x0a, [0, 200, 0, 0, 1, 0])); // single-slot form, slot 200 checked elsewhere
  assert.throws(() => parseKey('Macro16'));
});

test('key names cover combos, functions, macros', () => {
  assert.deepStrictEqual(parseKey('Ctrl+C'), [0, 0xe0, 0x06, 0]);
  assert.deepStrictEqual(parseKey('ctrl+shift+esc'), [0, 0xe0, 0xe1, 0x29]);
  assert.deepStrictEqual(parseKey('VolumeUp'), [3, 0, 0xe9, 0]);
  assert.deepStrictEqual(parseKey('Macro3:toggle'), [9, 1, 3, 0]);
  assert.deepStrictEqual(parseKey('Disabled'), [0, 0, 0, 0]);
  assert.strictEqual(slotName([0, 0xe0, 0x06, 0]), 'LCtrl+C');
  assert.strictEqual(slotName([3, 0, 0xe9, 0]), 'VolumeUp');
  assert.strictEqual(slotName([9, 2, 5, 0]), 'Macro5:hold');
  assert.strictEqual(slotName([0, 0x2a, 0, 0]), 'raw:002a0000');
  assert.throws(() => parseKey('A+B'));
});
