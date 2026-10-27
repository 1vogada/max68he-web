// Key wizard (Gamepad page, 4th tab): per key, what happens at which depth and after how long
// held (open firmware key action maps, caps 'keyActions'). Click a key, start from a template,
// answer plain questions (depth sliders on the switch gauge, a seconds slider for holds, outputs
// from the gamepad chips / key picker / mouse), check the summary, Save. Saves go through
// /api/key-actions and are undoable (App.history). The steps' HTML is in key-wizard-steps.js,
// the names / templates / sentences in key-actions-core.js. analog.js hands this module the
// board's clicks, painting and live depths while the tab is open.
(() => {
  const App = (window.App = window.App || {});
  App.views = App.views || {};
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const TRAVEL = 3.5;
  const COL = { light: '#4aa3ff', deep: '#ff8a3d', bottom: '#e056fd', press: '#8a8f98' };
  const C = () => App.keyActions;
  const S = () => App.kwSteps;
  const $ = (s, el) => App.$(s, el);

  const maps = new Map();                       // slot -> stored map (GET /api/key-actions)
  const W = { slot: null, name: '', step: 1, qi: 0, template: null, chosen: false, stored: null, draft: null,
    caps: false, live: null, moreOpen: false, get dirty() { return Boolean(tracker?.dirty); } };
  let tracker, gauge, visible = false, pressedAt = null, timer = null, previewTimer = null, previewSeq = 0, dragging = false;

  const reason = () => App.ui.firmwareReason('Key action maps');
  const blankDraft = () => ({ pressMm: C().DEFAULTS.pressMm, gapMm: C().DEFAULTS.gapMm, alsoType: false, answers: C().blankAnswers(), extra: [] });
  const specNow = () => C().answersToSpec({ slot: W.slot, ...W.draft });
  const strip = (m) => ({ slot: m.slot, press: m.press, gap: m.gap, alsoType: m.alsoType, rules: m.rules });
  const question = () => C().QUESTIONS[W.qi];
  const r05 = (v) => Math.round(v * 20) / 20;

  // ---- drawing -------------------------------------------------------------------------

  function render() {
    if (!visible) return;
    $('#kw-steps').innerHTML = S().stepsBar(W);
    const main = $('#kw-main');
    if (W.slot === null || W.step === 1) main.innerHTML = S().pickKey(W);
    else if (W.step === 2) main.innerHTML = S().templates(W);
    else if (W.step === 3) { main.innerHTML = S().question(W); mountPicker(); $('.kw-how', main).innerHTML = S().how(W); }
    else { main.innerHTML = S().summary(W, specNow()); checkPreview(); }
    $('#kw-key').textContent = W.slot === null ? 'no key yet' : `${W.name}${W.dirty ? ' · unsaved' : ''}`;
    $('#kw-gauge').classList.toggle('kw-drag', W.step === 3 && ['light', 'deep', 'bottom'].includes(question().id));
    drawGauge();
    readout();
  }

  function mountPicker() {
    const q = question(), a = W.draft.answers[q.id];
    const from = () => Math.min(3.4, Math.round((q.when === 'down' ? a.at : W.draft.pressMm) * 10) / 10);
    App.kaPicker($('#kw-main .kw-picker'), {
      value: a.do,
      depth: () => ({ from: from(), to: Math.max(from() + 0.1, 3.5) }),
      onChange: (d) => {
        a.do = d;
        if (d && !C().allowedModes(q.when, C().outputKind(d)).includes(a.mode)) a.mode = C().defaultMode({ when: q.when, do: d });
        changed();
        $('#kw-main .kw-how').innerHTML = S().how(W);
        $(`#kw-main .kw-dots [data-q="${W.qi}"]`)?.classList.toggle('set', Boolean(d));
      },
    });
  }

  // the switch gauge: a zone per answered depth, the line of the question being asked, live depth
  function gaugeModel() {
    const m = { travel: TRAVEL, live: W.live, name: W.name, lines: [], zones: [], arrows: [] };
    if (!W.draft || W.slot === null) return m;
    const a = W.draft.answers, cur = W.step === 3 ? question().id : null, p = W.draft.pressMm;
    const deepAt = a.deep.do ? a.deep.at : null, botAt = a.bottom.do ? a.bottom.at : null;
    const out = (d) => C().outputText(d);
    if (a.light.do) m.zones.push({ from: p, to: deepAt ?? botAt ?? TRAVEL, label: `light: ${out(a.light.do)}`, color: COL.light });
    if (a.deep.do) m.zones.push({ from: deepAt, to: botAt ?? TRAVEL, label: `deeper: ${out(a.deep.do)}`, color: COL.deep });
    if (a.bottom.do) m.zones.push({ from: botAt, to: TRAVEL, label: `bottom: ${out(a.bottom.do)}`, color: COL.bottom });
    m.lines.push({ mm: p, label: `${cur === 'light' ? '▶ ' : ''}pressed at ${C().mm(p)}`, color: COL.press, dashed: true });
    for (const id of ['deep', 'bottom']) {
      if (a[id].do || cur === id) m.lines.push({ mm: a[id].at, label: `${cur === id ? '▶ ' : ''}${C().mm(a[id].at)}`, color: COL[id], dashed: !a[id].do });
    }
    return m;
  }
  function drawGauge() { if (gauge && visible) gauge.draw(gaugeModel()); }

  // where the key is now, which answer that is, and how long it has been held
  function readout() {
    const el = $('#kw-live');
    if (!el) return;
    if (W.slot === null) { el.textContent = 'Pick a key; its live depth shows here.'; return; }
    if (W.live === null || pressedAt === null) { el.textContent = `Press ${W.name} to try it: the switch follows your finger.`; return; }
    const a = W.draft.answers, d = W.live;
    const zone = a.bottom.do && d >= a.bottom.at ? 'bottom' : a.deep.do && d >= a.deep.at ? 'deep' : 'light';
    const q = C().QUESTIONS.find((x) => x.id === zone), held = performance.now() - pressedAt;
    const what = a[zone].do ? C().actionText({ when: q.when, mode: a[zone].mode, do: a[zone].do }) : 'nothing';
    let text = `${W.name} at ${C().mm(d)}, held ${C().time(Math.round(held / 100) * 100)}. ${q.title}: ${what}.`;
    if (a.hold.do) text += held >= a.hold.ms ? ` Hold reached: ${C().actionText({ when: 'hold', mode: a.hold.mode, do: a.hold.do })}.` : ` In ${C().time(Math.ceil((a.hold.ms - held) / 100) * 100)}: ${C().outputText(a.hold.do)}.`;
    el.textContent = text;
  }

  function drawList() {
    const list = [...maps.values()].sort((x, y) => x.slot - y.slot);
    $('#kw-count').textContent = String(list.length);
    $('#kw-empty').hidden = list.length > 0 || !W.caps;
    $('#kw-maps').innerHTML = list.map((m) => `<li data-slot="${m.slot}"${m.slot === W.slot ? ' class="on"' : ''}><b>${esc(m.key ?? `slot ${m.slot}`)}</b>
      <span class="small">${esc(m.summary.join(' '))}</span>
      <span class="row-buttons"><button type="button" data-edit>Edit</button><button type="button" data-del${W.caps ? '' : ' disabled'}>Remove</button></span></li>`).join('');
    App.ui.gate($('#kw-list-gate'), W.caps ? null : reason());
  }

  // ---- talking to the keyboard ------------------------------------------------------------

  // after a write or an undo: the key on screen follows unless it has edits of its own
  function stored(slot, map) {
    if (map?.rules.length) maps.set(slot, map); else maps.delete(slot);
    if (slot === W.slot) {
      W.stored = maps.get(slot) ?? null;
      if (!W.dirty) { loadDraft(); if (W.step > 2 && !W.chosen) W.step = 2; }
    }
    drawList();
    if (App.st.view === 'analog') App.paintKeys();
    render();
  }
  async function write(spec) {
    const { map } = await App.api('POST', '/api/key-actions', spec);
    stored(map.slot, map);
    return map;
  }
  async function removeSlot(slot) {
    await App.api('DELETE', '/api/key-actions', { slot });
    stored(slot, null);
  }

  async function loadList() {
    W.caps = (App.st.features ?? []).includes('keyActions');
    App.ui.gate($('#kw-gate'), W.caps ? null : reason());
    maps.clear();
    if (W.caps) {
      try {
        const r = await App.api('GET', '/api/key-actions');
        r.maps.forEach((m) => maps.set(m.slot, m));
        App.ui.showError($('#kw-list'), null);
      } catch (e) { App.ui.showError($('#kw-list'), `Could not read the key action maps: ${e.message}`); }
    }
    if (W.slot !== null) { W.stored = maps.get(W.slot) ?? null; if (!W.dirty) loadDraft(); }
    drawList();
    if (App.st.view === 'analog' && visible) App.paintKeys();
    render();
  }

  async function save() {
    if (!W.caps) throw new Error(reason());
    const spec = specNow();
    if (!spec.rules.length) throw new Error('Answer at least one question first');
    const before = W.stored ? strip(W.stored) : null, slot = W.slot, name = W.name;
    tracker.clear();                            // the stored map becomes the draft again
    try { await write(spec); } catch (e) { tracker.mark(); throw e; }
    App.history?.push({ label: `action map on ${name}`, undo: () => (before ? write(before) : removeSlot(slot)), redo: () => write(spec) });
  }

  function removeMap(slot) {
    const m = maps.get(slot);
    if (!m || !confirm(`Remove the action map from ${m.key ?? `slot ${slot}`}? It goes back to typing its own key.`)) return;
    App.busy($('#kw-list'), 'Removing…', async () => {
      if (slot === W.slot) tracker.clear();
      await removeSlot(slot);
      App.history?.push({ label: `action map on ${m.key}`, undo: () => write(strip(m)), redo: () => removeSlot(slot) });
      App.toast(`${m.key}: action map removed`);
    });
  }

  function checkPreview() {
    clearTimeout(previewTimer);
    const seq = ++previewSeq, spec = specNow();
    if (!spec.rules.length || spec.rules.length > 6) return;
    previewTimer = setTimeout(async () => {
      let r;
      try { r = await App.api('POST', '/api/key-actions/preview', spec); } catch (e) { r = { error: e.message }; }
      const box = $('#kw-main .kw-errors[role=alert]');
      if (seq !== previewSeq || W.step !== 4 || !box) return;
      box.hidden = !r.error;
      box.textContent = r.error ? `The keyboard would refuse this: ${r.error}` : '';
      if (r.error) $('#kw-main [data-save]').disabled = true;
    }, 150);
  }

  // ---- state changes ----------------------------------------------------------------------

  function loadDraft() {
    W.draft = W.stored ? C().specToAnswers(W.stored) : blankDraft();
    W.chosen = Boolean(W.stored);
    W.template = null;
  }
  function changed() { tracker.mark(); $('#kw-key').textContent = `${W.name} · unsaved`; drawGauge(); readout(); }

  function select(slot, step = 2) {
    if (slot !== W.slot) {
      if (W.dirty && !App.ui.confirmLeave()) return true;
      Object.assign(W, { slot, name: App.keyEls.get(slot)?.dataset.name ?? `slot ${slot}`, stored: maps.get(slot) ?? null, qi: 0, live: null });
      pressedAt = null;
      loadDraft();
      App.st.selected = new Set([slot]);
      App.onSelectionChange();
    }
    W.step = step === 4 && !W.chosen ? 2 : step;
    drawList();
    render();
    return true;
  }

  function goStep(n) {
    if (n >= 2 && W.slot === null) return;
    if (n >= 3 && !W.chosen) return;
    W.step = n;
    render();
  }

  function pickTemplate(id) {
    const t = C().TEMPLATES.find((x) => x.id === id);
    W.draft = { ...W.draft, answers: C().templateAnswers(id), extra: [] };
    Object.assign(W, { template: id, chosen: true, step: 3 });
    W.qi = Math.max(0, C().QUESTIONS.findIndex((q) => q.id in t.answers));
    tracker.mark();
    render();
  }

  // depth questions, also from the gauge: deep stays above the light press and under the bottom
  function setDepth(id, v) {
    const a = W.draft.answers, p = W.draft.pressMm;
    if (id === 'light') { W.draft.pressMm = Math.max(0.1, Math.min(2, r05(v))); return W.draft.pressMm; }
    let at = Math.max(Math.max(0.2, p + 0.05), Math.min(TRAVEL, r05(v)));
    if (id === 'deep' && a.bottom.do) at = Math.min(at, a.bottom.at - 0.1);
    if (id === 'bottom' && a.deep.do) at = Math.max(at, a.deep.at + 0.1);
    a[id].at = Math.round(at * 100) / 100;
    return a[id].at;
  }

  function onInput(e) {
    const t = e.target, q = W.step === 3 ? question() : null;
    const out = (txt) => { const o = $(`#kw-main output[data-for=${t.name}]`); if (o) o.textContent = txt; };
    if (t.name === 'kwAt' && q) { out(C().mm(setDepth(q.id, Number(t.value)))); $('#kw-main .kw-q-text').textContent = q.ask(W.draft.answers[q.id]); }
    else if (t.name === 'kwMs' && q) {
      const a = W.draft.answers[q.id], old = a.ms;
      a.ms = Math.round(Number(t.value) * 1000);
      if (q.id === 'hold' && W.draft.answers.tap.ms === old) W.draft.answers.tap.ms = a.ms;   // tap / hold: the tap window follows
      out(C().time(a.ms));
      $('#kw-main .kw-q-text').textContent = q.ask(a);
    } else if (t.name === 'kwPress') out(C().mm(W.draft.pressMm = Number(t.value)));
    else if (t.name === 'kwGap') out(C().mm(W.draft.gapMm = Number(t.value)));
    else return;
    changed();
  }

  function onChange(e) {
    const t = e.target;
    if (t.name === 'kwMode') { W.draft.answers[question().id].mode = t.value; changed(); }
    if (t.name === 'kwAlso') { W.draft.alsoType = t.checked; changed(); render(); }
  }

  function onClick(e) {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    const d = b.dataset, n = C().QUESTIONS.length;
    if (d.step || d.go) goStep(Number(d.step ?? d.go));
    else if (d.template) pickTemplate(d.template);
    else if (b.hasAttribute('data-keep')) goStep(4);
    else if (d.q !== undefined) { W.qi = Number(d.q); W.step = 3; render(); }
    else if (b.hasAttribute('data-prev')) { if (W.qi > 0) W.qi--; else W.step = 2; render(); }
    else if (b.hasAttribute('data-next')) { if (W.qi < n - 1) W.qi++; else W.step = 4; render(); }
    else if (b.hasAttribute('data-none')) {
      W.draft.answers[question().id].do = null;
      changed();
      if (W.qi < n - 1) W.qi++; else W.step = 4;
      render();
    } else if (d.alt !== undefined) {
      const q = question();
      const alts = C().TEMPLATES.find((t) => t.id === W.template).alternatives[q.id].filter((x) => JSON.stringify(x) !== JSON.stringify(W.draft.answers[q.id].do));
      W.draft.answers[q.id].do = { ...alts[Number(d.alt)] };
      changed();
      render();
    } else if (b.hasAttribute('data-save')) tracker.save();
    else if (b.hasAttribute('data-remove')) removeMap(W.slot);
    else if (b.hasAttribute('data-discard')) tracker.discard();
  }

  // drag up / down on the gauge = the depth of the question shown (light press: the press depth)
  function bindGauge(box) {
    const mmAt = (e) => {
      const svg = box.querySelector('svg.sv3');
      if (!svg) return null;
      const r = svg.getBoundingClientRect();
      return ((e.clientY - r.top) * (250 / r.height) - 30) / 176 * TRAVEL;
    };
    const apply = (e) => {
      const q = question(), v = mmAt(e);
      if (v === null) return;
      const got = setDepth(q.id, v);
      const input = $(`#kw-main [name=${q.id === 'light' ? 'kwPress' : 'kwAt'}]`);
      if (input) { input.value = got; input.dispatchEvent(new Event('input', { bubbles: true })); } else changed();
      if (q.id === 'light') render();
    };
    box.addEventListener('pointerdown', (e) => {
      if (!box.classList.contains('kw-drag') || !e.target.closest('svg')) return;
      dragging = true;
      box.setPointerCapture(e.pointerId);
      apply(e);
    });
    box.addEventListener('pointermove', (e) => { if (dragging) apply(e); });
    box.addEventListener('pointerup', () => { dragging = false; });
  }

  // ---- hooks for analog.js --------------------------------------------------------------

  App.keyWizard = {
    paint(slot, el, mm) {
      const m = maps.get(slot);
      const val = App.$('.val', el);
      val.textContent = m ? 'map' : '';
      val.title = m ? m.summary.join(' ') : '';
      el.classList.toggle('sel', App.st.selected.has(slot));
      el.style.background = m ? 'var(--cap-marked)' : 'var(--cap)';
      App.$('.fill', el).style.height = `${Math.min(mm / 3.6, 1) * 100}%`;
      return true;
    },
    keyDown: (slot) => select(slot),
    onDepth(slot, mm) {
      if (slot !== W.slot || !W.draft) return;
      W.live = mm > 0.005 ? mm : null;
      if (mm >= W.draft.pressMm && pressedAt === null) pressedAt = performance.now();
      if (mm < W.draft.pressMm - W.draft.gapMm) pressedAt = null;
      clearInterval(timer);
      if (pressedAt !== null) timer = setInterval(readout, 100);
      drawGauge();
      readout();
    },
    shown(on) {
      visible = on;
      if (!on) { clearInterval(timer); App.ui.closePicker(); return; }
      if (!gauge) { gauge = App.switchViz($('#kw-gauge')); bindGauge($('#kw-gauge')); }
      if (!W.draft) W.draft = blankDraft();
      render();
    },
    canLeave: () => !W.dirty || App.ui.confirmLeave(),
  };

  App.views.keyWizard = {
    init() {
      const panel = $('#kw-panel');
      tracker = App.ui.track(panel, {
        save,
        discard() {
          loadDraft();
          W.step = W.slot === null ? 1 : 2;
          setTimeout(render);
        },
        saveLabel: 'Save to the keyboard',
      });
      $('#kw-steps').addEventListener('click', onClick);
      $('#kw-main').addEventListener('click', onClick);
      $('#kw-main').addEventListener('input', onInput);
      $('#kw-main').addEventListener('change', onChange);
      $('#kw-main').addEventListener('toggle', (e) => { if (e.target.matches?.('.kw-more')) W.moreOpen = e.target.open; }, true);
      $('#kw-maps').addEventListener('click', (e) => {
        const li = e.target.closest('li[data-slot]');
        if (!li || e.target.disabled) return;
        const slot = Number(li.dataset.slot);
        if (e.target.closest('[data-edit]')) select(slot, 4);
        if (e.target.closest('[data-del]')) removeMap(slot);
      });
      window.addEventListener('statechange', loadList);
    },
  };
})();
