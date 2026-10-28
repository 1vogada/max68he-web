// Key action engines 2 / 3 (feature 'keyModes'): conditions (`if`), modes and mouse keys (engine 3:
// shared speed). Packets and
// record bytes must match the contract (key-modes-spec.md); the acceptance example (Fn + Ctrl + M
// held 3 s -> mouse mode) must produce exactly tests/fixtures/ka-mouse-mode.hex.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const P = require('../src/protocol');
const K = require('../src/key-actions');
const { fakeKeyboard } = require('./fixtures/ka-fake');
const { MAX68HE_KEYS } = require('./fixtures/max68he-keys');
const { fixturePackets, toHex } = require('../scripts/ka-fixture');

const EXAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'ka-mouse-mode.json'), 'utf8'));
const v2 = (opts) => fakeKeyboard({ engine: 3, entries: 32, keys: MAX68HE_KEYS, ...opts });   // engine 3 (the example shares speed)
const writes = (f) => f.sent.filter((p) => p[0] === 0xee && [2, 5, 7].includes(p[1]));
const rule8 = (r, key = 'W') => K.toRecord(K.parseSpec({ key, rules: [r] }), 14, () => 1).slice(8, 16);
const rules16 = (r) => K.toRecord(K.parseSpec({ key: 'W', rules: [r] }), 14).slice(8, 24);
const bad = (spec, re) => assert.throws(() => K.parseSpec(spec), (e) => e.status === 400 && re.test(e.message), `${JSON.stringify(spec)} -> ${re}`);
const badRule = (r, re) => bad({ key: 'W', rules: [r] }, re);
const MK = (extra) => ({ when: 'press', do: { mouseKeys: 'up', ...extra } });

test('protocol: INFO v2, COND / MODE packets, condition nibble, mode names in UTF-8', () => {
  const info = [0xee, 0, 0, 0, 0, 0, 0, 0, 32, 6, 3, 56];
  assert.deepStrictEqual(P.parseKaInfo(info), { entries: 32, maxRules: 6, used: 3, recordBytes: 56, engine: 1, conditions: 0, modes: 0, activeModes: 0 });
  assert.deepStrictEqual(P.parseKaInfo([...info, 2, 15, 3, 5]), { entries: 32, maxRules: 6, used: 3, recordBytes: 56, engine: 2, conditions: 15, modes: 3, activeModes: 5 });
  assert.deepStrictEqual(P.kaCondGetPacket(15).slice(0, 3), [0xee, 4, 15]);
  const cs = P.kaCondSetPacket(1, [65, 5, 0xff, 0]);
  assert.deepStrictEqual([...cs.slice(0, 3), ...cs.slice(8, 12)], [0xee, 5, 1, 65, 5, 0xff, 0]);
  assert.strictEqual(cs[7], P.checksum(cs, 7));
  assert.throws(() => P.kaCondGetPacket(0), /1..255/);
  assert.throws(() => P.kaCondSetPacket(256, [0, 0, 0, 0]), /1..255/);
  assert.deepStrictEqual(P.kaModeGetPacket(3).slice(0, 3), [0xee, 6, 3]);
  const ms = P.kaModeSetPacket(1, 'Mäus');
  assert.deepStrictEqual(ms.slice(0, 3), [0xee, 7, 1]);
  assert.deepStrictEqual(ms.slice(8, 24), [0x4d, 0xc3, 0xa4, 0x75, 0x73, ...new Array(11).fill(0)]);
  assert.strictEqual(P.decodeModeName(ms.slice(8, 24)), 'Mäus');
  assert.throws(() => P.kaModeSetPacket(1, 'x'.repeat(17)), /at most 16 bytes/);
  assert.throws(() => P.kaModeSetPacket(33, 'x'), /1..32/);
  const r = P.encodeKaRecord({ slot: 1, rules: [{ trigger: 5, cond: 2, mode: 1, tval: 0, output: 5, a: 1 }] });
  assert.strictEqual(r[8], 0x25);
  assert.deepStrictEqual(P.decodeKaRecord(r).rules[0].trigger, 5);
  assert.deepStrictEqual(P.decodeKaRecord(r).rules[0].cond, 2);
});

test('acceptance: the mouse mode example writes exactly these packets (and the committed .hex)', async () => {
  const f = v2();
  const r = await f.kb.setKeyActionsBatch(EXAMPLE);
  const hdr = (slot, n) => [slot, n, 10, 0, 30, 0, 0, 0];
  const pad = (bytes) => [...bytes, ...new Array(56 - bytes.length).fill(0)];
  const mk = (slot, dir) => pad([...hdr(slot, 2), 0x25, 5, 0, 0, 9, dir, 10, 120, 0x0f, 15, 0xe8, 0x03, 1, 200, 0, 1]);
  const expect = [
    [7, 1, [0x4d, 0x6f, 0x75, 0x73, 0x65, ...new Array(11).fill(0)]],     // mode 1 = "Mouse"
    [5, 1, [65, 5, 0xff, 0]],                                             // Fn (65) + LCtrl (5)
    [5, 2, [0xff, 0xff, 0xff, 0x01]],                                     // mode 1 on
    [2, 52, pad([...hdr(52, 1), 0x13, 1, 0xb8, 0x0b, 10, 1, 1, 0])],      // M: cond 1, hold 3000 ms, press: enter mode 1
    [2, 76, pad([...hdr(76, 1), 0x25, 1, 0, 0, 5, 1, 0, 0])],             // RShift: cond 2, press: mouse button 1
    [2, 88, pad([...hdr(88, 1), 0x25, 1, 0, 0, 5, 2, 0, 0])],             // PgDn: button 2
    [2, 82, mk(82, 1)], [2, 83, mk(83, 2)], [2, 77, mk(77, 3)], [2, 89, mk(89, 4)],   // arrows: mouse keys + ARG (1000 ms, easeIn, P 2.00, keep 150 ms, shared)
    [2, 1, pad([...hdr(1, 1), 0x25, 1, 0, 0, 10, 1, 2, 0])],              // Esc: leave mode 1
  ];
  const got = writes(f);
  assert.deepStrictEqual(got.map((p) => [p[1], p[2], p.slice(8, 8 + expect[got.indexOf(p)]?.[2].length)]), expect);
  for (const p of got) assert.strictEqual(p[7], P.checksum(p, 7));
  assert.strictEqual(toHex(await fixturePackets()), fs.readFileSync(path.join(__dirname, 'fixtures', 'ka-mouse-mode.hex'), 'utf8'), 'regenerate: node scripts/ka-fixture.js');
  assert.deepStrictEqual(r.maps.map((m) => m.summary[0]), [
    'While Fn + Left Ctrl are held, hold 3.00 s: enter mode Mouse',
    'In mode Mouse, press: mouse button left (until released)',
    'In mode Mouse, press: mouse button right (until released)',
    'In mode Mouse, while pressed: move the mouse up, 100 -> 1200 px/s over 1.00 s (ease in), speed shared between directions, kept 150 ms after release',
    'In mode Mouse, while pressed: move the mouse down, 100 -> 1200 px/s over 1.00 s (ease in), speed shared between directions, kept 150 ms after release',
    'In mode Mouse, while pressed: move the mouse left, 100 -> 1200 px/s over 1.00 s (ease in), speed shared between directions, kept 150 ms after release',
    'In mode Mouse, while pressed: move the mouse right, 100 -> 1200 px/s over 1.00 s (ease in), speed shared between directions, kept 150 ms after release',
    'In mode Mouse, press: leave mode Mouse',
  ]);
  assert.deepStrictEqual(r.modes, [{ id: 1, name: 'Mouse' }, { id: 2, name: '' }, { id: 3, name: '' }]);
  // read back: `if` and modes by name, mouse keys with their defaults filled
  const m = await f.kb.getKeyActions('M');
  assert.deepStrictEqual(m.rules, [{ when: 'hold', ms: 3000, mode: 'press', if: { held: ['Fn', 'LCtrl'] }, do: { mode: 'Mouse', action: 'enter' } }]);
  assert.deepStrictEqual((await f.kb.getKeyActions('Up')).rules[0], { when: 'press', mode: 'while', if: { mode: 'Mouse' },
    do: { mouseKeys: 'up', start: 100, max: 1200, rampMs: 1000, curve: 'easeIn', power: 2, shareSpeed: true, keepMs: 150 } });
  // the same batch again writes the same records and no new condition
  f.sent.length = 0;
  await f.kb.setKeyActionsBatch(EXAMPLE);
  assert.deepStrictEqual(writes(f).filter((p) => p[1] !== 2), [], 'names and conditions already there');
});

