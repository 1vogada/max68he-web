// Key action maps (open firmware 0xEE, caps 'keyActions'): the JSON form <-> the 56-byte record
// (protocol.js KA), with the defaults and full validation. Names, default modes and the summary
// sentences are shared with the web UI (web/key-actions-core.js).
//
// { key: 'W' | slot: 12, press?: mm (0.3), gap?: mm (0.1), alsoType?: false,
//   rules: [{ when, at?, ms?, mode?, if?, do }] }   (up to 6 rules; see key-actions-core.js; `if`, mode
//   outputs and mouse keys (engine 2; a mouse keys rule takes 2 rule slots, 3 with speedBy pressure / both) in key-modes.js;
//   the flash output { flash, times } (caps 'modeFlash') too: it has no mode, its mode byte is the count)
// Wire units: depths in centi-mm (press 1..400, gap 1..50, at 10..400), hold / tap 10..10000 ms,
// axis-depth from / to in 0.1 mm (0 <= from < to <= 4 mm), glide dx dy / 4 (+-508 px) over 10..2550 ms.
const P = require('./protocol');
const { keyToMods, modsToName } = require('./keys');
const C = require('../web/key-actions-core');
const M = require('./key-modes');

const fail = (where, msg) => Object.assign(new Error(where ? `${where}: ${msg}` : msg), { status: 400 });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const lower = (list) => Object.fromEntries(list.map((n, i) => [n.toLowerCase(), i]));
const AXIS_IDX = lower(C.AXES), BUTTON_IDX = lower(C.BUTTONS);
const MOUSE_NAMES = { l: 1, left: 1, r: 2, right: 2, m: 4, middle: 4 };
const DO_FIELDS = { key: ['key'], gamepad: ['gamepad'], axis: ['axis', 'percent'], axisDepth: ['axis', 'from', 'to'],
  mouse: ['mouse'], move: ['move'], glide: ['glide', 'ms'], wheel: ['wheel'] };
const DO_HELP = 'do is { key }, { gamepad }, { axis, percent }, { axis, from, to }, { mouse }, { move: [dx, dy] }, { glide: [dx, dy], ms }, { wheel }, '
  + '{ mode, action }, { leaveAllModes: true }, { flash: true | [r, g, b] | "#rrggbb", times? } or { mouseKeys, start?, max?, rampMs?, curve?, power?, shareSpeed?, keepMs?, speedBy?, pressFrom?, pressTo? }';
const kindOf = (d) => C.outputKind(d) ?? M.newKind(d);
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

