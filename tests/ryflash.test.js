// src/ryflash.js against ry-flash (x68max-firmware/flasher/src). The guarantee: the same
// packets, in the same order, with the same waits as ry-flash.exe. Evidence:
//  - proto.rs's own unit-test vectors, repeated here;
//  - the whole sequence for a small image, written out by hand from device.rs below
//    (not built with ryflash.js's helpers), on a fake keyboard with a virtual clock;
//  - a recorded `ry-flash --image stock/2755/fw_at32.bin --json` dry run (slice size,
//    chunks, checksum), when that image is next to this checkout;
//  - every error path ends in a message that says whether to flash again.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const R = require('../src/ryflash');

// ---- a fake keyboard: normal mode (502D, two vendor collections) <-> updater (502A) --------

function fakeBoard({ devId = 2755, ack = 0x55, failAt = null, bootStart = false, noReturn = false, enterIgnored = false, slowRestart = false } = {}) {
  const log = [];                       // [t, mode, 'send' | 'recv', bytes]
  let t = 0, mode = bootStart ? 'boot' : 'normal', last = null, sentInBoot = 0, restartIn = 0;
  const hid = {
    devices() {
      if (mode === 'normal') return [1, 2].map((usage) => ({ vendorId: 0x3151, productId: 0x502d, usagePage: 0xffff, usage, path: `n${usage}` }));
      if (mode === 'boot') return [{ vendorId: 0x3151, productId: 0x502a, usagePage: 0xff01, usage: 1, path: 'b' }];
      return [];
    },
    HID: class {
      constructor(p) { this.mode = p === 'b' ? 'boot' : 'normal'; if (this.mode !== mode) throw new Error('gone'); }
      sendFeatureReport(bytes) {
        if (this.mode !== mode) throw new Error('could not send feature report to device');
        assert.strictEqual(bytes.length, 65);
        assert.strictEqual(bytes[0], 0);
        const f = bytes.slice(1);
        log.push([t, mode, 'send', f]);
        last = f;
        if (mode === 'boot') {
          sentInBoot++;
          if (failAt != null && sentInBoot === failAt) { mode = 'gone'; throw new Error('device disconnected'); }
          if (f[0] === 0xba && f[1] === 0xc2 && ack === 0x55) {
            if (slowRestart) restartIn = 2; else mode = noReturn ? 'gone' : 'back';
          }
        } else if (f[0] === 0x7f && !enterIgnored) { mode = 'boot'; throw new Error('the port dropped'); }
        return 65;
      }
      getFeatureReport() {
        if (this.mode !== mode) throw new Error('gone');
        log.push([t, mode, 'recv']);
        const r = new Array(65).fill(0);    // Windows keeps the report id byte in front
        if (last?.[0] === 0x8f) Object.assign(r, { 1: 0x8f, 2: devId & 0xff, 3: devId >> 8, 8: 0x04, 9: 0x05 });
        if (last?.[0] === 0xba && last[1] === 0xc2) Object.assign(r, { 1: 0xab, 2: 0xc2, 5: ack });
        return r;
      }
      close() {}
    },
  };
  const sleep = async (ms) => {
    t += ms;
    if (restartIn && !--restartIn) mode = 'back';   // slowRestart: answers the ACK first
    if (mode === 'back') mode = 'normal';   // the keyboard restarts while we wait
  };
  return { hid, sleep, log, now: () => t, mode: () => mode };
}

// A small image in the rydfu format: header (chip-ID, 512 bytes) + app with a vector table
// and the USB device descriptor. 200 bytes of app -> 712 bytes -> 12 chunks (last one padded).
function smallImage({ appLen = 200 } = {}) {
  const b = new Uint8Array(0x200 + appLen).fill(0);
  b.set(Buffer.from('AT32F405 8KMKB  '), 0);
  const app = b.subarray(0x200);
  const w = (at, v) => { app[at] = v & 0xff; app[at + 1] = (v >> 8) & 0xff; app[at + 2] = (v >> 16) & 0xff; app[at + 3] = (v >>> 24) & 0xff; };
  w(0, 0x20019800);                 // initial SP
  w(4, 0x08005201 + 0x40);          // reset handler, Thumb
  app.set([18, 1, 0, 2, 0, 0, 0, 64, 0x51, 0x31, 0x2d, 0x50], 0x60);   // device descriptor 3151:502D
  for (let i = 0x80; i < appLen; i++) app[i] = (i * 7) & 0xff;
  return b;
}