test('mouse keys: units, defaults, curves and power ranges, 2 rule slots', () => {
  assert.deepStrictEqual(rules16(MK()), [0x25, 5, 0, 0, 9, 1, 10, 120, 15, 0, 0xe8, 3, 1, 200, 0, 0].map((v, i) => (i === 0 ? 5 : v)), 'defaults, mode while');
  assert.deepStrictEqual(rules16(MK({ start: 10, max: 2550, rampMs: 0, curve: 'linear' })).slice(4, 16), [9, 1, 1, 255, 15, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepStrictEqual(rules16({ when: 'press', do: { mouseKeys: 'wheelDown' } }).slice(4, 8), [9, 6, 20, 100], 'wheel: 2 -> 10 notches/s');
  assert.deepStrictEqual(rules16({ when: 'press', do: { mouseKeys: 'wheelUp', start: 0.1, max: 25.5 } }).slice(4, 8), [9, 5, 1, 255]);
  assert.deepStrictEqual(rules16(MK({ start: 104, max: 106 })).slice(6, 8), [10, 11], 'px/s round to 10');
  assert.deepStrictEqual(rules16(MK({ curve: 'expo' })).slice(13, 15), [0xf4, 0x01], 'expo K 5 -> 500');
  assert.deepStrictEqual(rules16(MK({ curve: 'expo', power: -20 })).slice(13, 15), [0x30, 0xf8], 'K -20 -> -2000 LE');
  assert.deepStrictEqual(rules16(MK({ curve: 'easeOut', power: 0.3 })).slice(12, 15), [2, 30, 0]);
  assert.deepStrictEqual(rules16(MK({ curve: 'easeInOut', power: 8 })).slice(12, 15), [3, 0x20, 0x03]);
  assert.deepStrictEqual(rules16(MK({ curve: 'smooth', rampMs: 10000 })).slice(10, 14), [0x10, 0x27, 6, 0]);
  assert.deepStrictEqual(rules16({ when: 'down', at: 1, mode: 'toggle', do: { mouseKeys: 'left' } }).slice(0, 2), [1, 4]);
  const o = (extra, re) => badRule(MK(extra), re);
  o({ mouseKeys: 'diagonal' }, /mouseKeys is up, down, left, right, wheelUp, wheelDown/);
  o({ start: 5 }, /start is a number within 10..2550 px\/s/);
  o({ max: 2551 }, /max is a number within 10..2550 px\/s/);
  badRule({ when: 'press', do: { mouseKeys: 'wheelUp', max: 26 } }, /max is a number within 0.1..25.5 notches\/s/);
  o({ start: 500, max: 400 }, /start is not above max/);
  o({ rampMs: 10001 }, /rampMs is a whole number within 0..10000/);
  o({ rampMs: 1.5 }, /rampMs is a whole number/);
  o({ curve: 'points' }, /curve is linear, easeIn, easeOut, easeInOut, sine, expo, smooth/);
  o({ curve: 'linear', power: 2 }, /a power only goes with ease or expo curves, not linear/);
  o({ curve: 'sine', power: 2 }, /not sine/);
  o({ power: 0.29 }, /power \(ease P\) is a number within 0.3..8/);
  o({ power: 8.1 }, /power \(ease P\)/);
  o({ curve: 'expo', power: 0 }, /expo power \(K\) is within -20..20 and not 0/);
  o({ curve: 'expo', power: 20.1 }, /power \(expo K\) is a number within -20..20/);
  o({ speed: 1 }, /unknown field "speed"/);
  for (const mode of ['tap', 'release']) badRule({ ...MK(), mode }, /mouseKeys takes mode press, toggle, while/);
  assert.doesNotThrow(() => K.parseSpec({ key: 'W', rules: [MK(), MK(), MK()] }), '3 mouse keys rules = 6 slots');
  bad({ key: 'W', rules: [MK(), MK(), MK(), { when: 'press', do: { gamepad: 'A' } }] }, /the rules take 7 of the key's 6 rule slots \(a mouseKeys rule takes 2, 3 with speedBy pressure or both\)/);
});

test('mouse keys shareSpeed / keepMs: ARG mode byte = keepMs / 10, c bit 0; defaults, rounding, read back, summary', () => {
  const arg = (extra) => rules16(MK(extra)).slice(8, 16);
  assert.deepStrictEqual(arg(), [15, 0, 0xe8, 3, 1, 200, 0, 0], 'no sharing: mode 0, c 0 (as engine 2)');
  assert.deepStrictEqual(arg({ shareSpeed: false }), [15, 0, 0xe8, 3, 1, 200, 0, 0]);
  assert.deepStrictEqual(arg({ shareSpeed: true }), [15, 15, 0xe8, 3, 1, 200, 0, 1], 'default keep 150 ms');
  assert.deepStrictEqual(arg({ shareSpeed: true, keepMs: 0 }), [15, 0, 0xe8, 3, 1, 200, 0, 1]);
  assert.deepStrictEqual(arg({ shareSpeed: true, keepMs: 1000 }).slice(1, 8), [100, 0xe8, 3, 1, 200, 0, 1]);
  assert.strictEqual(arg({ shareSpeed: true, keepMs: 74 })[1], 7, '74 ms rounds to 70');
  assert.strictEqual(arg({ shareSpeed: true, keepMs: 75 })[1], 8, '75 ms rounds to 80');
  assert.deepStrictEqual(rules16({ when: 'press', do: { mouseKeys: 'wheelUp', shareSpeed: true, keepMs: 300 } }).slice(9, 16), [30, 0xe8, 3, 1, 200, 0, 1], 'wheel too');
  const back = (d) => K.preview({ key: 'W', rules: [{ when: 'press', do: { mouseKeys: 'up', ...d } }] });
  assert.deepStrictEqual(back({ shareSpeed: true, keepMs: 74 }).rules[0].do,
    { mouseKeys: 'up', start: 100, max: 1200, rampMs: 1000, curve: 'easeIn', power: 2, shareSpeed: true, keepMs: 70 });
  assert.ok(!('shareSpeed' in back({ shareSpeed: false }).rules[0].do) && !('keepMs' in back({}).rules[0].do), 'false omits both');
  assert.deepStrictEqual(back({ shareSpeed: true }).summary, ['While pressed: move the mouse up, 100 -> 1200 px/s over 1.00 s (ease in), speed shared between directions, kept 150 ms after release']);
  assert.deepStrictEqual(back({ shareSpeed: true, keepMs: 0, rampMs: 0 }).summary, ['While pressed: move the mouse up at 1200 px/s, speed shared between directions']);
  assert.deepStrictEqual(back({}).summary, ['While pressed: move the mouse up, 100 -> 1200 px/s over 1.00 s (ease in)']);
  const o = (extra, re) => badRule(MK(extra), re);
  o({ keepMs: 150 }, /keepMs only goes with shareSpeed: true/);
  o({ shareSpeed: false, keepMs: 0 }, /keepMs only goes with shareSpeed: true/);
  o({ shareSpeed: true, keepMs: 1001 }, /keepMs is a number within 0..1000 ms/);
  o({ shareSpeed: true, keepMs: -1 }, /keepMs is a number within 0..1000 ms/);
  o({ shareSpeed: true, keepMs: '150' }, /keepMs is a number within 0..1000 ms/);
  o({ shareSpeed: 1 }, /shareSpeed is true or false/);
});

test('engine 2 firmware: shareSpeed refused before anything is written; plain mouse keys still work', async () => {
  const f = v2({ engine: 2 });
  await assert.rejects(f.kb.setKeyActionsBatch(EXAMPLE), (e) => e.status === 400 && /shareSpeed need a newer open firmware \(key action engine 3\)/.test(e.message));
  await assert.rejects(f.kb.setKeyActions({ key: 'W', rules: [MK({ shareSpeed: true, keepMs: 0 })] }), /key action engine 3/);
  assert.deepStrictEqual(writes(f), [], 'nothing written');
  const m = await f.kb.setKeyActions({ key: 'W', rules: [MK()] });
  assert.ok(!('shareSpeed' in m.rules[0].do));
  // the fake engine 2 itself refuses a sharing ARG rule (as the firmware does)
  await assert.rejects(f.kb._kaQuery(P.kaSetPacket(14, K.toRecord(K.parseSpec({ key: 'W', rules: [MK({ shareSpeed: true })] }), 14))), /bad rule 2/);
});

test('mouse keys speedBy pressure / both: ARG c bits 1..2, DEPTH rule after the ARG, 3 slots, defaults, rounding, read back, summary', () => {
  const rules24 = (r) => K.toRecord(K.parseSpec({ key: 'W', rules: [r] }), 14).slice(8, 32);
  const tail = (extra) => rules24(MK(extra)).slice(8, 24);   // ARG + DEPTH
  assert.deepStrictEqual(tail({}), [15, 0, 0xe8, 3, 1, 200, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 'time: no DEPTH rule (as engine 3)');
  assert.deepStrictEqual(tail({ speedBy: 'time' }), tail({}), 'speedBy time = the old bytes');
  assert.deepStrictEqual(tail({ speedBy: 'pressure' }), [15, 0, 0xe8, 3, 1, 200, 0, 2, 15, 0, 0, 0, 5, 32, 0, 0], 'pressure: c = 2, DEPTH 0.5 -> 3.2 mm');
  assert.deepStrictEqual(tail({ speedBy: 'both', pressFrom: 1, pressTo: 4 }), [15, 0, 0xe8, 3, 1, 200, 0, 4, 15, 0, 0, 0, 10, 40, 0, 0], 'both: c = 4');
  assert.deepStrictEqual(tail({ speedBy: 'both', shareSpeed: true, keepMs: 200 }).slice(0, 10), [15, 20, 0xe8, 3, 1, 200, 0, 5, 15, 0], 'with share: c = 5');
  assert.deepStrictEqual(tail({ speedBy: 'pressure', pressFrom: 0, pressTo: 0.1 }).slice(12, 14), [0, 1], 'the extremes');
  assert.deepStrictEqual(tail({ speedBy: 'pressure', pressFrom: 0.84, pressTo: 2.25 }).slice(12, 14), [8, 23], 'rounded to 0.1 mm');
  assert.deepStrictEqual(rules24({ when: 'press', do: { mouseKeys: 'wheelDown', speedBy: 'pressure' } }).slice(0, 8), [0x05, 5, 0, 0, 9, 6, 20, 100], 'the mouse keys rule itself unchanged');
  // slots: 3 with pressure / both
  assert.doesNotThrow(() => K.parseSpec({ key: 'W', rules: [MK({ speedBy: 'pressure' }), MK({ speedBy: 'both' })] }), '2 x 3 = 6 slots');
  bad({ key: 'W', rules: [MK({ speedBy: 'pressure' }), MK(), MK()] }, /the rules take 7 of the key's 6 rule slots \(a mouseKeys rule takes 2, 3 with speedBy pressure or both\)/);
  // read back: speedBy only when not time, the depths with it
  const back = (d) => K.preview({ key: 'W', rules: [{ when: 'press', do: { mouseKeys: 'up', ...d } }] });
  assert.ok(!('speedBy' in back({}).rules[0].do) && !('speedBy' in back({ speedBy: 'time' }).rules[0].do), 'time is not read back');
  assert.deepStrictEqual(back({ speedBy: 'pressure', pressFrom: 0.84 }).rules[0].do,
    { mouseKeys: 'up', start: 100, max: 1200, rampMs: 1000, curve: 'easeIn', power: 2, speedBy: 'pressure', pressFrom: 0.8, pressTo: 3.2 });
  assert.deepStrictEqual(back({ speedBy: 'both', shareSpeed: true, rampMs: 600, pressFrom: 1, pressTo: 3.5 }).rules[0].do,
    { mouseKeys: 'up', start: 100, max: 1200, rampMs: 600, curve: 'easeIn', power: 2, shareSpeed: true, keepMs: 150, speedBy: 'both', pressFrom: 1, pressTo: 3.5 });
  // a pressure rule followed by another rule: the DEPTH rule is not read as a rule of its own
  const two = K.preview({ key: 'W', rules: [MK({ speedBy: 'pressure' }), { when: 'release', do: { key: 'A' } }] });
  assert.deepStrictEqual(two.rules.map((r) => r.when), ['press', 'release']);
  assert.deepStrictEqual(two.rules[1].do, { key: 'A' });
  // summaries
  assert.deepStrictEqual(back({ speedBy: 'pressure', shareSpeed: true }).summary,
    ['While pressed: move the mouse up, 100 -> 1200 px/s, speed by how deep you press, 0.50 -> 3.20 mm'], 'pressure leaves out the ramp and sharing');
  assert.deepStrictEqual(back({ speedBy: 'both', curve: 'linear' }).summary,
    ['While pressed: move the mouse up, 100 -> 1200 px/s, up to a speed set by how deep you press (0.50 -> 3.20 mm), building over 1.00 s (linear)']);
  assert.deepStrictEqual(back({ speedBy: 'both', shareSpeed: true, keepMs: 0 }).summary,
    ['While pressed: move the mouse up, 100 -> 1200 px/s, up to a speed set by how deep you press (0.50 -> 3.20 mm), building over 1.00 s (ease in), speed shared between directions']);
  assert.deepStrictEqual(back({ speedBy: 'both', rampMs: 0 }).summary, ['While pressed: move the mouse up, 100 -> 1200 px/s, speed by how deep you press, 0.50 -> 3.20 mm']);
  assert.deepStrictEqual(back({ speedBy: 'pressure', start: 500, max: 500, pressFrom: 1 }).summary, ['While pressed: move the mouse up at 500 px/s once pressed past 1.00 mm']);
  // refusals
  const o = (extra, re) => badRule(MK(extra), re);
  o({ speedBy: 'depth' }, /speedBy is time, pressure, both/);
  o({ speedBy: true }, /speedBy is time, pressure, both/);
  o({ pressFrom: 1 }, /pressFrom \/ pressTo only go with speedBy "pressure" or "both"/);
  o({ speedBy: 'time', pressTo: 3 }, /pressFrom \/ pressTo only go with speedBy "pressure" or "both"/);
  o({ speedBy: 'pressure', pressFrom: -0.1 }, /pressFrom is a number within 0..4 mm/);
  o({ speedBy: 'pressure', pressTo: 4.1 }, /pressTo is a number within 0..4 mm/);
  o({ speedBy: 'pressure', pressFrom: '1' }, /pressFrom is a number within 0..4 mm/);
  o({ speedBy: 'pressure', pressFrom: 2, pressTo: 2 }, /pressTo must be at least 0.1 mm deeper than pressFrom/);
  o({ speedBy: 'both', pressFrom: 2.04, pressTo: 1.96 }, /pressTo must be at least 0.1 mm deeper than pressFrom/);
  o({ speedBy: 'pressure', pressFrom: 3.2 }, /pressTo must be at least 0.1 mm deeper than pressFrom/);
});

test('engine 3 firmware: speedBy pressure / both refused before anything is written; by time and sharing still work', async () => {
  const PRESSURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'ka-mouse-mode-pressure.json'), 'utf8'));
  const f = v2();
  await assert.rejects(f.kb.setKeyActionsBatch(PRESSURE), (e) => e.status === 400 && /speedBy pressure or both need a newer open firmware \(key action engine 4\)/.test(e.message));
  await assert.rejects(f.kb.setKeyActions({ key: 'W', rules: [MK({ speedBy: 'both' })] }), /key action engine 4/);
  assert.deepStrictEqual(writes(f), [], 'nothing written');
  const m = await f.kb.setKeyActions({ key: 'W', rules: [MK({ speedBy: 'time', shareSpeed: true })] });
  assert.ok(!('speedBy' in m.rules[0].do) && m.rules[0].do.shareSpeed);
  // the fake engine 3 refuses the SPEEDBY bits itself (as the firmware does)
  const rec = K.toRecord(K.parseSpec({ key: 'W', rules: [MK({ speedBy: 'pressure' })] }), 14);
  await assert.rejects(f.kb._kaQuery(P.kaSetPacket(14, rec)), /bad rule 2/);
  // engine 2: the pressure refusal comes first, not a shareSpeed one
  await assert.rejects(v2({ engine: 2 }).kb.setKeyActions({ key: 'W', rules: [MK({ speedBy: 'pressure' })] }), /key action engine 4/);
});

test('engine 4: the pressure example writes the committed .hex, reads back and rewrites nothing new; the fake refuses bad DEPTH rules', async () => {
  const PRESSURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'ka-mouse-mode-pressure.json'), 'utf8'));
  const f = v2({ engine: 4 });
  const r = await f.kb.setKeyActionsBatch(PRESSURE);
  assert.strictEqual(toHex(await fixturePackets('ka-mouse-mode-pressure')),
    fs.readFileSync(path.join(__dirname, 'fixtures', 'ka-mouse-mode-pressure.hex'), 'utf8'), 'regenerate: node scripts/ka-fixture.js');
  const up = writes(f).find((p) => p[1] === 2 && p[2] === 82);
  assert.deepStrictEqual(up.slice(8, 40), [82, 3, 10, 0, 30, 0, 0, 0, 0x25, 5, 0, 0, 9, 1, 10, 120, 0x0f, 15, 0xe8, 3, 1, 200, 0, 3, 0x0f, 0, 0, 0, 5, 32, 0, 0]);
  assert.strictEqual(r.maps[3].summary[0], 'In mode Mouse, while pressed: move the mouse up, 100 -> 1200 px/s, speed by how deep you press, 0.50 -> 3.20 mm');
  assert.deepStrictEqual((await f.kb.getKeyActions('Up')).rules[0].do,
    { mouseKeys: 'up', start: 100, max: 1200, rampMs: 1000, curve: 'easeIn', power: 2, shareSpeed: true, keepMs: 150, speedBy: 'pressure', pressFrom: 0.5, pressTo: 3.2 });
  f.sent.length = 0;
  await f.kb.setKeyActionsBatch(PRESSURE);
  assert.deepStrictEqual(writes(f).filter((p) => p[1] !== 2), [], 'names and conditions already there');
  // the fake engine 4 refuses what the firmware refuses
  const rec = K.toRecord(K.parseSpec({ key: 'W', rules: [MK({ speedBy: 'pressure' })] }), 14);
  const set = (edit) => { const x = [...rec]; edit(x); return f.kb._kaQuery(P.kaSetPacket(14, x)); };
  await assert.rejects(set((x) => { x[23] = 6; }), /bad rule 2/, 'SPEEDBY 3');
  await assert.rejects(set((x) => { x[1] = 2; x.fill(0, 24, 32); }), /bad rule 2/, 'DEPTH missing');
  await assert.rejects(set((x) => { x[28] = 32; }), /bad rule 3/, 'from = to');
  await assert.rejects(set((x) => { x[29] = 41; }), /bad rule 3/, 'to > 4 mm');
  await set((x) => { x[28] = 0; x[29] = 40; });
});

