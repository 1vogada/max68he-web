// The flasher keeps the key action maps over a firmware update: read before (file + memory),
// written back and compared after. Fake keyboards and a fake ry-flash runner only.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fakeKeyboard } = require('./fixtures/ka-fake');

const fwDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x68fw-ka-'));
for (const rel of ['firmware/build/2755/ry5088_2755_rydfu.bin', 'stock/2755/fw_at32.bin']) {
  fs.mkdirSync(path.dirname(path.join(fwDir, rel)), { recursive: true });
  fs.writeFileSync(path.join(fwDir, rel), Buffer.alloc(90000));
}
process.env.MAX68HE_FIRMWARE_DIR = fwDir;
const F = require('../src/flasher');
F.defaults.open = null;   // stubbed ry-flash: never open a real keyboard for the key-map backup
test.after(() => { delete process.env.MAX68HE_FIRMWARE_DIR; fs.rmSync(fwDir, { recursive: true, force: true }); });

const OK = { code: 0, stdout: `${JSON.stringify({ ok: true, flashed: true, dev_id: 2755, post_dev_id: 2755, match: true, message: 'flash ok' })}\n`, stderr: 'chunk 1/1\n' };
const MAPS = [
  { key: 'W', rules: [{ when: 'press', do: { axis: 'LY-', percent: 40 } }, { when: 'down', at: 2.5, do: { axis: 'LY-', percent: 100 } }] },
  { slot: 9, rules: [{ when: 'hold', ms: 3000, do: { gamepad: 'LB' } }] },
  { key: 'D', alsoType: true, rules: [{ when: 'tap', ms: 200, do: { key: 'E' } }] },
];
async function withMaps(opts) {
  const f = fakeKeyboard(opts);
  for (const m of MAPS) await f.kb.setKeyActions(m);
  f.sent.length = 0;
  return f;
}
// open() hands out these in turn: a keyboard, null (not back yet) or an Error (thrown)
function opener(list) {
  const o = async () => { o.calls++; const x = list.shift() ?? null; if (x instanceof Error) throw x; return x; };
  o.calls = 0;
  return o;
}
const sets = (f) => f.sent.filter((p) => p[0] === 0xee && p[1] === 2);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'max68he-keymaps-'));
const files = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);
const sorted = (table) => [...table].sort((a, b) => a[0] - b[0]);

