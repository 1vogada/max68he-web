// Features page: the firmware builder (src/fw-builder.js). Builds the open firmware with the
// switches above it (features.js), shows make's log and the preflight, then "Flash this build"
// flashes it with the existing flasher (POST /api/firmware/flash: key maps kept over the update).
// Flashing stays a click of its own, with a confirmation.
(() => {
  const App = (window.App = window.App || {});
  App.views = App.views || {};

  const box = Object.assign(document.createElement('section'), { className: 'panel wide', id: 'fwb-panel', innerHTML: `
    <h2>Build and flash <span class="chip" id="fwb-chip">…</span></h2>
    <p class="muted small">Builds your own open firmware with the switches above, checks it offline (preflight) and adds it to the firmware list.
      Flash this build then puts it on the keyboard; your key action maps are backed up and put back.</p>
    <p class="small" id="fwb-reason" hidden></p>
    <div id="fwb-body">
      <div class="row-buttons">
        <button type="button" id="fwb-build" class="primary">Build</button>
        <button type="button" id="fwb-pick" hidden>Flash this build</button>
      </div>
      <pre class="flash-log" id="fwb-log" hidden></pre>
    </div>` });
  box.dataset.views = 'features';

  let pollTimer = 0, flashTimer = 0, builtId = null;
  const $ = (s) => box.querySelector(s);
  const log = (text, append = false) => {
    const el = $('#fwb-log');
    el.hidden = false;
    el.textContent = append ? `${el.textContent}${text}` : text;
    el.scrollTop = el.scrollHeight;
  };
  const lock = (on) => { $('#fwb-build').disabled = on; $('#fwb-pick').disabled = on; };

  function showJob(j) {
    log(j.log.slice(-300).join('\n') + (j.running ? '' : `\n\n${j.ok ? 'Result: built, preflight passed.' : `Result: failed. ${j.error ?? ''}`}`));
    $('#fwb-build').disabled = j.running;
    $('#fwb-chip').textContent = j.running ? 'building' : j.ok ? 'built' : 'ready';
  }
  function poll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      let j;
      try { j = await App.api('GET', '/api/firmware/build'); } catch { return poll(); }
      showJob(j);
      if (j.running) return poll();
      if (j.ok) {
        builtId = j.id;
        $('#fwb-pick').hidden = false;
        App.toast(`Built: ${j.label}`);
        if (j.size) App.features?.showMeasured(j.size);
        App.loadFirmwareImages?.().catch(() => {});
      } else App.ui.showError(box, j.error ?? 'The build failed (see the log)');
    }, 700);
  }

  async function startBuild() {
    $('#fwb-build').disabled = true;
    $('#fwb-pick').hidden = true;
    log('Starting…');
    try {
      await App.api('POST', '/api/firmware/build', { flags: App.features.flags() });
      App.ui.showError(box, null);
      poll();
    } catch (e) { $('#fwb-build').disabled = false; App.ui.showError(box, e.message); }
  }

  // the existing flasher (src/flasher.js, as Updates > Firmware update): confirm, flash, follow
  async function flashBuild() {
    const { images } = await App.api('GET', '/api/firmware/images');
    const im = images.find((x) => x.id === builtId);
    if (!im) return App.toast('The build is not in the firmware list yet', true);
    if (!confirm(`Flash "${im.name}"?\n\nSettings saved by the open firmware are kept; key action maps are backed up and put back.\n\n`
      + 'The keyboard restarts into its updater, gets written and restarts again. Keep the cable in until it says done.')) return;
    lock(true);
    log('\n\nFlashing…', true);
    try { await App.api('POST', '/api/firmware/flash', { id: im.id }); } catch (e) { lock(false); return App.ui.showError(box, e.message); }
    pollFlash();
  }
  function pollFlash() {
    clearTimeout(flashTimer);
    flashTimer = setTimeout(async () => {
      let j;
      try { j = await App.api('GET', '/api/firmware/flash'); } catch { return pollFlash(); }
      log(j.log.join('\n'));
      if (j.running) return pollFlash();
      lock(false);
      log(`\n\n${j.ok ? 'Result: flashed.' : j.outcome === 'write-failed' ? 'Result: failed during the update. Don\'t unplug the keyboard; flash it again.'
        : j.inUpdater ? 'Result: stopped before writing. The keyboard is in updater mode; click Flash this build again to finish.'
          : 'Result: failed before writing. The keyboard was not changed; safe to try again.'}`, true);
      if (j.keyMaps?.kept) log(`\nKey maps: ${j.keyMaps.error ?? `${j.keyMaps.restored} of ${j.keyMaps.kept} restored.`}`, true);
      if (j.ok) {
        App.toast('Firmware flashed');
        setTimeout(async () => { try { App.applyState(await App.api('GET', '/api/state')); } catch { /* reconnects on its own */ } }, 2500);
      } else App.ui.showError(box, j.error ?? 'Flashing failed (see the log)');
    }, 700);
  }

  // features.js: the list arrived (r = GET /api/firmware/features)
  function loaded(r) {
    const ok = r.available && !r.web;
    $('#fwb-reason').hidden = ok;
    $('#fwb-body').hidden = !ok;
    if (!ok) { $('#fwb-reason').textContent = r.reason || 'Building needs the desktop app.'; $('#fwb-chip').textContent = 'not available'; return; }
    $('#fwb-chip').textContent = 'ready';
    if (r.job?.running || r.job?.log?.length) {
      showJob(r.job);
      if (r.job.running) poll();
      else if (r.job.ok) { builtId = r.job.id; $('#fwb-pick').hidden = false; }
    }
  }
  // a switch changed: the last build no longer matches them
  function changed() { $('#fwb-pick').hidden = true; builtId = null; }

  function init() {
    (document.getElementById('feat-list') ?? document.querySelector('.panels').lastElementChild).after(box);
    $('#fwb-build').onclick = startBuild;
    $('#fwb-pick').onclick = () => flashBuild().catch((e) => { lock(false); App.ui.showError(box, e.message); });
  }

  App.views.fwBuilder = { init };
  App.fwBuilder = { loaded, changed };
})();
