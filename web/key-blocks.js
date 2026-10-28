// Key wizard page (view 'wizard'), tabs Wizard | Blocks | Modes | Code (Code: web/kb-code.js). Blocks: behaviours built like Scratch
// from generic blocks (Blockly, zelos renderer), compiled to key action rules (web/key-blocks-compile.js).
// Modes: name, delete and open the 3 modes. Blockly and the block code load only when Blocks or Modes
// first opens. The key action table is one for all profiles, so the workspace is kept once on the PC
// (GET / PUT /api/key-blocks, config/key-blocks.json; the web version keeps that file in browser
// storage); with none saved it is rebuilt from the keyboard's rules. Save all: mode names
// (POST /api/modes), the rules (POST /api/key-actions/batch), the workspace; undoable (App.history).
// While Blocks / Modes is open, the board's clicks and painting go here instead of the Wizard tab.
(() => {
  const App = (window.App = window.App || {});
  App.views = App.views || {};
  const $ = (s, el) => App.$(s, el);
  const FILES = ['vendor/blockly/blockly_compressed.js', 'vendor/blockly/msg/en.js', 'key-blocks-core.js', 'key-blocks-compile.js', 'key-blocks-defs.js', 'key-blocks-panels.js'];
  const STYLE_KEY = 'max68he.kwStyle';
  const blankModes = () => [1, 2, 3].map((id) => ({ id, name: '', active: false }));

  const S = {
    visible: false, ready: null, ws: null, B: null, loading: false, caps: false, why: '',
    modes: blankModes(), storedModes: blankModes(), maps: [], keyOpts: {}, storedWs: null,
    compiled: null, serverWarn: {}, armed: null, poll: null, recompileTimer: null,
  };
  let tracker;
  const C = () => App.keyBlocksCompile;
  const K = () => App.keyBlocksCore;
  const D = () => App.kbDefs;
  const P = () => App.kbPanels;

  // ---- Wizard | Blocks | Modes | Code ----------------------------------------------------------------

  const TABS = ['wizard', 'blocks', 'modes', 'code'];
  const style = () => (TABS.includes(document.body.dataset.kw) ? document.body.dataset.kw : 'wizard');
  const ours = () => App.st.view === 'wizard' && (style() === 'blocks' || style() === 'modes');   // the board belongs to Blocks / Modes
  const code = () => App.st.view === 'wizard' && style() === 'code' && App.kbCode;                // … or to Code
  function markTabs(next) {
    App.$$('#kw-style [data-kw]').forEach((b) => { b.classList.toggle('on', b.dataset.kw === next); b.setAttribute('aria-pressed', b.dataset.kw === next); });
  }
  function setStyle(next, { force = false } = {}) {
    if (next === style() && !force) return;
    if (!force && !App.ui.confirmLeave()) return;
    document.body.dataset.kw = next;
    try { localStorage.setItem(STYLE_KEY, next); } catch { /* storage off */ }
    markTabs(next);
    const on = App.st.view === 'wizard';
    wizardShown(on && next === 'wizard');
    shown(on && (next === 'blocks' || next === 'modes'));
    App.kbCode?.shown(on && next === 'code');
    App.showPage?.();                                  // the hint can depend on the tab
    if (on) App.paintKeys();
  }

  // ---- loading ---------------------------------------------------------------------------------

  const loadScript = (src) => new Promise((res, rej) => {
    const s = Object.assign(document.createElement('script'), { src });
    s.onload = res;
    s.onerror = () => rej(new Error(`could not load ${src}${src.startsWith('vendor/') ? ' (run npm install: it copies Blockly into web/vendor)' : ''}`));
    document.body.append(s);
  });
  function boot() {
    S.ready ??= (async () => {
      const t0 = performance.now();
      $('#kb-status').textContent = 'Loading the blocks…';
      for (const f of FILES) await loadScript(f);   // in order: Blockly, its messages, then the code that uses it
      S.B = window.Blockly;
      D().install(S.B, { keys: boardKeys, modes: () => S.modes, arm });
      S.ws = S.B.inject($('#kb-ws'), {
        renderer: 'zelos', theme: D().theme(S.B), toolbox: D().toolbox(S.modes, { flash: hasFlash() }), media: 'vendor/blockly/media/', sounds: false, trashcan: true,
        zoom: { controls: true, wheel: false, pinch: true, startScale: innerWidth < 700 ? 0.6 : 0.75 }, move: { scrollbars: true, drag: true, wheel: true },
      });
      S.ws.registerButtonCallback('kbMakeMode', () => P().makeMode(api));
      S.ws.registerButtonCallback('kbRenameMode', () => P().focusRename());
      S.ws.addChangeListener(onWsChange);
      window.addEventListener('themechange', () => S.ws.setTheme(D().theme(S.B)));
      window.addEventListener('resize', () => S.B.svgResize(S.ws));
      App.kbLoadMs = Math.round(performance.now() - t0);
      await reload();
    })().catch((e) => { S.ready = null; $('#kb-status').textContent = e.message; App.ui.showError($('#kb-panel'), e.message); throw e; });
    return S.ready;
  }

  // the keyboard has the hold bar flash (caps 'modeFlash'): the Lights blocks, no warning on a flash block
  const hasFlash = () => (App.st.features ?? []).includes('modeFlash');
  const boardKeys = () => [...App.keyEls.values()].map((el) => el.dataset.name).filter(Boolean);
  const engineOf = (r) => (typeof r.engine === 'number' ? r.engine : r.engine?.version ?? 0);
  const modesOf = (list) => blankModes().map((m) => ({ ...m, ...(list ?? []).find((x) => x.id === m.id) }));

  // what the keyboard has now: rules, mode names, engine; and the saved workspace (or one rebuilt)
  async function reload({ keepWorkspace = false } = {}) {
    const feats = App.st.features ?? [];
    let r = { maps: [], modes: [] };
    S.caps = false;
    if (feats.includes('keyActions')) {
      // a read can fail while another program talks to the keyboard: try once more, and a failed
      // read never makes the page say the firmware is too old (the caps say what it can do)
      const get = () => App.api('GET', '/api/key-actions');
      try {
        r = await get().catch(() => new Promise((res) => setTimeout(res, 400)).then(get));
        S.caps = engineOf(r) >= 2 || feats.includes('keyModes');
        S.engine = engineOf(r);
        App.ui.showError($('#kb-panel'), null);
      } catch (e) {
        S.caps = feats.includes('keyModes');
        App.ui.showError($('#kb-panel'), `Could not read the key action maps: ${e.message}. Reopen the tab to try again.`);
      }
    }
    S.why = S.caps ? '' : App.ui.firmwareReason('Key action blocks (modes, conditions, mouse keys)');
    App.ui.gate($('#kb-gate'), S.caps ? null : S.why);
    S.maps = r.maps ?? [];
    S.storedModes = modesOf(r.modes);
    S.modes = S.storedModes.map((m) => ({ ...m }));
    S.keyOpts = K().fromMaps(S.maps.filter(convertible), S.modes).keyOpts;
    D().allowKeys(S.maps.map((m) => m.key));
    if (!keepWorkspace) {
      S.storedWs = await loadWorkspace();
      const ws = S.storedWs ?? C().decompile(S.maps.filter(convertible), S.modes);
      show(ws, { arrange: !S.storedWs });
    } else P().drawModes(S, api);
    tracker.clear();
    $('#kb-status').textContent = S.storedWs ? 'Your saved blocks.' : S.maps.length ? 'Built from the rules on the keyboard.' : 'No blocks yet: drag some in from the left.';
    checkDrift();
    startPoll();
  }
  const convertible = (m) => { try { K().fromMaps([m], S.storedModes); return true; } catch { return false; } };

  // arrange: blocks rebuilt from the keyboard have no positions of their own, so tidy them up.
  // Loading and tidying run with Blockly's events off, so they never count as an edit (its events
  // would otherwise arrive a tick later, after any "loading" flag); the speed pictures are drawn by hand.
  function show(json, { arrange = false } = {}) {
    S.loading = true;
    S.B.Events.disable();
    try {
      S.ws.clear();
      collectKeys(json);
      S.B.serialization.workspaces.load(json, S.ws);
      if (arrange) S.ws.cleanUp();
      for (const b of S.ws.getAllBlocks(false)) if (b.type === 'kb_mouse_keys') b.onchange?.();
    } catch (e) { App.ui.showError($('#kb-panel'), `Could not show the saved blocks: ${e.message}`); }
    finally { S.B.Events.enable(); S.loading = false; }
    S.ws.updateToolbox(D().toolbox(S.modes, { flash: hasFlash() }));
    S.serverWarn = {};
    recompile();
    P().drawModes(S, api);
  }
  function collectKeys(json) {
    const walk = (b) => { if (!b) return; D().allowKeys([b.fields?.KEY, String(b.fields?.TARGET ?? '').replace(/^key:/, '')]); D().allowColours([b.fields?.COLOR]); Object.values(b.inputs ?? {}).forEach((i) => walk(i.block)); walk(b.next?.block); };
    (json?.blocks?.blocks ?? []).forEach(walk);
  }

  // the keyboard's rules no longer match the saved blocks (changed by the Questions view or an AI tool)
  function checkDrift() {
    const note = $('#kb-drift');
    if (!S.storedWs || !S.compiled) { note.hidden = true; return; }
    const norm = (maps) => JSON.stringify(K().toBatch(K().fromMaps(maps, S.storedModes).blocks, { modes: S.storedModes }).maps);
    let same = false;
    try { same = norm(S.maps) === JSON.stringify(C().compile(S.storedWs, { modes: S.storedModes }).batch().maps); } catch { same = false; }
    note.hidden = same;
  }

  async function loadWorkspace() {
    const local = 'max68he.keyBlocks';
    try { return (await App.api('GET', '/api/key-blocks')).workspace ?? null; } catch {
      try { return JSON.parse(localStorage.getItem(local) || 'null'); } catch { return null; }
    }
  }
  async function saveWorkspace(workspace) {
    try { await App.api('PUT', '/api/key-blocks', { workspace }); } catch {
      try { localStorage.setItem('max68he.keyBlocks', JSON.stringify(workspace)); } catch { /* storage off */ }
    }
  }

  // ---- compiling ---------------------------------------------------------------------------------

  function onWsChange(e) {
    if (S.loading || e.isUiEvent || e.type === S.B.Events.FINISHED_LOADING) return;
    if (e.type === S.B.Events.BLOCK_CHANGE && e.name === 'PLOT') return;   // the speed picture redrawing itself
    tracker.mark();
    clearTimeout(S.recompileTimer);
    S.recompileTimer = setTimeout(recompile, 120);
  }
  function recompile() {
    if (!S.ws) return null;
    const json = S.B.serialization.workspaces.save(S.ws);
    const r = C().compile(json, { modes: S.modes, engine: S.engine, flash: hasFlash() });
    for (const [id, msg] of Object.entries(S.serverWarn)) (r.warnings[id] ??= []).push(msg);
    for (const b of S.ws.getAllBlocks(false)) {
      const w = r.warnings[b.id]?.join('\n') ?? null;
      if ((b.getIcon?.('warning')?.getText?.() ?? null) !== w) b.setWarningText(w);
    }
    r.ok = Object.keys(r.warnings).length === 0;
    r.json = json;
    S.compiled = r;
    const n = Object.keys(r.warnings).length;
    $('#kb-warn').hidden = !n;
    $('#kb-warn').textContent = n ? `${n} block${n > 1 ? 's have' : ' has'} a warning (the red ⚠ on the block says why). Save stays off until they are fixed.` : '';
    $('#kb-count').textContent = `${r.blocks.length} rule${r.blocks.length === 1 ? '' : 's'}`;
    tracker.setReady(r.ok && S.caps, S.caps ? 'Fix the warnings first' : S.why);
    P().drawSummary(S);
    P().drawSlots(S);
    if (App.st.view === 'wizard' && S.visible) App.paintKeys();
    return r;
  }

  // ---- saving -------------------------------------------------------------------------------------

  const strip = (m) => ({ key: m.key, press: m.press, gap: m.gap, alsoType: m.alsoType, rules: m.rules });
  async function writeAll({ names, batch, workspace }) {
    for (const m of names) {
      const was = S.storedModes.find((x) => x.id === m.id);
      if ((was?.name ?? '') !== m.name) await App.api('POST', '/api/modes', { id: m.id, name: m.name });
    }
    if (batch.maps.length || batch.remove?.length) await App.api('POST', '/api/key-actions/batch', batch);
    await saveWorkspace(workspace);
  }

  async function save() {
    const r = recompile();
    if (!S.caps) throw new Error(S.why);
    if (!r.ok) throw new Error('Some blocks have a warning: fix them first (the red ⚠ on each says why)');
    const before = { names: S.storedModes.map((m) => ({ ...m })), maps: S.maps.map(strip), workspace: S.storedWs };
    const after = { names: S.modes.map((m) => ({ ...m })), batch: r.batch({ keyOpts: S.keyOpts, stored: S.maps.map((m) => m.key) }), workspace: r.json };
    S.serverWarn = {};
    try { await writeAll(after); } catch (e) { placeServerError(e.message, r); throw e; }
    await reload({ keepWorkspace: true });
    S.storedWs = after.workspace;
    checkDrift();
    const back = { names: before.names, batch: { maps: before.maps, remove: after.batch.maps.map((m) => m.key).filter((k) => !before.maps.some((m) => m.key === k)) }, workspace: before.workspace };
    if (!back.batch.remove.length) delete back.batch.remove;
    const redo = async () => { await writeAll(after); await reload(); };
    const undo = async () => { await writeAll(back); if (!back.workspace) await saveWorkspace(null); await reload(); };
    App.history?.push({ label: 'key action blocks', undo, redo });
  }

  // a refused batch: the message goes on the hat blocks of the key it names, if any
  function placeServerError(msg, r) {
    const keys = [...new Set(r.blocks.map((b) => b.key))].filter((k) => new RegExp(`(^|[^\\w])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w]|$)`).test(msg));
    for (const b of r.blocks.filter((x) => keys.includes(x.key))) S.serverWarn[b.hat] = `The keyboard refused this: ${msg}`;
    recompile();
  }

  // ---- board, modes, polling -----------------------------------------------------------------------

  function arm(field) {
    S.armed = field;
    const hint = $('#kb-arm');
    hint.hidden = false;
    hint.textContent = 'Click a key on the board above to put it in the block (Esc cancels).';
  }
  function disarm() { S.armed = null; $('#kb-arm').hidden = true; }

  const api = {
    get modes() { return S.modes; },
    S,
    // modes changed (made, renamed, deleted): fields and toolbox show the new names
    modesChanged() {
      const json = S.B.serialization.workspaces.save(S.ws);
      show(json);
      tracker.mark();
    },
    removeBlocksOfMode(id) {
      const hit = S.ws.getAllBlocks(false).filter((b) => b.getField('MODE') && b.getFieldValue('MODE') === String(id));
      let n = 0;
      for (const b of hit) {
        if (b.isDisposed()) continue;
        let gone = b;
        if (b.type === 'kb_mode_active') { gone = b; while (gone && gone.type !== 'kb_if') gone = gone.getParent(); gone ??= b; }
        gone.dispose(true);
        n++;
      }
      return n;
    },
    countBlocksOfMode: (id) => S.ws.getAllBlocks(false).filter((b) => b.getField('MODE') && b.getFieldValue('MODE') === String(id)).length,
    openLayer: (id) => App.remap?.openLayer?.(id),
  };

  function startPoll() {
    clearInterval(S.poll);
    if (!S.visible || !S.caps) return;
    S.poll = setInterval(async () => {
      if (document.hidden) return;
      try {
        const r = await App.api('GET', '/api/modes');
        const list = Array.isArray(r) ? r : r.modes ?? [];
        let changed = false;
        for (const m of S.modes) { const got = list.find((x) => x.id === m.id); if (got && Boolean(got.active) !== Boolean(m.active)) { m.active = Boolean(got.active); changed = true; } }
        if (changed) P().drawModes(S, api);
      } catch { clearInterval(S.poll); }
    }, 2500);
  }

  function shown(on) {
    S.visible = on;
    if (!on) { clearInterval(S.poll); disarm(); return; }
    boot().then(() => { S.B.svgResize(S.ws); startPoll(); }).catch(() => {});
  }

  App.keyBlocks = {
    paint(slot, el, mm) {
      const name = el.dataset.name, use = S.compiled ? K().slotUse(S.compiled.blocks).get(name) : 0;
      const val = App.$('.val', el);
      val.textContent = use ? `${use}/6` : '';
      val.title = use ? S.compiled.blocks.filter((b) => b.key === name).map((b) => K().sentence(b, S.modes)).join('\n') : '';
      el.classList.toggle('sel', S.armed !== null);
      el.style.background = use > K()?.MAX_RULES ? 'var(--danger-soft)' : use ? 'var(--cap-marked)' : 'var(--cap)';
      App.$('.fill', el).style.height = `${Math.min(mm / 3.6, 1) * 100}%`;
      return true;
    },
    keyDown(slot) {
      const name = App.keyEls.get(slot)?.dataset.name;
      if (!name || !S.ws) return true;
      if (S.armed) {
        D().allowKeys([name]);
        const f = S.armed;
        disarm();
        f.getOptions(false);
        f.setValue(f.name === 'TARGET' ? `key:${name}` : name);
        App.paintKeys();
        return true;
      }
      const top = S.ws.getTopBlocks(true).find((b) => b.getFieldValue('KEY') === name);
      if (top) { S.ws.centerOnBlock(top.id); top.select?.(); } else App.toast(`No block uses ${name} yet. Drag a "when" block in and pick ${name}.`);
      return true;
    },
    onDepth() {},
    shown,
    canLeave: () => !tracker?.dirty || App.ui.confirmLeave(),
  };

  // the Wizard tab's own hooks (key-wizard.js), called while the Wizard tab is the one open
  let wiz = null;
  const wizardShown = (on) => wiz?.shown(on);
  App.keyBlocksTabs = { show: (t) => setStyle(t), get tab() { return style(); } };

  App.views.keyBlocks = {
    init() {
      tracker = App.ui.track($('#kb-panel'), { save, discard: () => setTimeout(() => S.ws && reload()), saveLabel: 'Save all to the keyboard' });
      let st = 'wizard';
      try { const v = localStorage.getItem(STYLE_KEY); st = TABS.includes(v) ? v : 'wizard'; } catch { /* storage off */ }
      document.body.dataset.kw = st;
      markTabs(st);
      $('#kw-style').addEventListener('click', (e) => { const b = e.target.closest('[data-kw]'); if (b) setStyle(b.dataset.kw); });
      // the page's board hooks (analog.js) call App.keyWizard: route them to whichever tab is open
      wiz = { ...App.keyWizard };
      Object.assign(App.keyWizard, {
        paint: (slot, el, mm) => (code() ? code().paint(slot, el, mm) : ours() ? App.keyBlocks.paint(slot, el, mm) : wiz.paint(slot, el, mm)),
        keyDown: (slot) => (code() ? code().keyDown(slot) : ours() ? App.keyBlocks.keyDown(slot) : wiz.keyDown(slot)),
        onDepth: (slot, mm) => { if (!ours() && !code()) wiz.onDepth(slot, mm); },
        shown: (on) => { wizardShown(on && style() === 'wizard'); shown(on && ['blocks', 'modes'].includes(style())); App.kbCode?.shown(on && style() === 'code'); },
        canLeave: () => (code() ? code().canLeave() : ours() ? App.keyBlocks.canLeave() : wiz.canLeave()),
      });
      for (const ev of ['change', 'click']) $('#kb-modes-list').addEventListener(ev, (e) => App.kbPanels?.onModes(e));
      App.modeFlash?.mount($('#kb-mode-flash'), { instant: true });
      $('#kb-make-mode').addEventListener('click', () => boot().then(() => P().makeMode(api)).catch(() => {}));
      $('#kb-rebuild').addEventListener('click', () => {
        if (!confirm('Replace these blocks with blocks rebuilt from the rules on the keyboard?')) return;
        show(C().decompile(S.maps.filter(convertible), S.modes), { arrange: true });
        tracker.mark();                     // different from what was saved, so Save can keep them
      });
      window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.armed) disarm(); });
      window.addEventListener('statechange', () => { if (S.ws && !tracker.dirty) reload(); });
    },
  };
})();
