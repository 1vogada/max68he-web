// ROYUAN gen2 protocol constants and pure packet builders (no I/O).
// Reference: github.com/dniminenn/sharkfin docs/PROTOCOL.md
const { MAX_ACTUATION_MM } = require('./limits');

const REPORT_LEN = 64;

const OP = {
  IDENTIFY: 0x8f,
  GET_REPORT_RATE: 0x83,
  SET_PROFILE: 0x04,
  GET_PROFILE: 0x84,
  SET_LED: 0x07,
  GET_LED: 0x87,
  GET_DEBOUNCE: 0x86,
  GET_SLEEP: 0x91,
  SET_OPTIONS: 0x09,
  GET_OPTIONS: 0x89,
  GET_AUTO_OS: 0x97,
  SET_REPORT_RATE: 0x03,
  SET_KEYMAP: 0x0a,
  GET_KEYMAP: 0x8a,
  SET_MACRO: 0x0b,
  GET_MACRO: 0x8b,
  SET_USERPIC: 0x0c,
  SET_FN: 0x10,
  GET_FN: 0x90,
  SET_HALL: 0x65,
  TRAVEL_STREAM: 0x1b, // RAM flag only, not saved
  SET_AUDIO_VIZ: 0x0d, // streamed, not saved (mode 20/22)
  SET_SCREEN_COLOR: 0x0e, // streamed, not saved (mode 21)
  GET_HALL: 0xe5,
};

// Refused by packet(): flash erase (0xAC, 0x2C), bootloader (0x7F, 0x30),
// factory reset (0x01), sensor calibration (0x1C, 0x1E: can save zeroed tables),
// ISP prepare (0xC5, arms the bootloader entry; see dot-agi/ry5088-flasher).
const FORBIDDEN = new Set([0xac, 0x2c, 0x7f, 0x30, 0x01, 0x1c, 0x1e, 0xc5]);

// Magnetic-switch columns (sub-ops of 0x65/0xE5).
const HALL = {
  ACTUATION: 0,
  RELEASE: 1,
  RT_PRESS: 2,
  RT_RELEASE: 3,
  DKS_START: 4,
  MODTAP_TIME: 5,
  DEAD_BOTTOM: 6,
  MODE: 7,
  DKS_ACTIONS: 8, // 4 bytes, single slot only
  SNAP_PARTNER: 9,
  DKS_ALL: 10, // read only, 4 bytes per key over 8 pages
};
const WIDE = new Set([0, 1, 2, 3, 4, 6]); // u16 columns; the rest are u8
const MODE_RAPID_TRIGGER = 0x80;
// Open firmware only: bit 6 = continuous rapid trigger (stays armed until the key
// is fully up). Stock leaves it 0. Advanced-key kinds live in bits 0..5.
const MODE_RT_CONTINUOUS = 0x40;
const KIND_MASK = 0x3f;
const SLOTS = 128;

// Firmware clamps; values below these are rewritten by the board anyway.
const MIN_TRAVEL_MM = 0.1;
const MIN_RT_MM = 0.01;
const MAX_DEAD_MM = 3.4;
const MAX_TRAVEL_MM = 4.0;

// One travel count in mm, by firmware revision (e.g. 0x504).
function unitMm(revision) {
  if (revision >= 0x500) return 0.005;
  if (revision < 0x300) return 0.1;
  return 0.01;
}

function checksum(buf, end) {
  let sum = 0;
  for (let i = 0; i < end; i++) sum += buf[i];
  return 0xff - (sum & 0xff);
}

// mode: 'bit7' checksum at byte 7, 'bit8' at byte 8, 'none'.
function packet(opcode, payload = [], mode = 'bit7') {
  const chunk = chunkIndex(opcode, payload);
  if (chunk > MAX_CHUNK) throw new Error(`chunk index ${chunk} exceeds ${MAX_CHUNK}`);
  if (FORBIDDEN.has(opcode)) throw new Error(`opcode 0x${opcode.toString(16)} is refused`);
  if (payload.length > 6 && mode === 'bit7') throw new Error('bit7 payload is at most 6 bytes');
  const buf = new Array(REPORT_LEN).fill(0);
  buf[0] = opcode;
  payload.forEach((b, i) => { buf[1 + i] = b & 0xff; });
  if (mode === 'bit7') buf[7] = checksum(buf, 7);
  else if (mode === 'bit8') buf[8] = checksum(buf, 8);
  return buf;
}

function mmToWire(subop, mm, unit) {
  if (!Number.isFinite(mm)) throw new Error(`not a number: ${mm}`);
  const clamp = (lo, hi) => Math.min(Math.max(mm, lo), hi);
  let v = mm;
  if (subop === HALL.ACTUATION || subop === HALL.RELEASE) v = clamp(MIN_TRAVEL_MM, MAX_ACTUATION_MM);
  else if (subop === HALL.DKS_START) v = clamp(MIN_TRAVEL_MM, MAX_TRAVEL_MM);
  else if (subop === HALL.RT_PRESS || subop === HALL.RT_RELEASE) v = clamp(MIN_RT_MM, MAX_TRAVEL_MM);
  else if (subop === HALL.DEAD_BOTTOM) v = clamp(0, MAX_DEAD_MM);
  return Math.min(Math.max(Math.round(v / unit), 0), 0xffff);
}

const wireToMm = (wire, unit) => Math.round(wire * unit * 1000) / 1000;

// The firmware bounds-checks none of these IDs; out-of-range values write
// past its buffers (monsgeek-akko-linux docs/bugs/oob_hazards.txt). A macro
// id >= 16 overflows the stack in the flash-save path.
const MACRO_MAX = 15;
const MAX_CHUNK = 9;
const checkProfile = (profile) => { if (![0, 1, 2, 3].includes(profile)) throw new Error(`profile must be 0..3, got ${profile}`); };
const checkLayer = (layer) => { if (![0, 1, 2, 3].includes(layer)) throw new Error(`layer must be 0..3, got ${layer}`); };

// Page index of a chunked write, or -1 for single-slot and other packets.
function chunkIndex(opcode, p) {
  if (opcode === 0x0b) return p[1] ?? 0;                      // macro [id, page]
  if (opcode === 0x0c) return p[2] ?? 0;                      // picture [pic, FF, page]
  if (opcode === 0x0a && p[1] === 0xff) return p[2] ?? 0;     // keymap bulk
  if (opcode === 0x10 && p[2] === 0xff) return p[3] ?? 0;     // Fn bulk
  if (opcode === 0x65 && p[1] === 1) return p[2] ?? 0;        // hall bulk
  return -1;
}

function checkSlot(slot) {
  if (!Number.isInteger(slot) || slot < 0 || slot >= SLOTS) throw new Error(`slot out of range: ${slot}`);
}

// One slot of one hall column. `last` commits to flash.
function hallSetOne(subop, slot, value, last) {
  checkSlot(slot);
  const buf = packet(OP.SET_HALL, [subop, 0, slot, last ? 1 : 0]);
  buf[8] = value & 0xff;
  if (WIDE.has(subop)) buf[9] = (value >> 8) & 0xff;
  return buf;
}