test('modes and conditions: bytes, defaults and every refusal', () => {
  assert.deepStrictEqual(rule8({ when: 'press', do: { mode: 2, action: 'toggle' } }), [5, 1, 0, 0, 10, 2, 3, 0]);
  assert.deepStrictEqual(rule8({ when: 'tap', ms: 200, do: { leaveAllModes: true } }), [4, 3, 200, 0, 10, 0, 2, 0]);
  assert.deepStrictEqual(rule8({ when: 'down', at: 1, do: { mode: 3, action: 'enter' } }).slice(0, 2), [1, 5], 'down + enter: while (momentary)');
  assert.deepStrictEqual(rule8({ when: 'down', at: 1, do: { mode: 3, action: 'leave' } }).slice(0, 2), [1, 3], 'down + leave: tap');
  assert.strictEqual(rule8({ when: 'press', if: { held: [3] }, do: { gamepad: 'A' } })[0], 0x15, 'condition index in the high nibble');
  const w = K.parseSpec({ key: 'W', rules: [{ when: 'press', if: { held: ['Ctrl', 'Fn'], mode: [1, 3], notMode: 2 }, do: { gamepad: 'A' } }] });
  assert.deepStrictEqual(w.rules[0].need, { keys: ['LCtrl', 'Fn'], on: [1, 3], off: [2] }, 'Ctrl means the left one');
  const r = (c, re) => badRule({ when: 'press', if: c, do: { gamepad: 'A' } }, re);
  r('Fn', /rules\[0\]\.if: if is \{ held\?, notHeld\?, mode\?, notMode\? \}/);
  r({}, /if needs held, notHeld, mode or notMode/);
  r({ keys: ['Fn'] }, /unknown field "keys"/);
  r({ held: [] }, /held is a list of 1..3 keys/);
  r({ held: ['A', 'B', 'C', 'D'] }, /held is a list of 1..3 keys/);
  r({ held: 'Fn' }, /held is a list/);
  r({ held: [''] }, /held keys are key names/);
  r({ held: [128] }, /slots 0..127/);
  r({ held: ['Fn', 'fn'] }, /held names a key twice/);
  r({ held: ['LCtrl', 'Ctrl'] }, /held names a key twice/);
  r({ held: ['w'] }, /a key can not be in the condition of its own rule/);
  r({ mode: 33 }, /a mode number is 1..32, not 33/);
  r({ mode: [] }, /mode is a mode \(name or 1..32\) or a list of modes/);
  r({ mode: [1, 1] }, /mode names a mode twice/);
  r({ mode: '' }, /mode is a mode name or 1..32/);
  r({ mode: 'Mouse', notMode: 'mouse' }, /both mode and notMode/);
  const d = (x, re, mode) => badRule({ when: 'press', ...(mode && { mode }), do: x }, re);
  d({ mode: 1 }, /action is enter, leave, toggle/);
  d({ mode: 1, action: 'jump' }, /action is enter, leave, toggle/);
  d({ mode: [1, 2], action: 'enter' }, /mode is one mode/);
  d({ mode: 1, action: 'leave' }, /a mode leave takes mode press, tap \(while only with action enter\)/, 'while');
  d({ mode: 1, action: 'enter' }, /a mode enter takes mode press, tap, while/, 'toggle');
  d({ leaveAllModes: false }, /leaveAllModes is true/);
  d({ leaveAllModes: true }, /leaveAllModes takes mode press, tap/, 'while');
  d({ mode: 1, action: 'enter', extra: 1 }, /unknown field "extra"/);
});

