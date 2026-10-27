// The RY5088 updater protocol: ry-flash's flashing (x68max-firmware/flasher/src: proto.rs,
// device.rs, main.rs) in JavaScript, so the web version can flash over WebHID. It sends the
// same packets in the same order with the same waits as ry-flash.exe; tests/ryflash.test.js
// checks it against the Rust code's own test vectors and a recorded ry-flash dry run.
//
// I/O goes through node-hid's API (devices(), new HID(path)); the browser build swaps that
// for WebHID (web-build/node-hid.js). The desktop app still runs ry-flash.exe (flasher.js).
// The steps are separate (enterUpdater, writeImage, waitNormal) because in a browser the
// updater and the keyboard that comes back are devices the user may have to pick in between.
// It sends 0xC5 / 0x7F (restart into the updater), which hid.js refuses: on purpose, it
// writes on its own handles, never through Transport.

const REPORT_LEN = 64;
const CHIP_ID = 'AT32F405 8KMKB';   // keyboard chip-ID header (the dongle's differs: never flashed)
const SLICE_OFFSET = 0x5000;        // the updater writes from 0x08005000 (header + app)
const APP_VT = 0x200;               // app vector table inside the slice (header is 512 bytes)
const APP_REGION_MAX = 0x28000 - 0x5000;
// the open firmware's own limits (x68max-firmware/scripts/preflight.js)
const APP_BASE = 0x08005200, HDR_BASE = 0x08005000, APP_END = 0x08025800;
const RAM_START = 0x20000000, RAM_END = 0x20019800;

const VID = 0x3151;
const PIDS_NORMAL = [0x5030, 0x502d];
const PID_BOOT = 0x502a;
const UP_NORMAL = 0xffff, UP_BOOT = 0xff01;

// device.rs's waits, in ms
const WAIT = { ispPrepare: 100, infor: 50, poll: 500, appear: 20000, start: 30, chunk: 10, beforeComplete: 30, ack: 60 };

// ---- packets (proto.rs) -------------------------------------------------------------

// 64-byte report with the Bit7 header checksum at index 7 (normal-mode commands only;
// the updater checks no header, so its frames are raw).
function hdrBit7(payload) {
  const r = new Array(REPORT_LEN).fill(0);
  payload.slice(0, 7).forEach((b, i) => { r[i] = b; });
  r[7] = (0xff - r.slice(0, 7).reduce((a, b) => a + b, 0)) & 0xff;
  return r;
}

// 24-bit sum of every byte sent, the 0xFF padding of the last chunk included
function fwChecksum(data) {
  const pad = (REPORT_LEN - (data.length % REPORT_LEN)) % REPORT_LEN;
  let s = pad * 0xff;
  for (const b of data) s += b;
  return s % 0x1000000;
}

// 64-byte chunks, the last one padded with 0xFF
function chunkify(data) {
  const out = [];
  for (let i = 0; i < data.length; i += REPORT_LEN) {
    const c = new Array(REPORT_LEN).fill(0xff);
    for (let j = i; j < Math.min(i + REPORT_LEN, data.length); j++) c[j - i] = data[j];
    out.push(c);
  }
  return out;
}

const frame = (tag, count, v24) => {
  const f = new Array(REPORT_LEN).fill(0);
  f.splice(0, 7, 0xba, tag, count & 0xff, (count >> 8) & 0xff, v24 & 0xff, (v24 >> 8) & 0xff, (v24 >> 16) & 0xff);
  return f;
};
const buildStart = (chunkCount, size) => frame(0xc0, chunkCount, size);           // FW_TRANSFER_START
const buildComplete = (chunkCount, checksum) => frame(0xc2, chunkCount, checksum); // FW_TRANSFER_COMPLETE
const ispPrepare = () => hdrBit7([0xc5, 0x3a]);
const enterBootloader = () => hdrBit7([0x7f, 0x55, 0xaa, 0x55, 0xaa]);
const getInfor = () => hdrBit7([0x8f]);

