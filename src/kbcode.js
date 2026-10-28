// kbcode on Node: the sandbox runner, reading the keyboard for the diff, and apply.
// check(code, { keyboard }) never writes: it runs the script, checks the plan and compares it with
// the keyboard (or, with no keyboard, lists what would be written). apply(keyboard, code) refuses on
// any error, then writes only what differs, through the driver's own methods (and their pacing).
// The pure part (API, plan, validation, diff) is kbcode-core.js / kbcode-api.js.
const P = require('./protocol');
const { parseKey } = require('./keys');
const C = require('./kbcode-core');
const { runScriptWeb } = require('./kbcode-sandbox-web');

const TIMEOUT_MS = 1000;
const BOOT_MS = 2000;            // a worker's start and the read back, on top of the script's own time
const MEMORY_MB = 128;
const fail = (message) => ({ error: { line: 0, col: 0, message } });

// Runs the API (apiSource with meta) and then the script in a worker thread (kbcode-sandbox.js): its
// own isolate with a memory cap, a fresh node:vm context inside, 1 s for the script. The worker is
// killed when the script's promises keep it busy past that. -> Promise<{ json } | { error }>.
// In a browser (the web version) the sandbox is a Web Worker instead (kbcode-sandbox-web.js).
function runScript(apiSource, meta, code, { timeout = TIMEOUT_MS } = {}) {
  // process.getBuiltinModule keeps the web build (esbuild, browser) from bundling worker_threads
  const wt = globalThis.process?.getBuiltinModule?.('node:worker_threads');
  if (!wt && typeof globalThis.Worker === 'function') return runScriptWeb(apiSource, meta, code, { timeout });
  if (!wt) return Promise.resolve(fail('kbcode needs a sandbox to run scripts (worker threads or Web Workers); none here'));
  return new Promise((resolve) => {
    let settled = false;
    const end = (r) => { if (settled) return; settled = true; clearTimeout(timer); worker.terminate().catch(() => {}); resolve(r); };
    const worker = new wt.Worker(`${__dirname}/kbcode-sandbox.js`, {
      workerData: { apiSource, meta, code, timeout },
      resourceLimits: { maxOldGenerationSizeMb: MEMORY_MB, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      stdout: true, stderr: true,      // nothing the sandbox prints reaches this process's output
    });
    const timer = setTimeout(() => end(fail(`the script ran longer than ${timeout} ms (an endless loop, maybe in a promise?)`)), timeout + BOOT_MS);
    worker.on('message', (m) => end(typeof m?.json === 'string' || m?.error ? m : fail('the sandbox answered nothing')));
    worker.on('error', (e) => end(fail(e?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? `the script used more than ${MEMORY_MB} MB of memory` : 'the sandbox stopped')));
    worker.on('exit', () => end(fail('the sandbox stopped')));
  });
}

// ---- the keyboard ---------------------------------------------------------------------------

// what the script may use and the checks need: model, firmware features, key action engine, modes
async function readState(k) {
  const info = k.info;
  const open = Boolean(info.custom);
  const caps = open ? await k.getCaps() : null;
  const features = caps ? [...caps.features] : [];
  let engine = 0, entries = 0, modes = null, conditions = 0;
  if (features.includes('keyActions')) {
    const ka = await k.keyActionsInfo();
    engine = ka.engine;
    entries = ka.entries;
    conditions = ka.conditions;
    if (engine >= 2) modes = (await k.getModes()).map(({ id, name }) => ({ id, name }));
  }
  return { model: info.model ?? 'max68he', open, features, hostApi: caps?.api ?? 0, engine, entries, conditions,
    openModes: open ? Object.keys(P.openModesFor(caps)).map(Number) : [], modes, profile: await k.getProfile(), unitMm: info.unitMm };
}

// Reads only what the plan touches. perProfile false: the plan switches profile first, so this
// profile's switches, keys, lighting and advanced keys are not compared (all written as planned).
async function readCurrent(k, plan, state, { perProfile = true } = {}) {
  const cur = { profile: state.profile, unitMm: state.unitMm };
  if (plan.switches && perProfile) cur.switches = await k.getSwitches();
  if (plan.remap) {
    cur.keymaps = {};
    for (const id of new Set(plan.remap.map((r) => (r.os ? `${r.layer}:${r.os}` : r.layer)))) {
      const [layer, os = 'win'] = id.split(':');
      if (layer === 'base') { if (perProfile) cur.keymaps.base = await k.getKeymap(); } else if (layer === 'fn') {
        if (perProfile) cur.keymaps[id] = await k.getFnKeymap(undefined, os);
      } else if (layer.startsWith('fn')) cur.keymaps[id] = await k.getFnLayer(Number(layer.slice(2)));
      else cur.keymaps[id] = await k.getLayer(Number(layer.slice(1)));
    }
  }
  if ((plan.lighting || plan.picture) && perProfile) cur.lighting = await k.getLighting();
  if (plan.advanced && perProfile) cur.advanced = await k.getAdvancedKeys();
  if (plan.options) cur.options = await k.getOptions();
  if (plan.pollingRateHz !== undefined) cur.pollingRateHz = await k.getReportRate();
  if (plan.fwOptions) cur.fwOptions = await k.getFirmwareOptions();
  if (plan.gamepad) cur.gamepad = await k.getBoardGamepad();
  if (plan.macros) { cur.macros = {}; for (const m of plan.macros) cur.macros[m.index] = await k.getMacro(m.index); }
  if (plan.texts) { cur.texts = {}; for (const t of plan.texts) cur.texts[t.index] = await k.getText(t.index); }
  if (plan.keyActions) cur.keyActions = { maps: await k.getKeyActions(), modes: state.modes, entries: state.entries };
  return cur;
}

// ---- check / apply --------------------------------------------------------------------------

// -> { ok, plan, summary, changes, errors, logs, notes, compared }. keyboard: an open Keyboard, or
// null (then nothing is read; noKeyboard says why, for the notes).
async function check(code, { keyboard = null, noKeyboard } = {}) {
  const state = keyboard ? await readState(keyboard) : null;
  const r = await C.compile(code, { state, run: runScript });
  const notes = [...r.notes];
  if (!keyboard && noKeyboard) notes.unshift(`Keyboard not available (${noKeyboard}).`);
  if (!r.ok) return { ok: false, plan: r.plan, summary: [], changes: 0, errors: r.errors, logs: r.logs, notes, compared: false };
  let cur = null;
  if (keyboard) {
    const switching = r.plan.profile !== undefined && r.plan.profile !== state.profile;
    cur = await readCurrent(keyboard, r.plan, state, { perProfile: !switching });
    if (switching) notes.push(`The script makes profile ${r.plan.profile} active: its switches, keys, lighting and advanced keys are listed as planned and compared when it is applied.`);
  }
  const d = C.diff(r.plan, cur, state);
  const errors = d.problems.map((message) => ({ line: 0, col: 0, message }));
  const summary = d.changes.map((x) => x.text);
  if (keyboard && !summary.length) summary.push('Nothing to change: the keyboard already matches the script.');
  return { ok: errors.length === 0, plan: r.plan, summary: [...summary, ...notes.map((n) => `Note: ${n}`)], changes: d.changes.length,
    errors, logs: r.logs, notes, compared: Boolean(keyboard) };
}

// Writes what differs. -> { ok, applied: [text], errors, logs }; refuses (nothing written) on any error.
async function apply(k, code, { onStep = () => {} } = {}) {
  const c = await check(code, { keyboard: k });
  if (!c.ok) return { ok: false, applied: [], errors: c.errors, logs: c.logs };
  const applied = [];
  try {
    const state = await readState(k);
    const plan = c.plan;
    if (plan.profile !== undefined && plan.profile !== state.profile) {
      onStep(`profile ${plan.profile}`);
      await k.setProfile(plan.profile);
      applied.push(`Active profile: ${plan.profile} (was ${state.profile})`);
      state.profile = plan.profile;
    }
    const cur = await readCurrent(k, plan, state);
    const d = C.diff({ ...plan, profile: undefined }, cur, state);
    if (d.problems.length) return { ok: false, applied, errors: d.problems.map((message) => ({ line: 0, col: 0, message })), logs: c.logs };
    await write(k, d, applied, onStep);
    if (!applied.length) applied.push('Nothing to change: the keyboard already matches the script.');
    return { ok: true, applied, errors: [], logs: c.logs };
  } catch (e) {
    return { ok: false, applied, errors: [{ line: 0, col: 0, message: `stopped: ${e.message}${applied.length ? ' (the lines in applied were written)' : ' (nothing was written)'}` }], logs: c.logs };
  }
}

// diff writes -> driver calls, section by section; each finished section adds its change lines
async function write(k, { writes: w, changes }, applied, onStep) {
  const done = (section) => applied.push(...changes.filter((x) => x.section === section).map((x) => x.text));
  if (w.remap?.length) {
    for (const r of w.remap) {
      onStep(`key ${r.key} on ${r.layer}`);
      if (r.layer === 'base') await k.setKey(r.slot, r.bytes, { layer: 'base' });
      else if (r.layer === 'fn') await k.setKey(r.slot, r.bytes, { layer: 'fn', os: r.os ?? 'win' });
      else if (r.layer.startsWith('fn')) await k.setFnLayerKey(Number(r.layer.slice(2)), r.slot, r.bytes);
      else await k.setLayerKey(Number(r.layer.slice(1)), r.slot, r.bytes);
    }
    done('remap');
  }
  if (w.macros?.length) {
    for (const m of w.macros) { onStep(`macro ${m.index}`); await k.setMacro(m.index, m.steps, m.repeat); }
    done('macros');
  }
  if (w.texts?.length) {
    for (const t of w.texts) { onStep(`text ${t.index}`); await k.setText(t.index, t.text); }
    done('texts');
  }
  if (w.switches?.length) {
    for (const g of w.switches) { onStep(`switch settings of ${g.slots.length} key${g.slots.length > 1 ? 's' : ''}`); await k.setAllSwitches(g.settings, g.slots); }
    done('switches');
  }
  if (w.advanced?.length) {
    for (const a of w.advanced) {
      onStep(`advanced key ${a.slot}`);
      if (a.clearFirst || a.kind === 'plain') await k.clearAdvanced(a.slot);
      if (a.clearPartner) await k.clearAdvanced(a.partner);
      if (a.kind === 'modtap') await k.setModTap(a.slot, parseKey(a.hold), parseKey(a.tap), a.holdMs);
      else if (a.kind === 'toggle') await k.setToggle(a.slot, parseKey(a.key), a.repeat);
      else if (a.kind === 'snap') await k.setSnap(a.slot, a.partner);
      else if (a.kind === 'dks' && a.levels) await k.setDksLevels(a.slot, { keys: a.keys, levels: a.levels, gapMm: a.gapMm });
      else if (a.kind === 'dks') {
        await k.setDks(a.slot, { firstPointMm: a.firstPointMm, secondPointMm: a.secondPointMm,
          bindings: a.bindings.map((b) => ({ key: parseKey(b.key), cells: b.cells })) });
      }
    }
    done('advanced');
  }
  if (w.picture) {
    onStep(`picture ${w.picture.index}`);
    const hex = (h) => { const v = parseInt(h.slice(1), 16); return [v >> 16, (v >> 8) & 0xff, v & 0xff]; };
    const rgb = [];
    for (const { slot } of C.keyTable(k.info.model).keys) rgb[slot] = hex(w.picture.fill);
    for (const [slot, h] of Object.entries(w.picture.colors)) rgb[Number(slot)] = hex(h);
    await k.setPicture(w.picture.index, rgb);
  }
  if (w.lighting) { onStep('lighting'); await k.setLighting(w.lighting); }
  if (w.showPicture) await k.showPicture(w.showPicture.index);
  if (w.picture || w.lighting) done('lighting');
  if (w.options) { onStep('options'); await k.setOptions(w.options); }
  if (w.pollingRateHz) { onStep('polling rate'); await k.setReportRate(w.pollingRateHz); }
  if (w.fwOptions) { onStep('firmware options'); await k.setFirmwareOptions(w.fwOptions); }
  for (const { mode, ...f } of w.modeFlash ?? []) { onStep(`mode ${mode} flash`); await k.setModeFlash(mode, f); }
  if (w.options || w.pollingRateHz || w.fwOptions || w.modeFlash) done('options');
  if (w.gamepad) { onStep('gamepad'); await k.setBoardGamepad(w.gamepad); done('gamepad'); }
  if (w.keyActions) {
    onStep('key action maps');
    const { modes, maps, remove } = w.keyActions;
    await k.setKeyActionsBatch({ maps, remove, ...(modes && { modes }) });
    done('keyActions');
  }
  if (w.sequence) {
    onStep('sequence');
    await k.playSequence(w.sequence.text, { stopOnKey: w.sequence.stopOnKey });
    done('sequence');
  }
}

// ---- docs ---------------------------------------------------------------------------------------
// { dts, markdown, examples } for GET /api/kbcode/docs and the MCP tool
function docs() {
  const fs = require('fs');
  const path = require('path');
  const read = (f) => { try { return fs.readFileSync(path.join(__dirname, '..', 'docs', f), 'utf8'); } catch { return ''; } };
  return { dts: read('kb.d.ts'), markdown: read('KBCODE.md'), examples: require('./kbcode-examples').EXAMPLES.map(({ name, code }) => ({ name, code })) };
}

// plan errors -> "line 12:5: message" lines (CLI, MCP)
const errorLines = (errors) => errors.map((e) => (e.line ? `line ${e.line}${e.col ? `:${e.col}` : ''}: ${e.message}` : e.message));

module.exports = { runScript, readState, readCurrent, check, apply, docs, errorLines, TIMEOUT_MS };