test('condition table: reuse (any key order), allocation, cleanup after, full table refused before writing', async () => {
  const f = v2({ entries: 32 });
  await f.kb.setModeName(1, 'Game');
  const ctrlFn = (key, held) => ({ key, rules: [{ when: 'press', if: { held }, do: { gamepad: 'A' } }] });
  await f.kb.setKeyActions(ctrlFn('W', ['Fn', 'LCtrl']));
  await f.kb.setKeyActions(ctrlFn('A', ['LCtrl', 'Fn']));
  assert.deepStrictEqual(f.conds.filter((e) => e[0] !== 0xff), [[65, 5, 0xff, 0]], 'one entry for both');
  assert.strictEqual(f.table.get(9)[8] >> 4, 1);
  await f.kb.setKeyActions({ key: 'S', rules: [{ when: 'press', if: { mode: 'game' }, do: { gamepad: 'B' } }] });
  assert.deepStrictEqual(f.conds[1], [0xff, 0xff, 0xff, 1], 'next free entry, mode name case-insensitive');
  await f.kb.removeKeyActions('W');
  assert.deepStrictEqual(f.conds[0], [65, 5, 0xff, 0], 'A still uses it');
  f.sent.length = 0;
  await f.kb.removeKeyActions('A');
  assert.deepStrictEqual(f.conds[0], [0xff, 0xff, 0xff, 0], 'cleared once no record uses it');
  const order = writes(f).map((p) => p[1]);
  assert.deepStrictEqual(order, [2, 5], 'record first, then the cleanup');
  // a changed condition on the same key: the new entry is written before the record, the old one cleared after
  f.sent.length = 0;
  await f.kb.setKeyActions({ key: 'S', rules: [{ when: 'press', if: { notMode: 1 }, do: { gamepad: 'B' } }] });
  assert.deepStrictEqual(writes(f).map((p) => [p[1], p[2]]), [[5, 1], [2, 15], [5, 2]]);
  assert.deepStrictEqual(f.conds[0], [0xff, 0xff, 0xff, 0x10]);
  // 15 different conditions fit, a 16th is refused before anything is sent
  const g = v2({ entries: 32 });
  const keys = MAX68HE_KEYS.filter((k) => !['Fn', 'LCtrl', 'LShift', 'LAlt'].includes(k.name) && !/^\d$/.test(k.name));   // digit names read as slots
  const helds = [['Fn'], ['LCtrl'], ['LShift'], ['LAlt']].flatMap((a, i, all) => [a, ...all.slice(i + 1).map((b) => [...a, ...b])]);
  const conds = [...helds, ...[1, 2, 3, 4, 5, 6, 7].map((n) => n)].slice(0, 16);
  const maps = conds.map((c, i) => ({ key: keys[i].name, rules: [{ when: 'press', if: Array.isArray(c) ? { held: c } : { mode: [1, 2, 3].filter((m) => c & (1 << (m - 1))) }, do: { gamepad: 'A' } }] }));
  await g.kb.setKeyActionsBatch({ maps: maps.slice(0, 15) });
  assert.strictEqual(g.conds.filter((e) => e[0] !== 0xff || e[3]).length, 15);
  g.sent.length = 0;
  await assert.rejects(g.kb.setKeyActionsBatch({ maps: [maps[15]] }), (e) => e.status === 400 && /the condition table is full \(15 entries\)/.test(e.message));
  assert.deepStrictEqual(writes(g), [], 'nothing written');
  // replacing a key frees its entry for the new condition
  await g.kb.setKeyActionsBatch({ maps: [{ ...maps[15], key: keys[0].name }] });
  assert.strictEqual(g.conds.filter((e) => e[0] !== 0xff || e[3]).length, 15);
});

