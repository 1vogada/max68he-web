#!/usr/bin/env node
// Local web UI: JSON API over the Keyboard library plus static files from /web.
// Binds to 127.0.0.1 only. Usage: node src/web/server.js [port]
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createConnection, isDeviceError } = require('../connection');
const { slotName, textToSteps, describeSteps, FUNCTIONS, USAGE } = require('../keys');
const { AnalogEngine, PRESET_WASD, TARGETS, CURVES, CURVE_PRESETS } = require('../analog');
const P = require('../protocol');
const { loadPlugins } = require('../plugins');
const flasher = require('../flasher');
const uiPrefs = require('../ui-prefs');
const { profileRoutes } = require('./profile-routes');
const { MAX_ACTUATION_MM } = require('../limits');
const models = require('../models');
const { httpError, switchSettings, slotList, lightingChanges, intIn, keyValue, rgbList } = require('./validate');

const PORT = Number(process.argv[2] || process.env.PORT || 6868);
const STATIC = path.join(__dirname, '..', '..', 'web');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const MAX_BODY = 64 * 1024;

let flashing = false;              // nothing talks to the keyboard while it is being flashed
let scanRatePrev = null;          // last /api/scan-rate sample
// The keyboard model this server works on (models.js): the first one opened, then
// whichever POST /api/keyboard picks. It stays put while that keyboard is unplugged.
let selected = process.env.MAX68HE_KEYBOARD || null;
const conn = createConnection({
  blocked: () => flashing && httpError(503, 'the keyboard is being flashed; wait for it to finish'),
  key: () => selected ?? undefined,
});
const keyboard = () => conn.get().then((k) => { selected ??= k.model?.key ?? null; return k; });
// Closes the keyboard after the requests queued on it (see connection.js).
function drop() {
  travelStop = null;
  return conn.drop();
}

// ---- travel stream fan-out (Server-Sent Events) ---------------------------
// One board stream feeds two kinds of subscriber: raw travel (Analog view)
// and the analog engine's gamepad state (Analog page). It runs while either has one.

const travelClients = new Set();
const analogClients = new Set();
let travelStop = null;
let analogTimer = null;

// Before a flash: ends the streams and closes the keyboard, so the flasher has it alone.
async function release() {
  for (const c of [...travelClients, ...analogClients]) c.end();
  if (travelStop) await travelStop().catch(() => {});
  if (conn.opening) await conn.opening.catch(() => {});   // an open already in flight would hold the keyboard
  await drop();
  await new Promise((r) => setTimeout(r, 300));
}

// The web version's flash (web-build/web-flash.js): fn runs with the keyboard released and
// every request refused until it is done, as during POST /api/firmware/flash.
async function whileFlashing(fn) {
  if (flashing || flasher.job.running) throw httpError(409, 'a flash is already running');
  flashing = true;
  try {
    await release();
    return await fn();
  } finally { flashing = false; }
}

const ANALOG_FILE = path.join(__dirname, '..', '..', 'config', 'analog.json');

// The analog page's bindings + response as an on-board gamepad config. The board
// has no 'invert' option, so inverted bindings are left off it.
function boardGamepadFromEngine(flags) {
  const { curve, deadzoneMm, fullMm, buttonMm, points, antiDeadzone, square, snappy, diagonalDeg } = engine.settings;
  return { enabled: flags.enabled, keysStopTyping: flags.keysStopTyping, curve, deadzoneMm, fullMm, buttonMm,
    points, antiDeadzone, square, snappy, diagonalDeg, mouseSpeed: flags.mouseSpeed,
    bindings: engine.bindings.filter((b) => !b.invert).map(({ slot, target }) => ({ slot, target })) };
}
const engine = new AnalogEngine(PRESET_WASD);
try {
  const saved = JSON.parse(fs.readFileSync(ANALOG_FILE, 'utf8'));
  engine.configure(saved.bindings, saved.settings);
} catch { /* no saved config yet, or unreadable: keep the preset */ }

function saveAnalog() {
  fs.mkdirSync(path.dirname(ANALOG_FILE), { recursive: true });
  fs.writeFileSync(ANALOG_FILE, JSON.stringify({ bindings: engine.bindings, settings: engine.settings }, null, 1));
}