// ---- proto.rs's unit tests --------------------------------------------------------------

test('frames match proto.rs (frame_bytes_match_spec)', () => {
  assert.deepStrictEqual(R.buildStart(1403, 89788).slice(0, 7), [0xba, 0xc0, 0x7b, 0x05, 0xbc, 0x5e, 0x01]);
  assert.deepStrictEqual(R.buildComplete(1403, 0x8687e8).slice(0, 7), [0xba, 0xc2, 0x7b, 0x05, 0xe8, 0x87, 0x86]);
  assert.ok(R.buildStart(1, 1).slice(7).every((x) => x === 0));
});

test('checksum includes the 0xFF padding (checksum_includes_ff_pad)', () => {
  assert.strictEqual(R.fwChecksum([1, 2]), 1 + 2 + 62 * 0xff);
  const cs = R.chunkify([1, 2]);
  assert.strictEqual(cs.length, 1);
  assert.strictEqual(cs[0][2], 0xff);
  assert.strictEqual(cs[0][63], 0xff);
  assert.strictEqual(R.fwChecksum(new Array(64).fill(0xff)), (64 * 255) % 0x1000000);
});

test('header sums to 0xFF (header_sums_to_ff) and the updater commands', () => {
  const r = R.getInfor();
  assert.strictEqual(r[0], 0x8f);
  assert.strictEqual(r[7], 0x70);
  assert.strictEqual(r.slice(0, 8).reduce((a, b) => a + b, 0) & 0xff, 0xff);
  assert.deepStrictEqual(R.ispPrepare().slice(0, 8), [0xc5, 0x3a, 0, 0, 0, 0, 0, 0x00]);
  assert.deepStrictEqual(R.enterBootloader().slice(0, 8), [0x7f, 0x55, 0xaa, 0x55, 0xaa, 0, 0, 0x82]);
  for (const f of [R.ispPrepare(), R.enterBootloader(), R.getInfor()]) assert.strictEqual(f.length, 64);
});

test('GET_INFOR decodes dev_id and version (parse_infor_decodes_dev_id)', () => {
  assert.deepStrictEqual(R.parseInfor([0x8f, 0x03, 0x09, 0, 0, 0, 0, 0x06, 0x03]), { devId: 2307, version: 'v306' });
  assert.deepStrictEqual(R.parseInfor([0x8f, 0x53, 0x09, 0, 0, 0, 0, 0x02, 0x03]), { devId: 2387, version: 'v302' });
  assert.deepStrictEqual(R.parseInfor([0x8f, 0xc3, 0x0a, 0, 0, 0, 0, 0x04, 0x05]), { devId: 2755, version: 'v504' });
  assert.strictEqual(R.parseInfor([0x8e, 0, 0, 0, 0, 0, 0, 0, 0]), null);
});

test('slice_image validates the vector table (slice_image_validates_vector_table)', () => {
  const img = new Uint8Array(0x5208);
  img.set(Buffer.from(R.CHIP_ID), 0x5000);
  img.set([0x00, 0x00, 0x01, 0x20], 0x5200);        // SP 0x20010000
  img.set([0x01, 0x52, 0x00, 0x08], 0x5204);        // reset 0x08005201
  assert.ok(R.sliceImage(img));
  assert.strictEqual(R.sliceImage(img).length, 0x208);
  assert.strictEqual(R.sliceImage(Buffer.from(R.CHIP_ID)), null);
  const bad = img.slice(); bad.set([0, 0, 0, 0x20], 0x5204);
  assert.strictEqual(R.sliceImage(bad), null);
  const past = img.slice(); past.set([0x01, 0x00, 0x03, 0x08], 0x5204);
  assert.strictEqual(R.sliceImage(past), null);
  assert.strictEqual(R.sliceImage(Buffer.from('AT32F405 8K-DGKB')), null);
});