test('batch: a bad map anywhere, an unknown name, a full table or a duplicate key writes nothing', async () => {
  const cases = [
    [{ ...EXAMPLE, maps: [...EXAMPLE.maps, { key: 'W', rules: [{ when: 'press', do: { wheel: 0 } }] }] }, /maps\[8\]: rules\[0\]\.do: wheel 0 scrolls nothing/],
    [{ maps: EXAMPLE.maps }, /maps\[0\]: rules\[0\]\.do: no mode named "Mouse" \(name the mode first\)/],
    [{ ...EXAMPLE, maps: [{ key: 'M', rules: [{ when: 'press', if: { held: ['Nope'] }, do: { gamepad: 'A' } }] }] }, /maps\[0\]: rules\[0\]\.if: no key named Nope/],
    [{ ...EXAMPLE, maps: [...EXAMPLE.maps, { key: 'Nope', rules: [] }] }, /maps\[8\]: no key named Nope/],
    [{ ...EXAMPLE, remove: ['M'] }, /M is in the batch twice/],
    [{ ...EXAMPLE, maps: [{ key: 'Fn', rules: [{ when: 'press', if: { held: ['Fn'] }, do: { gamepad: 'A' } }] }] }, /own rule/],
    [{ ...EXAMPLE, modes: [{ id: 1, name: 'Mouse' }, { id: 2, name: 'mouse' }] }, /two modes would be called "mouse"/],
    [{ ...EXAMPLE, modes: [{ id: 4, name: 'X' }] }, /modes\[0\]\.id is a mode number 1..3/],
    [{ ...EXAMPLE, modes: [{ id: 1, name: 'x'.repeat(17) }] }, /modes\[0\]\.name: a mode name is at most 16 bytes/],
    [{ ...EXAMPLE, extra: 1 }, /unknown field "extra"/],
  ];
  for (const [body, re] of cases) {
    const f = v2();
    await assert.rejects(f.kb.setKeyActionsBatch(body), (e) => e.status === 400 && re.test(e.message), String(re));
    assert.deepStrictEqual(writes(f), [], `${re}: nothing written`);
  }
  const small = v2({ entries: 4 });
  await assert.rejects(small.kb.setKeyActionsBatch(EXAMPLE), /the key action table is full: 4 keys can have a map, this would make 8/);
  assert.deepStrictEqual(writes(small), []);
});

