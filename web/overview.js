// Quick settings (grouped like Wootility): overview cards that open the page behind them,
// and performance mode at one click.
(() => {
  const App = (window.App = window.App || {});
  App.views = App.views || {};

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const mm = (v) => `${Number(v).toFixed(2)} mm`;

  // switch settings of the keys on the board (the keyboard also reports slots without a key)
  const switches = () => [...(App.keyEls?.keys() ?? [])].map((slot) => App.st.switches?.[slot]).filter(Boolean);

  // the most common value of one switch field, and on how many keys
  function common(field) {
    const vals = switches().map((s) => s[field]).filter((v) => v !== undefined);
    const count = new Map();
    vals.forEach((v) => count.set(v, (count.get(v) ?? 0) + 1));
    const [v, n] = [...count].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
    return { v, n, total: vals.length };
  }

  function card(go, title, big, text, extra = '') {
    return `<div class="quick-card"><h3>${title}${go ? `<button type="button" data-open="${go}">Open</button>` : ''}</h3>
      <span class="big">${big}</span><span class="muted small">${text}</span>${extra}</div>`;
  }

  function drawQuick() {
    const { st } = App;
    const box = App.$('#quick-panel');
    if (!st.info) { box.innerHTML = '<h2>Quick settings</h2><p class="muted">Connect the keyboard to see its settings.</p>'; return; }
    const act = common('actuation');
    const rtOn = switches().filter((s) => s.rapidTrigger).length;
    const perfOk = Boolean(st.fwOptions) && (st.features ?? []).includes('perfMode');
    const light = (App.$('#light-form').elements.mode.selectedOptions[0]?.textContent ?? '–').replace(/\s*\(.*\)$/, '');
    box.innerHTML = `<h2>Quick settings <span class="chip">Profile ${st.profile + 1}</span></h2>
      <div class="quick-grid">
        ${card('actuation', 'Actuation point', act.v === null ? '–' : mm(act.v),
          act.n === act.total ? `on all ${act.total} keys` : `on ${act.n} of ${act.total} keys; the others differ`)}
        ${card('rt', 'Rapid trigger', rtOn ? 'On' : 'Off', rtOn ? `on ${rtOn} of ${act.total} keys` : 'on no key')}
        ${card('', 'Performance mode', perfOk ? (st.fwOptions.perf ? 'On' : 'Off') : '–',
          perfOk ? 'Lighting off, so all of the keyboard\'s time goes to the keys (like Wootility\'s Tachyon mode).'
            : App.ui.firmwareReason('Performance mode'),
          perfOk ? `<label class="toggle"><input type="checkbox" id="quick-perf"${st.fwOptions.perf ? ' checked' : ''}><span class="switch"></span> Performance mode</label>` : '')}
        ${card('lighting', 'Lighting', esc(light), `brightness ${(st.lighting?.brightness ?? 0) + 1} of 5`)}
        ${card('settings', 'Polling rate', `${st.pollingRateHz ?? '–'} Hz`, 'how often the keyboard reports to the PC')}
        ${card('profiles', 'Profile', esc(App.profileMeta?.onboard?.[st.profile]?.name ?? `${st.profile + 1} of 4`), `profile ${st.profile + 1} of 4: switch, save or load profiles`)}
      </div>`;
    const perf = App.$('#quick-perf');
    if (perf) {
      perf.onchange = () => App.busy(box, 'Saving…', async () => {
        try {
          const r = await App.api('POST', '/api/fw-options', { perf: perf.checked });
          App.st.fwOptions = r.fwOptions;
          App.fillFirmware?.(r.fwOptions);
          App.toast(`Performance mode ${r.fwOptions.perf ? 'on' : 'off'}`);
        } finally { drawQuick(); }
      });
    }
  }

  // (My profiles is my-profiles.js)
  function draw() {
    if (App.st.view === 'quick') drawQuick();
  }

  App.views.overview = {
    init() {
      App.$('#quick-panel').onclick = (e) => { const b = e.target.closest('[data-open]'); if (b) App.goto(b.dataset.open); };
      window.addEventListener('pagechange', draw);
      window.addEventListener('statechange', draw);
    },
  };
})();
