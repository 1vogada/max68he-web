// kbcode core: script -> plan -> changes. Pure and environment-neutral (no fs, no vm, no process):
// the Node runner (kbcode.js) and, later, the browser-only web version both use it. The device
// part (reading the keyboard, writing) is in kbcode.js.
//
// compile(code, { state, run }) (async) runs the script through `run` (a sandbox runner: kbcode.js has
// the Node one: a worker thread with node:vm) with the `kb` API of kbcode-api.js, then checks every recorded operation with the
// driver's own validation (limits.js, keys.js, protocol.js, key-actions.js, key-modes.js,
// sequence.js) and returns { ok, plan, errors: [{ line, col, message }], logs, notes }.
// diff(plan, cur, state) compares a plan with what was read from the keyboard (cur; null = no
// keyboard) -> { changes: [{ section, text }], writes, problems }; writes is what apply sends.
//
// state (what the keyboard is; null = none connected, no feature checks): { model, open, features,
// engine, entries, hostApi, openModes, modes: [{ id, name }] | null, profile, unitMm }
const P = require('./protocol');
const { parseKey, keyToMods, slotName, textToSteps } = require('./keys');
const { SWITCH_LIMITS } = require('./limits');
const KA = require('./key-actions');
const M = require('./key-modes');
const { parseSequence, sequenceMs, hasGlide } = require('./sequence');
const { API_SOURCE } = require('./kbcode-api');

const FILE = 'kbcode.js';         // the script's file name in stack traces (line numbers)

// ---- layouts ------------------------------------------------------------------------------
// MAX68HE: slot = matrix column * 6 + row (the board's physical keys; the factory keymap names
// them, tests/fixtures/max68he-keys.js). Keys are physical: a key keeps its name after a remap.
const MAX68HE_COLUMNS = [
  [null, 'Esc', 'Tab', 'Caps', 'LShift', 'LCtrl'], [null, '1', 'Q', 'A', null, 'LWin'], [null, '2', 'W', 'S', 'Z', 'LAlt'],
  [null, '3', 'E', 'D', 'X'], [null, '4', 'R', 'F', 'C'], [null, '5', 'T', 'G', 'V'], [null, '6', 'Y', 'H', 'B', 'Space'],
  [null, '7', 'U', 'J', 'N'], [null, '8', 'I', 'K', 'M'], [null, '9', 'O', 'L', ',', 'RAlt'], [null, '0', 'P', ';', '.', 'Fn'],
  [null, '-', '[', "'", '/', 'RCtrl'], [null, '=', ']', null, 'RShift', 'Left'], [null, 'Bksp', '\\', 'Enter', 'Up', 'Down'],
  [null, 'Home', 'Del', 'PgUp', 'PgDn', 'Right'],
];
const MAX68HE_SLOT = Object.fromEntries(MAX68HE_COLUMNS.flatMap((rows, col) => rows.map((n, row) => n && [n, col * 6 + row]).filter(Boolean)));
const MAX68HE_ROWS = [
  ['Esc', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '=', 'Bksp', 'Home'],
  ['Tab', 'Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P', '[', ']', '\\', 'Del'],
  ['Caps', 'A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', ';', "'", 'Enter', 'PgUp'],
  ['LShift', 'Z', 'X', 'C', 'V', 'B', 'N', 'M', ',', '.', '/', 'RShift', 'Up', 'PgDn'],
  ['LCtrl', 'LWin', 'LAlt', 'Space', 'RAlt', 'Fn', 'RCtrl', 'Left', 'Down', 'Right'],
].map((r) => r.map((n) => [n, MAX68HE_SLOT[n]]));
// X82HE Pro: fixed slots from its stock keymap (web/layout.js)
const x82 = (names, first, step = 6) => names.map((n, i) => [n, first + i * step]);
const X82_ROWS = [
  [['Esc', 0], ...x82(['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'], 6), ['Knob', 92], ['Del', 78], ['Ins', 84]],
  [...x82(['`', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '='], 1), ['Bksp', 79], ['Home', 85]],
  [['Tab', 2], ...x82(['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P', '[', ']'], 8), ['\\', 80], ['PgUp', 86]],
  [['Caps', 3], ...x82(['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', ';', "'"], 9), ['Enter', 81], ['PgDn', 87]],
  [['LShift', 4], ...x82(['Z', 'X', 'C', 'V', 'B', 'N', 'M', ',', '.', '/'], 16), ['RShift', 76], ['Up', 82], ['End', 88]],
  [['LCtrl', 5], ['LWin', 17], ['LAlt', 23], ['Space', 41], ['RAlt', 59], ['Fn', 65], ['RCtrl', 71], ['Left', 77], ['Down', 83], ['Right', 89]],
];
const LAYOUTS = { max68he: { name: 'MAX68HE', rows: MAX68HE_ROWS }, x82he: { name: 'X82HE Pro', rows: X82_ROWS } };
const ALIASES = [['ctrl', 'LCtrl'], ['shift', 'LShift'], ['alt', 'LAlt'], ['win', 'LWin'], ['gui', 'LWin'], ['cmd', 'LWin'],
  ['lctrl', 'LCtrl'], ['rctrl', 'RCtrl'], ['lshift', 'LShift'], ['rshift', 'RShift'], ['lalt', 'LAlt'], ['ralt', 'RAlt'],
  ['escape', 'Esc'], ['backspace', 'Bksp'], ['return', 'Enter'], ['capslock', 'Caps'], ['delete', 'Del'], ['insert', 'Ins'],
  ['pageup', 'PgUp'], ['pagedown', 'PgDn'], ['spacebar', 'Space'], ['arrowup', 'Up'], ['arrowdown', 'Down'], ['arrowleft', 'Left'],
  ['arrowright', 'Right'], ['minus', '-'], ['equal', '='], ['equals', '='], ['backslash', '\\'], ['semicolon', ';'], ['quote', "'"],
  ['comma', ','], ['period', '.'], ['dot', '.'], ['slash', '/'], ['lbracket', '['], ['rbracket', ']'], ['grave', '`'], ['backtick', '`']];