test('mode names: round trip, unique, cleared; getModes shows the active ones', async () => {
  const f = v2({ active: 0b101 });
  assert.deepStrictEqual(await f.kb.getModes(), [{ id: 1, name: '', active: true }, { id: 2, name: '', active: false }, { id: 3, name: '', active: true }]);
  assert.deepStrictEqual((await f.kb.setModeName(2, '  Maus ✓ ')).map((m) => m.name), ['', 'Maus ✓', '']);
  assert.deepStrictEqual(f.names, ['', 'Maus ✓', '']);
  await assert.rejects(f.kb.setModeName(3, 'maus ✓'), /another mode is already called "maus ✓"/);
  await assert.rejects(f.kb.setModeName(3, 'x'.repeat(17)), /at most 16 bytes/);
  await assert.rejects(f.kb.setModeName(0, 'x'), /id is a mode number 1..3/);
  await assert.rejects(f.kb.setModeName(1, 5), /name is a string/);
  assert.deepStrictEqual((await f.kb.setModeName(2, '')).map((m) => m.name), ['', '', '']);
});

test('engine 1 firmware: if / modes / mouse keys refused before anything is written; plain maps still work', async () => {
  const f = fakeKeyboard({ keys: MAX68HE_KEYS, entries: 32 });
  for (const body of [EXAMPLE, { maps: [{ key: 'W', rules: [MK()] }] }, { maps: [{ key: 'W', rules: [{ when: 'press', do: { leaveAllModes: true } }] }] },
    { maps: [], modes: [{ id: 1, name: 'X' }] }]) {
    await assert.rejects(f.kb.setKeyActionsBatch(body), (e) => e.status === 400 && /need a newer open firmware/.test(e.message));
  }
  await assert.rejects(f.kb.getModes(), /Modes need a newer open firmware/);
  assert.deepStrictEqual(writes(f), []);
  assert.ok(!f.sent.some((p) => p[0] === 0xee && p[1] >= 4), 'no COND / MODE command to engine 1');
  const m = await f.kb.setKeyActions({ key: 'W', rules: [{ when: 'press', do: { gamepad: 'A' } }] });
  assert.strictEqual(m.summary[0], 'Light press: presses A.');
});

