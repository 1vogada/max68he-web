// Calibration replies (0xFE 15/16) and the one-click flasher's sequence, with a
// fake ry-flash: nothing here touches a keyboard.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../src/calibration');

test('calibration packets and status reply', () => {
  assert.deepStrictEqual(C.statusPacket('start').slice(0, 3), [0xfe, 15, 1]);
  assert.deepStrictEqual(C.statusPacket('reset').slice(0, 3), [0xfe, 15, 4]);
  assert.deepStrictEqual(C.spansPacket(28, true).slice(0, 4), [0xfe, 16, 28, 1]);
  const r = new Array(64).fill(0);
  r[8] = 1; r[9] = 68; r[10] = 12; r[11] = 0; r[12] = 0; r[13] = 0x7e; r[14] = 0x04;
  assert.deepStrictEqual(C.parseStatus(r), { running: true, keys: 68, doneThisRun: 12, calibratedKeys: 0, lastFinish: 0, assumedSpan: 1150 });
  r[12] = 0xff;
  assert.strictEqual(C.parseStatus(r).lastFinish, 'flash error');
});

// a temporary x68max-firmware layout with one latest build and one stock image
function fakeFirmwareDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x68fw-'));
  const put = (rel, size) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), Buffer.alloc(size)); };
  put('firmware/build/2755/ry5088_2755_rydfu.bin', 90000);
  put('stock/2755/fw_at32.bin', 120000);
  put('firmware/build/previous/ry5088_2755_7eb1909_rydfu.bin', 50000);
  put('firmware/build/previous/broken.bin', 100);               // too small: not offered
  return dir;
}

// (the flash/retry sequence itself is in flasher.test.js)
test('flasher: lists only plausible images, refuses unknown ids', async () => {
  process.env.MAX68HE_FIRMWARE_DIR = fakeFirmwareDir();
  delete require.cache[require.resolve('../src/flasher')];
  const F = require('../src/flasher');
  const imgs = F.listImages();
  assert.deepStrictEqual(imgs.map((x) => x.id), ['latest', 'stock', 'previous:ry5088_2755_7eb1909_rydfu.bin']);
  assert.deepStrictEqual(imgs.map((x) => x.keepsSettings), [true, false, false], 'stock and earlier builds warn about settings');
  await assert.rejects(F.flash('../../etc/passwd', async () => {}, async () => ({ code: 0, stdout: '', stderr: '' })), /unknown firmware image/);
  delete process.env.MAX68HE_FIRMWARE_DIR;
});