// A whole column in bulk pages: 28 u16 or 56 u8 per page, `last` on the final page.
function hallSetAll(subop, values, last) {
  if (values.length !== SLOTS) throw new Error(`need ${SLOTS} values`);
  const bytes = [];
  for (const v of values) {
    bytes.push(v & 0xff);
    if (WIDE.has(subop)) bytes.push((v >> 8) & 0xff);
  }
  const pages = [];
  for (let off = 0, page = 0; off < bytes.length; off += 56, page++) {
    const final = off + 56 >= bytes.length;
    const buf = packet(OP.SET_HALL, [subop, 1, page, last && final ? 1 : 0]);
    bytes.slice(off, off + 56).forEach((b, i) => { buf[8 + i] = b; });
    pages.push(buf);
  }
  return pages;
}

// Lighting packet (Bit8). flags: 0..6 preset colour (red, orange, yellow,
// green, cyan, blue, magenta), 7 the packet's RGB, 8 rainbow on this board.
function ledPacket({ mode, speed, brightness, option = 0, rainbow = false, presetColour = null,
  r = 0, g = 0, b = 0 }) {
  const clamp = (v, lo, hi, name) => {
    if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`${name} must be ${lo}..${hi}`);
    return v;
  };
  if (!OPEN_LIGHT_MODES[mode]) clamp(mode, 1, 22, 'mode');
  if (mode === 13 && !(Number.isInteger(option) && option >= 0 && option <= 4)) throw new Error('mode 13 shows picture 0..4 (option)');
  // 20/22 music bars and 21 screen colour are fed live by the host.
  const wireSpeed = 4 - clamp(speed, 0, 4, 'speed'); // host 4 = fastest = wire 0
  let flags = rainbow ? 8 : 7;
  if (presetColour !== null && presetColour !== undefined) flags = clamp(presetColour, 0, 6, 'presetColour');
  if (mode === 20 || mode === 22) flags = rainbow ? 0 : 4; // music modes invert the nibble
  if (mode === 21) { flags = 0; option = 0; } // vendor sends 0 for screen colour
  const buf = packet(OP.SET_LED, [mode, wireSpeed, clamp(brightness, 0, 4, 'brightness'),
    (clamp(option, 0, 15, 'option') << 4) | flags,
    Math.min(clamp(r, 0, 255, 'r'), 0xfa), Math.min(clamp(g, 0, 255, 'g'), 0xfa),
    Math.min(clamp(b, 0, 255, 'b'), 0xfa)], 'bit8');
  return buf;
}

function parseLed(reply) {
  const flags = reply[4] & 0x0f;
  return {
    mode: reply[1],
    speed: 4 - reply[2],
    brightness: reply[3],
    option: reply[4] >> 4,
    rainbow: flags === 8,
    presetColour: flags <= 6 ? flags : null,
    r: reply[5], g: reply[6], b: reply[7],
  };
}

// Live colour for mode 21 (screen colour). One colour for the whole board.
// Streamed by the vendor at 25-50 Hz; does not touch flash.
function screenColorPacket(r, g, b) {
  return packet(OP.SET_SCREEN_COLOR, [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v)))));
}

// Live bars for modes 20/22 over USB: 16 band levels 0..6 at bytes 8..23.
// The board sums adjacent pairs into 8 columns. Colour is a fixed rainbow.
function audioVizPacket(bands) {
  if (!Array.isArray(bands) || bands.length !== 16) throw new Error('need 16 bands');
  const buf = packet(OP.SET_AUDIO_VIZ);
  bands.forEach((v, i) => { buf[8 + i] = Math.max(0, Math.min(6, Math.round(v))); });
  return buf;
}

// ---- keymap, Fn layer, polling rate, per-key colour, macros --------------
// Shapes from the vendor app's gen2 class (5e635fe2.js).

const REPORT_RATES = [8000, 4000, 2000, 1000, 500, 250, 125]; // index = wire code
const OS_LAYER = { win: 0, mac: 1, android: 2, ios: 3 };

function checkValue(value) {
  if (!Array.isArray(value) || value.length !== 4 || value.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) {
    throw new Error('key value must be 4 bytes');
  }
  // macro [9, mode, index, 0] and text [11, 0, index, 0]: the firmware does not bounds-check the index
  if (value[0] === 9 && value[2] > MACRO_MAX) throw new Error(`macro index is 0..${MACRO_MAX}`);
  if (value[0] === 11 && value[2] >= TEXT_COUNT) throw new Error(`text slot is 0..${TEXT_COUNT - 1}`);
}

// One base-layer slot. byte 5 saves to flash, byte 6 is the layer.
function keymapSetOne(profile, slot, value, layer = 0) {
  checkProfile(profile);
  checkLayer(layer);
  checkSlot(slot);
  checkValue(value);
  const buf = packet(OP.SET_KEYMAP, [profile, slot, 0, 0, 1, layer]);
  value.forEach((b, i) => { buf[8 + i] = b; });
  return buf;
}

// One Fn-layer slot for one host OS layer.
function fnSetOne(profile, slot, value, os = 'win') {
  checkProfile(profile);
  checkSlot(slot);
  checkValue(value);
  if (!(os in OS_LAYER)) throw new Error('os is win, mac, android or ios');
  const buf = packet(OP.SET_FN, [OS_LAYER[os], profile, slot]);
  value.forEach((b, i) => { buf[8 + i] = b; });
  return buf;
}

function fnGetPage(profile, page, os = 'win') {
  checkProfile(profile);
  if (!(os in OS_LAYER)) throw new Error('os is win, mac, android or ios');
  return packet(OP.GET_FN, [OS_LAYER[os], profile, 0xff, page]);
}

function reportRatePacket(hz) {
  const code = REPORT_RATES.indexOf(hz);
  if (code < 0) throw new Error(`polling rate must be one of ${REPORT_RATES.join(', ')}`);
  return packet(OP.SET_REPORT_RATE, [0, code]);
}

// Per-key colour picture: 126 slots x RGB = 378 bytes in 7 pages, pic 0..4.
// Shown by light mode 13 with option = pic. GET does not reflect writes.
function userPicPages(pic, rgbBySlot) {
  if (!Number.isInteger(pic) || pic < 0 || pic > 4) throw new Error('picture slot is 0..4');
  const bytes = new Array(378).fill(0);
  rgbBySlot.forEach((rgb, slot) => {
    if (!rgb || slot >= 126) return;
    rgb.forEach((v, c) => { bytes[slot * 3 + c] = Math.max(0, Math.min(255, Math.round(v))); });
  });
  return Array.from({ length: 7 }, (_, page) => {
    const len = page === 6 ? 378 - 56 * 6 : 56;
    const buf = packet(OP.SET_USERPIC, [pic, 0xff, page, len, page === 6 ? 1 : 0]);
    bytes.slice(page * 56, page * 56 + len).forEach((b, i) => { buf[8 + i] = b; });
    return buf;
  });
}

