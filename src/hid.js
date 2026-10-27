// Transport: 64-byte feature reports, report ID 0, on the vendor collection
// 0xFFFF:2. Owns all pacing so callers cannot outrun the board.
const HID = require('node-hid');
const { REPORT_LEN, FORBIDDEN } = require('./protocol');

const { VID, DEFAULT } = require('./models');
const PID = DEFAULT.pid;          // the MAX68HE; other models pass their own

const MIN_WRITE_GAP_MS = 12;      // faster stalls the endpoint until replug
const SETTLE_MS = 10;             // reply ready after a GET
const REPLY_TRIES = 5;
const FLASH_PAGE_GAP_MS = 100;    // between pages of one flash batch
const FLASH_SETTLE_MS = 2000;     // idle after a flash batch
const FLASH_COOLDOWN_MS = 10000;  // between flash batches
const SETTING_GAP_MS = 1000;      // between small saved settings
const KEY_GAP_MS = 400;           // between single-key writes
const SETTING_SETTLE_MS = 150;    // hold the line after a saved setting

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Last write / flash batch / saved setting, per process: a reopened Transport keeps
// pacing from the previous one, so a drop and reopen cannot outrun the board.
const pace = { write: 0, flash: 0, setting: 0 };

// Packets that reached the keyboard, per process. connection.js retries a request only
// when this did not move while it ran (nothing was delivered, so running it again is safe).
let sentPackets = 0;
const sentCount = () => sentPackets;

// Marks an error as the device's (not found, I/O failed, no answer) rather than bad
// input. Only these make a long-running server close and reopen the keyboard.
function deviceError(e) {
  return Object.assign(e instanceof Error ? e : new Error(String(e)), { device: true });
}
function io(fn) {
  try { return fn(); } catch (e) { throw deviceError(e); }
}

function findSettingsPath(pid = PID) {
  const node = io(() => HID.devices()).find(
    (d) => d.vendorId === VID && d.productId === pid && d.usagePage === 0xffff && d.usage === 2,
  );
  if (!node) throw deviceError(new Error('keyboard settings interface not found (plugged in by cable?)'));
  return node.path;
}

class Transport {
  constructor(path = findSettingsPath()) {
    this.dev = io(() => new HID.HID(path));
    this.busy = Promise.resolve(); // serialises every exchange
  }

  // Runs fn exclusively so concurrent callers never interleave packets.
  exclusive(fn) {
    const run = this.busy.then(fn, fn);
    this.busy = run.catch(() => {});
    return run;
  }

  async rawSend(buf) {
    if (buf.length !== REPORT_LEN) throw new Error('packet must be 64 bytes');
    if (FORBIDDEN.has(buf[0])) throw new Error(`opcode 0x${buf[0].toString(16)} is refused`);
    const wait = pace.write + MIN_WRITE_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    // a failed send delivered nothing (a stale handle after a replug or flash fails here).
    // node-hid answers at once; the browser's WebHID stand-in (web-build/node-hid.js) with a promise.
    try { await this.dev.sendFeatureReport([0, ...buf]); } catch (e) { throw Object.assign(deviceError(e), { unsent: true }); }
    sentPackets++;
    pace.write = Date.now();
  }

  async rawRead() {
    let r;
    try { r = await this.dev.getFeatureReport(0, REPORT_LEN + 1); } catch (e) { throw deviceError(e); }
    return r.length === REPORT_LEN + 1 ? r.slice(1) : r; // Windows keeps the ID byte
  }

  // GET whose reply echoes the opcode. Retries until it does.
  query(buf) {
    return this.exclusive(async () => {
      await this.rawSend(buf);
      for (let i = 1; i <= REPLY_TRIES; i++) {
        await sleep(SETTLE_MS * i);
        const r = await this.rawRead();
        if (r[0] === buf[0]) return r;
      }
      throw deviceError(new Error(`no reply to 0x${buf[0].toString(16)}`));
    });
  }

  // GET whose reply is a raw page (keymap, hall columns): no echo to check.
  queryPage(buf) {
    return this.exclusive(async () => {
      await this.rawSend(buf);
      await sleep(SETTLE_MS);
      return await this.rawRead();
    });
  }

  // A SET that does not touch flash.
  send(buf) {
    return this.exclusive(() => this.rawSend(buf));
  }

  // One small saved setting (a key, lighting, polling rate). Spaced at least
  // gapMs from the previous such write; X86 stalled at nine key writes 150 ms apart.
  writeSetting(buf, gapMs = SETTING_GAP_MS) {
    return this.exclusive(async () => {
      const wait = Math.max(pace.setting + gapMs, pace.flash + FLASH_SETTLE_MS) - Date.now();
      if (wait > 0) await sleep(wait);
      await this.rawSend(buf);
      pace.setting = Date.now();
      // Reads in the next ~50 ms return an empty page while the board saves.
      await sleep(SETTING_SETTLE_MS);
    });
  }

  // A batch of packets ending in a flash commit, paced as the board needs.
  flash(packets) {
    return this.exclusive(async () => {
      const wait = Math.max(pace.flash + FLASH_COOLDOWN_MS, pace.setting + SETTING_GAP_MS) - Date.now();
      if (wait > 0) await sleep(wait);
      for (let i = 0; i < packets.length; i++) {
        if (i > 0) await sleep(FLASH_PAGE_GAP_MS);
        await this.rawSend(packets[i]);
      }
      await sleep(FLASH_SETTLE_MS);
      pace.flash = Date.now();
    });
  }

  close() { this.dev.close(); }
}

// Input collections on the vendor page; the travel stream arrives on one of them.
function openInputNodes(pid = PID) {
  return io(() => HID.devices()
    .filter((d) => d.vendorId === VID && d.productId === pid && d.usagePage === 0xffff && d.usage !== 2)
    .map((d) => new HID.HID(d.path)));
}

module.exports = { Transport, findSettingsPath, openInputNodes, deviceError, pace, sentCount, VID, PID, KEY_GAP_MS };
