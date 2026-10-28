// MAX68HE web UI. Talks to src/web/server.js.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const MODES = [
  [1, 'Static'], [2, 'Breathing'], [3, 'Spectrum', { noColour: true }], [4, 'Wave', ['Right', 'Left', 'Down', 'Up']],
  [5, 'Ripple'], [6, 'Star dots'], [7, 'Flow', ['Zigzag', 'Spiral']], [8, 'Key shadow'], [9, 'Layers'],
  [10, 'Sine'], [11, 'Spring', ['Outward', 'Inward']], [12, 'Neon', ['Right', 'Left']], [14, 'Radiant'],
  [15, 'Loop', ['CCW', 'CW']], [16, 'Colour grid'], [17, 'Snowfall'], [18, 'Meteor'], [19, 'Silent snow'],
];
const PRESETS = ['Red', 'Orange', 'Yellow', 'Green', 'Cyan', 'Blue', 'Magenta'];
const BRIGHTNESS = ['lowest', 'low', 'medium', 'high', 'highest'];
const SPEED = ['slowest', 'slow', 'medium', 'fast', 'fastest'];
const FULL_TRAVEL_MM = 3.6;
const SWITCH_FIELDS = ['actuation', 'release', 'rtPress', 'rtRelease', 'deadZone'];
const SELECTING = ['actuation', 'rt', 'keymap', 'fn', 'layers', 'advanced', 'analog'];   // pages that select keys

const st = { keys: [], switches: [], lighting: null, profile: 0, selected: new Set(), view: 'actuation', dirty: new Set(),
  fn: new Map(), pollingRateHz: null, functions: [], features: [] };
const keyEls = new Map(); // slot -> element
// Feature modules register per-view hooks in App.views[view]: init, paint, keyDown, keyDrag, selection.
const view = () => window.App?.views?.[st.view];

// ---- api and connection ----------------------------------------------------------

let connected = null;

async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method, headers: body ? { 'content-type': 'application/json' } : {}, body: body && JSON.stringify(body),
    });
  } catch {
    setConnected(false, 'The web UI server is not running.');
    throw new Error('Lost contact with the web UI server');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status >= 500 && url !== '/api/ping') checkConnection();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

let pingTimer = null;
async function checkConnection() {
  try {
    await api('POST', '/api/ping');
    if (connected === false) {
      setConnected(true);
      applyState(await api('GET', '/api/state'));
      toast('Keyboard connected again');
    }
  } catch (e) {
    setConnected(false, e.message);
  }
}

function setConnected(ok, why = '') {
  connected = ok;
  const s = $('#status');
  s.classList.toggle('down', !ok);
  $('#status-text').textContent = ok ? `USB · ${st.pollingRateHz ?? '?'} Hz`
    : /web UI server/.test(why) ? 'Web UI server stopped' : 'Keyboard not connected';
  s.title = ok ? '' : why;
  $('#reconnect').hidden = ok;
  clearInterval(pingTimer);
  if (!ok) pingTimer = setInterval(checkConnection, 3000);   // reconnects on its own once it is back
}