// Macro body: repeat count u16, then per step [usage, down<<7 | delay] when
// delay is 1..127 ms, else [usage, down<<7, delay lo, delay hi]. 256 bytes max.
// steps: [{ usage, down, delayMs }]
function encodeMacro(steps, repeat = 1) {
  if (!Number.isInteger(repeat) || repeat < 0 || repeat > 0xffff) throw new Error('repeat is 0..65535');
  const out = [repeat & 0xff, repeat >> 8];
  for (const { usage, down, delayMs } of steps) {
    if (!Number.isInteger(usage) || usage < 1 || usage > 0xff) throw new Error(`bad usage ${usage}`);
    const d = Math.max(1, Math.min(0xffff, Math.round(delayMs ?? 10)));
    if (d <= 127) out.push(usage, (down ? 0x80 : 0) | d);
    else out.push(usage, down ? 0x80 : 0, d & 0xff, d >> 8);
  }
  if (out.length > 256) throw new Error('macro too long (256 bytes max)');
  return out;
}

function decodeMacro(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xff) return { repeat: 0, steps: [] }; // erased flash
  const repeat = bytes[0] | (bytes[1] << 8);
  const steps = [];
  for (let i = 2; i + 1 < bytes.length && bytes[i] && bytes[i] !== 0xff; ) {
    const usage = bytes[i];
    const down = (bytes[i + 1] & 0x80) !== 0;
    let delayMs = bytes[i + 1] & 0x7f;
    i += 2;
    if (delayMs === 0) { delayMs = bytes[i] | (bytes[i + 1] << 8); i += 2; }
    steps.push({ usage, down, delayMs });
  }
  return { repeat, steps };
}

function checkMacroIndex(index) {
  if (!Number.isInteger(index) || index < 0 || index > MACRO_MAX) throw new Error(`macro index is 0..${MACRO_MAX}`);
}

function macroPages(index, body) {
  checkMacroIndex(index);
  const n = Math.max(1, Math.ceil(body.length / 56));
  return Array.from({ length: n }, (_, page) => {
    const buf = packet(OP.SET_MACRO, [index, page, 56, page === n - 1 ? 1 : 0]);
    body.slice(page * 56, page * 56 + 56).forEach((b, i) => { buf[8 + i] = b; });
    return buf;
  });
}

// ---- advanced keys --------------------------------------------------------
// Kind in bits 0..6 of the mode column; bit 7 is rapid trigger. The extra keys
// live in keymap sub-layers: DKS 0..3, mod-tap 0 hold / 1 tap, toggle 0.
const KIND = { normal: 0, dks: 2, modtap: 3, toggle: 4, toggleRepeat: 5, snap: 7 };
const NO_PARTNER = 0xff;

// DKS action bytes, one per sub-layer: four 2-bit cells for the events
// A press past point 1, B press past point 2, C release past 2, D release past 1.
// Cell values: 0 nothing, 1 tap, 2 press (release at next event), 3 hold.
function dksActionByte(cells) {
  if (!Array.isArray(cells) || cells.length !== 4 || cells.some((c) => ![0, 1, 2, 3].includes(c))) {
    throw new Error('DKS cells are four values 0..3');
  }
  return cells[0] | (cells[1] << 2) | (cells[2] << 4) | (cells[3] << 6);
}
const dksCells = (byte) => [byte & 3, (byte >> 2) & 3, (byte >> 4) & 3, (byte >> 6) & 3];

function dksActionsPacket(slot, bytes, last) {
  checkSlot(slot);
  if (bytes.length !== 4) throw new Error('need 4 action bytes');
  const buf = packet(OP.SET_HALL, [HALL.DKS_ACTIONS, 0, slot, last ? 1 : 0]);
  bytes.forEach((b, i) => { buf[8 + i] = b & 0xff; });
  return buf;
}

// ---- keyboard options (gen2 0x09 / 0x89, vendor setKBOption) ---------------
// fnIndex is kept as read; rtStability is 0..125 in steps of 25.
function parseOptions(r) {
  return {
    os: ['win', 'mac', 'ios', 'android'][r[1]] ?? 'win',
    fnIndex: r[2],
    antiMistouch: r[3] === 1,
    rtStability: (r[4] > 5 ? 0 : r[4]) * 25,
    wasdSwap: r[5] === 1,
  };
}

function optionsPacket({ fnIndex, antiMistouch, rtStability, wasdSwap }) {
  if (![0, 25, 50, 75, 100, 125].includes(rtStability)) throw new Error('rtStability is 0..125 in steps of 25');
  if (!Number.isInteger(fnIndex) || fnIndex < 0 || fnIndex > 255) throw new Error('bad fnIndex');
  return packet(OP.SET_OPTIONS, [0, fnIndex, antiMistouch ? 1 : 0, rtStability / 25, wasdSwap ? 1 : 0]);
}

// ---- open (fun60-derived) firmware only --------------------------------------
// Never send these to stock firmware: Keyboard checks info.custom first.
const CUSTOM_MODE = { live: 0x41, droplet: 0x42 };

// Effects only the open firmware renders (fx.c, droplet.c). Same SET_LEDPARAM
// packet; Keyboard.setLighting refuses them on stock firmware.
const OPEN_LIGHT_MODES = {
  0x40: 'Random rainbow', 0x42: 'Droplet', 0x43: 'Reactive', 0x44: 'Ripple (firmware)', 0x45: 'Heatmap',
  0x46: 'Key depth', 0x47: 'Starlight', 0x48: 'Rain', 0x49: 'Fire', 0x4a: 'Aurora', 0x4b: 'Splash',
  // pressure effects (pfx.c), host API 3+
  0x4c: 'Trampoline', 0x4d: 'Liquid dye', 0x4e: 'Frost', 0x4f: 'Lava lamp', 0x50: 'Charge shot',
  0x51: 'Impact', 0x52: 'Sparks', 0x53: 'Lightning', 0x54: 'Gravity', 0x55: 'Squeeze',
  0x56: 'Actuation trainer', 0x57: 'WASD gauge', 0x58: 'Spotlight', 0x59: 'Pressure paint',
};
// which open modes a board offers: base ones always (Droplet unless a custom build left it out),
// fx.c with 'fxEffects', pfx.c with host API 3+ (and 'pressureFx' once CAPS has its third word)
function openModesFor(caps) {
  const feats = caps?.features ?? [];
  return Object.fromEntries(Object.entries(OPEN_LIGHT_MODES).filter(([k]) => {
    const m = Number(k);
    if (m === CUSTOM_MODE.droplet && caps) return feats.includes('droplet');
    if (BASE_OPEN_LIGHT_MODES.includes(m)) return true;
    if (m >= 0x4c) return (caps?.api ?? 0) >= 3 && (!caps.caps3 || feats.includes('pressureFx'));
    return feats.includes('fxEffects');
  }));
}
// the effects every open firmware has; the rest need the 'fxEffects' capability
const BASE_OPEN_LIGHT_MODES = [0x40, 0x42];   // (used by openModesFor below)

// ---- multi-level DKS (0xFE 9 read / 10 write, open firmware 'dksLevels') ----
// Per key: up to 4 bound keys { mods, usage } and 1..8 levels, each a depth and,
// per bound key, an action for passing it going down and for coming back up.
const DKS_ACTIONS = ['none', 'tap', 'press', 'hold', 'release'];
const DKS_MAX_LEVELS = 8;
const DKS_MIN_MM = 0.05;
const DKS_MAX_MM = 5;
const DKS_TABLE_FULL = 0xfe;
const dksReadPacket = (slot) => hostPacket(0xfe, [9, slot]);

