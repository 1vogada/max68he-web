// Web version only: the Updates page's firmware update over WebHID (src/ryflash.js, the same
// packets and waits as ry-flash.exe), step by step. It replaces the desktop panel (#flash-panel,
// which runs ry-flash.exe through the server). The updater (3151:502A) is a USB device of its
// own, so the browser asks for it once; so may it for the keyboard when it comes back.
//
// Images: a .bin file the user picks (open firmware, checked like ry-flash and preflight.js),
// or the site's firmware/manifest.json list when the site hosts one. Going back to the stock
// firmware stays with the desktop app: the vendor's download server allows no web page (CORS).
const hid = require('node-hid');                    // web-build/node-hid.js
const R = require('../src/ryflash');
const { whileFlashing } = require('../src/web/server');
const { keepKeyMaps, restoreKeyMaps } = require('../src/flash-keymaps');
const { Keyboard } = require('../src/keyboard');
const models = require('../src/models');

const BOARD = models.DEFAULT;                       // the open firmware is for the MAX68HE only
const BACKUP_DIR = '/app/config/backups';           // as flasher.js (browser storage here)
const STEPS = [['keep', 'Back up key maps'], ['updater', 'Restart into the updater'], ['write', 'Write the firmware'],
  ['back', 'Wait for the keyboard'], ['restore', 'Restore key maps'], ['done', 'Done']];

let image = null;          // { name, slice, chunks, checksum }
let running = false;
const $ = (s) => document.querySelector(s);

function panel() {
  const p = Object.assign(document.createElement('section'), { className: 'panel', id: 'web-flash-panel' });
  p.dataset.views = 'updates';
  p.innerHTML = `
    <h2>Firmware update</h2>
    <p class="muted small">Flashes the open firmware from this page. Keep the cable in and <b>this tab in front</b> until it says done
      (browsers slow down hidden tabs). If anything goes wrong, the keyboard's updater is never touched: flashing again always recovers it.</p>
    <label id="wf-list-row" hidden>Firmware <select id="wf-list"></select></label>
    <label>Firmware file (.bin) <input type="file" id="wf-file" accept=".bin,application/octet-stream"></label>
    <p class="small" id="wf-check">Choose a build from the list, or an open-firmware image file (ry5088_2755_rydfu.bin).</p>
    <p class="small wf-recover" id="wf-recover-note" hidden>The keyboard is in updater mode (an earlier flash stopped).
      Choose the image and click <b>Finish the flash</b>.</p>
    <ol class="wf-steps" id="wf-steps">${STEPS.map(([id, t]) => `<li data-step="${id}">${t}</li>`).join('')}</ol>
    <div class="wf-bar" hidden><div id="wf-bar"></div></div>
    <div class="wf-pick" id="wf-pick" hidden><span id="wf-pick-why"></span> <button type="button" class="primary" id="wf-pick-btn">Pick it</button></div>
    <div class="row-buttons">
      <button type="button" id="wf-go" class="primary" disabled>Flash</button>
      <button type="button" id="wf-find">Keyboard stuck in updater mode?</button>
    </div>
    <p class="muted small" id="wf-licence" hidden>The listed builds come with their licences:
      <a href="firmware/LICENSE-firmware.txt" target="_blank" rel="noopener">LICENSE-firmware.txt</a>.</p>
    <p class="muted small">Going back to the stock firmware needs the desktop app (the vendor's download server does not allow web pages).</p>
    <pre class="flash-log" id="wf-log" hidden></pre>`;
  return p;
}

function say(line) {
  const log = $('#wf-log');
  log.hidden = false;
  log.textContent += `${log.textContent ? '\n' : ''}${line}`;
  log.scrollTop = log.scrollHeight;
}

function step(id, state) {   // state: 'now' | 'ok' | 'skip' | 'fail'
  const li = $(`#wf-steps [data-step="${id}"]`);
  if (li) li.dataset.state = state;
}

const updater = () => new R.Updater({
  hid, appearMs: 180000,   // ry-flash waits 20 s; here the user may first have to pick the device
  onWait: (kind) => offerPick(kind),
});

