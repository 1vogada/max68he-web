// Key action maps (open firmware 0xEE, caps 'keyActions'): the JSON form <-> the 56-byte record
// (protocol.js KA), with the defaults and full validation. Names, default modes and the summary
// sentences are shared with the web UI (web/key-actions-core.js).
//
// { key: 'W' | slot: 12, press?: mm (0.3), gap?: mm (0.1), alsoType?: false,
//   rules: [{ when, at?, ms?, mode?, do }] }   (up to 6 rules; see key-actions-core.js)
// Wire units: depths in centi-mm (press 1..400, gap 1..50, at 10..400), hold / tap 10..10000 ms,
// axis-depth from / to in 0.1 mm (0 <= from < to <= 4 mm), glide dx dy / 4 (+-508 px) over 10..2550 ms.
const P = require('./protocol');
const { keyToMods, modsToName } = require('./keys');
const C = require('../web/key-actions-core');

const fail = (where, msg) => Object.assign(new Error(where ? `${where}: ${msg}` : msg), { status: 400 });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const lower = (list) => Object.fromEntries(list.map((n, i) => [n.toLowerCase(), i]));
const AXIS_IDX = lower(C.AXES), BUTTON_IDX = lower(C.BUTTONS);
const MOUSE_NAMES = { l: 1, left: 1, r: 2, right: 2, m: 4, middle: 4 };
const DO_FIELDS = { key: ['key'], gamepad: ['gamepad'], axis: ['axis', 'percent'], axisDepth: ['axis', 'from', 'to'],
  mouse: ['mouse'], move: ['move'], glide: ['glide', 'ms'], wheel: ['wheel'] };
const DO_HELP = 'do is { key }, { gamepad }, { axis, percent }, { axis, from, to }, { mouse }, { move: [dx, dy] }, { glide: [dx, dy], ms } or { wheel }';
const int8 = (v) => (v > 127 ? v - 256 : v);

function only(obj, fields, where) {
  const bad = Object.keys(obj).filter((k) => !fields.includes(k));
  if (bad.length) throw fail(where, `unknown field${bad.length > 1 ? 's' : ''} ${bad.map((b) => `"${b}"`).join(', ')}`);
}

function num(v, lo, hi, what, where, unit = '') {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw fail(where, `${what} is a number within ${lo}..${hi}${unit}`);
  return v;
}
function int(v, lo, hi, what, where) {
  if (!Number.isInteger(v) || v < lo || v > hi) throw fail(where, `${what} is a whole number within ${lo}..${hi}`);
  return v;
}
// mm -> centi-mm (0.01 mm steps)
const cmm = (v, lo, hi, what, where) => Math.round(num(v, lo / 100, hi / 100, what, where, ' mm') * 100);