function dksWritePacket(slot, { keys = [], levels = [], gapMm = 0.1 }) {
  if (!Number.isInteger(slot) || slot < 0 || slot >= SLOTS) throw new Error('slot out of range');
  if (levels.length > DKS_MAX_LEVELS) throw new Error(`at most ${DKS_MAX_LEVELS} levels`);
  if (keys.length > 4) throw new Error('at most 4 bound keys');
  const gap = Math.round(gapMm * 100);
  if (!(gap >= 0 && gap <= 100)) throw new Error('release gap is 0..1 mm');
  const data = new Array(56).fill(0);
  keys.forEach((k, i) => { data[i * 2] = k.mods & 0xff; data[i * 2 + 1] = k.usage & 0xff; });
  let prev = 0;
  levels.forEach((l, i) => {
    const cmm = Math.round(l.depthMm * 100);
    if (!(l.depthMm >= DKS_MIN_MM && l.depthMm <= DKS_MAX_MM)) throw new Error(`level ${i + 1}: depth is ${DKS_MIN_MM}..${DKS_MAX_MM} mm`);
    if (cmm <= prev) throw new Error(`level ${i + 1} must be deeper than level ${i}`);
    prev = cmm;
    const o = 8 + i * 6;
    data[o] = cmm & 0xff; data[o + 1] = cmm >> 8;
    for (let b = 0; b < 4; b++) {
      const a = l.actions?.[b] ?? {};
      const dn = DKS_ACTIONS.indexOf(a.down ?? 'none'), up = DKS_ACTIONS.indexOf(a.up ?? 'none');
      if (dn < 0 || up < 0) throw new Error(`level ${i + 1}: action is ${DKS_ACTIONS.join(', ')}`);
      data[o + 2 + b] = dn | (up << 4);
    }
  });
  return hostPacket(0xfe, [10, slot, levels.length, gap], data);
}

function parseDks(r) {
  if (r[3] === DKS_TABLE_FULL) throw new Error('the keyboard has no room for another DKS key');
  if (r[3] === 0xff) throw new Error('slot out of range');
  const n = Math.min(r[3], DKS_MAX_LEVELS);
  const keys = [0, 1, 2, 3].map((i) => ({ mods: r[8 + i * 2], usage: r[9 + i * 2] }));
  const levels = Array.from({ length: n }, (_, i) => {
    const o = 16 + i * 6;
    return {
      depthMm: (r[o] | (r[o + 1] << 8)) / 100,
      actions: [0, 1, 2, 3].map((b) => ({ down: DKS_ACTIONS[r[o + 2 + b] & 15] ?? 'none', up: DKS_ACTIONS[r[o + 2 + b] >> 4] ?? 'none' })),
    };
  });
  return { isDks: r[6] === 1, maxLevels: r[5], gapMm: r[4] / 100, keys, levels };
}

// ---- open-firmware options + user layers (0xFE) -----------------------------
const SNAP_MODES = ['last', 'neutral', 'first', 'deeper'];   // deeper = Rappy Snappy (needs the scan-timing firmware)
// text keys: how non-US characters are typed (Windows needs EnableHexNumpad); other keys while one types (byte 11)
const UNICODE_MODES = ['windows', 'linux', 'mac'], TEXT_TYPING_MODES = ['keep', 'block', 'stop'];

// bytes 12..15 (CAPS2 bits 9..11, reserved = 0 before): compatibility mode (6KRO), release debounce ms,
// dim after N idle minutes, dim level % (0 = the firmware's 30 %)
const RELEASE_DEBOUNCE_MAX = 10, DIM_DEFAULT_PERCENT = 30;

function parseFwOptions(r) {
  const o = r.slice(8, 24);
  return { capsIndicator: o[0] === 1, capsColor: [o[1], o[2], o[3]], snapMode: SNAP_MODES[o[4]] ?? 'last',
    statusGuide: o[5] === 1, idleMinutes: o[6], layerIndicator: o[7] === 1, fnHold: o[8] === 1,
    unicode: UNICODE_MODES[o[9]] ?? 'windows', perf: o[10] === 1, textTyping: TEXT_TYPING_MODES[o[11]] ?? 'keep',
    compatMode: o[12] === 1, releaseDebounceMs: Math.min(o[13] ?? 0, RELEASE_DEBOUNCE_MAX), dimMinutes: o[14] ?? 0,
    dimPercent: Math.min(o[15] || DIM_DEFAULT_PERCENT, 100) };
}

function fwOptionsPacket(o) {
  const snap = SNAP_MODES.indexOf(o.snapMode), typing = TEXT_TYPING_MODES.indexOf(o.textTyping ?? 'keep');
  for (const [v, k, l] of [[snap, 'snapMode', SNAP_MODES], [typing, 'textTyping', TEXT_TYPING_MODES]]) if (v < 0) throw new Error(`${k} is ${l.join(', ')}`);
  const int = (k, max, def = 0) => {
    const v = o[k] ?? def;
    if (!Number.isInteger(v) || v < 0 || v > max) throw new Error(`${k} is 0..${max}`);
    return v;
  };
  const idle = int('idleMinutes', 255, NaN), release = int('releaseDebounceMs', RELEASE_DEBOUNCE_MAX), dim = int('dimMinutes', 255);
  const dimPct = int('dimPercent', 100, DIM_DEFAULT_PERCENT);
  const c = (o.capsColor ?? [255, 255, 255]).map((v) => Math.max(0, Math.min(255, v | 0)));
  return hostPacket(0xfe, [1], [o.capsIndicator ? 1 : 0, ...c, snap, o.statusGuide ? 1 : 0, idle, o.layerIndicator ? 1 : 0,
    o.fnHold ? 1 : 0, Math.max(0, UNICODE_MODES.indexOf(o.unicode ?? 'windows')), o.perf ? 1 : 0, typing,
    o.compatMode ? 1 : 0, release, dim, dim ? dimPct : 0]);
}

// full factory reset through 0xFE 17 (CAPS2 'resetFe'): the open firmware's 0x01 reset, which packet() / hid.js refuse
const fwFactoryResetPacket = () => hostPacket(0xfe, [17, 0x52, 0x53, 0x54]);   // 'RST'

