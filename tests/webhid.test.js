// Web version: the WebHID stand-in for node-hid (web-build/node-hid.js) and the fs one.
// The key guarantee: the same keyboard calls put the same bytes on the wire as the
// desktop app (node-hid), so the web page can't drift from what the firmware expects.
const test = require('node:test');
const assert = require('node:assert');
const webhid = require('../web-build/node-hid');
// as in the browser bundle: src/hid.js gets the WebHID stand-in where it asks for node-hid
const nodeHidPath = require.resolve('node-hid');
require.cache[nodeHidPath] = { id: nodeHidPath, filename: nodeHidPath, loaded: true, exports: webhid };
const { Transport } = require('../src/hid');
const { Keyboard } = require('../src/keyboard');
const P = require('../src/protocol');

// What the keyboard answers: an echo of the opcode, IDENTIFY as a 2755 on the open firmware.
function reply(pkt) {
  const r = new Array(64).fill(0);
  r[0] = pkt[0];
  if (pkt[0] === P.OP.IDENTIFY) Object.assign(r, { 1: 0xc3, 2: 0x0a, 3: 1, 4: 2, 7: 0x04, 8: 0x05 });
  return r;
}

// a browser HIDDevice: two interfaces' worth of collections, like the real MAX68HE
function fakeHidDevice(log, { keepId = false } = {}) {
  let last = null;
  const listeners = new Set();
  return {
    vendorId: 0x3151, productId: 0x502d, productName: 'MAX68HE', opened: false,
    collections: [{ usagePage: 0xffff, usage: 1, inputReports: [{ reportId: 5 }] }, { usagePage: 0xffff, usage: 2, inputReports: [] }],
    async open() { this.opened = true; },
    async sendFeatureReport(id, data) { last = [...data]; log.push([id, ...data]); },
    async receiveFeatureReport(id) {
      const r = reply(last);
      return new DataView(new Uint8Array(keepId ? [id, ...r] : r).buffer);
    },
    addEventListener(t, fn) { if (t === 'inputreport') listeners.add(fn); },
    removeEventListener(t, fn) { listeners.delete(fn); },
    input(reportId, bytes) { const data = new DataView(new Uint8Array(bytes).buffer); listeners.forEach((fn) => fn({ reportId, data })); },
  };
}

function fakeHidApi(devices) {
  return { getDevices: async () => devices, requestDevice: async () => devices, addEventListener() {} };
}

// node-hid's HID object, as src/hid.js uses it
function fakeNodeHid(log) {
  let last = null;
  return {
    sendFeatureReport(bytes) { last = bytes.slice(1); log.push([...bytes]); return bytes.length; },
    getFeatureReport() { return [0, ...reply(last)]; },
    close() {},
  };
}

function transportOn(dev) {
  const t = Object.create(Transport.prototype);
  Object.assign(t, { dev, busy: Promise.resolve() });
  return t;
}

async function steps(k) {
  await k.identify();
  await k.getProfile();
  await k.getCaps();
  await k.t.send(P.packet(P.OP.TRAVEL_STREAM, [1]));
  await k.t.queryPage(P.packet(P.OP.GET_PROFILE));
  return k.info;
}

test('the same calls send the same bytes over WebHID as over node-hid', async () => {
  const webLog = [], nodeLog = [];
  await webhid.init(fakeHidApi([fakeHidDevice(webLog)]));
  const path = webhid.devices().find((d) => d.usagePage === 0xffff && d.usage === 2).path;
  const viaWeb = new Keyboard(new Transport(path));
  const viaNode = new Keyboard(transportOn(fakeNodeHid(nodeLog)));
  const a = await steps(viaWeb);
  const b = await steps(viaNode);
  assert.deepStrictEqual(a, b, 'both read the same keyboard');
  assert.strictEqual(a.boardId, 2755);
  assert.ok(a.custom);
  assert.ok(webLog.length >= 5);
  assert.deepStrictEqual(webLog, nodeLog);
  assert.ok(webLog.every((p) => p.length === 65 && p[0] === 0), 'report id 0 + 64 bytes, like node-hid');
});

test('a reply that keeps the report id byte reads the same', async () => {
  const log = [];
  await webhid.init(fakeHidApi([fakeHidDevice(log, { keepId: true })]));
  const path = webhid.devices().filter((d) => d.usage === 2).pop().path;
  const k = new Keyboard(new Transport(path));
  assert.strictEqual((await k.identify()).boardId, 2755);
});

