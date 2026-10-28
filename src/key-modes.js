// Key action engine 2 (feature 'keyModes'): conditions (`if`), mode outputs and mouse keys in the
// JSON form, the 4-byte condition entries, and the summary sentences for rules that use them.
// Used by key-actions.js; the wire layout is in protocol.js (KA).
//
// Rule `if`: { held?: ['Fn', 'LCtrl'] (1..3 key names or slots; Ctrl / Shift / Alt / Win = the left one),
//   notHeld?: same (engine 5: keys that must be up; held + notHeld at most 3), mode?: 'Mouse' | 1 | [..] (all active), notMode?: same (none active) }
// do: { mode: 'Mouse' | 1, action: 'enter' | 'leave' | 'toggle' } | { leaveAllModes: true }
//   | { mouseKeys: up|down|left|right|wheelUp|wheelDown, start?, max?, rampMs?, curve?, power?, shareSpeed?, keepMs?,
//       speedBy?, pressFrom?, pressTo? }
// shareSpeed / keepMs (engine 3): the ARG rule's mode byte = keepMs / 10, c bit 0 = shared speed.
// speedBy 'pressure' | 'both' (engine 4): ARG c bits 1..2 = 1 | 2, and a DEPTH rule follows the ARG rule:
// [0x0F, 0, 0, 0, FROM, TO, 0, 0] (output = pressFrom, a = pressTo, in 0.1 mm), so 3 rule slots.
// do: { flash: true | [r, g, b] | '#rrggbb', times?: 1..15 (3) } (caps 'modeFlash', any engine): the hold bar
// column flashes `times` times in that colour (true = the default green). Output 11; the rule's mode byte is
// the count, so a flash rule has no `mode` and output 11 never reads as a mode change. Black can't flash
// (0,0,0 is the default green on the wire): it is refused, and 0,0,0 reads back as flash: true.
const P = require('./protocol');
const { CURVE_IDS, CURVE_NAMES, DEFAULT_POWER } = require('../web/glide-core');
const C = require('../web/key-actions-core');

const fail = (where, msg) => Object.assign(new Error(where ? `${where}: ${msg}` : msg), { status: 400 });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const OUT = { MOUSE_KEYS: 9, MODE: 10, FLASH: P.KA.FLASH };
const FLASH_TIMES = 3;   // a flash rule's default count (like a mode's enter flash)
const DIRS = ['up', 'down', 'left', 'right', 'wheelUp', 'wheelDown'];   // wire a = index + 1
const ACTIONS = ['enter', 'leave', 'toggle'];                              // wire b = index + 1
const CURVES = CURVE_NAMES.filter((n) => n !== 'points');
const MK_DEFAULTS = { pointer: { start: 100, max: 1200 }, wheel: { start: 2, max: 10 }, rampMs: 1000, curve: 'easeIn', keepMs: 150,
  pressFrom: 0.5, pressTo: 3.2 };
const SHARE = 1;   // ARG rule c bit 0: speed shared between directions (engine 3)
const SPEED_BY = ['time', 'pressure', 'both'];   // ARG rule c bits 1..2 (engine 4); 3 is refused
const speedByOf = (arg) => (arg ? (arg.c >> 1) & 3 : 0);
const ALIASES = { ctrl: 'LCtrl', shift: 'LShift', alt: 'LAlt', win: 'LWin' };

// which engine-2 output a `do` names (null: none of them)
function newKind(d) {
  if (!isObj(d)) return null;
  if ('mouseKeys' in d) return 'mouseKeys';
  if ('leaveAllModes' in d) return 'leaveAllModes';
  if ('flash' in d) return 'flash';
  if ('mode' in d) return 'mode';
  return null;
}