const fwOptionsGetPacket = () => hostPacket(0xfe, [0]);
const pressCountPacket = (start) => hostPacket(0xfe, [4, start]);
const pressResetPacket = () => hostPacket(0xfe, [5]);
// Scan timing (0xFE 6 read / 7 tune). ADC divider: clock = 216 MHz / (div + 2).
// Sample time codes 0..7 = 1.5, 7.5, 13.5, 28.5, 41.5, 55.5, 71.5, 239.5 ADC cycles.
const ADC_SAMPLE_CYCLES = [1.5, 7.5, 13.5, 28.5, 41.5, 55.5, 71.5, 239.5];
const scanStatsPacket = () => hostPacket(0xfe, [6]);
function scanTunePacket({ settleUs = 0, adcDiv = 0, sample = 0, background = true, resetMax = false } = {}) {
  if (settleUs && !(settleUs >= 1 && settleUs <= 200)) throw new Error('settle is 1..200 us');
  if (adcDiv < 0 || adcDiv > 15) throw new Error('ADC divider code is 0..15');
  if (sample < 0 || sample > 7) throw new Error('sample time code is 0..7');
  return hostPacket(0xfe, [7, settleUs, adcDiv, sample, background ? 1 : 0, resetMax ? 1 : 0]);
}
function parseScanStats(r) {
  const u32 = (o) => (r[o] | (r[o + 1] << 8) | (r[o + 2] << 16) | (r[o + 3] << 24)) >>> 0;
  const u16 = (o) => r[o] | (r[o + 1] << 8);
  // where a pass spends its time (firmware with the 'sectionTime' feature), microseconds
  const sections = Object.fromEntries(['scan', 'hall', 'logic', 'reports', 'lightsAndSave'].map((k, n) => [k, u16(44 + 2 * n) / 10]));
  return {
    sections,
    frames: u32(8), passes: u32(12),
    passAvgUs: u32(16) / 1000, passMaxUs: u32(20) / 1000, ledRenderMaxUs: u32(24) / 1000,
    framesPerPass: u32(28) / 100,
    settleUs: r[32], adcDiv: r[33], adcMHz: 216 / (r[33] + 2), sample: r[34], sampleCycles: ADC_SAMPLE_CYCLES[r[34]],
    background: r[35] === 1, adcTimeouts: u32(36),
    // start-up check, background vs blocking frame (mean counts); null = not run; aligned is ~1, a shifted scan ~400 and is refused
    scanCheckDiff: (r[40] | (r[41] << 8)) === 0xffff ? null : r[40] | (r[41] << 8),
  };
}
const LAYER_PAGES = Math.ceil((SLOTS * 4) / 56);   // 10 pages of 56 bytes
const layerGetPacket = (layer, page) => hostPacket(0xfe, [3, layer, page]);
function layerPackets(layer, values) {
  if (![1, 2, 3].includes(layer)) throw new Error('layer is 1..3');
  if (values.length !== SLOTS) throw new Error(`need ${SLOTS} values`);
  const bytes = values.flat();
  return Array.from({ length: LAYER_PAGES }, (_, page) => hostPacket(0xfe, [2, layer, page], bytes.slice(page * 56, page * 56 + 56)));
}

// Fn layers 2..4 (0xFE 11 set / 12 get, open firmware 'fnLayers'): same paging as the user layers.
// Fn layer 1 is the stock Fn map. Fn+Home / Del / PgUp / PgDn picks which one Fn uses.
const FN_LAYERS = 4;
const fnLayerGetPacket = (layer, page) => hostPacket(0xfe, [12, layer, page]);
function fnLayerPackets(layer, values) {
  if (![2, 3, 4].includes(layer)) throw new Error('Fn layer is 2..4 (layer 1 is the stock Fn map)');
  if (values.length !== SLOTS) throw new Error(`need ${SLOTS} values`);
  const bytes = values.flat();
  return Array.from({ length: LAYER_PAGES }, (_, page) => hostPacket(0xfe, [11, layer, page], bytes.slice(page * 56, page * 56 + 56)));
}

// Text keys (0xFE 13 get / 14 set, open firmware 'textKeys'): string index 0..63, up to 119
// characters, typed by the keyboard itself (US layout) when a key [11, 0, index, 0] is pressed.
const TEXT_COUNT = 64;
const TEXT_MAX_LEN = 119;
const TEXT_PAGES = Math.ceil(TEXT_MAX_LEN / 56);
const textGetPacket = (index, page) => hostPacket(0xfe, [13, index, page]);
function textPackets(index, text) {
  if (!Number.isInteger(index) || index < 0 || index >= TEXT_COUNT) throw new Error(`text slot is 0..${TEXT_COUNT - 1}`);
  const s = String(text ?? '');
  // stored as UTF-8; plain characters are typed directly, others through the system's Unicode input
  const bad = [...s].find((ch) => /[\x00-\x08\x0b-\x1f\x7f]/.test(ch));
  if (bad !== undefined) throw new Error('control characters can\'t be typed (only Enter and Tab)');
  const bytes = [...Buffer.from(s, 'utf8')];
  if (bytes.length > TEXT_MAX_LEN) {
    throw new Error(`too long: ${bytes.length} of ${TEXT_MAX_LEN} bytes (plain characters take 1, special ones 2 to 4)`);
  }
  return Array.from({ length: TEXT_PAGES }, (_, page) => hostPacket(0xfe, [14, index, page, bytes.length], bytes.slice(page * 56, page * 56 + 56)));
}

// Lighting packet for a custom-firmware-only mode (same SET_LEDPARAM layout).
function customModePacket(mode, brightness = 4, rgb = [0, 0, 0]) {
  if (!Object.values(CUSTOM_MODE).includes(mode)) throw new Error('not a custom-firmware mode');
  if (!Number.isInteger(brightness) || brightness < 0 || brightness > 4) throw new Error('brightness is 0..4');
  return packet(OP.SET_LED, [mode, 2, brightness, 7, ...rgb.map((v) => Math.max(0, Math.min(255, v | 0)))], 'bit8');
}

// Per-key software control (open firmware, host_api.h). Built without packet()'s
// opcode checks because these opcodes only exist on the open firmware.
const HOST = { CAPS: 0xf8, CLAIM: 0xf9, INJECT: 0xfa, OVERLAY: 0xfb, SNAPSHOT: 0xfc, GAMEPAD: 0xfd, EVENT_KEY: 0xa1 };
const HOST_CAPS = ['travelStream', 'liveFrames', 'droplet', 'claim', 'inject', 'overlay', 'snapshot', 'keymapApplied', 'fnApplied',
  'advancedKeys', 'macros', 'nkro', 'continuousRt', 'gamepad', 'optionsLayers', 'fxEffects'];

function hostPacket(op, header = [], data = []) {
  const buf = new Array(REPORT_LEN).fill(0);
  buf[0] = op;
  header.forEach((b, i) => { buf[1 + i] = b & 0xff; });
  buf[7] = checksum(buf, 7);
  data.forEach((b, i) => { buf[8 + i] = b & 0xff; });
  return buf;
}

// second word (CAPS [8..9]): optional parts of the build
const HOST_CAPS2 = ['games', 'dksLevels', 'fnLayers', 'textKeys', 'calibration', 'perfMode', 'sectionTime', 'textTyping',
  'gamepadPlus', 'compatMode', 'releaseDebounce', 'idleDim', 'resetFe', 'sequence', 'sequenceGlide', 'keyActions'];

// third word (CAPS [10..11], firmware feature builder): bit 15 = the word is there (older firmware
// leaves it 0, so nothing in it can be read as "left out")
// bits 2..13 are the switchable firmware features (features.json caps); bit 14 says they follow
// the build (without it, older firmware, they are not reported)
const HOST_CAPS3 = ['pressureFx', 'memReport', 'dks', 'advKeys', 'kaModes', 'mouseKeys', 'mouseKeysPressure',
  'analogMouse', null, null, null, 'scanTiming', 'pressCounters', 'userLayers', 'buildBits'];
