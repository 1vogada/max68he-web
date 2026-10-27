// One-click firmware flashing for the web UI: runs ry-flash (from x68max-firmware)
// on one of a fixed set of images, the same way you would by hand:
// `ry-flash --image <file> --arm` switches the keyboard to its updater, flashes and verifies.
// Only images listed by listImages() can be flashed (the page picks by id).
//
// Settings: the open firmware keeps its settings in flash pages above the app slot
// (0x08028000..), which the updater never erases, so open -> open keeps them. Leaving the
// stock firmware resets its config, and stock may not read what the open firmware stored.
//
// Paths default to a sibling x68max-firmware checkout; config/flash.json may set
// { "flasher": "<ry-flash.exe>", "firmwareDir": "<x68max-firmware>" }.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function config() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'flash.json'), 'utf8')); } catch { /* defaults */ }
  const fw = process.env.MAX68HE_FIRMWARE_DIR ? path.resolve(process.env.MAX68HE_FIRMWARE_DIR)
    : c.firmwareDir ? path.resolve(ROOT, c.firmwareDir) : path.join(ROOT, '..', 'x68max-firmware');
  const exe = process.platform === 'win32' ? 'ry-flash.exe' : 'ry-flash';
  return { firmwareDir: fw, flasher: c.flasher ? path.resolve(ROOT, c.flasher) : path.join(fw, 'flasher', 'target', 'release', exe) };
}

function info(id, name, file, note, keepsSettings) {
  try {
    const s = fs.statSync(file);
    if (!s.isFile() || s.size < 8 * 1024 || s.size > 256 * 1024) return null;
    return { id, name, file, note, keepsSettings, size: s.size, built: s.mtime.toISOString() };
  } catch { return null; }
}

function listImages() {
  const { firmwareDir: fw } = config();
  const out = [
    info('latest', 'Open firmware (latest build)', path.join(fw, 'firmware', 'build', '2755', 'ry5088_2755_rydfu.bin'),
      'Your settings are kept. Coming from the stock firmware, settings start from defaults.', true),
    info('stock', 'Stock firmware (restore)', path.join(fw, 'stock', '2755', 'fw_at32.bin'),
      'Back to the Attack Shark firmware. Open-firmware features go away and settings may reset: export a profile first, then set actuation and calibrate in the Attack Shark app.', false),
  ];
  const prev = path.join(fw, 'firmware', 'build', 'previous');
  try {
    for (const f of fs.readdirSync(prev).filter((x) => x.endsWith('.bin')).sort().reverse())
      out.push(info(`previous:${f}`, `Earlier open firmware (${f.replace(/^ry5088_2755_|_rydfu\.bin$/g, '')})`, path.join(prev, f),
        'A saved earlier build. Settings may reset if it predates the current settings format: export a profile first.', false));
  } catch { /* no saved builds */ }
  return out.filter(Boolean);
}

function flasherPresent() { return fs.existsSync(config().flasher); }

// outcome: 'ok' | 'not-written' (nothing changed, safe to retry) | 'write-failed' (keep it plugged in, flash again)
const job = { running: false, log: [], ok: null, error: null, outcome: null, inUpdater: false, image: null, startedAt: null };

// Runs ry-flash; each stderr line goes to onLine as it arrives (ry-flash ends chunk
// progress with \r, so \r counts as a line end). stdout is kept whole for the JSON result.
// cp.spawn is looked up per call so the tests can stub it.
function run(exe, args, onLine = () => {}, timeoutMs = 180000) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '', partial = '', killed = false, done = false, timer = null, child;
    const lines = (parts) => parts.map((l) => l.trim()).filter(Boolean).forEach((l) => onLine(l));
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      lines([partial]);
      partial = '';
      resolve({ signal: null, killed, spawnError: null, stdout, stderr, ...r });
    };
    try { child = cp.spawn(exe, args, { windowsHide: true }); } catch (e) { return finish({ code: null, spawnError: e.message }); }
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => {
      stderr += d;
      const parts = (partial + d).split(/\r\n|\r|\n/);
      partial = parts.pop();   // an unfinished line waits for its end (or for close)
      lines(parts);
    });
    child.on('error', (e) => finish({ code: null, spawnError: e.message }));
    child.on('close', (code, signal) => finish({ code, signal }));
    timer = setTimeout(() => { killed = true; child.kill(); }, timeoutMs);
  });
}

// Exit codes from 0xC0000000 up are Windows exceptions: the process crashed rather than exited.
const NTSTATUS = { 0xC0000005: 'crashed (access violation)', 0xC0000409: 'aborted' };
function describeExit(r) {
  if (r.killed) return 'timed out';
  if (r.spawnError) return `did not start: ${r.spawnError}`;
  if (typeof r.code !== 'number') return r.signal ? `ended by ${r.signal}` : 'no exit code';
  const u = r.code >>> 0;
  if (u < 0xC0000000) return `exit code ${r.code}`;
  return `exit code 0x${u.toString(16).toUpperCase()}${NTSTATUS[u] ? `, ${NTSTATUS[u]}` : ''}`;
}
function diagnostic(r) {
  const out = r.stdout.trim();
  return `ry-flash: ${describeExit(r)}${r.signal ? `, signal ${r.signal}` : ''}; stdout: ${out ? out.slice(-300) : '(empty)'}`;
}