// a flash colour: true (default green -> 0,0,0), [r, g, b] or '#rrggbb' / 'rrggbb'; black refused
function flashColor(v, w) {
  if (v === true) return [0, 0, 0];
  let c = null;
  if (Array.isArray(v) && v.length === 3 && v.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)) c = [...v];
  else if (typeof v === 'string' && /^#?[0-9a-f]{6}$/i.test(v.trim())) {
    const n = parseInt(v.trim().replace('#', ''), 16);
    c = [n >> 16, (n >> 8) & 0xff, n & 0xff];
  }
  if (!c) throw fail(w, 'flash is true (the default green), [r, g, b] (0..255 each) or "#rrggbb"');
  if (!c.some(Boolean)) throw fail(w, `flash: ${P.BLACK_FLASH}; use flash: true for the default green`);
  return c;
}
const hex = (c) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
// a wire rule that is a FLASH (ARG / DEPTH rules are not outputs: a DEPTH rule's output byte is a depth)
const isFlashRule = (x) => x.output === OUT.FLASH && x.trigger !== P.KA.ARG;
// true when a wire rule list has a FLASH rule (needs caps 'modeFlash')
const usesFlash = (wire) => wire.rules.some(isFlashRule);

// ---- conditions -----------------------------------------------------------------------

// Without a keyboard: key names stay names (aliases applied), mode names stay names.
const LOOSE = {
  slotOf: (k) => (typeof k === 'string' ? ALIASES[k.trim().toLowerCase()] ?? k.trim() : k),
  modeOf: (m) => m,
};
const same = (a, b) => (typeof a === 'string' && typeof b === 'string' ? a.toLowerCase() === b.toLowerCase() : a === b);

function modeRefs(v, what, where, ctx) {
  const list = Array.isArray(v) ? v : [v];
  const N = P.KA.MAX_MODES;
  if (!list.length || list.length > N) throw fail(where, `${what} is a mode (name or 1..${N}) or a list of modes`);
  const out = list.map((m) => {
    if (typeof m === 'number') {
      if (!Number.isInteger(m) || m < 1 || m > N) throw fail(where, `${what}: a mode number is 1..${N}, not ${m}`);
    } else if (typeof m !== 'string' || !m.trim()) throw fail(where, `${what} is a mode name or 1..${N}`);
    return ctx.modeOf(typeof m === 'string' ? m.trim() : m, where);
  });
  if (out.some((m, i) => out.findIndex((x) => same(x, m)) !== i)) throw fail(where, `${what} names a mode twice`);
  return out;
}

function keyRefs(v, what, w, ctx) {
  if (!Array.isArray(v) || v.length < 1 || v.length > 3) throw fail(w, `${what} is a list of 1..3 keys like ["Fn", "LCtrl"]`);
  const keys = v.map((k) => {
    if (typeof k === 'number' ? !Number.isInteger(k) || k < 0 || k >= P.SLOTS : typeof k !== 'string' || !k.trim()) {
      throw fail(w, `${what} keys are key names like "Fn" or slots 0..${P.SLOTS - 1}`);
    }
    return ctx.slotOf(k, w);
  });
  if (keys.some((k, i) => keys.findIndex((x) => same(x, k)) !== i)) throw fail(w, `${what} names a key twice`);
  return keys;
}

// rule.if -> { keys: [slot | name], notKeys?: [...] (only when used), on: [id | name], off: [...] }; self = the key's own slot / name
function parseIf(c, where, ctx = LOOSE, self) {
  const w = `${where}.if`;
  if (!isObj(c)) throw fail(w, 'if is { held?, notHeld?, mode?, notMode? }');
  const bad = Object.keys(c).filter((k) => !['held', 'notHeld', 'mode', 'notMode'].includes(k));
  if (bad.length) throw fail(w, `unknown field${bad.length > 1 ? 's' : ''} ${bad.map((b) => `"${b}"`).join(', ')}`);
  if (c.held === undefined && c.notHeld === undefined && c.mode === undefined && c.notMode === undefined) {
    throw fail(w, 'if needs held, notHeld, mode or notMode');
  }
  const keys = c.held === undefined ? [] : keyRefs(c.held, 'held', w, ctx);
  const notKeys = c.notHeld === undefined ? [] : keyRefs(c.notHeld, 'notHeld', w, ctx);
  if (keys.length + notKeys.length > 3) throw fail(w, 'held and notHeld together name at most 3 keys');
  if (keys.some((k) => notKeys.some((x) => same(x, k)))) throw fail(w, 'a key can not be in both held and notHeld (never true)');
  if (self !== undefined && [...keys, ...notKeys].some((k) => same(k, self))) throw fail(w, 'a key can not be in the condition of its own rule');
  const on = c.mode === undefined ? [] : modeRefs(c.mode, 'mode', w, ctx);
  const off = c.notMode === undefined ? [] : modeRefs(c.notMode, 'notMode', w, ctx);
  if (on.some((m) => off.some((x) => same(x, m)))) throw fail(w, 'a mode can not be in both mode and notMode (never true)');
  return { keys, ...(notKeys.length && { notKeys }), on, off };
}

