// Features page: the pure logic (web/features-core.js) against a features.json with the
// contract's optional fields (tests/fixtures/features-full.json), and the server passing
// those fields through (src/fw-builder.js checkManifest / GET /api/firmware/features).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../web/features-core');
const fwb = require('../src/fw-builder');

const RAW = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'features-full.json'), 'utf8'));
const M = fwb.checkManifest(RAW);
const all = C.defaults(M.features);
const off = (...ids) => ({ ...all, ...Object.fromEntries(ids.map((i) => [i, false])) });

test('server: group, storage, cost, sizes and alwaysOn pass through; bad or missing ones are null', () => {
  const games = M.features.find((f) => f.id === 'games');
  assert.deepStrictEqual([games.group, games.storage, games.cost], ['games', 'none', { flash: 9000, ram: 2000 }]);
  assert.strictEqual(M.features.find((f) => f.id === 'droplet').cost, null);
  assert.deepStrictEqual(M.sizes.full, { flash: 120000, ram: 90000 });
  assert.strictEqual(M.sizes.commit, 'abc1234');
  assert.deepStrictEqual(M.alwaysOn.map((a) => a.name), ['Hall sensor scan', 'USB']);
  const old = fwb.checkManifest({ features: [{ id: 'a', make: 'A', default: 1, group: 'nonsense', cost: { flash: -1, ram: 2 } }],
    sizes: { full: { flash: 1, ram: 1 }, limits: { flash: 0, ram: 5 } }, alwaysOn: [{ reason: 'no name' }, 'x'] });
  assert.deepStrictEqual([old.features[0].group, old.features[0].cost, old.features[0].storage, old.sizes, old.alwaysOn], [null, null, null, null, []]);
});