function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `show${err ? ' err' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.className = ''; }, err ? 5000 : 2500);
}

// Runs fn with el dimmed. A failure stays visible in el's panel until the next success.
async function busy(el, label, fn) {
  el.classList.add('busy');
  if (label) toast(label);
  try {
    await fn();
    App.ui.showError(el, null);
  } catch (e) {
    toast(e.message, true);
    App.ui.showError(el, e.message);
  } finally { el.classList.remove('busy'); }
}

const fwText = () => (st.info ? `${st.info.firmware.slice(0, -2)}.${st.info.firmware.slice(-2)}` : '');

// ---- keyboard drawing ------------------------------------------------------

function slotForName(name) {
  const k = st.keys.find((x) => x.name === name);
  return k ? k.slot : null;
}

// Key unit that makes the 16-unit-wide board fill its card (34..68 px).
function fitUnit() {
  const css = getComputedStyle(document.documentElement);
  const gap = parseFloat(css.getPropertyValue('--gap')) || 5;
  const avail = $('.board-wrap').clientWidth - 28 - 15 * gap;
  const u = Math.max(34, Math.min(68, Math.floor(avail / 16)));
  document.documentElement.style.setProperty('--u', `${u}px`);
  return { u, gap };
}

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (st.keys.length) drawKeyboard(); }, 120);
});

function drawKeyboard() {
  const kbEl = $('#keyboard');
  kbEl.textContent = '';
  keyEls.clear();
  const { u: unit, gap } = fitUnit();
  for (const row of window.LAYOUT) {
    const r = document.createElement('div');
    r.className = 'krow';
    for (const [spec, w = 1] of row) {
      const name = typeof spec === 'string' ? spec : spec.name ?? null;
      const slot = typeof spec === 'string' ? slotForName(spec) : spec.slot;
      const el = document.createElement('div');
      el.className = 'key';
      el.style.width = `${w * unit + (w - 1) * gap}px`;
      el.innerHTML = '<div class="fill"></div><div class="mark"></div><div class="bar"></div><span class="label"></span><span class="val"></span>';
      $('.label', el).textContent = name ? (window.LABELS[name] ?? name) : spec.label;
      if (slot === null || slot === undefined) el.classList.add('empty');
      else {
        el.dataset.slot = slot;
        el.dataset.name = name ?? spec.label;
        keyEls.set(slot, el);
      }
      r.append(el);
    }
    kbEl.append(r);
  }
  bindSelection(kbEl);
  paintKeys();
}

function paintKeys() {
  for (const [slot, el] of keyEls) {
    const s = st.switches[slot];
    if (!s) continue;
    el.classList.toggle('sel', st.selected.has(slot));
    el.classList.remove('partner');
    const val = $('.val', el);
    val.title = ''; $('.bar', el).style.width = '0';
    if (view()?.paint?.(slot, el)) continue; // a feature module drew this key
    el.style.color = '';
    if (st.view === 'actuation') val.textContent = s.actuation.toFixed(2);
    else if (st.view === 'rt') val.textContent = s.rapidTrigger ? `${s.rtPress.toFixed(2)}/${s.rtRelease.toFixed(2)}` : 'off';
    else val.textContent = '';
    el.style.background = 'var(--cap)';
    // Value bar: length = actuation depth, so shallow keys show a short bar.
    const bar = $('.bar', el);
    bar.style.width = ['actuation', 'rt'].includes(st.view) ? `${Math.min(s.actuation / 3.4, 1) * 100}%` : '0';
    bar.classList.toggle('off', st.view === 'rt' && !s.rapidTrigger);
    $('.mark', el).style.top = `${(s.actuation / FULL_TRAVEL_MM) * 100}%`;
  }
  $('#keyboard').classList.toggle('view-travel', st.view === 'travel');
}

// Click toggles; dragging paints the state of the first key across others.
function bindSelection(kbEl) {
  let painting = null;
  kbEl.onpointerdown = (e) => {
    const el = e.target.closest('.key[data-slot]');
    if (!el) return;
    const slot = Number(el.dataset.slot);
    if (view()?.keyDown?.(slot, e)) { painting = 'module'; return; }
    if (!view()?.multiSelect && !['actuation', 'rt'].includes(st.view)) return;
    painting = !st.selected.has(slot);
    setSelected(slot, painting);
  };
  kbEl.onpointerover = (e) => {
    if (painting === null) return;
    const el = e.target.closest('.key[data-slot]');
    if (!el) return;
    if (painting === 'module') { view()?.keyDrag?.(Number(el.dataset.slot)); return; }
    setSelected(Number(el.dataset.slot), painting);
  };
  window.onpointerup = () => { painting = null; };
}

function setSelected(slot, on) {
  if (on) st.selected.add(slot); else st.selected.delete(slot);
  onSelectionChange();
}

function pick(kind) {
  st.selected.clear();
  if (kind !== 'none') {
    for (const [slot, el] of keyEls) {
      if (kind === 'all' || window.GROUPS[kind](el.dataset.name)) st.selected.add(slot);
    }
  }
  onSelectionChange();
}

function onSelectionChange() {
  paintKeys();
  const n = st.selected.size;
  $('#sel-count').textContent = n === 1 ? '1 key selected' : `${n} keys selected`;
  fillSwitchForm();
  view()?.selection?.();
}

// ---- switches form ----------------------------------------------------------
// Edits stay while the selection changes; Save writes them to every selected key.

let switchTracker;
const mmText = (v) => `${Number(v).toFixed(2)} mm`;

function fillSwitchForm() {
  const f = $('#switch-form');
  const slots = [...st.selected].filter((s) => st.switches[s]);
  for (const name of SWITCH_FIELDS) {
    const out = $(`output[data-for=${name}]`, f);
    const label = f.elements[name].closest('label');
    label.classList.toggle('changed', st.dirty.has(name));
    if (st.dirty.has(name)) { out.textContent = mmText(f.elements[name].value); continue; }
    const vals = [...new Set(slots.map((s) => st.switches[s][name]))];
    if (vals.length) f.elements[name].value = vals[0];
    out.textContent = !vals.length ? '–' : vals.length > 1 ? 'mixed' : mmText(vals[0]);
    label.classList.toggle('mixed', vals.length > 1);
  }
  for (const name of ['rapidTrigger', 'continuousRt']) {
    const el = f.elements[name];
    el.closest('label').classList.toggle('changed', st.dirty.has(name));
    if (st.dirty.has(name)) continue;
    const vals = [...new Set(slots.map((s) => Boolean(st.switches[s][name])))];
    el.checked = vals[0] ?? false;
    el.indeterminate = vals.length > 1;
  }
  switchTracker?.setReady(slots.length > 0, 'Select keys on the board to change them.');
  $('#switch-note').textContent = slots.length
    ? `Changes apply to the ${slots.length === 1 ? 'selected key' : `${slots.length} selected keys`}.` : 'Select keys on the board (drag across keys to select many, or use the quick picks).';
}

function bindSwitchForm() {
  const f = $('#switch-form');
  f.addEventListener('input', (e) => {
    const { name, value, type } = e.target;
    if (!name) return;
    st.dirty.add(name);
    e.target.indeterminate = false;
    e.target.closest('label').classList.add('changed');
    e.target.closest('label').classList.remove('mixed');
    if (type === 'range') $(`output[data-for=${name}]`, f).textContent = mmText(value);
  });
  // writes [slot, values] pairs, keys with the same values in one request (undo / redo)
  async function writeSwitches(pairs) {
    const groups = new Map();
    for (const [slot, v] of pairs) {
      const k = JSON.stringify(v);
      if (!groups.has(k)) groups.set(k, { ...v, slots: [] });
      groups.get(k).slots.push(slot);
    }
    for (const body of groups.values()) st.switches = (await api('POST', '/api/switches', body)).switches;
    switchTracker.clear();
    st.dirty.clear();
    paintKeys();
    fillSwitchForm();
  }
  switchTracker = App.ui.track(f, {
    async save() {
      const body = { slots: [...st.selected] };
      for (const name of st.dirty) {
        body[name] = f.elements[name].type === 'checkbox' ? f.elements[name].checked : Number(f.elements[name].value);
      }
      const fields = Object.keys(body).filter((k) => k !== 'slots');
      const pick = (src) => Object.fromEntries(fields.map((k) => [k, src?.[k]]));
      const before = body.slots.map((s) => [s, pick(st.switches[s])]);
      st.switches = (await api('POST', '/api/switches', body)).switches;
      st.dirty.clear();
      paintKeys();
      fillSwitchForm();
      const n = body.slots.length;
      App.history?.push({ label: `${fields.join(', ')} on ${n} key${n === 1 ? '' : 's'}`,
        undo: () => writeSwitches(before), redo: () => writeSwitches(body.slots.map((s) => [s, pick(body)])) });
    },
    discard() { st.dirty.clear(); fillSwitchForm(); },
  });
}

// ---- lighting form ----------------------------------------------------------

let lightTracker;

function fillLightForm(l) {
  const f = $('#light-form');
  f.elements.mode.value = l.mode;
  syncOptionRow(l.option);
  f.elements.brightness.value = l.brightness;
  f.elements.speed.value = l.speed;
  syncLightOutputs();
  const hex = (v) => v.toString(16).padStart(2, '0');
  f.elements.color.value = `#${hex(l.r)}${hex(l.g)}${hex(l.b)}`;
  f.elements.presetColour.value = l.presetColour ?? 0;
  f.elements.colourKind.value = l.rainbow ? 'rainbow' : l.presetColour !== null ? 'preset' : 'custom';
}

