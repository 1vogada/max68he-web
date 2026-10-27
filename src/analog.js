// Analog engine: key depth (from the travel stream) -> virtual gamepad state.
// Pure logic, no I/O, so any output (web UI, a ViGEm bridge, a socket) can use it.
// The same math runs on the keyboard (open firmware gamepad.c), so this is also its preview.
//
// A binding maps one key to one gamepad input:
//   { slot, target, invert? }
//   target: 'lx-' 'lx+' 'ly-' 'ly+' 'rx-' 'rx+' 'ry-' 'ry+'  (stick half-axes)
//           'lt' 'rt'                                           (triggers)
//           'a' 'b' 'x' 'y' 'lb' 'rb' 'back' 'start' 'ls' 'rs' 'up' 'down' 'left' 'right'
// Settings: { deadzoneMm, fullMm, buttonMm,
//             curve: 'linear'|'smooth'|'aggressive'|'instant'|'custom',
//             points: 4 x [x, y] 0..255 for 'custom' (x: dead zone .. full press, y: output),
//             antiDeadzone: 0..100 % (sticks and triggers start there once pressed),
//             square: bool (full diagonal = full x and y), snappy: bool (opposite keys: stronger wins),
//             diagonalDeg: 0 = off, 10..80 (where two equal keys point, from the x axis) }

const STICK_HALVES = ['lx-', 'lx+', 'ly-', 'ly+', 'rx-', 'rx+', 'ry-', 'ry+'];
const TRIGGERS = ['lt', 'rt'];
const BUTTONS = ['a', 'b', 'x', 'y', 'lb', 'rb', 'back', 'start', 'ls', 'rs', 'up', 'down', 'left', 'right'];
// Run on the keyboard only (open firmware's analog mouse); the PC preview ignores them.
const MOUSE = ['mouse-left', 'mouse-right', 'mouse-up', 'mouse-down', 'mouse1', 'mouse2', 'mouse3', 'wheel-up', 'wheel-down'];
const TARGETS = [...STICK_HALVES, ...TRIGGERS, ...BUTTONS, ...MOUSE];

// The polyline through 4 points (0..255 each); y0 before the first, y3 after the last.
function polyline(points, t) {
  const x = t * 255;
  if (x < points[0][0]) return points[0][1] / 255;
  let i = 3;
  while (points[i][0] > x) i--;                // the last point at or before x (a step: its upper end)
  if (i === 3) return points[3][1] / 255;
  const [x0, y0] = points[i], [x1, y1] = points[i + 1];
  return (y0 + ((y1 - y0) * (x - x0)) / (x1 - x0)) / 255;
}
const CURVES = {
  linear: (t) => t,
  smooth: (t) => t * t * (3 - 2 * t), // eased at both ends
  aggressive: (t) => Math.sqrt(t),     // most of the range early in the press
  instant: (t) => (t > 0 ? 1 : 0),     // digital, past the dead zone
  custom: (t, points) => polyline(points, t),
};
// Starting points for the curve editor (like Wootility's Linear / Aggro / Slow / Smooth).
const CURVE_PRESETS = {
  linear: [[0, 0], [85, 85], [170, 170], [255, 255]],
  aggro: [[0, 0], [40, 120], [110, 210], [255, 255]],
  slow: [[0, 0], [130, 40], [205, 100], [255, 255]],
  smooth: [[0, 0], [75, 30], [180, 225], [255, 255]],
};

const DEFAULTS = { deadzoneMm: 0.3, fullMm: 3.2, curve: 'linear', buttonMm: 1.2,
  points: CURVE_PRESETS.linear, antiDeadzone: 0, square: false, snappy: false, diagonalDeg: 0 };

// The classic WASD-to-left-stick layout. Slots are this board's (see layout).
const PRESET_WASD = [
  { slot: 14, target: 'ly-' }, { slot: 15, target: 'ly+' },
  { slot: 9, target: 'lx-' }, { slot: 21, target: 'lx+' },
];

function validateBinding(b) {
  if (!b || !Number.isInteger(b.slot) || b.slot < 0 || b.slot > 127) throw new Error('binding slot is 0..127');
  if (!TARGETS.includes(b.target)) throw new Error(`unknown target ${b.target}`);
  return { slot: b.slot, target: b.target, invert: Boolean(b.invert) };
}

const byte = (v) => Number.isInteger(v) && v >= 0 && v <= 255;

