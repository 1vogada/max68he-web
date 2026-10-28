// Key action maps (open firmware 0xEE, caps 'keyActions'): the packets and the 56-byte record
// (must match the firmware contract), the JSON form's defaults and validation (src/key-actions.js),
// the summary sentences, the caps gate and the driver calls against a fake firmware table.
const test = require('node:test');
const assert = require('node:assert');
const P = require('../src/protocol');
const K = require('../src/key-actions');
const C = require('../web/key-actions-core');

const rec = (spec, slot = 14) => K.toRecord(K.parseSpec(spec), slot);
const rule8 = (r) => rec({ slot: 14, rules: [r] }).slice(8, 16);
const bad = (spec, re) => assert.throws(() => K.parseSpec(spec), (e) => e.status === 400 && re.test(e.message), `${JSON.stringify(spec)} -> ${re}`);
const badRule = (r, re) => bad({ key: 'W', rules: [r] }, re);

test('protocol: "keyActions" is CAPS2 bit 15; 0xEE INFO / GET / SET / LIST packets', () => {
  assert.deepStrictEqual(P.parseCaps([0xf8, 4, 120, 68, 15, 8, 0, 0, 0x00, 0x80]).features, ['keyActions']);
  assert.deepStrictEqual(P.kaInfoPacket().slice(0, 8), [0xee, 0, 0, 0, 0, 0, 0, P.checksum([0xee, 0, 0, 0, 0, 0, 0], 7)]);
  assert.deepStrictEqual(P.kaGetPacket(14).slice(0, 3), [0xee, 1, 14]);
  assert.deepStrictEqual(P.kaListPacket(30).slice(0, 3), [0xee, 3, 30]);
  const r = rec({ slot: 14, rules: [{ when: 'press', do: { gamepad: 'A' } }] });
  const set = P.kaSetPacket(14, r);
  assert.strictEqual(set.length, 64);
  assert.deepStrictEqual(set.slice(0, 3), [0xee, 2, 14]);
  assert.strictEqual(set[7], P.checksum(set, 7));
  assert.deepStrictEqual(set.slice(8), r);
  assert.throws(() => P.kaGetPacket(128), /slot out of range/);
  assert.throws(() => P.kaSetPacket(1, [0]), /56 bytes/);
  assert.deepStrictEqual(P.parseKaInfo([0xee, 0, 0, 0, 0, 0, 0, 0, 32, 6, 3, 56]), { entries: 32, maxRules: 6, used: 3, recordBytes: 56, engine: 1, conditions: 0, modes: 0, activeModes: 0 });
});

test('record header: slot, n, gap, flags, press LE, defaults 0.30 mm / 0.10 mm', () => {
  assert.deepStrictEqual(rec({ slot: 14, rules: [] }).slice(0, 8), [14, 0, 10, 0, 30, 0, 0, 0]);
  assert.deepStrictEqual(rec({ key: 'W', press: 3.99, gap: 0.5, alsoType: true, rules: [] }, 3).slice(0, 8), [3, 0, 50, 1, 0x8f, 0x01, 0, 0]);
  assert.strictEqual(rec({ key: 'W', rules: [] }).length, 56);
  const six = rec({ key: 'W', rules: Array.from({ length: 6 }, () => ({ when: 'press', do: { gamepad: 'A' } })) });
  assert.strictEqual(six[1], 6);
  assert.deepStrictEqual(six.slice(48, 56), [5, 1, 0, 0, 2, 11, 0, 0]);
  assert.deepStrictEqual(rec({ key: 'W', rules: [{ when: 'press', do: { gamepad: 'A' } }] }).slice(16), new Array(40).fill(0), 'unused rules all 0');
});