function syncLightOutputs() {
  const f = $('#light-form');
  $('output[data-for=brightness]', f).textContent = BRIGHTNESS[f.elements.brightness.value];
  $('output[data-for=speed]', f).textContent = SPEED[f.elements.speed.value];
}

function syncOptionRow(value) {
  const f = $('#light-form');
  $('#effect-info').textContent = App.effectInfo?.(Number(f.elements.mode.value), st.info?.custom) ?? '';
  const mode = MODES.find((m) => m[0] === Number(f.elements.mode.value));
  const opts = Array.isArray(mode?.[2]) ? mode[2] : null;
  $('#option-row').hidden = !opts;
  f.elements.option.innerHTML = '';
  (opts || []).forEach((label, i) => f.elements.option.add(new Option(label, i)));
  if (opts) f.elements.option.value = Math.min(value ?? 0, opts.length - 1);
}

// preset buttons (effect-presets.js): only effects this firmware offers; a click fills the form
function drawLightPresets() {
  const f = $('#light-form');
  const formColour = () => { const v = parseInt(f.elements.color.value.slice(1), 16); return { r: v >> 16, g: (v >> 8) & 255, b: v & 255 }; };
  App.effectPresets?.render($('#light-presets'), [...f.elements.mode.options].map((o) => o.value), formColour,
    (l) => { fillLightForm(l); lightTracker.mark(); });
}

