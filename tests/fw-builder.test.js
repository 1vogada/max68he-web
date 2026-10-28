// The firmware feature builder (src/fw-builder.js) with child_process.spawn stubbed: no make,
// compiler or preflight runs, and nothing here touches a keyboard.
const test = require('node:test');
const assert = require('node:assert');
const cp = require('child_process');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MANIFEST = { version: 1, profile: '2755', features: [
  { id: 'games', make: 'GAMES', default: 1, requires: [], caps: ['games'], name: 'Games', description: 'Game mode.' },
  { id: 'pfx', make: 'PFX', default: 1, requires: [], caps: ['pressureFx'], name: 'Pressure lighting', description: '14 effects.' },
  { id: 'watchdog', make: 'WATCHDOG', default: 1, requires: [], caps: [], name: 'Watchdog', description: 'Restarts a hung keyboard.' },
] };

// a temporary x68max-firmware layout: features.json, a latest build, the stock image, a (fake) ry-flash
function fakeFirmwareDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x68fwb-'));
  const put = (rel, data) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), data); };
  put('firmware/features.json', JSON.stringify(MANIFEST));
  put('firmware/build/2755/ry5088_2755_rydfu.bin', Buffer.alloc(90000, 7));
  put('stock/2755/fw_at32.bin', Buffer.alloc(200000, 1));
  put(`flasher/target/release/${process.platform === 'win32' ? 'ry-flash.exe' : 'ry-flash'}`, 'x');
  return dir;
}
const FW = fakeFirmwareDir();
process.env.MAX68HE_FIRMWARE_DIR = FW;
for (const m of ['../src/flasher', '../src/fw-builder']) delete require.cache[require.resolve(m)];
const flasher = require('../src/flasher');
const fwb = require('../src/fw-builder');
const Core = require('../web/fw-builder-core');
const P = require('../src/protocol');
fwb.deps.stamp = () => 'abc1234';

const REPORT = { flash: { used: 94000, limit: 132608 }, ram: { used: 83544, limit: 104448, reserved: 3072 }, sections: { '.text': 90000 }, flags: { GAMES: 1, PFX: 0, WATCHDOG: 1 } };

// a fake child: writes its stdout, then closes with code (hold: a promise it waits for first)
function fakeChild({ out = '', code = 0, hold = null }) {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
  (async () => {
    if (hold) await hold;
    child.stdout.end(out);
    child.stderr.end('');
    setImmediate(() => child.emit('close', code));
  })();
  return child;
}
// stubbed make / preflight: make writes the .bin into its GENDIR, preflight the _rydfu.bin
function stub({ preflightOk = true, hold = null } = {}) {
  const calls = [];
  cp.spawn = (exe, args, opts) => {
    calls.push({ exe, args, cwd: opts?.cwd });
    if (args.includes('size-report')) {
      const gen = args.find((a) => a.startsWith('GENDIR=')).slice(7);
      const dir = path.join(opts.cwd, gen);
      fs.mkdirSync(path.join(dir, 'obj'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'ry5088_2755.bin'), Buffer.alloc(94000, 3));
      return fakeChild({ out: `cc -c main.c\nwarning: _close is not implemented\nSIZE-REPORT ${JSON.stringify(REPORT)}\n`, hold });
    }
    const dir = path.join(opts.cwd, args[3]);
    fs.writeFileSync(path.join(dir, 'ry5088_2755_rydfu.bin'), Buffer.alloc(94512, 5));
    return fakeChild({ out: preflightOk ? 'built x\nPREFLIGHT PASSED\n' : '  FAIL: something\nPREFLIGHT FAILED\n', code: preflightOk ? 0 : 1 });
  };
  return calls;
}
const realSpawn = cp.spawn;
test.after(() => { cp.spawn = realSpawn; delete process.env.MAX68HE_FIRMWARE_DIR; fs.rmSync(FW, { recursive: true, force: true }); });
const finished = async () => { while (fwb.job.running) await new Promise((r) => setTimeout(r, 5)); return fwb.job; };