// key groups, by name (the web UI's quick picks: typing = letters, digits, punctuation and arrows)
const GROUPS = {
  typing: (n) => /^([A-Z0-9]|[-=[\]\\;',./`])$/.test(n) || ['Left', 'Right', 'Up', 'Down'].includes(n),
  letters: (n) => /^[A-Z]$/.test(n),
  digits: (n) => /^[0-9]$/.test(n),
  wasd: (n) => ['W', 'A', 'S', 'D'].includes(n),
  arrows: (n) => ['Up', 'Down', 'Left', 'Right'].includes(n),
  mods: (n) => /Shift|Ctrl|Alt|Win|Fn|Caps|Tab|Esc|Enter|Space|Bksp|Del|PgUp|PgDn/.test(n),
  modifiers: (n) => /^[LR](Ctrl|Shift|Alt|Win)$/.test(n),
  nav: (n) => ['Home', 'End', 'Ins', 'Del', 'PgUp', 'PgDn'].includes(n),
};

function layoutOf(model) { return LAYOUTS[model] ?? LAYOUTS.max68he; }
function keyTable(model) {
  const keys = layoutOf(model).rows.flat().map(([name, slot]) => ({ name, slot }));
  const byName = new Map(keys.map((k) => [k.name.toLowerCase(), k]));
  for (const [a, n] of ALIASES) if (!byName.has(a) && byName.has(n.toLowerCase())) byName.set(a, byName.get(n.toLowerCase()));
  return { keys, byName, bySlot: new Map(keys.map((k) => [k.slot, k])) };
}

// what the sandbox's `kb` is built from
function metaFor(state) {
  const model = state?.model ?? 'max68he';
  const L = layoutOf(model);
  const keys = L.rows.flat().map(([name, slot]) => ({ name, slot }));
  const have = new Set(keys.map((k) => k.name.toLowerCase()));
  return {
    file: FILE, model, modelName: L.name, keys,
    aliases: ALIASES.filter(([a, n]) => have.has(n.toLowerCase()) && !have.has(a)),
    rows: L.rows.map((r) => r.map(([, s]) => s)),
    groups: Object.fromEntries(Object.entries(GROUPS).map(([g, f]) => [g, keys.filter((k) => f(k.name)).map((k) => k.slot)])),
    firmware: state ? { known: true, open: Boolean(state.open), engine: state.engine ?? 0, features: [...(state.features ?? [])] }
      : { known: false, open: true, engine: 4, features: [] },
  };
}

// ---- colours --------------------------------------------------------------------------------
const NAMED = Object.fromEntries(('black:000000 silver:c0c0c0 gray:808080 grey:808080 white:ffffff maroon:800000 red:ff0000 purple:800080 '
  + 'fuchsia:ff00ff magenta:ff00ff green:008000 lime:00ff00 olive:808000 yellow:ffff00 navy:000080 blue:0000ff teal:008080 aqua:00ffff '
  + 'cyan:00ffff orange:ffa500 aliceblue:f0f8ff antiquewhite:faebd7 aquamarine:7fffd4 azure:f0ffff beige:f5f5dc bisque:ffe4c4 '
  + 'blanchedalmond:ffebcd blueviolet:8a2be2 brown:a52a2a burlywood:deb887 cadetblue:5f9ea0 chartreuse:7fff00 chocolate:d2691e '
  + 'coral:ff7f50 cornflowerblue:6495ed cornsilk:fff8dc crimson:dc143c darkblue:00008b darkcyan:008b8b darkgoldenrod:b8860b '
  + 'darkgray:a9a9a9 darkgrey:a9a9a9 darkgreen:006400 darkkhaki:bdb76b darkmagenta:8b008b darkolivegreen:556b2f darkorange:ff8c00 '
  + 'darkorchid:9932cc darkred:8b0000 darksalmon:e9967a darkseagreen:8fbc8f darkslateblue:483d8b darkslategray:2f4f4f '
  + 'darkslategrey:2f4f4f darkturquoise:00ced1 darkviolet:9400d3 deeppink:ff1493 deepskyblue:00bfff dimgray:696969 dimgrey:696969 '
  + 'dodgerblue:1e90ff firebrick:b22222 floralwhite:fffaf0 forestgreen:228b22 gainsboro:dcdcdc ghostwhite:f8f8ff gold:ffd700 '
  + 'goldenrod:daa520 greenyellow:adff2f honeydew:f0fff0 hotpink:ff69b4 indianred:cd5c5c indigo:4b0082 ivory:fffff0 khaki:f0e68c '
  + 'lavender:e6e6fa lavenderblush:fff0f5 lawngreen:7cfc00 lemonchiffon:fffacd lightblue:add8e6 lightcoral:f08080 lightcyan:e0ffff '
  + 'lightgoldenrodyellow:fafad2 lightgray:d3d3d3 lightgrey:d3d3d3 lightgreen:90ee90 lightpink:ffb6c1 lightsalmon:ffa07a '
  + 'lightseagreen:20b2aa lightskyblue:87cefa lightslategray:778899 lightslategrey:778899 lightsteelblue:b0c4de lightyellow:ffffe0 '
  + 'limegreen:32cd32 linen:faf0e6 mediumaquamarine:66cdaa mediumblue:0000cd mediumorchid:ba55d3 mediumpurple:9370db '
  + 'mediumseagreen:3cb371 mediumslateblue:7b68ee mediumspringgreen:00fa9a mediumturquoise:48d1cc mediumvioletred:c71585 '
  + 'midnightblue:191970 mintcream:f5fffa mistyrose:ffe4e1 moccasin:ffe4b5 navajowhite:ffdead oldlace:fdf5e6 olivedrab:6b8e23 '
  + 'orangered:ff4500 orchid:da70d6 palegoldenrod:eee8aa palegreen:98fb98 paleturquoise:afeeee palevioletred:db7093 '
  + 'papayawhip:ffefd5 peachpuff:ffdab9 peru:cd853f pink:ffc0cb plum:dda0dd powderblue:b0e0e6 rebeccapurple:663399 '
  + 'rosybrown:bc8f8f royalblue:4169e1 saddlebrown:8b4513 salmon:fa8072 sandybrown:f4a460 seagreen:2e8b57 seashell:fff5ee '
  + 'sienna:a0522d skyblue:87ceeb slateblue:6a5acd slategray:708090 slategrey:708090 snow:fffafa springgreen:00ff7f '
  + 'steelblue:4682b4 tan:d2b48c thistle:d8bfd8 tomato:ff6347 turquoise:40e0d0 violet:ee82ee wheat:f5deb3 whitesmoke:f5f5f5 '
  + 'yellowgreen:9acd32 off:000000').split(' ').map((p) => p.split(':')));

const hex2 = (v) => v.toString(16).padStart(2, '0');
const toHex = ([r, g, b]) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;
function hslToRgb(h, s, l) {
  const S = s / 100, L = l / 100, k = (n) => (n + h / 30) % 12, a = S * Math.min(L, 1 - L);
  const f = (n) => L - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}
// '#ff4400' | 'ff4400' | '#f40' | 'rgb(255, 68, 0)' | 'hsl(16, 100%, 50%)' | 'cyan' | [r, g, b] -> [r, g, b]; throws
function parseColor(c) {
  const bad = () => new Error(`${JSON.stringify(c)} is not a colour (use '#ff4400', 'rgb(255, 68, 0)', 'hsl(16, 100%, 50%)', a CSS name like 'cyan', or [r, g, b])`);
  if (Array.isArray(c)) {
    if (c.length !== 3 || !c.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) throw bad();
    return [...c];
  }
  if (typeof c !== 'string') throw bad();
  const s = c.trim().toLowerCase();
  if (NAMED[s]) return parseColor(NAMED[s]);
  let m = /^#?([0-9a-f]{6})$/.exec(s);
  if (m) { const v = parseInt(m[1], 16); return [v >> 16, (v >> 8) & 0xff, v & 0xff]; }
  m = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s);
  if (m) return m.slice(1).map((d) => parseInt(d + d, 16));
  m = /^rgb\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/.exec(s);
  if (m) {
    const v = m.slice(1).map(Number);
    if (!v.every((x) => x >= 0 && x <= 255)) throw bad();
    return v.map(Math.round);
  }
  m = /^hsl\(\s*(-?[\d.]+)(?:deg)?\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/.exec(s);
  if (m) {
    const [h, sat, l] = m.slice(1).map(Number);
    if (sat > 100 || l > 100) throw bad();
    return hslToRgb(((h % 360) + 360) % 360, sat, l);
  }
  throw bad();
}

// ---- lighting effects -----------------------------------------------------------------------
// stock modes 1..19 (13 = the stored picture, see kb.lighting.picture); [mode, name, option names]
const STOCK_EFFECTS = [[1, 'Static'], [2, 'Breathing'], [3, 'Spectrum'], [4, 'Wave', ['Right', 'Left', 'Down', 'Up']], [5, 'Ripple'],
  [6, 'Star dots'], [7, 'Flow', ['Zigzag', 'Spiral']], [8, 'Key shadow'], [9, 'Layers'], [10, 'Sine'], [11, 'Spring', ['Outward', 'Inward']],
  [12, 'Neon', ['Right', 'Left']], [13, 'Picture'], [14, 'Radiant'], [15, 'Loop', ['CCW', 'CW']], [16, 'Colour grid'], [17, 'Snowfall'],
  [18, 'Meteor'], [19, 'Silent snow']];
const norm = (s) => String(s).toLowerCase().replace(/color/g, 'colour').replace(/[^a-z0-9]/g, '');
const EFFECTS = [...STOCK_EFFECTS.map(([mode, name, options]) => ({ mode, name, options })),
  ...Object.entries(P.OPEN_LIGHT_MODES).map(([m, name]) => ({ mode: Number(m), name, open: true }))];
const EFFECT_BY_NAME = new Map(EFFECTS.map((e) => [norm(e.name), e]));
const effectName = (mode) => EFFECTS.find((e) => e.mode === mode)?.name ?? `mode ${mode}`;

// ---- small helpers --------------------------------------------------------------------------
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fmtMm = (v) => `${Number(v).toFixed(2)} mm`;
const show = (v) => (typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? String(v));
const badValue = (v) => isObj(v) && '$bad' in v;
const LABEL = { actuation: 'actuation', release: 'release', rtPress: 'rapidTrigger press', rtRelease: 'rapidTrigger release', deadZone: 'deadZone' };
const SWITCH_FIELDS = ['actuation', 'release', 'rtPress', 'rtRelease', 'deadZone', 'rapidTrigger', 'continuousRt'];
function listNames(names, max = 8) {
  return names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
}
const ON = (b) => (b ? 'on' : 'off');

// ---- compile ---------------------------------------------------------------------------------

// The script -> Promise<{ ok, plan, errors, logs, notes }>. run(apiSource, meta, code) -> (a promise of) { json } | { error: { message, line, col } }
// (kbcode.js: runScript). state: see the top; null = no keyboard.
async function compile(code, { state = null, run } = {}) {
  if (typeof code !== 'string') return { ok: false, plan: null, errors: [{ line: 0, col: 0, message: 'code is a string' }], logs: [], notes: [] };
  if (typeof run !== 'function') throw new Error('compile needs a sandbox runner (run)');
  const r = await run(API_SOURCE, metaFor(state), code);
  if (r.error) return { ok: false, plan: null, errors: [r.error], logs: [], notes: [] };
  let data;
  try { data = JSON.parse(r.json); } catch { data = null; }
  if (!isObj(data) || !Array.isArray(data.ops)) {
    return { ok: false, plan: null, errors: [{ line: 0, col: 0, message: 'the script broke the kb API (its result was not readable)' }], logs: [], notes: [] };
  }
  return buildPlan(data.ops, state);
}

// recorded operations -> plan, checked like the driver checks a write
function buildPlan(ops, state = null) {
  const known = Boolean(state);
  const model = state?.model ?? 'max68he';
  const T = keyTable(model);
  const errors = [], logs = [], notes = [];
  const has = (f) => !known || state.features?.includes(f);
  const at0 = { line: 0, col: 0 };
  const err = (at, message) => { errors.push({ line: at?.line ?? 0, col: at?.col ?? 0, message }); };
  const keyName = (slot) => T.bySlot.get(slot)?.name ?? `slot ${slot}`;
  const needOpen = (at, what) => { if (known && !state.open) { err(at, `${what} needs the open firmware (this keyboard runs the stock firmware)`); return false; } return true; };
  const needFeature = (at, f, what) => {
    if (!needOpen(at, what)) return false;
    if (!has(f)) { err(at, `${what} needs a newer open firmware (feature "${f}" is missing on this keyboard)`); return false; }
    return true;
  };
  const list = Array.isArray(ops) ? ops.filter((o) => isObj(o) && typeof o.op === 'string') : [];
  for (const o of list) if (!isObj(o.at)) o.at = at0;
  const plan = { format: 'kbcode-plan', version: 1, model };

  // ---- modes first (rules and layers refer to them by name) ----
  const modes = [];          // [{ id, name, at }]
  const boardModes = state?.modes ?? null;
  for (const o of list.filter((x) => x.op === 'mode')) {
    const name = typeof o.name === 'string' ? o.name.trim() : o.name;
    if (typeof name !== 'string' || !name) { err(o.at, 'kb.mode takes a name like "Mouse"'); continue; }
    try { P.encodeModeName(name); } catch (e) { err(o.at, `mode name ${show(name)}: ${e.message}`); continue; }
    if (o.id !== undefined && (!Number.isInteger(o.id) || o.id < 1 || o.id > P.KA.MODES)) { err(o.at, `mode number is 1..${P.KA.MODES}, not ${show(o.id)}`); continue; }
    const same = modes.find((m) => m.name.toLowerCase() === name.toLowerCase());
    if (same) {
      if (o.id !== undefined && same.id !== undefined && same.id !== o.id) err(o.at, `mode "${name}" is already mode ${same.id}`);
      else if (o.id !== undefined) same.id = o.id;
      continue;
    }
    modes.push({ name, id: o.id, at: o.at });
  }
  for (const m of modes) {   // ids: given, else the keyboard's mode of that name, else a free one
    if (m.id !== undefined) {
      const onBoard = boardModes?.find((b) => b.name && b.name.toLowerCase() === m.name.toLowerCase());
      if (onBoard && onBoard.id !== m.id && !modes.some((x) => x !== m && x.id === onBoard.id)) {
        err(m.at, `mode "${m.name}" is mode ${onBoard.id} on the keyboard; leave out the number, or rename mode ${onBoard.id} too`);
      }
      continue;
    }
    const onBoard = boardModes?.find((b) => b.name && b.name.toLowerCase() === m.name.toLowerCase());
    const taken = (id) => modes.some((x) => x !== m && x.id === id);
    if (onBoard && !taken(onBoard.id)) { m.id = onBoard.id; continue; }
    const free = [1, 2, 3].filter((id) => !taken(id));
    const id = boardModes ? free.find((i) => !boardModes[i - 1]?.name) : free[0];
    if (id === undefined) {
      err(m.at, boardModes && free.length
        ? `all ${P.KA.MODES} modes already have names on the keyboard (${boardModes.map((b) => b.name || '-').join(', ')}): give a number to reuse one, like kb.mode(${show(m.name)}, ${free[0]})`
        : `at most ${P.KA.MODES} modes`);
      continue;
    }
    m.id = id;
  }
  const seenIds = new Map();
  for (const m of modes.filter((x) => x.id !== undefined)) {
    if (seenIds.has(m.id)) err(m.at, `modes "${seenIds.get(m.id)}" and "${m.name}" are both mode ${m.id}`);
    seenIds.set(m.id, m.name);
  }
  const allModes = () => {   // name lookup: the script's modes, then the keyboard's
    const out = modes.filter((m) => m.id !== undefined).map((m) => ({ id: m.id, name: m.name }));
    for (const b of boardModes ?? []) if (b.name && !out.some((x) => x.id === b.id) && !out.some((x) => x.name.toLowerCase() === b.name.toLowerCase())) out.push({ id: b.id, name: b.name });
    return out;
  };
  const modeByName = (name) => allModes().find((m) => m.name.toLowerCase() === String(name).trim().toLowerCase());
  if (modes.length && known && (!has('keyActions') || (state.engine ?? 0) < 2)) {
    err(modes[0].at, 'modes need a newer open firmware (key action engine 2)');
  } else if (modes.length) {
    plan.keyActions ={ modes: modes.filter((m) => m.id !== undefined).map((m) => ({ id: m.id, name: m.name })).sort((a, b) => a.id - b.id), maps: [] };
  }

  // ---- everything else, in script order ----
  const switches = new Map();        // slot -> fields
  const remaps = new Map();          // `${layer}:${slot}` -> entry
  const advanced = new Map();        // slot -> entry
  const ruleOps = [];                // [{ slot, rule, at }]
  const mapOpts = new Map();         // slot -> { press, gap, alsoType, at }
  const bindings = new Map();        // slot -> target | null
  let picture = null, lighting = null, effectAt = null, replaceMaps = false;

  const slotsOk = (o) => Array.isArray(o.slots) && o.slots.every((s) => T.bySlot.has(s));
  for (const o of list) {
    const at = o.at;
    if (['switch', 'remap', 'color', 'advanced', 'bind', 'rule', 'map'].includes(o.op) && !slotsOk(o)) { err(at, 'unknown key'); continue; }
    switch (o.op) {
      case 'error': err(at, String(o.message)); break;
      case 'log': logs.push({ line: at.line, text: String(o.text) }); break;
      case 'mode': break;
      case 'profile':
        if (![0, 1, 2, 3].includes(o.value)) err(at, `profile is 0..3, not ${show(o.value)}`);
        else plan.profile = o.value;
        break;
      case 'switch': {
        const f = isObj(o.fields) ? o.fields : {};
        const clean = {};
        for (const [k, v] of Object.entries(f)) {
          if (!SWITCH_FIELDS.includes(k)) {
            err(at, o.rt ? `rapidTrigger takes { press, release, continuous }, not "${k}"` : `unknown switch setting "${k}" (${SWITCH_FIELDS.join(', ')})`);
            continue;
          }
          if (k === 'rapidTrigger' || k === 'continuousRt') {
            if (typeof v !== 'boolean') { err(at, `${k === 'continuousRt' ? 'continuous' : k} is true or false, not ${show(v)}`); continue; }
            if (k === 'continuousRt' && v && !needOpen(at, 'continuous rapid trigger')) continue;
            clean[k] = v;
            continue;
          }
          const [lo, hi] = SWITCH_LIMITS[k];
          if (typeof v !== 'number' || badValue(v)) { err(at, `${LABEL[k]} is a number of mm, not ${show(v)}`); continue; }
          if (v > hi) { err(at, `${LABEL[k]} ${v} mm is above ${hi}`); continue; }
          if (v < lo) { err(at, `${LABEL[k]} ${v} mm is below ${lo}`); continue; }
          clean[k] = Math.round(v * 1000) / 1000;
        }
        for (const s of o.slots) switches.set(s, { ...switches.get(s), ...clean });
        break;
      }
      case 'remap': {
        const layer = parseLayer(o.layer, at);
        if (!layer) break;
        if (typeof o.value !== 'string') { err(at, `remap takes a key value like "A", "Ctrl+C", "VolumeUp", "Macro2:toggle", "Text3" or "Disabled", not ${show(o.value)}`); break; }
        let bytes;
        try { bytes = parseKey(o.value); P.checkValue(bytes); } catch (e) {
          err(at, /unknown key/.test(e.message) ? `unknown key value ${show(o.value)} (names like "A", "Ctrl+C", "VolumeUp", "MouseLeft", "Macro2:toggle", "Text3", "Fn", "Disabled")` : `${o.value}: ${e.message}`);
          break;
        }
        if (bytes[0] === 11 && !needFeature(at, 'textKeys', 'A text key')) break;
        if (bytes[0] === 10 && bytes[1] === 0xe0 && !needOpen(at, `${o.value}`)) break;
        for (const s of o.slots) remaps.set(`${layer.id}:${layer.os ?? ""}:${s}`, { layer: layer.id, ...(layer.os && { os: layer.os }), slot: s, key: keyName(s), value: o.value, bytes, at });
        break;
      }
      case 'color': {
        let rgb;
        try { rgb = parseColor(o.color); } catch (e) { err(at, e.message); break; }
        picture ??= { index: 0, colors: {}, fill: '#000000', show: true, at };
        for (const s of o.slots) picture.colors[s] = toHex(rgb);
        break;
      }
      case 'picture': {
        if (!Number.isInteger(o.index) || o.index < 0 || o.index > 4) { err(at, `picture is 0..4, not ${show(o.index)}`); break; }
        picture ??= { index: 0, colors: {}, fill: '#000000', show: true, at };
        picture.index = o.index;
        const op = isObj(o.opts) ? o.opts : {};
        for (const k of Object.keys(op)) if (!['fill', 'show'].includes(k)) err(at, `picture options are fill and show, not "${k}"`);
        if (op.fill !== undefined) { try { picture.fill = toHex(parseColor(op.fill)); } catch (e) { err(at, e.message); } }
        if (op.show !== undefined) {
          if (typeof op.show !== 'boolean') err(at, 'show is true or false');
          else { picture.show = op.show; picture.showSet = true; }
        }
        break;
      }
      case 'lighting': {
        lighting ??= {};
        const v = o.value;
        switch (o.field) {
          case 'effect': {
            effectAt = at;
            let e = typeof v === 'number' ? EFFECTS.find((x) => x.mode === v) : EFFECT_BY_NAME.get(norm(v));
            if (!e) {
              err(at, `unknown effect ${show(v)} (${EFFECTS.filter((x) => !x.open).map((x) => x.name).join(', ')}; open firmware: ${EFFECTS.filter((x) => x.open).map((x) => x.name).join(', ')})`);
              break;
            }
            if (e.open) {
              if (!needOpen(at, `the ${e.name} effect`)) break;
              if (known && state.openModes && !state.openModes.includes(e.mode)) { err(at, `the ${e.name} effect needs a newer open firmware`); break; }
            }
            lighting.mode = e.mode;
            if (e.mode === 13) { picture ??= { index: 0, colors: {}, fill: '#000000', show: true, at }; picture.show = true; }
            break;
          }
          case 'color': {
            try { const [r, g, b] = parseColor(v); Object.assign(lighting, { r, g, b, rainbow: false, presetColour: null }); } catch (e) { err(at, e.message); }
            break;
          }
          case 'rainbow':
            if (typeof v !== 'boolean') err(at, 'rainbow is true or false');
            else Object.assign(lighting, { rainbow: v, presetColour: null });
            break;
          case 'speed': case 'brightness':
            if (!Number.isInteger(v) || v < 0 || v > 4) err(at, `${o.field} is a whole number 0..4 (4 = ${o.field === 'speed' ? 'fastest' : 'brightest'}), not ${show(v)}`);
            else lighting[o.field] = v;
            break;
          case 'option':
            if (!Number.isInteger(v) || v < 0 || v > 15) err(at, `option is 0..15, not ${show(v)}`);
            else lighting.option = v;
            break;
          case 'direction':
            lighting.direction = { value: v, at };
            break;
          default: err(at, `unknown lighting setting "${o.field}" (color, speed, brightness, direction, option, rainbow)`);
        }
        break;
      }
      case 'advanced': {
        const entry = parseAdvanced(o, at);
        if (entry) for (const s of o.slots) advanced.set(s, { slot: s, key: keyName(s), ...entry(s), at });
        break;
      }
      case 'bind': {
        if (!needFeature(at, 'gamepad', 'The on-board gamepad')) break;
        const t = o.target === null ? null : typeof o.target === 'string' ? o.target.trim().toLowerCase() : undefined;
        if (t === undefined || (t !== null && !P.GAMEPAD_TARGETS.includes(t))) { err(at, `gamepad target is one of ${P.GAMEPAD_TARGETS.join(', ')} (or null to unbind), not ${show(o.target)}`); break; }
        for (const s of o.slots) bindings.set(s, t);
        break;
      }
      case 'gamepad': {
        if (!needFeature(at, 'gamepad', 'The on-board gamepad')) break;
        const g = parseGamepad(o.settings, at);
        if (g) plan.gamepad = { ...plan.gamepad, settings: { ...plan.gamepad?.settings, ...g } };
        break;
      }
      case 'rule':
        for (const s of o.slots) ruleOps.push({ slot: s, rule: o.rule, at });
        break;
      case 'map': {
        const op = isObj(o.opts) ? o.opts : {};
        for (const k of Object.keys(op)) if (!['press', 'gap', 'alsoType'].includes(k)) err(at, `actionMap takes press, gap and alsoType, not "${k}"`);
        for (const s of o.slots) mapOpts.set(s, { ...mapOpts.get(s), ...op, at });
        break;
      }
      case 'resetKeyActions': replaceMaps = true; break;
      case 'macro': parseMacro(o, at); break;
      case 'text': {
        if (!Number.isInteger(o.index) || o.index < 0 || o.index >= P.TEXT_COUNT) { err(at, `text key is 0..${P.TEXT_COUNT - 1}, not ${show(o.index)}`); break; }
        if (typeof o.text !== 'string') { err(at, 'kb.text(index, "the text")'); break; }
        const n = new TextEncoder().encode(o.text).length;
        if (n > P.TEXT_MAX_LEN) { err(at, `text ${o.index} is ${n} bytes, at most ${P.TEXT_MAX_LEN} (plain characters take 1, special ones 2 to 4)`); break; }
        if (!needFeature(at, 'textKeys', 'Text keys')) break;
        plan.texts = [...(plan.texts ?? []).filter((t) => t.index !== o.index), { index: o.index, text: o.text }];
        break;
      }
      case 'sequence': {
        if (typeof o.text !== 'string' && !Array.isArray(o.text)) { err(at, 'kb.sequence takes the sequence text, like "W down; 120ms; Space tap; release"'); break; }
        let steps;
        try { steps = parseSequence(o.text); } catch (e) { err(at, e.message.startsWith("sequence") ? e.message : `sequence: ${e.message}`); break; }
        if (steps.length > P.SEQ.CAPACITY) { err(at, `${steps.length} sequence steps, the keyboard holds ${P.SEQ.CAPACITY}`); break; }
        if (!needFeature(at, 'sequence', 'Play sequence')) break;
        if (hasGlide(steps) && !needFeature(at, 'sequenceGlide', 'Mouse glides in a sequence')) break;
        const op = isObj(o.opts) ? o.opts : {};
        for (const k of Object.keys(op)) if (k !== 'stopOnKey') err(at, `sequence options: stopOnKey, not "${k}"`);
        if (op.stopOnKey !== undefined && typeof op.stopOnKey !== 'boolean') err(at, 'stopOnKey is true or false');
        plan.sequence = { text: o.text, stopOnKey: Boolean(op.stopOnKey), steps: steps.length, ms: sequenceMs(steps) };
        break;
      }
      case 'options': parseOptions(o.value, at); break;
      case 'polling':
        if (!P.REPORT_RATES.includes(o.value)) err(at, `polling rate is one of ${P.REPORT_RATES.join(', ')} Hz, not ${show(o.value)}`);
        else plan.pollingRateHz = o.value;
        break;
      case 'fwOptions': parseFwOptions(o.value, at); break;
      default: err(at, `unknown operation ${o.op}`);
    }
  }

  // ---- after the walk: things that depend on each other ----
  if (switches.size) plan.switches = [...switches].filter(([, f]) => Object.keys(f).length).map(([slot, f]) => ({ key: keyName(slot), slot, ...f }));
  if (remaps.size) plan.remap = [...remaps.values()].map(({ at, ...r }) => r);
  if (lighting) {
    if (lighting.direction) {
      const { value, at } = lighting.direction;
      delete lighting.direction;
      const e = EFFECTS.find((x) => x.mode === lighting.mode);
      const i = e?.options?.findIndex((n) => n.toLowerCase() === String(value).toLowerCase()) ?? -1;
      if (lighting.mode === undefined) err(at, 'pick the effect first: kb.lighting.effect("wave", { direction: "left" })');
      else if (!e?.options) err(at, `the ${effectName(lighting.mode)} effect has no direction`);
      else if (i < 0) err(at, `${e.name} direction is ${e.options.join(', ')}, not ${show(value)}`);
      else lighting.option = i;
    }
    if (Object.keys(lighting).length) plan.lighting = lighting;
  }
  if (picture) {
    const { at, showSet, ...pic } = picture;
    if (plan.lighting?.mode !== undefined && plan.lighting.mode !== 13 && pic.show) {
      pic.show = false;
      notes.push(`Per-key colours go into picture ${pic.index}, but the effect is ${effectName(plan.lighting.mode)}, so the picture is stored and not shown.`);
    }
    if (plan.lighting?.mode === 13) plan.lighting.option = pic.index;
    plan.picture = pic;
  }
  if (plan.lighting) {
    try { P.ledPacket({ mode: 1, speed: 2, brightness: 4, ...plan.lighting }); } catch (e) { err(effectAt, `lighting: ${e.message}`); }
  }
  if (advanced.size) {
    plan.advanced = [];
    for (const [slot, a] of advanced) {
      const base = remaps.get(`base::${slot}`);
      if (base && ['modtap', 'toggle', 'dks'].includes(a.kind) && !a.levels) {
        err(a.at, `${keyName(slot)}: ${a.kind === 'modtap' ? 'modTap' : a.kind} sets the key's base mapping itself; drop its remap (line ${base.at.line})`);
      }
      if (a.kind === 'snap') {
        const p = advanced.get(a.partner);
        if (p && !(p.kind === 'snap' && p.partner === slot)) { err(a.at, `${keyName(slot)} snaps with ${keyName(a.partner)}, which is set to something else`); continue; }
        if (p && slot > a.partner) continue;   // the pair once
      }
      const { at, ...rest } = a;
      plan.advanced.push(rest);
    }
  }
  if (bindings.size) plan.gamepad = { ...plan.gamepad, bindings: [...bindings].map(([slot, target]) => ({ key: keyName(slot), slot, target })) };
  if (ruleOps.length || replaceMaps || [...mapOpts.keys()].length) buildMaps();
  if (!known) notes.push('No keyboard connected: firmware features were not checked and nothing was compared with the keyboard.');
  errors.sort((a, b) => a.line - b.line || a.col - b.col);
  return { ok: errors.length === 0, plan, errors, logs, notes };

  // ---- parts ----

  // 'base' | 'fn' | 'fn1'..'fn4' | 'l1'..'l3' | 'layer1'..'layer3' | a mode name | { layer, os } -> { id, os? }
  function parseLayer(v, at) {
    let os;
    if (isObj(v)) {
      const bad = Object.keys(v).filter((k) => !['layer', 'os'].includes(k));
      if (bad.length) { err(at, `remap options are layer and os, not "${bad[0]}"`); return null; }
      os = v.os;
      v = v.layer;
    }
    const s = v === undefined ? 'base' : typeof v === 'number' ? `l${v}` : String(v).trim();
    const low = s.toLowerCase();
    let id = null;
    if (low === 'base') id = 'base';
    else if (low === 'fn' || low === 'fn1') id = 'fn';
    else if (/^fn[234]$/.test(low)) id = low;
    else if (/^(l|layer)[123]$/.test(low)) id = `l${low.slice(-1)}`;
    else if (modeByName(s)) id = `l${modeByName(s).id}`;
    if (!id) { err(at, `layer is base, fn, fn2, fn3, fn4, l1, l2, l3 or a mode name, not ${show(v)}`); return null; }
    if (os !== undefined) {
      if (id !== 'fn') { err(at, 'os only goes with the fn layer'); return null; }
      if (!(os in P.OS_LAYER)) { err(at, `os is ${Object.keys(P.OS_LAYER).join(', ')}`); return null; }
    }
    if (/^fn[234]$/.test(id) && !needFeature(at, 'fnLayers', `Fn layer ${id.slice(2)}`)) return null;
    if (/^l[123]$/.test(id) && !needOpen(at, `user layer ${id.slice(1)}`)) return null;
    return { id, ...(os && os !== 'win' && { os }) };
  }

  function keyValue(v, at, what) {
    if (typeof v !== 'string' || !v.trim()) { err(at, `${what} is a key value like "A", "LShift" or "Ctrl+C", not ${show(v)}`); return null; }
    try { const b = parseKey(v); P.checkValue(b); return b; } catch (e) { err(at, `${what}: ${e.message}`); return null; }
  }

  // advanced op -> (slot) => entry, or null
  function parseAdvanced(o, at) {
    switch (o.kind) {
      case 'plain': return () => ({ kind: 'plain' });
      case 'modtap': {
        const hold = keyValue(o.hold, at, 'modTap hold key'), tap = keyValue(o.tap, at, 'modTap tap key');
        const holdMs = o.holdMs ?? 200;
        if (!Number.isInteger(holdMs) || holdMs < 10 || holdMs > 2550) { err(at, `modTap hold time is 10..2550 ms, not ${show(holdMs)}`); return null; }
        if (!hold || !tap) return null;
        return () => ({ kind: 'modtap', hold: o.hold, tap: o.tap, holdMs });
      }
      case 'toggle': {
        if (o.repeat !== undefined && typeof o.repeat !== 'boolean') { err(at, 'toggle repeat is true or false'); return null; }
        if (o.key !== undefined && !keyValue(o.key, at, 'toggle key')) return null;
        return (slot) => ({ kind: 'toggle', key: o.key ?? keyName(slot), repeat: Boolean(o.repeat) });
      }
      case 'snap':
        if (!Number.isInteger(o.partner)) { err(at, 'snapTap takes the other key, like kb.key("A").snapTap("D")'); return null; }
        if (o.slots.includes(o.partner)) { err(at, 'snapTap needs two different keys'); return null; }
        if (o.slots.length !== 1) { err(at, 'snapTap pairs one key with one other key'); return null; }
        return () => ({ kind: 'snap', partner: o.partner, partnerKey: keyName(o.partner) });
      case 'dks': return parseDks(o.def, at);
      default: err(at, `unknown advanced key ${o.kind}`); return null;
    }
  }

  // dks({ keys, levels: [{ depthMm, actions: [{ down, up } x4] }], gapMm }) (multi-level, open firmware 'dksLevels')
  // or dks({ firstPointMm, secondPointMm, bindings: [{ key, cells: [A, B, C, D] }] }) (stock 2-point)
  function parseDks(d, at) {
    if (!isObj(d)) { err(at, 'dks takes { keys, levels, gapMm? } or { firstPointMm, secondPointMm, bindings }'); return null; }
    if (d.levels !== undefined) {
      const bad = Object.keys(d).filter((k) => !['keys', 'levels', 'gapMm'].includes(k));
      if (bad.length) { err(at, `dks levels take keys, levels and gapMm, not "${bad[0]}"`); return null; }
      if (!needFeature(at, 'dksLevels', 'Multi-level DKS')) return null;
      if (!Array.isArray(d.keys) || !d.keys.length || d.keys.length > 4) { err(at, 'dks keys: 1..4 keys like ["W", "LShift"] ("none" = unbound)'); return null; }
      if (!Array.isArray(d.levels) || !d.levels.length) { err(at, `dks levels: 1..${P.DKS_MAX_LEVELS} levels`); return null; }
      try {
        const keys = d.keys.map((k) => keyToMods(String(k)));
        if (!keys.some((k) => k.mods || k.usage)) throw new Error('bind at least one key');
        const levels = d.levels.map((l) => ({ depthMm: l?.depthMm, actions: Array.isArray(l?.actions) ? l.actions : [] }));
        P.dksWritePacket(0, { keys, levels, gapMm: d.gapMm ?? 0.1 });
        return () => ({ kind: 'dks', keys: d.keys.map(String), levels, gapMm: d.gapMm ?? 0.1 });
      } catch (e) { err(at, `dks: ${e.message}`); return null; }
    }
    const bad = Object.keys(d).filter((k) => !['firstPointMm', 'secondPointMm', 'bindings'].includes(k));
    if (bad.length) { err(at, `dks takes firstPointMm, secondPointMm and bindings (or keys / levels / gapMm), not "${bad[0]}"`); return null; }
    const first = d.firstPointMm, second = d.secondPointMm, max = SWITCH_LIMITS.actuation[1];
    if (!(typeof first === 'number' && typeof second === 'number' && first >= 0.1 && second <= max && first < second)) {
      err(at, `dks points: 0.1 <= firstPointMm < secondPointMm <= ${max} mm`);
      return null;
    }
    if (!Array.isArray(d.bindings) || !d.bindings.length || d.bindings.length > 4) { err(at, 'dks bindings: 1..4 of { key, cells: [A, B, C, D] }'); return null; }
    for (const b of d.bindings) {
      if (!keyValue(b?.key, at, 'dks binding key')) return null;
      try { P.dksActionByte(b.cells); } catch (e) { err(at, `dks binding ${b.key}: ${e.message} (0 nothing, 1 tap, 2 press, 3 hold)`); return null; }
    }
    return () => ({ kind: 'dks', firstPointMm: first, secondPointMm: second, bindings: d.bindings.map((b) => ({ key: b.key, cells: [...b.cells] })) });
  }

  function parseGamepad(s, at) {
    if (!isObj(s)) { err(at, 'gamepad settings are an object'); return null; }
    const out = {};
    const bool = ['enabled', 'keysStopTyping', 'square', 'snappy'];
    const mm = ['deadzoneMm', 'fullMm', 'buttonMm'];
    for (const [k, v] of Object.entries(s)) {
      if (bool.includes(k)) { if (typeof v !== 'boolean') err(at, `${k} is true or false`); else out[k] = v; } else if (mm.includes(k)) {
        if (typeof v !== 'number' || v < 0 || v > 4) err(at, `${k} is 0..4 mm, not ${show(v)}`); else out[k] = v;
      } else if (k === 'curve') {
        if (!P.GAMEPAD_CURVES.includes(v)) err(at, `curve is ${P.GAMEPAD_CURVES.join(', ')}`); else out.curve = v;
      } else if (k === 'mouseSpeed') {
        if (!Number.isInteger(v) || v < 20 || v > 5100) err(at, 'mouseSpeed is 20..5100 px/s'); else out.mouseSpeed = v;
      } else if (k === 'antiDeadzone') {
        if (typeof v !== 'number' || v < 0 || v > 100) err(at, 'antiDeadzone is 0..100 %'); else out.antiDeadzone = v;
      } else if (k === 'diagonalDeg') {
        if (!(v === 0 || (typeof v === 'number' && v >= 10 && v <= 80))) err(at, 'diagonalDeg is 0 (off) or 10..80'); else out.diagonalDeg = v;
      } else if (k === 'points') {
        if (!Array.isArray(v) || v.length !== 4 || !v.every((p) => Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === 'number' && x >= 0 && x <= 255))) {
          err(at, 'points are 4 x [x, y] within 0..255');
        } else out.points = v;
      } else err(at, `unknown gamepad setting "${k}" (enabled, keysStopTyping, curve, deadzoneMm, fullMm, buttonMm, mouseSpeed, antiDeadzone, square, snappy, diagonalDeg, points)`);
    }
    if (out.deadzoneMm !== undefined && out.fullMm !== undefined && !(out.deadzoneMm < out.fullMm)) err(at, 'deadzoneMm must be below fullMm');
    const plus = out.curve === 'custom' || out.antiDeadzone || out.square || out.snappy || out.diagonalDeg;
    if (plus && known && !has('gamepadPlus')) err(at, 'the custom curve, anti-deadzone, square output, snappy joystick and diagonal angle need a newer open firmware ("gamepadPlus")');
    return out;
  }

  function parseMacro(o, at) {
    try { P.checkMacroIndex(o.index); } catch (e) { err(at, e.message); return; }
    const d = o.def;
    if (!isObj(d)) { err(at, 'kb.macro(index, "text") or kb.macro(index, { text | steps, repeat?, delayMs? })'); return; }
    const bad = Object.keys(d).filter((k) => !['text', 'steps', 'repeat', 'delayMs'].includes(k));
    if (bad.length) { err(at, `macro takes text, steps, repeat and delayMs, not "${bad[0]}"`); return; }
    const repeat = d.repeat ?? 1;
    if (!Number.isInteger(repeat) || repeat < 1 || repeat > 100) { err(at, 'macro repeat is 1..100'); return; }
    const delay = d.delayMs ?? 15;
    if (!Number.isInteger(delay) || delay < 1 || delay > 1000) { err(at, 'macro delayMs is 1..1000'); return; }
    let steps;
    try {
      if ((d.text === undefined) === (d.steps === undefined)) throw new Error('give text or steps');
      if (d.text !== undefined) {
        if (typeof d.text !== 'string' || !d.text.length || d.text.length > 60) throw new Error('macro text is 1..60 characters');
        steps = textToSteps(d.text, delay);
      } else {
        if (!Array.isArray(d.steps) || !d.steps.length) throw new Error('steps is a list of { key, down, delayMs? }');
        steps = d.steps.map((s, i) => {
          if (!isObj(s) || typeof s.down !== 'boolean') throw new Error(`step ${i + 1} is { key, down: true | false, delayMs? }`);
          const v = parseKey(String(s.key));
          if (v[0] !== 0 || v[1] !== 0 || v[3] !== 0 || !v[2]) throw new Error(`step ${i + 1}: ${s.key} is not a plain key (one key per step; hold a modifier with its own step)`);
          const ms = s.delayMs ?? delay;
          if (!Number.isInteger(ms) || ms < 1 || ms > 65535) throw new Error(`step ${i + 1}: delayMs is 1..65535`);
          return { usage: v[2], down: s.down, delayMs: ms };
        });
      }
      P.encodeMacro(steps, repeat);
    } catch (e) { err(at, `macro ${o.index}: ${e.message}`); return; }
    plan.macros = [...(plan.macros ?? []).filter((m) => m.index !== o.index), { index: o.index, repeat, steps, ...(d.text !== undefined && { text: d.text }) }];
  }

  function parseOptions(v, at) {
    if (!isObj(v)) { err(at, 'kb.options({ antiMistouch?, rtStability?, wasdSwap? })'); return; }
    const out = { ...plan.options };
    for (const [k, x] of Object.entries(v)) {
      if (k === 'antiMistouch' || k === 'wasdSwap') { if (typeof x !== 'boolean') err(at, `${k} is true or false`); else out[k] = x; } else if (k === 'rtStability') {
        if (![0, 25, 50, 75, 100, 125].includes(x)) err(at, `rtStability is 0..125 in steps of 25, not ${show(x)}`); else out.rtStability = x;
      } else if (k === 'os') {
        if (x !== 'win') err(at, `the driver has no way to set the OS mode (every options write sends "win"); for a Mac Fn layer use remap(value, { layer: "fn", os: "mac" })`);
      } else err(at, `unknown option "${k}" (antiMistouch, rtStability, wasdSwap)`);
    }
    if (Object.keys(out).length) plan.options = out;
  }

  function parseFwOptions(v, at) {
    if (!isObj(v)) { err(at, 'kb.firmwareOptions({ ... }) takes an object'); return; }
    if (!needOpen(at, 'Firmware options')) return;
    const out = { ...plan.fwOptions };
    const gate = { textTyping: 'textTyping', compatMode: 'compatMode', releaseDebounceMs: 'releaseDebounce', dimMinutes: 'idleDim', dimPercent: 'idleDim' };
    const LISTS = { snapMode: P.SNAP_MODES, unicode: P.UNICODE_MODES, textTyping: P.TEXT_TYPING_MODES };
    const INTS = { idleMinutes: 255, releaseDebounceMs: P.RELEASE_DEBOUNCE_MAX, dimMinutes: 255, dimPercent: 100 };
    for (const [k, x] of Object.entries(v)) {
      if (['capsIndicator', 'statusGuide', 'layerIndicator', 'fnHold', 'perf', 'compatMode'].includes(k)) {
        if (typeof x !== 'boolean') { err(at, `${k} is true or false`); continue; }
      } else if (LISTS[k]) {
        if (!LISTS[k].includes(x)) { err(at, `${k} is ${LISTS[k].join(', ')}, not ${show(x)}`); continue; }
      } else if (INTS[k] !== undefined) {
        if (!Number.isInteger(x) || x < 0 || x > INTS[k]) { err(at, `${k} is 0..${INTS[k]}, not ${show(x)}`); continue; }
      } else if (k === 'capsColor') {
        try { out.capsColor = parseColor(x); } catch (e) { err(at, `capsColor: ${e.message}`); }
        continue;
      } else { err(at, `unknown firmware option "${k}" (capsIndicator, capsColor, snapMode, statusGuide, idleMinutes, layerIndicator, fnHold, unicode, perf, textTyping, compatMode, releaseDebounceMs, dimMinutes, dimPercent)`); continue; }
      if (gate[k] && known && !has(gate[k]) && x !== ({ textTyping: 'keep', compatMode: false })[k] && x !== 0) {
        err(at, `${k} needs a newer open firmware (feature "${gate[k]}")`);
        continue;
      }
      out[k] = x;
    }
    if (Object.keys(out).length) plan.fwOptions = out;
  }

  // rules -> key action maps (the driver's JSON form), checked rule by rule with key-actions.js
  function buildMaps() {
    const at1 = ruleOps[0]?.at ?? at0;
    if (known && !has('keyActions')) { err(at1, 'Key action maps need a newer open firmware (feature "keyActions")'); return; }
    const ka = plan.keyActions ??= { modes: [], maps: [] };
    if (replaceMaps) ka.replace = true;
    const slotOfName = (ref, where) => {
      if (Number.isInteger(ref)) { if (T.bySlot.has(ref)) return ref; throw KA.fail(where, `no key in slot ${ref}`); }
      const k = T.byName.get(String(ref).trim().toLowerCase());
      if (!k) throw KA.fail(where, `no key named ${ref}`);
      return k.slot;
    };
    const modeOf = (ref, where) => {
      if (Number.isInteger(ref)) return ref;
      const m = modeByName(ref);
      if (!m) throw KA.fail(where, `no mode named "${ref}" (declare it: kb.mode(${show(ref)}))`);
      return m.id;
    };
    const ctx = (self) => ({ slotOf: slotOfName, modeOf, self });
    const byKey = new Map();
    for (const { slot, rule, at } of ruleOps) {
      const r = normRule(rule, at);
      if (!r) continue;
      let wire;
      try { wire = KA.parseSpec({ slot, rules: [r] }, ctx(slot)); } catch (e) {
        const hint = typeof r.do?.key === 'string' && modeByName(r.do.key) ? ` (for the mode use kb.mode(${show(r.do.key)}).enter(), .leave() or .toggle())` : '';
        err(at, `${keyName(slot)}: ${e.message.replace(/^rules\[\d+\]\.?/, '').replace(/^: /, '')}${hint}`);
        continue;
      }
      if (known && KA.usesModes(wire) && (state.engine ?? 0) < 2) { err(at, 'conditions (if), modes and mouse keys need a newer open firmware (key action engine 2)'); continue; }
      if (known && M.usesNotHeld(wire) && (state.engine ?? 0) < 5) { err(at, 'conditions with notHeld need a newer open firmware (key action engine 5)'); continue; }
      if (known && M.speedByPressure(wire) && (state.engine ?? 0) < 4) { err(at, 'mouse keys with speedBy pressure or both need a newer open firmware (key action engine 4)'); continue; }
      if (known && M.sharesSpeed(wire) && (state.engine ?? 0) < 3) { err(at, 'mouse keys with shareSpeed need a newer open firmware (key action engine 3)'); continue; }
      if (!byKey.has(slot)) byKey.set(slot, { rules: [], ats: [], wire: [] });
      const e = byKey.get(slot);
      e.rules.push(r); e.ats.push(at); e.wire.push(...wire.rules);
    }
    for (const [slot, o] of mapOpts) if (!byKey.has(slot)) err(o.at, `${keyName(slot)}: actionMap options without any .when(...).do(...) rule`);
    const entries = state?.entries ?? 16;
    const conds = [];
    for (const [slot, e] of byKey) {
      const { at, ...opts } = mapOpts.get(slot) ?? {};
      const spec = { key: keyName(slot), ...opts, rules: e.rules };
      try { KA.parseSpec({ ...spec, key: undefined, slot }, ctx(slot)); } catch (x) {
        err(e.ats[e.ats.length - 1], `${keyName(slot)}: ${x.message.replace(/^: /, '')}`);
        continue;
      }
      for (const w of e.wire) if (w.need) { const c = M.condEntry(w.need); if (!conds.some((x) => M.sameEntry(x, c))) conds.push(c); }
      if (ka.maps.length === entries) err(e.ats[0], `the key action table holds ${entries} keys; this is key ${entries + 1} (${keyName(slot)})`);
      if (!spec.key) delete spec.key;
      ka.maps.push(Object.fromEntries(Object.entries(spec).filter(([, v]) => v !== undefined)));
    }
    if (conds.length > P.KA.CONDS) err(ruleOps[0].at, `these rules need ${conds.length} different conditions; the keyboard's condition table holds ${P.KA.CONDS}`);
  }

  // a recorded rule -> the driver's rule JSON (aliases, names made canonical), or null
  function normRule(rule, at) {
    if (!isObj(rule)) { err(at, 'bad rule'); return null; }
    const r = { ...rule };
    const ALIAS = { past: 'down', above: 'up', held: 'hold', pressed: 'press', released: 'release', tapped: 'tap' };
    if (typeof r.when === 'string' && ALIAS[r.when]) r.when = ALIAS[r.when];
    if (r.when === 'down' || r.when === 'up') { if (r.ms !== undefined) { r.at = r.ms; delete r.ms; } } else if (r.at !== undefined) { r.ms = r.at; delete r.at; }
    if (typeof r.mode === 'string' && !['press', 'release', 'tap', 'toggle', 'while'].includes(r.mode)) {
      err(at, `.mode() is how the output acts: press, release, tap, toggle or while (not ${show(r.mode)}; for "only in mode ${r.mode}" use .if({ mode: ${show(r.mode)} }))`);
      return null;
    }
    if (typeof r.do === 'string') {
      err(at, `.do() takes an action: kb.send(${show(r.do)}) for a key, or kb.mode(${show(r.do)}).enter() / .leave() / .toggle() for a mode`);
      return null;
    }
    if (badValue(r.do) || (isObj(r.do) && Object.values(r.do).some(badValue))) { err(at, `.do() takes an action object, not a ${r.do.$bad ?? 'function'}`); return null; }
    if (isObj(r.if)) {
      const c = { ...r.if };
      for (const f of ['held', 'notHeld']) {
        if (c[f] === undefined) continue;
        const list = Array.isArray(c[f]) ? c[f] : [c[f]];
        c[f] = list.map((k) => (Number.isInteger(k) ? T.bySlot.get(k)?.name ?? k : T.byName.get(String(k).trim().toLowerCase())?.name ?? k));
      }
      for (const f of ['mode', 'notMode']) {
        if (c[f] === undefined) continue;
        const fix = (m) => (typeof m === 'string' ? modeByName(m)?.name ?? m : m);
        c[f] = Array.isArray(c[f]) ? c[f].map(fix) : fix(c[f]);
      }
      r.if = c;
    }
    if (isObj(r.do) && typeof r.do.mode === 'string') r.do = { ...r.do, mode: modeByName(r.do.mode)?.name ?? r.do.mode };
    return Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined));
  }
}