const NOT = 0x80;   // entry key byte bit 7: the key must not be held (engine 5)
const resolved = (need) => [...need.keys, ...(need.notKeys ?? [])].every(Number.isInteger) && [...need.on, ...need.off].every(Number.isInteger);
// { keys: [slots], notKeys: [slots], on: [ids], off: [ids] } -> the entry: 4 bytes when its modes are 1..3
// (every engine), else 12 ([k0, k1, k2, byte 3, on u32, off u32], modes 4..32: engine 6)
function condEntry(need) {
  if (!resolved(need)) throw new Error('condition keys and modes are not resolved to slots and ids');
  const mask = (ids) => ids.reduce((m, id) => (m | (1 << (id - 1))) >>> 0, 0);
  const on = mask(need.on), off = mask(need.off);
  const keys = [...need.keys, ...(need.notKeys ?? []).map((s) => s | NOT), 0xff, 0xff, 0xff].slice(0, 3);
  const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  return P.compactCond([...keys, 0, ...le(on), ...le(off)]);
}
// true when a wire rule list has a notHeld condition (needs engine 5)
const usesNotHeld = (wire) => wire.rules.some((x) => x.need?.notKeys?.length);
// an entry's mode masks (4- or 12-byte form)
function masksOf(e) {
  const w = P.wideCond(e);
  const u32 = (i) => (w[i] | (w[i + 1] << 8) | (w[i + 2] << 16) | (w[i + 3] << 24)) >>> 0;
  return { on: u32(4), off: u32(8) };
}
const isFree = (e) => e.slice(0, 3).every((k) => k === 0xff) && !masksOf(e).on && !masksOf(e).off;
// the same condition: the same keys in any order and the same modes
const sameEntry = (a, b) => {
  const x = masksOf(a), y = masksOf(b);
  return x.on === y.on && x.off === y.off && [...a.slice(0, 3)].sort().join() === [...b.slice(0, 3)].sort().join();
};
// true when a wire rule list names a mode above 3 (in `if` or a mode output): needs engine 6
const usesHighModes = (wire) => wire.rules.some((x) => [...(x.need?.on ?? []), ...(x.need?.off ?? [])].some((m) => Number.isInteger(m) && m > P.KA.MODES) ||
  (x.output === OUT.MODE && x.trigger !== P.KA.ARG && x.a > P.KA.MODES));

// a stored entry -> { keys, on, off } (null for an unused / malformed one)
function needOf(e) {
  if (!Array.isArray(e) || (e.length !== 4 && e.length !== P.KA.COND_BYTES) || isFree(e)) return null;
  const ids = (bits) => Array.from({ length: P.KA.MAX_MODES }, (_, i) => i + 1).filter((id) => (bits >>> (id - 1)) & 1);
  const used = e.slice(0, 3).filter((k) => k !== 0xff);
  const not = used.filter((k) => k & NOT).map((k) => k & ~NOT);
  const { on, off } = masksOf(e);
  return { keys: used.filter((k) => !(k & NOT)), ...(not.length && { notKeys: not }), on: ids(on), off: ids(off) };
}
// Firmware rule for an entry: used keys first, distinct slots (bit 7 = not held, engine 5); a key or a mode.
// 4 bytes: byte 3 = on bits 0..2 | off bits 4..6 (bits 3 and 7 zero); 12 bytes: the masks (modes 1..32).
function entryProblem(e) {
  if (!Array.isArray(e) || (e.length !== 4 && e.length !== P.KA.COND_BYTES) || !e.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) return 'an entry is 4 or 12 bytes';
  if (isFree(e)) return null;
  const keys = e.slice(0, 3), used = keys.filter((k) => k !== 0xff);
  if (keys.slice(used.length).some((k) => k !== 0xff)) return 'used keys come first';
  if (new Set(used.map((k) => k & ~NOT)).size !== used.length) return 'keys are distinct slots 0..127 (bit 7 = not held)';
  if (e[3] & 0x88) return 'mode bits 3 and 7 are 0';
  const { on, off } = masksOf(e);
  if (!used.length && !on && !off) return 'no key and no mode';
  return null;
}

