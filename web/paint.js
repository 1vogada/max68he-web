// Paint view: colour keys and store them as one of the board's five pictures.
// The board cannot read pictures back, so each one is remembered in this browser.
(() => {
  const App = (window.App = window.App || {});
  App.views = App.views || {};

  const pictures = [0, 1, 2, 3, 4].map((i) => load(i));
  let saved = pictures.map((p) => new Map(p));   // what was last sent to the keyboard (or loaded)
  let current = 0;
  const undo = [];
  let tracker;

  function load(i) {
    try { return new Map(JSON.parse(localStorage.getItem(`max68he.pic.${i}`) || '[]')); } catch { return new Map(); }
  }
  function store(i) {
    try { localStorage.setItem(`max68he.pic.${i}`, JSON.stringify([...pictures[i]])); } catch { /* storage off */ }
  }

  const brush = () => App.$('#paint-form').elements.brush.value.slice(1);

  function paint(slot, el) {
    const hex = pictures[current].get(slot);
    App.$('.val', el).textContent = '';
    el.classList.remove('sel');
    el.style.background = hex ? `#${hex}` : 'var(--cap)';
    el.style.color = hex && luminance(hex) > 0.55 ? '#111' : '';
    return true;
  }

  function luminance(hex) {
    const v = parseInt(hex, 16);
    return (0.299 * (v >> 16) + 0.587 * ((v >> 8) & 0xff) + 0.114 * (v & 0xff)) / 255;
  }

  function snapshot() {
    undo.push({ pic: current, map: new Map(pictures[current]) });
    if (undo.length > 30) undo.shift();
    App.$('#paint-undo').disabled = false;
  }

  function changed() {
    store(current);
    App.paintKeys();
    const same = pictures[current].size === saved[current].size
      && [...pictures[current]].every(([k, v]) => saved[current].get(k) === v);
    if (same) tracker.clear(); else tracker.mark();
  }

  let stroke = false;
  function apply(slot) {
    const erase = App.$('#paint-form').elements.tool.value === 'erase';
    if (!stroke) { snapshot(); stroke = true; if (!erase) used(); }
    if (erase) pictures[current].delete(slot); else pictures[current].set(slot, brush());
    changed();
  }
  window.addEventListener('pointerup', () => { stroke = false; });

  // remember the brush colour once per stroke / fill (recent-colours.js)
  const used = () => App.recentColours?.push('paint', `#${brush()}`);

  function showActive() {
    const l = App.st.lighting;
    App.$('#paint-active').textContent = l?.mode === 13
      ? `The keyboard is showing picture ${l.option + 1} now.`
      : 'The keyboard is showing a lighting effect now; Save shows this picture instead.';
  }

  function init() {
    const { $, api } = App;
    const f = $('#paint-form');
    for (const el of [f.elements.picture, f.elements.brush, ...f.elements.tool]) el.dataset.nodirty = '1';
    f.elements.picture.onchange = () => {
      if (tracker.dirty && !confirm(`Picture ${current + 1} has changes that are not on the keyboard yet. Switch anyway? (They stay in this browser.)`)) {
        f.elements.picture.value = current; return;
      }
      current = Number(f.elements.picture.value);
      tracker.clear();
      changed();
    };
    // a recent swatch sets the brush and switches back from Erase to Paint
    App.recentColours?.mount($('.row-buttons', f), f.elements.brush, 'paint', () => { f.elements.tool.value = 'paint'; });
    $('#paint-fill').onclick = () => { snapshot(); used(); App.keyEls.forEach((_, slot) => pictures[current].set(slot, brush())); changed(); };
    $('#paint-clear').onclick = () => { snapshot(); pictures[current].clear(); changed(); };
    $('#paint-undo').onclick = () => {
      const u = undo.pop();
      if (u) { current = u.pic; f.elements.picture.value = current; pictures[current] = u.map; changed(); }
      $('#paint-undo').disabled = !undo.length;
    };
    tracker = App.ui.track(f, {
      saveLabel: 'Save & show on the keyboard',
      async save() {
        const colors = [...pictures[current]].filter(([slot]) => slot < 126);
        const { lighting } = await api('POST', '/api/picture', { picture: current, colors, show: true });
        App.st.lighting = lighting;
        saved[current] = new Map(pictures[current]);
        showActive();
      },
      discard() { snapshot(); pictures[current] = new Map(saved[current]); store(current); App.paintKeys(); },
    });
  }

  App.views.paint = {
    init,
    paint,
    keyDown: (slot) => { apply(slot); return true; },
    keyDrag: apply,
    selection: showActive,
  };
})();