const CAPS3_BUILD = 0x4000;
// caps 'memReport': CAPS reply [12..35] = six u32 LE, how much of the keyboard the running image
// uses (firmware host_api.h host_mem_t). stackPeak 0 = not measured.
const MEM_FIELDS = ['flashUsed', 'flashSize', 'ramStatic', 'ramReserved', 'ramSize', 'stackPeak'];
function parseMemory(r) {
  const u32 = (o) => ((r[o] ?? 0) | ((r[o + 1] ?? 0) << 8) | ((r[o + 2] ?? 0) << 16) | ((r[o + 3] ?? 0) << 24)) >>> 0;
  return Object.fromEntries(MEM_FIELDS.map((f, i) => [f, u32(12 + i * 4)]));
}
const CAPS3_VALID = 0x8000;

function parseCaps(r) {
  const bits = r[6] | (r[7] << 8), bits2 = (r[8] ?? 0) | ((r[9] ?? 0) << 8), bits3 = (r[10] ?? 0) | ((r[11] ?? 0) << 8);
  const caps3 = Boolean(bits3 & CAPS3_VALID);
  return { api: r[1], keys: r[2], leds: r[3], cols: r[4], rows: r[5], ...(caps3 ? { caps3 } : {}),
    features: [...HOST_CAPS.filter((_, i) => bits & (1 << i)), ...HOST_CAPS2.filter((_, i) => bits2 & (1 << i)),
      ...(caps3 ? HOST_CAPS3.filter((f, i) => f && bits3 & (1 << i) && (i < 2 || bits3 & CAPS3_BUILD)) : [])],
    ...(caps3 && (bits3 & 2) ? { memory: parseMemory(r) } : {}) };
}

// ---- on-board gamepad (open firmware 0xFD, gamepad.h) ----------------------
// Targets in firmware order: index + 1 is the wire value, 0 = none. Same names
// as analog.js. Distances on the wire are centi-mm (u16 LE).
const GAMEPAD_TARGETS = ['lx-', 'lx+', 'ly-', 'ly+', 'rx-', 'rx+', 'ry-', 'ry+', 'lt', 'rt',
  'a', 'b', 'x', 'y', 'lb', 'rb', 'back', 'start', 'ls', 'rs', 'up', 'down', 'left', 'right',
  // analog mouse (open firmware with the mouse collection)
  'mouse-left', 'mouse-right', 'mouse-up', 'mouse-down', 'mouse1', 'mouse2', 'mouse3', 'wheel-up', 'wheel-down'];
// 'custom' and the payload from [11] on need caps 'gamepadPlus' (older firmware refuses curve 4
// and ignores the rest): [11] flags (bit0 square, bit1 snappy), [12] anti-deadzone %, [13] diagonal
// angle (0 = off, 10..80), [14..21] curve points x0 y0 .. x3 y3 (all 0 = keep), [22] output type (0).
const GAMEPAD_CURVES = ['linear', 'smooth', 'aggressive', 'instant', 'custom'];
const GP_SUB = { GET: 0, SET: 1, SET_BIND: 2, GET_BIND: 3 };
const GP_LINEAR_POINTS = [[0, 0], [85, 85], [170, 170], [255, 255]];
const cmm = (mm) => Math.max(0, Math.min(400, Math.round(mm * 100)));

const gamepadGetPacket = () => hostPacket(HOST.GAMEPAD, [GP_SUB.GET]);

function gamepadSetPacket({ enabled, keysStopTyping, curve, deadzoneMm, fullMm, buttonMm, mouseSpeed = 0,
  points = GP_LINEAR_POINTS, antiDeadzone = 0, square = false, snappy = false, diagonalDeg = 0 }) {
  const c = GAMEPAD_CURVES.indexOf(curve);
  if (c < 0) throw new Error(`curve is ${GAMEPAD_CURVES.join(', ')}`);
  const [d, f, b] = [cmm(deadzoneMm), cmm(fullMm), cmm(buttonMm)];
  if (!(d < f) || b < 1) throw new Error('0 <= dead zone < full press <= 4 mm, button point > 0');
  if (!(antiDeadzone >= 0 && antiDeadzone <= 100) || !(diagonalDeg === 0 || (diagonalDeg >= 10 && diagonalDeg <= 80))) {
    throw new Error('anti-deadzone 0..100 %, diagonal angle 0 or 10..80 degrees');
  }
  const ms = Math.max(0, Math.min(255, Math.round((mouseSpeed || 0) / 20)));   // x20 px/s, 0 = keep
  const pts = points.flat().map((v) => Math.max(0, Math.min(255, Math.round(v))));
  return hostPacket(HOST.GAMEPAD, [GP_SUB.SET], [enabled ? 1 : 0, keysStopTyping ? 1 : 0, c,
    d & 0xff, d >> 8, f & 0xff, f >> 8, b & 0xff, b >> 8, 0, ms,
    (square ? 1 : 0) | (snappy ? 2 : 0), Math.round(antiDeadzone), Math.round(diagonalDeg), ...pts, 0]);
}

function parseGamepad(r) {
  const u16 = (i) => r[i] | (r[i + 1] << 8);
  const raw = Array.from({ length: 8 }, (_, i) => r[22 + i] ?? 0);
  // older firmware (no gamepadPlus) answers zeros here: plain linear, every option off
  const points = raw.some(Boolean) ? [0, 2, 4, 6].map((i) => [raw[i], raw[i + 1]]) : GP_LINEAR_POINTS.map((p) => [...p]);
  return { enabled: r[8] === 1, keysStopTyping: r[9] === 1, curve: GAMEPAD_CURVES[r[10]] ?? 'linear',
    deadzoneMm: u16(11) / 100, fullMm: u16(13) / 100, buttonMm: u16(15) / 100,
    targetCount: r[17] ?? 0, mouseSpeed: (r[18] ?? 0) * 20,
    square: Boolean((r[19] ?? 0) & 1), snappy: Boolean((r[19] ?? 0) & 2), antiDeadzone: r[20] ?? 0,
    diagonalDeg: r[21] ?? 0, points, outputType: r[30] ?? 0 };
}

// bindings [{ slot, target }] -> 128 wire targets, 56 per packet
function gamepadBindPackets(bindings) {
  const t = new Array(SLOTS).fill(0);
  for (const { slot, target } of bindings) {
    const i = GAMEPAD_TARGETS.indexOf(target);
    if (i < 0) throw new Error(`unknown target ${target}`);
    checkSlot(slot);
    t[slot] = i + 1;
  }
  const out = [];
  for (let start = 0; start < SLOTS; start += 56) {
    const chunk = t.slice(start, start + 56);
    out.push(hostPacket(HOST.GAMEPAD, [GP_SUB.SET_BIND, start, chunk.length], chunk));
  }
  return out;
}

const gamepadGetBindPacket = (start) => hostPacket(HOST.GAMEPAD, [GP_SUB.GET_BIND, start]);

// claim[slot] truthy = software handles that key. One packet per 56 slots.
function claimPackets(claimBySlot) {
  const out = [];
  for (let start = 0; start < claimBySlot.length; start += 56) {
    const chunk = claimBySlot.slice(start, start + 56).map((c) => (c ? 1 : 0));
    out.push(hostPacket(HOST.CLAIM, [start, chunk.length], chunk));
  }
  return out;
}
const releaseAllPacket = () => hostPacket(HOST.CLAIM, [0xff]);