// The browser shows a USB device to a page only after the user picks it once.
function offerPick(kind) {
  const why = kind === 'updater'
    ? 'The keyboard restarted into its updater, which is a separate USB device ("3151:502A"). If the browser has not asked yet, click Pick it and choose it: the browser needs your permission for each new device.'
    : 'The keyboard restarted with the new firmware. If it does not come back by itself, click Pick it and choose the MAX68HE.';
  $('#wf-pick-why').textContent = why;
  const present = () => (kind === 'updater' ? updater().bootPresent() : updater().normalPresent());
  $('#wf-pick').hidden = present();
  let picked = false;
  $('#wf-pick-btn').onclick = async () => {
    picked = true;
    try { await hid.request(undefined, kind === 'updater' ? hid.UPDATER_FILTERS : hid.FILTERS); } catch (e) { if (e.name !== 'NotFoundError') say(e.message); }
    $('#wf-pick').hidden = present();
  };
  const timer = setInterval(() => {
    if (!present() && running) return;
    // worth knowing: does the browser hand the device back by itself, or does it need the pick?
    if (present()) say(`The ${kind} showed up ${picked ? 'after you picked it' : 'by itself'}.`);
    $('#wf-pick').hidden = true;
    clearInterval(timer);
  }, 500);
}

function refresh() {
  const inUpdater = updater().bootPresent();
  $('#wf-recover-note').hidden = !inUpdater;
  $('#wf-go').textContent = inUpdater ? 'Finish the flash' : 'Flash';
  $('#wf-go').disabled = running || !image;
  $('#wf-file').disabled = running;
}

function useImage(bytes, name) {
  const c = R.checkImage(bytes, { name, boardId: BOARD.boardId, pid: BOARD.pid });
  image = c.ok ? { name, ...c } : null;
  $('#wf-check').textContent = c.ok ? `${name}: ${c.slice.length} bytes, ${c.chunks} chunks, checksum 0x${c.checksum.toString(16).padStart(6, '0')}. Ready.`
    : `${name}: ${c.error}`;
  $('#wf-check').classList.toggle('error', !c.ok);
  refresh();
}