function bindLightForm() {
  const f = $('#light-form');
  const builtIn = Object.assign(document.createElement('optgroup'), { label: 'Built-in effects' });
  MODES.forEach(([n, label]) => builtIn.append(new Option(label, n)));
  f.elements.mode.append(builtIn);
  PRESETS.forEach((label, i) => f.elements.presetColour.add(new Option(label, i)));
  f.elements.mode.addEventListener('change', () => syncOptionRow(0));
  f.addEventListener('input', (e) => {
    if (['brightness', 'speed'].includes(e.target.name)) syncLightOutputs();
    if (e.target.name === 'color') f.elements.colourKind.value = 'custom';
    if (e.target.name === 'presetColour') f.elements.colourKind.value = 'preset';
  });
  App.recentColours?.mount($('.colours', f), f.elements.color, 'light');
  drawLightPresets();
  window.addEventListener('statechange', drawLightPresets);   // open-firmware effects arrive with the state
  lightTracker = App.ui.track(f, {
    note: 'The keys above preview it; the keyboard shows it after Save.',
    async save() {
      const body = {
        mode: Number(f.elements.mode.value),
        brightness: Number(f.elements.brightness.value),
        speed: Number(f.elements.speed.value),
        option: $('#option-row').hidden ? 0 : Number(f.elements.option.value),
      };
      const kind = f.elements.colourKind.value;
      if (kind === 'rainbow') body.rainbow = true;
      else if (kind === 'preset') body.presetColour = Number(f.elements.presetColour.value);
      else body.color = f.elements.color.value.slice(1);
      const before = st.lighting;
      st.lighting = (await api('POST', '/api/lighting', body)).lighting;
      if (body.color) App.recentColours?.push('light', `#${body.color}`);
      fillLightForm(st.lighting);
      // undo / redo send a lighting state as a full request again
      const asBody = (l) => ({ mode: l.mode, brightness: l.brightness, speed: l.speed, option: l.option,
        ...(l.rainbow ? { rainbow: true } : l.presetColour !== null && l.presetColour !== undefined ? { presetColour: l.presetColour }
          : { color: [l.r, l.g, l.b].map((v) => v.toString(16).padStart(2, '0')).join('') }) });
      const write = async (b) => { st.lighting = (await api('POST', '/api/lighting', b)).lighting; fillLightForm(st.lighting); lightTracker.clear(); };
      if (before) App.history?.push({ label: 'lighting', undo: () => write(asBody(before)), redo: () => write(body) });
    },
    discard() { fillLightForm(st.lighting); },
  });
}

// ---- live travel ------------------------------------------------------------

let travelSource = null;

function setTravel(on) {
  if (travelSource) { travelSource.close(); travelSource = null; }
  for (const el of keyEls.values()) { $('.fill', el).style.height = '0'; el.classList.remove('down'); }
  if (!on) return;
  travelSource = new EventSource('/api/travel');
  travelSource.onmessage = (e) => {
    const { slot, mm } = JSON.parse(e.data);
    const el = keyEls.get(slot);
    if (!el) return;
    $('.fill', el).style.height = `${Math.min(mm / FULL_TRAVEL_MM, 1) * 100}%`;
    $('.val', el).textContent = mm ? mm.toFixed(2) : '';
    el.classList.toggle('down', mm >= (st.switches[slot]?.actuation ?? Infinity));
  };
  travelSource.addEventListener('error', (e) => {
    if (e.data) toast(`Live depth: ${JSON.parse(e.data)}`, true);
  });
}

