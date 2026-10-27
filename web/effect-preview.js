// Effects view: the drawn keyboard plays the picked effect, fed by your real key
// depth, so you can see an effect before applying it. Uses ports of the
// firmware's own effect code (fx-core.js, pfx-core.js, droplet-core.js), so it
// shows what the open firmware draws. On stock firmware only Droplet previews
// (the stock animations are Attack Shark's and not reproduced here).
(() => {
  const App = (window.App = window.App || {});
  App.views = App.views || {};
  const DROPLET = 0x42, LIVE = 0x41, USERPIC = 13;
  const TRAVEL_MM = 4.0;                       // firmware depth 1.0 = full_travel_cmm (4 mm)
  const PRESETS = [[255, 0, 0], [255, 128, 0], [255, 255, 0], [0, 255, 0], [0, 255, 255], [0, 0, 255], [255, 0, 255]];

  const depth = new Map();   // slot -> mm
  const speed = new Map();   // slot -> fastest press since the last frame, travels/s
  const last = new Map();    // slot -> { mm, t }
  let src = null, raf = 0;
  let slots = [], pos = [], col = [], row = [], geo = null;
  let drop = null, fx = null, pfx = null, outBuf = [];
  let lastMode = -1;

  const form = () => App.$('#light-form').elements;
  const mode = () => Number(form().mode.value);
  const custom = () => Boolean(App.st.info?.custom);
  const previewable = (m) => (custom() ? m !== LIVE && m !== USERPIC : m === DROPLET);
  const active = () => App.st.view === 'lighting' && previewable(mode());

  // Key centres in key units from the drawn board (rows 1..5 like the firmware).
  function measure() {
    const unit = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--u'));
    const gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--gap')) || 5;
    const board = App.$('#keyboard').getBoundingClientRect();
    slots = [...App.keyEls.keys()];
    pos = slots.map((s) => {
      const r = App.keyEls.get(s).getBoundingClientRect();
      return { col: (r.left + r.width / 2 - board.left) / (unit + gap) - 0.5, row: (r.top + r.height / 2 - board.top) / (unit + gap) + 0.5 };
    });
    col = pos.map((p) => Math.max(0, Math.round(p.col)));   // the firmware's LED map is whole key units
    row = pos.map((p) => Math.max(1, Math.round(p.row)));
    geo = { col, row, maxCol: Math.max(...col, 1), maxRow: Math.max(...row, 1) };
    drop = window.DropletCore.createState(slots.length);
    fx = window.FxCore.fxCreate(slots.length);
    pfx = window.PfxCore.create();
    outBuf = slots.map(() => [0, 0, 0]);
  }

  // the effect parameters the keyboard would get from this form
  function params() {
    const f = form(), kind = f.colourKind.value, v = parseInt(f.color.value.slice(1), 16);
    const p = { mode: mode(), speed: Number(f.speed.value), brightness: Number(f.brightness.value),
      direction: $optionShown() ? Number(f.option.value) : 0, flag: 7, r: 0, g: 0, b: 0 };
    if (kind === 'rainbow') p.flag = 8;
    else if (kind === 'preset') { p.flag = 7; [p.r, p.g, p.b] = PRESETS[Number(f.presetColour.value)] ?? [255, 255, 255]; }
    else { p.r = Math.min(v >> 16, 0xfa); p.g = Math.min((v >> 8) & 0xff, 0xfa); p.b = Math.min(v & 0xff, 0xfa); }
    return p;
  }
  const $optionShown = () => !App.$('#option-row').hidden;

  function frame(t) {
    raf = requestAnimationFrame(frame);
    if (!active() || !geo) return;
    const p = params(), tMs = Math.floor(t);
    if (p.mode !== lastMode) { fx = window.FxCore.fxCreate(slots.length); lastMode = p.mode; }
    const d = slots.map((s) => Math.min((depth.get(s) ?? 0) / TRAVEL_MM, 1));
    let out = outBuf;
    if (p.mode === DROPLET) {
      const base = p.flag === 7 ? [p.r, p.g, p.b] : [0, 0, 0];
      out = window.DropletCore.render(drop, slots.map((s) => Math.min((depth.get(s) ?? 0) / 3.6, 1)), pos, base, p.brightness, t);
    } else if (window.PfxCore.handles(p.mode)) {
      const act = slots.map((s) => (App.st.switches[s]?.actuation ?? 1.2) / TRAVEL_MM);
      const input = { depth: d, vdown: slots.map((s) => speed.get(s) ?? 0), act,
        on: d.map((x, i) => (x >= act[i] ? 1 : 0)),
        gauge: slots.map((s) => (['W', 'A', 'S', 'D'].includes(App.keyEls.get(s).dataset.name) ? 1 : 0)) };
      window.PfxCore.render(pfx, p, input, col, row, slots.length, tMs, out);
    } else if (window.FxCore.fxHandles(p.mode)) {
      window.FxCore.fxRender(fx, p, d, col, row, slots.length, tMs, out);
    } else {
      window.FxCore.ledEffects(p, tMs, slots.length, geo, out);
    }
    speed.clear();
    slots.forEach((s, i) => {
      const el = App.keyEls.get(s);
      const [r, g, b] = out[i];
      const lit = r + g + b > 0;
      el.style.background = lit ? `rgb(${Math.max(r, 35)}, ${Math.max(g, 38)}, ${Math.max(b, 46)})` : 'var(--cap)';
      el.style.boxShadow = lit ? `0 0 ${8 + (r + g + b) / 30}px rgba(${r}, ${g}, ${b}, 0.65)` : '';
      el.style.color = r + g + b > 450 ? '#111' : '';
    });
  }

  function onDepth(slot, mm) {
    const now = performance.now(), prev = last.get(slot);
    if (prev && now > prev.t && mm > prev.mm) {          // press speed for Impact / Sparks / Paint
      const v = (mm - prev.mm) / TRAVEL_MM / ((now - prev.t) / 1000);
      if (v > (speed.get(slot) ?? 0)) speed.set(slot, v);
    }
    last.set(slot, { mm, t: now });
    if (mm > 0) depth.set(slot, mm); else depth.delete(slot);
  }

  function start() {
    measure();
    if (!src) {
      src = new EventSource('/api/travel');
      src.onmessage = (e) => { const { slot, mm } = JSON.parse(e.data); onDepth(slot, mm); };
    }
    if (!raf) raf = requestAnimationFrame(frame);
  }

  function stop() {
    if (!src && !raf) return;
    src?.close();
    src = null;
    cancelAnimationFrame(raf);
    raf = 0;
    depth.clear(); speed.clear(); last.clear();
    App.keyEls.forEach((el) => { el.style.boxShadow = ''; el.style.color = ''; });
    App.paintKeys();
  }

  const sync = () => setTimeout(() => (active() ? start() : stop()), 0);

  function init() {
    form().mode.addEventListener('change', sync);
    App.$$('button[data-view]').forEach((b) => b.addEventListener('click', sync));
    window.addEventListener('resize', () => { if (active()) setTimeout(measure, 200); });
  }

  App.views.lighting = {
    init,
    // the preview loop owns the key colours while it runs
    paint: (slot, el) => { if (!active()) return false; App.$('.val', el).textContent = ''; return true; },
    simulate: onDepth,    // for testing without a hand on the keys
    selection: sync,
  };
})();