test('manifest and flags: defaults, unknown and non-boolean flags refused, make variables, label', () => {
  const m = fwb.readManifest(FW);
  assert.deepStrictEqual(m.features.map((f) => [f.id, f.make, f.default]), [['games', 'GAMES', true], ['pfx', 'PFX', true], ['watchdog', 'WATCHDOG', true]]);
  assert.deepStrictEqual(fwb.normalizeFlags(m, undefined), { games: true, pfx: true, watchdog: true });
  const f = fwb.normalizeFlags(m, { pfx: false, games: 0 });
  assert.deepStrictEqual(f, { games: false, pfx: false, watchdog: true });
  assert.deepStrictEqual(fwb.makeVars(m, f), ['GAMES=0', 'PFX=0', 'WATCHDOG=1']);
  assert.strictEqual(fwb.label(m, f), 'Custom build (games off, pressure lighting off)');
  assert.strictEqual(fwb.label(m, fwb.normalizeFlags(m, {})), 'Custom build (all features)');
  for (const [bad, re] of [[{ macros: false }, /unknown feature "macros"/], [{ pfx: 'no' }, /pfx: true or false/], [[1], /flags is an object/], ['x', /flags is an object/]])
    assert.throws(() => fwb.normalizeFlags(m, bad), (e) => e.status === 400 && re.test(e.message));
  // a feature on without one it requires
  const dep = fwb.checkManifest({ features: [...MANIFEST.features, { id: 'gauge', make: 'GAUGE', default: 1, requires: ['pfx'], name: 'Gauge', description: 'd' }] });
  assert.throws(() => fwb.normalizeFlags(dep, { pfx: false }), (e) => e.status === 400 && /Gauge needs Pressure lighting/.test(e.message));
  assert.throws(() => fwb.checkManifest({ features: [{ id: 'a', make: 'A', default: 1, requires: ['zz'] }] }), /requires unknown zz/);
  assert.throws(() => fwb.checkManifest({ features: [{ id: 'A b', make: 'A', default: 1 }] }), /bad entry/);
  // the key depends on the flags and on the firmware source
  assert.notStrictEqual(fwb.buildKey('abc1234', ['PFX=0']), fwb.buildKey('abc1234', ['PFX=1']));
  assert.notStrictEqual(fwb.buildKey('abc1234', ['PFX=0']), fwb.buildKey('abc1235', ['PFX=0']));
});

test('the real firmware manifest parses, when the sibling checkout has one', (t) => {
  const real = path.join(__dirname, '..', '..', 'x68max-firmware');
  if (!fs.existsSync(path.join(real, 'firmware', 'features.json'))) return t.skip('no x68max-firmware with features.json next to this checkout');
  const m = fwb.readManifest(real);
  assert.ok(m.features.length >= 1 && m.features.every((f) => f.name && f.description));
});

test('page logic: ticking pulls in what a feature requires, clearing drops what requires it; bar levels', () => {
  const feats = [{ id: 'a', requires: [] }, { id: 'b', requires: ['a'] }, { id: 'c', requires: ['b'] }, { id: 'd', requires: [] }];
  let r = Core.toggle(feats, { a: true, b: true, c: true, d: true }, 'a', false);
  assert.deepStrictEqual(r.state, { a: false, b: false, c: false, d: true });
  assert.deepStrictEqual(r.changed.sort(), ['b', 'c']);
  r = Core.toggle(feats, r.state, 'c', true);
  assert.deepStrictEqual(r.state, { a: true, b: true, c: true, d: true });
  assert.deepStrictEqual(Core.toggle(feats, r.state, 'd', false).changed, []);
  assert.deepStrictEqual(Core.defaults([{ id: 'x', default: true }, { id: 'y', default: false }]), { x: true, y: false });
  assert.strictEqual(Core.level(90, 100).level, 'ok');
  assert.strictEqual(Core.level(96, 100).level, 'warn');
  assert.strictEqual(Core.level(101, 100).level, 'over');
});

