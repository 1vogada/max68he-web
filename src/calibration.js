// Per-key travel calibration (open firmware with the 'calibration' feature,
// 0xFE 15/16). While a run is on, the keyboard mutes every key and shows its
// progress on the LEDs; the user presses each key to the bottom once. Mixed
// into Keyboard.prototype by keyboard.js.
const P = require('./protocol');

const ACTIONS = { status: 0, start: 1, finish: 2, cancel: 3, reset: 4 };

const statusPacket = (action = 'status') => P.hostPacket(0xfe, [15, ACTIONS[action]]);
const spansPacket = (start, peaks) => P.hostPacket(0xfe, [16, start, peaks ? 1 : 0]);

function parseStatus(r) {
  const last = r[12] > 127 ? r[12] - 256 : r[12];
  return { running: r[8] === 1, keys: r[9], doneThisRun: r[10], calibratedKeys: r[11],
    lastFinish: last < 0 ? 'flash error' : last, assumedSpan: r[13] | (r[14] << 8) };
}

module.exports = {
  ACTIONS, statusPacket, spansPacket, parseStatus,

  async _requireCalibration() {
    this._requireCustom();
    if (!(await this.getCaps()).features.includes('calibration')) {
      throw Object.assign(new Error('this firmware has no calibration (flash a newer open-firmware build)'), { status: 400 });
    }
  },

  // action: status | start | finish (keeps the measured keys, saves) | cancel | reset (all keys back to the default, saves)
  async calibration(action = 'status') {
    if (!(action in ACTIONS)) throw Object.assign(new Error(`action is ${Object.keys(ACTIONS).join(', ')}`), { status: 400 });
    await this._requireCalibration();
    const r = await this.t.query(statusPacket(action));
    if (action === 'finish' || action === 'reset') {          // the board saves on its next pass
      await new Promise((res) => setTimeout(res, 150));
      return parseStatus(await this.t.query(statusPacket()));
    }
    return parseStatus(r);
  },

  // per slot: { slot, span (stored counts, 0 = default), peak (this run) }
  async calibrationSpans() {
    await this._requireCalibration();
    const read = async (peaks) => {
      const v = [];
      for (let start = 0; start < P.SLOTS; start += 28) {
        const r = await this.t.query(spansPacket(start, peaks));
        for (let k = 0; k < 28 && start + k < P.SLOTS; k++) v[start + k] = r[8 + 2 * k] | (r[9 + 2 * k] << 8);
      }
      return v;
    };
    const span = await read(false), peak = await read(true);
    return span.map((s, slot) => ({ slot, span: s, peak: peak[slot] }));
  },
};