test('flasher backup keeps conditions and mode names; restore writes names, conditions, records and compares', async () => {
  const KM = require('../src/key-map-backup');
  const a = v2();
  await a.kb.setKeyActionsBatch(EXAMPLE);
  const t = await KM.readTable(a.kb);
  assert.deepStrictEqual(t.modeNames, ['Mouse', '', '']);
  assert.deepStrictEqual(t.conditions.slice(0, 3), [[65, 5, 0xff, 0], [0xff, 0xff, 0xff, 1], [0xff, 0xff, 0xff, 0]]);
  assert.strictEqual(t.maps.find((m) => m.key === 'M').map.summary[0], 'While Fn + Left Ctrl are held, hold 3.00 s: enter mode Mouse');
  const kept = JSON.parse(JSON.stringify(t));
  const b = v2();
  const r = await KM.restoreMaps(b.kb, kept);
  assert.deepStrictEqual(r, { restored: 8, problems: [] });
  const order = writes(b).map((p) => p[1]);
  assert.deepStrictEqual(order, [7, 5, 5, 2, 2, 2, 2, 2, 2, 2, 2], 'names, conditions, records');
  assert.deepStrictEqual([...b.table].sort(), [...a.table].sort());
  assert.deepStrictEqual(b.names, a.names);
  assert.deepStrictEqual((await b.kb.getKeyActions('Up')).rules[0].do, (await a.kb.getKeyActions('Up')).rules[0].do);
  assert.deepStrictEqual([b.table.get(82)[16 + 1], b.table.get(82)[16 + 7]], [15, 1], 'sharing ARG rule restored (keep 150 ms, shared)');
  // a condition that reads back different is reported
  const c = v2({ set: () => undefined });
  const real = c.kb._kaSetCond.bind(c.kb);
  c.kb._kaSetCond = (n, e) => real(n, n === 2 ? [0xff, 0xff, 0xff, 2] : e);
  assert.deepStrictEqual((await KM.restoreMaps(c.kb, kept)).problems, [{ slot: null, key: 'condition 2', why: 'reads back different' }]);
  // engine 1 after the flash: nothing written, one clear problem
  const old = fakeKeyboard({ keys: MAX68HE_KEYS, entries: 32 });
  assert.match((await KM.restoreMaps(old.kb, kept)).problems[0].why, /conditions, modes or mouse keys/);
  assert.deepStrictEqual(writes(old), []);
  // a v1 backup (just maps) still restores
  const plain = v2();
  assert.deepStrictEqual(await KM.restoreMaps(plain.kb, [{ slot: 14, key: 'W', record: K.toRecord(K.parseSpec({ key: 'W', rules: [{ when: 'press', do: { gamepad: 'A' } }] }), 14) }]), { restored: 1, problems: [] });
});

test('profile export / import carries conditions and mode names; a bad table is refused first', async () => {
  const board = (f) => Object.assign(f.kb, {
    async getProfile() { return 0; }, async readColumn() { return new Array(128).fill(0); },
    async readDksAll() { return Array.from({ length: 128 }, () => [0, 0, 0, 0]); },
    async getKeymap() { return Array.from({ length: 128 }, () => [0, 0, 0, 0]); },
    async getFnKeymap() { return Array.from({ length: 128 }, () => [0, 0, 0, 0]); },
    async hasDksLevels() { return false; }, async getReportRate() { return 1000; },
    async getLighting() { return { mode: 1, speed: 2, brightness: 3, option: 0, rainbow: false, presetColour: null, r: 1, g: 2, b: 3 }; },
    async getOptions() { return { os: 'win', fnIndex: 0, antiMistouch: false, rtStability: 0, wasdSwap: false }; },
    async setKey() {}, async setLighting() {}, async setReportRate() {}, async setOptions() {},
  }) && f;
  const a = board(v2());
  await a.kb.setKeyActionsBatch(EXAMPLE);
  const data = JSON.parse(JSON.stringify(await a.kb.exportProfile()));
  assert.deepStrictEqual(data.keyActions.modeNames, ['Mouse', '', '']);
  assert.strictEqual(data.keyActions.conditions.length, 15);
  const b = board(v2());
  await b.kb.setKeyActionsBatch({ maps: [{ key: 'W', rules: [{ when: 'press', if: { held: ['Q'] }, do: { gamepad: 'A' } }] }] });
  const r = await b.kb.importProfile(data, () => {}, { backupDir: null });
  assert.deepStrictEqual([...b.table].sort(), [...a.table].sort());
  assert.deepStrictEqual(b.names, ['Mouse', '', '']);
  assert.deepStrictEqual(b.conds, a.conds, 'W\'s old condition was replaced, nothing left over');
  assert.strictEqual(r.keyMaps.written, 8);
  for (const [spoil, re] of [[(d) => { d.keyActions.conditions[0] = [65, 65, 0xff, 0]; }, /condition 1: keys are distinct/],
    [(d) => { d.keyActions.conditions[1] = [0xff, 0xff, 0xff, 0]; }, /a rule uses condition entry 2, which is not in the file/],
    [(d) => { d.keyActions.modeNames = ['a', 'A', '']; }, /two modes share a name/]]) {
    const d = JSON.parse(JSON.stringify(data));
    spoil(d);
    const c = board(v2());
    await assert.rejects(c.kb.importProfile(d, () => {}, { backupDir: null }), re);
    assert.deepStrictEqual(c.sent.filter((p) => p[0] === 0xee), [], `${re}: nothing sent`);
  }
  const old = board(fakeKeyboard({ keys: MAX68HE_KEYS, entries: 32 }));
  const o = await old.kb.importProfile(data, () => {}, { backupDir: null });
  assert.match(o.notes[0], /need a newer open firmware; they were not written/);
  assert.deepStrictEqual(writes(old), []);
});

