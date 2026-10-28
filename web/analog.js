// Gamepad page (like Wootility's: Setup & remap, Configuration, Gamepad tester). Keys bound to
// sticks / triggers / buttons; the mapping and response live on the PC (config/analog.json) and,
// with the open firmware, also run on the keyboard as a real gamepad ("On the keyboard").
(() => {
  const App = (window.App = window.App || {});
  App.views = App.views || {};

  const LABEL = {
    'lx-': 'L ←', 'lx+': 'L →', 'ly-': 'L ↑', 'ly+': 'L ↓', 'rx-': 'R ←', 'rx+': 'R →', 'ry-': 'R ↑', 'ry+': 'R ↓',
    lt: 'LT', rt: 'RT', a: 'A', b: 'B', x: 'X', y: 'Y', lb: 'LB', rb: 'RB', back: 'Back', start: 'Start',
    ls: 'LS', rs: 'RS', up: 'D↑', down: 'D↓', left: 'D←', right: 'D→',
    'mouse-left': 'M ←', 'mouse-right': 'M →', 'mouse-up': 'M ↑', 'mouse-down': 'M ↓',
    mouse1: 'Click L', mouse2: 'Click R', mouse3: 'Click M', 'wheel-up': 'Wheel ↑', 'wheel-down': 'Wheel ↓',
  };
  const GROUPS = [
    ['Left stick', ['ly-', 'lx-', 'ly+', 'lx+']], ['Right stick', ['ry-', 'rx-', 'ry+', 'rx+']],
    ['Buttons', ['a', 'b', 'x', 'y']], ['Triggers', ['lt', 'rt', 'lb', 'rb']], ['D-pad', ['up', 'left', 'down', 'right']],
    ['Menu, sticks', ['back', 'start', 'ls', 'rs']],
    ['Mouse', ['mouse-up', 'mouse-left', 'mouse-down', 'mouse-right', 'mouse1', 'mouse2', 'mouse3', 'wheel-up', 'wheel-down']],
  ];
  App.gpChips = { LABEL, GROUPS };                // the palette's names, for the Key wizard's picker
  const PRESET_NAMES = { linear: 'Linear', aggro: 'Aggro', slow: 'Slow', smooth: 'Smooth' };
  let cfg = null;
  let gamepadSrc = null;
  let travelSrc = null;
  let armed = null;                             // palette target waiting for keys
  let draft = null;                             // response settings as edited (curve editor, sliders)
  const depth = new Map();

  const bindingOf = (slot) => cfg?.bindings.find((b) => b.slot === slot);
  const slotOf = (el) => { for (const [s, e] of App.keyEls) if (e === el) return s; return undefined; };
  const tab = () => document.body.dataset.gp;

  // the Key wizard page (view 'wizard') shares the board hooks and the depth stream
  const wizard = () => App.st.view === 'wizard' && App.keyWizard;

  function paint(slot, el) {
    if (wizard()) return App.keyWizard.paint(slot, el, depth.get(slot) ?? 0);
    const b = bindingOf(slot);
    App.$('.val', el).textContent = b ? LABEL[b.target] : '';
    el.classList.toggle('sel', App.st.selected.has(slot));
    el.style.background = b ? 'var(--cap-marked)' : 'var(--cap)';
    App.$('.fill', el).style.height = `${Math.min((depth.get(slot) ?? 0) / 3.6, 1) * 100}%`;
    return true;
  }

  let bindTracker, setTracker, boardTracker, lastBoard = null;

  // with a palette button armed, a click gives that key the target (or takes it off again)
  function keyDown(slot) {
    if (wizard()) return App.keyWizard.keyDown(slot);
    if (armed && cfg) {
      const b = bindingOf(slot);
      assign(slot, b?.target === armed ? null : armed);
      return true;
    }
    if ([...App.st.selected][0] === slot) return true;
    if (bindTracker.dirty && !App.ui.confirmLeave()) return true;
    App.st.selected = new Set([slot]);
    App.onSelectionChange();
    return true;
  }

  function assign(slot, target) {
    const rest = cfg.bindings.filter((b) => b.slot !== slot);
    const name = App.keyEls.get(slot)?.dataset.name ?? `slot ${slot}`;
    App.busy(App.$('#gp-palette'), 'Saving…', async () => {
      await save(target ? [...rest, { slot, target }] : rest, cfg.settings);
      App.toast(target ? `${name} → ${LABEL[target]}` : `${name}: no gamepad input`);
    });
  }

  function selection() {
    const { st, $ } = App;
    const slot = [...st.selected][0];
    const f = $('#analog-bind');
    $('#analog-key').textContent = slot === undefined ? 'Click a key on the board' : App.keyEls.get(slot)?.dataset.name;
    bindTracker.setReady(slot !== undefined && Boolean(cfg), 'Click a key on the board first.');
    if (bindTracker.dirty) return;
    const b = slot === undefined ? null : bindingOf(slot);
    f.elements.target.value = b?.target ?? '';
    f.elements.invert.checked = Boolean(b?.invert);
  }

  function fillBoard(board) {
    const f = App.$('#analog-board');
    lastBoard = board;
    const ok = Boolean(board);
    for (const name of ['enabled', 'keysStopTyping']) f.elements[name].checked = ok && Boolean(board[name]);
    const hasMouse = ok && board.targetCount > 25;
    f.elements.mouseSpeed.closest('label').hidden = !hasMouse;
    if (hasMouse) {
      f.elements.mouseSpeed.value = board.mouseSpeed;
      App.$('output[data-for=mouseSpeed]', f).textContent = `${board.mouseSpeed} px/s`;
    }
    App.ui.gate(f, ok ? null : App.ui.firmwareReason('A gamepad that runs on the keyboard'));
    boardTracker?.clear();
    drawPalette();
    const plusNote = App.$('#gp-plus-note');
    plusNote.hidden = !ok || (App.st.features ?? []).includes('gamepadPlus');
    plusNote.textContent = 'The preview already uses these. For the gamepad on the keyboard, the custom curve, anti-deadzone, square, snappy and angle settings need the newer open firmware.';
  }

  // writes bindings + response settings (kept on the PC, and on the keyboard when it runs them)
  async function write(bindings, settings) {
    cfg = { ...cfg, ...(await App.api('POST', '/api/analog/set', { bindings, settings })) };
    if (cfg.board !== undefined) fillBoard(cfg.board);
    fillSettings();
    setTracker.clear();
    App.paintKeys();
    drawPalette();
  }
  async function save(bindings, settings) {
    const before = { bindings: cfg.bindings, settings: cfg.settings };
    await write(bindings, settings);
    App.history?.push({ label: 'gamepad mapping', undo: () => write(before.bindings, before.settings), redo: () => write(bindings, settings) });
  }

  // ---- Setup & remap: the button palette ------------------------------------------

  function drawPalette() {
    const box = App.$('#gp-chips');
    if (!box) return;
    const mouse = (lastBoard?.targetCount ?? 0) > 25;
    box.innerHTML = GROUPS.filter(([g]) => g !== 'Mouse' || mouse).map(([g, ts]) => `<div class="gp-group"><span>${g}</span>${ts.map((t) =>
      `<button type="button" class="gp-chip${armed === t ? ' armed' : ''}" data-t="${t}" draggable="true" aria-pressed="${armed === t}"
        title="${t}: click, then click keys">${LABEL[t]}</button>`).join('')}</div>`).join('');
    App.$('#gp-count').textContent = `${cfg?.bindings.length ?? 0} key${cfg?.bindings.length === 1 ? '' : 's'}`;
  }

  function bindPalette() {
    const { $ } = App;
    $('#gp-chips').onclick = (e) => {
      const c = e.target.closest('.gp-chip');
      if (!c) return;
      armed = armed === c.dataset.t ? null : c.dataset.t;
      drawPalette();
      if (armed) App.toast(`Click keys to make them ${LABEL[armed]}; click the button again to stop`);
    };
    $('#gp-chips').addEventListener('dragstart', (e) => {
      const c = e.target.closest('.gp-chip');
      if (c) e.dataTransfer.setData('text/x-gp-target', c.dataset.t);
    });
    const kb = $('#keyboard');
    const keyAt = (e) => e.target.closest?.('.key');
    kb.addEventListener('dragover', (e) => {
      if (App.st.view !== 'analog' || !e.dataTransfer.types.includes('text/x-gp-target')) return;
      e.preventDefault();
      App.$$('.key.gp-drop').forEach((k) => k.classList.remove('gp-drop'));
      keyAt(e)?.classList.add('gp-drop');
    });
    kb.addEventListener('dragleave', (e) => keyAt(e)?.classList.remove('gp-drop'));
    kb.addEventListener('drop', (e) => {
      const t = e.dataTransfer.getData('text/x-gp-target');
      const el = keyAt(e);
      App.$$('.key.gp-drop').forEach((k) => k.classList.remove('gp-drop'));
      if (App.st.view !== 'analog' || !t || !el || !cfg) return;
      e.preventDefault();
      const slot = slotOf(el);
      if (slot !== undefined) assign(slot, t);
    });
    kb.addEventListener('contextmenu', (e) => {         // right-click takes a key's gamepad input off
      const el = keyAt(e);
      if (App.st.view !== 'analog' || !el || !cfg) return;
      e.preventDefault();
      const slot = slotOf(el);
      if (slot !== undefined && bindingOf(slot)) assign(slot, null);
    });
  }

  // ---- Configuration: curve and response ---------------------------------------------

  function readForm() {
    const f = App.$('#analog-settings');
    const n = (k) => Number(f.elements[k].value);
    return { ...draft, deadzoneMm: n('deadzoneMm'), fullMm: n('fullMm'), buttonMm: n('buttonMm'), curve: f.elements.curve.value,
      antiDeadzone: n('antiDeadzone'), square: f.elements.square.checked, snappy: f.elements.snappy.checked,
      diagonalDeg: f.elements.angleOn.checked ? n('diagonalDeg') : 0 };
  }

  function outputs() {
    const f = App.$('#analog-settings');
    for (const k of ['deadzoneMm', 'fullMm', 'buttonMm']) App.$(`output[data-for=${k}]`, f).textContent = `${Number(f.elements[k].value).toFixed(2)} mm`;
    App.$('output[data-for=antiDeadzone]', f).textContent = `${f.elements.antiDeadzone.value} %`;
    App.$('output[data-for=diagonalDeg]', f).textContent = `${f.elements.diagonalDeg.value}°`;
    f.elements.diagonalDeg.disabled = !f.elements.angleOn.checked;
  }

  function fillSettings() {
    const f = App.$('#analog-settings');
    const s = cfg.settings;
    draft = { ...s, points: s.points.map((p) => [...p]) };
    for (const k of ['deadzoneMm', 'fullMm', 'buttonMm', 'antiDeadzone']) f.elements[k].value = s[k];
    f.elements.curve.value = s.curve;
    f.elements.square.checked = s.square;
    f.elements.snappy.checked = s.snappy;
    f.elements.angleOn.checked = s.diagonalDeg > 0;
    f.elements.diagonalDeg.value = s.diagonalDeg || 45;
    outputs();
    redraw();
  }

  function redraw() {
    if (!cfg) return;
    draft = readForm();
    App.gpCurve.draw(App.$('#curve-canvas'), draft);
    App.$$('#curve-presets [data-preset]').forEach((b) => {
      const p = cfg.presets?.[b.dataset.preset];
      b.classList.toggle('on', draft.curve === 'custom' && JSON.stringify(p) === JSON.stringify(draft.points));
    });
  }

  function bindSettings() {
    const { $ } = App;
    const set = $('#analog-settings');
    set.addEventListener('input', () => { outputs(); redraw(); });
    set.addEventListener('change', () => { outputs(); redraw(); });
    setTracker = App.ui.track(set, {
      async save() { await save(cfg.bindings, readForm()); },
      discard() { fillSettings(); },
    });
    // dragging a point makes the curve a custom one
    App.gpCurve.attach($('#curve-canvas'), () => draft, (points) => {
      draft.points = points;
      set.elements.curve.value = 'custom';
      setTracker.mark();
      redraw();
    });
  }

  function fillPresets() {
    const box = App.$('#curve-presets');
    box.innerHTML = Object.entries(PRESET_NAMES).filter(([k]) => cfg.presets?.[k])
      .map(([k, name]) => `<button type="button" data-preset="${k}">${name}</button>`).join('');
    box.onclick = (e) => {
      const b = e.target.closest('[data-preset]');
      if (!b) return;
      draft.points = cfg.presets[b.dataset.preset].map((p) => [...p]);
      App.$('#analog-settings').elements.curve.value = 'custom';
      setTracker.mark();
      redraw();
    };
  }

  // ---- Gamepad tester: preview from depth + what the PC sees ------------------------------

  function drawPad(s) {
    const { $ } = App;
    const stick = (id, x, y) => {
      $(`#${id}`).setAttribute('cx', 0 + x * 22);
      $(`#${id}`).setAttribute('cy', 0 + y * 22);
    };
    stick('pad-ls', s.lx, s.ly);
    stick('pad-rs', s.rx, s.ry);
    $('#pad-lt').setAttribute('width', 70 * s.lt);
    $('#pad-rt').setAttribute('width', 70 * s.rt);
    App.$$('[data-btn]').forEach((el) => el.classList.toggle('lit', Boolean(s.buttons[el.dataset.btn])));
    $('#pad-readout').textContent = `L ${s.lx.toFixed(2)}, ${s.ly.toFixed(2)}   R ${s.rx.toFixed(2)}, ${s.ry.toFixed(2)}   LT ${s.lt.toFixed(2)}   RT ${s.rt.toFixed(2)}`;
  }

  function startStreams() {
    if (gamepadSrc) return;
    gamepadSrc = new EventSource('/api/analog');
    gamepadSrc.onmessage = (e) => drawPad(JSON.parse(e.data));
    travelSrc = new EventSource('/api/travel');
    travelSrc.onmessage = (e) => {
      const { slot, mm } = JSON.parse(e.data);
      if (mm > 0) depth.set(slot, mm); else depth.delete(slot);
      const el = App.keyEls.get(slot);
      if (el && App.st.view === 'analog') App.$('.fill', el).style.height = `${Math.min(mm / 3.6, 1) * 100}%`;
      if (wizard()) App.keyWizard.onDepth(slot, mm);
    };
  }

  function stopStreams() {
    gamepadSrc?.close();
    travelSrc?.close();
    gamepadSrc = travelSrc = null;
    depth.clear();
  }

  function showTab(t) {
    document.body.dataset.gp = t;
    App.$$('#gp-tabs [data-gp-tab]').forEach((b) => b.classList.toggle('on', b.dataset.gpTab === t));
    if (t !== 'setup' && armed) { armed = null; drawPalette(); }
    if (t === 'tester' && App.st.view === 'analog') App.gpTester.start(); else App.gpTester.stop();
    if (t === 'config') redraw();
    if (App.st.view === 'analog') App.paintKeys();
  }

  function init() {
    const { $, api } = App;
    document.body.dataset.gp = 'setup';
    $('#gp-tabs').onclick = (e) => { const b = e.target.closest('[data-gp-tab]'); if (b) showTab(b.dataset.gpTab); };
    const bind = $('#analog-bind');
    bind.elements.target.add(new Option('— nothing —', ''));
    Object.entries(LABEL).forEach(([t, l]) => bind.elements.target.add(new Option(`${l} (${t})`, t)));
    bindTracker = App.ui.track(bind, {
      async save() {
        const slot = [...App.st.selected][0];
        const rest = cfg.bindings.filter((b) => b.slot !== slot);
        const target = bind.elements.target.value;
        await save(target ? [...rest, { slot, target, invert: bind.elements.invert.checked }] : rest, cfg.settings);
      },
      discard() { bindTracker.dirty = false; selection(); },
    });
    bindSettings();
    bindPalette();
    $('#analog-wasd').onclick = () => App.busy($('#gp-palette'), 'Binding WASD to the left stick…', async () => {
      await save([
        ...cfg.bindings.filter((b) => ![14, 9, 15, 21].includes(b.slot)),
        { slot: 14, target: 'ly-' }, { slot: 15, target: 'ly+' }, { slot: 9, target: 'lx-' }, { slot: 21, target: 'lx+' },
      ], cfg.settings);
      App.toast('W A S D now move the left stick');
    });
    $('#analog-clear').onclick = () => {
      if (!cfg?.bindings.length) return App.toast('No keys are bound');
      if (!confirm(`Remove all ${cfg.bindings.length} gamepad bindings?`)) return;
      App.busy($('#gp-palette'), 'Removing all bindings…', async () => { await save([], cfg.settings); App.toast('All gamepad bindings removed'); });
    };
    const board = $('#analog-board');
    board.addEventListener('input', (e) => {
      if (e.target.name === 'mouseSpeed') $('output[data-for=mouseSpeed]', board).textContent = `${e.target.value} px/s`;
    });
    boardTracker = App.ui.track(board, {
      async save() {
        const r = await api('POST', '/api/gamepad/board/set', {
          enabled: board.elements.enabled.checked, keysStopTyping: board.elements.keysStopTyping.checked,
          ...(!board.elements.mouseSpeed.closest('label').hidden && { mouseSpeed: Number(board.elements.mouseSpeed.value) }),
        });
        fillBoard(r.board);
      },
      discard() { fillBoard(lastBoard); },
    });
    api('POST', '/api/gamepad/board/get').then((r) => fillBoard(r.board)).catch(() => fillBoard(null));
    api('POST', '/api/analog/get').then((c) => {
      cfg = c;
      c.curves.forEach((k) => $('#analog-settings').elements.curve.add(new Option(k === 'custom' ? 'custom (drag the points)' : k, k)));
      fillPresets();
      fillSettings();
      drawPalette();
      if (App.st.view === 'analog') App.paintKeys();
      selection();
    }).catch((e) => App.ui.showError(bind, `Could not read the gamepad mapping: ${e.message}`));
    // Streams (and the tester) run only while this page is open.
    window.addEventListener('pagechange', (e) => {
      if (e.detail === 'analog') { startStreams(); showTab(tab()); App.keyWizard?.shown(false); }
      else if (e.detail === 'wizard') { startStreams(); App.gpTester.stop(); armed = null; App.keyWizard?.shown(true); App.paintKeys(); }
      else { stopStreams(); App.gpTester.stop(); armed = null; App.keyWizard?.shown(false); }
    });
    window.addEventListener('themechange', () => cfg && redraw());
  }

  App.views.analog = { init, paint, keyDown, selection };
  App.views.wizard = { paint, keyDown };
})();