test('3 maps: kept in a file, flashed, written back after a re-enumeration wait, read back equal', async () => {
  const before = await withMaps(), after = fakeKeyboard(), dir = tmp();
  const open = opener([before.kb, null, new Error('not found'), after.kb]);
  let ran = 0;
  const runner = async () => { ran++; assert.strictEqual(before.kb.closed, 1, 'the backup handle is closed before ry-flash runs'); return OK; };
  const j = await F.flash('latest', async () => {}, runner, { open, backupDir: dir, reopenMs: 1 });
  assert.strictEqual(j.outcome, 'ok');
  assert.strictEqual(ran, 1);
  const [name] = files(dir);
  assert.match(name, /^keymaps-.*\.json$/);
  const file = path.join(dir, name);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(saved.maps.map((m) => [m.slot, m.record]), sorted(before.table));
  assert.deepStrictEqual(saved.maps.map((m) => m.map.key), ['A', 'W', 'D'], 'the readable form too');
  assert.strictEqual(sets(after).length, 3, 'SET for every map');
  assert.deepStrictEqual(sorted(after.table), sorted(before.table));
  assert.deepStrictEqual(j.keyMaps, { kept: 3, restored: 3, file, error: null });
  assert.ok(j.log.includes(`Kept 3 key maps (A (slot 9), W (slot 14), D (slot 21)) in memory and in ${file}.`), j.log.join('\n'));
  assert.ok(j.log.includes('Restored 3 key maps.'));
  assert.strictEqual(open.calls, 4);
  assert.strictEqual(after.kb.closed, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('restore problems name the keys; the flash stays ok and the file is kept', async () => {
  const before = await withMaps(), dir = tmp();
  // W is stored with one byte changed, D is refused (table full)
  const after = fakeKeyboard({ set: (slot, body) => (slot === 14 ? body.map((v, i) => (i === 2 ? v + 1 : v)) : slot === 21 ? 2 : undefined) });
  const j = await F.flash('latest', async () => {}, async () => OK, { open: opener([before.kb, after.kb]), backupDir: dir });
  assert.strictEqual(j.outcome, 'ok');
  assert.strictEqual(j.ok, true);
  assert.strictEqual(j.keyMaps.restored, 1);
  assert.strictEqual(j.keyMaps.kept, 3);
  const file = path.join(dir, files(dir)[0]);
  assert.ok(fs.existsSync(file));
  const line = j.log.find((l) => l.startsWith('Key maps: restored 1 of 3'));
  assert.ok(line, j.log.join('\n'));
  assert.match(line, /D \(slot 21\): keyboard refused the key map: the key action table is full/);
  assert.match(line, /W \(slot 14\): reads back different/);
  assert.doesNotMatch(line, /slot 9/);
  assert.ok(line.endsWith(`The backup is in ${file}.`));
  assert.match(j.keyMaps.error, /restored 1 of 3/);
  assert.ok(!j.log.some((l) => /^Restored/.test(l)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('no keyActions before (older open firmware, stock): no backup, no restore, no 0xEE', async () => {
  for (const opts of [{ caps2: 0x7fff }, { custom: false }]) {
    const before = fakeKeyboard(opts), dir = tmp();
    const open = opener([before.kb, fakeKeyboard()]);
    const j = await F.flash('latest', async () => {}, async () => OK, { open, backupDir: dir });
    assert.strictEqual(j.outcome, 'ok');
    assert.strictEqual(j.keyMaps, null);
    assert.deepStrictEqual(files(dir), []);
    assert.strictEqual(open.calls, 1, 'nothing to restore: the keyboard is not reopened');
    assert.ok(!before.sent.some((p) => p[0] === 0xee));
    assert.ok(!j.log.some((l) => /key map|Error/i.test(l)), j.log.join('\n'));
  }
});

test('keyActions before, empty table: says so, no file, no restore', async () => {
  const before = fakeKeyboard(), dir = tmp();
  const open = opener([before.kb]);
  const j = await F.flash('latest', async () => {}, async () => OK, { open, backupDir: dir });
  assert.ok(j.log.includes('No key maps to keep.'));
  assert.deepStrictEqual(j.keyMaps, { kept: 0, restored: 0, file: null, error: null });
  assert.deepStrictEqual(files(dir), []);
  assert.strictEqual(open.calls, 1);
});

test('keyActions before but not after: file kept, log says so, nothing written', async () => {
  const before = await withMaps(), after = fakeKeyboard({ caps2: 0x7fff }), dir = tmp();
  const j = await F.flash('latest', async () => {}, async () => OK, { open: opener([before.kb, after.kb]), backupDir: dir });
  assert.strictEqual(j.outcome, 'ok');
  const file = path.join(dir, files(dir)[0]);
  assert.ok(j.log.includes(`Key maps: the new firmware has no key action maps, so the 3 maps were not restored. The backup is in ${file}.`), j.log.join('\n'));
  assert.deepStrictEqual(j.keyMaps, { kept: 3, restored: 0, file, error: 'the new firmware has no key action maps, so the 3 maps were not restored' });
  assert.ok(!after.sent.some((p) => p[0] === 0xee));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('stock image with maps: backup first, a warning pointing to it, no restore', async () => {
  const before = await withMaps(), dir = tmp();
  const open = opener([before.kb, fakeKeyboard()]);
  const calls = [];
  const j = await F.flash('stock', async () => {}, async (exe, args) => { calls.push(args); return OK; }, { open, backupDir: dir });
  assert.strictEqual(j.outcome, 'ok');
  assert.ok(calls[0].some((a) => a.endsWith('fw_at32.bin')));
  const file = path.join(dir, files(dir)[0]);
  const warn = j.log.findIndex((l) => l === `Warning: the stock firmware has no key action maps, so the 3 kept here can't survive; they stay in ${file}.`);
  assert.ok(warn >= 0 && warn < j.log.findIndex((l) => /^Flashing/.test(l)), j.log.join('\n'));
  assert.strictEqual(open.calls, 1);
  assert.match(j.keyMaps.error, /stock firmware/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('reading the maps fails before the flash: not written, ry-flash never runs', async () => {
  const before = await withMaps(), dir = tmp();
  const q = before.kb.t.query;
  before.kb.t.query = async (p) => { if (p[0] === 0xee && p[1] === 1) throw Object.assign(new Error('read timed out'), { device: true }); return q(p); };
  let ran = 0;
  const j = await F.flash('latest', async () => {}, async () => { ran++; return OK; }, { open: opener([before.kb]), backupDir: dir });
  assert.strictEqual(ran, 0);
  assert.strictEqual(j.outcome, 'not-written');
  assert.strictEqual(j.ok, false);
  assert.match(j.error, /Could not read the key action maps before flashing \(read timed out\).*Nothing was flashed; try again/);
  assert.deepStrictEqual(files(dir), []);
  assert.strictEqual(before.kb.closed, 1);
});

test('the keyboard does not open before the flash (e.g. in updater mode): flashes without a backup', async () => {
  const dir = tmp();
  const open = opener([new Error('no MAX68HE found')]);
  const j = await F.flash('latest', async () => {}, async () => OK, { open, backupDir: dir });
  assert.strictEqual(j.outcome, 'ok');
  assert.ok(j.log.some((l) => /could not open the keyboard to read them \(no MAX68HE found\); flashing without a key map backup/.test(l)));
  assert.strictEqual(j.keyMaps, null);
  assert.strictEqual(open.calls, 1);
});

test('the keyboard never comes back: flash ok, the backup named', async () => {
  const before = await withMaps(), dir = tmp();
  const j = await F.flash('latest', async () => {}, async () => OK, { open: opener([before.kb]), backupDir: dir, reopenTries: 3, reopenMs: 1 });
  assert.strictEqual(j.outcome, 'ok');
  assert.match(j.keyMaps.error, /could not be opened after the flash \(not found\)/);
  assert.ok(j.log.some((l) => /^Key maps: the keyboard could not be opened after the flash.*The backup is in /.test(l)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a flash that fails while writing points to the key map backup and restores nothing', async () => {
  const before = await withMaps(), dir = tmp();
  const open = opener([before.kb]);
  const broken = { code: 4, stdout: `${JSON.stringify({ ok: false, error: 'flash_failed', message: 'chunk write failed' })}\n`, stderr: '502A present\nchunk 3/40\n' };
  const j = await F.flash('latest', async () => {}, async () => broken, { open, backupDir: dir });
  assert.strictEqual(j.outcome, 'write-failed');
  const file = path.join(dir, files(dir)[0]);
  assert.ok(j.error.includes(`the backup is in ${file}.`), j.error);
  assert.strictEqual(open.calls, 1, 'no reopen to restore after a failed write');
  fs.rmSync(dir, { recursive: true, force: true });
});
