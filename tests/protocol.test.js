// Offline tests for packet building. No keyboard needed: node --test
const test = require('node:test');
const assert = require('node:assert');
const P = require('../src/protocol');
const { parseKey, slotName } = require('../src/keys');

test('bit7 checksum matches the identify packet', () => {
  const pkt = P.packet(0x8f);
  assert.strictEqual(pkt.length, 64);
  assert.strictEqual(pkt[7], 0xff - 0x8f);
});

test('reply checksums seen on the real board verify', () => {
  // 0x84 reply was "84 00 00 00 00 00 00 7b"
  assert.strictEqual(P.checksum([0x84, 0, 0, 0, 0, 0, 0], 7), 0x7b);
});

test('destructive opcodes are refused', () => {
  for (const op of [0xac, 0x2c, 0x7f, 0x30, 0x01, 0x1c, 0x1e, 0xc5]) assert.throws(() => P.packet(op));
});

test('firmware 5.04 uses 0.005 mm counts', () => {
  assert.strictEqual(P.unitMm(0x504), 0.005);
  assert.strictEqual(P.mmToWire(P.HALL.ACTUATION, 2.0, 0.005), 400);
  assert.strictEqual(P.wireToMm(446, 0.005), 2.23);
});

test('travel is clamped to firmware limits', () => {
  assert.strictEqual(P.mmToWire(P.HALL.ACTUATION, 0, 0.005), 20); // 0.1 mm floor
  assert.strictEqual(P.mmToWire(P.HALL.DEAD_BOTTOM, 9, 0.005), 680); // 3.4 mm ceiling
  assert.strictEqual(P.mmToWire(P.HALL.ACTUATION, 4, 0.005), 680); // actuation and release: 3.4 mm, under the 3.5 mm travel
  assert.strictEqual(P.mmToWire(P.HALL.RELEASE, 3.9, 0.005), 680);
  assert.strictEqual(P.mmToWire(P.HALL.RT_PRESS, 3.9, 0.005), 780);
});

test('single hall write puts u16 at bytes 8..9 and commit flag at 4', () => {
  const pkt = P.hallSetOne(P.HALL.ACTUATION, 8, 0x01c2, true);
  assert.deepStrictEqual(pkt.slice(0, 5), [0x65, 0, 0, 8, 1]);
  assert.deepStrictEqual(pkt.slice(8, 10), [0xc2, 0x01]);
  assert.throws(() => P.hallSetOne(0, 128, 1, true));
});

test('bulk hall write: 5 pages for u16, 3 for u8, commit on last page only', () => {
  const wide = P.hallSetAll(P.HALL.ACTUATION, new Array(128).fill(400), true);
  assert.strictEqual(wide.length, 5);
  assert.deepStrictEqual(wide.map((p) => p[4]), [0, 0, 0, 0, 1]);
  const narrow = P.hallSetAll(P.HALL.MODE, new Array(128).fill(0x80), false);
  assert.strictEqual(narrow.length, 3);
  assert.ok(narrow.every((p) => p[4] === 0));
});

test('lighting round-trips through packet and parser', () => {
  const pkt = P.ledPacket({ mode: 1, speed: 4, brightness: 3, r: 255, g: 0, b: 16 });
  assert.strictEqual(pkt[2], 0); // speed 4 is wire 0
  assert.strictEqual(pkt[5], 0xfa); // white channel capped
  assert.strictEqual(pkt[8], P.checksum(pkt, 8));
  const back = P.parseLed(pkt);
  assert.strictEqual(back.speed, 4);
  assert.strictEqual(back.rainbow, false);
  // the board's own state: wave, preset colour 1, option 2
  const cur = P.parseLed([0x87, 4, 2, 4, 0x21, 255, 255, 255]);
  assert.deepStrictEqual(P.ledPacket(cur).slice(1, 5), [4, 2, 4, 0x21]);
  assert.throws(() => P.ledPacket({ mode: 13, speed: 0, brightness: 0, option: 5 }), /picture 0..4/);
  assert.throws(() => P.ledPacket({ mode: 40, speed: 0, brightness: 0 }));
});

test('mode 13 shows a stored picture: option is the picture 0..4', () => {
  const pkt = P.ledPacket({ mode: 13, speed: 2, brightness: 4, option: 3 });
  assert.deepStrictEqual([pkt[1], pkt[4] >> 4], [13, 3]);
  for (const option of [-1, 5, 1.5]) assert.throws(() => P.ledPacket({ mode: 13, speed: 2, brightness: 4, option }));
});

test('live colour packet matches the RY5088 reference layout', () => {
  // monsgeek-akko-linux screen_color::build_report(0x67, 0x67, 0x67)
  const pkt = P.screenColorPacket(0x67, 0x67, 0x67);
  assert.deepStrictEqual(pkt.slice(0, 8), [0x0e, 0x67, 0x67, 0x67, 0, 0, 0, (255 - ((0x0e + 3 * 0x67) & 0xff))]);
  assert.deepStrictEqual(P.screenColorPacket(300, -5, 12.6).slice(1, 4), [255, 0, 13]);
});

test('audio bars: 16 levels 0..6 at bytes 8..23', () => {
  const pkt = P.audioVizPacket([0, 1, 2, 3, 4, 5, 6, 9, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.strictEqual(pkt[0], 0x0d);
  assert.deepStrictEqual(pkt.slice(8, 16), [0, 1, 2, 3, 4, 5, 6, 6]);
  assert.throws(() => P.audioVizPacket([1, 2]));
});

test('live modes encode the flags nibble like the vendor app', () => {
  assert.strictEqual(P.ledPacket({ mode: 21, speed: 0, brightness: 4, option: 3, r: 1, g: 2, b: 3 })[4], 0);
  assert.strictEqual(P.ledPacket({ mode: 22, speed: 0, brightness: 4, option: 1, rainbow: true })[4], 0x10);
  assert.strictEqual(P.ledPacket({ mode: 22, speed: 0, brightness: 4, option: 1 })[4], 0x14);
  assert.throws(() => P.ledPacket({ mode: 23, speed: 0, brightness: 0 }));
});

test('key names parse and print', () => {
  assert.deepStrictEqual(parseKey('Esc'), [0, 0, 0x29, 0]);
  assert.deepStrictEqual(parseKey('fn'), [0x0a, 1, 0, 0]);
  assert.strictEqual(slotName([0, 0, 0x14, 0]), 'Q');
  assert.strictEqual(slotName([0, 0, 0, 0]), null);
  assert.throws(() => parseKey('nope'));
});

test('key values: macro index 0..15 and text index 0..63 on every write path', () => {
  P.checkValue([9, 0, 15, 0]);
  P.checkValue([11, 0, 63, 0]);
  P.checkValue([0, 0, 0x14, 0]);
  assert.throws(() => P.checkValue([9, 0, 16, 0]), /macro index is 0..15/);
  assert.throws(() => P.checkValue([11, 0, 64, 0]), /text slot is 0..63/);
  const raw = require('../src/keys').parseKey('raw:09001400');   // raw: skips parseKey's own guard
  assert.throws(() => P.keymapSetOne(0, 8, raw), /macro index/);
  assert.throws(() => P.fnSetOne(0, 8, [11, 0, 200, 0]), /text slot/);
});