test('ACK status (ack_status)', () => {
  assert.ok(R.ackOk([0xab, 0xc2, 0, 0, 0x55]));
  assert.ok(!R.ackOk([0xab, 0xc2, 0, 0, 0xaa]));
});

// ---- a recorded ry-flash.exe dry run ------------------------------------------------------

// `ry-flash --image stock/2755/fw_at32.bin --json` printed (dry run, 2026-10):
// {"chunks":1701,"checksum":"0x8f614f","dev_id":2755,"slice_bytes":108832,...}
const STOCK = path.join(__dirname, '..', '..', 'x68max-firmware', 'stock', '2755', 'fw_at32.bin');
test('the stock 2755 image slices and sums as ry-flash.exe reported', { skip: !fs.existsSync(STOCK) && 'stock image not next to this checkout' }, () => {
  const slice = R.sliceImage(fs.readFileSync(STOCK));
  assert.strictEqual(slice.length, 108832);
  assert.strictEqual(R.chunkify(slice).length, 1701);
  assert.strictEqual(R.fwChecksum(slice), 0x8f614f);
  // and the picker refuses it: going back to stock is the desktop app's job
  assert.strictEqual(R.checkImage(fs.readFileSync(STOCK)).kind, 'stock');
});

// ---- the whole sequence, against device.rs -------------------------------------------

// device.rs, read top to bottom, for `ry-flash --image <f> --arm` on a keyboard in normal mode:
//  read_infor:        send GET_INFOR (8F, sum 0xFF), sleep 50, GET_REPORT
//  enter_bootloader:  send C5 3A (ISP_PREPARE), sleep 100, send 7F 55 AA 55 AA, poll 500 ms
//  flash_slice:       send START, sleep 30, per chunk: send, sleep 10; sleep 30, COMPLETE, sleep 60, GET_REPORT
//  wait_normal:       poll 500 ms; read_infor again
function expected(img) {
  const bit7 = (...p) => { const f = new Array(64).fill(0); p.forEach((b, i) => { f[i] = b; }); f[7] = (0xff - p.reduce((a, b) => a + b, 0)) & 0xff; return f; };
  const n = Math.ceil(img.length / 64);
  let sum = 0;
  const chunks = [];
  for (let i = 0; i < n; i++) {
    const c = Array.from({ length: 64 }, (_, j) => (i * 64 + j < img.length ? img[i * 64 + j] : 0xff));
    sum += c.reduce((a, b) => a + b, 0);
    chunks.push(c);
  }
  sum &= 0xffffff;
  const f7 = (tag, a, b) => { const f = new Array(64).fill(0); f.splice(0, 7, 0xba, tag, a & 0xff, a >> 8, b & 0xff, (b >> 8) & 0xff, b >> 16); return f; };
  const steps = [];
  let t = 0;
  const send = (mode, f) => steps.push([t, mode, 'send', f]);
  const recv = (mode) => steps.push([t, mode, 'recv']);
  send('normal', bit7(0x8f)); t += 50; recv('normal');
  send('normal', bit7(0xc5, 0x3a)); t += 100; send('normal', bit7(0x7f, 0x55, 0xaa, 0x55, 0xaa));
  t += 500;                                            // first poll finds the updater
  send('boot', f7(0xc0, n, img.length)); t += 30;
  for (const c of chunks) { send('boot', c); t += 10; }
  t += 30; send('boot', f7(0xc2, n, sum)); t += 60;
  // the keyboard restarted on COMPLETE: the ACK read finds it gone (not logged), then
  t += 500;                                            // the first poll finds it back
  send('normal', bit7(0x8f)); t += 50; recv('normal');
  return { steps, n, sum };
}

