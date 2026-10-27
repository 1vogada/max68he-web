// Output picker for the Key wizard: what one answer does, from the gamepad (the palette's chips),
// a keyboard key (the key picker) or the mouse, or nothing. Value = a rule's `do` (see
// key-actions-core.js) or null. App.kaPicker(el, { value, onChange, depth }) -> { set(value) };
// depth() gives the { from, to } a stick that grows with the press starts with.
(() => {
  const App = (window.App = window.App || {});
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const KEYS = ['LShift', 'LCtrl', 'LAlt', 'Space', 'E', 'R', 'F', 'Q', 'C', 'Tab', 'Esc', 'Enter'];
  const MOUSE = [['Left click', { mouse: 'L' }], ['Right click', { mouse: 'R' }], ['Middle click', { mouse: 'M' }],
    ['Wheel ↑', { wheel: 1 }], ['Wheel ↓', { wheel: -1 }]];
  const KIND_TAB = { key: 'keyboard', gamepad: 'gamepad', axis: 'gamepad', axisDepth: 'gamepad', mouse: 'mouse', move: 'mouse', glide: 'mouse', wheel: 'mouse' };

  // palette target ('ly-', 'a', 'up') <-> the map's names ('LY-', 'A', 'Up')
  function fromTarget(t, prev) {
    const C = App.keyActions;
    const axis = C.AXES.find((a) => a.toLowerCase() === t);
    if (axis) {
      if (prev && 'from' in prev) return { axis, from: prev.from, to: prev.to };
      return { axis, percent: prev?.percent ?? 100 };
    }
    const b = C.BUTTONS.find((x) => x.toLowerCase() === t);
    return b ? { gamepad: b } : null;
  }
  const targetOf = (v) => (v?.axis ?? v?.gamepad ?? '').toLowerCase();
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  App.kaPicker = (el, { value = null, onChange = () => {}, depth = () => ({ from: 0.3, to: 3.5 }) } = {}) => {
    const C = App.keyActions;
    let v = value;
    let tab = v ? KIND_TAB[C.outputKind(v)] : 'none';
    el.innerHTML = `<div class="kap"><div class="seg-tabs kap-tabs" role="group" aria-label="What it does">
      <button type="button" data-tab="none">Nothing</button><button type="button" data-tab="gamepad">Gamepad</button><button type="button" data-tab="keyboard">Keyboard key</button><button type="button" data-tab="mouse">Mouse</button></div>
      <div class="kap-pane"></div></div>`;
    const pane = el.querySelector('.kap-pane');

    const change = (next) => { if (same(next, v)) return; v = next; draw(); onChange(v); };

    function gamepadPane() {
      const L = App.gpChips?.LABEL ?? {};
      const groups = (App.gpChips?.GROUPS ?? []).filter(([g]) => g !== 'Mouse');
      const kind = C.outputKind(v);
      const axis = kind === 'axis' || kind === 'axisDepth';
      const d = kind === 'axisDepth' ? v : depth();
      return `<div class="gp-palette">${groups.map(([g, ts]) => `<div class="gp-group"><span>${g}</span>${ts.map((t) =>
        `<button type="button" class="gp-chip${targetOf(v) === t ? ' armed' : ''}" data-t="${t}" aria-pressed="${targetOf(v) === t}">${esc(L[t] ?? t)}</button>`).join('')}</div>`).join('')}</div>
        ${axis ? `<div class="kap-axis">
          <label${kind === 'axisDepth' ? ' hidden' : ''}>How far <output>${v.percent ?? 100} %</output>
            <input type="range" name="kapPct" min="1" max="100" step="1" value="${v.percent ?? 100}"></label>
          <label class="row"><input type="checkbox" name="kapGrow"${kind === 'axisDepth' ? ' checked' : ''}> Grow with the press depth</label>
          <span class="row kap-grow"${kind === 'axisDepth' ? '' : ' hidden'}>from <input type="number" name="kapFrom" min="0" max="3.9" step="0.1" value="${d.from}">
            to <input type="number" name="kapTo" min="0.1" max="4" step="0.1" value="${d.to}"> mm</span>
        </div>` : ''}`;
    }

    function keyboardPane() {
      const cur = v?.key ?? '';
      return `<div class="kap-chips">${KEYS.map((k) => `<button type="button" class="gp-chip${cur === k ? ' armed' : ''}" data-key="${k}" aria-pressed="${cur === k}">${esc(k.replace(/^L(?=Shift|Ctrl|Alt)/, ''))}</button>`).join('')}</div>
        <label>Or any key <input name="kapKey" spellcheck="false" placeholder="type or pick: E, LShift, Ctrl+C…" value="${esc(cur)}"></label>`;
    }

    function mousePane() {
      const mv = v?.move ?? v?.glide ?? [0, 0];
      return `<div class="kap-chips">${MOUSE.map(([l, d], i) => `<button type="button" class="gp-chip${same(d, v) ? ' armed' : ''}" data-m="${i}" aria-pressed="${same(d, v)}">${l}</button>`).join('')}</div>
        <div class="kap-move"><span class="muted small">Or move the pointer</span>
          <span class="row">right <input type="number" name="kapDx" min="-508" max="508" step="1" value="${mv[0]}"> down <input type="number" name="kapDy" min="-508" max="508" step="1" value="${mv[1]}"> px
          over <input type="number" name="kapMs" min="0" max="2550" step="10" value="${v?.glide ? v.ms : 0}"> ms</span>
          <button type="button" class="kap-usemove">Use this move</button>
          <span class="muted small">0 ms jumps at once (up to 127 px); a time glides (up to 508 px, 2.55 s). Negative goes left / up.</span></div>`;
    }

    function draw() {
      el.querySelectorAll('[data-tab]').forEach((b) => { b.classList.toggle('on', b.dataset.tab === tab); b.setAttribute('aria-pressed', b.dataset.tab === tab); });
      pane.innerHTML = tab === 'gamepad' ? gamepadPane() : tab === 'keyboard' ? keyboardPane() : tab === 'mouse' ? mousePane()
        : '<p class="muted small">Nothing happens here. Pick Gamepad, Keyboard key or Mouse to give it something to do.</p>';
      const key = pane.querySelector('[name=kapKey]');
      if (key) App.ui.keyPicker(key, { only: 'keyboard' });
    }

    el.querySelector('.kap-tabs').onclick = (e) => {
      const b = e.target.closest('[data-tab]');
      if (!b) return;
      tab = b.dataset.tab;
      if (tab === 'none') change(null); else draw();
    };
    pane.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-t], [data-key], [data-m]');
      if (chip?.dataset.t) change(fromTarget(chip.dataset.t, C.outputKind(v)?.startsWith('axis') ? v : null));
      else if (chip?.dataset.key) change({ key: chip.dataset.key });
      else if (chip?.dataset.m) change({ ...MOUSE[Number(chip.dataset.m)][1] });
      if (e.target.closest('.kap-usemove')) {
        const n = (k) => Math.round(Number(pane.querySelector(`[name=${k}]`).value) || 0);
        const [dx, dy, ms] = [n('kapDx'), n('kapDy'), n('kapMs')];
        if (!dx && !dy) return App.toast('Give the move a distance first', true);
        if (ms > 0) change({ glide: [dx, dy].map((x) => Math.max(-512, Math.min(508, x))), ms: Math.max(10, Math.min(2550, ms)) });
        else change({ move: [dx, dy].map((x) => Math.max(-128, Math.min(127, x))) });
      }
    });
    pane.addEventListener('input', (e) => {
      const t = e.target;
      if (t.name === 'kapPct') { t.previousElementSibling.textContent = `${t.value} %`; v = { axis: v.axis, percent: Number(t.value) }; onChange(v); }
      if (t.name === 'kapFrom' || t.name === 'kapTo') {
        const f = Number(pane.querySelector('[name=kapFrom]').value), to = Number(pane.querySelector('[name=kapTo]').value);
        v = { axis: v.axis, from: f, to };
        onChange(v);
      }
    });
    pane.addEventListener('change', (e) => {
      const t = e.target;
      if (t.name === 'kapGrow') change(t.checked ? { axis: v.axis, ...depth() } : { axis: v.axis, percent: 100 });
      if (t.name === 'kapKey') { const k = t.value.trim(); if (k) change({ key: k }); }
    });
    draw();
    return { set(next) { v = next; tab = v ? KIND_TAB[C.outputKind(v)] : 'none'; draw(); } };
  };
})();