// ---- header -----------------------------------------------------------------

function drawProfiles() {
  const box = $('#profiles');
  box.innerHTML = '<span class="muted">Profile</span>';
  for (let p = 0; p < 4; p++) {
    const b = document.createElement('button');
    const meta = App.profileMeta?.onboard?.[p];   // names and colours from My profiles (my-profiles.js)
    b.textContent = meta?.name ?? `Profile ${p + 1}`;
    if (meta?.color) b.style.setProperty('--profile-color', meta.color);
    b.className = p === st.profile ? 'on' : '';
    b.setAttribute('aria-pressed', p === st.profile);
    b.onclick = () => {
      if (p === st.profile || !App.ui.confirmLeave()) return;
      busy(box, `Switching to profile ${p + 1}…`, async () => {
        applyState(await api('POST', '/api/profile', { profile: p }));
        toast(`Profile ${p + 1}: every page now shows its settings`);
      });
    };
    box.append(b);
  }
}

// Pages that need the open firmware (data-open-fw, data-api = minimum host API).
function pageReason(id) {
  const b = $(`nav button[data-view="${id}"]`);
  if (!b?.hasAttribute('data-open-fw')) return null;
  const ok = (st.features ?? []).includes('optionsLayers') && (st.hostApi ?? 0) >= Number(b.dataset.api ?? 1);
  return ok ? null : App.ui.firmwareReason(b.textContent.trim());
}

function applyState(s) {
  Object.assign(st, { keys: s.keys, switches: s.switches, lighting: s.lighting, profile: s.profile,
    fn: new Map(s.fn.map((x) => [x.slot, x.name])), pollingRateHz: s.pollingRateHz, functions: s.functions, keyNames: s.keyNames ?? [],
    info: s.info, options: s.options, memory: s.memory ?? null,
    layers: (s.layers ?? [[], [], []]).map((l) => new Map(l.map((x) => [x.slot, x.name]))), fwOptions: s.fwOptions,
    openModes: s.openModes ?? {}, features: s.features ?? [], hostApi: s.hostApi ?? 0,
    fnLayers: (s.fnLayers ?? [[], [], []]).map((l) => new Map(l.map((x) => [x.slot, x.name]))) });
  // open-firmware pages stay clickable; the page itself says what it needs
  $$('nav button[data-open-fw]').forEach((b) => b.classList.toggle('needs-fw', Boolean(pageReason(b.dataset.view))));
  const modeSel = $('#light-form').elements.mode;
  $$('optgroup[data-open]', modeSel).forEach((o) => o.remove());
  if (Object.keys(st.openModes).length) {
    const g = Object.assign(document.createElement('optgroup'), { label: 'Open firmware effects' });
    g.dataset.open = 1;
    Object.entries(st.openModes).forEach(([n, label]) => {
      g.append(new Option(`${label}${App.isAnalogEffect?.(Number(n)) ? ' (reacts to press depth)' : ''}`, Number(n)));
    });
    modeSel.append(g);
  }
  App.fillFirmware?.(s.fwOptions);
  App.fillChoices?.();
  App.fillDevice?.();
  window.LAYOUT = window.LAYOUTS[s.info.model] ?? window.LAYOUTS.max68he;
  $('#model-name').textContent = s.info.modelName ?? 'MAX68HE';
  $('#board').textContent = `${s.info.model === 'x82he' ? '' : 'X68MAX · '}fw ${fwText()}${s.info.custom ? ' (open)' : ''}`;
  window.MemBar?.render($('#mem-bar'), s.memory, s.info.custom);
  // continuous RT exists only on the open firmware
  App.ui.gate($('#cont-rt'), s.info.custom ? null : App.ui.firmwareReason('Continuous rapid trigger'));
  setConnected(true);
  drawProfiles();
  drawKeyboard();
  fillLightForm(s.lighting);
  lightTracker?.clear();
  onSelectionChange();
  showPage();
  window.dispatchEvent(new Event('statechange'));   // overview.js redraws its cards
}