function validateSettings(s) {
  const out = { ...DEFAULTS, ...s };
  if (!(out.deadzoneMm >= 0 && out.deadzoneMm < out.fullMm && out.fullMm <= 4)) throw new Error('0 <= dead zone < full press <= 4 mm');
  if (!(out.buttonMm > 0 && out.buttonMm <= 4)) throw new Error('button point is 0..4 mm');
  if (!(out.curve in CURVES)) throw new Error(`curve is ${Object.keys(CURVES).join(', ')}`);
  const p = out.points;
  if (!Array.isArray(p) || p.length !== 4 || !p.every((q) => Array.isArray(q) && q.length === 2 && byte(q[0]) && byte(q[1]))) {
    throw new Error('points are 4 [x, y] pairs of whole numbers 0..255');
  }
  if (p.some((q, i) => i && q[0] < p[i - 1][0])) throw new Error('curve points go left to right');
  if (!(Number.isInteger(out.antiDeadzone) && out.antiDeadzone >= 0 && out.antiDeadzone <= 100)) throw new Error('anti-deadzone is 0..100 %');
  if (!(out.diagonalDeg === 0 || (Number.isInteger(out.diagonalDeg) && out.diagonalDeg >= 10 && out.diagonalDeg <= 80))) {
    throw new Error('diagonal angle is 0 (off) or 10..80 degrees');
  }
  return { ...out, points: p.map(([x, y]) => [x, y]), square: Boolean(out.square), snappy: Boolean(out.snappy) };
}

// One stick: (x, y) -1..1 after the angle adjustment and the round / square limit.
function shapeStick(x, y, { diagonalDeg, square }) {
  if (diagonalDeg && x && y) {                       // 45 degrees (two equal keys) points at diagonalDeg
    const len = Math.hypot(x, y);
    const th = (Math.atan2(Math.abs(y), Math.abs(x)) * 180) / Math.PI;
    const a = th < 45 ? (th * diagonalDeg) / 45 : diagonalDeg + ((th - 45) * (90 - diagonalDeg)) / 45;
    const r = (a * Math.PI) / 180;
    x = Math.sign(x) * len * Math.cos(r);
    y = Math.sign(y) * len * Math.sin(r);
  }
  if (!square) {                                     // a real stick: diagonals stay in the unit circle
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
  }
  return [Math.max(-1, Math.min(1, x)), Math.max(-1, Math.min(1, y))];
}

class AnalogEngine {
  constructor(bindings = PRESET_WASD, settings = {}) {
    this.depth = new Map(); // slot -> mm; held keys send nothing, so the last value stands
    this.configure(bindings, settings);
  }

  configure(bindings, settings = {}) {
    this.bindings = bindings.map(validateBinding);
    this.settings = validateSettings(settings);
  }

  // Feed one travel report.
  update(slot, mm) {
    if (mm > 0) this.depth.set(slot, mm); else this.depth.delete(slot);
  }

  // 0..1 after dead zone, full-press point and curve.
  level(slot) {
    const { deadzoneMm, fullMm, curve, points } = this.settings;
    const mm = this.depth.get(slot) ?? 0;
    if (mm <= deadzoneMm) return 0;
    return CURVES[curve](Math.min((mm - deadzoneMm) / (fullMm - deadzoneMm), 1), points);
  }

  // { lx, ly, rx, ry: -1..1, lt, rt: 0..1, buttons: { a: bool, ... } }
  state() {
    const s = this.settings;
    const ad = s.antiDeadzone / 100;
    const lift = (v) => (v > 0 ? ad + v * (1 - ad) : 0);   // anti-deadzone: a pressed key starts at ad
    const half = Object.fromEntries(STICK_HALVES.map((h) => [h, 0]));
    const out = { lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0, buttons: Object.fromEntries(BUTTONS.map((b) => [b, false])) };
    for (const b of this.bindings) {
      let v = this.level(b.slot);
      if (b.invert) v = 1 - v;
      if (b.target in half) half[b.target] = Math.max(half[b.target], v);
      else if (TRIGGERS.includes(b.target)) out[b.target] = Math.max(out[b.target], v);
      else if (MOUSE.includes(b.target)) continue;
      else if ((this.depth.get(b.slot) ?? 0) >= s.buttonMm) out.buttons[b.target] = true;
    }
    for (const t of TRIGGERS) out[t] = lift(out[t]);
    for (const axis of ['lx', 'ly', 'rx', 'ry']) {
      const pos = lift(half[`${axis}+`]), neg = lift(half[`${axis}-`]);
      // snappy: when both are down the stronger one wins outright; else they subtract
      out[axis] = s.snappy && pos && neg ? (pos > neg ? pos : pos < neg ? -neg : 0) : pos - neg;
    }
    for (const [x, y] of [['lx', 'ly'], ['rx', 'ry']]) [out[x], out[y]] = shapeStick(out[x], out[y], s);
    return out;
  }
}

module.exports = { AnalogEngine, TARGETS, MOUSE, CURVES, CURVE_PRESETS, DEFAULTS, PRESET_WASD, validateBinding, validateSettings };