// need (with ids / slots, or loose names) -> the JSON `if`
function ifJson(need, ctx = {}) {
  const key = (s) => (Number.isInteger(s) ? ctx.keyName?.(s) ?? s : s);
  const mode = (id) => (Number.isInteger(id) ? ctx.modeName?.(id) || id : id);
  const one = (list) => (list.length === 1 ? list[0] : list);
  return { ...(need.keys.length && { held: need.keys.map(key) }), ...(need.notKeys?.length && { notHeld: need.notKeys.map(key) }),
    ...(need.on.length && { mode: one(need.on.map(mode)) }),
    ...(need.off.length && { notMode: one(need.off.map(mode)) }) };
}

// ---- outputs ------------------------------------------------------------------------------

function num(v, lo, hi, what, where, unit = '') {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw fail(where, `${what} is a number within ${lo}..${hi}${unit}`);
  return v;
}

// engine-2 `do` -> { output, a, b, c, arg? } (arg = the ARG rule's fields for mouse keys)
function parseNewOutput(d, kind, w, ctx = LOOSE) {
  const only = (fields) => {
    const bad = Object.keys(d).filter((k) => !fields.includes(k));
    if (bad.length) throw fail(w, `unknown field${bad.length > 1 ? 's' : ''} ${bad.map((b) => `"${b}"`).join(', ')}`);
  };
  if (kind === 'flash') {
    only(['flash', 'times']);
    const times = d.times ?? FLASH_TIMES;
    if (!Number.isInteger(times) || times < 1 || times > P.KA.FLASH_MAX) throw fail(w, `times is a whole number within 1..${P.KA.FLASH_MAX}`);
    const [a, b, c] = flashColor(d.flash, w);
    return { output: OUT.FLASH, a, b, c, times };
  }
  if (kind === 'leaveAllModes') {
    only(['leaveAllModes']);
    if (d.leaveAllModes !== true) throw fail(w, 'leaveAllModes is true');
    return { output: OUT.MODE, a: 0, b: 2, c: 0 };
  }
  if (kind === 'mode') {
    only(['mode', 'action']);
    const [id] = modeRefs(d.mode, 'mode', w, ctx);
    if (Array.isArray(d.mode)) throw fail(w, `mode is one mode (name or 1..${P.KA.MAX_MODES}); every mode: { leaveAllModes: true }`);
    const b = ACTIONS.indexOf(d.action);
    if (b < 0) throw fail(w, `action is ${ACTIONS.join(', ')}`);
    return { output: OUT.MODE, a: id, b: b + 1, c: 0 };
  }
  only(['mouseKeys', 'start', 'max', 'rampMs', 'curve', 'power', 'shareSpeed', 'keepMs', 'speedBy', 'pressFrom', 'pressTo']);
  const dir = DIRS.indexOf(d.mouseKeys);
  if (dir < 0) throw fail(w, `mouseKeys is ${DIRS.join(', ')}`);
  const wheel = dir >= 4, def = wheel ? MK_DEFAULTS.wheel : MK_DEFAULTS.pointer;
  const speed = (v, what) => (wheel ? Math.round(num(v, 0.1, 25.5, what, w, ' notches/s') * 10) : Math.round(num(v, 10, 2550, what, w, ' px/s') / 10));
  const start = speed(d.start ?? def.start, 'start'), max = speed(d.max ?? def.max, 'max');
  if (start > max) throw fail(w, 'start is not above max');
  const ramp = d.rampMs ?? MK_DEFAULTS.rampMs;
  if (!Number.isInteger(ramp) || ramp < 0 || ramp > 10000) throw fail(w, 'rampMs is a whole number within 0..10000');
  const curve = d.curve ?? MK_DEFAULTS.curve;
  if (!CURVES.includes(curve)) throw fail(w, `curve is ${CURVES.join(', ')}`);
  let param = 0;
  if (DEFAULT_POWER[curve] === undefined) {
    if (d.power !== undefined) throw fail(w, `a power only goes with ease or expo curves, not ${curve}`);
  } else if (curve === 'expo') {
    param = Math.round(num(d.power ?? DEFAULT_POWER.expo, -20, 20, 'power (expo K)', w) * 100);
    if (param === 0) throw fail(w, 'expo power (K) is within -20..20 and not 0');
  } else {
    param = Math.round(num(d.power ?? DEFAULT_POWER[curve], 0.3, 8, 'power (ease P)', w) * 100);
  }
  if (d.shareSpeed !== undefined && typeof d.shareSpeed !== 'boolean') throw fail(w, 'shareSpeed is true or false');
  if (d.keepMs !== undefined && !d.shareSpeed) throw fail(w, 'keepMs only goes with shareSpeed: true');
  const keep = d.shareSpeed ? Math.round(num(d.keepMs ?? MK_DEFAULTS.keepMs, 0, 1000, 'keepMs', w, ' ms') / 10) : 0;
  const by = SPEED_BY.indexOf(d.speedBy ?? 'time');
  if (by < 0) throw fail(w, `speedBy is ${SPEED_BY.join(', ')}`);
  if (!by && (d.pressFrom !== undefined || d.pressTo !== undefined)) throw fail(w, 'pressFrom / pressTo only go with speedBy "pressure" or "both"');
  const from = by && Math.round(num(d.pressFrom ?? MK_DEFAULTS.pressFrom, 0, 4, 'pressFrom', w, ' mm') * 10);
  const to = by && Math.round(num(d.pressTo ?? MK_DEFAULTS.pressTo, 0, 4, 'pressTo', w, ' mm') * 10);
  if (by && !(from < to)) throw fail(w, 'pressTo must be at least 0.1 mm deeper than pressFrom (0 <= pressFrom < pressTo <= 4 mm, in 0.1 mm steps)');
  return { output: OUT.MOUSE_KEYS, a: dir + 1, b: start, c: max,
    arg: { trigger: P.KA.ARG, mode: keep, tval: ramp, output: CURVE_IDS[curve], a: param & 0xff, b: (param >> 8) & 0xff, c: (d.shareSpeed ? SHARE : 0) | (by << 1) },
    ...(by && { depth: { trigger: P.KA.ARG, mode: 0, tval: 0, output: from, a: to, b: 0, c: 0 } }) };
}