test('size report: the last SIZE-REPORT line among make noise; missing or broken refused', () => {
  const r = fwb.parseSizeReport(`make: Entering directory\r\nSIZE-REPORT ${JSON.stringify(REPORT)}\r\nmake: Leaving directory\r\n`);
  assert.deepStrictEqual(r.flash, { used: 94000, limit: 132608 });
  assert.deepStrictEqual(r.ram, { used: 83544, limit: 104448, reserved: 3072 });
  assert.strictEqual(r.flags.PFX, 0);
  assert.throws(() => fwb.parseSizeReport('cc -c main.c\n'), /no size report/);
  assert.throws(() => fwb.parseSizeReport('SIZE-REPORT {nope'), /size report/);
  assert.throws(() => fwb.parseSizeReport('SIZE-REPORT {"flash":{"used":1}}'), /used and limit missing/);
});

test('size estimate: builds in its own dir, removes it, then answers from the cache', async () => {
  const calls = stub();
  const r = await fwb.size({ flags: { pfx: false } });
  assert.strictEqual(r.cached, false);
  assert.strictEqual(r.flash.used, 94000);
  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0].args.includes(`GENDIR=build/fb-size-${r.key}`) && calls[0].args.includes('PFX=0'));
  assert.ok(!fs.existsSync(path.join(FW, 'firmware', 'build', `fb-size-${r.key}`)), 'the estimate dir is removed');
  const again = await fwb.size({ flags: { pfx: false } });
  assert.strictEqual(again.cached, true);
  assert.strictEqual(calls.length, 1, 'no second build');
  await assert.rejects(fwb.size({ flags: { nope: true } }), (e) => e.status === 400);
});

test('build: own dir, preflight, registered for the flasher; latest untouched; one at a time; again = already built', async () => {
  const latest = path.join(FW, 'firmware', 'build', '2755', 'ry5088_2755_rydfu.bin');
  const before = { data: fs.readFileSync(latest), mtime: fs.statSync(latest).mtimeMs };
  let release;
  const calls = stub({ hold: new Promise((r) => { release = r; }) });
  const s = fwb.build({ flags: { games: false, pfx: false } });
  assert.strictEqual(s.started, true);
  assert.strictEqual(s.label, 'Custom build (games off, pressure lighting off)');
  assert.throws(() => fwb.build({ flags: {} }), (e) => e.status === 409);
  release();
  const j = await finished();
  assert.strictEqual(j.ok, true, j.error);
  assert.strictEqual(j.id, `custom:${s.key}`);
  assert.ok(j.log.some((l) => l.includes('PREFLIGHT PASSED')) && j.log.some((l) => l.startsWith('Flash 94000 of 132608')));
  const make = calls.find((c) => c.args.includes('size-report'));
  assert.ok(make.args.includes(`GENDIR=build/custom-${s.key}`) && make.args.includes(`TARGET=build/custom-${s.key}/ry5088_2755`));
  assert.ok(!calls.some((c) => c.args.some((a) => /build[/\\]2755\b/.test(a))), 'nothing builds into build/2755');
  const pre = calls.find((c) => c.exe === process.execPath);
  assert.deepStrictEqual(pre.args.slice(1, 3), ['2755', path.join('stock', '2755', 'fw_at32.bin')]);
  const dir = path.join(FW, 'firmware', 'build', `custom-${s.key}`);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'image.json'), 'utf8'));
  assert.strictEqual(meta.preflight, 'passed');
  assert.deepStrictEqual(meta.vars, ['GAMES=0', 'PFX=0', 'WATCHDOG=1']);
  assert.ok(!fs.existsSync(path.join(dir, 'obj')), 'objects removed');

  const imgs = flasher.listImages();
  assert.deepStrictEqual(imgs.map((x) => x.id), ['latest', 'stock', `custom:${s.key}`]);
  const custom = imgs[2];
  assert.strictEqual(custom.name, 'Custom build (games off, pressure lighting off)');
  assert.strictEqual(custom.keepsSettings, true);
  assert.match(custom.note, /firmware abc1234 with 2 features left out/);
  assert.strictEqual(custom.file, path.join(dir, 'ry5088_2755_rydfu.bin'));
  assert.ok(fs.readFileSync(latest).equals(before.data) && fs.statSync(latest).mtimeMs === before.mtime, 'latest untouched');
  assert.strictEqual(imgs[0].file, latest);

  const calls2 = stub();
  fwb.build({ flags: { pfx: false, games: false } });
  const j2 = await finished();
  assert.strictEqual(j2.ok, true);
  assert.match(j2.log[0], /^Already built/);
  assert.strictEqual(calls2.length, 0);
});

