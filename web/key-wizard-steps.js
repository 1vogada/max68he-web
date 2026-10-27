// Key wizard (Gamepad page, web/key-wizard.js): the step contents. 1 pick a key, 2 start from a
// template (or the key's current map), 3 the questions one by one, 4 the summary with Save.
// App.kwSteps.render(main, W, act): W is the wizard state, act its actions (key-wizard.js).
(() => {
  const App = (window.App = window.App || {});
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const TRAVEL = 3.5;
  const STEPS = ['Pick a key', 'Start from', 'Questions', 'Check and save'];

  // "How long" choices, worded for the question they belong to
  function modeLabel(m, q, kind) {
    const once = App.keyActions.ONCE.includes(kind);
    return {
      press: once ? 'once' : q.when === 'press' ? 'until you let go' : 'until you let go of the key',
      while: q.when === 'down' ? 'only while it is pressed this deep' : 'while you keep holding',
      tap: once ? 'once' : 'a quick tap',
      toggle: 'switch on / off (stays on until the next time)',
      release: 'let go of it',
    }[m];
  }

  function stepsBar(W) {
    const reach = [true, W.slot !== null, W.slot !== null && W.chosen, W.slot !== null && W.chosen];
    return STEPS.map((s, i) => `<li><button type="button" data-step="${i + 1}" class="${W.step === i + 1 ? 'on' : ''}${i + 1 < W.step ? ' done' : ''}"
      ${reach[i] ? '' : 'disabled'} aria-current="${W.step === i + 1 ? 'step' : 'false'}"><b>${i + 1}</b> ${s}</button></li>`).join('');
  }

  function pickKey(W) {
    if (W.slot === null) return '<p class="kw-lead">Click the key you want to set up on the board above.</p><p class="muted small">Its depth shows on the switch on the right while you press it, so you can feel where each zone starts.</p>';
    return `<p class="kw-lead"><b>${esc(W.name)}</b> is picked.</p><div class="kw-nav"><button type="button" class="primary" data-go="2">Next →</button></div>`;
  }

  function templates(W) {
    const C = App.keyActions;
    const cur = W.stored ? `<button type="button" class="kw-card current" data-keep><span class="kw-ico">✎</span><b>Edit its current map</b>
      <span class="muted small">${esc(W.stored.summary.join(' '))}</span></button>` : '';
    return `<p class="kw-lead">What should <b>${esc(W.name)}</b> do? Start from one of these; the next questions let you change every part.</p>
      <div class="kw-cards">${cur}${C.TEMPLATES.map((t) => `<button type="button" class="kw-card${W.template === t.id ? ' on' : ''}" data-template="${t.id}">
        <span class="kw-ico">${esc(t.icon)}</span><b>${esc(t.name)}</b><span class="muted small">${esc(t.note)}</span></button>`).join('')}</div>`;
  }

  function question(W) {
    const C = App.keyActions, q = C.QUESTIONS[W.qi], a = W.draft.answers[q.id];
    const n = C.QUESTIONS.length;
    const alts = (C.TEMPLATES.find((t) => t.id === W.template)?.alternatives?.[q.id] ?? []).filter((d) => JSON.stringify(d) !== JSON.stringify(a.do));
    let slider = '';
    if (q.when === 'down') {
      slider = `<label class="kw-slider">Depth <output data-for="kwAt">${C.mm(a.at)}</output>
        <input type="range" name="kwAt" min="0.2" max="${TRAVEL}" step="0.05" value="${a.at}">
        <span class="help">Drag here or on the switch gauge. ${q.id === 'bottom' ? 'The keys bottom out at about 3.4 mm.' : 'Full travel is about 3.5 mm.'}</span></label>`;
    } else if (q.when === 'hold' || q.when === 'tap') {
      const max = q.when === 'hold' ? 10 : 2, step = q.when === 'hold' ? 0.1 : 0.05;
      slider = `<label class="kw-slider">${q.when === 'hold' ? 'Hold for' : 'Let go within'} <output data-for="kwMs">${C.time(a.ms)}</output>
        <input type="range" name="kwMs" min="${step}" max="${max}" step="${step}" value="${a.ms / 1000}">
        <span class="help">${q.when === 'hold' ? 'Seconds you keep the key down before this happens (up to 10 s).' : 'A press shorter than this counts as a quick tap; it fires when you let go.'}</span></label>`;
    } else {
      slider = `<p class="muted small">A light press is anything past ${C.mm(W.draft.pressMm)} (change it under More options at the end).</p>`;
    }
    return `<div class="kw-q">
      <div class="kw-dots" role="group" aria-label="Questions">${C.QUESTIONS.map((x, i) => `<button type="button" data-q="${i}" class="${i === W.qi ? 'on' : ''}${W.draft.answers[x.id].do ? ' set' : ''}"
        title="${esc(x.title)}${W.draft.answers[x.id].do ? `: ${esc(C.outputText(W.draft.answers[x.id].do))}` : ''}">${i + 1}</button>`).join('')}</div>
      <p class="kw-q-count muted small">Question ${W.qi + 1} of ${n} · ${esc(q.title)}</p>
      <h3 class="kw-q-text">${esc(q.ask(a))}</h3>
      ${slider}
      <div class="kw-picker"></div>
      ${alts.length ? `<p class="kw-alts muted small">Or: ${alts.map((d, i) => `<button type="button" class="gp-chip" data-alt="${i}">${esc(C.outputText(d))}</button>`).join(' ')}</p>` : ''}
      <div class="kw-how"></div>
      <div class="kw-nav">
        <button type="button" data-prev>← Back</button>
        <button type="button" data-none>Nothing here</button>
        <button type="button" class="primary" data-next>${W.qi === n - 1 ? 'See the summary →' : 'Next question →'}</button>
        ${W.qi < n - 1 ? '<button type="button" class="link" data-go="4">Skip to the summary</button>' : ''}
      </div></div>`;
  }

  function how(W) {
    const C = App.keyActions, q = C.QUESTIONS[W.qi], a = W.draft.answers[q.id];
    if (!a.do) return '';
    const kind = C.outputKind(a.do), modes = C.allowedModes(q.when, kind);
    if (modes.length < 2) return '';
    const cur = modes.includes(a.mode) ? a.mode : C.defaultMode({ when: q.when, do: a.do });
    return `<label>How long <select name="kwMode">${modes.map((m) => `<option value="${m}"${m === cur ? ' selected' : ''}>${esc(modeLabel(m, q, kind))}</option>`).join('')}</select></label>`;
  }

  function summary(W, spec) {
    const C = App.keyActions;
    const lines = C.summary(spec);
    const extra = W.draft.extra;
    const why = W.caps ? '' : App.ui.firmwareReason('Saving key action maps');
    return `<h3 class="kw-q-text">What <b>${esc(W.name)}</b> will do</h3>
      ${lines.length ? `<ul class="kw-summary">${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`
        : '<p class="kw-lead">Nothing yet: answer at least one question.</p>'}
      ${spec.rules.length > 6 ? '<p class="kw-errors">A key holds up to 6 rules; take some answers out.</p>' : ''}
      <p class="kw-errors" role="alert" hidden></p>
      <details class="kw-more"${W.moreOpen ? ' open' : ''}><summary>More options</summary>
        <label class="kw-slider">Counts as pressed past <output data-for="kwPress">${C.mm(W.draft.pressMm)}</output>
          <input type="range" name="kwPress" min="0.1" max="2" step="0.05" value="${W.draft.pressMm}">
          <span class="help">The light press, quick tap, hold and let-go answers start here.</span></label>
        <label class="kw-slider">Release gap <output data-for="kwGap">${C.mm(W.draft.gapMm)}</output>
          <input type="range" name="kwGap" min="0.05" max="0.5" step="0.01" value="${W.draft.gapMm}">
          <span class="help">A depth counts as left once the key is this far back above it, so it doesn't chatter.</span></label>
        <label class="toggle"><input type="checkbox" name="kwAlso"${W.draft.alsoType ? ' checked' : ''}><span class="switch"></span> Still type ${esc(W.name)} too</label>
        ${extra.length ? `<p class="muted small">Kept as they are (set with the API or MCP tools):</p><ul class="kw-summary extra">${C.summary({ rules: extra }).map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
      </details>
      <div class="kw-nav">
        <button type="button" data-q="0">← Change answers</button>
        <button type="button" class="primary" data-save ${W.caps && spec.rules.length && spec.rules.length <= 6 ? '' : 'disabled'}>Save to the keyboard</button>
        ${W.stored ? `<button type="button" data-remove${W.caps ? '' : ' disabled'}>Remove this key's map</button>` : ''}
        <button type="button" class="link" data-discard ${W.dirty ? '' : 'disabled'}>Start over</button>
      </div>
      ${why ? `<p class="gate">${esc(why)}</p>` : ''}`;
  }

  App.kwSteps = { stepsBar, pickKey, templates, question, how, summary, modeLabel };
})();
