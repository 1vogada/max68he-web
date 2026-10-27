// Keymap slot values <-> readable names. A slot is 4 bytes: [kind, a, b, c].
// Encodings from the vendor app (configToMatrix): kind 0 key/combo
// [0, modifier, key, key2], 1 mouse, 3 media, 2 system, 9 macro, 10 special.

const USAGE = {};
'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').forEach((c, i) => { USAGE[0x04 + i] = c; });
'1234567890'.split('').forEach((c, i) => { USAGE[0x1e + i] = c; });
for (let i = 0; i < 12; i++) USAGE[0x3a + i] = `F${i + 1}`;
for (let i = 0; i < 12; i++) USAGE[0x68 + i] = `F${i + 13}`;
Object.assign(USAGE, {
  0x28: 'Enter', 0x29: 'Esc', 0x2a: 'Bksp', 0x2b: 'Tab', 0x2c: 'Space', 0x2d: '-', 0x2e: '=',
  0x2f: '[', 0x30: ']', 0x31: '\\', 0x33: ';', 0x34: "'", 0x35: '`', 0x36: ',', 0x37: '.',
  0x38: '/', 0x39: 'Caps', 0x46: 'PrtSc', 0x47: 'ScrLk', 0x48: 'Pause', 0x49: 'Ins',
  0x4a: 'Home', 0x4b: 'PgUp', 0x4c: 'Del', 0x4d: 'End', 0x4e: 'PgDn', 0x4f: 'Right',
  0x50: 'Left', 0x51: 'Down', 0x52: 'Up', 0x53: 'NumLock', 0x64: 'ISO\\', 0x65: 'Menu',
  0xe0: 'LCtrl', 0xe1: 'LShift', 0xe2: 'LAlt', 0xe3: 'LWin', 0xe4: 'RCtrl', 0xe5: 'RShift',
  0xe6: 'RAlt', 0xe7: 'RWin',
});
const BY_NAME = Object.fromEntries(Object.entries(USAGE).map(([u, n]) => [n.toLowerCase(), Number(u)]));
const MOD_ALIASES = { ctrl: 0xe0, shift: 0xe1, alt: 0xe2, win: 0xe3, gui: 0xe3, cmd: 0xe3 };

// Named functions, values from the vendor's function table.
const FUNCTIONS = {
  VolumeUp: [3, 0, 0xe9, 0], VolumeDown: [3, 0, 0xea, 0], Mute: [3, 0, 0xe2, 0],
  PlayPause: [3, 0, 0xcd, 0], NextTrack: [3, 0, 0xb5, 0], PrevTrack: [3, 0, 0xb6, 0],
  StopMedia: [3, 0, 0xb7, 0], MediaPlayer: [3, 0, 0x83, 1], Calculator: [3, 0, 0x92, 1],
  Mail: [3, 0, 0x8a, 1], MyComputer: [3, 0, 0x94, 1], Search: [3, 0, 0x21, 2],
  BrowserHome: [3, 0, 0x23, 2], BrowserBack: [3, 0, 0x24, 2], BrowserRefresh: [3, 0, 0x27, 2],
  ScreenBrightnessUp: [3, 0, 0x6f, 0], ScreenBrightnessDown: [3, 0, 0x70, 0],
  SystemPower: [2, 0, 0x81, 0], SystemSleep: [2, 0, 0x82, 0], SystemWake: [2, 0, 0x83, 0],
  LockScreen: [0, 0, 0xe3, 0x0f], ShowDesktop: [0, 0, 0xe3, 0x07],
  MouseLeft: [1, 0, 0xf0, 0], MouseRight: [1, 0, 0xf1, 0], MouseMiddle: [1, 0, 0xf2, 0],
  MouseBack: [1, 0, 0xf3, 0], MouseForward: [1, 0, 0xf4, 0],
  ProfileNext: [8, 0, 1, 0], ProfilePrev: [8, 0, 2, 0], ProfileCycle: [8, 0, 3, 0],
  LedBrightnessUp: [13, 2, 1, 0], LedBrightnessDown: [13, 2, 2, 0],
  Fn: [0x0a, 1, 0, 0], Disabled: [0, 0, 0, 0],
  // open firmware only (stock ignores these): on-board actions and layer keys
  FwProfileNext: [10, 0xe0, 0xf1, 0], FwLightingNext: [10, 0xe0, 0xf2, 0], FwRapidTriggerToggle: [10, 0xe0, 0xf3, 0],
  FwLightSlower: [10, 0xe0, 0xf4, 0], FwLightFaster: [10, 0xe0, 0xf5, 0],
  FwProfile1: [10, 0xe0, 0xf6, 0], FwProfile2: [10, 0xe0, 0xf7, 0], FwProfile3: [10, 0xe0, 0xf8, 0],
  MO1: [10, 0xe0, 0xf9, 0], MO2: [10, 0xe0, 0xfa, 0], MO3: [10, 0xe0, 0xfb, 0],
  TG1: [10, 0xe0, 0xfc, 0], TG2: [10, 0xe0, 0xfd, 0], TG3: [10, 0xe0, 0xfe, 0],
};
const FN_BY_NAME = Object.fromEntries(Object.keys(FUNCTIONS).map((k) => [k.toLowerCase(), k]));
const MACRO_MODES = { repeat: 0, toggle: 1, hold: 2 };

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