test('flash: byte-identical packets in device.rs order and timing', async () => {
  const img = smallImage();
  const b = fakeBoard();
  const done = [];
  const r = await new R.Updater({ hid: b.hid, sleep: b.sleep }).flash(R.sliceImage(img), { progress: (i, n) => done.push([i, n]) });
  const { steps, n } = expected(img);
  assert.strictEqual(n, 12);
  assert.deepStrictEqual(b.log, steps);
  assert.deepStrictEqual(done.at(-1), [12, 12]);
  assert.deepStrictEqual(r, { mode: 'normal', devId: 2755, postDevId: 2755, postVersion: 'v504', ack: null });
});

test('flash: an ACK read before the restart counts (0x55 -> true)', async () => {
  const b = fakeBoard({ slowRestart: true });
  const r = await new R.Updater({ hid: b.hid, sleep: b.sleep }).flash(R.sliceImage(smallImage()));
  assert.strictEqual(r.ack, true);
  assert.deepStrictEqual(b.log.filter((l) => l[2] === 'recv').map((l) => l[1]), ['normal', 'boot', 'normal']);
});

test('recover mode: already in the updater, flashes without a model check (as cmd_recover)', async () => {
  const b = fakeBoard({ bootStart: true });
  const r = await new R.Updater({ hid: b.hid, sleep: b.sleep }).flash(R.sliceImage(smallImage()));
  assert.strictEqual(r.mode, 'recover');
  assert.strictEqual(b.log[0][3][1], 0xc0);   // first packet is START: no GET_INFOR, no restart
  assert.strictEqual(r.postDevId, 2755);
});

// ---- error paths: each says whether anything was written and what to do -------------------

const flashErr = async (opts, slice = R.sliceImage(smallImage()), extra = {}) => {
  const b = fakeBoard(opts);
  try {
    await new R.Updater({ hid: b.hid, sleep: b.sleep }).flash(slice, extra);
  } catch (e) { return { e, b }; }
  assert.fail('expected a flash error');
};

test('wrong model: refused before anything is sent but GET_INFOR', async () => {
  const { e, b } = await flashErr({ devId: 2381 });
  assert.strictEqual(e.stage, 'before');
  assert.strictEqual(e.code, 'wrong_model');
  assert.deepStrictEqual(b.log.filter((l) => l[2] === 'send').map((l) => l[3][0]), [0x8f]);
});

test('updater never shows up: before, keyboard maybe in updater mode', async () => {
  const { e, b } = await flashErr({ enterIgnored: true });
  assert.strictEqual(e.stage, 'before');
  assert.strictEqual(e.inUpdater, 'maybe');
  assert.match(e.message, /did not re-enumerate/);
  assert.strictEqual(b.now(), 50 + 100 + 20000);   // the 20 s wait of device.rs
});

test('refused chunk (ACK 0xAA): writing, stays in the updater, flash again', async () => {
  const { e } = await flashErr({ ack: 0xaa });
  assert.strictEqual(e.stage, 'writing');
  assert.strictEqual(e.inUpdater, true);
  assert.match(e.message, /checksum mismatch.*flash again/);
});

test('device lost mid-write: writing, flash again; lost on START: nothing written but in the updater', async () => {
  const mid = await flashErr({ failAt: 5 });
  assert.strictEqual(mid.e.stage, 'writing');
  assert.strictEqual(mid.e.inUpdater, true);
  const first = await flashErr({ failAt: 1 });
  assert.strictEqual(first.e.stage, 'before');
  assert.strictEqual(first.e.inUpdater, true);
});

test('keyboard does not come back: writing, flash again', async () => {
  const { e } = await flashErr({ noReturn: true });
  assert.strictEqual(e.stage, 'writing');
  assert.match(e.message, /flash again/);
});

test('no keyboard at all: before, nothing sent', async () => {
  const b = fakeBoard();
  b.hid.devices = () => [];
  await assert.rejects(new R.Updater({ hid: b.hid, sleep: b.sleep }).flash(R.sliceImage(smallImage())), (e) => e.stage === 'before' && e.code === 'no_device');
  assert.strictEqual(b.log.length, 0);
});