// the modes an engine-2 output takes (null: not one of them)
function newModes(kind, d) {
  if (kind === 'mouseKeys') return ['press', 'toggle', 'while'];
  if (kind === 'leaveAllModes') return ['press', 'tap'];
  if (kind === 'mode') return d?.action === 'enter' ? ['press', 'tap', 'while'] : ['press', 'tap'];
  return null;
}
// the default mode of a rule whose do is an engine-2 output
function newDefaultMode(when, kind, d) {
  if (kind === 'mouseKeys') return 'while';
  const m = C.DEFAULT_MODE[when] ?? 'press';
  return m === 'while' && !(kind === 'mode' && d?.action === 'enter') ? 'tap' : m;
}

const i16 = (lo, hi) => ((lo | (hi << 8)) << 16) >> 16;
// wire output (+ its ARG rule and DEPTH rule) -> the JSON do; null when not an engine-2 output
function newDo(x, arg, ctx = {}, depth = null) {
  if (isFlashRule(x)) {   // the mode byte is the count: never a mode
    const c = [x.a, x.b, x.c];
    return { flash: c.some(Boolean) ? hex(c) : true, times: x.mode };
  }
  if (x.output === OUT.MODE) {
    if (x.a === 0 && x.b === 2) return { leaveAllModes: true };
    const id = x.a;
    return { mode: Number.isInteger(id) ? ctx.modeName?.(id) || id : id, action: ACTIONS[x.b - 1] ?? `action ${x.b}` };
  }
  if (x.output !== OUT.MOUSE_KEYS) return null;
  const wheel = x.a >= 5, speed = (v) => (wheel ? v / 10 : v * 10);
  const curve = CURVE_NAMES[arg?.output] ?? `curve ${arg?.output}`;
  return { mouseKeys: DIRS[x.a - 1] ?? `direction ${x.a}`, start: speed(x.b), max: speed(x.c), rampMs: arg?.tval ?? 0, curve,
    ...(DEFAULT_POWER[curve] !== undefined && arg && { power: i16(arg.a, arg.b) / 100 }),
    ...(arg && arg.c & SHARE && { shareSpeed: true, keepMs: arg.mode * 10 }),
    ...(speedByOf(arg) && { speedBy: SPEED_BY[speedByOf(arg)] ?? `speedBy ${speedByOf(arg)}`,
      ...(depth && { pressFrom: depth.output / 10, pressTo: depth.a / 10 }) }) };
}
// true when a wire rule list shares mouse keys speed (needs engine 3; the speedBy bits are engine 4's)
const sharesSpeed = (wire) => wire.rules.some((x) => x.trigger === P.KA.ARG && (x.mode || x.c & SHARE));
// true when a wire rule list sets mouse keys speed by pressure (needs engine 4)
const speedByPressure = (wire) => wire.rules.some((x) => x.trigger === P.KA.ARG && speedByOf(x));
// a mouse keys rule's extra rules: its ARG rule, then its DEPTH rule when the ARG sets speed by pressure
const mkTail = (rules, i) => {
  const arg = rules[i]?.output === OUT.MOUSE_KEYS && rules[i + 1]?.trigger === P.KA.ARG ? rules[i + 1] : null;
  const depth = speedByOf(arg) && rules[i + 2]?.trigger === P.KA.ARG ? rules[i + 2] : null;
  return { arg, depth };
};

