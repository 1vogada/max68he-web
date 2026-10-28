// Features page: every switchable part of the open firmware (x68max-firmware firmware/features.json,
// GET /api/firmware/features) as a switch, grouped, with what it costs, what it needs, and a
// warning when something in use would stop working. Two bars: the running firmware's memory
// report and the projected size of the choice (features.json sizes − costs; else a measured
// build). Building and flashing are the firmware builder's (fw-builder.js, below the list).
// Pure logic in features-core.js.
(() => {
  const App = (window.App = window.App || {});
  App.views = App.views || {};
  const C = window.FeaturesCore;

  const panel = (id, cls, html) => {
    const p = Object.assign(document.createElement('section'), { className: cls, id, innerHTML: html });
    p.dataset.views = 'features';
    return p;
  };
  const meter = (id, label) => `<div class="fwb-meter" id="${id}"><div class="fwb-head"><span>${label}</span><span class="fwb-num">?</span></div>
    <div class="fwb-bar"><span></span></div></div>`;

  const bars = panel('feat-bars', 'panel wide', `
    <h2>Memory</h2>
    <div class="feat-bars">
      <div><h3>Now on the keyboard</h3>${meter('feat-cur-flash', 'Flash')}${meter('feat-cur-ram', 'RAM')}<p class="muted small" id="feat-cur-note"></p></div>
      <div><h3>With these switches <span class="chip" id="feat-proj-chip">estimate</span></h3>${meter('feat-proj-flash', 'Flash')}${meter('feat-proj-ram', 'RAM')}
        <p class="muted small" id="feat-proj-note"></p></div>
    </div>`);

  const list = panel('feat-list', 'panel wide', `
    <h2>Features <span class="chip" id="feat-chip">…</span></h2>
    <p class="muted small">Switch off what you don't use: it frees flash and RAM for a custom build. Settings a feature stores stay on the keyboard
      when a build leaves it out, so switching it back on later finds them. Nothing changes until you build and flash.</p>
    <p class="small" id="feat-reason" hidden></p>
    <div id="feat-warn" class="gate" hidden></div>
    <p class="small muted" id="feat-dep" hidden></p>
    <div class="feat-tools row-buttons">
      <label class="row small">Sort <select id="feat-sort"></select></label>
      <input type="search" id="feat-filter" placeholder="Filter features…" aria-label="Filter features">
      <label class="row small"><input type="checkbox" id="feat-offonly"> Only switched off</label>
    </div>
    <div id="feat-groups"></div>
    <div class="row-buttons"><button type="button" id="feat-all">All on</button></div>
    <details id="feat-always" hidden><summary>Always on (not switchable)</summary><ul class="small"></ul></details>`);

  let manifest = null, state = {}, use = {}, web = false, measureSeq = 0, measureTimer = 0, loading = null;
  const $ = (s) => document.querySelector(s);

  function fill(el, b) {
    el.dataset.level = b ? b.level : '';
    el.querySelector('.fwb-num').textContent = b ? b.text : '?';
    el.querySelector('.fwb-bar span').style.width = b ? `${Math.min(100, b.pct).toFixed(1)}%` : '0';
  }

  function showCurrent() {
    const cur = C.currentBars(App.st.memory);
    fill($('#feat-cur-flash'), cur?.[0]);
    fill($('#feat-cur-ram'), cur?.[1]);
    $('#feat-cur-note').textContent = cur ? 'The running firmware\'s own memory report (RAM = static data + the stack / heap floor).'
      : App.st.info?.custom ? 'This firmware does not report its memory use (needs a newer open firmware).'
        : App.st.info ? 'The stock firmware does not report its memory use.' : 'Keyboard not connected.';
  }

  // estimate from features.json; without one a real (cached) build of the choice measures it
  function showProjected() {
    const p = manifest ? C.projection(manifest, state) : { known: false, why: 'no feature list' };
    if (p.known) {
      const b = C.bars(p.flash, p.ram, p.limits);
      fill($('#feat-proj-flash'), b[0]);
      fill($('#feat-proj-ram'), b[1]);
      $('#feat-proj-chip').textContent = 'estimate';
      $('#feat-proj-note').textContent = `Estimate from the sizes measured on firmware ${manifest.sizes.commit ?? '?'}: ${C.kb(p.freed.flash)} flash and `
        + `${C.kb(p.freed.ram)} RAM freed. The build reports the real numbers.`;
      return;
    }
    fill($('#feat-proj-flash'), null);
    fill($('#feat-proj-ram'), null);
    $('#feat-proj-chip').textContent = 'size unknown';
    if (!manifest || web) { $('#feat-proj-note').textContent = web ? 'Building needs the desktop app.' : ''; return; }
    $('#feat-proj-note').textContent = `No estimate (${p.why}). Measuring this choice (builds it once, a few seconds)…`;
    clearTimeout(measureTimer);
    measureTimer = setTimeout(measure, 400);
  }
  async function measure() {
    const n = ++measureSeq;
    try {
      const r = await App.api('POST', '/api/firmware/size', { flags: { ...state } });
      if (n !== measureSeq) return;
      showMeasured(r);
    } catch (e) { if (n === measureSeq) $('#feat-proj-note').textContent = `Could not measure: ${e.message}`; }
  }
  // a real build's size report (the measuring above, or a finished build)
  function showMeasured(r) {
    const b = C.bars(r.flash.used, r.ram.used, { flash: r.flash.limit, ram: r.ram.limit });
    fill($('#feat-proj-flash'), b[0]);
    fill($('#feat-proj-ram'), b[1]);
    $('#feat-proj-chip').textContent = 'measured';
    $('#feat-proj-note').textContent = `Measured by building this choice (RAM includes ${C.kb(r.ram.reserved ?? 0)} for the stack).`;
  }

  // the toolbar's choices; the sort is remembered in this browser
  const SORT_KEY = 'max68he.featuresSort';
  const opts = () => ({ sort: $('#feat-sort')?.value || 'use', filter: $('#feat-filter')?.value ?? '', offOnly: Boolean($('#feat-offonly')?.checked) });

  function renderRows() {
    const box = $('#feat-groups');
    box.textContent = '';
    const o = opts();
    const sections = C.view(manifest.features, o, use, state);
    if (!sections.length) box.append(Object.assign(document.createElement('p'), { className: 'muted small', textContent: 'No feature matches.' }));
    for (const g of sections) {
      const sec = document.createElement('div');
      sec.className = 'feat-group';
      if (g.label) sec.append(Object.assign(document.createElement('h3'), { textContent: g.label }));
      for (const f of g.features) {
        const row = document.createElement('label');
        row.className = 'toggle fwb-feat feat-row';
        row.innerHTML = '<input type="checkbox"><span class="switch"></span><span class="fwb-text"><span class="feat-top"><b></b>'
          + '<span class="feat-cost"></span></span><span class="muted small feat-desc"></span><span class="muted small feat-rel"></span></span>';
        const cb = row.querySelector('input');
        cb.checked = state[f.id] !== false;
        cb.disabled = web;
        cb.dataset.id = f.id;
        const used = C.inUse(f, use);   // a tag when the sort doesn't already say it
        row.querySelector('b').textContent = f.name + (o.sort !== 'use' ? (used ? ' · in use' : used === null ? ' · ?' : '') : '');
        row.querySelector('.feat-cost').textContent = C.costText(f, cb.checked);
        row.querySelector('.feat-desc').textContent = `${f.description}${f.storage && f.storage !== 'none' ? ` ${f.storage}` : ''}`;
        row.querySelector('.feat-rel').textContent = C.relations(manifest.features, f);
        row.classList.toggle('off', !cb.checked);
        cb.onchange = () => flip(f.id, cb.checked);
        sec.append(row);
      }
      box.append(sec);
    }
  }

  function showWarnings() {
    const w = C.warnings(manifest?.features ?? [], state, use);
    const el = $('#feat-warn');
    el.hidden = !w.length;
    el.replaceChildren(Object.assign(document.createElement('b'), { textContent: 'In use, stops working in this build (the data stays stored):' }),
      ...w.map((x) => { const p = document.createElement('div'); p.textContent = `${x.name}: ${x.text}`; return p; }));
  }

  function changed() {
    renderRows();
    showWarnings();
    showProjected();
    const off = manifest.features.filter((f) => state[f.id] === false).length;
    $('#feat-chip').textContent = off ? `${off} of ${manifest.features.length} off` : `${manifest.features.length} features`;
    App.fwBuilder?.changed();
  }

  function flip(id, on) {
    const r = C.toggle(manifest.features, state, id, on);
    state = r.state;
    const note = C.dependencyNote(manifest.features, r.changed, on);
    $('#feat-dep').hidden = !note;
    $('#feat-dep').textContent = note;
    changed();
  }

  // ---- what is in use (existing APIs; each one that fails just gives no warning) -----------
  const count = (maps) => (maps ?? []).reduce((a, m) => a + (m?.size ?? 0), 0);
  const READERS = {
    text: async (u) => { u.textKeys = (await App.api('POST', '/api/texts')).texts.filter((t) => t).length; },
    sequence: async (u) => { u.sequencePlaying = Boolean((await App.api('GET', '/api/sequence/status')).playing); },
    keyact: async (u) => { Object.assign(u, C.useFromKeyActions(await App.api('GET', '/api/key-actions'))); },
    advkeys: async (u) => { Object.assign(u, C.useFromAdvanced((await App.api('POST', '/api/advanced/list')).keys)); },
    gamepad: async (u) => { const b = (await App.api('POST', '/api/gamepad/board/get')).board; u.gamepadBindings = b?.enabled ? b.bindings.length : 0; },
    calib: async (u) => { u.calibratedKeys = (await App.api('POST', '/api/calibration', { action: 'status' })).calibratedKeys ?? 0; },
    macros: async (u) => {
      let n = 0;
      for (let i = 0; i < 16; i++) { const m = await App.api('POST', '/api/macro/get', { index: i }); if (m.steps?.length) n++; }
      u.macros = n;
    },
  };
  READERS.text_typing = READERS.text;
  READERS.glide = READERS.mousekeys = READERS.mk_pressure = READERS.modes = READERS.keyact;
  READERS.dks = READERS.dks_levels = READERS.advkeys;

  // each answer shows as it comes (the 16 macro reads take a while), so "in use first" fills in
  async function readUse() {
    const st = App.st, u = {};
    use = u;
    if (Number.isInteger(st.lighting?.mode)) u.lightingMode = st.lighting.mode;
    const shown = () => { if (use !== u) return; showWarnings(); renderRows(); };
    shown();
    if (!st.info?.custom) return;
    u.userLayerKeys = count(st.layers);
    u.fnLayerKeys = count(st.fnLayers);
    shown();
    const fns = new Set(manifest.features.map((f) => READERS[f.id]).filter(Boolean));   // only for features this list has
    await Promise.allSettled([...fns].map((fn) => fn(u).then(shown)));
  }

  async function load() {
    const r = await App.api('GET', '/api/firmware/features');
    web = r.web === true;
    $('#feat-reason').hidden = r.available;
    if (!r.available) {
      $('#feat-reason').textContent = r.reason;
      $('#feat-chip').textContent = 'not available';
      fill($('#feat-proj-flash'), null); fill($('#feat-proj-ram'), null);
      $('#feat-proj-chip').textContent = 'size unknown';
      $('#feat-proj-note').textContent = r.reason;
      $('#feat-all').hidden = true;
      App.fwBuilder?.loaded(r);
      return;
    }
    manifest = { features: r.features, sizes: r.sizes ?? null, alwaysOn: r.alwaysOn ?? [] };
    state = C.defaults(manifest.features);
    if (r.job?.flags && (r.job.running || r.job.ok)) Object.assign(state, r.job.flags);   // the switches match the last build
    $('#feat-all').hidden = web;
    const always = $('#feat-always');
    always.hidden = !manifest.alwaysOn.length;
    always.querySelector('ul').replaceChildren(...manifest.alwaysOn.map((a) => {
      const li = document.createElement('li');
      li.textContent = a.reason ? `${a.name}: ${a.reason}` : a.name;
      return li;
    }));
    changed();
    App.fwBuilder?.loaded(r);
  }

  function init() {
    // the Firmware page's "Features & size" tab (nav and tabs in index.html)
    document.querySelector('.panels').append(bars, list);
    $('#feat-all').onclick = () => { state = C.defaults(manifest.features); $('#feat-dep').hidden = true; changed(); };
    const sort = $('#feat-sort');
    C.SORTS.forEach(([v, label]) => sort.add(new Option(label, v)));
    try { sort.value = localStorage.getItem(SORT_KEY) || 'use'; } catch { sort.value = 'use'; }
    if (!sort.value) sort.value = 'use';
    const redraw = () => { if (manifest) renderRows(); };
    sort.onchange = () => { try { localStorage.setItem(SORT_KEY, sort.value); } catch { /* storage off */ } redraw(); };
    $('#feat-filter').oninput = redraw;
    $('#feat-offonly').onchange = redraw;
    window.addEventListener('statechange', () => { if (App.st.view === 'features') showCurrent(); });
  }

  function selection() {
    if (App.st.view !== 'features') return;
    showCurrent();
    loading ??= load().catch((e) => { loading = null; $('#feat-reason').hidden = false; $('#feat-reason').textContent = e.message; });
    loading.then(() => { if (manifest) readUse(); });
  }

  App.views.featuresPage = { init };   // not 'features': App.views[view] is a view's own hooks
  App.features = { flags: () => ({ ...state }), available: () => Boolean(manifest) && !web, showMeasured };
  window.addEventListener('pagechange', selection);
})();