test('devices() lists collections like node-hid; input reports reach only their collection', async () => {
  const dev = fakeHidDevice([]);
  await webhid.init(fakeHidApi([dev]));
  const list = webhid.devices().filter((d) => d.productId === 0x502d);
  assert.ok(list.some((d) => d.usagePage === 0xffff && d.usage === 1));
  assert.ok(list.some((d) => d.usagePage === 0xffff && d.usage === 2));
  const travel = new webhid.HID(list.find((d) => d.usage === 1).path);
  const got = [];
  travel.on('data', (d) => got.push(d));
  dev.input(5, [0x1b, 40, 0, 9]);
  dev.input(6, [1, 2, 3]);                         // another collection's report
  assert.deepStrictEqual(got, [[5, 0x1b, 40, 0, 9]]);
  assert.deepStrictEqual(P.parseTravel(got[0]), { slot: 9, counts: 40 });
  travel.close();
  dev.input(5, [0x1b, 41, 0, 9]);
  assert.strictEqual(got.length, 1, 'closed: no more reports');
});

test('a device that went away fails like a stale handle (nothing sent)', async () => {
  const dev = fakeHidDevice([]);
  await webhid.init(fakeHidApi([dev]));
  const path = webhid.devices().filter((d) => d.usage === 2).pop().path;
  const t = new Transport(path);
  dev.opened = false;                              // unplugged
  const e = await t.send(P.packet(P.OP.GET_PROFILE)).catch((x) => x);
  assert.ok(e.device && e.unsent, 'device error, marked unsent so connection.js reopens and retries');
});

test('fs stand-in: files in localStorage, directories implied, backups capped', () => {
  const mem = new Map();
  globalThis.localStorage = {
    get length() { return mem.size; }, key: (i) => [...mem.keys()][i] ?? null,
    getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k),
  };
  const fs = require('../web-build/fs');
  assert.throws(() => fs.readFileSync('/app/config/ui.json'), (e) => e.code === 'ENOENT');
  fs.writeFileSync('/app/config/ui.json', '{"a":1}');
  assert.strictEqual(fs.readFileSync('/app/config/ui.json', 'utf8'), '{"a":1}');
  assert.ok(fs.existsSync('/app/config'));
  fs.writeFileSync('/app/config/profiles/abc.json', 'x');
  assert.deepStrictEqual(fs.readdirSync('/app/config'), ['profiles', 'ui.json']);
  for (let i = 0; i < 8; i++) fs.writeFileSync(`/app/config/backups/profile0-${i}.json`, String(i));
  assert.deepStrictEqual(fs.readdirSync('/app/config/backups'), [3, 4, 5, 6, 7].map((i) => `profile0-${i}.json`));
  fs.unlinkSync('/app/config/profiles/abc.json');
  assert.ok(!fs.existsSync('/app/config/profiles'));
  // the real config modules work on it unchanged
  const { store } = require('../src/profiles');
  const s = store('/app/config');
  s.setOnboard(1, { name: 'Web' });
  assert.strictEqual(s.meta().onboard[1].name, 'Web');
  delete globalThis.localStorage;
});

test('the web build bundles: driver before the page scripts, no Node-only modules inside', async () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const { build } = require('../scripts/build-web');
  const out = await build({ outDir: fs.mkdtempSync(path.join(os.tmpdir(), 'max68he-site-')), minify: false, firmwareDir: null });
  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.ok(html.indexOf('driver.js') > 0 && html.indexOf('driver.js') < html.indexOf('ui.js'));
  const js = fs.readFileSync(path.join(out, 'driver.js'), 'utf8');
  for (const bad of ['require("node-hid")', 'require("fs")', 'require("child_process")', 'HID.node', '.node"']) {
    assert.ok(!js.includes(bad), `bundle has ${bad}`);
  }
  assert.ok(js.includes('requestDevice'), 'the WebHID stand-in is in');
  assert.ok(fs.existsSync(path.join(out, 'plugins', 'games')), 'plugin files copied');
  assert.ok(fs.existsSync(path.join(out, 'THIRD_PARTY_NOTICES.md')), 'notices on the site');
  // Blockly (Key wizard Blocks view) ships as its own files with its licence, loaded only when the view opens
  for (const f of ['blockly_compressed.js', 'msg/en.js', 'media/sprites.svg', 'LICENSE.txt']) assert.ok(fs.existsSync(path.join(out, 'vendor', 'blockly', f)), `vendor/blockly/${f}`);
  assert.ok(!html.includes('blockly_compressed'), 'Blockly is lazy-loaded, not in the page');
  assert.match(fs.readFileSync(path.join(out, 'THIRD_PARTY_NOTICES.md'), 'utf8'), /blockly.*Apache License 2\.0/i);
  // flashing over WebHID is in; no firmware image is on the site unless a build asks for one
  assert.ok(build.inputs.some((i) => i.endsWith('src/ryflash.js')) && build.inputs.some((i) => i.endsWith('web-build/web-flash.js')));
  assert.deepStrictEqual(fs.readdirSync(path.join(out, 'firmware')), ['manifest.json'], 'no firmware hosted by default');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(out, 'firmware', 'manifest.json'), 'utf8')).images, []);
  // THIRD_PARTY_NOTICES.md says no package's code is bundled: keep it true
  assert.deepStrictEqual(build.inputs.filter((i) => i.includes('node_modules')), []);
  fs.rmSync(out, { recursive: true, force: true });
});
