// Memory report: CAPS word 3 bit 1 + [12..35] (firmware host_api.h host_mem_t) and the
// sidebar memory bar's pure logic (web/mem-bar.js).
const test = require('node:test');
const assert = require('node:assert');
const P = require('../src/protocol');
const MemBar = require('../web/mem-bar');

const u32 = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
// the 2755 mem-report build: 114,324 / 132,608 B flash, 74,816 + 5,120 / 104,448 B RAM
const MEM = { flashUsed: 114324, flashSize: 0x20600, ramStatic: 74816, ramReserved: 0x1400, ramSize: 0x19800, stackPeak: 2148 };
const caps = (bits3, mem) => [0xf8, 4, 82, 68, 15, 6, 0xff, 0xff, 0xff, 0xff, bits3 & 0xff, bits3 >> 8,
  ...(mem ? [mem.flashUsed, mem.flashSize, mem.ramStatic, mem.ramReserved, mem.ramSize, mem.stackPeak].flatMap(u32) : []),
  ...new Array(28).fill(0)].slice(0, 64);

test('caps word 3 bit 1 carries the memory report', () => {
  const c = P.parseCaps(caps(0x8002, MEM));
  assert.ok(c.features.includes('memReport'));
  assert.deepStrictEqual(c.memory, MEM);
});

test('no memory report on firmware without the bit', () => {
  assert.strictEqual(P.parseCaps(caps(0x8001)).memory, undefined);   // word 3 without bit 1
  assert.strictEqual(P.parseCaps(caps(0x0002, MEM)).memory, undefined);   // word 3 not present (bit 15 clear)
  assert.strictEqual(P.parseCaps([0xf8, 1, 90, 68, 15, 6, 0xff, 0xff]).memory, undefined);
});

test('driver memoryUsage() returns the report or null', async () => {
  const custom = require('../src/custom');
  const fake = (reply) => Object.assign(Object.create(custom), {
    _requireCustom() {}, t: { query: async () => reply } });
  assert.deepStrictEqual(await fake(caps(0x8002, MEM)).memoryUsage(), MEM);
  assert.strictEqual(await fake(caps(0x8000)).memoryUsage(), null);
});

test('bars: percentages, KB tooltip, stack peak', () => {
  const v = MemBar.view(MEM);
  assert.strictEqual(v.known, true);
  assert.deepStrictEqual(v.bars.map((b) => [b.name, Math.round(b.pct), b.level, b.text]),
    [['Flash', 86, 'ok', 'Flash 86 %'], ['RAM', 77, 'ok', 'RAM 77 %']]);
  assert.match(v.tip, /Flash: 111\.6 KB of 129\.5 KB/);
  assert.match(v.tip, /RAM: 78\.1 KB of 102\.0 KB/);
  assert.match(v.tip, /stack peak 2\.1 KB/);
  assert.doesNotMatch(MemBar.view({ ...MEM, stackPeak: 0 }).tip, /stack peak/);
});

test('bar colours like the firmware builder: amber above 95 %, red when full', () => {
  assert.strictEqual(MemBar.level(95), 'ok');
  assert.strictEqual(MemBar.level(95.1), 'warn');
  assert.strictEqual(MemBar.level(100), 'over');
  assert.strictEqual(MemBar.view({ ...MEM, flashUsed: MEM.flashSize }).bars[0].level, 'over');
});

test('firmware without the report: no bars, a "?" explaining why', () => {
  const v = MemBar.view(null);
  assert.strictEqual(v.known, false);
  assert.match(v.tip, /does not report/);
  assert.match(MemBar.view(undefined, false).tip, /stock firmware/);
});
