// Keyboards this driver talks to. Both are RY5088 boards with the same stock
// protocol; the board id from IDENTIFY is what tells them apart (the USB PID only
// picks which device to open). Only the MAX68HE has the open firmware.
const HID = require('node-hid');

const VID = 0x3151;
const MODELS = [
  { key: 'max68he', name: 'MAX68HE', boardId: 2755, pid: 0x502d, openFirmware: true },
  { key: 'x82he', name: 'X82HE Pro', boardId: 2356, pid: 0x502f, openFirmware: false },
];
const DEFAULT = MODELS[0];

const byKey = (key) => MODELS.find((m) => m.key === key) ?? null;
const byBoard = (boardId) => MODELS.find((m) => m.boardId === boardId) ?? null;

// Models whose settings interface is plugged in, in MODELS order.
function plugged(devices = HID.devices()) {
  return MODELS.filter((m) => devices.some((d) => d.vendorId === VID && d.productId === m.pid
    && d.usagePage === 0xffff && d.usage === 2));
}

// The model to open: the one asked for (key), else MAX68HE_KEYBOARD, else the first
// one plugged in, else the MAX68HE (so the "not found" error names it).
function pick(key = process.env.MAX68HE_KEYBOARD, devices) {
  if (key) {
    const m = byKey(key);
    if (!m) throw new Error(`unknown keyboard "${key}" (known: ${MODELS.map((x) => x.key).join(', ')})`);
    return m;
  }
  try { return plugged(devices)[0] ?? DEFAULT; } catch { return DEFAULT; }
}

module.exports = { VID, MODELS, DEFAULT, byKey, byBoard, plugged, pick };