// Keys the firmware presses for software: modifier bits + up to 6 HID usages.
function injectPacket(modifiers = 0, usages = []) {
  if (usages.length > 6) throw new Error('at most 6 keys at once');
  return hostPacket(HOST.INJECT, [modifiers], usages);
}

// Per-key colours over the running effect; [0,0,0] = transparent. ttlMs up to 25.5 s.
function overlayPackets(rgbByLed, ttlMs = 2000) {
  const ttl = Math.max(1, Math.min(255, Math.round(ttlMs / 100)));
  const out = [];
  for (let start = 0; start < rgbByLed.length; start += 18) {
    const chunk = rgbByLed.slice(start, start + 18);
    out.push(hostPacket(HOST.OVERLAY, [start, chunk.length, ttl], chunk.flatMap((c) => (c ?? [0, 0, 0]).map((v) => Math.max(0, Math.min(255, v | 0))))));
  }
  return out;
}
const clearOverlayPacket = () => hostPacket(HOST.OVERLAY, [0xff]);

// Input report from the open firmware: [5?, 0xA1, slot, down].
function parseKeyEvent(data) {
  const d = data[0] === 5 ? data.slice(1) : data;
  if (d.length < 3 || d[0] !== HOST.EVENT_KEY) return null;
  return { slot: d[1], down: d[2] === 1 };
}

// Live frame packets (FEA_LIVE_LEDS 0xF5): [0xF5, start, n<=18] + RGB from byte 8.
function liveFramePackets(rgbByLed) {
  const out = [];
  for (let start = 0; start < rgbByLed.length; start += 18) {
    const chunk = rgbByLed.slice(start, start + 18);
    const buf = new Array(REPORT_LEN).fill(0);
    buf[0] = 0xf5; buf[1] = start; buf[2] = chunk.length;
    buf[7] = checksum(buf, 7);
    chunk.forEach((rgb, i) => rgb.forEach((v, c) => { buf[8 + i * 3 + c] = Math.max(0, Math.min(255, v | 0)); }));
    out.push(buf);
  }
  return out;
}

// ---- play sequence (open firmware 0xEF, seq.h, caps 'sequence') -------------
// [EF, sub, ...]; replies: [2] result, [8] playing, [9] flags, [10..11] next step,
// [12..13] steps loaded, [14..15] capacity, [16] why it last ended.
// Step = [delay ms u16 LE, type, a, b], 11 per APPEND chunk.
const SEQ = { OP: 0xef, STATUS: 0, CLEAR: 1, APPEND: 2, PLAY: 3, STOP: 4, CHUNK: 11, STEP_BYTES: 5, CAPACITY: 512, MAX_DELAY: 0xffff };
// glide = a mouse glide's header step, glideArg = its 2 or 4 argument steps (caps 'sequenceGlide')
const SEQ_EVENTS = ['wait', 'down', 'up', 'release', 'mouseDown', 'mouseUp', 'move', 'wheel', 'glide', 'glideArg'];   // type byte = index
const SEQ_ERRORS = [null, 'busy (a sequence is playing)', 'chunk out of order', 'too many steps', 'bad step', 'nothing loaded', 'unknown command'];
const SEQ_ENDS = [null, 'done', 'stopped', 'key pressed', 'blocked', 'cleared'];

const seqPacket = (sub, header = [], data = []) => hostPacket(SEQ.OP, [sub, ...header], data);
const seqPlayPacket = (stopOnKey = false) => seqPacket(SEQ.PLAY, [stopOnKey ? 1 : 0]);

// steps: [{ delay, type, a, b }] (type = SEQ_EVENTS index) -> APPEND packets in order
function seqAppendPackets(steps) {
  const out = [];
  for (let start = 0; start < steps.length; start += SEQ.CHUNK) {
    const chunk = steps.slice(start, start + SEQ.CHUNK);
    const data = chunk.flatMap(({ delay = 0, type, a = 0, b = 0 }) => [delay & 0xff, (delay >> 8) & 0xff, type, a, b]);
    out.push(seqPacket(SEQ.APPEND, [start & 0xff, start >> 8, chunk.length], data));
  }
  return out;
}
function parseSeqStatus(r) {
  return { error: SEQ_ERRORS[r[2]] ?? (r[2] ? `error ${r[2]}` : null), playing: r[8] === 1, stopOnKey: !!(r[9] & 1),
    step: r[10] | (r[11] << 8), steps: r[12] | (r[13] << 8), capacity: r[14] | (r[15] << 8), ended: SEQ_ENDS[r[16]] ?? null };
}

// ---- key action maps (open firmware 0xEE, caps 'keyActions') ------------------
// Per key: what happens at which depth / after how long held (src/key-actions.js has the JSON form).
// [EE, 0 INFO] -> [8] table entries, [9] max rules, [10] in use, [11] record bytes;
// [EE, 1 GET, slot] -> [2] 0 / 1 no map, [3] slot, [8..63] record;
// [EE, 2 SET, slot] + record -> [2] 0 ok / 2 table full / 3 bad rule ([3] rule index, 0xFF header) / 4 bad slot;
// [EE, 3 LIST, start] -> [3] slots returned, [4] total in use, [8..] slots with maps (ascending).
// Record (56): [0] slot [1] n [2] gap cmm [3] flags [4..5] press cmm LE [6..7] 0, then 6 rules of
// 8 bytes: [trigger | condition << 4, mode, tval lo, tval hi, output, a, b, c].
// Engine 2 (INFO [12] >= 2, feature 'keyModes'): [13] condition entries, [14] modes, [15] active modes;
// [EE, 4 COND_GET, idx] -> [3] idx, [8..11] entry; [EE, 5 COND_SET, idx] + entry -> 3 bad / 4 bad idx / 5 in use;
// [EE, 6 MODE_GET, n] -> [3] n, [4] active mask, [8..23] name; [EE, 7 MODE_SET, n] + name -> 3 bad / 4 bad n.
// Condition entry: [k0, k1, k2] slots held (0xFF unused), [3] modes on | modes off << 4.
// Engine 3 (INFO [12] = 3): a mouse keys ARG rule's mode byte = keep ms / 10 (0..100), c bit 0 = shared
// speed; engine 2 refuses a non-zero ARG mode / c. Engine 4 (INFO [12] = 4): ARG c bits 1..2 = speed by
// (0 time, 1 pressure, 2 both; 3 refused), and with 1 / 2 a DEPTH rule right after the ARG:
// [0x0F, 0, 0, 0, from, to, 0, 0] in 0.1 mm (0 <= from < to <= 40); engine 3 refuses those bits.
const KA = { OP: 0xee, INFO: 0, GET: 1, SET: 2, LIST: 3, COND_GET: 4, COND_SET: 5, MODE_GET: 6, MODE_SET: 7,
  RECORD: 56, MAX_RULES: 6, RULE: 8, CONDS: 15, MODES: 3, NAME: 16, ARG: 15 };