async function ensureTravel() {
  if (travelStop) return;
  const k = await keyboard();
  travelStop = await k.startTravel((t) => {
    engine.update(t.slot, t.mm);
    const line = `data: ${JSON.stringify(t)}

`;
    for (const c of travelClients) c.write(line);
  });
}

async function maybeStopTravel() {
  if (travelClients.size || analogClients.size || !travelStop) return;
  const stop = travelStop;
  travelStop = null;
  await stop().catch((e) => { if (isDeviceError(e)) return drop(); });
}

async function addTravelClient(res) {
  travelClients.add(res);
  await ensureTravel();
}

async function removeTravelClient(res) {
  travelClients.delete(res);
  await maybeStopTravel();
}

async function addAnalogClient(res) {
  analogClients.add(res);
  await ensureTravel();
  if (!analogTimer) {
    let last = '';
    analogTimer = setInterval(() => {
      const line = JSON.stringify(engine.state());
      if (line === last) return; // a held key sends nothing; skip unchanged frames
      last = line;
      for (const c of analogClients) c.write(`data: ${line}

`);
    }, 16);
  }
}

async function removeAnalogClient(res) {
  analogClients.delete(res);
  if (!analogClients.size && analogTimer) { clearInterval(analogTimer); analogTimer = null; }
  await maybeStopTravel();
}

// ---- routes ---------------------------------------------------------------

async function state() {
  const k = await keyboard();
  const caps = k.info.custom ? await k.getCaps() : null;
  const feats = caps ? [...caps.features] : [];
  // 'keyModes': key action engine 2 (conditions, modes, mouse keys), from the 0xEE INFO reply
  if (feats.includes('keyActions') && (await k.keyActionsInfo()).engine >= 2) feats.push('keyModes');
  const hasOL = feats.includes('optionsLayers');
  return {
    info: k.info,
    profile: await k.getProfile(),
    lighting: await k.getLighting(),
    keys: await k.listKeys(),
    switches: await k.getSwitches(),
    fn: (await k.getFnKeymap()).map((v, slot) => ({ slot, name: slotName(v) })).filter((x) => x.name),
    pollingRateHz: await k.getReportRate(),
    options: await k.getOptions(),
    functions: Object.keys(FUNCTIONS),
    keyNames: [...new Set(Object.values(USAGE))],   // plain keys, for the key picker
    // open firmware: user layers 1..3 (named entries only) and its options
    features: feats,
    hostApi: caps ? caps.api : 0,
    memory: caps?.memory ?? null,   // flash / RAM use (caps 'memReport'), null = not reported
    layers: hasOL ? await Promise.all([1, 2, 3].map(async (n) => (await k.getLayer(n))
      .map((v, slot) => ({ slot, name: slotName(v) })).filter((x) => x.name))) : null,
    fwOptions: hasOL ? await k.getFirmwareOptions() : null,
    // open firmware: Fn layers 2..4 (named entries only)
    fnLayers: feats.includes('fnLayers') ? await Promise.all([2, 3, 4].map(async (n) => (await k.getFnLayer(n))
      .map((v, slot) => ({ slot, name: slotName(v) })).filter((x) => x.name))) : null,
    openModes: k.info.custom ? P.openModesFor(caps) : {},
  };
}