function output(d, where) {
  if (!isObj(d)) throw fail(where, DO_HELP);
  const kind = C.outputKind(d);
  if (!kind) throw fail(where, DO_HELP);
  only(d, DO_FIELDS[kind], where);
  const w = `${where}.do`;
  switch (kind) {
    case 'key': {
      if (typeof d.key !== 'string' || !d.key.trim()) throw fail(w, 'key is a key name like "Shift", "E" or "Ctrl+C"');
      let m;
      try { m = keyToMods(d.key); } catch (e) { throw fail(w, e.message.replace(' (DKS sends keys and modifiers only)', ' (only keyboard keys and modifiers)')); }
      if (!m.mods && !m.usage) throw fail(w, `key "${d.key}" sends nothing`);
      if (m.usage > 0xe7) throw fail(w, `"${d.key}" is not a keyboard key`);
      return { output: 1, a: m.mods, b: m.usage, c: 0 };
    }
    case 'gamepad': {
      const i = BUTTON_IDX[String(d.gamepad).trim().toLowerCase()];
      if (i === undefined) throw fail(w, `gamepad is one of ${C.BUTTONS.join(', ')} (sticks and triggers: use axis)`);
      return { output: 2, a: 11 + i, b: 0, c: 0 };
    }
    case 'axis': case 'axisDepth': {
      const i = AXIS_IDX[String(d.axis).trim().toLowerCase()];
      if (i === undefined) throw fail(w, `axis is one of ${C.AXES.join(', ')}`);
      if (kind === 'axis') return { output: 3, a: 1 + i, b: int(d.percent, 1, 100, 'percent', w), c: 0 };
      const from = Math.round(num(d.from, 0, 4, 'from', w, ' mm') * 10), to = Math.round(num(d.to, 0, 4, 'to', w, ' mm') * 10);
      if (!(from < to)) throw fail(w, 'to must be at least 0.1 mm deeper than from (0 <= from < to <= 4 mm, in 0.1 mm steps)');
      return { output: 4, a: 1 + i, b: from, c: to };
    }
    case 'mouse': {
      const parts = String(d.mouse).split('+').map((p) => MOUSE_NAMES[p.trim().toLowerCase()]);
      if (!parts.length || parts.some((p) => !p)) throw fail(w, `mouse is L, R or M (or a mix like "L+R"), not "${d.mouse}"`);
      return { output: 5, a: parts.reduce((x, b) => x | b, 0), b: 0, c: 0 };
    }
    case 'move': {
      if (!Array.isArray(d.move) || d.move.length !== 2) throw fail(w, 'move is [dx, dy] in pixels (down is +dy)');
      const [dx, dy] = d.move.map((v, k) => int(v, -128, 127, k ? 'dy' : 'dx', w));
      if (!dx && !dy) throw fail(w, 'move [0, 0] goes nowhere');
      return { output: 6, a: dx, b: dy, c: 0 };
    }
    case 'glide': {
      if (!Array.isArray(d.glide) || d.glide.length !== 2) throw fail(w, 'glide is [dx, dy] in pixels with ms');
      const [dx, dy] = d.glide.map((v, k) => Math.round(int(v, -512, 508, k ? 'dy' : 'dx', w) / 4));
      if (!dx && !dy) throw fail(w, 'a glide of less than 2 px goes nowhere');
      const t = Math.round(num(d.ms, 10, 2550, 'ms', w, ' (glide time)') / 10);
      return { output: 7, a: dx, b: dy, c: t };
    }
    default: {
      const n = int(d.wheel, -128, 127, 'wheel', w);
      if (!n) throw fail(w, 'wheel 0 scrolls nothing');
      return { output: 8, a: n, b: 0, c: 0 };
    }
  }
}

function rule(r, i) {
  const where = `rules[${i}]`;
  if (!isObj(r)) throw fail(where, 'a rule is { when, at?, ms?, mode?, do }');
  only(r, ['when', 'at', 'ms', 'mode', 'do'], where);
  const t = C.TRIGGERS.indexOf(r.when);
  if (t < 0) throw fail(where, `when is ${C.TRIGGERS.join(', ')}`);
  let tval = 0;
  if (r.when === 'down' || r.when === 'up') {
    if (r.ms !== undefined) throw fail(where, `${r.when} takes at (mm), not ms`);
    tval = cmm(r.at, 10, 400, 'at', where);
  } else if (r.when === 'hold' || r.when === 'tap') {
    if (r.at !== undefined) throw fail(where, `${r.when} takes ms, not at`);
    tval = int(r.ms, 10, 10000, 'ms', where);
  } else if (r.at !== undefined || r.ms !== undefined) throw fail(where, `${r.when} takes no at or ms`);
  const out = output(r.do, where);
  const kind = C.outputKind(r.do);
  const mode = r.mode ?? C.defaultMode(r);
  if (!C.MODES.includes(mode)) throw fail(where, `mode is ${C.MODES.join(', ')}`);
  if (mode === 'while' && ['up', 'tap', 'release'].includes(r.when)) throw fail(where, `mode "while" works with down, hold and press, not ${r.when}`);
  if (kind === 'axisDepth' && !['press', 'while', 'toggle'].includes(mode)) throw fail(where, 'an axis that follows the depth (from / to) takes mode press, while or toggle');
  if (C.ONCE.includes(kind) && !['tap', 'press'].includes(mode)) throw fail(where, `${kind} happens once: mode tap or press`);
  return { trigger: t + 1, mode: C.MODES.indexOf(mode) + 1, tval, ...out };
}