// What one `ry-flash --image <f> --arm --json` run means (flasher/src/main.rs): exit 0 ok,
// 1 error, 2 no device, 3 no image, 4 flash failed; stdout is one JSON object
// { ok, error, message, match, ... } and progress goes to stderr. The exit code decides
// success. A retry happens only when the run clearly stopped before the updater took over.
const PRE_WRITE_FLASH_FAIL = /^(not in normal mode|enter-bootloader \(ISP_PREPARE\) failed|did not re-enumerate to bootloader)/;
const PRE_WRITE_NO_RETRY = ['bad_args', 'bad_image', 'wrong_platform', 'no_image', 'fetch_failed', 'read_failed'];
function parseResult(stdout) {
  for (const line of stdout.split(/\r?\n/).reverse()) {
    try { const v = JSON.parse(line); if (v && typeof v === 'object') return v; } catch { /* not JSON */ }
  }
  return null;
}
function classify(r) {
  const res = parseResult(r.stdout);
  const message = res?.message ?? r.spawnError ?? (r.stderr.trim().split(/\r?\n/).pop() || `exit code ${r.code}`);
  if (r.code === 0) return { kind: 'ok', res, message };
  // stderr progress past this point means the updater was running and may have written
  const updaterStarted = /502A present|chunk \d+\/\d+|verifying re-enumeration/.test(r.stderr);
  if (!updaterStarted && !r.killed) {
    if (r.code === 2 || res?.error === 'no_device' || res?.error === 'hidapi') return { kind: 'retry', res, message };
    if (r.code === 4 && res?.error === 'flash_failed' && PRE_WRITE_FLASH_FAIL.test(message)) return { kind: 'retry', res, message };
    // crashed or quit after asking for the updater but before it showed up: nothing written,
    // though the keyboard may now sit in the updater (a rerun flashes it from there)
    if (!res && !r.spawnError && /entering bootloader/.test(r.stderr))
      return { kind: 'retry', res, updater: true, message: `ry-flash stopped while switching to the updater (${describeExit(r)})` };
    if (r.spawnError || PRE_WRITE_NO_RETRY.includes(res?.error) || (!res && /unknown arg/.test(r.stderr))) return { kind: 'stop', res, message };
  }
  return { kind: 'broken', res, message: r.killed ? 'ry-flash timed out' : message };
}

// Flashes image `id`; `prepare` closes the keyboard first. Resolves when done (job has the result).
async function flash(id, prepare = async () => {}, runner = run) {
  if (job.running) throw Object.assign(new Error('a flash is already running'), { status: 409 });
  const img = listImages().find((x) => x.id === id);
  if (!img) throw Object.assign(new Error('unknown firmware image'), { status: 400 });
  const { flasher } = config();
  if (!fs.existsSync(flasher) && runner === run) throw Object.assign(new Error(`ry-flash not found at ${flasher}`), { status: 400 });
  Object.assign(job, { running: true, log: [], ok: null, error: null, outcome: null, inUpdater: false, image: img.name, startedAt: new Date().toISOString() });
  const say = (line) => { job.log.push(line); };
  const fail = (outcome, msg) => { Object.assign(job, { ok: false, outcome, error: msg }); say(`Error: ${msg}`); return job; };
  const writeFailed = (msg) => fail('write-failed', `Failed during the update: ${msg}. Don't unplug the keyboard; `
    + 'flash it again (the updater itself is never touched, so a new flash recovers it).');
  // after a run stopped on the way to the updater the keyboard may be waiting there
  const unchanged = (tail) => (job.inUpdater ? 'The keyboard is in updater mode; click Flash again to finish.' : `The keyboard was not changed${tail}`);
  let ran = false;
  try {
    await prepare();
    say(`Flashing ${img.name} (${img.size} bytes)…`);
    for (let attempt = 1; attempt <= 3; attempt++) {
      ran = true;
      const r = await runner(flasher, ['--image', img.file, '--arm', '--json'], say);
      const c = classify(r);
      if (c.kind !== 'ok') say(diagnostic(r));
      if (c.updater) job.inUpdater = true;
      if (c.kind === 'ok') {
        Object.assign(job, { ok: true, outcome: 'ok' });
        if (!c.res) say('ry-flash reported success (exit 0) but its report was unreadable; check that the keyboard types.');
        else if (c.res.match === false) say('The keyboard came back but its model could not be read; check that it types.');
        // recover mode (board was already in the updater) writes without checking the model first
        if (c.res?.mode === 'recover' && c.res.post_dev_id != null && c.res.post_dev_id !== 2755)
          say(`Warning: flashed from updater mode without a model check, and the keyboard now reports model ${c.res.post_dev_id}, not 2755.`);
        say('Done: the keyboard is back with the new firmware.');
        return job;
      }
      if (c.kind === 'broken') return writeFailed(c.message);
      if (c.kind === 'stop') return fail('not-written', `Failed before writing: ${c.message}. ${unchanged('.')}`);
      if (attempt === 3) return fail('not-written', `Failed before writing: ${c.message}. ${unchanged('; safe to try again.')}`);
      say(c.updater ? `Nothing written yet (${c.message}); the keyboard may be in updater mode, trying again to finish the flash from there…`
        : `Nothing written yet (${c.message}); trying again…`);
      await sleep(2500);
    }
    return job;
  } catch (e) {
    return ran ? writeFailed(e.message) : fail('not-written', e.message);
  } finally {
    job.running = false;
  }
}

module.exports = { listImages, flasherPresent, flash, job, config, classify, run, describeExit };