test('REST: batch and modes check shapes before the keyboard; GET adds modes and engine; MCP tools', async () => {
  const { keyActionRoutes } = require('../src/web/key-action-routes');
  const httpError = (status, msg) => Object.assign(new Error(msg), { status });
  let opened = 0;
  const f = v2();
  const R = keyActionRoutes({ keyboard: async () => { opened++; return f.kb; }, httpError });
  await assert.rejects(R['POST /api/key-actions/batch']({}), /the batch is \{ maps/);
  await assert.rejects(R['POST /api/key-actions/batch']({ maps: [{ key: 'W', rules: [MK({ max: 1 })] }] }), /maps\[0\]: rules\[0\]\.do: max/);
  await assert.rejects(R['POST /api/modes']({ id: 4, name: 'x' }), /id is a mode number 1..3/);
  await assert.rejects(R['POST /api/modes']({ id: 1 }), /name is a string/);
  assert.deepStrictEqual((await R['POST /api/key-actions/preview'](EXAMPLE.maps[0])).summary, ['While Fn + Left Ctrl are held, hold 3.00 s: enter mode Mouse']);
  assert.strictEqual(opened, 0);
  assert.deepStrictEqual((await R['POST /api/modes']({ id: 1, name: 'Mouse' })).modes[0], { id: 1, name: 'Mouse', active: false });
  const r = await R['POST /api/key-actions/batch']({ maps: EXAMPLE.maps });
  assert.strictEqual(r.maps.length, 8);
  const all = await R['GET /api/key-actions']({});
  assert.deepStrictEqual([all.engine, all.modes[0].name, all.maps.length], [3, 'Mouse', 8]);
  assert.deepStrictEqual((await R['GET /api/modes']()).modes.map((m) => m.name), ['Mouse', '', '']);
  const { server } = require('../src/mcp');
  const t = server._registeredTools;
  assert.ok(t.get_modes && t.set_mode_name);
  assert.ok(t.set_key_actions.inputSchema.safeParse(EXAMPLE).success);
  assert.match(t.set_key_actions.description, /mouseKeys/);
});

test('flash rule (output 11): [trigger, TIMES, tval, 11, R, G, B], defaults, every refusal', () => {
  assert.deepStrictEqual(rule8({ when: 'press', do: { flash: [255, 0, 255], times: 5 } }), [0x05, 5, 0, 0, 0x0b, 0xff, 0x00, 0xff], 'the firmware doc example');
  assert.deepStrictEqual(rule8({ when: 'hold', ms: 300, do: { flash: true } }), [3, 3, 44, 1, 11, 0, 0, 0], 'true = green (0,0,0), default 3 times');
  assert.deepStrictEqual(rule8({ when: 'tap', ms: 200, do: { flash: '#010203', times: 15 } }), [4, 15, 200, 0, 11, 1, 2, 3]);
  assert.deepStrictEqual(rule8({ when: 'down', at: 1.5, do: { flash: 'FF8000', times: 1 } }), [1, 1, 150, 0, 11, 255, 128, 0], 'any trigger, its tval');
  assert.deepStrictEqual(rule8({ when: 'release', if: { mode: 1 }, do: { flash: [0, 0, 255], times: 2 } }), [0x16, 2, 0, 0, 11, 0, 0, 255], 'condition nibble');
  for (const [d, re] of [[{ flash: true, times: 0 }, /times is a whole number within 1..15/], [{ flash: true, times: 16 }, /times is a whole number within 1..15/],
    [{ flash: true, times: 2.5 }, /times/], [{ flash: [0, 0, 0] }, /black \(0, 0, 0\) can't flash.*flash: true/], [{ flash: '#000000' }, /black/],
    [{ flash: 'cyan' }, /flash is true \(the default green\), \[r, g, b\]/], [{ flash: [1, 2] }, /flash is true/], [{ flash: false }, /flash is true/],
    [{ flash: true, color: 'x' }, /unknown field "color"/]]) {
    badRule({ when: 'press', do: d }, re);
  }
  badRule({ when: 'press', mode: 'tap', do: { flash: true } }, /a flash has no mode/);
  badRule({ when: 'hold', ms: 5, do: { flash: true } }, /ms is a whole number within 10..10000/);
  assert.ok(K.usesFlash(K.parseSpec({ key: 'W', rules: [{ when: 'press', do: { flash: true } }] })));
  assert.ok(!K.usesModes(K.parseSpec({ key: 'W', rules: [{ when: 'press', do: { flash: true } }] })), 'not an engine 2 output');
});

test('flash rule decode: output 11 is never a mode (its mode byte is the count); round trip', () => {
  const rec = (rules) => P.encodeKaRecord({ slot: 14, rules });
  // mode byte 1..5 would read as press / release / tap / toggle / while, and a, b as a mode reference (output 10)
  for (const times of [1, 2, 3, 4, 5, 15]) {
    const r = K.fromRecord(rec([{ trigger: 5, mode: times, tval: 0, output: 11, a: 1, b: 3, c: 0 }]), 'W').rules[0];
    assert.deepStrictEqual(r, { when: 'press', do: { flash: '#010300', times } }, `times ${times}`);
    assert.ok(!('mode' in r) && !('action' in r.do));
  }
  const ten = K.fromRecord(rec([{ trigger: 5, mode: 1, tval: 0, output: 10, a: 1, b: 3, c: 0 }]), 'W').rules[0];
  assert.deepStrictEqual(ten.do, { mode: 1, action: 'toggle' }, 'output 10 still reads as a mode change');
  const green = K.fromRecord(rec([{ trigger: 3, mode: 2, tval: 500, output: 11, a: 0, b: 0, c: 0 }]), 'W');
  assert.deepStrictEqual(green.rules[0], { when: 'hold', ms: 500, do: { flash: true, times: 2 } });
  assert.deepStrictEqual(green.summary, ['Hold 0.50 s: flash the hold bar column 2 times']);
  // a DEPTH rule whose output byte (pressFrom 1.1 mm) is 11 stays a mouse keys rule
  const mk = K.parseSpec({ key: 'W', rules: [MK({ speedBy: 'pressure', pressFrom: 1.1 })] });
  assert.ok(!K.usesFlash(mk) && mk.rules[2].output === 11);
  assert.strictEqual(K.fromRecord(K.toRecord(mk, 14), 'W').rules[0].do.pressFrom, 1.1);
  // JSON -> record -> JSON -> record: the same bytes
  const spec = { key: 'W', rules: [{ when: 'press', do: { flash: [255, 0, 255], times: 5 } }, { when: 'hold', ms: 300, if: { mode: 2 }, do: { flash: true, times: 1 } },
    { when: 'tap', ms: 200, do: { flash: '#00ff00' } }] };
  const bytes = K.toRecord(K.parseSpec(spec), 14, () => 1);
  const back = K.fromRecord(bytes, 'W', { conds: [[0xff, 0xff, 0xff, 0x02]] });
  assert.deepStrictEqual(back.rules.map((r) => r.do), [{ flash: '#ff00ff', times: 5 }, { flash: true, times: 1 }, { flash: '#00ff00', times: 3 }]);
  assert.deepStrictEqual(K.toRecord(K.parseSpec(back), 14, () => 1), bytes);
  assert.deepStrictEqual(K.preview(spec).rules[2], { when: 'tap', ms: 200, do: { flash: '#00ff00', times: 3 } });
});

test('flash rule: only to firmware with caps modeFlash (word 3 bit 9), refused before anything is written', async () => {
  const map = { key: 'W', rules: [{ when: 'press', do: { flash: [255, 0, 255], times: 5 } }] };
  for (const caps3 of [0, 0xc100, 0x0200]) {
    const f = v2({ engine: 5, caps3 });
    await assert.rejects(f.kb.setKeyActions(map), (e) => e.status === 400 && /A flash \(do: \{ flash \}\) needs a newer open firmware \(feature "modeFlash"\)/.test(e.message));
    await assert.rejects(f.kb.setKeyActionsBatch({ maps: [{ key: 'A', rules: [{ when: 'press', do: { key: 'B' } }] }, map] }), /modeFlash/);
    assert.deepStrictEqual(writes(f), [], `caps3 ${caps3.toString(16)}: nothing written`);
  }
  const f = v2({ engine: 5, caps3: 0xc300 });
  const stored = await f.kb.setKeyActions(map);
  assert.deepStrictEqual(stored.rules, [{ when: 'press', do: { flash: '#ff00ff', times: 5 } }]);
  assert.deepStrictEqual(f.table.get(14).slice(8, 16), [5, 5, 0, 0, 11, 255, 0, 255]);
  assert.deepStrictEqual((await f.kb.getKeyActions('W')).rules, stored.rules, 'read back');
  // the engine is not what decides: engine 1 firmware with the caps bit takes a flash
  const e1 = fakeKeyboard({ keys: MAX68HE_KEYS, caps3: 0x8200 });
  assert.deepStrictEqual((await e1.kb.setKeyActions(map)).rules[0].do, { flash: '#ff00ff', times: 5 });
});
