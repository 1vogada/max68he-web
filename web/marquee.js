// Selection rectangle on the drawn keyboard, like on a desktop: press on empty space
// in or around the board and drag; every key the rectangle touches is selected live.
// Plain drag replaces the selection, Ctrl / Shift + drag adds to it, a click on empty
// space clears it. Presses that start on a key stay with app.js.
// Pages that select many keys (Actuation, Rapid trigger) always have it. With the
// Settings toggle "Selection box on every keyboard" every page with a drawn board has
// it: the box only marks the keys it touches, and on release the page gets them the
// way a click does: keyDown for the top-left one (it opens that key's panel), and
// keyDrag for the rest where the page takes drags (Per-key colour paints them all).
(() => {
  const App = (window.App = window.App || {});
  const MOVE = 4;                 // px a press must travel before it becomes a drag
  // Empty space: the stage and board backgrounds, rows and blank key gaps, never text or controls.
  const EMPTY = '.stage, .stage-head, .board-wrap, .keyboard, .krow, .key.empty, .key.empty *';

  let drag = null;                // { id, x0, y0 (stage coords), x, y (client), base, hit, box, moved }

  const stage = () => document.querySelector('.stage');
  // 'multi': the box edits st.selected; 'one': it marks keys and hands them over on release.
  const mode = () => {
    const v = App.st?.view;
    const hooks = App.views?.[v];
    if (!App.st || !document.querySelector('.board-wrap')?.offsetWidth) return null;   // no board on this page
    if (!hooks?.keyDown && (['actuation', 'rt'].includes(v) || !!hooks?.multiSelect)) return 'multi';
    return App.prefs?.get('marqueeEverywhere') ? 'one' : null;
  };

  function rectNow() {            // the rectangle in client coords, clipped to the stage
    const s = stage().getBoundingClientRect();
    const cx = Math.min(Math.max(drag.x, s.left), s.right), cy = Math.min(Math.max(drag.y, s.top), s.bottom);
    const ax = drag.x0 + s.left, ay = drag.y0 + s.top;
    return { left: Math.min(ax, cx), top: Math.min(ay, cy), right: Math.max(ax, cx), bottom: Math.max(ay, cy), s };
  }

  function update() {
    const r = rectNow();
    Object.assign(drag.box.style, { left: `${r.left - r.s.left}px`, top: `${r.top - r.s.top}px`,
      width: `${r.right - r.left}px`, height: `${r.bottom - r.top}px` });
    const hit = new Set();
    for (const [slot, el] of App.keyEls) {
      if (!App.st.switches[slot]) continue;
      const k = el.getBoundingClientRect();
      if (k.left < r.right && k.right > r.left && k.top < r.bottom && k.bottom > r.top) hit.add(slot);
    }
    if (hit.size === drag.hit.size && [...hit].every((x) => drag.hit.has(x))) return;
    drag.hit = hit;
    if (drag.mode === 'one') { for (const [slot, el] of App.keyEls) el.classList.toggle('marquee-hit', hit.has(slot)); return; }
    // st.selected is shared by reference: change it in place.
    App.st.selected.clear();
    for (const x of drag.base) App.st.selected.add(x);
    for (const x of hit) App.st.selected.add(x);
    App.onSelectionChange();
  }

  function down(e) {
    const m = !drag && e.button === 0 && e.target.matches(EMPTY) && mode();
    if (!m) return;
    const s = stage().getBoundingClientRect();
    drag = { mode: m, id: e.pointerId, x0: e.clientX - s.left, y0: e.clientY - s.top, x: e.clientX, y: e.clientY,
      add: e.ctrlKey || e.shiftKey || e.metaKey, base: null, hit: new Set(), box: null, moved: false };
    e.preventDefault();           // no text selection, no focus change
    try { stage().setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
  }

  function move(e) {
    if (e.pointerId !== drag?.id) return;
    drag.x = e.clientX; drag.y = e.clientY;
    if (!drag.moved) {
      const s = stage().getBoundingClientRect();
      if (Math.hypot(e.clientX - s.left - drag.x0, e.clientY - s.top - drag.y0) < MOVE) return;
      drag.moved = true;
      drag.base = drag.add ? new Set(App.st.selected) : new Set();
      drag.box = Object.assign(document.createElement('div'), { className: 'marquee' });
      stage().append(drag.box);
    }
    update();
  }

  function up(e) {
    if (e.pointerId !== drag?.id) return;
    const d = drag;
    drag = null;
    d.box?.remove();
    if (stage().hasPointerCapture(e.pointerId)) stage().releasePointerCapture(e.pointerId);
    if (d.mode === 'one') return handOver(d, e);
    // A plain click on empty space clears the selection; a cancelled touch leaves it alone.
    if (!d.moved && e.type === 'pointerup' && !d.add && App.st.selected.size) { App.st.selected.clear(); App.onSelectionChange(); }
  }

  // Single-key pages: the touched keys go to the page as clicks would, top-left first.
  function handOver(d, e) {
    App.keyEls.forEach((el) => el.classList.remove('marquee-hit'));
    if (!d.moved || e.type !== 'pointerup' || !d.hit.size) return;
    const at = (slot) => App.keyEls.get(slot).getBoundingClientRect();
    const [first, ...rest] = [...d.hit].sort((a, b) => Math.round(at(a).top - at(b).top) || at(a).left - at(b).left);
    const hooks = App.views?.[App.st.view];
    if (!hooks?.keyDown?.(first, e)) return;
    if (hooks.keyDrag) rest.forEach((slot) => hooks.keyDrag(slot));
  }

  // Touch can only draw a rectangle when the board isn't also needed for panning
  // (it fits its box); otherwise a finger on the board keeps scrolling as before.
  function touchMode() {
    const wrap = document.querySelector('.board-wrap');
    const fits = wrap && wrap.scrollWidth <= wrap.clientWidth + 1;
    stage()?.classList.toggle('marquee-touch', !!mode() && !!fits);
  }

  function init() {
    const s = stage();
    if (!s) return;
    s.addEventListener('pointerdown', down);
    s.addEventListener('pointermove', move);
    s.addEventListener('pointerup', up);
    s.addEventListener('pointercancel', up);
    // Page scroll during a drag: the anchor is in stage coords, so redraw from the last pointer spot.
    window.addEventListener('scroll', () => { if (drag?.moved) update(); }, true);
    window.addEventListener('pagechange', touchMode);
    window.addEventListener('prefschange', touchMode);
    new ResizeObserver(touchMode).observe(document.querySelector('.board-wrap'));
    touchMode();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