const ascii = (b, at, n) => String.fromCharCode(...b.slice(at, at + n));
const u32 = (b, at) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

function validAppVector(slice) {
  if (slice.length < APP_VT + 8) return false;
  const sp = u32(slice, APP_VT), rv = u32(slice, APP_VT + 4), reset = (rv & ~1) >>> 0;
  return sp >= 0x20000000 && sp <= 0x20020000 && (rv & 1) === 1 && reset >= 0x08005200 && reset < 0x08028000;
}

// The slice the updater writes, from a full image (chip-ID at 0x5000) or a sliced one
// (chip-ID at 0); null unless it is a keyboard image with a plausible vector table that fits.
function sliceImage(image) {
  const b = Uint8Array.from(image);
  const n = CHIP_ID.length;
  let slice;
  if (b.length >= 0x5200 && ascii(b, SLICE_OFFSET, n) === CHIP_ID) slice = b.slice(SLICE_OFFSET);
  else if (b.length >= n && ascii(b, 0, n) === CHIP_ID) slice = b;
  else return null;
  return slice.length <= APP_REGION_MAX && validAppVector(slice) ? slice : null;
}

// { devId, version } from a GET_INFOR reply
function parseInfor(r) {
  if (!r || r.length < 9 || r[0] !== 0x8f) return null;
  return { devId: r[1] | (r[2] << 8), version: `v${r[8]}${String(r[7]).padStart(2, '0')}` };
}
const ackOk = (a) => a.length >= 5 && a[0] === 0xab && a[4] === 0x55;

// ---- image checks for a picked file ---------------------------------------------------

// What the web version flashes: an open-firmware update image (ry5088_<board>_rydfu.bin,
// the 512-byte chip-ID header + the app), checked as ry-flash does (sliceImage) and as
// preflight.js does (layout, vector table, USB identity). A full stock-format image is
// refused: going back to stock is the desktop app's job. -> { ok, slice, error, kind }
function checkImage(bytes, { name = '', boardId = 2755, pid = 0x502d } = {}) {
  const b = Uint8Array.from(bytes);
  const bad = (error, kind = 'bad') => ({ ok: false, kind, error });
  if (b.length >= 0x5200 && ascii(b, SLICE_OFFSET, CHIP_ID.length) === CHIP_ID) {
    return bad('This is a full stock-format image (it includes the updater area), not an open-firmware update. '
      + 'Going back to the stock firmware needs the desktop app.', 'stock');
  }
  const slice = sliceImage(b);
  if (!slice) return bad(`Not a flashable keyboard image: no "${CHIP_ID}" header with a valid start address (a dongle or other file?).`);
  const named = /(?:ry5088_|x68max-)(\d+)/i.exec(name);   // ry5088_2755_rydfu.bin, x68max-2755-<sha>.bin
  if (named && Number(named[1]) !== boardId) return bad(`This image is for board ${named[1]}; this keyboard is board ${boardId}.`, 'board');
  const app = slice.subarray(APP_VT), end = HDR_BASE + slice.length;
  if (end > APP_END) return bad(`The image is too big (${slice.length} bytes): it would reach into the settings area.`);
  const sp = u32(app, 0), reset = u32(app, 4);
  const inImage = (v) => (v & 1) === 1 && v > APP_BASE && v < end;
  if (!(sp > RAM_START && sp <= RAM_END && sp % 8 === 0) || !inImage(reset)) return bad('The image does not start like a firmware for this keyboard (vector table).');
  for (let i = 2; i < 16; i++) {
    const v = u32(app, i * 4);
    if (v !== 0 && !inImage(v)) return bad('The image does not start like a firmware for this keyboard (vector table).');
  }
  let usb = false;
  for (let i = 0; i + 18 <= app.length && !usb; i++) {
    usb = app[i] === 18 && app[i + 1] === 1 && app[i + 8] === (VID & 0xff) && app[i + 9] === VID >> 8
      && app[i + 10] === (pid & 0xff) && app[i + 11] === pid >> 8;
  }
  if (!usb) return bad(`The image is not for this keyboard (no USB identity ${VID.toString(16)}:${pid.toString(16)}).`, 'board');
  return { ok: true, kind: 'open', slice, chunks: Math.ceil(slice.length / REPORT_LEN), checksum: fwChecksum(slice) };
}