// Views that share a sidebar page (tabs, the Remap layer row) share its title.
const TITLES = {
  quick: 'Quick settings', profiles: 'My profiles',
  actuation: 'Actuation point', rt: 'Rapid trigger', travel: 'Analog view', keymap: 'Remap', fn: 'Remap',
  layers: 'Remap', stats: 'Key stats',
  analog: 'Gamepad', wizard: 'Key wizard', advanced: 'Advanced keys', macros: 'Advanced keys', texts: 'Advanced keys', lighting: 'RGB settings', paint: 'RGB settings',
  fwopts: 'Firmware', features: 'Firmware', updates: 'Firmware',
  settings: 'General settings', interface: 'Interface',
};

const HINTS = {
  actuation: 'How far a key goes down before it types. Select keys on the board (drag across keys to select many, or use the quick picks), set the values below, then Save. A short bar on a key means it fires early.',
  rt: 'With rapid trigger a key fires again as soon as it moves back up a little, instead of at a fixed point: great for fast repeated presses. Select keys, switch it on, set how far a key must move, then Save. Keys show press / release sensitivity.',
  travel: 'Press keys: the fill shows how far each key is down, live, and the white line is its actuation point. Nothing here changes settings.',
  stats: 'How often each key was pressed since the keyboard was plugged in. Stronger colours were pressed more.',
  analog: 'Turn keys into gamepad sticks, triggers and buttons: the deeper you press, the further the stick moves. Click a key to bind it; press keys to see the controller move.',
  wizard: 'Per key, say what happens at which depth or after how long it is held: keys, gamepad and mouse. Click a key, pick a starting point and answer the questions.',
  keymap: 'Click a key to choose what it sends. Highlighted keys send something other than their label.',
  fn: 'What each key does while Fn is held. There are four Fn layers: on the keyboard Fn + Home / Del / PgUp / PgDn picks which one Fn uses. Keys left empty do what they do without Fn. Click a key to change it.',
  layers: 'Three extra keymaps you reach with layer keys: put MO1-3 (held) or TG1-3 (switch on and off) on a key in Remap. Keys left empty here do what the layer below does. Click a key to change it.',
  advanced: 'Give a key extra behaviour: snap tap (two keys cancel each other), mod-tap (one key on tap, another on hold), toggle, or dynamic keystroke (different keys at different depths). Click a key to start.',
  macros: 'A macro types a piece of text for you. Store it in one of 16 slots here, then put it on a key.',
  texts: 'Strings the keyboard types by itself when you press a text key, with no app running. Write them here, Save, then put TextN on any key (Remap, an Fn layer or a layer).',
  lighting: 'Pick an effect and its colour. The keys above preview it as you press them; the keyboard shows it after you Save.',
  paint: 'Paint keys in your own colours and keep up to five pictures. Click or drag across keys to paint; Save sends the picture to the keyboard and shows it.',
  quick: 'The settings you change most, at a glance. Click a card to open its page.',
  profiles: 'The keyboard keeps four profiles on board; the active one is what every page shows and edits. Back one up to a file or load one from a file.',
  settings: 'Polling rate, keyboard options, key calibration and speed.',
  fwopts: 'What the open firmware does on its own: indicators, idle lighting, how text keys type, the hold bar and mode flashes. Saved on the keyboard.',
  features: 'Which parts of the open firmware a custom build has. Switch off what you don\'t use, see what it frees, then build and flash it.',
  updates: 'Put new firmware on the keyboard, or go back to the stock firmware.',
  interface: 'How this page looks and which extra pages it shows. Nothing here changes the keyboard.',
  'wizard:code': 'Describe the keyboard in a short script: keys, actuation, layers, lighting, macros, key actions. Check shows what would change; Apply writes it. Click a key on the board to put its name in the script.',
};

// ---- pages --------------------------------------------------------------------

function showPage() {
  $('#hint').textContent = HINTS[`${st.view}:${document.body.dataset.kw}`] ?? HINTS[st.view] ?? '';   // 'wizard:code': a tab's own hint
  $('#page-title').textContent = TITLES[st.view] ?? st.view;
  const model = st.info?.modelName ?? 'MAX68HE';
  document.title = `${TITLES[st.view] ?? model} · ${model}`;
}