// ---- summary sentences (rules with `if` or an engine-2 output) ----------------------------

const KEY_TEXT = { LCtrl: 'Left Ctrl', RCtrl: 'Right Ctrl', LShift: 'Left Shift', RShift: 'Right Shift', LAlt: 'Left Alt',
  RAlt: 'Right Alt', LWin: 'Left Win', RWin: 'Right Win' };
const CURVE_TEXT = { linear: 'linear', easeIn: 'ease in', easeOut: 'ease out', easeInOut: 'ease in-out', sine: 'sine', expo: 'expo', smooth: 'smooth' };
const DIR_TEXT = { up: 'move the mouse up', down: 'move the mouse down', left: 'move the mouse left', right: 'move the mouse right',
  wheelUp: 'scroll up', wheelDown: 'scroll down' };
const secs = (ms) => `${(ms / 1000).toFixed(2)} s`;
const mm2 = (v) => Number(v).toFixed(2);
const keyText = (k) => (typeof k === 'number' ? `key ${k}` : KEY_TEXT[k] ?? String(k));
const modeText = (m) => (typeof m === 'number' ? `mode ${m}` : `mode ${m}`);
const andList = (l) => (l.length < 2 ? l.join('') : `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}`);

function ifText(c) {
  const parts = [];
  const list = (v) => (Array.isArray(v) ? v : [v]);
  const keys = (l, how) => `${l.map(keyText).join(' + ')} ${l.length > 1 ? 'are' : 'is'} ${how}`;
  const not = c.notHeld?.length ? keys(c.notHeld, 'not held') : '';
  if (c.held?.length) parts.push(`while ${keys(c.held, 'held')}${not ? ` and ${not}` : ''}`);
  if (c.mode !== undefined) parts.push(`in ${andList(list(c.mode).map(modeText))}`);
  if (c.notMode !== undefined) parts.push(`not in ${andList(list(c.notMode).map(modeText))}`);
  if (not && !c.held?.length) parts.push(`while ${not}`);
  return parts.join(', ');
}

function triggerText(r, mode) {
  const w = mode === 'while';
  switch (r.when) {
    case 'press': return w ? 'while pressed' : 'press';
    case 'down': return `${w ? 'while past' : 'past'} ${C.mm(r.at)}`;
    case 'up': return `back above ${C.mm(r.at)}`;
    case 'hold': return `${w ? 'while held' : 'hold'} ${secs(r.ms)}`;
    case 'tap': return `quick tap (let go within ${secs(r.ms)})`;
    case 'release': return 'let go';
    default: return String(r.when);
  }
}

function flashText(d) {
  const n = d.times ?? FLASH_TIMES;
  return `flash the hold bar column ${n} time${n === 1 ? '' : 's'}${d.flash === true || d.flash === undefined ? '' : ` in ${Array.isArray(d.flash) ? hex(d.flash) : d.flash}`}`;
}

