// Droplet maths (JS port of the firmware's droplet.c): same cases as the
// firmware's host test common/test/test_droplet.c.
const test = require('node:test');
const assert = require('node:assert');
const D = require('../web/droplet-core');
const P = require('../src/protocol');

const row8 = Array.from({ length: 8 }, (_, i) => ({ col: i, row: 1 }));
const blue = [0, 0, 255];
const sum = (rgb) => rgb[0] + rgb[1] + rgb[2];
const frame = (depth, t = 0, s = D.createState(8)) => D.render(s, depth, row8, blue, 4, t);

test('dark at rest; a press glows brightest at the key and spreads with distance', () => {
  assert.strictEqual(sum(frame(new Array(8).fill(0))[3]), 0);
  const d = new Array(8).fill(0); d[3] = 1;
  const o = frame(d);
  assert.ok(sum(o[3]) > sum(o[4]) && sum(o[4]) > 0 && sum(o[2]) > 0);
  assert.ok(sum(o[7]) < sum(o[4]));
  assert.ok(o[3][0] > 0, 'full press heats the core toward white');
});

test('depth sets reach; nearby glows merge', () => {
  const full = new Array(8).fill(0); full[3] = 1;
  const shallow = new Array(8).fill(0); shallow[3] = 0.4;
  assert.ok(sum(frame(shallow)[4]) < sum(frame(full)[4]));
  const one = new Array(8).fill(0); one[2] = 0.6;
  const two = [...one]; two[4] = 0.6;
  assert.ok(sum(frame(two)[3]) > sum(frame(one)[3]) + 20);
});

test('released key drains, then goes dark', () => {
  const s = D.createState(8);
  const d = new Array(8).fill(0); d[3] = 1;
  const full = sum(D.render(s, d, row8, blue, 4, 0)[3]);
  d[3] = 0;
  const mid = sum(D.render(s, d, row8, blue, 4, 50)[3]);
  assert.ok(mid > 0 && mid < full);
  let o;
  for (let t = 100; t < 3000; t += 50) o = D.render(s, d, row8, blue, 4, t);
  assert.strictEqual(sum(o[3]), 0);
});

test('custom-firmware packets: live frames in chunks of 18, droplet mode 0x42', () => {
  const frames = P.liveFramePackets(Array.from({ length: 68 }, (_, i) => [i, 0, 255]));
  assert.strictEqual(frames.length, 4);
  assert.deepStrictEqual(frames[1].slice(0, 3), [0xf5, 18, 18]);
  assert.deepStrictEqual(frames[3].slice(0, 3), [0xf5, 54, 14]);
  assert.deepStrictEqual(frames[0].slice(8, 11), [0, 0, 255]);
  assert.deepStrictEqual(P.customModePacket(0x42, 3).slice(0, 5), [0x07, 0x42, 2, 3, 7]);
  assert.throws(() => P.customModePacket(0x13));
});