async function sha256(bytes) {
  const h = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// The site's open-firmware builds (scripts/publish-firmware.js), newest first:
// firmware/manifest.json { images: [{ board, file, commit, committedAt, size, sha256, notes }] }
const label = (x, i) => `${i ? 'Open firmware' : 'Latest open firmware'} ${x.commit?.slice(0, 7) ?? x.file}`
  + `${x.committedAt ? ` · ${new Date(x.committedAt).toLocaleDateString()}` : ''}`;

async function loadManifest() {
  let m;
  try {
    const r = await fetch('firmware/manifest.json', { cache: 'no-store' });
    if (!r.ok) return;
    m = await r.json();
  } catch { return; }
  const list = (m.images ?? []).filter((x) => x.board === BOARD.boardId && /^[\w.-]+\.bin$/.test(x.file ?? '') && x.sha256 && x.size);
  if (!list.length) return;
  const sel = $('#wf-list');
  sel.innerHTML = '<option value="">Choose…</option>';
  list.forEach((x, i) => sel.add(new Option(label(x, i), String(i))));
  $('#wf-list-row').hidden = false;
  $('#wf-licence').hidden = false;
  sel.onchange = async () => {
    const x = list[Number(sel.value)];
    if (!x) return;
    $('#wf-check').textContent = `Downloading ${x.file}…`;
    try {
      const r = await fetch(`firmware/${x.file}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`download failed (${r.status})`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      // the list's size and sha256 must match before the image is even looked at
      if (bytes.length !== x.size || (await sha256(bytes)) !== x.sha256.toLowerCase()) throw new Error('the download does not match the list (size or sha256); not used');
      useImage(bytes, x.file);
      if (image) $('#wf-check').textContent = `${label(x, Number(sel.value))}: ${x.notes ?? ''} (${x.size} bytes, sha256 checked). Ready.`;
    } catch (e) { image = null; $('#wf-check').textContent = `${x.file}: ${e.message}`; refresh(); }
  };
}

function outcome(e, keyMaps) {
  const backup = keyMaps?.file ? ` The key maps were not restored; the backup is in this browser's storage (${keyMaps.file}).` : '';
  if (e.stage === 'writing') {
    return `Failed during the update: ${e.message}. Don't unplug the keyboard; click Flash again (pick the updater if asked). `
      + `The updater itself is never touched, so a new flash recovers it.${backup}`;
  }
  if (e.stage === 'after') return `${e.message}. Check that the keyboard types.${backup}`;
  if (e.inUpdater) return `Nothing written yet: ${e.message}. The keyboard may be in updater mode: click Flash again to finish (pick the updater if asked).`;
  return `Failed before writing: ${e.message}. The keyboard was not changed; safe to try again.`;
}

async function flash() {
  if (!image || running) return;
  const recover = updater().bootPresent();
  if (!confirm(recover ? `Finish the flash with "${image.name}"?\n\nThe keyboard is in updater mode, so its model can't be checked first: make sure this image is for the MAX68HE.`
    : `Flash "${image.name}"?\n\nThe keyboard restarts into its updater, gets written and restarts again. Your browser may ask you to pick the updater: it is a separate USB device. Keep the cable in and this tab in front until it says done.`)) return;
  running = true;
  refresh();
  $('#wf-log').textContent = '';
  STEPS.forEach(([id]) => step(id, ''));
  const bar = $('#wf-bar');
  bar.parentElement.hidden = false;
  bar.style.width = '0';
  const guard = (ev) => { ev.preventDefault(); ev.returnValue = ''; };
  window.addEventListener('beforeunload', guard);
  const hiddenWarn = () => { if (document.hidden) say('This tab is in the background: the browser slows it down, so the flash takes longer. Bring it back to the front.'); };
  document.addEventListener('visibilitychange', hiddenWarn);
  const open = () => Keyboard.open({ key: BOARD.key });
  let kept = { maps: null, keyMaps: null }, ok = false;
  try {
    await whileFlashing(async () => {
      step('keep', 'now');
      if (!recover) {
        kept = await keepKeyMaps(open, { backupDir: BACKUP_DIR, say });
        if (kept.stop) throw R.flashError(kept.stop.replace(/; try again$/, ''), 'before');
      }
      step('keep', kept.maps?.length ? 'ok' : 'skip');
      step(recover ? 'write' : 'updater', 'now');
      say(`Flashing ${image.name} (${image.slice.length} bytes, ${image.chunks} chunks)…`);
      const r = await updater().flash(image.slice, {
        boardId: BOARD.boardId,
        say: (l) => { say(l); if (/Waiting for the keyboard/.test(l)) { step('write', 'ok'); step('back', 'now'); } },
        progress: (i, n) => {
          if (i === 1) { step('updater', recover ? 'skip' : 'ok'); step('write', 'now'); }
          bar.style.width = `${(100 * i / n).toFixed(1)}%`;
        },
      });
      step('back', 'ok');
      say(r.postDevId != null ? `The keyboard is back: model ${r.postDevId}, ${r.postVersion}.` : 'The keyboard is back (its model could not be read; check that it types).');
      if (r.mode === 'recover' && r.postDevId != null && r.postDevId !== BOARD.boardId) {
        say(`Warning: flashed from updater mode without a model check, and the keyboard now reports model ${r.postDevId}, not ${BOARD.boardId}.`);
      }
      ok = true;
      if (kept.maps?.length) {
        step('restore', 'now');
        await restoreKeyMaps(open, kept.maps, kept.keyMaps, { say });
        step('restore', kept.keyMaps.error ? 'fail' : 'ok');
      } else step('restore', 'skip');
      step('done', 'ok');
      say('Done: the keyboard has the new firmware.');
    });
  } catch (e) {
    const cur = STEPS.find(([id]) => $(`#wf-steps [data-step="${id}"]`)?.dataset.state === 'now');
    if (cur) step(cur[0], 'fail');
    const msg = e.stage ? outcome(e, kept.keyMaps) : `Failed before writing: ${e.message}. The keyboard was not changed; safe to try again.`;
    say(`Error: ${msg}`);
    window.App?.ui?.showError($('#web-flash-panel'), msg);
  } finally {
    running = false;
    window.removeEventListener('beforeunload', guard);
    document.removeEventListener('visibilitychange', hiddenWarn);
    $('#wf-pick').hidden = true;
    refresh();
  }
  if (ok) {
    window.App?.toast?.('Firmware flashed');
    setTimeout(async () => { try { window.App.applyState(await window.App.api('GET', '/api/state')); } catch { /* reconnects on its own */ } }, 1500);
  }
}

function mount() {
  const desktop = document.getElementById('flash-panel');
  if (!desktop || document.getElementById('web-flash-panel')) return false;
  desktop.after(panel());
  $('#wf-file').onchange = async (ev) => {
    const f = ev.target.files?.[0];
    if (f) useImage(new Uint8Array(await f.arrayBuffer()), f.name);
  };
  $('#wf-go').onclick = () => flash();
  $('#wf-find').onclick = async () => {
    try {
      await hid.request(undefined, hid.UPDATER_FILTERS);
    } catch (e) { if (e.name !== 'NotFoundError') alert(e.message); }
    refresh();
    if (!updater().bootPresent()) alert('No updater found. A keyboard stuck in updater mode shows up as "3151:502A" in the list; if the list is empty, the keyboard is not in updater mode.');
  };
  hid.onChange(() => { if (!running) refresh(); });
  window.addEventListener('pagechange', (e) => { if (e.detail === 'updates' && !running) refresh(); });
  loadManifest();
  refresh();
  return true;
}

module.exports = { mount, useImage, outcome };