function doText(d) {
  const kind = newKind(d);
  if (kind === 'flash') return flashText(d);
  if (kind === 'leaveAllModes') return 'leave every mode';
  if (kind === 'mode') return `${d.action} ${modeText(d.mode)}`;
  if (kind === 'mouseKeys') {
    const unit = d.mouseKeys.startsWith('wheel') ? 'notches/s' : 'px/s';
    const curve = CURVE_TEXT[d.curve] ?? d.curve;
    const power = d.power !== undefined && d.power !== DEFAULT_POWER[d.curve] ? `, power ${d.power}` : '';
    const share = d.shareSpeed ? `, speed shared between directions${d.keepMs ? `, kept ${d.keepMs} ms after release` : ''}` : '';
    const dir = DIR_TEXT[d.mouseKeys] ?? d.mouseKeys, by = d.speedBy ?? 'time';
    const from = mm2(d.pressFrom ?? MK_DEFAULTS.pressFrom), range = `${from} -> ${mm2(d.pressTo ?? MK_DEFAULTS.pressTo)} mm`;
    if (d.start === d.max || (by === 'time' && !d.rampMs)) {
      return `${dir} at ${d.max} ${unit}${by === 'time' ? '' : ` once pressed past ${from} mm`}${by === 'pressure' ? '' : share}`;
    }
    if (by === 'pressure') return `${dir}, ${d.start} -> ${d.max} ${unit}, speed by how deep you press, ${range}`;
    const ramp = `${secs(d.rampMs)} (${curve}${power})`;
    if (by === 'both') {
      if (!d.rampMs) return `${dir}, ${d.start} -> ${d.max} ${unit}, speed by how deep you press, ${range}${share}`;
      return `${dir}, ${d.start} -> ${d.max} ${unit}, up to a speed set by how deep you press (${range}), building over ${ramp}${share}`;
    }
    return `${dir}, ${d.start} -> ${d.max} ${unit} over ${ramp}${share}`;
  }
  if (C.outputKind(d) === 'mouse') {
    const names = { L: 'left', R: 'right', M: 'middle' };
    const list = String(d.mouse).split('+').map((b) => names[b.trim().toUpperCase()] ?? b);
    return `mouse button${list.length > 1 ? 's' : ''} ${list.join(' + ')}`;
  }
  return C.outputText(d);
}

function newRuleText(r) {
  const kind = newKind(r.do) ?? C.outputKind(r.do);
  const mode = kind === 'flash' ? 'press' : r.mode ?? (newKind(r.do) ? newDefaultMode(r.when, kind, r.do) : C.defaultMode(r));
  const once = kind === 'mode' || kind === 'leaveAllModes' || kind === 'flash' || C.ONCE.includes(kind);
  let action = doText(r.do);
  if (kind === 'mode' && mode === 'while') action += ' (only while it lasts)';
  else if (!once) {
    if (mode === 'press') action += ' (until released)';
    else if (mode === 'tap') action = `tap ${action}`;
    else if (mode === 'toggle') action += ' (on / off each time)';
    else if (mode === 'release') action = `let go of ${action}`;
  }
  const head = [r.if ? ifText(r.if) : '', triggerText(r, mode)].filter(Boolean).join(', ');
  return `${head[0].toUpperCase()}${head.slice(1)}: ${action}`;
}

// one sentence per rule (the old wording for rules without `if` and engine-2 outputs)
function summary(spec) {
  const out = (spec?.rules ?? []).map((r) => (r.if || newKind(r.do) ? newRuleText(r) : C.ruleText(r)));
  if (spec?.alsoType) out.push('It still types its own key too.');
  return out;
}

module.exports = { OUT, FLASH_TIMES, flashColor, flashText, isFlashRule, usesFlash, DIRS, ACTIONS, CURVES, MK_DEFAULTS, SPEED_BY, LOOSE, mkTail, speedByPressure, usesNotHeld, newKind, parseIf, condEntry, needOf, entryProblem,
  isFree, sameEntry, masksOf, usesHighModes, ifJson, parseNewOutput, newModes, newDefaultMode, newDo, sharesSpeed, newRuleText, summary, resolved };