function slotName(entry) {
  const [kind, a, b, c] = entry;
  if (kind === 0 && a === 0 && b === 0 && c === 0) return null; // unused or dead
  if (kind === 0 && a === 0 && c === 0 && USAGE[b]) return USAGE[b];
  const fn = Object.keys(FUNCTIONS).find((k) => k !== 'Disabled' && same(FUNCTIONS[k], entry));
  if (fn) return fn;
  if (kind === 0 && b && USAGE[b] && (a === 0 || USAGE[a]) && (c === 0 || USAGE[c])) {
    return [a && USAGE[a], USAGE[b], c && USAGE[c]].filter(Boolean).join('+');
  }
  if (kind === 9) return `Macro${b}:${Object.keys(MACRO_MODES).find((m) => MACRO_MODES[m] === a) ?? a}`;
  if (kind === 11 && a === 0 && c === 0 && b < 64) return `Text${b}`;
  return `raw:${entry.map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

function usageOf(name) {
  const s = name.trim().toLowerCase();
  if (s in BY_NAME) return BY_NAME[s];
  if (s in MOD_ALIASES) return MOD_ALIASES[s];
  if (s.startsWith('usage:')) {
    const v = Number(s.slice(6));
    if (Number.isInteger(v) && v >= 0 && v <= 0xff) return v;
  }
  return undefined;
}

// 'A', 'Esc', 'Ctrl+C', 'Shift+[', 'VolumeUp', 'Macro2', 'Macro2:toggle',
// 'Disabled', 'raw:00002a00' -> 4-byte slot value
function parseKey(name) {
  const s = String(name).trim();
  const lower = s.toLowerCase();
  if (lower in FN_BY_NAME) return [...FUNCTIONS[FN_BY_NAME[lower]]];
  if (lower.startsWith('raw:') && /^[0-9a-f]{8}$/.test(lower.slice(4))) {
    return lower.slice(4).match(/../g).map((h) => parseInt(h, 16));
  }
  const text = /^text(\d+)$/.exec(lower);       // open firmware: types string N
  if (text) {
    const index = Number(text[1]);
    if (index > 63) throw new Error('text slot is 0..63');
    return [11, 0, index, 0];
  }
  const macro = /^macro(\d+)(?::(repeat|toggle|hold))?$/.exec(lower);
  if (macro) {
    const index = Number(macro[1]);
    if (index > 15) throw new Error('macro index is 0..15');
    return [9, MACRO_MODES[macro[2] || 'repeat'], index, 0];
  }
  const single = usageOf(s);
  if (single !== undefined) return [0, 0, single, 0];
  // Combo: a modifier then one or two keys (which may be modifiers too),
  // e.g. Ctrl+C or Ctrl+Shift+Esc. Vendor shape [0, mod, key, key2].
  const parts = s.split('+').filter(Boolean).map(usageOf);
  if (parts.length >= 2 && parts.length <= 3 && parts.every((p) => p !== undefined)) {
    const [mod, key, key2 = 0] = parts;
    if (mod >= 0xe0 && mod <= 0xe7) return [0, mod, key, key2];
  }
  throw new Error(`unknown key: ${name}`);
}

// On-board advanced-key outputs (multi-level DKS): modifier bits + one key.
// 'W', 'LShift', 'Ctrl+Shift+Esc', 'none' <-> { mods, usage }. Only keyboard keys
// and modifiers: media, mouse, macros and layer keys can't be sent from there.
function keyToMods(name) {
  const s = String(name ?? '').trim();
  if (!s || s.toLowerCase() === 'none') return { mods: 0, usage: 0 };
  let mods = 0, usage = 0;
  for (const part of s.split('+').filter(Boolean)) {
    const u = usageOf(part);
    if (u === undefined || u < 0x04) throw new Error(`not a keyboard key: ${part} (DKS sends keys and modifiers only)`);
    if (u >= 0xe0 && u <= 0xe7) mods |= 1 << (u - 0xe0);
    else if (usage) throw new Error(`${s}: one key plus modifiers at most`);
    else usage = u;
  }
  return { mods, usage };
}

function modsToName({ mods = 0, usage = 0 } = {}) {
  const parts = [];
  for (let b = 0; b < 8; b++) if (mods & (1 << b)) parts.push(USAGE[0xe0 + b]);
  if (usage) parts.push(USAGE[usage] ?? `usage:${usage}`);
  return parts.length ? parts.join('+') : 'none';
}

// US-layout characters typed with Shift, mapped to their unshifted key.
const SHIFTED = { '!': '1', '@': '2', '#': '3', $: '4', '%': '5', '^': '6', '&': '7', '*': '8',
  '(': '9', ')': '0', _: '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'",
  '<': ',', '>': '.', '?': '/', '~': '`' };

// Text -> macro steps that type it (US layout). Each key: down, up.
function textToSteps(text, delayMs = 15) {
  const steps = [];
  const tap = (usage) => steps.push({ usage, down: true, delayMs }, { usage, down: false, delayMs });
  for (const ch of String(text)) {
    let name = ch;
    let shift = false;
    if (ch === ' ') name = 'Space';
    else if (ch === '\n') name = 'Enter';
    else if (ch === '\t') name = 'Tab';
    else if (/[A-Z]/.test(ch)) shift = true;
    else if (ch in SHIFTED) { name = SHIFTED[ch]; shift = true; }
    const usage = BY_NAME[name.toLowerCase()];
    if (usage === undefined) throw new Error(`cannot type ${JSON.stringify(ch)} in a macro`);
    if (shift) steps.push({ usage: 0xe1, down: true, delayMs });
    tap(usage);
    if (shift) steps.push({ usage: 0xe1, down: false, delayMs });
  }
  return steps;
}

// Macro steps -> readable text like "A↓ A↑ (15ms)" for display.
function describeSteps(steps) {
  return steps.map((s) => `${USAGE[s.usage] ?? `0x${s.usage.toString(16)}`}${s.down ? '↓' : '↑'}${s.delayMs}`).join(' ');
}

module.exports = { USAGE, FUNCTIONS, MACRO_MODES, slotName, parseKey, keyToMods, modsToName, textToSteps, describeSteps };