function output(d, where, ctx) {
  if (!isObj(d)) throw fail(where, DO_HELP);
  const kind = kindOf(d);
  if (!kind) throw fail(where, DO_HELP);
  const w = `${where}.do`;
  if (!C.outputKind(d)) return M.parseNewOutput(d, kind, w, ctx);
  only(d, DO_FIELDS[kind], where);
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

function rule(r, i, ctx, self) {
  const where = `rules[${i}]`;
  if (!isObj(r)) throw fail(where, 'a rule is { when, at?, ms?, mode?, if?, do }');
  only(r, ['when', 'at', 'ms', 'mode', 'if', 'do'], where);
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
  const { arg, depth, times, ...out } = output(r.do, where, ctx);
  const kind = kindOf(r.do), fresh = !C.outputKind(r.do);
  const need = r.if === undefined ? null : M.parseIf(r.if, where, ctx, self);
  if (kind === 'flash') {   // FLASH: the mode byte is the count; it fires once, there is no mode to pick
    if (r.mode !== undefined) throw fail(where, `a flash has no mode: it fires once and flashes times (1..${P.KA.FLASH_MAX}) times`);
    return [{ trigger: t + 1, mode: times, tval, ...out, ...(need && { need }) }];
  }
  const mode = r.mode ?? (fresh ? M.newDefaultMode(r.when, kind, r.do) : C.defaultMode(r));
  if (!C.MODES.includes(mode)) throw fail(where, `mode is ${C.MODES.join(', ')}`);
  if (mode === 'while' && ['up', 'tap', 'release'].includes(r.when)) throw fail(where, `mode "while" works with down, hold and press, not ${r.when}`);
  if (kind === 'axisDepth' && !['press', 'while', 'toggle'].includes(mode)) throw fail(where, 'an axis that follows the depth (from / to) takes mode press, while or toggle');
  if (C.ONCE.includes(kind) && !['tap', 'press'].includes(mode)) throw fail(where, `${kind} happens once: mode tap or press`);
  const allowed = fresh && M.newModes(kind, r.do);
  if (allowed && !allowed.includes(mode)) {
    const what = kind === 'mode' ? `a mode ${r.do.action}` : kind;
    throw fail(where, `${what} takes mode ${allowed.join(', ')}${kind === 'mode' ? ' (while only with action enter)' : ''}`);
  }
  return [{ trigger: t + 1, mode: C.MODES.indexOf(mode) + 1, tval, ...out, ...(need && { need }) }, ...(arg ? [arg] : []), ...(depth ? [depth] : [])];
}

// JSON -> wire record fields (no slot yet); throws 400 errors that name the field. ctx (from the
// keyboard, custom-key-actions.js) resolves `if` keys to slots and mode names to ids: { slotOf, modeOf,
// self (the key's slot) }; without it names stay names (enough to check and preview). Rules with
// `if` carry need: { keys, on, off }; a mouse keys rule is followed by its ARG rule (and DEPTH rule).
function parseSpec(spec, ctx) {
  if (!isObj(spec)) throw fail('', 'the map is { key | slot, press?, gap?, alsoType?, rules: [...] }');
  only(spec, ['key', 'slot', 'press', 'gap', 'alsoType', 'rules', 'summary'], '');
  if (spec.key === undefined && spec.slot === undefined) throw fail('', 'give key (like "W") or slot');
  if (spec.slot !== undefined) int(spec.slot, 0, P.SLOTS - 1, 'slot', '');
  if (spec.key !== undefined && (typeof spec.key !== 'string' || !spec.key.trim())) throw fail('', 'key is a key name like "W"');
  if (spec.alsoType !== undefined && typeof spec.alsoType !== 'boolean') throw fail('', 'alsoType is true or false');
  if (!Array.isArray(spec.rules)) throw fail('', 'rules is a list (empty removes the map)');
  const parts = Boolean(ctx?.parts);   // engine 6: a key takes more records, any number of rules
  if (!parts && spec.rules.length > P.KA.MAX_RULES) throw fail('', `at most ${P.KA.MAX_RULES} rules per key, not ${spec.rules.length}`);
  const head = {
    press: cmm(spec.press ?? C.DEFAULTS.pressMm, 1, 400, 'press', ''),
    gap: cmm(spec.gap ?? C.DEFAULTS.gapMm, 1, 50, 'gap', ''),
    flags: spec.alsoType ? 1 : 0,
  };
  const self = ctx ? ctx.self : spec.key !== undefined ? M.LOOSE.slotOf(spec.key) : spec.slot;
  const rules = spec.rules.flatMap((r, i) => rule(r, i, ctx ?? M.LOOSE, self));
  if (!parts && rules.length > P.KA.MAX_RULES) {
    throw fail('', `the rules take ${rules.length} of the key's ${P.KA.MAX_RULES} rule slots (a mouseKeys rule takes 2, 3 with speedBy pressure or both)`);
  }
  return { ...head, rules };
}

// true when a parsed map needs engine 2 (conditions, modes, mouse keys)
const usesModes = (wire) => wire.rules.some((x) => x.need || x.cond || x.output === M.OUT.MODE || x.output === M.OUT.MOUSE_KEYS || x.trigger === P.KA.ARG);

// wire -> 56 bytes; condIndex(entry) -> the entry number for rules with a condition (needs resolved
// slots / ids); part / bank: the record's (engine 6; its conditions are entries bank * 15 + 1..15)
function toRecord(wire, slot, condIndex, { part = 0, bank = 0 } = {}) {
  const rules = wire.rules.map(({ need, ...x }) => {
    if (!need) return x;
    if (!condIndex) throw new Error('a rule with a condition needs the condition table');
    return { ...x, cond: condIndex(M.condEntry(need)) };
  });
  return P.encodeKaRecord({ ...wire, rules, slot, part, bank });
}

// wire rules -> parts of at most 6 rule slots (engine 6); a mouse keys rule stays with its ARG / DEPTH rules
function splitParts(rules) {
  const groups = [];
  rules.forEach((x) => { if (x.trigger === P.KA.ARG && groups.length) groups[groups.length - 1].push(x); else groups.push([x]); });
  const parts = [[]];
  for (const g of groups) {
    if (parts[parts.length - 1].length + g.length > P.KA.MAX_RULES) parts.push([]);
    parts[parts.length - 1].push(...g);
  }
  return parts.filter((x) => x.length);
}

// wire -> one record per part; bankFor(entries) -> { bank, condIndex } for a part's conditions
function toRecords(wire, slot, bankFor) {
  return splitParts(wire.rules).map((rules, part) => {
    const entries = rules.filter((x) => x.need).map((x) => M.condEntry(x.need));
    const { bank = 0, condIndex } = bankFor ? bankFor(entries) : {};
    return toRecord({ ...wire, rules }, slot, condIndex, { part, bank });
  });
}

// a key's records (its parts, part 0 first) -> one decoded map (the rules of every part in order)
function mergeParts(records) {
  const d = records.map((r) => (Array.isArray(r) ? P.decodeKaRecord(r) : r)).sort((a, b) => (a.part ?? 0) - (b.part ?? 0));
  const { part, bank, ...head } = d[0];
  return { ...head, rules: d.flatMap((x) => x.rules) };
}

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

// record bytes (or decoded / parsed fields) -> JSON with the summary sentences. ctx rebuilds `if`
// and mode names: { conds: the 15 condition entries (entry n at [n - 1]), modeName(id), keyName(slot) };
// without conds a rule's condition shows as if: { entry: n }.
function fromRecord(bytes, name, ctx = {}) {
  const r = Array.isArray(bytes) ? P.decodeKaRecord(bytes) : bytes;
  const rules = [];
  const tails = new Set();   // ARG / DEPTH rules read with their mouse keys rule
  r.rules.forEach((x, i) => {
    if (tails.has(i)) return;
    const when = C.TRIGGERS[x.trigger - 1] ?? (x.trigger === P.KA.ARG ? 'arg' : `trigger ${x.trigger}`);
    const { arg, depth } = M.mkTail(r.rules, i);
    if (arg) tails.add(i + 1);
    if (depth) tails.add(i + 2);
    const need = x.need ?? (x.cond ? M.needOf(ctx.conds?.[x.cond - 1]) : null);
    const cond = need ? M.ifJson(need, ctx) : x.cond ? { entry: x.cond } : null;
    const flash = M.isFlashRule(x);   // its mode byte is the flash count (do.times), never a mode
    rules.push({ when, ...((when === 'down' || when === 'up') && { at: x.tval / 100 }), ...((when === 'hold' || when === 'tap') && { ms: x.tval }),
      ...(!flash && { mode: C.MODES[x.mode - 1] ?? `mode ${x.mode}` }), ...(cond && { if: cond }), do: M.newDo(x, arg, ctx, depth) ?? doOf(x) });
  });
  const spec = { ...(name && { key: name }), slot: r.slot, press: (r.press || 30) / 100, gap: (r.gap || 10) / 100, alsoType: Boolean(r.flags & 1), rules };
  return { ...spec, summary: M.summary(spec) };
}

// the stored form of a spec (rounded to wire steps, defaults filled), without the keyboard
function preview(spec) {
  if (!isObj(spec)) parseSpec(spec);                  // throws the shape error
  const wire = parseSpec(spec.key === undefined && spec.slot === undefined ? { ...spec, slot: 0 } : spec);
  const out = fromRecord({ ...wire, slot: spec.slot ?? 0 });
  delete out.slot;
  return { ...(spec.key !== undefined && { key: spec.key }), ...(spec.slot !== undefined && { slot: spec.slot }), ...out };
}

module.exports = { parseSpec, toRecord, toRecords, splitParts, mergeParts, fromRecord, preview, usesModes, usesFlash: M.usesFlash, fail };
