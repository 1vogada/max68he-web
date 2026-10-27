// Request validation for the web API: turns JSON bodies into library arguments
// and refuses bad input with httpError(400) before anything reaches the keyboard.
const P = require('../protocol');
const { parseKey } = require('../keys');

const { SWITCH_LIMITS: SWITCH_FIELDS } = require('../limits');

function switchSettings(body) {
  const s = {};
  for (const [f, [lo, hi]] of Object.entries(SWITCH_FIELDS)) {
    if (body[f] === undefined) continue;
    const v = Number(body[f]);
    if (!Number.isFinite(v) || v < lo || v > hi) throw httpError(400, `${f} must be ${lo}..${hi} mm`);
    s[f] = v;
  }
  if (body.rapidTrigger !== undefined) s.rapidTrigger = Boolean(body.rapidTrigger);
  if (body.continuousRt !== undefined) s.continuousRt = Boolean(body.continuousRt);
  if (!Object.keys(s).length) throw httpError(400, 'nothing to change');
  return s;
}

function slotList(slots) {
  if (slots === undefined) return undefined;
  if (!Array.isArray(slots) || !slots.length || slots.some((s) => !Number.isInteger(s) || s < 0 || s > 127)) {
    throw httpError(400, 'slots must be a non-empty array of 0..127');
  }
  return slots;
}

function lightingChanges(body) {
  const c = {};
  const int = (k, lo, hi) => {
    if (body[k] === undefined) return;
    if (!Number.isInteger(body[k]) || body[k] < lo || body[k] > hi) throw httpError(400, `${k} must be ${lo}..${hi}`);
    c[k] = body[k];
  };
  if (P.OPEN_LIGHT_MODES[body.mode]) c.mode = body.mode;   // board-rendered (★); setLighting refuses them on stock
  else int('mode', 1, 19);
  int('speed', 0, 4); int('brightness', 0, 4); int('option', 0, 15);
  if (c.mode === 13) throw httpError(400, 'mode 13 unsupported');
  if (body.rainbow) Object.assign(c, { rainbow: true, presetColour: null });
  if (body.presetColour !== undefined) {
    int('presetColour', 0, 6);
    c.rainbow = false;
  }
  if (body.color !== undefined) {
    if (!/^#?[0-9a-f]{6}$/i.test(body.color)) throw httpError(400, 'color is rrggbb');
    const v = parseInt(body.color.replace('#', ''), 16);
    Object.assign(c, { r: v >> 16, g: (v >> 8) & 0xff, b: v & 0xff, rainbow: false, presetColour: null });
  }
  if (!Object.keys(c).length) throw httpError(400, 'nothing to change');
  return c;
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

const intIn = (v, lo, hi, name) => {
  if (!Number.isInteger(v) || v < lo || v > hi) throw httpError(400, `${name} must be ${lo}..${hi}`);
  return v;
};

// A key name or raw:xxxxxxxx, checked like any key write (macro / text index in range).
function keyValue(text) {
  try {
    const v = parseKey(String(text ?? ''));
    P.checkValue(v);
    return v;
  } catch (e) {
    throw httpError(400, e.message);
  }
}

function rgbList(colors) {
  if (!Array.isArray(colors) || colors.length > 128) throw httpError(400, 'colors must be [[slot, "rrggbb"], ...]');
  const rgb = [];
  for (const [slot, hex] of colors) {
    intIn(slot, 0, 125, 'slot');
    if (!/^#?[0-9a-f]{6}$/i.test(String(hex))) throw httpError(400, 'colour is rrggbb');
    const v = parseInt(String(hex).replace('#', ''), 16);
    rgb[slot] = [v >> 16, (v >> 8) & 0xff, v & 0xff];
  }
  return rgb;
}

module.exports = { httpError, switchSettings, slotList, lightingChanges, intIn, keyValue, rgbList, SWITCH_FIELDS };