test('onWait tells the page when to offer the device pickers', async () => {
  const b = fakeBoard();
  const waits = [];
  await new R.Updater({ hid: b.hid, sleep: b.sleep, onWait: (k) => waits.push(k) }).flash(R.sliceImage(smallImage()));
  assert.deepStrictEqual(waits, ['updater', 'keyboard']);
});

// ---- picking a file --------------------------------------------------------------------

test('checkImage: an open-firmware image passes, with ry-flash\'s chunks and checksum', () => {
  const img = smallImage();
  const c = R.checkImage(img, { name: 'ry5088_2755_rydfu.bin' });
  assert.strictEqual(c.ok, true);
  assert.strictEqual(c.chunks, 12);
  assert.strictEqual(c.checksum, R.fwChecksum(R.sliceImage(img)));
});

test('checkImage refuses other boards, other files, and images too big for the app slot', () => {
  assert.strictEqual(R.checkImage(smallImage(), { name: 'ry5088_2381_rydfu.bin' }).kind, 'board');
  assert.strictEqual(R.checkImage(smallImage(), { pid: 0x5030 }).kind, 'board');
  assert.strictEqual(R.checkImage(Buffer.from('hello')).ok, false);
  assert.strictEqual(R.checkImage(Buffer.from('AT32F405 8K-DGKB')).ok, false);
  const big = smallImage({ appLen: 0x08025800 - 0x08005200 + 64 });
  assert.match(R.checkImage(big).error, /too big/);
  const vec = smallImage(); vec.set([3, 0, 0, 0], 0x200 + 8);   // NMI vector not Thumb/inside
  assert.match(R.checkImage(vec).error, /vector table/);
});

const BUILT = path.join(__dirname, '..', '..', 'x68max-firmware', 'firmware', 'build', '2755', 'ry5088_2755_rydfu.bin');
test('checkImage accepts the real open-firmware build', { skip: !fs.existsSync(BUILT) && 'no firmware build next to this checkout' }, () => {
  const c = R.checkImage(fs.readFileSync(BUILT), { name: path.basename(BUILT) });
  assert.strictEqual(c.ok, true, c.error);
  assert.strictEqual(c.slice.length, fs.statSync(BUILT).size);
});

// ---- the same flash over WebHID (the browser's path) ---------------------------------------

// navigator.hid for a keyboard that re-enumerates: each restart is a new HIDDevice, as in Chrome
function fakeNavigatorHid({ devId = 2755 } = {}) {
  const log = [];
  let t = 0, pending = null;
  const listeners = { connect: [], disconnect: [] };
  const mk = (mode) => {
    let last = null;
    return {
      vendorId: 0x3151, productId: mode === 'boot' ? 0x502a : 0x502d, productName: mode, opened: false,
      collections: mode === 'boot' ? [{ usagePage: 0xff01, usage: 1, inputReports: [] }]
        : [{ usagePage: 0xffff, usage: 1, inputReports: [{ reportId: 5 }] }, { usagePage: 0xffff, usage: 2, inputReports: [] }],
      async open() { this.opened = true; },
      async sendFeatureReport(id, data) {
        assert.strictEqual(id, 0);
        if (!this.opened) throw new Error('gone');
        const f = [...data];
        log.push([t, mode, 'send', f]);
        last = f;
        if (mode === 'normal' && f[0] === 0x7f) { swap('boot'); throw new Error('the port dropped'); }
        if (mode === 'boot' && f[0] === 0xba && f[1] === 0xc2) pending = 'normal';
      },
      async receiveFeatureReport() {
        if (!this.opened) throw new Error('gone');
        log.push([t, mode, 'recv']);
        const r = new Uint8Array(64);   // no id byte this time (the code takes both)
        if (last?.[0] === 0x8f) r.set([0x8f, devId & 0xff, devId >> 8, 0, 0, 0, 0, 4, 5]);
        return new DataView(r.buffer);
      },
      addEventListener() {}, removeEventListener() {},
    };
  };
  let current = mk('normal');
  function swap(mode) {
    const old = current;
    old.opened = false;
    listeners.disconnect.forEach((fn) => fn({ device: old }));
    current = mk(mode);
    listeners.connect.forEach((fn) => fn({ device: current }));
  }
  const api = { getDevices: async () => [current], requestDevice: async () => [current], addEventListener: (type, fn) => listeners[type].push(fn) };
  const sleep = async (ms) => {
    t += ms;
    if (pending) { swap(pending); pending = null; }
    await new Promise(setImmediate);   // the shim opens connected devices asynchronously
  };
  return { api, sleep, log };
}

