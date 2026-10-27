// Remap presets and the key palette (like Wootility's Remap page). Presets (remap-presets.js)
// rewrite the main layer (or Fn layer 1) in one go through POST /api/remap/batch, as one undo
// step. The palette lists every key the keyboard can send, searchable: drag one onto a key on
// the board to remap it on the layer shown (main, Fn layer N, Layer N), or click it to put it
// in the "New function" box.
(() => {
  const App = (window.App = window.App || {});
  App.views = App.views || {};
  const DRAG = 'text/x-remap-key';
  const VIEWS = ['keymap', 'fn', 'layers'];

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // palette groups, in order; a name goes in the first group whose test it passes
  const GROUPS = [
    ['Letters', (n) => /^[A-Z]$/.test(n)],
    ['Digits', (n) => /^[0-9]$/.test(n)],
    ['Symbols', (n) => /^[-=[\]\\;'`,./]$|^ISO\\$/.test(n)],
    ['F-keys', (n) => /^F\d+$/.test(n)],
    ['Editing and moving', (n) => /^(Esc|Tab|Bksp|Enter|Space|Caps|Ins|Del|Home|End|PgUp|PgDn|Up|Down|Left|Right|PrtSc|ScrLk|Pause|Menu|NumLock)$/.test(n)],
    ['Modifiers', (n) => /^[LR](Ctrl|Shift|Alt|Win)$/.test(n)],
    ['Media and system', (n) => /^(Volume|Mute|PlayPause|NextTrack|PrevTrack|StopMedia|MediaPlayer|Calculator|Mail|MyComputer|Search|Browser|ScreenBrightness|System|LockScreen|ShowDesktop)/.test(n)],
    ['Mouse', (n) => /^Mouse/.test(n)],
    ['Layers', (n) => /^(Fn|MO\d|TG\d)$/.test(n)],
    ['Macros', (n) => /^Macro\d+$/.test(n)],
    ['Text keys', (n) => /^Text\d+$/.test(n)],
    ['Keyboard', (n) => /^(Profile|Fw|Led)/.test(n)],
    ['Other', () => true],
  ];

  function names() {
    const { st } = App;
    const custom = Boolean(st.info?.custom);
    const fns = (st.functions ?? []).filter((n) => custom || !/^(Fw|MO|TG)/.test(n))
      .filter((n) => !/^(MO|TG)\d/.test(n) || App.prefs?.get('layers'));        // extra layers: Interface toggle
    const texts = App.texts?.supported?.() ? Array.from({ length: 64 }, (_, i) => `Text${i}`) : [];
    return [...new Set([...(st.keyNames ?? []), ...fns, ...Array.from({ length: 16 }, (_, i) => `Macro${i}`), ...texts])];
  }

  function drawPalette() {
    const box = App.$('#palette-keys');
    if (!box || !App.st.info) return;
    const q = App.$('#palette-search').value.trim().toLowerCase();
    const groups = new Map(GROUPS.map(([g]) => [g, []]));
    for (const n of names()) {
      if (q && !n.toLowerCase().includes(q)) continue;
      groups.get(GROUPS.find(([, t]) => t(n))[0]).push(n);
    }
    // text keys: all 64 only when searching, else the first few
    if (!q) groups.set('Text keys', groups.get('Text keys').slice(0, 8));
    box.innerHTML = [...groups].filter(([, list]) => list.length).map(([g, list]) => `<div class="palette-group"><span>${g}</span>
      <div>${list.map((n) => `<button type="button" class="palette-key" draggable="true" data-key="${esc(n)}" title="${esc(n)}: drag onto a key, or click">${esc(n)}</button>`).join('')}</div></div>`)
      .join('') || '<p class="muted">No key matches.</p>';
  }

  // ---- presets -------------------------------------------------------------------------

  function drawPresets() {
    const box = App.$('#preset-buttons');
    if (!box || box.childElementCount) return;
    box.innerHTML = Object.entries(App.remapPresets).map(([id, p]) => `<button type="button" class="preset" data-preset="${id}" title="${esc(p.note)}">
      <span class="preset-icon">${esc(p.icon)}</span><span>${esc(p.name)}</span></button>`).join('');
  }

  // keys the preset changes on its layer: [{ slot, value, before }]
  function plan(p) {
    const { st } = App;
    const out = [];
    for (const [slot, el] of App.keyEls) {
      const label = el.dataset.name;
      const value = p.keys ? p.keys[label] : label;           // Default: every key sends its label
      if (!value) continue;
      const before = p.layer === 'fn' ? (st.fn.get(slot) ?? null) : (st.keys.find((k) => k.slot === slot)?.name ?? null);
      if (before === value) continue;
      out.push({ slot, value, before: before ?? (p.layer === 'fn' ? 'Disabled' : null) });
    }
    return out;
  }

  async function batch(layer, keys) {
    const r = await App.api('POST', '/api/remap/batch', { layer, keys });
    App.applyState(r.state);
    return r;
  }

  async function applyPreset(id) {
    const p = App.remapPresets[id];
    const keys = plan(p);
    if (!keys.length) return App.toast(`${p.name}: every key already matches`);
    const where = p.layer === 'fn' ? 'Fn layer 1' : 'the main layer';
    if (!confirm(`${p.name} preset: change ${keys.length} key${keys.length === 1 ? '' : 's'} on ${where} of the active profile?\n\n${p.note}\n\nYou can undo it with ↶ (Ctrl+Z).`)) return;
    const layer = p.layer;
    const after = keys.map(({ slot, value }) => ({ slot, value }));
    const back = keys.filter((k) => k.before).map(({ slot, before }) => ({ slot, value: before }));
    await App.busy(App.$('#remap-presets'), `Writing ${keys.length} keys… (about ${Math.ceil(keys.length * 0.45)} s)`, async () => {
      await batch(layer, after);
      App.toast(`${p.name}: ${keys.length} keys changed`);
      if (back.length) App.history?.push({ label: `${p.name} preset (${keys.length} keys)`, undo: () => batch(layer, back), redo: () => batch(layer, after) });
    });
  }

  // ---- drag and drop onto the board --------------------------------------------------------

  function bindBoard() {
    const kb = App.$('#keyboard');
    const keyAt = (e) => e.target.closest?.('.key');
    const slotOf = (el) => { for (const [s, e] of App.keyEls) if (e === el) return s; return undefined; };
    const clear = () => App.$$('.key.palette-drop').forEach((k) => k.classList.remove('palette-drop'));
    kb.addEventListener('dragover', (e) => {
      if (!VIEWS.includes(App.st.view) || !e.dataTransfer.types.includes(DRAG)) return;
      e.preventDefault();
      clear();
      keyAt(e)?.classList.add('palette-drop');
    });
    kb.addEventListener('dragleave', (e) => keyAt(e)?.classList.remove('palette-drop'));
    kb.addEventListener('drop', (e) => {
      const value = e.dataTransfer.getData(DRAG);
      const el = keyAt(e);
      clear();
      if (!VIEWS.includes(App.st.view) || !value || !el) return;
      e.preventDefault();
      const slot = slotOf(el);
      if (slot === undefined || App.remap.current(slot) === value) return;
      if (App.ui.anyDirty?.() && !App.ui.confirmLeave()) return;
      App.busy(App.$('#remap-palette'), `Saving ${App.remap.physical(slot) ?? `slot ${slot}`}…`, () => App.remap.key(slot, value));
    });
  }

  App.views.remapPalette = {
    init() {
      const { $ } = App;
      $('#palette-search').addEventListener('input', drawPalette);
      $('#palette-keys').addEventListener('dragstart', (e) => {
        const b = e.target.closest('.palette-key');
        if (b) { e.dataTransfer.setData(DRAG, b.dataset.key); e.dataTransfer.effectAllowed = 'copy'; }
      });
      $('#palette-keys').addEventListener('click', (e) => {   // click: into the "New function" box, ready to Save
        const b = e.target.closest('.palette-key');
        if (!b) return;
        const input = $('#remap-form').elements.value;
        input.value = b.dataset.key;
        input.dispatchEvent(new Event('input', { bubbles: true }));   // marks the form changed
        App.ui.closePicker?.();                     // that input opens the key picker; the choice is made
        if (![...App.st.selected].length) App.toast(`${b.dataset.key}: now click a key on the board, then Save (or drag it onto the key)`);
      });
      $('#preset-buttons').addEventListener('click', (e) => { const b = e.target.closest('[data-preset]'); if (b) applyPreset(b.dataset.preset); });
      bindBoard();
      const show = () => { if (VIEWS.includes(App.st.view)) { drawPresets(); drawPalette(); } };
      window.addEventListener('pagechange', show);
      window.addEventListener('statechange', show);
      window.addEventListener('prefschange', show);
    },
  };
})();