// ---- the updater over HID (device.rs) ---------------------------------------------------

// stage: 'before' (nothing written: safe to try again) or 'writing' (flash again to recover)
const flashError = (message, stage, extra = {}) => Object.assign(new Error(message), { stage, ...extra });
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Updater {
  // hid: node-hid or its WebHID stand-in. appearMs: how long to wait for the updater or the
  // keyboard to show up (ry-flash: 20 s; a browser waits longer while the user picks it).
  // onWait(kind) runs when that wait starts ('updater' | 'keyboard'), so a page can offer a pick.
  constructor({ hid = require('node-hid'), sleep = realSleep, appearMs = WAIT.appear, onWait = () => {} } = {}) {
    Object.assign(this, { hid, sleep, appearMs, onWait });
  }

  matches(pids, up, usage) {
    let list = [];
    try { list = this.hid.devices(); } catch { /* none */ }
    return list.filter((d) => d.vendorId === VID && pids.includes(d.productId) && d.usagePage === up && (usage == null || d.usage === usage));
  }

  open(pids, up, usage) {
    for (const d of this.matches(pids, up, usage)) {
      try { return new this.hid.HID(d.path); } catch { /* next */ }
    }
    return null;
  }

  normalPresent() { return this.matches(PIDS_NORMAL, UP_NORMAL).length > 0; }
  bootPresent() { return this.matches([PID_BOOT], UP_BOOT).length > 0; }

  // send_feature_report with report id 0 in front
  async send(d, f) { await d.sendFeatureReport([0, ...f]); }

  async recv(d) {
    try {
      const r = await d.getFeatureReport(0, REPORT_LEN + 1);
      return r && r.length ? Array.from(r) : null;
    } catch { return null; }
  }

  // { devId, version } of the keyboard in normal mode, or null
  async readInfor() {
    const d = this.open(PIDS_NORMAL, UP_NORMAL, 2);
    if (!d) return null;
    try {
      try { await this.send(d, getInfor()); } catch { return null; }
      await this.sleep(WAIT.infor);
      const r = await this.recv(d);
      if (!r) return null;
      return parseInfor(r) ?? (r.length > 1 ? parseInfor(r.slice(1)) : null);
    } finally { try { d.close(); } catch { /* gone */ } }
  }

  // polls every 500 ms until present() or appearMs is up
  async waitFor(kind, present) {
    this.onWait(kind);
    for (let t = 0; t < this.appearMs;) {
      await this.sleep(WAIT.poll);
      t += WAIT.poll;
      if (present()) return true;
    }
    return false;
  }

  // Restarts the keyboard into its updater (stock firmware loses its config here) and waits for it.
  async enterUpdater() {
    const d = this.open(PIDS_NORMAL, UP_NORMAL, 2);
    if (!d) throw flashError('not in normal mode (3151:5030/502D)', 'before');
    try {
      try { await this.send(d, ispPrepare()); } catch (e) { throw flashError(`enter-bootloader (ISP_PREPARE) failed: ${e.message}`, 'before'); }
      await this.sleep(WAIT.ispPrepare);
      // the keyboard resets on this one, so its send may fail as the port drops: expected
      try { await this.send(d, enterBootloader()); } catch { /* see above */ }
    } finally { try { d.close(); } catch { /* gone */ } }
    if (await this.waitFor('updater', () => this.bootPresent())) return;
    throw flashError('did not re-enumerate to bootloader (502A) within 20s', 'before', { inUpdater: 'maybe' });
  }

  // Writes the slice from the updater: true (ACK ok), false (ACK fail: checksum mismatch,
  // the updater stays), null (no ACK: the keyboard already restarted; waitNormal decides).
  async writeImage(slice, progress = () => {}) {
    const d = this.open([PID_BOOT], UP_BOOT, null);
    if (!d) throw flashError('not in bootloader mode (3151:502A)', 'before', { inUpdater: 'maybe' });
    const chunks = chunkify(slice);
    if (chunks.length > 0xffff) throw flashError(`image too large: ${chunks.length} chunks exceeds the 16-bit transfer limit`, 'before', { inUpdater: true });
    const cc = chunks.length, cks = fwChecksum(slice);
    let sent = false;
    const send = async (f) => {
      try { await this.send(d, f); } catch (e) { throw flashError(e.message, sent ? 'writing' : 'before', { inUpdater: true }); }
      sent = true;
    };
    try {
      await send(buildStart(cc, slice.length));
      await this.sleep(WAIT.start);
      for (let i = 0; i < cc; i++) {
        await send(chunks[i]);
        progress(i + 1, cc);
        // the updater takes one report per main-loop pass; a faster one overwrites the last
        await this.sleep(WAIT.chunk);
      }
      await this.sleep(WAIT.beforeComplete);
      await send(buildComplete(cc, cks));
      await this.sleep(WAIT.ack);
      const a = await this.recv(d);   // a good flash restarts the keyboard at once, so may be gone
      if (!a) return null;
      if (ackOk(a) || (a.length > 1 && ackOk(a.slice(1)))) return true;
      const fail = (a.length > 4 && a[0] === 0xab && a[4] === 0xaa) || (a.length > 5 && a[1] === 0xab && a[5] === 0xaa);
      return fail ? false : null;
    } finally { try { d.close(); } catch { /* gone */ } }
  }

  // back in normal mode (the success signal after a flash)
  waitNormal() { return this.waitFor('keyboard', () => this.normalPresent()); }

  // ry-flash --image <f> --arm (main.rs: cmd_auto / cmd_recover + flash_round_trip).
  // -> { mode: 'normal' | 'recover', devId, postDevId, postVersion, ack }; throws flashError.
  async flash(slice, { boardId = 2755, progress, say = () => {} } = {}) {
    let mode = 'recover', devId = null;
    if (!this.bootPresent()) {
      const info = await this.readInfor();
      if (!info) throw flashError('could not read GET_INFOR (keyboard in normal mode, app closed?)', 'before', { code: 'no_device' });
      if (info.devId !== boardId) throw flashError(`this keyboard reports model ${info.devId}, not ${boardId}; this image is not for it`, 'before', { code: 'wrong_model' });
      mode = 'normal';
      devId = info.devId;
      say('Restarting into the updater…');
      await this.enterUpdater();
    } else say('The keyboard is in updater mode; finishing the flash from there.');
    const ack = await this.writeImage(slice, progress);
    if (ack === false) throw flashError('checksum mismatch (ACK 0xAA): the keyboard stays in updater mode, safe to flash again', 'writing', { inUpdater: true });
    say('Waiting for the keyboard to come back…');
    if (!(await this.waitNormal())) throw flashError('did not return to normal mode (likely still in 502A; flash again)', 'writing', { inUpdater: 'maybe' });
    const post = await this.readInfor();
    if (post && devId != null && post.devId !== devId) {
      throw flashError(`flash completed but the board now reports model ${post.devId}, not ${devId}`, 'after', { code: 'post_flash_mismatch' });
    }
    return { mode, devId, postDevId: post?.devId ?? null, postVersion: post?.version ?? '', ack };
  }
}

module.exports = {
  REPORT_LEN, CHIP_ID, VID, PIDS_NORMAL, PID_BOOT, UP_NORMAL, UP_BOOT, WAIT,
  hdrBit7, fwChecksum, chunkify, buildStart, buildComplete, ispPrepare, enterBootloader, getInfor,
  sliceImage, parseInfor, ackOk, checkImage, Updater, flashError,
};