// ---- diff -------------------------------------------------------------------------------------

// plan + what the keyboard has (cur, null = no keyboard) -> { changes: [{ section, text }], writes, problems }.
// cur: { profile, unitMm, switches: [per slot], keymaps: { base | fn | fn:mac | fn2 | l1 ...: [128 x 4 bytes] },
//   lighting, advanced: getAdvancedKeys(), options, pollingRateHz, fwOptions, gamepad, macros: { n: macro | null },
//   texts: { n: text }, keyActions: { maps: getKeyActions(), modes, entries } }. Sections the plan
//   names but cur lacks are written as planned (e.g. another profile is about to become active).
function diff(plan, cur, state = null) {
  const changes = [], writes = {}, problems = [];
  const T = keyTable(plan.model);
  const keyName = (slot) => T.bySlot.get(slot)?.name ?? `slot ${slot}`;
  const add = (section, text) => changes.push({ section, text });
  const c = cur ?? {};
  const was = (text) => (cur ? ` (was ${text})` : '');

  if (plan.profile !== undefined && plan.profile !== c.profile) {
    writes.profile = plan.profile;
    add('profile', `Active profile: ${plan.profile}${c.profile !== undefined ? ` (was ${c.profile})` : ''}`);
  }

  // switches: one bulk write per group of keys getting the same new values
  if (plan.switches) {
    const unit = c.unitMm ?? state?.unitMm ?? 0.001;
    const groups = new Map();
    for (const s of plan.switches) {
      const old = c.switches?.[s.slot];
      const settings = {};
      for (const f of SWITCH_FIELDS) {
        if (s[f] === undefined) continue;
        const same = old && (typeof s[f] === 'boolean' ? old[f] === s[f] : Math.round(old[f] / unit) === Math.round(s[f] / unit));
        if (!same) settings[f] = s[f];
      }
      if (!Object.keys(settings).length) continue;
      const k = JSON.stringify(settings);
      if (!groups.has(k)) groups.set(k, { slots: [], settings, olds: [] });
      groups.get(k).slots.push(s.slot);
      groups.get(k).olds.push(old);
    }
    writes.switches = [...groups.values()].map(({ slots, settings }) => ({ slots, settings }));
    for (const g of groups.values()) {
      const parts = Object.entries(g.settings).map(([f, v]) => {
        const olds = g.olds.map((o) => o?.[f]);
        const prev = cur && olds.every((x) => x !== undefined && x === olds[0]) ? olds[0] : undefined;
        const val = typeof v === 'boolean' ? ON(v) : fmtMm(v);
        const name = f === 'rapidTrigger' ? 'rapid trigger' : f === 'continuousRt' ? 'continuous rapid trigger' : LABEL[f];
        return `${name} ${val}${prev !== undefined ? ` (was ${typeof prev === 'boolean' ? ON(prev) : fmtMm(prev)})` : cur ? ' (was mixed)' : ''}`;
      });
      add('switches', `${listNames(g.slots.map(keyName))}: ${parts.join(', ')}`);
    }
  }

  // key values per layer
  if (plan.remap) {
    writes.remap = [];
    const LAYER = { base: 'base layer', fn: 'Fn layer', fn2: 'Fn layer 2', fn3: 'Fn layer 3', fn4: 'Fn layer 4', l1: 'layer 1', l2: 'layer 2', l3: 'layer 3' };
    for (const r of plan.remap) {
      const id = r.os ? `${r.layer}:${r.os}` : r.layer;
      const old = c.keymaps?.[id]?.[r.slot];
      if (old && old.join() === r.bytes.join()) continue;
      writes.remap.push(r);
      add('remap', `${r.key} on the ${LAYER[r.layer]}${r.os ? ` (${r.os})` : ''}: ${slotName(r.bytes) ?? 'nothing (falls through)'}${old ? was(slotName(old) ?? 'nothing') : ''}`);
    }
  }

  if (plan.macros) {
    writes.macros = [];
    for (const m of plan.macros) {
      const old = c.macros?.[m.index];
      const same = old && old.repeat === m.repeat && old.steps.length === m.steps.length
        && old.steps.every((s, i) => s.usage === m.steps[i].usage && s.down === m.steps[i].down && s.delayMs === m.steps[i].delayMs);
      if (same) continue;
      writes.macros.push(m);
      add('macros', `Macro ${m.index}: ${m.text !== undefined ? `types ${JSON.stringify(m.text)}` : `${m.steps.length} steps`}${m.repeat > 1 ? `, ${m.repeat} times` : ''}`
        + (cur && c.macros && old === null ? ' (this macro can\'t be read back, so it is always written)' : ''));
    }
  }

  if (plan.texts) {
    writes.texts = [];
    for (const t of plan.texts) {
      const old = c.texts?.[t.index];
      if (old === t.text) continue;
      writes.texts.push(t);
      add('texts', `Text ${t.index}: ${JSON.stringify(t.text)}${old !== undefined ? was(JSON.stringify(old)) : ''}`);
    }
  }

  if (plan.advanced) {
    writes.advanced = [];
    const curAdv = new Map((c.advanced ?? []).map((a) => [a.slot, a]));
    const keyEq = (a, b) => { try { return parseKey(String(a)).join() === parseKey(String(b)).join(); } catch { return false; } };
    for (const a of plan.advanced) {
      const old = curAdv.get(a.slot) ?? (c.advanced ? { kind: 'normal' } : null);
      const kind = old?.kind === 'toggleRepeat' ? 'toggle' : old?.kind;
      let same = false;
      if (old) {
        if (a.kind === 'plain') same = kind === 'normal';
        else if (a.kind === 'modtap') same = kind === 'modtap' && old.holdMs === a.holdMs && keyEq(old.keys[0], a.hold) && keyEq(old.keys[1], a.tap);
        else if (a.kind === 'toggle') same = kind === 'toggle' && (old.kind === 'toggleRepeat') === a.repeat && keyEq(old.keys[0], a.key);
        else if (a.kind === 'snap') same = kind === 'snap' && old.partner === a.partner && curAdv.get(a.partner)?.partner === a.slot;
        else if (a.levels) {
          const mods = (k) => { try { const m = keyToMods(k); return `${m.mods}:${m.usage}`; } catch { return k; } };
          const pad = (l) => [...l, 'none', 'none', 'none', 'none'].slice(0, 4).map(mods).join();
          same = kind === 'dks' && Array.isArray(old.levels) && pad(old.keys) === pad(a.keys) && Math.abs(old.gapMm - a.gapMm) < 0.005
            && JSON.stringify(old.levels.map((l) => [Math.round(l.depthMm * 100), l.actions.map((x) => [x.down, x.up])]))
              === JSON.stringify(a.levels.map((l) => [Math.round(l.depthMm * 100), [0, 1, 2, 3].map((i) => [l.actions[i]?.down ?? 'none', l.actions[i]?.up ?? 'none'])]));
        } else {
          same = kind === 'dks' && old.firstPointMm === a.firstPointMm && old.secondPointMm === a.secondPointMm
            && a.bindings.every((b, i) => keyEq(old.keys[i], b.key) && old.cells[i].join() === b.cells.join());
        }
      }
      if (same) continue;
      const clearFirst = Boolean(old && kind !== 'normal' && a.kind !== 'plain' && (kind !== a.kind || a.kind === 'snap' || a.kind === 'dks'));
      // snap tap makes the partner a snap key too: whatever it was goes first
      const partner = a.kind === 'snap' && c.advanced ? curAdv.get(a.partner) : null;
      const clearPartner = Boolean(partner && partner.kind !== 'normal');
      writes.advanced.push({ ...a, ...(clearFirst && { clearFirst }), ...(clearPartner && { clearPartner }) });
      add('advanced', `${keyName(a.slot)}: ${advText(a)}${old ? was(old.kind === 'normal' ? 'a plain key' : old.kind) : ''}`);
    }
  }

  if (plan.lighting || plan.picture) {
    const L = plan.lighting ?? {};
    const old = c.lighting;
    const out = {};
    for (const [k, v] of Object.entries(L)) {
      const o = old?.[k];
      const same = old && (['r', 'g', 'b'].includes(k) ? Math.min(v, 250) === o : v === o);
      if (!same) out[k] = v;
    }
    if (old && ('r' in out || 'g' in out || 'b' in out)) Object.assign(out, { r: L.r, g: L.g, b: L.b });
    if (Object.keys(out).length) {
      writes.lighting = out;
      const parts = [];
      if ('mode' in out) parts.push(`effect ${effectName(out.mode)}${old ? was(effectName(old.mode)) : ''}`);
      if ('r' in out) parts.push(`colour ${toHex([L.r, L.g, L.b])}${old ? was(old.rainbow ? 'rainbow' : toHex([old.r, old.g, old.b])) : ''}`);
      if (out.rainbow) parts.push('rainbow colours');
      if ('speed' in out) parts.push(`speed ${out.speed}${old ? was(old.speed) : ''}`);
      if ('brightness' in out) parts.push(`brightness ${out.brightness}${old ? was(old.brightness) : ''}`);
      if ('option' in out && out.mode !== 13) {
        const e = EFFECTS.find((x) => x.mode === (L.mode ?? old?.mode));
        parts.push(e?.options ? `direction ${e.options[out.option] ?? out.option}` : `option ${out.option}`);
      }
      if (parts.length) add('lighting', `Lighting: ${parts.join(', ')}`);
    }
    if (plan.picture) {
      const p = plan.picture;
      writes.picture = p;
      const byColour = new Map();
      for (const [slot, hex] of Object.entries(p.colors)) { if (!byColour.has(hex)) byColour.set(hex, []); byColour.get(hex).push(keyName(Number(slot))); }
      const what = [...byColour].map(([hex, names]) => `${listNames(names, 6)} ${hex}`).join('; ');
      const showIt = p.show && !(old && old.mode === 13 && old.option === p.index) && L.mode !== 13;
      if (showIt) writes.showPicture = { index: p.index };
      add('lighting', `Per-key colours (picture ${p.index}): ${what || 'none'}, every other key ${p.fill}${p.show ? (showIt ? '; shown as the lighting' : '; shown') : '; stored, not shown'}`
        + ' (a picture can\'t be read back from the keyboard, so it is always written)');
    }
  }

  const fields = (section, label, planned, old, fmt = (v) => JSON.stringify(v)) => {
    const out = {};
    for (const [k, v] of Object.entries(planned)) if (!old || JSON.stringify(old[k]) !== JSON.stringify(v)) out[k] = v;
    if (!Object.keys(out).length) return null;
    add(section, `${label}: ${Object.entries(out).map(([k, v]) => `${k} ${fmt(v, k)}${old ? was(fmt(old[k], k)) : ''}`).join(', ')}`);
    return out;
  };
  if (plan.options) { const o = fields('options', 'Options', plan.options, c.options); if (o) writes.options = o; }
  if (plan.pollingRateHz !== undefined && plan.pollingRateHz !== c.pollingRateHz) {
    writes.pollingRateHz = plan.pollingRateHz;
    add('options', `Polling rate: ${plan.pollingRateHz} Hz${c.pollingRateHz ? ` (was ${c.pollingRateHz})` : ''}`);
  }
  if (plan.fwOptions) {
    const o = fields('options', 'Firmware options', plan.fwOptions, c.fwOptions, (v, k) => (k === 'capsColor' && Array.isArray(v) ? toHex(v) : JSON.stringify(v)));
    if (o) writes.fwOptions = o;
  }
  if (plan.gamepad) {
    const g = {};
    if (plan.gamepad.settings) { const o = fields('gamepad', 'Gamepad', plan.gamepad.settings, c.gamepad); if (o) Object.assign(g, o); }
    if (plan.gamepad.bindings) {
      const now = new Map((c.gamepad?.bindings ?? []).map((b) => [b.slot, b.target]));
      const next = new Map(now);
      const changed = [];
      for (const b of plan.gamepad.bindings) {
        if ((now.get(b.slot) ?? null) === b.target) continue;
        changed.push(b);
        if (b.target === null) next.delete(b.slot); else next.set(b.slot, b.target);
      }
      if (changed.length) {
        g.bindings = [...next].map(([slot, target]) => ({ slot, target }));
        for (const b of changed) add('gamepad', `${b.key}: gamepad ${b.target ?? 'unbound'}${cur ? was(now.get(b.slot) ?? 'unbound') : ''}`);
      }
    }
    if (Object.keys(g).length) writes.gamepad = g;
  }

  if (plan.keyActions) keyActionDiff(plan.keyActions);

  if (plan.sequence) {
    writes.sequence = plan.sequence;
    add('sequence', `Plays a sequence after writing: ${plan.sequence.steps} steps, ${(plan.sequence.ms / 1000).toFixed(2)} s${plan.sequence.stopOnKey ? ', a key press stops it' : ''}`);
  }
  return { changes, writes, problems };

  function keyActionDiff(ka) {
    const curMaps = c.keyActions?.maps ?? null;
    const curModes = c.keyActions?.modes ?? state?.modes ?? null;
    const modes = ka.modes.filter((m) => !curModes || (curModes.find((x) => x.id === m.id)?.name ?? '') !== m.name);
    for (const m of modes) {
      const old = curModes?.find((x) => x.id === m.id)?.name;
      add('keyActions', `Mode ${m.id}: named "${m.name}"${curModes ? was(old ? `"${old}"` : 'unnamed') : ''}`);
    }
    const norm = (spec) => { try { const p = KA.preview({ ...spec, key: undefined, slot: 0 }); return JSON.stringify([p.press, p.gap, p.alsoType, p.rules]); } catch { return null; } };
    const curBySlot = new Map((curMaps ?? []).map((m) => [m.slot, m]));
    const maps = [];
    for (const m of ka.maps) {
      const slot = T.byName.get(m.key.toLowerCase()).slot;
      const old = curBySlot.get(slot);
      if (old && norm(old) === norm(m)) continue;
      maps.push({ ...m, slot });
      let summary;
      try { summary = KA.preview({ ...m, key: undefined, slot: 0 }).summary; } catch { summary = M.summary(m); }
      add('keyActions', `Key map ${m.key}: ${summary.join(' / ')}${cur && curMaps ? (old ? ' (replaces its map)' : ' (new)') : ''}`);
    }
    const planned = new Set(ka.maps.map((m) => T.byName.get(m.key.toLowerCase()).slot));
    const remove = ka.replace && curMaps ? curMaps.filter((m) => !planned.has(m.slot)).map((m) => m.slot) : [];
    for (const s of remove) add('keyActions', `Key map ${keyName(s)}: removed`);
    if (ka.replace && !curMaps) add('keyActions', 'Every other key action map on the keyboard: removed');
    if (curMaps) {
      const after = new Set([...curMaps.map((m) => m.slot).filter((s) => !remove.includes(s)), ...planned]);
      const entries = c.keyActions.entries ?? state?.entries ?? 16;
      if (after.size > entries) problems.push(`the key action table holds ${entries} keys; with the keyboard's other maps this would make ${after.size} (kb.resetKeyActions() removes the ones the script doesn't define)`);
    }
    if (!modes.length && !maps.length && !remove.length && !(ka.replace && !curMaps)) return;
    writes.keyActions = {
      ...(modes.length && { modes }),
      maps: maps.map(({ key, slot, ...spec }) => ({ slot, ...spec, rules: spec.rules.map((r) => slotRefs(r)) })),
      remove,
      ...(ka.replace && !curMaps && { replace: true }),
    };
  }
  // rule `if.held` names -> slots (the board's live keymap may name keys differently)
  function slotRefs(r) {
    if (!r.if?.held) return r;
    return { ...r, if: { ...r.if, held: r.if.held.map((k) => (typeof k === 'string' ? T.byName.get(k.toLowerCase())?.slot ?? k : k)) } };
  }
}

function advText(a) {
  switch (a.kind) {
    case 'plain': return 'plain key (no snap tap, mod-tap, toggle or DKS)';
    case 'modtap': return `mod-tap: tap ${a.tap}, hold ${a.hold} (after ${a.holdMs} ms)`;
    case 'toggle': return `toggle ${a.key}${a.repeat ? ' (repeating)' : ''}`;
    case 'snap': return `snap tap with ${a.partnerKey}`;
    default: return a.levels ? `DKS, ${a.levels.length} level${a.levels.length > 1 ? 's' : ''} on ${a.keys.filter((k) => k !== 'none').join(', ')}`
      : `DKS ${fmtMm(a.firstPointMm)} / ${fmtMm(a.secondPointMm)} on ${a.bindings.map((b) => b.key).join(', ')}`;
  }
}

module.exports = { compile, buildPlan, diff, metaFor, parseColor, keyTable, LAYOUTS, GROUPS, EFFECTS, NAMED_COLORS: NAMED, FILE };