test('a build whose preflight fails is not offered for flashing', async () => {
  stub({ preflightOk: false });
  const s = fwb.build({ flags: { watchdog: false } });
  const j = await finished();
  assert.strictEqual(j.ok, false);
  assert.match(j.error, /preflight failed/);
  assert.ok(!fs.existsSync(path.join(FW, 'firmware', 'build', `custom-${s.key}`, 'image.json')));
  assert.ok(!flasher.listImages().some((x) => x.id === `custom:${s.key}`));
  // a dir that looks like a build but has no passed preflight is ignored as well
  const fake = path.join(FW, 'firmware', 'build', 'custom-0123456789');
  fs.mkdirSync(fake, { recursive: true });
  fs.writeFileSync(path.join(fake, 'ry5088_2755_rydfu.bin'), Buffer.alloc(90000));
  fs.writeFileSync(path.join(fake, 'image.json'), JSON.stringify({ key: '0123456789', preflight: 'failed' }));
  assert.ok(!flasher.listImages().some((x) => x.id === 'custom:0123456789'));
});

test('routes: features list, unknown flags refused, one build at a time', async () => {
  const { ROUTES } = require('../src/web/server');
  for (const r of ['GET /api/firmware/features', 'POST /api/firmware/size', 'POST /api/firmware/build', 'GET /api/firmware/build'])
    assert.strictEqual(typeof ROUTES[r], 'function', r);
  const f = await ROUTES['GET /api/firmware/features']({});
  assert.strictEqual(f.available, true);
  assert.deepStrictEqual(f.features.map((x) => x.id), ['games', 'pfx', 'watchdog']);
  await assert.rejects(ROUTES['POST /api/firmware/size']({ flags: { turbo: true } }), (e) => e.status === 400 && /unknown feature "turbo"/.test(e.message));
  await assert.rejects(ROUTES['POST /api/firmware/build']({ flags: { games: 'off' } }), (e) => e.status === 400);
  let release;
  stub({ hold: new Promise((r) => { release = r; }) });
  const s = await ROUTES['POST /api/firmware/build']({ flags: { games: false } });
  assert.strictEqual(s.started, true);
  await assert.rejects(ROUTES['POST /api/firmware/build']({ flags: { pfx: false } }), (e) => e.status === 409);
  assert.strictEqual((await ROUTES['GET /api/firmware/build']({})).running, true);
  release();
  assert.strictEqual((await finished()).ok, true);
  // a firmware checkout without features.json: not available, with the reason
  fwb.deps.firmwareDir = () => path.join(FW, 'nowhere');
  try {
    const n = await ROUTES['GET /api/firmware/features']({});
    assert.strictEqual(n.available, false);
    assert.match(n.reason, /no feature list/);
  } finally { fwb.deps.firmwareDir = () => FW; }
});

test('CAPS word 3: pressure effects and Droplet follow a custom build; older firmware unchanged', () => {
  const caps = (w1, w2, w3) => [0xf8, 4, 90, 68, 15, 6, w1 & 0xff, w1 >> 8, w2 & 0xff, w2 >> 8, ...(w3 == null ? [] : [w3 & 0xff, w3 >> 8])];
  const old = P.parseCaps(caps(0xffff, 0xffff));
  assert.strictEqual(old.caps3, undefined);
  assert.ok(P.openModesFor(old)[0x4c] && P.openModesFor(old)[0x42]);
  const full = P.parseCaps(caps(0xffff, 0xffff, 0x8001));
  assert.ok(full.caps3 && full.features.includes('pressureFx') && P.openModesFor(full)[0x4c]);
  const lean = P.parseCaps(caps(0xffff & ~(1 << 2) & ~(1 << 15), 0xffff, 0x8000));
  const modes = P.openModesFor(lean);
  assert.ok(!modes[0x4c] && !modes[0x59] && !modes[0x42] && !modes[0x43], 'pressure, droplet and fx modes hidden');
  assert.ok(modes[0x40], 'random rainbow stays');
});