test('over WebHID: the same packets, order and waits as over node-hid', async () => {
  const webhid = require('../web-build/node-hid');
  const w = fakeNavigatorHid();
  await webhid.init(w.api);
  const slice = R.sliceImage(smallImage());
  const rw = await new R.Updater({ hid: webhid, sleep: w.sleep }).flash(slice);
  const n = fakeBoard();
  const rn = await new R.Updater({ hid: n.hid, sleep: n.sleep }).flash(slice);
  assert.deepStrictEqual(w.log, n.log);
  assert.deepStrictEqual(w.log, expected(smallImage()).steps);
  assert.deepStrictEqual(rw, rn);
});

test('the page\'s messages: a failed write always says flash again; nothing written says so', () => {
  const { outcome } = require('../web-build/web-flash');
  const e = (stage, extra = {}) => Object.assign(new Error('x'), { stage, ...extra });
  assert.match(outcome(e('writing', { inUpdater: true })), /Don't unplug.*Flash again.*recovers/);
  assert.match(outcome(e('writing'), { file: '/app/config/backups/k.json' }), /backup is in/);
  assert.match(outcome(e('before', { inUpdater: 'maybe' })), /updater mode: click Flash again to finish/);
  assert.match(outcome(e('before', { inUpdater: true })), /click Flash again/);
  assert.match(outcome(e('before')), /not changed; safe to try again/);
  assert.match(outcome(e('after')), /Check that the keyboard types/);
});

// ---- recorded from ry-flash's own Rust code ------------------------------------------------

// tests/fixtures/ryflash-rust.json: tools/ryflash-record (private repo only) compiles ry-flash's
// device.rs and proto.rs unchanged against a fake hidapi, runs them in main.rs's order on the
// same small image, and logs every report with its real time. The JS must send the same bytes
// in the same order, and wait at least as long as ry-flash did between them (within 15 ms:
// the Rust times include the OS's sleep overshoot).
test('ry-flash\'s own code (recorded): identical packets and order, same pacing', async () => {
  const rec = require('./fixtures/ryflash-rust.json');
  const img = Buffer.from(rec.image, 'hex');
  const b = fakeBoard();
  const r = await new R.Updater({ hid: b.hid, sleep: b.sleep }).flash(R.sliceImage(img));
  const js = b.log.map(([t, mode, op, f]) => [t, mode, op, f && Buffer.from(f).toString('hex')]);
  assert.deepStrictEqual(js.map((x) => x.slice(1)), rec.log.map(([, mode, op, hex]) => [mode, op, hex]));
  for (let i = 1; i < js.length; i++) {
    const want = js[i][0] - js[i - 1][0], got = rec.log[i][0] - rec.log[i - 1][0];
    assert.ok(got >= want - 0.5 && got - want < 15, `gap before packet ${i}: ry-flash ${got.toFixed(1)} ms, js ${want} ms`);
  }
  assert.strictEqual(r.devId, rec.devId);
  assert.strictEqual(r.postDevId, rec.post);
  assert.strictEqual(r.ack, rec.ack);
});

test('checkImage reads the board from the site\'s build names too', () => {
  assert.strictEqual(R.checkImage(smallImage(), { name: 'x68max-2755-f17f883.bin' }).ok, true);
  assert.strictEqual(R.checkImage(smallImage(), { name: 'x68max-2381-f17f883.bin' }).kind, 'board');
});