// JSON -> wire record fields (no slot yet); throws 400 errors that name the field
function parseSpec(spec) {
  if (!isObj(spec)) throw fail('', 'the map is { key | slot, press?, gap?, alsoType?, rules: [...] }');
  only(spec, ['key', 'slot', 'press', 'gap', 'alsoType', 'rules', 'summary'], '');
  if (spec.key === undefined && spec.slot === undefined) throw fail('', 'give key (like "W") or slot');
  if (spec.slot !== undefined) int(spec.slot, 0, P.SLOTS - 1, 'slot', '');
  if (spec.key !== undefined && (typeof spec.key !== 'string' || !spec.key.trim())) throw fail('', 'key is a key name like "W"');
  if (spec.alsoType !== undefined && typeof spec.alsoType !== 'boolean') throw fail('', 'alsoType is true or false');
  if (!Array.isArray(spec.rules)) throw fail('', 'rules is a list (empty removes the map)');
  if (spec.rules.length > P.KA.MAX_RULES) throw fail('', `at most ${P.KA.MAX_RULES} rules per key, not ${spec.rules.length}`);
  return {
    press: cmm(spec.press ?? C.DEFAULTS.pressMm, 1, 400, 'press', ''),
    gap: cmm(spec.gap ?? C.DEFAULTS.gapMm, 1, 50, 'gap', ''),
    flags: spec.alsoType ? 1 : 0,
    rules: spec.rules.map(rule),
  };
}

const toRecord = (wire, slot) => P.encodeKaRecord({ ...wire, slot });

function doOf(x) {
  switch (x.output) {
    case 1: return { key: modsToName({ mods: x.a, usage: x.b }) };
    case 2: return { gamepad: C.BUTTONS[x.a - 11] ?? `target ${x.a}` };
    case 3: return { axis: C.AXES[x.a - 1] ?? `target ${x.a}`, percent: x.b };
    case 4: return { axis: C.AXES[x.a - 1] ?? `target ${x.a}`, from: x.b / 10, to: x.c / 10 };
    case 5: return { mouse: ['L', 'R', 'M'].filter((_, k) => x.a & (1 << k)).join('+') };
    case 6: return { move: [int8(x.a), int8(x.b)] };
    case 7: return { glide: [int8(x.a) * 4, int8(x.b) * 4], ms: x.c * 10 };
    case 8: return { wheel: int8(x.a) };
    default: return { raw: [x.output, x.a, x.b, x.c] };
  }
}

// record bytes (or decoded fields) -> JSON with the summary sentences
function fromRecord(bytes, name) {
  const r = Array.isArray(bytes) ? P.decodeKaRecord(bytes) : bytes;
  const rules = r.rules.map((x) => {
    const when = C.TRIGGERS[x.trigger - 1] ?? `trigger ${x.trigger}`;
    return { when, ...((when === 'down' || when === 'up') && { at: x.tval / 100 }), ...((when === 'hold' || when === 'tap') && { ms: x.tval }),
      mode: C.MODES[x.mode - 1] ?? `mode ${x.mode}`, do: doOf(x) };
  });
  const spec = { ...(name && { key: name }), slot: r.slot, press: (r.press || 30) / 100, gap: (r.gap || 10) / 100, alsoType: Boolean(r.flags & 1), rules };
  return { ...spec, summary: C.summary(spec) };
}

// the stored form of a spec (rounded to wire steps, defaults filled), without the keyboard
function preview(spec) {
  if (!isObj(spec)) parseSpec(spec);                  // throws the shape error
  const wire = parseSpec(spec.key === undefined && spec.slot === undefined ? { ...spec, slot: 0 } : spec);
  const out = fromRecord({ ...wire, slot: spec.slot ?? 0 });
  delete out.slot;
  return { ...(spec.key !== undefined && { key: spec.key }), ...(spec.slot !== undefined && { slot: spec.slot }), ...out };
}

module.exports = { parseSpec, toRecord, fromRecord, preview, fail };
