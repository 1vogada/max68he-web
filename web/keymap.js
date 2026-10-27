// Keymap, Fn layer and user layers: show what each key does, remap the selected key.
(() => {
  const App = (window.App = window.App || {});
  App.views = App.views || {};

  // Built-in firmware functions without a known name show as a dot; the panel shows the raw value.
  const short = (name) => (name ? (name.startsWith('raw:') ? '•' : name) : '');

  function physical(slot) {
    return App.keyEls.get(slot)?.dataset.name;
  }

  const isUser = (layer) => layer === 'layers';
  let fnl = 1;                                  // Fn layer shown on the Fn page, 1..4
  let ul = 1;                                   // user layer shown on the Layers page, 1..3
  const label = (layer) => (layer === 'fn' ? `Fn${fnl > 1 ? ` layer ${fnl}` : ''} + ` : isUser(layer) ? `Layer ${ul} · ` : '');
  const layerOf = (v) => (v === 'fn' || isUser(v) ? v : 'base');
  const remapLayer = (layer) => (layer === 'fn' && fnl > 1 ? `fn${fnl}` : isUser(layer) ? `l${ul}` : layer);
  const fnlOk = () => (App.st.features ?? []).includes('fnLayers');
  let tracker;

  function currentName(slot, layer) {
    const { st } = App;
    if (layer === 'fn') return (fnl > 1 ? st.fnLayers?.[fnl - 2]?.get(slot) : st.fn.get(slot)) ?? null;
    if (isUser(layer)) return st.layers?.[ul - 1]?.get(slot) ?? null;
    return st.keys.find((k) => k.slot === slot)?.name ?? null;
  }

  function paint(layer) {
    return (slot, el) => {
      const name = currentName(slot, layer);
      const val = App.$('.val', el);
      const overlay = layer === 'fn' || isUser(layer);
      val.textContent = overlay ? short(name) : (name !== physical(slot) ? short(name) : '');
      val.title = val.textContent ? name : '';               // full name when the cap cuts it short
      el.classList.toggle('sel', App.st.selected.has(slot));
      const changed = overlay ? Boolean(name) : name !== physical(slot);
      el.style.background = changed ? 'var(--cap-marked)' : 'var(--cap)';
      return true;
    };
  }

  // Single selection: clicking a key selects only it.
  function keyDown(slot) {
    const { st } = App;
    if (st.selected.has(slot) && st.selected.size === 1) return true;
    if (tracker?.dirty && !App.ui.confirmLeave()) return true;
    st.selected = new Set([slot]);
    App.onSelectionChange();
    return true;
  }

  function nowText(slot, layer) {
    const name = currentName(slot, layer);
    if (name) return `Now: ${name}`;
    if (layer === 'fn') return 'Now: nothing on Fn (the key does what it does without Fn)';
    if (isUser(layer)) return 'Now: empty (uses the layer below)';
    return 'Now: disabled';
  }

  function selection() {
    const { st, $ } = App;
    const f = $('#remap-form');
    const slot = [...st.selected][0];
    const layer = layerOf(st.view);
    $('#remap-title').textContent = slot === undefined ? 'Click a key on the board' : `${label(layer)}${physical(slot) ?? `slot ${slot}`}`;
    $('#remap-now').textContent = slot === undefined ? 'Then choose what it should send.' : nowText(slot, layer);
    if (!tracker.dirty) f.elements.value.value = '';
    if (slot !== undefined && App.pendingKey) {           // "Put this macro on a key…" from Macros
      f.elements.value.value = App.pendingKey;
      App.pendingKey = null;
      tracker.mark();
    }
    tracker.setReady(slot !== undefined, 'Click a key on the board first.');
    $('#remap-reset').disabled = slot === undefined || layer !== 'base';
    $('#remap-reset').hidden = layer !== 'base';
    $('#remap-clear').disabled = slot === undefined || !currentName(slot, layer);
    $('#remap-clear').hidden = layer === 'base';
    $('#remap-clear').textContent = layer === 'fn' ? 'Remove the Fn function' : 'Make empty (use the layer below)';
    $('#layer-help').hidden = !isUser(layer);
    $('#fn-tabs-note').textContent = fnlOk()
      ? `Fn + Home / Del / PgUp / PgDn on the keyboard picks Fn layer 1 / 2 / 3 / 4. You are editing Fn layer ${fnl}.`
      : App.ui.firmwareReason('Fn layers 2 to 4');
    renderLayers();
    App.ui.gate(f, isUser(layer) ? App.pageReason(st.view) : null);
    showText();
  }

  // ---- Remap's layer row (like Wootility): Main layer, the Fn layers, Layer 1-3 when
  // switched on (Interface), and Add layer. An Fn layer shows when it has keys, was added
  // (the fnLayers UI preference) or is open; firmware without Fn layers has only Fn layer 1.
  function fnShown() {
    if (!fnlOk()) return 1;
    const used = (App.st.fnLayers ?? []).reduce((n, m, k) => (m?.size ? k + 2 : n), 1);
    return Math.min(4, Math.max(used, App.prefs?.get('fnLayers') ?? 1, App.st.view === 'fn' ? fnl : 1));
  }

  function renderLayers() {
    const { st } = App;
    const box = App.$('#layer-list');
    if (!box) return;
    const n = fnShown();
    const lastEmpty = n > 1 && !st.fnLayers?.[n - 2]?.size;
    const item = (go, text, on, remove) => `<button type="button" data-go="${go}"${on ? ' class="on" aria-pressed="true"' : ''}>${text}${remove
      ? '<span class="layer-x" data-remove role="button" aria-label="Remove this Fn layer" title="Remove this Fn layer (it has no keys)">×</span>' : ''}</button>`;
    box.innerHTML = item('keymap', 'Main layer', st.view === 'keymap')
      + Array.from({ length: n }, (_, k) => item(`fn:${k + 1}`, `Fn layer ${k + 1}`, st.view === 'fn' && fnl === k + 1, k === n - 1 && lastEmpty)).join('')
      + (App.prefs?.get('layers') ? [1, 2, 3].map((u) => item(`layers:${u}`, `Layer ${u}`, st.view === 'layers' && ul === u)).join('') : '')
      + (n < 4 ? `<button type="button" class="layer-add" data-add${fnlOk() ? '' : ` disabled title="${App.ui.firmwareReason('Fn layers 2 to 4')}"`}>Add layer +</button>` : '');
  }

  // Opens a layer: another view goes through App.goto (which asks about unsaved changes),
  // another layer of this view asks here.
  function showLayer(view, k = 1) {
    const { st } = App;
    if (view === st.view) {
      if (view === 'keymap' || (view === 'fn' ? fnl : ul) === k) return renderLayers();
      if (tracker.dirty && !App.ui.confirmLeave()) return;
      if (view === 'fn') fnl = k; else ul = k;
      App.paintKeys();
      selection();
      return;
    }
    const before = [fnl, ul];
    if (view === 'fn') fnl = k; else if (view === 'layers') ul = k;
    if (!App.goto(view)) [fnl, ul] = before;
  }

  async function onLayerClick(e) {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    const n = fnShown();
    if (e.target.closest('[data-remove]')) {          // only the last Fn layer, and only when it has no keys
      await App.prefs.set('fnLayers', n - 1);
      if (App.st.view === 'fn' && fnl >= n) showLayer('fn', n - 1); else renderLayers();
      return;
    }
    if (b.hasAttribute('data-add')) {
      await App.prefs.set('fnLayers', n + 1);
      showLayer('fn', n + 1);
      return;
    }
    const [view, k] = b.dataset.go.split(':');
    showLayer(view, Number(k || 1));
  }
  App.renderLayers = renderLayers;

  // for remap-palette.js: the layer this page edits (as /api/remap names it), what a key does
  // on it now, and remapping one key there (selected afterwards, undoable like a Save)
  App.remap = {
    layer: () => remapLayer(layerOf(App.st.view)),
    current: (slot) => currentName(slot, layerOf(App.st.view)),
    physical,
    key: (slot, value) => remapSlot(slot, value),
  };

  // ---- text keys: a TextN key's string is edited right here (texts.js keeps the strings)
  let textAt = null;                            // index of the text in the box, null = no box

  function textIndex(slot, layer) {
    const typed = App.$('#remap-form').elements.value.value.trim();
    const m = /^Text(\d+)$/i.exec(typed || currentName(slot, layer) || '');
    return m && Number(m[1]) < 64 ? Number(m[1]) : null;
  }

  // the other keys (any layer) that type text i; slot/layer = the key being edited
  function usedBy(i, slot, layer) {
    const { st } = App;
    const here = layer && remapLayer(layer);
    const maps = [['base', new Map(st.keys.map((k) => [k.slot, k.name]))], ['fn', st.fn],
      ...(st.fnLayers ?? []).map((m, k) => [`fn${k + 2}`, m]), ...(st.layers ?? []).map((m, k) => [`l${k + 1}`, m])];
    const where = (l) => (l === 'base' ? '' : l === 'fn' ? 'Fn + ' : l.startsWith('fn') ? `Fn layer ${l[2]} + ` : `Layer ${l[1]} · `);
    return maps.flatMap(([l, m]) => [...(m ?? [])]
      .filter(([s, n]) => n === `Text${i}` && !(l === here && s === slot))
      .map(([s]) => `${where(l)}${physical(s) ?? `slot ${s}`}`));
  }

  function countText() {
    const box = App.$('#remap-text');
    const n = App.texts.bytes(App.$('#remap-form').elements.text.value);
    App.$('#remap-text-count').textContent = `${n}/${App.texts.max()}`;
    box.classList.toggle('over', n > App.texts.max());
  }

  function showText() {
    const { $, st } = App;
    const slot = [...st.selected][0];
    const layer = layerOf(st.view);
    const ok = Boolean(App.texts?.supported()) && slot !== undefined;
    const texts = ok ? App.textList() : null;
    const i = ok ? textIndex(slot, layer) : null;
    $('#remap-newtext').hidden = !ok;
    if (ok && !texts) {                         // read once, then show the box
      App.texts.load().then(showText, (e) => App.ui.showError($('#remap-form'), `Could not read the texts: ${e.message}`));
    }
    $('#remap-text').hidden = $('#remap-text-note').hidden = i === null || !texts;
    if (i === null || !texts) { textAt = null; return; }
    if (i !== textAt) { $('#remap-form').elements.text.value = texts[i]; textAt = i; }
    $('#remap-text-name').textContent = `Text${i}`;
    countText();
    const others = usedBy(i, slot, layer);
    $('#remap-text-note').hidden = !others.length;
    $('#remap-text-note').textContent = `Also on ${others.slice(0, 4).join(', ')}${others.length > 4 ? ` and ${others.length - 4} more` : ''}: they type it too.`;
  }

  // puts the first text slot that is empty and on no key on this key, ready to write
  async function newText() {
    const f = App.$('#remap-form');
    let texts;
    try { texts = await App.texts.load(); } catch (e) { App.toast(`Could not read the texts: ${e.message}`, true); return; }
    const i = texts.findIndex((s, k) => !s && !usedBy(k).length);
    if (i < 0) { App.toast('All 64 texts are in use. Empty one on the Text keys page first.', true); return; }
    f.elements.value.value = `Text${i}`;
    tracker.mark();
    showText();
    f.elements.text.focus();
  }

  async function remap(value) {
    const slot = [...App.st.selected][0];
    if (slot === undefined) throw new Error('Click a key on the board first');
    return remapSlot(slot, value);
  }

  // any key on the layer this page shows (a key dropped from the palette, remap-palette.js)
  async function remapSlot(slot, value) {
    const { st, api, applyState } = App;
    const layer = layerOf(st.view);
    const where = remapLayer(layer), what = `${label(layer)}${physical(slot)}`;
    const before = currentName(slot, layer);
    const res = await api('POST', '/api/remap', { slot, value, layer: where });
    applyState(res.state);
    st.selected = new Set([slot]);
    App.onSelectionChange();
    App.toast(`${what} → ${res.name ?? (layer === 'base' ? 'disabled' : 'layer below')}`);
    // undo puts the old function back (an empty Fn / layer key is "Disabled" there; a raw
    // value goes back as raw:xxxxxxxx, which the API takes)
    const back = before ?? (layer === 'base' ? null : 'Disabled');
    if (back) {
      const write = async (v) => applyState((await api('POST', '/api/remap', { slot, value: v, layer: where })).state);
      App.history?.push({ label: `${what} → ${res.name ?? value}`, undo: () => write(back), redo: () => write(value) });
    }
  }

  function init() {
    const { $, busy } = App;
    const f = $('#remap-form');
    App.ui.keyPicker(f.elements.value);
    tracker = App.ui.track(f, {
      async save() {
        const v = f.elements.value.value.trim();
        const text = f.elements.text.value;
        const textChanged = textAt !== null && text !== App.textList()[textAt];
        if (!v && !textChanged) throw new Error('Choose what the key should send first');
        if (textChanged && App.texts.bytes(text) > App.texts.max()) throw new Error(`Text${textAt} is too long: at most ${App.texts.max()} bytes`);
        if (textChanged) await App.texts.set(textAt, text);   // the text first: the key then types the new one
        if (v) await remap(v);
        f.elements.value.value = '';
        textAt = null;
        showText();
      },
      discard() { f.elements.value.value = ''; textAt = null; showText(); },
    });
    f.elements.value.addEventListener('input', showText);
    f.elements.text.addEventListener('input', countText);
    $('#remap-newtext').onclick = newText;
    $('#remap-clear').onclick = () => busy(f, 'Saving key…', () => remap('Disabled')); // all zero on Fn = fall through
    $('#layer-list').onclick = onLayerClick;
    window.addEventListener('prefschange', renderLayers);
    $('#remap-reset').onclick = () => {
      const slot = [...App.st.selected][0];
      if (slot !== undefined && physical(slot)) busy(f, 'Saving key…', () => remap(physical(slot)));
    };
  }

  // The datalist is filled once state (with the function list) has arrived.
  function fillChoices() {
    const list = App.$('#key-choices');
    if (!list || list.options.length || !App.st.functions.length) return;
    [...(App.st.keyNames ?? []), ...App.st.functions.filter((n) => App.st.info?.custom || !/^(Fw|MO|TG)/.test(n)),
      'Ctrl+C', 'Ctrl+V', 'Ctrl+Z', 'Ctrl+Shift+Esc', ...Array.from({ length: 16 }, (_, i) => `Macro${i}`)]
      .forEach((v) => list.append(new Option(v)));
  }

  const view = (layer) => ({
    init: layer === 'base' ? init : undefined,
    paint: paint(layer),
    keyDown,
    selection: () => { fillChoices(); selection(); },
  });
  App.fillChoices = fillChoices;
  App.views.keymap = view('base');
  App.views.fn = view('fn');
  App.views.layers = view('layers');
})();