test('rule bytes per trigger and mode: [trigger, mode, tval LE, output, a, b, c]', () => {
  const A = { gamepad: 'A' };
  assert.deepStrictEqual(rule8({ when: 'down', at: 2.5, do: A }), [1, 5, 250, 0, 2, 11, 0, 0], 'down: while by default');
  assert.deepStrictEqual(rule8({ when: 'up', at: 0.1, do: A }), [2, 3, 10, 0, 2, 11, 0, 0], 'up: tap by default');
  assert.deepStrictEqual(rule8({ when: 'hold', ms: 3000, do: A }), [3, 1, 0xb8, 0x0b, 2, 11, 0, 0], 'hold: press by default');
  assert.deepStrictEqual(rule8({ when: 'tap', ms: 10000, do: A }), [4, 3, 0x10, 0x27, 2, 11, 0, 0], 'tap: tap by default');
  assert.deepStrictEqual(rule8({ when: 'press', do: A }), [5, 1, 0, 0, 2, 11, 0, 0], 'press: press by default');
  assert.deepStrictEqual(rule8({ when: 'release', do: A }), [6, 3, 0, 0, 2, 11, 0, 0], 'release: tap by default');
  assert.deepStrictEqual(rule8({ when: 'down', at: 4, mode: 'press', do: A }).slice(0, 4), [1, 1, 144, 1]);
  assert.deepStrictEqual(rule8({ when: 'down', at: 1.234, mode: 'release', do: A }).slice(0, 4), [1, 2, 123, 0], 'at rounds to 0.01 mm');
  assert.deepStrictEqual(rule8({ when: 'down', at: 1, mode: 'tap', do: A }).slice(0, 2), [1, 3]);
  assert.deepStrictEqual(rule8({ when: 'hold', ms: 10, mode: 'toggle', do: A }).slice(0, 4), [3, 4, 10, 0]);
  assert.deepStrictEqual(rule8({ when: 'press', mode: 'while', do: A }).slice(0, 2), [5, 5]);
});

test('rule bytes per output', () => {
  const o = (d, mode) => rule8({ when: 'press', ...(mode && { mode }), do: d }).slice(4);
  assert.deepStrictEqual(o({ key: 'Shift' }), [1, 0x02, 0, 0], 'a modifier alone: bits only');
  assert.deepStrictEqual(o({ key: 'Ctrl+C' }), [1, 0x01, 0x06, 0]);
  assert.deepStrictEqual(o({ key: 'E' }), [1, 0, 0x08, 0]);
  assert.deepStrictEqual(o({ key: 'RShift+F12' }), [1, 0x20, 0x45, 0]);
  assert.deepStrictEqual(o({ gamepad: 'A' }), [2, 11, 0, 0]);
  assert.deepStrictEqual(o({ gamepad: 'lb' }), [2, 15, 0, 0], 'case does not matter');
  assert.deepStrictEqual(o({ gamepad: 'Right' }), [2, 24, 0, 0]);
  assert.deepStrictEqual(o({ axis: 'LX-', percent: 1 }), [3, 1, 1, 0]);
  assert.deepStrictEqual(o({ axis: 'LY-', percent: 40 }), [3, 3, 40, 0]);
  assert.deepStrictEqual(o({ axis: 'RT', percent: 100 }), [3, 10, 100, 0]);
  assert.deepStrictEqual(o({ axis: 'LT', from: 0, to: 4 }), [4, 9, 0, 40]);
  assert.deepStrictEqual(o({ axis: 'RY+', from: 1.04, to: 2.96 }), [4, 8, 10, 30], 'from / to round to 0.1 mm');
  assert.deepStrictEqual(o({ mouse: 'L' }), [5, 1, 0, 0]);
  assert.deepStrictEqual(o({ mouse: 'right' }), [5, 2, 0, 0]);
  assert.deepStrictEqual(o({ mouse: 'L+R+M' }), [5, 7, 0, 0]);
  assert.deepStrictEqual(o({ move: [-128, 127] }), [6, 0x80, 0x7f, 0]);
  assert.deepStrictEqual(o({ glide: [508, -512], ms: 500 }), [7, 127, 0x80, 50]);
  assert.deepStrictEqual(o({ glide: [6, 0], ms: 2550 }), [7, 2, 0, 255], 'dx / 4 rounded, ms / 10');
  assert.deepStrictEqual(o({ wheel: -128 }), [8, 0x80, 0, 0]);
  assert.deepStrictEqual(o({ wheel: 3 }), [8, 3, 0, 0]);
  // once-outputs default to tap even on press / down
  assert.deepStrictEqual(rule8({ when: 'down', at: 1, do: { wheel: 1 } }).slice(0, 2), [1, 3]);
  assert.deepStrictEqual(rule8({ when: 'press', mode: 'press', do: { move: [1, 0] } }).slice(0, 2), [5, 1]);
});

