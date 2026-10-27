// Puts the switch view (switch-viz.js) next to the travel sliders: Actuation,
// Rapid trigger and the gamepad's Response settings. Redraws when a value
// changes; with exactly one key selected the keycap follows that key live, with
// none selected whichever key was pressed last (and is still down). Idle: at rest.
(() => {
  const App = (window.App = window.App || {});
  const TRAVEL = 3.5;                                   // the firmware's full travel (mm)
  const C = { act: '#ff8a3d', rel: '#4aa3ff', dead: '#8a8f98', rt: '#2ecc71', full: '#e056fd', btn: '#ffd166' };
  let sw, pad, sig = '', src = null;
  const down = new Map();                               // slot -> mm of the keys held now, last moved last

  const num = (f, n) => Number(f.elements[n]?.value ?? 0);

  function switchModel() {
    const f = App.$('#switch-form'), view = App.st.view;
    const act = num(f, 'actuation'), rel = num(f, 'release'), dz = num(f, 'deadZone');
    const rt = f.elements.rapidTrigger?.checked, cont = f.elements.continuousRt?.checked;
    const m = { travel: TRAVEL, ...liveNow(), lines: [], zones: [], arrows: [] };
    if (view === 'rt') {
      const press = num(f, 'rtPress'), up = num(f, 'rtRelease');
      m.lines.push({ mm: act, label: `fires first at ${act.toFixed(2)} mm`, color: C.act });
      if (rt) {
        m.zones.push({ from: cont ? 0.1 : act, to: TRAVEL, label: cont ? 'rapid trigger: whole press' : 'rapid trigger: below the actuation point', color: C.rt });
        const mid = Math.min(TRAVEL - press - 0.05, Math.max(act + 0.6, 1.8));
        m.arrows.push({ at: mid, mm: press, label: `${press.toFixed(2)} down: fires`, color: C.act, x: 150 });
        m.arrows.push({ at: mid + press + 0.6, mm: up, up: true, label: `${up.toFixed(2)} up: lets go`, color: C.rel, x: 150 });
      } else m.lines.push({ mm: act + 0.0001, label: 'rapid trigger off', color: C.dead, dashed: true });
    } else {
      m.lines.push({ mm: act, label: `actuation ${act.toFixed(2)} mm`, color: C.act });
      m.lines.push({ mm: rel, label: `release ${rel.toFixed(2)} mm`, color: C.rel, dashed: true });
      if (dz > 0) m.zones.push({ from: TRAVEL - dz, to: TRAVEL, label: `dead zone ${dz.toFixed(2)} mm`, color: C.dead });
    }
    return m;
  }

  function padModel() {
    const f = App.$('#analog-settings');
    const dz = num(f, 'deadzoneMm'), full = num(f, 'fullMm'), btn = num(f, 'buttonMm');
    return { travel: TRAVEL, ...liveNow(),
      zones: dz > 0 ? [{ from: 0, to: dz, label: `dead zone ${dz.toFixed(2)} mm`, color: C.dead }] : [],
      lines: [{ mm: full, label: `full stick ${full.toFixed(2)} mm`, color: C.full }, { mm: btn, label: `buttons ${btn.toFixed(2)} mm`, color: C.btn, dashed: true }],
      arrows: [] };
  }

  // live key depths: the board's travel stream (a RAM flag on the keyboard) stays
  // open while one of these pages is shown
  function live(on) {
    if (on && !src) {
      src = new EventSource('/api/travel');
      src.onmessage = (e) => {
        const { slot, mm } = JSON.parse(e.data);
        down.delete(slot);                              // re-added at the end: the latest mover
        if (mm > 0.02) down.set(slot, mm);
      };
    } else if (!on && src) { src.close(); src = null; down.clear(); }
  }

  // one key selected: that key; none: the last key moved that is still down (named)
  function liveNow() {
    const sel = [...App.st.selected];
    if (sel.length === 1) return { live: down.get(sel[0]) ?? null };
    const last = sel.length ? null : [...down].pop();
    return last ? { live: last[1], name: App.keyEls.get(last[0])?.dataset.name ?? `slot ${last[0]}` } : { live: null };
  }

  function tick() {
    const view = App.st?.view;
    const onSwitch = view === 'actuation' || view === 'rt';
    live(onSwitch || view === 'analog');
    let m = null, target = null;
    if (onSwitch && sw) { m = switchModel(); target = sw; } else if (view === 'analog' && pad) { m = padModel(); target = pad; }
    if (!m) return;
    const s = JSON.stringify(m) + view;
    if (s !== sig) { sig = s; target.draw(m); }
  }

  function mount(formSel, afterSel, id) {
    const f = App.$(formSel);
    if (!f) return null;
    const box = Object.assign(document.createElement('div'), { className: 'switch-viz-box', id });
    (afterSel ? App.$(afterSel, f) : f.firstElementChild).after(box);
    return App.switchViz(box);
  }

  App.views.switchVizPanels = {
    init() {
      sw = mount('#switch-form', '#switch-note', 'sv-switch');
      pad = mount('#analog-settings', 'h2', 'sv-pad');
      setInterval(tick, 50);
    },
  };
})();