test('server: GET /api/firmware/features carries sizes and alwaysOn from the checkout', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x68feat-'));
  fs.mkdirSync(path.join(dir, 'firmware'));
  fs.writeFileSync(path.join(dir, 'firmware', 'features.json'), JSON.stringify(RAW));
  const saved = { ...fwb.deps };
  Object.assign(fwb.deps, { firmwareDir: () => dir, stamp: () => 'abc1234' });
  try {
    const { fwBuilderRoutes } = require('../src/web/fw-builder-routes');
    const r = await fwBuilderRoutes()['GET /api/firmware/features']({});
    assert.strictEqual(r.available, true);
    assert.strictEqual(r.features.length, 14);
    assert.deepStrictEqual(r.sizes.limits, { flash: 132608, ram: 104448 });
    assert.strictEqual(r.alwaysOn.length, 2);
  } finally { Object.assign(fwb.deps, saved); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('rows by group in a fixed order; older lists without group fall back by id', () => {
  assert.deepStrictEqual(C.grouped(M.features).map((g) => g.id), ['lighting', 'input', 'layers', 'system', 'games']);
  const old = fwb.checkManifest({ features: [{ id: 'watchdog', make: 'W', default: 1 }, { id: 'pfx', make: 'P', default: 1 }, { id: 'zz', make: 'Z', default: 1 }] });
  assert.deepStrictEqual(C.grouped(old.features).map((g) => [g.id, g.features.map((f) => f.id)]),
    [['lighting', ['pfx']], ['system', ['watchdog']], ['other', ['zz']]]);
});

test('cost text: minus when switching off frees it, plus when switching on; unknown without cost', () => {
  const pfx = M.features.find((f) => f.id === 'pfx');
  assert.strictEqual(C.costText(pfx, true), '−11.7 KB flash, −7.8 KB RAM');
  assert.strictEqual(C.costText(pfx, false), '+11.7 KB flash, +7.8 KB RAM');
  assert.strictEqual(C.costText(M.features.find((f) => f.id === 'droplet'), true), 'size unknown');
  assert.strictEqual(C.costText(M.features.find((f) => f.id === 'watchdog'), true), '−0.3 KB flash, no RAM');
});

test('dependency closure: off drops what requires it (all the way), on pulls in what it requires', () => {
  let r = C.toggle(M.features, all, 'keyact', false);
  assert.deepStrictEqual(r.changed.sort(), ['mk_pressure', 'modes', 'mousekeys']);
  assert.strictEqual(C.dependencyNote(M.features, r.changed.sort(), false), 'Also off (needs it): Pressure mouse, Modes, Mouse keys.');
  r = C.toggle(M.features, r.state, 'mk_pressure', true);
  assert.deepStrictEqual(r.changed.sort(), ['keyact', 'mousekeys']);
  assert.strictEqual(r.state.modes, false, 'what it does not need stays off');
  assert.strictEqual(C.dependencyNote(M.features, [], true), '');
  assert.deepStrictEqual([...C.dependents(M.features, 'keyact')].sort(), ['mk_pressure', 'modes', 'mousekeys']);
  assert.strictEqual(C.relations(M.features, M.features.find((f) => f.id === 'mousekeys')), 'Needs Key actions. Needed by Pressure mouse.');
});

test('projection: full minus the cost of what is off, a dependent counted once inside its parent', () => {
  const p = C.projection(M, off('games', 'pfx'));
  assert.deepStrictEqual([p.known, p.flash, p.ram, p.freed], [true, 120000 - 21000, 90000 - 10000, { flash: 21000, ram: 10000 }]);
  const chain = C.toggle(M.features, all, 'keyact', false).state;   // keyact's cost already holds modes / mouse keys
  assert.deepStrictEqual(C.counted(M.features, chain).map((f) => f.id), ['keyact']);
  assert.strictEqual(C.projection(M, chain).flash, 112000);
  assert.strictEqual(C.projection(M, all).flash, 120000);
});

test('projection degrades: unknown with an off feature that has no cost, or a list without sizes', () => {
  const p = C.projection(M, off('droplet', 'games'));
  assert.deepStrictEqual([p.known, p.missing], [false, ['droplet']]);
  const bare = { ...M, sizes: null };
  assert.strictEqual(C.projection(bare, all).known, false);
  assert.match(C.projection(bare, all).why, /no sizes/);
});

test('bars: current from the memory report (or null), levels as the builder', () => {
  const cur = C.currentBars({ flashUsed: 114324, flashSize: 132608, ramStatic: 74816, ramReserved: 5120, ramSize: 104448 });
  assert.deepStrictEqual(cur.map((b) => [b.name, b.used, b.level]), [['Flash', 114324, 'ok'], ['RAM', 79936, 'ok']]);
  assert.match(cur[0].text, /^111\.6 KB of 129\.5 KB · 86\.2 %$/);
  assert.strictEqual(C.currentBars(null), null);
  assert.strictEqual(C.currentBars({ flashUsed: 1 }), null);
  assert.strictEqual(C.bars(130000, 1, { flash: 132608, ram: 10 })[0].level, 'warn');
  assert.strictEqual(C.bars(140000, 1, { flash: 132608, ram: 10 })[0].level, 'over');
});

test('in-use warnings: only for features switched off, only when the data is there', () => {
  const use = { textKeys: 2, sequencePlaying: true, glideActions: 1, lightingMode: 0x50, keyActionMaps: 5, mouseActions: 0,
    userLayerKeys: 3, calibratedKeys: 68 };
  assert.deepStrictEqual(C.warnings(M.features, all, use), []);
  const w = C.warnings(M.features, off('text', 'sequence', 'glide', 'pfx', 'fx', 'keyact', 'mousekeys', 'user_layers', 'calib', 'watchdog', 'droplet'), use);
  assert.deepStrictEqual(w.map((x) => x.id), ['pfx', 'sequence', 'glide', 'text', 'keyact', 'user_layers', 'calib', 'watchdog']);
  assert.match(w.find((x) => x.id === 'text').text, /^2 saved texts: /);
  assert.match(w.find((x) => x.id === 'pfx').text, /pressure effect/);
  assert.match(w.find((x) => x.id === 'keyact').text, /^5 keys /);
  // fx / droplet follow the lighting mode
  assert.deepStrictEqual(C.warnings(M.features, off('fx', 'droplet', 'pfx'), { lightingMode: 0x42 }).map((x) => x.id), ['droplet']);
  assert.deepStrictEqual(C.warnings(M.features, off('fx'), { lightingMode: 0x45 }).map((x) => x.id), ['fx']);
  // nothing known (web version, stock firmware): only the always-true watchdog note
  assert.deepStrictEqual(C.warnings(M.features, off('text', 'keyact', 'watchdog'), {}).map((x) => x.id), ['watchdog']);
  assert.match(C.warnings([{ id: 'text', name: 'T' }], { text: false }, { textKeys: 1 })[0].text, /^1 saved text: /);
});

test('CAPS word 3: switchable feature bits are read only when bit 14 says they follow the build', () => {
  const P = require('../src/protocol');
  const r = new Array(64).fill(0);
  r[6] = 0xff; r[7] = 0xff;
  const w3 = (v) => { r[10] = v & 0xff; r[11] = v >> 8; return P.parseCaps(r).features; };
  const on = w3(0x8000 | 0x4000 | (1 << 2) | (1 << 5) | (1 << 13) | 1);
  for (const f of ['pressureFx', 'dks', 'mouseKeys', 'userLayers', 'buildBits']) assert.ok(on.includes(f), f);
  assert.ok(!on.includes('advKeys') && !on.includes('scanTiming'));
  const old = w3(0x8000 | (1 << 2) | 1);
  assert.ok(old.includes('pressureFx') && !old.includes('dks'), 'older firmware: bits 2..13 not read');
});