function goto(id) {
  const b = $(`nav button[data-view="${id}"]`);
  if (!b || id === st.view) return true;
  if (!App.ui.confirmLeave()) return false;
  App.ui.closePicker();
  // a view shown as a tab (data-sub) lights its page's button (data-also)
  const page = b.hasAttribute('data-sub') ? $$('nav button[data-also]').find((x) => x.dataset.also.split(' ').includes(id)) ?? b : b;
  $$('nav button[data-view]').forEach((x) => { x.classList.toggle('on', x === page); x.setAttribute('aria-current', x === page ? 'page' : 'false'); });
  $$('[data-goto]').forEach((x) => x.classList.toggle('on', x.dataset.goto === id));
  st.view = id;
  document.body.dataset.view = st.view;
  setTravel(st.view === 'travel');
  showPage();
  if (!SELECTING.includes(st.view)) st.selected.clear();                       // this page doesn't select keys
  else if (!['actuation', 'rt'].includes(st.view) && !view()?.multiSelect && st.selected.size > 1) st.selected.clear();
  onSelectionChange();
  window.dispatchEvent(new CustomEvent('pagechange', { detail: id }));
  return true;
}

function bindViewButton(b) {
  b.onclick = () => goto(b.dataset.view);
}

async function init() {
  document.body.dataset.view = st.view;
  Object.values(window.App.views || {}).forEach((v) => v.init?.());
  bindSwitchForm();
  bindLightForm();
  $$('[data-pick]').forEach((b) => { b.onclick = () => pick(b.dataset.pick); });
  // Only the view buttons: <body> carries data-view too, for the panel CSS.
  $$('nav button[data-view]').forEach(bindViewButton);
  $$('[data-goto]').forEach((b) => { b.onclick = () => goto(b.dataset.goto); });
  $('#reconnect').onclick = () => busy($('#status'), 'Looking for the keyboard…', async () => {
    applyState(await api('GET', '/api/state'));
    toast('Keyboard connected');
  });
  showPage();
  try {
    applyState(await api('GET', '/api/state'));
  } catch (e) {
    $('#board').textContent = 'not connected';
    $('#mem-bar').hidden = true;
    setConnected(false, e.message);
    toast(e.message, true);
  }
  loadKeyboards();
  window.addEventListener('focus', loadKeyboards);   // one plugged in meanwhile
  loadPlugins();
}

// ---- keyboard switcher (shown when more than one supported keyboard is plugged in) ----

async function loadKeyboards() {
  let r;
  try { r = await api('GET', '/api/keyboards'); } catch { return; }
  const sel = $('#kb-pick');
  sel.replaceChildren(...r.keyboards.map((k) => new Option(k.name, k.key)));
  sel.value = r.selected ?? '';
  sel.hidden = r.keyboards.length < 2;
  sel.onchange = async () => {
    if (!App.ui.confirmLeave()) { sel.value = r.selected ?? ''; return; }
    try {
      await api('POST', '/api/keyboard', { key: sel.value });
      location.reload();   // every page reloads its data from the other keyboard
    } catch (e) {
      sel.value = r.selected ?? '';
      toast(e.message, true);
    }
  };
}

// ---- plugins (optional features shipped in plugins/<name>/, see src/plugins.js) ----

// A plugin page: nav button after `after`, title and hint; its panels carry data-views="<id>".
function addView({ id, label, icon = '•', after, title = label, hint = '', board = true }) {
  const b = Object.assign(document.createElement('button'), { innerHTML: `<span class="ico">${icon}</span>${label}` });
  b.dataset.view = id;
  const ref = after && $(`nav button[data-view="${after}"]`);
  if (ref) ref.after(b); else $('nav').append(b);
  bindViewButton(b);
  TITLES[id] = title; HINTS[id] = hint;
  const css = document.createElement('style');
  css.textContent = `body[data-view="${id}"] [data-views]:not([data-views~="${id}"]) { display: none !important; }`
    + (board ? '' : `body[data-view="${id}"] .board-wrap { display: none; } body[data-view="${id}"] .hint { margin-bottom: 0; }`);
  document.head.append(css);
  return b;
}

async function loadPlugins() {
  let list = [];
  try { list = await api('GET', '/api/plugins'); } catch { return; }
  for (const p of list) {
    for (const href of p.styles ?? []) document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href }));
    for (const src of p.scripts ?? []) document.body.append(Object.assign(document.createElement('script'), { src }));
  }
}

// Shared with the feature modules (keymap.js, paint.js, macros.js…).
window.App = Object.assign(window.App || {}, {
  st, keyEls, api, toast, busy, paintKeys, applyState, onSelectionChange, $, $$, addView, goto, pageReason, fwText, drawProfiles, showPage,
});

init();