const ROUTES = {
  'POST /api/remap': async (body) => {
    const k = await keyboard();
    const slot = intIn(body.slot, 0, 127, 'slot');
    const fnl = /^fn([234])$/.exec(body.layer ?? '');
    if (fnl) {
      if (!(await k.getCaps()).features.includes('fnLayers')) throw httpError(400, 'Fn layers 2-4 need a newer open firmware');
      const got = await k.setFnLayerKey(Number(fnl[1]), slot, keyValue(body.value));
      return { slot, layer: body.layer, name: slotName(got), state: await state() };
    }
    const user = /^l([123])$/.exec(body.layer ?? '');
    if (user) {
      if (!k.info.custom) throw httpError(400, 'layers need the open firmware');
      const got = await k.setLayerKey(Number(user[1]), slot, keyValue(body.value));
      return { slot, layer: body.layer, name: slotName(got), state: await state() };
    }
    const layer = body.layer === 'fn' ? 'fn' : 'base';
    const got = await k.setKey(slot, keyValue(body.value), { layer });
    return { slot, layer, name: slotName(got), state: await state() };
  },
  'POST /api/texts': async () => {
    const k = await keyboard();
    if (!k.info.custom || !(await k.getCaps()).features.includes('textKeys')) throw httpError(400, 'text keys need a newer open firmware');
    return { texts: await k.getTexts(), max: P.TEXT_MAX_LEN };
  },
  'POST /api/text/set': async (body) => {
    const k = await keyboard();
    const index = intIn(body.index, 0, P.TEXT_COUNT - 1, 'index');
    try {
      return { index, text: await k.setText(index, String(body.text ?? '')) };
    } catch (e) {
      throw e.status ? e : httpError(400, e.message);
    }
  },
  'POST /api/stats': async () => {
    const k = await keyboard();
    if (!k.info.custom || (await k.getCaps()).api < 2) throw httpError(400, 'needs the open firmware (stats build)');
    return k.getPressCounts();
  },
  'POST /api/stats/reset': async () => (await keyboard()).resetPressCounts(),
  'POST /api/fw-options': async (body) => {
    const k = await keyboard();
    if (!k.info.custom) throw httpError(400, 'needs the open firmware');
    const c = {};
    for (const key of ['capsIndicator', 'statusGuide', 'layerIndicator', 'fnHold', 'perf']) if (body[key] !== undefined) c[key] = Boolean(body[key]);
    if (body.snapMode !== undefined) c.snapMode = String(body.snapMode);
    for (const [key, list] of [['unicode', P.UNICODE_MODES], ['textTyping', P.TEXT_TYPING_MODES]]) if (body[key] !== undefined) {
      if (!list.includes(body[key])) throw httpError(400, `${key} is ${list.join(', ')}`);
      c[key] = body[key];
    }
    if (body.idleMinutes !== undefined) c.idleMinutes = intIn(body.idleMinutes, 0, 255, 'idleMinutes');
    if (body.compatMode !== undefined) c.compatMode = Boolean(body.compatMode);
    if (body.releaseDebounceMs !== undefined) c.releaseDebounceMs = intIn(body.releaseDebounceMs, 0, P.RELEASE_DEBOUNCE_MAX, 'releaseDebounceMs');
    if (body.dimMinutes !== undefined) c.dimMinutes = intIn(body.dimMinutes, 0, 255, 'dimMinutes');
    if (body.dimPercent !== undefined) c.dimPercent = intIn(body.dimPercent, 0, 100, 'dimPercent');
    if (body.capsColor !== undefined) {
      if (!/^#?[0-9a-f]{6}$/i.test(String(body.capsColor))) throw httpError(400, 'capsColor is rrggbb');
      const v = parseInt(String(body.capsColor).replace('#', ''), 16);
      c.capsColor = [v >> 16, (v >> 8) & 0xff, v & 0xff];
    }
    try {
      return { fwOptions: await k.setFirmwareOptions(c) };
    } catch (e) {
      throw httpError(400, e.message);
    }
  },
  'POST /api/fw-reset': async (body) => {
    if (body.confirm !== 'reset all') throw httpError(400, 'confirm with { confirm: "reset all" }');
    const k = await keyboard();
    if (!k.info.custom) throw httpError(400, 'needs the open firmware');
    await k.factoryReset();
    await new Promise((r) => setTimeout(r, 300));   // the board reseeds its keymaps in the next loop passes
    return { reset: true, state: await state() };
  },
  'POST /api/polling': async (body) => {
    if (![8000, 4000, 2000, 1000, 500, 250, 125].includes(body.hz)) throw httpError(400, 'unsupported polling rate');
    return { pollingRateHz: await (await keyboard()).setReportRate(body.hz) };
  },
  'POST /api/macro/get': async (body) => {
    const m = await (await keyboard()).getMacro(intIn(body.index, 0, 15, 'index'));
    return m ? { ...m, text: describeSteps(m.steps) } : { unreadable: true };
  },
  'POST /api/macro/set': async (body) => {
    const index = intIn(body.index, 0, 15, 'index');
    if (typeof body.text !== 'string' || !body.text.length || body.text.length > 60) throw httpError(400, 'text is 1..60 characters');
    let steps;
    try { steps = textToSteps(body.text, intIn(body.delayMs ?? 15, 1, 1000, 'delayMs')); } catch (e) { throw httpError(400, e.message); }
    const m = await (await keyboard()).setMacro(index, steps, intIn(body.repeat ?? 1, 1, 100, 'repeat'));
    return m ? { ...m, text: describeSteps(m.steps) } : { stored: true, unreadable: true };
  },
  'POST /api/options/get': async () => (await keyboard()).getOptions(),
  'POST /api/options/set': async (body) => {
    const c = {};
    if (body.antiMistouch !== undefined) c.antiMistouch = Boolean(body.antiMistouch);
    if (body.wasdSwap !== undefined) c.wasdSwap = Boolean(body.wasdSwap);
    if (body.rtStability !== undefined) {
      if (![0, 25, 50, 75, 100, 125].includes(body.rtStability)) throw httpError(400, 'rtStability is 0..125 in steps of 25');
      c.rtStability = body.rtStability;
    }
    if (!Object.keys(c).length) throw httpError(400, 'nothing to change');
    return (await keyboard()).setOptions(c);
  },
  // cheap check that the keyboard still answers (the page's connection status)
  'POST /api/ping': async () => { await (await keyboard()).getProfile(); return { ok: true }; },

  // which supported keyboards are plugged in, and the one this server works on
  'GET /api/keyboards': async () => {
    let list = [];
    try { list = models.plugged(); } catch { /* HID enumeration failed: report none */ }
    return { selected: conn.current?.model?.key ?? selected, keyboards: list.map(({ key, name }) => ({ key, name })) };
  },
  // switch to another keyboard: streams end, the open one closes, the next request opens the new one
  'POST /api/keyboard': async (body) => {
    const m = models.byKey(String(body.key ?? ''));
    if (!m) throw httpError(400, 'unknown keyboard');
    if (flashing) throw httpError(503, 'the keyboard is being flashed; wait for it to finish');
    if (m.key !== (conn.current?.model?.key ?? selected)) {
      for (const c of [...travelClients, ...analogClients]) c.end();
      if (travelStop) await travelStop().catch(() => {});
      if (conn.opening) await conn.opening.catch(() => {});
      await drop();
      selected = m.key;
      scanRatePrev = null;
    }
    return state();
  },

  // per-key calibration (open firmware): status / start / finish / cancel / reset, and the spans
  'POST /api/calibration': async (body) => (await keyboard()).calibration(String(body.action ?? 'status')),
  'POST /api/scan-stats': async () => (await keyboard()).getScanStats(1000),
  // live rates for the header: one read, rates over the time since the previous call
  'POST /api/scan-rate': async () => {
    const k = await keyboard();
    if (!k.info.custom) throw httpError(400, 'needs the open firmware');
    const s = P.parseScanStats(await k.t.query(P.scanStatsPacket()));
    const now = process.hrtime.bigint(), prev = scanRatePrev;
    scanRatePrev = { now, frames: s.frames, passes: s.passes };
    const sec = prev ? Number(now - prev.now) / 1e9 : 0;
    if (!prev || sec < 0.2 || sec > 30) return { scansPerSec: null, passesPerSec: null, passAvgUs: s.passAvgUs, background: s.background };
    return { scansPerSec: Math.round(((s.frames - prev.frames) >>> 0) / sec), passesPerSec: Math.round(((s.passes - prev.passes) >>> 0) / sec),
      passAvgUs: s.passAvgUs, background: s.background };
  },
  'POST /api/calibration/spans': async () => ({ keys: await (await keyboard()).calibrationSpans() }),

  // one-click firmware flashing (src/flasher.js): only the listed images
  'GET /api/firmware/images': async () => ({ flasher: flasher.flasherPresent(), images: flasher.listImages(), job: flasher.job }),
  'GET /api/firmware/flash': async () => flasher.job,
  'POST /api/firmware/flash': async (body) => {
    if (flasher.job.running) throw httpError(409, 'a flash is already running');
    // the images and ry-flash are for the MAX68HE (board 2755) only
    if ((conn.current?.model?.key ?? selected ?? models.DEFAULT.key) !== models.DEFAULT.key) {
      throw httpError(400, `firmware flashing is only for the ${models.DEFAULT.name}; switch to it first`);
    }
    const id = String(body.id ?? '');
    if (!flasher.listImages().some((x) => x.id === id)) throw httpError(400, 'unknown firmware image');
    if (!flasher.flasherPresent()) throw httpError(400, `ry-flash not found at ${flasher.config().flasher}`);
    // set before flash() starts and cleared only when it has finished, retry waits included,
    // so no other request reopens the keyboard mid-flash (the key action maps go on a handle of its own)
    flashing = true;
    flasher.flash(id, release, undefined, { open: () => require('../keyboard').Keyboard.open({ key: models.DEFAULT.key }) })
      .catch(() => {}).finally(() => { flashing = false; });
    return { started: true };
  },
  'POST /api/advanced/list': async () => ({ keys: await (await keyboard()).getAdvancedKeys() }),
  'POST /api/advanced/dks': async (body) => (await keyboard()).getDks(intIn(body.slot, 0, 127, 'slot')),
  'POST /api/advanced/set': async (body) => {
    const k = await keyboard();
    const slot = intIn(body.slot, 0, 127, 'slot');
    switch (body.type) {
      case 'clear': await k.clearAdvanced(slot); break;
      case 'snap': await k.setSnap(slot, intIn(body.partner, 0, 127, 'partner')); break;
      case 'modtap': await k.setModTap(slot, keyValue(body.hold), keyValue(body.tap), intIn(body.holdMs ?? 200, 10, 2550, 'holdMs')); break;
      case 'toggle': await k.setToggle(slot, keyValue(body.key), Boolean(body.repeat)); break;
      case 'dks': {
        if (Array.isArray(body.levels)) {   // multi-level DKS (open firmware 'dksLevels')
          const levels = body.levels.map((l) => ({ depthMm: Number(l?.depthMm), actions: Array.isArray(l?.actions) ? l.actions : [] }));
          const gapMm = body.gapMm === undefined ? 0.1 : Number(body.gapMm);
          await k.setDksLevels(slot, { keys: Array.isArray(body.keys) ? body.keys.map(String) : [], levels, gapMm });
          break;
        }
        if (!Array.isArray(body.bindings) || !body.bindings.length || body.bindings.length > 4) throw httpError(400, '1..4 bindings');
        const bindings = body.bindings.map((b) => {
          if (!Array.isArray(b.cells) || b.cells.length !== 4 || b.cells.some((c) => ![0, 1, 2, 3].includes(c))) throw httpError(400, 'cells are four values 0..3');
          return { key: keyValue(b.key), cells: b.cells };
        });
        const first = Number(body.firstPointMm);
        const second = Number(body.secondPointMm);
        if (!(first >= 0.1 && second <= MAX_ACTUATION_MM && first < second)) throw httpError(400, `points: 0.1 <= first < second <= ${MAX_ACTUATION_MM} mm`);
        await k.setDks(slot, { firstPointMm: first, secondPointMm: second, bindings });
        break;
      }
      default: throw httpError(400, 'type is clear, snap, modtap, toggle or dks');
    }
    return { keys: await k.getAdvancedKeys(), state: await state() };
  },
  'POST /api/analog/get': async () => ({
    bindings: engine.bindings, settings: engine.settings, targets: TARGETS, curves: Object.keys(CURVES), presets: CURVE_PRESETS,
  }),
  'POST /api/analog/set': async (body) => {
    try {
      engine.configure(body.bindings ?? engine.bindings, body.settings ?? engine.settings);
    } catch (e) {
      throw httpError(400, e.message);
    }
    saveAnalog();
    // keep the on-board gamepad in step while it is switched on
    const k = await keyboard();
    let board = null;
    if (k.info.custom) {
      board = await k.getBoardGamepad();
      if (board.enabled) board = await k.setBoardGamepad(boardGamepadFromEngine(board));
    }
    return { bindings: engine.bindings, settings: engine.settings, board };
  },
  // On-board gamepad (open firmware): the analog page's mapping, run by the keyboard.
  'POST /api/gamepad/board/get': async () => {
    const k = await keyboard();
    return { board: k.info.custom ? await k.getBoardGamepad() : null };
  },
  'POST /api/gamepad/board/set': async (body) => {
    const k = await keyboard();
    if (!k.info.custom) throw httpError(400, 'needs the open firmware');
    const cur = await k.getBoardGamepad();
    const want = { ...cur, ...(body.enabled !== undefined && { enabled: Boolean(body.enabled) }),
      ...(body.keysStopTyping !== undefined && { keysStopTyping: Boolean(body.keysStopTyping) }),
      ...(body.mouseSpeed !== undefined && { mouseSpeed: intIn(body.mouseSpeed, 20, 5100, 'mouseSpeed') }) };
    try {
      return { board: await k.setBoardGamepad(boardGamepadFromEngine(want)) };
    } catch (e) {
      throw httpError(400, e.message);
    }
  },
  'POST /api/custom/mode': async (body) => {
    const k = await keyboard();
    const rgb = /^#?[0-9a-f]{6}$/i.test(body.color ?? '') ? (() => { const v = parseInt(body.color.replace('#', ''), 16); return [v >> 16, (v >> 8) & 0xff, v & 0xff]; })() : [0, 0, 0];
    await k.setCustomMode(String(body.mode), intIn(body.brightness ?? 4, 0, 4, 'brightness'), rgb);
    return { ok: true };
  },
  'POST /api/custom/frame': async (body) => {
    const k = await keyboard();
    if (!Array.isArray(body.rgb) || !body.rgb.length || body.rgb.length > 128
      || !body.rgb.every((c) => Array.isArray(c) && c.length === 3 && c.every((v) => Number.isInteger(v) && v >= 0 && v <= 255))) {
      throw httpError(400, 'rgb is up to 128 [r, g, b] triples');
    }
    k.sendLiveFrame(body.rgb);
    return { ok: true };
  },
  'POST /api/export': async () => (await keyboard()).exportProfile(),
  'POST /api/import': async (body) => {
    const k = await keyboard();
    try {
      const r = await k.importProfile(body);
      return { ...r, state: await state() };
    } catch (e) {
      if (e.message.startsWith('not a valid backup')) throw httpError(400, e.message);
      throw e;
    }
  },
  'POST /api/picture': async (body) => {
    const k = await keyboard();
    const picture = intIn(body.picture, 0, 4, 'picture');
    await k.setPicture(picture, rgbList(body.colors));
    return { lighting: body.show === false ? await k.getLighting() : await k.showPicture(picture) };
  },
  'GET /api/state': () => state(),
  'POST /api/switches': async (body) => {
    const k = await keyboard();
    await k.setAllSwitches(switchSettings(body), slotList(body.slots));
    return { switches: await k.getSwitches() };
  },
  'POST /api/lighting': async (body) => ({ lighting: await (await keyboard()).setLighting(lightingChanges(body)) }),
  'POST /api/profile': async (body) => {
    if (![0, 1, 2, 3].includes(body.profile)) throw httpError(400, 'profile must be 0..3');
    const k = await keyboard();
    await k.setProfile(body.profile);
    return state();
  },
};

// optional features (plugins/<name>/): their API routes and web files
const PLUGINS = loadPlugins();
for (const p of PLUGINS) Object.assign(ROUTES, p.routes?.({ keyboard, httpError, intIn }) ?? {});
Object.assign(ROUTES, uiPrefs.routes());      // GET / POST /api/ui-prefs (config/ui.json)
// My profiles: names, saved library, swap, app-linked switching (profile-routes.js)
const myProfiles = profileRoutes({ keyboard, conn, drop, isDeviceError, isFlashing: () => flashing, state, httpError });
Object.assign(ROUTES, myProfiles.routes);
Object.assign(ROUTES, require('./remap-routes').remapRoutes({ keyboard, state, httpError, intIn, keyValue, slotName }));   // POST /api/remap/batch
Object.assign(ROUTES, require('./sequence-routes').sequenceRoutes({ keyboard, httpError }));   // /api/sequence/play|stop|status|preview
Object.assign(ROUTES, require('./key-action-routes').keyActionRoutes({ keyboard, httpError }));
Object.assign(ROUTES, require('./key-blocks-routes').keyBlocksRoutes({ httpError }));   // /api/key-blocks: the Blocks workspace (config/key-blocks.json)   // /api/key-actions (GET ?key=, POST, DELETE, preview, batch), /api/modes
Object.assign(ROUTES, require('./kbcode-routes').kbcodeRoutes({ keyboard, httpError }));   // /api/kbcode/check|apply|docs (docs/KBCODE.md)
Object.assign(ROUTES, require('./fw-builder-routes').fwBuilderRoutes());   // /api/firmware/features|size|build (src/fw-builder.js)
ROUTES['GET /api/plugins'] =async () => PLUGINS.map((p) => ({ name: p.name ?? p.id, scripts: p.scripts, styles: p.styles }));

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(httpError(413, 'body too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(httpError(400, 'invalid JSON')); }
    });
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

function serveStatic(req, res) {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const plug = /^\/plugins\/([\w-]+)\/(.+)$/.exec(rel);
  const p = plug && PLUGINS.find((x) => x.id === plug[1]);
  const base = p ? p.webDir : STATIC;
  const file = path.normalize(path.join(base, p ? plug[2] : rel === '/' ? 'index.html' : rel));
  if (plug && !p) return sendJson(res, 404, { error: 'not found' });
  if (!file.startsWith(base + path.sep)) return sendJson(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

async function handle(req, res) {
  // Host check blocks DNS-rebinding pages from reaching the API.
  const port = server.address()?.port ?? PORT;
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) {
    return sendJson(res, 421, { error: 'unexpected host' });
  }
  const route = `${req.method} ${new URL(req.url, 'http://x').pathname}`;
  // Same-origin only: refuse requests a foreign page's script could send.
  if (req.method !== 'GET' && req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) {
    return sendJson(res, 403, { error: 'cross-origin request refused' });
  }
  if (route === 'GET /api/analog') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(engine.state())}

`);
    req.on('close', () => removeAnalogClient(res));
    return addAnalogClient(res).catch((e) => { res.write(`event: error
data: ${JSON.stringify(e.message)}

`); res.end(); });
  }
  if (route === 'GET /api/travel') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': ok\n\n');
    req.on('close', () => removeTravelClient(res));
    return addTravelClient(res).catch((e) => { res.write(`event: error\ndata: ${JSON.stringify(e.message)}\n\n`); res.end(); });
  }
  const handler = ROUTES[route];
  if (!handler) return req.method === 'GET' ? serveStatic(req, res) : sendJson(res, 404, { error: 'not found' });
  try {
    // a GET's query string (?key=W) arrives as its body; callRoute reopens a stale handle (connection.js)
    const body = req.method === 'GET' ? Object.fromEntries(new URL(req.url, 'http://x').searchParams) : await readBody(req);
    sendJson(res, 200, await callRoute(route, body));
  } catch (e) {
    sendJson(res, e.status || 500, { error: e.message });
  }
}

// One API call: also how the browser build (web-build/main.js) answers the page's fetch.
// A device error drops the keyboard (bad input keeps it); a stale handle reopens and the
// handler runs once more when nothing was sent (connection.js).
async function callRoute(route, body = {}) {
  const handler = ROUTES[route];
  if (!handler) throw httpError(404, 'not found');
  return conn.run(() => handler(body), (e) => (isDeviceError(e) ? drop() : undefined));
}

// Anything the handler throws ends as an answer, never as an unhandled rejection:
// a malformed URL (GET /%) is the client's fault, the rest is logged.
const server = http.createServer((req, res) => handle(req, res).catch((e) => {
  const bad = e instanceof URIError || e?.code === 'ERR_INVALID_URL';
  if (!bad) console.error('request failed:', e);
  if (res.headersSent) return res.end();
  sendJson(res, bad ? 400 : 500, { error: bad ? 'malformed URL' : e.message });
}));

if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => console.log(`max68he web UI: http://127.0.0.1:${PORT}`));
  myProfiles.sync();                            // app-linked profiles, when switched on
  // A stray error is logged instead of ending the server; during a flash it also goes
  // into the flash log so the page shows it.
  for (const ev of ['unhandledRejection', 'uncaughtException']) {
    process.on(ev, (e) => {
      console.error(`${ev}:`, e);
      if (flasher.job.running) flasher.job.log.push(`Web server error during the flash: ${e?.message ?? e}`);
    });
  }
  process.on('SIGINT', async () => {
    for (const c of [...travelClients, ...analogClients]) c.end();
    if (analogTimer) clearInterval(analogTimer);
    if (travelStop) await travelStop().catch(() => {});
    await drop();
    process.exit(0);
  });
}

// streams: the browser build's EventSource stand-in subscribes like a response object would
const streams = { addTravelClient, removeTravelClient, addAnalogClient, removeAnalogClient, analogState: () => engine.state() };

module.exports = { server, ROUTES, callRoute, streams, whileFlashing };
