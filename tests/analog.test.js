// Analog engine: depth -> gamepad state.
const test = require('node:test');
const assert = require('node:assert');
const { AnalogEngine, PRESET_WASD } = require('../src/analog');

const W = 14; const A = 9; const S = 15; const D = 21;

test('WASD preset drives the left stick; dead zone and full press bound it', () => {
  const e = new AnalogEngine(PRESET_WASD, { deadzoneMm: 0.2, fullMm: 2.2, curve: 'linear' });
  e.update(D, 0.1);
  assert.strictEqual(e.state().lx, 0, 'inside dead zone');
  e.update(D, 1.2);
  assert.ok(Math.abs(e.state().lx - 0.5) < 1e-9, 'half way');
  e.update(D, 3.5);
  assert.strictEqual(e.state().lx, 1, 'clamped at full');
  e.update(W, 3.5);
  const s = e.state();
  assert.ok(Math.abs(Math.hypot(s.lx, s.ly) - 1) < 1e-9, 'diagonal kept on the unit circle');
  assert.ok(s.ly < 0 && s.lx > 0);
});

test('opposite keys cancel; release (0 mm) clears the key', () => {
  const e = new AnalogEngine(PRESET_WASD, { deadzoneMm: 0, fullMm: 2 });
  e.update(A, 2);
  e.update(D, 2);
  assert.strictEqual(e.state().lx, 0);
  e.update(A, 0);
  assert.strictEqual(e.state().lx, 1);
});

test('triggers, buttons and curves', () => {
  const e = new AnalogEngine([{ slot: 1, target: 'rt' }, { slot: 2, target: 'a' }], { deadzoneMm: 0, fullMm: 2, curve: 'aggressive', buttonMm: 1 });
  e.update(1, 0.5);
  assert.ok(Math.abs(e.state().rt - 0.5) < 1e-9, 'sqrt(0.25)');
  e.update(2, 0.9);
  assert.strictEqual(e.state().buttons.a, false);
  e.update(2, 1.1);
  assert.strictEqual(e.state().buttons.a, true);
});

test('bad bindings and settings are refused', () => {
  assert.throws(() => new AnalogEngine([{ slot: 1, target: 'turbo' }]));
  assert.throws(() => new AnalogEngine([{ slot: 200, target: 'a' }]));
  assert.throws(() => new AnalogEngine([], { deadzoneMm: 3, fullMm: 2 }));
  assert.throws(() => new AnalogEngine([], { curve: 'wobbly' }));
});

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);

test('custom curve: the polyline through 4 points, flat before the first and after the last', () => {
  const e = new AnalogEngine([{ slot: 1, target: 'rt' }], { deadzoneMm: 0, fullMm: 2.55, curve: 'custom',
    points: [[51, 51], [102, 204], [204, 204], [230, 255]] });
  e.update(1, 0.25); near(e.state().rt, 0.2, 'before the first point = y0');
  e.update(1, 0.765); near(e.state().rt, 0.5, 'half way 51..102 -> half way 51..204');
  e.update(1, 1.5); near(e.state().rt, 0.8, 'flat 102..204');
  e.update(1, 2.5); near(e.state().rt, 1, 'after the last point = y3');
  assert.throws(() => new AnalogEngine([], { curve: 'custom', points: [[100, 0], [50, 0], [200, 0], [255, 0]] }), /left to right/);
});

test('anti-deadzone lifts pressed sticks and triggers, never a released one', () => {
  const e = new AnalogEngine([{ slot: 1, target: 'lt' }, ...PRESET_WASD], { deadzoneMm: 0, fullMm: 2, antiDeadzone: 20 });
  assert.strictEqual(e.state().lt, 0);
  e.update(1, 0.5); near(e.state().lt, 0.2 + 0.25 * 0.8, 'lt');
  e.update(D, 1); near(e.state().lx, 0.2 + 0.5 * 0.8, 'stick half');
});

test('snappy: the deeper of two opposite keys wins outright', () => {
  const e = new AnalogEngine(PRESET_WASD, { deadzoneMm: 0, fullMm: 2, snappy: true });
  e.update(A, 1); e.update(D, 2);
  near(e.state().lx, 1, 'D deeper');
  e.update(A, 2);
  near(e.state().lx, 0, 'equal = centre');
});

test('square output keeps a full diagonal at full x and y; round limits it to the circle', () => {
  const sq = new AnalogEngine(PRESET_WASD, { deadzoneMm: 0, fullMm: 2, square: true });
  sq.update(W, 2); sq.update(D, 2);
  near(sq.state().lx, 1, 'square x'); near(sq.state().ly, -1, 'square y');
});

test('diagonal angle: two equal keys point at the set angle, the length is kept', () => {
  const e = new AnalogEngine(PRESET_WASD, { deadzoneMm: 0, fullMm: 2, diagonalDeg: 30, square: true });
  e.update(W, 1); e.update(D, 1);
  const { lx, ly } = e.state();
  near((Math.atan2(-ly, lx) * 180) / Math.PI, 30, 'angle');
  near(Math.hypot(lx, ly), Math.hypot(0.5, 0.5), 'length');
  e.update(W, 0);
  near(e.state().ly, 0, 'one key alone is unchanged');
});

test('custom curve step: at the shared x the upper point counts (as on the keyboard)', () => {
  const e = new AnalogEngine([{ slot: 1, target: 'rt' }], { deadzoneMm: 0, fullMm: 2.55, curve: 'custom',
    points: [[0, 0], [102, 51], [102, 204], [255, 255]] });
  e.update(1, 1.02); near(e.state().rt, 0.8, 'exactly at the step');
  e.update(1, 1.01); near(e.state().rt, 0.2 * (101 / 102), 'just before it');
});