test('decode: every output back to the JSON form, defaults filled, summary added', () => {
  const spec = { key: 'W', press: 0.5, gap: 0.2, alsoType: true, rules: [
    { when: 'press', mode: 'press', do: { key: 'LShift+E' } }, { when: 'down', at: 2.5, mode: 'while', do: { axis: 'LY-', percent: 100 } },
    { when: 'up', at: 1, mode: 'toggle', do: { axis: 'LT', from: 0.5, to: 3 } }, { when: 'hold', ms: 3000, mode: 'press', do: { mouse: 'L+M' } },
    { when: 'tap', ms: 200, mode: 'tap', do: { move: [-5, 9] } }, { when: 'release', mode: 'tap', do: { glide: [-200, 40], ms: 1000 } },
  ] };
  const back = K.fromRecord(rec(spec), 'W');
  assert.deepStrictEqual({ ...back, summary: undefined }, { ...spec, slot: 14, summary: undefined });
  assert.strictEqual(back.summary.length, 7);
  const zero = K.fromRecord([5, 0, 0, 0, 0, 0, 0, 0, ...new Array(48).fill(0)]);
  assert.deepStrictEqual(zero, { slot: 5, press: 0.3, gap: 0.1, alsoType: false, rules: [], summary: [] }, 'wire 0 = defaults');
  assert.deepStrictEqual(K.fromRecord(rec({ key: 'W', rules: [{ when: 'press', do: { wheel: -1 } }] })).rules[0].do, { wheel: -1 });
  assert.deepStrictEqual(K.fromRecord(rec({ key: 'W', rules: [{ when: 'press', do: { gamepad: 'Start' } }] })).rules[0].do, { gamepad: 'Start' });
});

