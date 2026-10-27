// The one-click flasher's retry rules, with child_process.spawn stubbed:
// no real ry-flash runs and nothing here touches a keyboard.
const test = require('node:test');
const assert = require('node:assert');
const cp = require('child_process');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const fs = require('fs');
const os = require('os');
const path = require('path');

// a temporary x68max-firmware layout with a latest build and a (fake) ry-flash binary
function fakeFirmwareDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x68fw-'));
  const put = (rel, size) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), Buffer.alloc(size)); };
  put('firmware/build/2755/ry5088_2755_rydfu.bin', 90000);
  put(`flasher/target/release/${process.platform === 'win32' ? 'ry-flash.exe' : 'ry-flash'}`, 10);
  return dir;
}
process.env.MAX68HE_FIRMWARE_DIR = fakeFirmwareDir();
delete require.cache[require.resolve('../src/flasher')];
const F = require('../src/flasher');
F.defaults.open = null;   // stubbed ry-flash: never open a real keyboard for the key-map backup

// what ry-flash --json prints (flasher/src/main.rs): one JSON line on stdout, progress on stderr
const PROGRESS = 'detected\nentering bootloader (stock firmware resets its config here)... 502A present.\n'
  + '\r  chunk 250/2072   \r  chunk 2072/2072   \nverifying re-enumeration to normal mode... ok\n';
const OK = { code: 0, stdout: `${JSON.stringify({ ok: true, armed: true, flashed: true, dev_id: 2755, post_dev_id: 2755, match: true, message: 'flash ok' })}\n`, stderr: PROGRESS };
const NO_DEVICE = { code: 2, stdout: `${JSON.stringify({ ok: false, error: 'no_device', message: 'could not read GET_INFOR (keyboard in normal mode, app closed?)' })}\n`, stderr: '' };
const CHECKSUM = { code: 4, stdout: `${JSON.stringify({ ok: false, error: 'flash_failed', message: 'checksum mismatch (ACK 0xAA) — board stays in 502A, safe to re-run' })}\n`, stderr: PROGRESS.replace(/verifying.*\n/, '') };

// a fake child process: stderr may be one string or a list of chunks, written one per tick;
// 'close' follows once both pipes have ended, as with a real child
function fakeChild(r) {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
  const chunks = [].concat(r.stderr ?? '');
  let ended = 0;
  const ends = () => { if (++ended === 2) setImmediate(() => child.emit('close', r.code, r.signal ?? null)); };
  child.stdout.on('end', ends);
  child.stderr.on('end', ends);
  const next = () => {
    if (chunks.length) { child.stderr.write(chunks.shift()); return setImmediate(next); }
    child.stderr.end();
    child.stdout.end(r.stdout ?? '');
  };
  setImmediate(next);
  return child;
}
// stub spawn with a queue of results; returns the argument lists it was called with
function stub(results) {
  const calls = [];
  cp.spawn = (exe, args) => { calls.push(args); return fakeChild(results.shift()); };
  return calls;
}
const realSpawn = cp.spawn;
test.after(() => { cp.spawn = realSpawn; delete process.env.MAX68HE_FIRMWARE_DIR; });

test('success on the first try: one run, with --arm --json', async () => {
  const calls = stub([OK]);
  let prepared = 0;
  const j = await F.flash('latest', async () => { prepared++; });
  assert.strictEqual(j.ok, true);
  assert.strictEqual(j.outcome, 'ok');
  assert.strictEqual(prepared, 1, 'the keyboard is released before flashing');
  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0].includes('--arm') && calls[0].includes('--json') && calls[0].some((a) => a.endsWith('ry5088_2755_rydfu.bin')));
  assert.ok(j.log.some((l) => /chunk 2072\/2072/.test(l)) && !j.running);
});

test('device not found, then success: retried, since nothing was written', async () => {
  const calls = stub([NO_DEVICE, OK]);
  const j = await F.flash('latest');
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(j.ok, true);
  assert.ok(j.log.some((l) => /Nothing written yet/.test(l)));
});

