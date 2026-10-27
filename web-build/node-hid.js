// node-hid's API on top of WebHID, for the browser build (scripts/build-web.js swaps it in
// for 'node-hid'). Same shape as node-hid on Windows: devices() lists one entry per
// top-level collection with a path; new HID(path) reads and writes [reportId, ...data].
// The one difference: sendFeatureReport / getFeatureReport return promises, which
// src/hid.js awaits (node-hid answers at once, and awaiting that is the same).
//
// WebHID needs a user click to grant a device (request()); granted devices come back by
// themselves on the next visit (init()). Devices are opened once and shared.
const VID = 0x3151;
const FILTERS = [{ vendorId: VID, usagePage: 0xffff }, { vendorId: VID, usagePage: 0xff00 }];
// the keyboard's updater, a device of its own while a flash runs (src/ryflash.js)
const UPDATER_FILTERS = [{ vendorId: VID, productId: 0x502a }];

let hid = typeof navigator !== 'undefined' ? navigator.hid : null;
let opened = [];                 // HIDDevice, opened, in the order they were found
const listeners = new Set();     // (event: 'connect' | 'disconnect') => void

function notify(event) { for (const fn of listeners) { try { fn(event); } catch { /* a listener's bug */ } } }

async function add(dev) {
  if (dev.vendorId !== VID || opened.includes(dev)) return;
  try { if (!dev.opened) await dev.open(); } catch { return; }   // in use elsewhere, or gone again
  opened.push(dev);
}

// Opens the devices this page may already use. Safe to call again.
async function init(api = hid) {
  hid = api;
  if (!hid) return false;
  const granted = await hid.getDevices();
  opened = opened.filter((d) => granted.includes(d));   // what the browser grants now
  for (const d of granted) await add(d);
  if (!init.watching) {
    init.watching = true;
    hid.addEventListener('connect', async (e) => { await add(e.device); notify('connect'); });
    hid.addEventListener('disconnect', (e) => { opened = opened.filter((d) => d !== e.device); notify('disconnect'); });
  }
  return opened.length > 0;
}

// The browser's device picker (must run from a click). True when a device was granted.
async function request(api = hid, filters = FILTERS) {
  hid = api;
  if (!hid) throw new Error('This browser has no WebHID: use Chrome, Edge or Opera on a computer.');
  const picked = await hid.requestDevice({ filters });
  for (const d of picked) await add(d);
  return picked.some((d) => opened.includes(d));
}

const supported = () => Boolean(hid);
const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

function devices() {
  const out = [];
  opened.forEach((dev, i) => dev.collections.forEach((c, j) => {
    out.push({ vendorId: dev.vendorId, productId: dev.productId, usagePage: c.usagePage, usage: c.usage,
      product: dev.productName, path: `webhid:${i}:${j}` });
  }));
  return out;
}

function lookup(path) {
  const m = /^webhid:(\d+):(\d+)$/.exec(String(path));
  const dev = m && opened[Number(m[1])];
  const col = dev && dev.collections[Number(m[2])];
  if (!col) throw new Error('the keyboard is not connected (click "Connect keyboard")');
  return { dev, col };
}

class HID {
  constructor(path) {
    const { dev, col } = lookup(path);
    this.dev = dev;
    // input reports of this collection only (a device can carry several)
    this.ids = new Set((col.inputReports ?? []).map((r) => r.reportId));
    this.handlers = { data: [], error: [] };
    this.onInput = (e) => {
      if (this.ids.size && !this.ids.has(e.reportId)) return;
      const data = [e.reportId, ...new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength)];
      this.handlers.data.forEach((fn) => fn(data));
    };
    this.closed = false;
  }

  // [reportId, ...data]
  async sendFeatureReport(bytes) {
    if (this.closed || !this.dev.opened) throw new Error('could not send feature report to device: not connected');
    await this.dev.sendFeatureReport(bytes[0], new Uint8Array(bytes.slice(1)));
    return bytes.length;
  }

  // [reportId, ...data] when the browser keeps the id byte, else the data alone
  // (src/hid.js accepts both, as it does for node-hid across platforms)
  async getFeatureReport(reportId) {
    if (this.closed || !this.dev.opened) throw new Error('could not get feature report from device: not connected');
    const v = await this.dev.receiveFeatureReport(reportId);
    return [...new Uint8Array(v.buffer, v.byteOffset, v.byteLength)];
  }

  on(event, fn) {
    if (!this.handlers[event]) return this;
    if (event === 'data' && !this.handlers.data.length) this.dev.addEventListener('inputreport', this.onInput);
    this.handlers[event].push(fn);
    return this;
  }

  // the device stays open (other HID objects share it); this one stops listening
  close() {
    this.closed = true;
    this.dev.removeEventListener('inputreport', this.onInput);
    this.handlers = { data: [], error: [] };
  }
}

module.exports = { devices, HID, init, request, supported, onChange, FILTERS, UPDATER_FILTERS };