test('validation: the map', () => {
  bad(null, /the map is \{ key \| slot/);
  bad([], /the map is/);
  bad({ rules: [] }, /give key \(like "W"\) or slot/);
  bad({ key: '', rules: [] }, /key is a key name/);
  bad({ slot: 128, rules: [] }, /slot is a whole number within 0..127/);
  bad({ slot: 1.5, rules: [] }, /slot is a whole number/);
  bad({ key: 'W', rules: [], colour: 'red' }, /unknown field "colour"/);
  bad({ key: 'W' }, /rules is a list/);
  bad({ key: 'W', rules: new Array(7).fill({ when: 'press', do: { gamepad: 'A' } }) }, /at most 6 rules per key, not 7/);
  bad({ key: 'W', press: 0, rules: [] }, /press is a number within 0.01..4 mm/);
  bad({ key: 'W', press: 4.01, rules: [] }, /press is a number within 0.01..4 mm/);
  bad({ key: 'W', press: '1', rules: [] }, /press is a number/);
  bad({ key: 'W', gap: 0, rules: [] }, /gap is a number within 0.01..0.5 mm/);
  bad({ key: 'W', gap: 0.6, rules: [] }, /gap is a number within 0.01..0.5 mm/);
  bad({ key: 'W', alsoType: 1, rules: [] }, /alsoType is true or false/);
  assert.doesNotThrow(() => K.parseSpec({ key: 'W', rules: [], summary: ['ignored'] }), 'summary from a get is ignored');
});

test('validation: triggers, depths, times, modes', () => {
  const A = { gamepad: 'A' };
  badRule('press', /rules\[0\]: a rule is/);
  badRule({ when: 'later', do: A }, /rules\[0\]: when is down, up, hold, tap, press, release/);
  badRule({ when: 'press', do: A, extra: 1 }, /unknown field "extra"/);
  badRule({ when: 'down', do: A }, /at is a number within 0.1..4 mm/);
  badRule({ when: 'down', at: 0.09, do: A }, /at is a number within 0.1..4 mm/);
  badRule({ when: 'up', at: 4.1, do: A }, /at is a number within 0.1..4 mm/);
  badRule({ when: 'down', at: 1, ms: 5, do: A }, /down takes at \(mm\), not ms/);
  badRule({ when: 'hold', do: A }, /ms is a whole number within 10..10000/);
  badRule({ when: 'hold', ms: 9, do: A }, /ms is a whole number within 10..10000/);
  badRule({ when: 'tap', ms: 10001, do: A }, /ms is a whole number within 10..10000/);
  badRule({ when: 'tap', ms: 100.5, do: A }, /ms is a whole number/);
  badRule({ when: 'hold', ms: 100, at: 1, do: A }, /hold takes ms, not at/);
  badRule({ when: 'press', at: 1, do: A }, /press takes no at or ms/);
  badRule({ when: 'release', ms: 1, do: A }, /release takes no at or ms/);
  badRule({ when: 'press', mode: 'forever', do: A }, /mode is press, release, tap, toggle, while/);
  for (const when of ['up', 'tap', 'release']) {
    badRule({ when, ...(when === 'up' && { at: 1 }), ...(when === 'tap' && { ms: 100 }), mode: 'while', do: A }, new RegExp(`mode "while" works with down, hold and press, not ${when}`));
  }
  for (const mode of ['tap', 'release']) badRule({ when: 'press', mode, do: { axis: 'LT', from: 0, to: 2 } }, /follows the depth .* takes mode press, while or toggle/);
  for (const mode of ['while', 'toggle', 'release']) badRule({ when: 'press', mode, do: { wheel: 1 } }, /wheel happens once: mode tap or press/);
  badRule({ when: 'press', mode: 'toggle', do: { move: [1, 1] } }, /move happens once/);
  badRule({ when: 'press', mode: 'while', do: { glide: [8, 0], ms: 100 } }, /glide happens once/);
});

test('validation: outputs', () => {
  const o = (d, re) => badRule({ when: 'press', do: d }, re);
  o(undefined, /rules\[0\]: do is \{ key \}/);
  o({}, /do is \{ key \}/);
  o({ jump: true }, /do is \{ key \}/);
  o({ key: 'A', gamepad: 'B' }, /unknown field "gamepad"/);
  o({ key: '' }, /key is a key name/);
  o({ key: 'Nope' }, /rules\[0\]\.do: not a keyboard key: Nope/);
  o({ key: 'VolumeUp' }, /not a keyboard key/);
  o({ key: 'A+B' }, /one key plus modifiers at most/);
  o({ key: 'none' }, /key "none" sends nothing/);
  o({ key: 'usage:240' }, /"usage:240" is not a keyboard key/);
  o({ gamepad: 'Z' }, /gamepad is one of A, B, X, Y, LB, RB, Back, Start, LS, RS, Up, Down, Left, Right/);
  o({ gamepad: 'LT' }, /use axis/);
  o({ axis: 'LZ', percent: 5 }, /axis is one of LX-, LX\+/);
  o({ axis: 'LX-' }, /percent is a whole number within 1..100/);
  o({ axis: 'LX-', percent: 0 }, /percent is a whole number within 1..100/);
  o({ axis: 'LX-', percent: 101 }, /percent/);
  o({ axis: 'LX-', percent: 50, from: 1 }, /unknown field "percent"/);
  o({ axis: 'LX-', from: 2, to: 2 }, /to must be at least 0.1 mm deeper than from/);
  o({ axis: 'LX-', from: 2.04, to: 1.96 }, /to must be at least/);
  o({ axis: 'LX-', from: -1, to: 2 }, /from is a number within 0..4 mm/);
  o({ axis: 'LX-', from: 1, to: 4.5 }, /to is a number within 0..4 mm/);
  o({ mouse: 'X' }, /mouse is L, R or M/);
  o({ mouse: 'L+' }, /mouse is L, R or M/);
  o({ move: 5 }, /move is \[dx, dy\]/);
  o({ move: [1, 2, 3] }, /move is \[dx, dy\]/);
  o({ move: [128, 0] }, /dx is a whole number within -128..127/);
  o({ move: [0, -129] }, /dy is a whole number within -128..127/);
  o({ move: [0, 0] }, /goes nowhere/);
  o({ glide: [100, 0] }, /ms is a number within 10..2550/);
  o({ glide: [509, 0], ms: 100 }, /dx is a whole number within -512..508/);
  o({ glide: [1, -1], ms: 100 }, /less than 2 px goes nowhere/);
  o({ glide: [100, 0], ms: 2551 }, /ms is a number within 10..2550/);
  o({ wheel: 0 }, /wheel 0 scrolls nothing/);
  o({ wheel: 128 }, /wheel is a whole number within -128..127/);
  o({ wheel: 1.5 }, /wheel is a whole number/);
});

test('defaults: modes per trigger, once-outputs tap, header defaults', () => {
  assert.deepStrictEqual(C.DEFAULT_MODE, { down: 'while', up: 'tap', hold: 'press', tap: 'tap', press: 'press', release: 'tap' });
  assert.strictEqual(C.defaultMode({ when: 'down', do: { glide: [4, 0], ms: 10 } }), 'tap');
  assert.strictEqual(C.defaultMode({ when: 'hold', do: { key: 'A' } }), 'press');
  assert.deepStrictEqual(C.allowedModes('up', 'key'), ['press', 'release', 'tap', 'toggle']);
  assert.deepStrictEqual(C.allowedModes('down', 'axisDepth'), ['press', 'toggle', 'while']);
  assert.deepStrictEqual(C.allowedModes('down', 'wheel'), ['press', 'tap']);
  const p = K.preview({ rules: [{ when: 'press', do: { gamepad: 'A' } }] });
  assert.deepStrictEqual([p.press, p.gap, p.alsoType, p.rules[0].mode], [0.3, 0.1, false, 'press']);
});

test('summaries: plain sentences per rule', () => {
  const s = (rules, extra = {}) => C.summary({ rules, ...extra });
  assert.deepStrictEqual(s([{ when: 'press', do: { axis: 'LY-', percent: 40 } }, { when: 'down', at: 2.5, do: { axis: 'LY-', percent: 100 } },
    { when: 'hold', ms: 3000, do: { gamepad: 'LB' } }]), ['Light press: left stick up 40 %.', 'Past 2.50 mm: left stick up 100 %.', 'Held 3 s: presses LB.']);
  assert.deepStrictEqual(s([{ when: 'down', at: 3.2, mode: 'while', do: { key: 'LShift' } }]), ['Past 3.20 mm: holds Shift.']);
  assert.deepStrictEqual(s([{ when: 'tap', ms: 500, do: { gamepad: 'A' } }]), ['Quick tap (let go within 500 ms): taps A.']);
  assert.deepStrictEqual(s([{ when: 'hold', ms: 1500, do: { gamepad: 'Up' } }]), ['Held 1.5 s: presses D-pad up.']);
  assert.deepStrictEqual(s([{ when: 'down', at: 2.5, mode: 'toggle', do: { key: 'LCtrl' } }]), ['Past 2.50 mm: turns Ctrl on or off.']);
  assert.deepStrictEqual(s([{ when: 'up', at: 1, mode: 'release', do: { axis: 'RT', percent: 50 } }]), ['Back above 1.00 mm: lets go of right trigger.']);
  assert.deepStrictEqual(s([{ when: 'release', do: { wheel: 2 } }]), ['Let go: scrolls 2 notches up.']);
  assert.deepStrictEqual(s([{ when: 'press', do: { move: [10, -5] } }]), ['Light press: moves the mouse 10 px right and 5 px up.']);
  assert.deepStrictEqual(s([{ when: 'press', do: { glide: [0, 200], ms: 500 } }]), ['Light press: glides the mouse 200 px down over 500 ms.']);
  assert.deepStrictEqual(s([{ when: 'press', mode: 'while', do: { axis: 'LT', from: 0.5, to: 3 } }]), ['Light press: left trigger, deeper = further (0.50 mm to 3.00 mm).']);
  assert.deepStrictEqual(s([{ when: 'press', do: { mouse: 'R' } }], { alsoType: true }), ['Light press: presses the right mouse button.', 'It still types its own key too.']);
  assert.deepStrictEqual(s([{ when: 'press', mode: 'tap', do: { axis: 'RX+', percent: 20 } }]), ['Light press: flicks right stick right 20 %.']);
});

test('templates -> rules, and back to answers', () => {
  const rules = (id) => C.answersToSpec({ key: 'W', answers: C.templateAnswers(id) }).rules;
  assert.deepStrictEqual(rules('walkRun'), [{ when: 'press', mode: 'press', do: { axis: 'LY-', percent: 40 } }, { when: 'down', at: 2.5, mode: 'while', do: { axis: 'LY-', percent: 100 } }]);
  assert.deepStrictEqual(rules('walkRunSprint').map((r) => [r.when, r.at, r.do]), [['press', undefined, { axis: 'LY-', percent: 40 }],
    ['down', 2.2, { axis: 'LY-', percent: 100 }], ['down', 3.2, { key: 'LShift' }]]);
  assert.deepStrictEqual(rules('aimShoot').map((r) => [r.at, r.do.axis, r.do.percent]), [[1.5, 'RT', 50], [3.2, 'RT', 100]]);
  assert.deepStrictEqual(rules('tapHold'), [{ when: 'tap', ms: 500, mode: 'tap', do: { gamepad: 'A' } }, { when: 'hold', ms: 500, mode: 'press', do: { gamepad: 'B' } }]);
  assert.deepStrictEqual(rules('holdTo'), [], 'hold to … waits for an answer');
  assert.deepStrictEqual(rules('toggleDeep'), [{ when: 'down', at: 2.5, mode: 'toggle', do: { key: 'LCtrl' } }]);
  assert.deepStrictEqual(rules('scratch'), []);
  assert.throws(() => C.templateAnswers('nope'), /unknown template/);
  for (const t of C.TEMPLATES) {
    const spec = C.answersToSpec({ key: 'W', answers: C.templateAnswers(t.id) });
    assert.doesNotThrow(() => K.parseSpec(spec), t.id);
    const back = C.specToAnswers(K.fromRecord(K.toRecord(K.parseSpec(spec), 14)));
    assert.deepStrictEqual(C.answersToSpec({ key: 'W', ...back }).rules, spec.rules, `${t.id} round trip`);
  }
  // a mode the output can't take falls back to its default; unasked rules are kept as extras
  assert.strictEqual(C.answersToSpec({ answers: { ...C.blankAnswers(), deep: { at: 2, mode: 'toggle', do: { wheel: 1 } } } }).rules[0].mode, 'tap');
  const a = C.specToAnswers({ rules: [{ when: 'down', at: 3.3, mode: 'while', do: { key: 'A' } }, { when: 'up', at: 1, mode: 'tap', do: { key: 'B' } },
    { when: 'press', mode: 'press', do: { key: 'C' } }, { when: 'press', mode: 'press', do: { key: 'D' } }] });
  assert.strictEqual(a.answers.bottom.at, 3.3, 'a lone deep rule reads as the bottom');
  assert.strictEqual(a.answers.deep.do, null);
  assert.deepStrictEqual(a.extra.map((r) => r.do.key), ['B', 'D']);
});

const { fakeKeyboard } = require('./fixtures/ka-fake');

const WALK = { key: 'W', rules: [{ when: 'press', do: { axis: 'LY-', percent: 40 } }, { when: 'down', at: 2.5, do: { axis: 'LY-', percent: 100 } }] };

test('driver: set, get one, list (paged), remove, info; refusals', async () => {
  const { kb, table } = fakeKeyboard();
  const got = await kb.setKeyActions(WALK);
  assert.deepStrictEqual(got.summary, ['Light press: left stick up 40 %.', 'Past 2.50 mm: left stick up 100 %.']);
  assert.strictEqual(got.slot, 14);
  assert.deepStrictEqual(table.get(14), rec(WALK, 14));
  await kb.setKeyActions({ slot: 9, rules: [{ when: 'hold', ms: 3000, do: { gamepad: 'LB' } }] });
  await kb.setKeyActions({ key: 'D', alsoType: true, rules: [{ when: 'tap', ms: 200, do: { key: 'E' } }] });
  assert.strictEqual((await kb.getKeyActions('W')).rules[1].at, 2.5);
  assert.strictEqual((await kb.getKeyActions(9)).key, 'A');
  assert.strictEqual(await kb.getKeyActions('S'), null);
  assert.deepStrictEqual((await kb.getKeyActions()).map((m) => m.key), ['A', 'W', 'D'], 'all three over two LIST pages');
  assert.deepStrictEqual(await kb.keyActionsInfo(), { entries: 4, maxRules: 6, used: 3, recordBytes: 56, engine: 1, conditions: 0, modes: 0, activeModes: 0 });
  assert.deepStrictEqual(await kb.removeKeyActions('W'), { key: 'W', slot: 14, removed: true });
  assert.ok(!table.has(14));
  await kb.setKeyActions({ key: 'S', rules: [{ when: 'press', do: { gamepad: 'A' } }] });
  await kb.setKeyActions({ key: 'E', rules: [{ when: 'press', do: { gamepad: 'A' } }] });
  await assert.rejects(kb.setKeyActions({ key: 'W', rules: [{ when: 'press', do: { gamepad: 'A' } }] }), (e) => e.status === 400 && /table is full/.test(e.message));
  await assert.rejects(kb.setKeyActions({ key: 'Nope', rules: [] }), (e) => e.status === 400 && /no key named Nope/.test(e.message));
});

test('a bad map sends nothing; a firmware "bad rule" names the rule', async () => {
  const a = fakeKeyboard();
  await assert.rejects(a.kb.setKeyActions({ key: 'W', rules: [{ when: 'press', do: { wheel: 0 } }] }), /wheel 0/);
  assert.strictEqual(a.sent.length, 0);
  const b = fakeKeyboard();
  b.kb.t.query = async (p) => (p[0] === 0xf8 ? Object.assign([...p], { 8: 0, 9: 0x80 }) : Object.assign([...p], { 2: 3, 3: 1 }));
  await assert.rejects(b.kb.setKeyActions(WALK), /keyboard refused the key map: bad rule 2/);
});

test('caps gate: no "keyActions" or stock firmware -> no 0xEE at all', async () => {
  const { kb, sent } = fakeKeyboard({ caps2: 0x7fff });
  for (const call of [() => kb.keyActionsInfo(), () => kb.getKeyActions(), () => kb.getKeyActions('W'), () => kb.setKeyActions(WALK), () => kb.removeKeyActions('W')]) {
    await assert.rejects(call(), (e) => e.status === 400 && /Key action maps need a newer open firmware/.test(e.message));
  }
  assert.ok(!sent.some((p) => p[0] === 0xee));
  const stock = fakeKeyboard();
  stock.kb.info = { custom: false, unitMm: 0.005 };
  await assert.rejects(stock.kb.getKeyActions(), /open firmware/);
  assert.strictEqual(stock.sent.length, 0);
});

test('web routes: shape checked before the keyboard opens; set / get / list / delete / preview', async () => {
  const { keyActionRoutes } = require('../src/web/key-action-routes');
  const httpError = (status, msg) => Object.assign(new Error(msg), { status });
  let opened = 0;
  const { kb } = fakeKeyboard();
  const R = keyActionRoutes({ keyboard: async () => { opened++; return kb; }, httpError });
  await assert.rejects(R['POST /api/key-actions']({ key: 'W', rules: [{ when: 'soon' }] }), (e) => e.status === 400 && /when is/.test(e.message));
  await assert.rejects(R['GET /api/key-actions']({ slot: '200' }), /slot is 0..127/);
  await assert.rejects(R['GET /api/key-actions']({ key: 'W', slot: '1' }), /give key/);
  await assert.rejects(R['DELETE /api/key-actions']({}), /give key/);
  assert.deepStrictEqual(await R['POST /api/key-actions/preview']({ rules: [{ when: 'press', do: { wheel: 0 } }] }), { error: 'rules[0].do: wheel 0 scrolls nothing' });
  assert.deepStrictEqual((await R['POST /api/key-actions/preview'](WALK)).summary, ['Light press: left stick up 40 %.', 'Past 2.50 mm: left stick up 100 %.']);
  assert.strictEqual(opened, 0);
  assert.strictEqual((await R['POST /api/key-actions'](WALK)).map.key, 'W');
  assert.strictEqual((await R['GET /api/key-actions']({ key: 'W' })).map.rules.length, 2);
  assert.strictEqual((await R['GET /api/key-actions']({ slot: '14' })).map.key, 'W');
  const all = await R['GET /api/key-actions']({});
  assert.deepStrictEqual([all.info.used, all.maps.length], [1, 1]);
  assert.strictEqual((await R['DELETE /api/key-actions']({ key: 'W' })).removed, true);
  assert.strictEqual((await R['GET /api/key-actions']({ key: 'W' })).map, null);
});

test('MCP: get_key_actions and set_key_actions with examples', () => {
  const { server } = require('../src/mcp');
  const t = server._registeredTools;
  assert.ok(t.get_key_actions && t.set_key_actions);
  assert.match(t.set_key_actions.description, /Walk \/ run/);
  assert.match(t.set_key_actions.description, /Tap \/ hold/);
  assert.match(t.set_key_actions.description, /Hold 3 s/);
  assert.match(t.set_key_actions.description, /open X68MAX firmware/);
  assert.ok(t.set_key_actions.inputSchema.safeParse(WALK).success);
  assert.ok(!t.set_key_actions.inputSchema.safeParse({ key: 'W', rules: new Array(7).fill({}) }).success);
  assert.ok(t.get_key_actions.inputSchema.safeParse({}).success);
});

test('Questions view: a flash rule (no mode) is kept as it is, never given a mode, and reads in the summary', () => {
  const stored = K.fromRecord(rec({ key: 'W', rules: [{ when: 'press', do: { flash: [255, 0, 255], times: 5 } }, { when: 'hold', ms: 500, do: { gamepad: 'B' } }] }), 'W');
  const a = C.specToAnswers(stored);
  assert.strictEqual(a.answers.light.do, null, 'no question takes the flash');
  assert.deepStrictEqual(a.extra, [{ when: 'press', do: { flash: '#ff00ff', times: 5 } }]);
  const spec = C.answersToSpec({ key: 'W', ...a });
  assert.deepStrictEqual(spec.rules.at(-1), { when: 'press', do: { flash: '#ff00ff', times: 5 } });
  assert.deepStrictEqual(rec(spec), rec({ key: 'W', rules: [{ when: 'hold', ms: 500, do: { gamepad: 'B' } }, { when: 'press', do: { flash: '#ff00ff', times: 5 } }] }), 'saves back');
  assert.deepStrictEqual(C.summary({ rules: a.extra }), ['Light press: flashes the hold bar 5 times in #ff00ff.']);
});