test('failure after the write started: no retry, says flash again', async () => {
  const calls = stub([CHECKSUM, OK]);
  const j = await F.flash('latest');
  assert.strictEqual(calls.length, 1, 'never rerun after the updater took over');
  assert.strictEqual(j.ok, false);
  assert.strictEqual(j.outcome, 'write-failed');
  assert.match(j.error, /checksum mismatch.*Don't unplug/);
});

test('exit 0 with unexpected text: success, no retry', async () => {
  const calls = stub([{ code: 0, stdout: 'something else entirely\n', stderr: '' }, OK]);
  const j = await F.flash('latest');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(j.ok, true);
  assert.ok(j.log.some((l) => /report was unreadable/.test(l)));
});

test('classify: pre-write vs. mid-write failures', () => {
  const r = (code, error, message, stderr = '') => F.classify({ code, stdout: JSON.stringify({ ok: false, error, message }), stderr });
  assert.strictEqual(r(4, 'flash_failed', 'not in normal mode (3151:5030/502D)').kind, 'retry');
  assert.strictEqual(r(4, 'flash_failed', 'did not re-enumerate to bootloader (502A) within 20s', 'entering bootloader... ').kind, 'retry');
  assert.strictEqual(r(4, 'flash_failed', 'not in bootloader mode (3151:502A)', 'entering bootloader... 502A present.\n').kind, 'broken');
  assert.strictEqual(r(4, 'flash_failed', 'did not return to normal mode (likely still in 502A; re-run)', PROGRESS).kind, 'broken');
  assert.strictEqual(r(4, 'post_flash_mismatch', 'flash completed but the board now reports a different dev_id').kind, 'broken');
  assert.strictEqual(r(1, 'bad_image', 'no chip-ID').kind, 'stop');
  assert.strictEqual(F.classify({ code: null, killed: true, stdout: '', stderr: '' }).kind, 'broken');
  assert.strictEqual(F.classify({ code: 1, stdout: '', stderr: 'mystery\n' }).kind, 'broken', 'unknown failures are not retried');
});

// the incident: open firmware -> stock, ry-flash crashed right after asking for the updater
const CRASH = { code: 3221225477, stdout: '', stderr: 'entering bootloader (stock firmware resets its config here)... ' };

test('crash while switching to the updater: retried, then flashed', async () => {
  const calls = stub([CRASH, OK]);
  const j = await F.flash('latest');
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(j.ok, true);
  assert.ok(j.log.some((l) => /^ry-flash: exit code 0xC0000005, crashed \(access violation\); stdout: \(empty\)$/.test(l)), j.log.join('\n'));
  assert.ok(j.log.some((l) => /Nothing written yet \(ry-flash stopped while switching to the updater/.test(l)));
  assert.ok(!j.log.some((l) => /Failed during the update/.test(l)));
});

test('crash every time: not written, and says the keyboard is in updater mode', async () => {
  stub([CRASH, CRASH, CRASH]);
  const j = await F.flash('latest');
  assert.strictEqual(j.ok, false);
  assert.strictEqual(j.outcome, 'not-written');
  assert.strictEqual(j.inUpdater, true);
  assert.match(j.error, /updater mode; click Flash again to finish/);
  assert.doesNotMatch(j.error, /not changed/);
});

test('stderr streams into the log in order, once each, including CR-separated chunk progress', async () => {
  stub([{ ...OK, stderr: ['detected\nentering boot', 'loader (stock firmware resets its config here)... ', '502A present.\n\r  chunk 1/3   ',
    '\r  chunk 2/3   \r  chunk 3/3   \nverifying re-enumeration to normal mode... ok'] }]);
  const j = await F.flash('latest');
  assert.deepStrictEqual(j.log.slice(1, -1), ['detected', 'entering bootloader (stock firmware resets its config here)... 502A present.',
    'chunk 1/3', 'chunk 2/3', 'chunk 3/3', 'verifying re-enumeration to normal mode... ok']);
});

test('recover mode onto another model: warns', async () => {
  stub([{ code: 0, stdout: JSON.stringify({ ok: true, mode: 'recover', post_dev_id: 2307, message: 'flash ok' }), stderr: '' }]);
  const j = await F.flash('latest');
  assert.strictEqual(j.ok, true);
  assert.ok(j.log.some((l) => /Warning: .*reports model 2307/.test(l)));
});

test('run(): lines arrive before exit; timeout kills; a spawn error resolves once', async () => {
  // a child that never exits on its own; kill() closes it the way Windows reports it
  let child;
  cp.spawn = () => {
    child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    child.kill = () => setImmediate(() => child.emit('close', null, 'SIGTERM'));
    return child;
  };
  const seen = [];
  const p = F.run('ry-flash', [], (l) => seen.push(l), 50);
  child.stderr.write('detected\r  chunk 1/2 ');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepStrictEqual(seen, ['detected'], 'a finished line shows up while ry-flash still runs');
  const r = await p;
  assert.deepStrictEqual({ code: r.code, signal: r.signal, killed: r.killed, spawnError: r.spawnError }, { code: null, signal: 'SIGTERM', killed: true, spawnError: null });
  assert.deepStrictEqual(seen, ['detected', 'chunk 1/2'], 'the unfinished line is flushed on close');
  assert.strictEqual(F.classify(r).kind, 'broken');

  cp.spawn = () => {
    child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
    setImmediate(() => { child.emit('error', new Error('spawn ry-flash ENOENT')); child.emit('close', -4058, null); });
    return child;
  };
  const e = await F.run('ry-flash', []);
  assert.deepStrictEqual({ code: e.code, killed: e.killed, spawnError: e.spawnError, stdout: e.stdout }, { code: null, killed: false, spawnError: 'spawn ry-flash ENOENT', stdout: '' });
  assert.strictEqual(F.classify(e).kind, 'stop');
});

test('describeExit: Windows crash codes in hex', () => {
  assert.strictEqual(F.describeExit({ code: 3221225477 }), 'exit code 0xC0000005, crashed (access violation)');
  assert.strictEqual(F.describeExit({ code: -1073740791 }), 'exit code 0xC0000409, aborted');
  assert.strictEqual(F.describeExit({ code: 4 }), 'exit code 4');
});

test('a real flash keeps the key maps by default (open defaults to the MAX68HE); fake runners do not', () => {
  const src = require('fs').readFileSync(require.resolve('../src/flasher'), 'utf8');
  assert.match(src, /open = runner === run \? defaults\.open : null/);
  delete require.cache[require.resolve('../src/flasher')];
  const fresh = require('../src/flasher');
  assert.strictEqual(typeof fresh.defaults.open, 'function', 'the default opener is set');
  delete require.cache[require.resolve('../src/flasher')];
});
