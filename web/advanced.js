// Advanced keys page: snap tap, mod-tap, toggle and DKS on the selected key.
(() => {
  const App = (window.App = window.App || {});
  App.views = App.views || {};

  const BADGE = { snap: 'SNAP', modtap: 'MT', toggle: 'TGL', toggleRepeat: 'TGL+', dks: 'DKS' };
  const CELLS = [['0', '–'], ['1', 'Tap'], ['2', 'Press'], ['3', 'Hold']];
  let list = [];
  let loaded = false;
  let tracker;
  let pickingPartner = false;

  const bySlot = (slot) => list.find((k) => k.slot === slot);
  const levelsOn = () => (App.st.features ?? []).includes('dksLevels');
  const keyName = (slot) => App.keyEls.get(slot)?.dataset.name ?? `slot ${slot}`;
  const current = () => [...App.st.selected][0];

  async function load() {
    try {
      list = (await App.api('POST', '/api/advanced/list')).keys;
      loaded = true;
      App.ui.showError(App.$('#adv-form'), null);
      App.paintKeys();
      selection();
      showActive();
    } catch (e) {
      App.ui.showError(App.$('#adv-form'), `Could not read the advanced keys: ${e.message}`);
    }
  }

  function paint(slot, el) {
    const a = bySlot(slot);
    const sel = App.st.selected.has(slot);
    const f = App.$('#adv-form');
    const partner = f.elements.type.value === 'snap' && Number(f.elements.partner.value) === slot && current() !== undefined;
    App.$('.val', el).textContent = a ? BADGE[a.kind] : '';
    el.classList.toggle('sel', sel);
    el.classList.toggle('partner', partner && !sel);
    el.style.background = a ? 'var(--cap-marked)' : 'var(--cap)';
    return true;
  }

  function keyDown(slot) {
    const f = App.$('#adv-form');
    if (pickingPartner) {
      if (slot !== current() && f.elements.partner.value !== String(slot)) {
        f.elements.partner.value = slot;
        tracker.mark();
      }
      setPicking(false);
      App.paintKeys();
      return true;
    }
    if (slot === current()) return true;
    if (tracker.dirty && !App.ui.confirmLeave()) return true;
    App.st.selected = new Set([slot]);
    App.onSelectionChange();
    return true;
  }

  function setPicking(on) {
    pickingPartner = on;
    const b = App.$('#adv-pick-partner');
    if (b) b.textContent = on ? 'Now click the partner key on the board…' : 'Pick it on the board';
    document.body.classList.toggle('picking', on);
  }

  function describe(a) {
    if (!a) return 'A plain key: no advanced function yet.';
    if (a.kind === 'snap') return `Now: snap tap with ${keyName(a.partner)}`;
    if (a.kind === 'modtap') return `Now: mod-tap, hold for ${a.keys[0]} (after ${a.holdMs} ms), tap for ${a.keys[1]}`;
    if (a.kind.startsWith('toggle')) return `Now: toggles ${a.keys[0]}${a.kind === 'toggleRepeat' ? ', repeating while on' : ''}`;
    if (a.levels) return `Now: ${App.dksEditor.describe(a)}`;
    return `Now: DKS ${a.firstPointMm}–${a.secondPointMm} mm: ${a.keys.filter((k) => k !== 'none').join(', ')}`;
  }

  function showType(type) {
    const f = App.$('#adv-form');
    f.elements.type.value = type;
    App.$$('[data-adv]', f).forEach((el) => { el.hidden = el.dataset.adv !== type; });
    App.$$('[data-type]', f).forEach((b) => b.classList.toggle('on', b.dataset.type === type));
    const slot = current();
    App.dksEditor.setLive(type === 'dks' && levelsOn() && slot !== undefined && App.st.view === 'advanced' ? slot : null);
    if (type !== 'snap') setPicking(false);
    App.paintKeys();
  }

  function selection() {
    const { st, $ } = App;
    const slot = current();
    const f = $('#adv-form');
    $('#adv-title').textContent = slot === undefined ? 'Click a key on the board' : keyName(slot);
    $('#adv-now').textContent = slot === undefined ? 'Then choose what extra it should do.' : (loaded ? describe(bySlot(slot)) : 'Reading the advanced keys…');
    tracker.setReady(slot !== undefined && loaded, slot === undefined ? 'Click a key on the board first.' : 'Reading the advanced keys…');
    $('#dks2').hidden = !levelsOn();
    $('.dks-legacy', f).hidden = levelsOn();
    $('#adv-types').hidden = slot === undefined;
    if (slot === undefined) { App.$$('[data-adv]', f).forEach((el) => { el.hidden = true; }); App.dksEditor.setLive(null); return; }
    const a = bySlot(slot);
    if (levelsOn()) App.dksEditor.load(a?.kind === 'dks' ? a : null, keyName(slot));
    const sw = st.switches[slot];
    f.elements.first.value = a?.firstPointMm ?? 0.5;
    f.elements.second.value = a?.secondPointMm ?? sw?.actuation ?? 2;
    f.elements.holdMs.value = a?.holdMs ?? 200;
    f.elements.hold.value = a?.kind === 'modtap' ? a.keys[0] : keyName(slot);
    f.elements.tap.value = a?.kind === 'modtap' ? a.keys[1] : '';
    f.elements.toggleKey.value = a?.kind?.startsWith('toggle') ? a.keys[0] : keyName(slot);
    f.elements.repeat.checked = a?.kind === 'toggleRepeat';
    f.elements.partner.value = a?.kind === 'snap' ? a.partner : '';
    for (let i = 0; i < 4 && !a?.levels; i++) {
      f.elements[`dk${i}`].value = a?.kind === 'dks' && a.keys[i] !== 'none' ? a.keys[i] : (i === 0 ? keyName(slot) : '');
      for (let c = 0; c < 4; c++) f.elements[`dc${i}${c}`].value = a?.kind === 'dks' ? a.cells[i][c] : (i === 0 && c === 0 ? 2 : 0);
    }
    showType(a?.kind ? (a.kind.startsWith('toggle') ? 'toggle' : a.kind) : 'none');
  }

  // the "Active advanced keys" list under the form
  function showActive() {
    if (!loaded) return;
    App.advActive.render(App.$('#adv-active'), list, {
      name: keyName,
      selected: current(),
      select: (slot) => { setPicking(false); keyDown(slot); },
      remove,
    });
  }

  // × in the list: make the key plain again (a snap tap pair clears both keys)
  async function remove(slot) {
    if (tracker.dirty && !App.ui.confirmLeave()) return;
    const el = App.$('#adv-active');
    await App.busy(el, 'Removing…', async () => {   // busy shows any error itself
      const res = await App.api('POST', '/api/advanced/set', { slot, type: 'clear' });
      list = res.keys;
      App.applyState(res.state);
      App.toast(`${keyName(slot)} is a plain key again`);
    });
    showActive();
  }

  function body(slot) {
    const e = App.$('#adv-form').elements;
    const type = e.type.value;
    if (type === 'none') return { slot, type: 'clear' };
    if (type === 'snap') {
      if (e.partner.value === '') throw new Error('Choose the partner key first');
      return { slot, type, partner: Number(e.partner.value) };
    }
    if (type === 'modtap') return { slot, type, hold: e.hold.value.trim(), tap: e.tap.value.trim(), holdMs: Number(e.holdMs.value) };
    if (type === 'toggle') return { slot, type, key: e.toggleKey.value.trim(), repeat: e.repeat.checked };
    if (levelsOn()) return { slot, type, ...App.dksEditor.value() };
    const bindings = [];
    for (let i = 0; i < 4; i++) {
      const key = e[`dk${i}`].value.trim();
      if (key) bindings.push({ key, cells: [0, 1, 2, 3].map((c) => Number(e[`dc${i}${c}`].value)) });
    }
    return { slot, type, firstPointMm: Number(e.first.value), secondPointMm: Number(e.second.value), bindings };
  }

  function init() {
    const { $, api } = App;
    const f = $('#adv-form');
    const grid = $('#dks-grid');
    for (let i = 0; i < 4; i++) {
      const row = document.createElement('div');
      row.className = 'dks-row';
      row.innerHTML = `<input name="dk${i}" list="key-choices" placeholder="${i ? '(none)' : 'key'}" spellcheck="false">`
        + [0, 1, 2, 3].map((c) => `<select name="dc${i}${c}" aria-label="binding ${i + 1} event ${c + 1}">`
          + CELLS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('') + '</select>').join('');
      grid.append(row);
    }
    for (const n of ['hold', 'tap', 'toggleKey']) App.ui.keyPicker(f.elements[n], { only: 'keyboard' });
    const pickBtn = Object.assign(document.createElement('button'), { type: 'button', id: 'adv-pick-partner', textContent: 'Pick it on the board' });
    pickBtn.onclick = () => setPicking(!pickingPartner);
    f.elements.partner.closest('label').after(pickBtn);
    f.elements.partner.addEventListener('change', () => App.paintKeys());
    App.$$('[data-type]', f).forEach((b) => {
      b.onclick = () => {
        if (f.elements.type.value === b.dataset.type) return;
        showType(b.dataset.type);
        tracker.mark();
      };
    });
    App.dksEditor.mount($('#dks2'), () => tracker.mark());
    tracker = App.ui.track(f, {
      async save() {
        const slot = current();
        const res = await api('POST', '/api/advanced/set', body(slot));
        list = res.keys;
        App.applyState(res.state);
        App.st.selected = new Set([slot]);
        App.onSelectionChange();
        App.toast(describe(bySlot(slot)).replace(/^Now: /, ''));
      },
      discard() { setPicking(false); selection(); },
    });
    // the live depth stream only runs while this page is open
    window.addEventListener('pagechange', (e) => { if (e.detail !== 'advanced') { App.dksEditor.setLive(null); setPicking(false); } });
  }

  function fillPartners() {
    const sel = App.$('#adv-form').elements.partner;
    if (sel.options.length) return;
    sel.add(new Option('— choose a key —', ''));
    [...App.keyEls.entries()].sort((a, b) => a[0] - b[0])
      .forEach(([slot, el]) => sel.add(new Option(el.dataset.name, slot)));
  }

  App.views.advanced = {
    init,
    paint,
    keyDown,
    selection: () => { fillPartners(); if (!loaded) load(); selection(); showActive(); },
  };
})();
