// Multi-level DKS editor (open firmware with DKS levels), used by advanced.js.
// One key, up to 4 bound keys, 1..8 depth levels; at each level every bound key has
// an action for passing it going down and one for coming back up over it.
(() => {
  const App = (window.App = window.App || {});

  const MAX_LEVELS = 8;
  const MAX_KEYS = 4;
  const RULER_MM = 4;            // the ruler shows the key's full travel
  const STEP = 0.05;
  const ACTIONS = [
    ['none', '—', ''],
    ['tap', 'Tap', 'pressed and let go right away'],
    ['press', 'Press', 'held until the next level is passed or left'],
    ['hold', 'Hold', 'held until the key is fully up'],
    ['release', 'Let go', 'lets go of the key if it is held'],
  ];
  const VERB = { tap: 'taps', press: 'presses', hold: 'holds', release: 'lets go of' };
  const blank = () => ({ down: 'none', up: 'none' });

  let root;
  let model = null;              // { keys: [names], levels: [{ depthMm, actions: [{down, up} x4] }], gapMm }
  let live = null;               // EventSource for the live depth
  let liveSlot = null;
  let onChange = () => {};

  const round = (mm) => Math.round(mm / STEP) * STEP;
  const fmt = (mm) => `${mm.toFixed(2)} mm`;
  const keyLabel = (k, i) => (k && k !== 'none' ? k : `key ${i + 1}`);

  // ---- defaults and presets ----------------------------------------------------

  function fresh(ownKey) {
    return {
      keys: [ownKey],
      gapMm: 0.1,
      levels: [
        { depthMm: 1, actions: [{ down: 'hold', up: 'none' }, blank(), blank(), blank()] },
        { depthMm: 3, actions: [blank(), blank(), blank(), blank()] },
      ],
    };
  }

  const PRESETS = {
    plain: { label: 'Like a normal key', keys: 1, build: () => [{ depthMm: 1, a: [['hold', 'none']] }] },
    twoKeys: { label: 'Two keys by depth', keys: 2,
      build: () => [{ depthMm: 1, a: [['press', 'none']] }, { depthMm: 3, a: [['none', 'none'], ['hold', 'none']] }] },
    tapHold: { label: 'Tap shallow, hold deep', keys: 2,
      build: () => [{ depthMm: 1, a: [['tap', 'none']] }, { depthMm: 3, a: [['none', 'none'], ['hold', 'none']] }] },
    downUp: { label: 'Tap going down and coming up', keys: 1,
      build: () => [{ depthMm: 1.5, a: [['tap', 'tap']] }] },
  };

  function applyPreset(id, ownKey) {
    const p = PRESETS[id];
    const keys = model.keys.slice(0, MAX_KEYS);
    if (!keys.length || keys[0] === 'none') keys[0] = ownKey;
    while (keys.length < p.keys) keys.push('none');
    model.keys = keys;
    model.levels = p.build().map((l) => ({
      depthMm: l.depthMm,
      actions: [0, 1, 2, 3].map((b) => (l.a[b] ? { down: l.a[b][0], up: l.a[b][1] } : blank())),
    }));
    render();
    if (p.keys > 1 && keys.slice(1).some((k) => k === 'none')) App.toast('Now pick the second bound key', false);
  }

  // ---- reading the model -------------------------------------------------------

  function problems() {
    const out = [];
    if (!model.keys.some((k) => k && k !== 'none')) out.push('Bind at least one key.');
    model.levels.forEach((l, i) => {
      if (!(l.depthMm >= STEP && l.depthMm <= 5)) out.push(`Level ${i + 1}: depth must be 0.05–5 mm.`);
      else if (i && !(l.depthMm > model.levels[i - 1].depthMm)) out.push(`Level ${i + 1} must be deeper than level ${i}.`);
    });
    return out;
  }

  function summary() {
    const lines = [];
    model.levels.forEach((l, i) => {
      for (const dir of ['down', 'up']) {
        const acts = l.actions.slice(0, model.keys.length)
          .map((a, b) => (a[dir] !== 'none' ? `${VERB[a[dir]]} ${keyLabel(model.keys[b], b)}` : null)).filter(Boolean);
        if (acts.length) lines.push(`${dir === 'down' ? 'Pressing past' : 'Coming back above'} ${fmt(l.depthMm)} ${acts.join(', ')}.`);
      }
    });
    if (!lines.length) return 'Nothing happens yet: choose what each key does at a level.';
    return [...lines, 'When the key is fully up, every held key is let go.'].join(' ');
  }

  // ---- rendering ----------------------------------------------------------------

  function actionSelect(level, b, dir) {
    const sel = document.createElement('select');
    sel.className = `dks2-act act-${level.actions[b][dir]}`;
    sel.setAttribute('aria-label', `${keyLabel(model.keys[b], b)} ${dir === 'down' ? 'going down' : 'coming up'}`);
    for (const [v, label, help] of ACTIONS) sel.add(Object.assign(new Option(label, v), { title: help }));
    sel.value = level.actions[b][dir];
    sel.onchange = () => { level.actions[b][dir] = sel.value; render(); };
    return sel;
  }

  function renderKeys() {
    const box = App.$('.dks2-keys', root);
    box.innerHTML = '';
    model.keys.forEach((k, i) => {
      const chip = document.createElement('div');
      chip.className = `dks2-key k${i}`;
      chip.innerHTML = '<span class="dot"></span>';
      const input = Object.assign(document.createElement('input'), {
        value: k === 'none' ? '' : k, placeholder: 'pick a key', spellcheck: false,
      });
      input.setAttribute('list', 'dks-key-choices');
      input.setAttribute('aria-label', `bound key ${i + 1}`);
      input.onchange = () => { model.keys[i] = input.value.trim() || 'none'; render(); };
      chip.append(input);
      App.ui.keyPicker(input, { only: 'keyboard' });
      if (model.keys.length > 1) {
        const x = Object.assign(document.createElement('button'), { type: 'button', className: 'icon', textContent: '×', title: 'Remove this key' });
        x.onclick = () => {
          model.keys.splice(i, 1);
          for (const l of model.levels) { l.actions.splice(i, 1); l.actions.push(blank()); }
          render();
        };
        chip.append(x);
      }
      box.append(chip);
    });
    if (model.keys.length < MAX_KEYS) {
      const add = Object.assign(document.createElement('button'), { type: 'button', textContent: '+ Add key' });
      add.onclick = () => { model.keys.push('none'); render(); box.querySelector(`.k${model.keys.length - 1} input`)?.focus(); };
      box.append(add);
    }
  }

  function renderRuler() {
    const ruler = App.$('.dks2-ruler', root);
    App.$$('.mark', ruler).forEach((m) => m.remove());
    model.levels.forEach((l, i) => {
      const m = document.createElement('div');
      m.className = 'mark';
      m.style.top = `${Math.min(l.depthMm / RULER_MM, 1) * 100}%`;
      m.innerHTML = `<span class="tag">${i + 1}</span><span class="mm">${l.depthMm.toFixed(2)}</span>`;
      m.title = 'Drag to change the depth';
      m.onpointerdown = (e) => drag(e, i);
      ruler.append(m);
    });
  }

  function drag(e, i) {
    e.preventDefault();
    const ruler = App.$('.dks2-ruler', root);
    const rect = ruler.getBoundingClientRect();
    const lo = i ? model.levels[i - 1].depthMm + STEP : STEP;
    const hi = i < model.levels.length - 1 ? model.levels[i + 1].depthMm - STEP : RULER_MM;
    const move = (ev) => {
      const mm = round(((ev.clientY - rect.top) / rect.height) * RULER_MM);
      model.levels[i].depthMm = Math.min(hi, Math.max(lo, mm));
      renderRuler(); renderLevels(); renderFoot();
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); onChange(); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function renderLevels() {
    const box = App.$('.dks2-levels', root);
    box.innerHTML = '';
    model.levels.forEach((l, i) => {
      const row = document.createElement('div');
      row.className = 'dks2-level';
      const head = document.createElement('div');
      head.className = 'dks2-level-head';
      head.innerHTML = `<b>Level ${i + 1}</b>`;
      const depth = Object.assign(document.createElement('input'), {
        type: 'number', min: STEP, max: 5, step: STEP, value: l.depthMm.toFixed(2),
      });
      depth.setAttribute('aria-label', `level ${i + 1} depth in mm`);
      depth.onchange = () => { l.depthMm = Number(depth.value); render(); };
      const unit = Object.assign(document.createElement('span'), { className: 'muted', textContent: 'mm' });
      head.append(depth, unit);
      if (model.levels.length > 1) {
        const x = Object.assign(document.createElement('button'), { type: 'button', className: 'icon', textContent: '×', title: 'Remove this level' });
        x.onclick = () => { model.levels.splice(i, 1); render(); };
        head.append(x);
      }
      row.append(head);
      const grid = document.createElement('div');
      grid.className = 'dks2-acts';
      grid.innerHTML = '<span></span><span class="muted small">↓ going down</span><span class="muted small">↑ coming up</span>';
      model.keys.forEach((k, b) => {
        const name = Object.assign(document.createElement('span'), { className: `dks2-kname k${b}`, textContent: keyLabel(k, b) });
        name.prepend(Object.assign(document.createElement('span'), { className: 'dot' }));
        grid.append(name, actionSelect(l, b, 'down'), actionSelect(l, b, 'up'));
      });
      row.append(grid);
      box.append(row);
    });
  }

  function renderFoot() {
    App.$('.dks2-summary', root).textContent = summary();
    const errs = problems();
    const err = App.$('.dks2-errors', root);
    err.hidden = !errs.length;
    err.textContent = errs.join(' ');
    App.$('.dks2-add-level', root).disabled = model.levels.length >= MAX_LEVELS;
    App.$('.dks2-count', root).textContent = `${model.levels.length} of ${MAX_LEVELS} levels`;
    App.$('[name=dksGap]', root).value = model.gapMm.toFixed(2);
  }

  let quiet = false;   // loading from the keyboard is not an edit
  function render() {
    renderKeys(); renderRuler(); renderLevels(); renderFoot();
    if (!quiet) onChange();
  }

  function addLevel() {
    const last = model.levels[model.levels.length - 1];
    const depthMm = Math.min(RULER_MM, round((last?.depthMm ?? 0) + 0.5));
    if (last && depthMm <= last.depthMm) { App.toast('No room below the last level: move it up first', true); return; }
    model.levels.push({ depthMm, actions: [blank(), blank(), blank(), blank()] });
    render();
  }

  // ---- live depth -------------------------------------------------------------------

  function setLive(slot) {
    if (live && liveSlot === slot) return;
    if (live) { live.close(); live = null; }
    liveSlot = slot;
    const fill = root && App.$('.dks2-ruler .fill', root);
    if (fill) fill.style.height = '0';
    if (slot === null) return;
    live = new EventSource('/api/travel');
    live.onmessage = (e) => {
      const { slot: s, mm } = JSON.parse(e.data);
      if (s !== liveSlot) return;
      App.$('.dks2-ruler .fill', root).style.height = `${Math.min(mm / RULER_MM, 1) * 100}%`;
      App.$('.dks2-live', root).textContent = mm ? `now ${fmt(mm)}` : 'press the key to see its depth here';
    };
  }

  // ---- mounting -------------------------------------------------------------------

  // keyboard keys only: DKS can't send media, mouse, macro or layer keys
  function fillChoices() {
    const list = document.getElementById('dks-key-choices');
    if (list.options.length || !App.keyEls?.size) return;
    const names = new Set([...App.keyEls.values()].map((el) => el.dataset.name).filter(Boolean));
    ['LCtrl', 'LShift', 'LAlt', 'LWin', 'RCtrl', 'RShift', 'RAlt', 'RWin', 'Esc', 'Home', 'End', 'Ins', 'PrtSc',
      ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`), 'Ctrl+C', 'Ctrl+V', 'Ctrl+Z', 'Ctrl+Shift+Esc', 'Alt+Tab']
      .forEach((n) => names.add(n));
    names.delete('Fn');
    names.forEach((n) => list.append(new Option(n)));
  }

  function mount(el, changed) {
    root = el;
    onChange = changed ?? (() => {});
    root.innerHTML = `
      <div class="dks2-section">
        <h3>Bound keys <span class="muted small">what this key can send, up to ${MAX_KEYS}</span></h3>
        <div class="dks2-keys"></div>
      </div>
      <div class="dks2-section">
        <h3>Levels <span class="muted small dks2-count"></span></h3>
        <div class="dks2-main">
          <div class="dks2-ruler-wrap">
            <div class="dks2-ruler" aria-label="Key travel, top to bottom"><div class="fill"></div>
              <span class="end top">0 mm</span><span class="end bottom">${RULER_MM} mm</span></div>
            <p class="muted small dks2-live">press the key to see its depth here</p>
          </div>
          <div class="dks2-levels"></div>
        </div>
        <div class="row-buttons">
          <button type="button" class="dks2-add-level">+ Add level</button>
          <label class="dks2-preset">Start from <select name="dksPreset"><option value="">a preset…</option>
            ${Object.entries(PRESETS).map(([id, p]) => `<option value="${id}">${p.label}</option>`).join('')}</select></label>
        </div>
      </div>
      <details class="dks2-more"><summary>Release gap</summary>
        <label>A level counts as left once the key is this far above it
          <span class="row"><input name="dksGap" type="number" min="0" max="1" step="0.05"> mm</span></label>
        <p class="muted small">Stops a key held right at a level from firing it again and again. 0.10 mm suits most switches.</p>
      </details>
      <datalist id="dks-key-choices"></datalist>
      <p class="dks2-errors" role="alert" hidden></p>
      <div class="dks2-explain">
        <p class="dks2-summary"></p>
        <dl>${ACTIONS.slice(1).map(([, l, h]) => `<dt>${l}</dt><dd>${h}</dd>`).join('')}</dl>
      </div>`;
    App.$('.dks2-add-level', root).onclick = addLevel;
    App.$('[name=dksGap]', root).onchange = (e) => { model.gapMm = Math.max(0, Math.min(1, Number(e.target.value) || 0)); render(); };
    App.$('[name=dksPreset]', root).onchange = (e) => {
      if (e.target.value) applyPreset(e.target.value, model.ownKey);
      e.target.value = '';
    };
  }

  // entry: an advanced-key entry from /api/advanced/list with levels, or null for a new DKS
  function load(entry, ownKey) {
    const keys = entry?.levels ? entry.keys.slice() : [ownKey];
    while (keys.length > 1 && keys[keys.length - 1] === 'none') keys.pop();
    model = entry?.levels
      ? { keys, gapMm: entry.gapMm ?? 0.1,
          levels: entry.levels.map((l) => ({ depthMm: l.depthMm, actions: l.actions.map((a) => ({ ...a })) })) }
      : fresh(ownKey);
    model.ownKey = ownKey;
    fillChoices();
    quiet = true;
    render();
    quiet = false;
  }

  function value() {
    const errs = problems();
    if (errs.length) throw new Error(errs[0]);
    return {
      keys: model.keys.map((k) => k || 'none'),
      gapMm: model.gapMm,
      levels: model.levels.map((l) => ({ depthMm: l.depthMm, actions: l.actions.slice(0, MAX_KEYS) })),
    };
  }

  function describe(entry) {
    const keys = entry.keys.filter((k) => k !== 'none');
    return `DKS, ${entry.levels.length} level${entry.levels.length === 1 ? '' : 's'} `
      + `(${entry.levels.map((l) => l.depthMm.toFixed(2)).join(' / ')} mm): ${keys.join(', ') || 'no keys'}`;
  }

  App.dksEditor = { mount, load, value, describe, setLive };
})();
