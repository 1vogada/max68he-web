// Settings page: key calibration wizard, speed measurement and one-click
// firmware update (panels added after "Profile backup").
(() => {
  const App = (window.App = window.App || {});
  App.views = App.views || {};
  const feats = () => App.st.features ?? [];

  function panel(id, html, view = 'settings') {
    const p = Object.assign(document.createElement('section'), { className: 'panel', id, innerHTML: html });
    p.dataset.views = view;
    return p;
  }

  // ---- calibration -------------------------------------------------------
  const cal = panel('calib-panel', `
    <h2>Key calibration <span class="chip" id="cal-chip">…</span></h2>
    <p class="muted small">Measures each key's real travel, so a setting like "actuate at 1.20 mm" means the same depth on every key.
      Start, then press <b>every key all the way down once</b> and let go: keys turn yellow while pressed, green when done.
      While it runs no key reaches the PC; holding Esc for 2 s cancels.</p>
    <p class="small" id="cal-progress"></p>
    <div class="row-buttons">
      <button type="button" id="cal-start" class="primary">Start calibration</button>
      <button type="button" id="cal-finish" class="primary" hidden>Finish and save</button>
      <button type="button" id="cal-cancel" hidden>Cancel</button>
      <button type="button" id="cal-reset">Reset to default</button>
    </div>
    <p class="muted small">Calibration matches every key to the same full travel. Hall sensors are not perfectly linear, so mid-travel
      depths are close, not lab-exact.</p>`);

  // ---- speed ----------------------------------------------------------------
  const speed = panel('speed-panel', `
    <h2>Speed</h2>
    <p class="muted small">How fast the keyboard reads its sensors (scans/s) and handles them (passes/s). USB polls at 8000 Hz.
      Performance mode (Firmware options) switches the lighting off to give the keys more time.</p>
    <div class="row-buttons"><button type="button" id="speed-run">Measure (1 s)</button></div>
    <dl class="facts" id="speed-out"></dl>`);

  // ---- firmware update -------------------------------------------------------
  const fwu = panel('flash-panel', `
    <h2>Firmware update</h2>
    <p class="muted small">Flashes the keyboard in one click (the same as running ry-flash --image … --arm by hand). Keep the cable in until it says done.
      If anything goes wrong, the keyboard's updater is never touched: flashing again always recovers it.</p>
    <label>Firmware <select id="flash-image"></select></label>
    <p class="muted small" id="flash-note"></p>
    <div class="row-buttons"><button type="button" id="flash-go" class="primary">Flash now</button></div>
    <pre class="flash-log" id="flash-log" hidden></pre>`, 'updates');

  let calTimer = 0, flashTimer = 0, images = [];

  function showCal(s) {
    const { $ } = App;
    $('#cal-chip').textContent = s.running ? 'running' : s.calibratedKeys ? `${s.calibratedKeys} of ${s.keys} keys calibrated` : 'not calibrated';
    $('#cal-progress').textContent = s.running ? `Done: ${s.doneThisRun} of ${s.keys} keys. Press the rest to the bottom once.` : '';
    $('#cal-start').hidden = s.running; $('#cal-reset').hidden = s.running;
    $('#cal-finish').hidden = !s.running; $('#cal-cancel').hidden = !s.running;
    $('#cal-finish').disabled = !s.doneThisRun;
    clearTimeout(calTimer);
    if (s.running && App.st.view === 'settings') calTimer = setTimeout(refreshCal, 400);
  }
  async function refreshCal() {
    try { showCal(await App.api('POST', '/api/calibration', { action: 'status' })); } catch (e) { App.$('#cal-chip').textContent = e.message; }
  }
  const calDo = (action, msg) => App.busy(cal, msg, async () => {
    const s = await App.api('POST', '/api/calibration', { action });
    showCal(s);
    if (action === 'finish') App.toast(s.lastFinish === 'flash error' ? 'Could not save the calibration' : `Calibrated ${s.lastFinish} keys`);
    if (action === 'reset') App.toast('Every key uses the default range again');
  });

  async function measure() {
    const r = await App.api('POST', '/api/scan-stats');
    const facts = {
      'Sensor scans': `${r.scansPerSec} /s`, 'Key passes': `${r.passesPerSec} /s`,
      'Pass time': `${r.passAvgUs.toFixed(0)} µs average, ${r.passMaxUs.toFixed(0)} µs worst`,
    };
    if (feats().includes('sectionTime')) {
      const s = r.sections;
      facts['Time per pass'] = `scan ${s.scan} · keys ${s.hall} · layers ${s.logic} · reports ${s.reports} · lights ${s.lightsAndSave} µs`;
    }
    const dl = App.$('#speed-out');
    dl.textContent = '';
    for (const [k, v] of Object.entries(facts)) {
      dl.append(Object.assign(document.createElement('dt'), { textContent: k }));
      dl.append(Object.assign(document.createElement('dd'), { textContent: v }));
    }
  }

  async function loadImages() {
    const { $ } = App;
    const r = await App.api('GET', '/api/firmware/images');
    images = r.images;
    const sel = $('#flash-image');
    sel.innerHTML = '';
    for (const im of images) sel.add(new Option(`${im.name} · ${new Date(im.built).toLocaleString()}`, im.id));
    $('#flash-go').disabled = !r.flasher || !images.length || r.job.running;
    $('#flash-note').textContent = !r.flasher ? 'ry-flash was not found (build it in x68max-firmware/flasher, or set config/flash.json).'
      : !images.length ? 'No firmware images found next to this driver (x68max-firmware).' : images[0].note;
    if (r.job.running) pollFlash();
  }

  function pollFlash() {
    const { $ } = App;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(async () => {
      let j;
      try { j = await App.api('GET', '/api/firmware/flash'); } catch { return pollFlash(); }
      $('#flash-log').hidden = false;
      $('#flash-log').textContent = j.log.join('\n');
      if (j.running) return pollFlash();
      $('#flash-go').disabled = false;
      $('#flash-log').textContent += `\n\n${j.ok ? 'Result: flashed.'
        : j.outcome === 'write-failed' ? 'Result: failed during the update. Don\'t unplug the keyboard; flash it again.'
          : j.inUpdater ? 'Result: stopped before writing. The keyboard is in updater mode; click Flash again to finish.'
            : 'Result: failed before writing. The keyboard was not changed; safe to try again.'}`;
      const km = j.keyMaps;   // key action maps kept over the update (flash-keymaps.js)
      if (km?.kept) $('#flash-log').textContent += `\nKey maps: ${km.error ?? `${km.restored} of ${km.kept} restored.`}`;
      if (j.ok) {
        App.toast('Firmware flashed');
        setTimeout(async () => { try { App.applyState(await App.api('GET', '/api/state')); } catch { /* reconnects on its own */ } }, 2500);
      } else App.ui.showError(fwu, j.error ?? 'Flashing failed (see the log)');
    }, 700);
  }

  function init() {
    const { $ } = App;
    $('#fw-form').after(cal, speed, fwu);
    $('#cal-start').onclick = () => calDo('start', 'Starting calibration…');
    $('#cal-finish').onclick = () => calDo('finish', 'Saving the calibration…');
    $('#cal-cancel').onclick = () => calDo('cancel', 'Cancelling…');
    $('#cal-reset').onclick = () => { if (confirm('Forget the calibration? Every key goes back to the default travel range.')) calDo('reset', 'Resetting…'); };
    $('#speed-run').onclick = () => App.busy(speed, 'Measuring…', measure);
    $('#flash-image').onchange = () => { $('#flash-note').textContent = images.find((x) => x.id === $('#flash-image').value)?.note ?? ''; };
    $('#flash-go').onclick = () => {
      const im = images.find((x) => x.id === $('#flash-image').value);
      if (!im) return;
      const settings = im.keepsSettings ? 'Settings saved by the open firmware are kept.'
        : 'Settings may be reset: export a profile first, then set actuation and calibrate again afterwards.';
      if (!confirm(`Flash "${im.name}"?\n\n${settings}\n\nThe keyboard restarts into its updater, gets written and restarts again. `
        + 'Keep the cable in until it says done.')) return;
      $('#flash-go').disabled = true;
      $('#flash-log').hidden = false;
      $('#flash-log').textContent = 'Starting…';
      App.api('POST', '/api/firmware/flash', { id: im.id }).then(pollFlash).catch((e) => { $('#flash-go').disabled = false; App.ui.showError(fwu, e.message); });
    };
  }

  // the Settings view's own hook is in settings.js; this one runs alongside it
  function selection() {
    if (App.st.view === 'updates') loadImages().catch((e) => { App.$('#flash-note').textContent = e.message; });
    if (App.st.view !== 'settings') { clearTimeout(calTimer); return; }
    const ok = Boolean(App.st.info?.custom) && feats().includes('calibration');
    App.ui.gate(cal, ok ? null : App.ui.firmwareReason('Calibration'));
    App.ui.gate(speed, App.st.info?.custom ? null : App.ui.firmwareReason('Speed figures'));
    if (ok) refreshCal();
  }

  App.views.maintenance = { init };
  window.addEventListener('pagechange', selection);
  App.maintenanceSelection = selection;
})();