const KA_ERRORS = [null, 'the key has no map', 'the key action table is full', 'bad rule', 'bad slot', 'in use'];
const KA_COND_FREE = [0xff, 0xff, 0xff, 0];
const kaSlot = (slot) => { checkSlot(slot); return slot; };
const kaInfoPacket = () => hostPacket(KA.OP, [KA.INFO]);
const kaGetPacket = (slot) => hostPacket(KA.OP, [KA.GET, kaSlot(slot)]);
const kaListPacket = (start) => hostPacket(KA.OP, [KA.LIST, kaSlot(start)]);
function kaSetPacket(slot, record) {
  if (record.length !== KA.RECORD) throw new Error(`a key action record is ${KA.RECORD} bytes`);
  return hostPacket(KA.OP, [KA.SET, kaSlot(slot)], record);
}
// { slot, gap, flags, press, rules: [{ trigger, mode, tval, output, a, b, c }] } (wire units) <-> 56 bytes
function encodeKaRecord({ slot, gap = 0, flags = 0, press = 0, rules = [] }) {
  if (rules.length > KA.MAX_RULES) throw new Error(`at most ${KA.MAX_RULES} rules per key`);
  const r = new Array(KA.RECORD).fill(0);
  r.splice(0, 6, slot, rules.length, gap, flags, press & 0xff, (press >> 8) & 0xff);
  rules.forEach((x, i) => r.splice(8 + i * KA.RULE, KA.RULE,
    (x.trigger & 0x0f) | ((x.cond ?? 0) << 4), x.mode, x.tval & 0xff, (x.tval >> 8) & 0xff,
    x.output, x.a & 0xff, (x.b ?? 0) & 0xff, (x.c ?? 0) & 0xff));
  return r;
}
function decodeKaRecord(b) {
  const n = Math.min(b[1], KA.MAX_RULES);
  return { slot: b[0], gap: b[2], flags: b[3], press: b[4] | (b[5] << 8),
    rules: Array.from({ length: n }, (_, i) => {
      const o = 8 + i * KA.RULE;
      return { trigger: b[o] & 0x0f, cond: b[o] >> 4, mode: b[o + 1], tval: b[o + 2] | (b[o + 3] << 8), output: b[o + 4], a: b[o + 5], b: b[o + 6], c: b[o + 7] };
    }) };
}
// engine 1 = the first key action engine (INFO [12] 0 / absent): no conditions, modes or mouse keys;
// 2 / 3 as INFO [12] says (3: mouse keys can share speed)
function parseKaInfo(r) {
  const engine = r[12] >= 2 ? r[12] : 1;
  return { entries: r[8], maxRules: r[9], used: r[10], recordBytes: r[11], engine,
    conditions: engine >= 2 ? r[13] : 0, modes: engine >= 2 ? r[14] : 0, activeModes: engine >= 2 ? r[15] : 0 };
}
const kaIdx = (i, max, what) => { if (!Number.isInteger(i) || i < 1 || i > max) throw new Error(`${what} is 1..${max}`); return i; };
const kaCondGetPacket = (idx) => hostPacket(KA.OP, [KA.COND_GET, kaIdx(idx, KA.CONDS, 'condition entry')]);
function kaCondSetPacket(idx, entry) {
  if (!Array.isArray(entry) || entry.length !== 4) throw new Error('a condition entry is 4 bytes');
  return hostPacket(KA.OP, [KA.COND_SET, kaIdx(idx, KA.CONDS, 'condition entry')], entry);
}
const kaModeGetPacket = (n) => hostPacket(KA.OP, [KA.MODE_GET, kaIdx(n, KA.MODES, 'mode')]);
// name: string (UTF-8, at most 16 bytes; '' = unnamed)
function kaModeSetPacket(n, name) {
  return hostPacket(KA.OP, [KA.MODE_SET, kaIdx(n, KA.MODES, 'mode')], encodeModeName(name));
}
function encodeModeName(name) {
  const b = [...new TextEncoder().encode(String(name))];
  if (b.length > KA.NAME) throw new Error(`a mode name is at most ${KA.NAME} bytes (UTF-8)`);
  if (b.includes(0)) throw new Error('a mode name has no NUL characters');
  return [...b, ...new Array(KA.NAME - b.length).fill(0)];
}
function decodeModeName(bytes) {
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(Uint8Array.from(end < 0 ? bytes : bytes.slice(0, end)));
}
const parseKaCond = (r) => ({ idx: r[3], entry: r.slice(8, 12) });
const parseKaMode = (r) => ({ id: r[3], active: r[4], name: decodeModeName(r.slice(8, 8 + KA.NAME)) });

// Travel stream input report: [5, 0x1B, lo, hi, slot], report ID optional.
function parseTravel(data) {
  const d = data[0] === 5 ? data.slice(1) : data;
  if (d.length < 4 || d[0] !== OP.TRAVEL_STREAM) return null;
  return { slot: d[3], counts: d[1] | (d[2] << 8) };
}

module.exports = {
  REPORT_LEN, OP, FORBIDDEN, MACRO_MAX, checkMacroIndex, checkValue, HALL, WIDE, MODE_RAPID_TRIGGER, MODE_RT_CONTINUOUS, KIND_MASK, SLOTS,
  unitMm, checksum, packet, mmToWire, wireToMm, hallSetOne, hallSetAll, ledPacket, parseLed, parseTravel,
  screenColorPacket, audioVizPacket, REPORT_RATES, OS_LAYER, keymapSetOne, fnSetOne, fnGetPage,
  reportRatePacket, userPicPages, encodeMacro, decodeMacro, macroPages,
  CUSTOM_MODE, customModePacket, liveFramePackets, OPEN_LIGHT_MODES, BASE_OPEN_LIGHT_MODES, openModesFor,
  FN_LAYERS, fnLayerGetPacket, fnLayerPackets, TEXT_COUNT, TEXT_MAX_LEN, TEXT_PAGES, textGetPacket, textPackets,
  SNAP_MODES, UNICODE_MODES, TEXT_TYPING_MODES, RELEASE_DEBOUNCE_MAX, DIM_DEFAULT_PERCENT, parseFwOptions, fwOptionsPacket, fwOptionsGetPacket, fwFactoryResetPacket, pressCountPacket, pressResetPacket, scanStatsPacket, scanTunePacket, parseScanStats, LAYER_PAGES, layerGetPacket, layerPackets,
  HOST, HOST_CAPS, hostPacket, parseCaps, parseMemory, claimPackets, releaseAllPacket, injectPacket, overlayPackets,
  GAMEPAD_TARGETS, GAMEPAD_CURVES, gamepadGetPacket, gamepadSetPacket, parseGamepad, gamepadBindPackets, gamepadGetBindPacket,
  clearOverlayPacket, parseKeyEvent,
  SEQ, SEQ_EVENTS, seqPacket, seqPlayPacket, seqAppendPackets, parseSeqStatus,
  KA, KA_ERRORS, kaInfoPacket, kaGetPacket, kaSetPacket, kaListPacket, encodeKaRecord, decodeKaRecord, parseKaInfo,
  KA_COND_FREE, kaCondGetPacket, kaCondSetPacket, kaModeGetPacket, kaModeSetPacket, encodeModeName, decodeModeName, parseKaCond, parseKaMode,
  KIND, NO_PARTNER, dksActionByte, dksCells, dksActionsPacket,
  DKS_ACTIONS, DKS_MAX_LEVELS, DKS_MIN_MM, DKS_MAX_MM, dksReadPacket, dksWritePacket, parseDks, parseOptions, optionsPacket,
};
