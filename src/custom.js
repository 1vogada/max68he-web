// Features of the open (fun60-derived) firmware. Every method refuses unless
// identify() saw that firmware, so nothing here ever reaches stock firmware.
// Mixed into Keyboard.prototype by keyboard.js.
const P = require('./protocol');
const { openInputNodes } = require('./hid');
const { parseSequence, sequenceMs, hasGlide } = require('./sequence');

module.exports = {
  _requireCustom() {
    if (!this.info?.custom) throw Object.assign(new Error('needs the open firmware (stock firmware detected)'), { status: 400 });
  },

  // 'droplet' (rendered on the keyboard from key depth) or 'live' (PC-streamed frames).
  async setCustomMode(name, brightness = 4, rgb = [0, 0, 0]) {
    this._requireCustom();
    const mode = P.CUSTOM_MODE[name];
    if (mode === undefined) throw Object.assign(new Error(`mode is ${Object.keys(P.CUSTOM_MODE).join(' or ')}`), { status: 400 });
    await this.t.writeSetting(P.customModePacket(mode, brightness, rgb));
  },

  // ---- per-key software control (host_api.h) ------------------------------

  async getCaps() {
    this._requireCustom();
    return P.parseCaps(await this.t.query(P.hostPacket(P.HOST.CAPS)));
  },

  // flash / RAM use of the running firmware (P.parseMemory), or null if it does not report it
  async memoryUsage() {
    return (await this.getCaps()).memory ?? null;
  },

  // ---- open-firmware options (0xFE) -------------------------------------------
  // { capsIndicator, capsColor: [r,g,b], snapMode: last|neutral|first|deeper, statusGuide,
  //   idleMinutes (0 = never), layerIndicator, fnHold, unicode, perf, textTyping: keep|block|stop,
  //   compatMode (6KRO boot keyboard), releaseDebounceMs 0..10, dimMinutes (0 = never), dimPercent 0..100 }
  async getFirmwareOptions() {
    this._requireCustom();
    return P.parseFwOptions(await this.t.query(P.fwOptionsGetPacket()));
  },

  async setFirmwareOptions(changes) {
    this._requireCustom();
    const next = { ...(await this.getFirmwareOptions()), ...changes };
    // bytes 11..15 are reserved on older open firmware: a non-default value goes only to firmware that has
    // the option (CAPS2 bit), otherwise the byte is sent as 0
    const has = (await this.getCaps()).features;
    for (const [feature, key, off, label] of [
      ['textTyping', 'textTyping', 'keep', '"While a text is typing"'],
      ['compatMode', 'compatMode', false, 'Compatibility mode'],
      ['releaseDebounce', 'releaseDebounceMs', 0, 'Release debounce'],
      ['idleDim', 'dimMinutes', 0, '"Dim lighting after idle"'],
    ]) {
      if (has.includes(feature)) continue;
      if ((changes[key] ?? off) !== off) throw Object.assign(new Error(`${label} needs a newer open firmware`), { status: 400 });
      next[key] = off;
    }
    return P.parseFwOptions(await this.t.query(P.fwOptionsPacket(next)));
  },

  // Full factory reset (0xFE 17 = the firmware's 0x01 reset): every profile, keymap, layer, lighting,
  // actuation, advanced key, macro, text key, gamepad setting and firmware option back to defaults;
  // per-key calibration is kept. Only on open firmware that reports 'resetFe'.
  async factoryReset() {
    this._requireCustom();
    if (!(await this.getCaps()).features.includes('resetFe')) {
      throw Object.assign(new Error('Reset all keyboard settings needs a newer open firmware'), { status: 400 });
    }
    const r = await this.t.query(P.fwFactoryResetPacket());
    if (r[0] !== 0xfe || r[1] !== 17 || r[2] !== 1) throw new Error('the keyboard did not confirm the reset');
    return { reset: true };
  },

  // ---- press statistics (0xFE 4/5): presses per slot since power-up -----------
  async getPressCounts() {
    this._requireCustom();
    const counts = new Array(P.SLOTS).fill(0);
    let total = 0;
    for (let start = 0; start < P.SLOTS; start += 14) {
      const r = await this.t.query(P.pressCountPacket(start));
      total = (r[3] | (r[4] << 8) | (r[5] << 16) | (r[6] << 24)) >>> 0;
      for (let i = 0; i < 14 && start + i < P.SLOTS; i++) {
        const o = 8 + i * 4;
        counts[start + i] = (r[o] | (r[o + 1] << 8) | (r[o + 2] << 16) | (r[o + 3] << 24)) >>> 0;
      }
    }
    return { total, counts };
  },

  async resetPressCounts() {
    this._requireCustom();
    await this.t.query(P.pressResetPacket());
    return this.getPressCounts();
  },

  // ---- scan timing (0xFE 6/7) --------------------------------------------------
  // Measures for ms milliseconds: scans/s (frames the ADC finished) and passes/s
  // (key-processing loops), plus the board's own pass timing.
  async getScanStats(ms = 1000) {
    this._requireCustom();
    const read = async () => ({ at: process.hrtime.bigint(), s: P.parseScanStats(await this.t.query(P.scanStatsPacket())) });
    const a = await read();
    await new Promise((r) => setTimeout(r, ms));
    const b = await read();
    const sec = Number(b.at - a.at) / 1e9;
    const rate = (k) => Math.round(((b.s[k] - a.s[k]) >>> 0) / sec);
    return { scansPerSec: rate('frames'), passesPerSec: rate('passes'), ...b.s };
  },

  // { settleUs, adcDiv, sample, background, resetMax }; the board applies it between scans.
  async setScanTiming(timing) {
    this._requireCustom();
    const now = P.parseScanStats(await this.t.query(P.scanStatsPacket()));
    const next = { settleUs: now.settleUs, adcDiv: now.adcDiv, sample: now.sample, background: now.background, ...timing };
    return P.parseScanStats(await this.t.query(P.scanTunePacket(next)));
  },

  // ---- user layers 1..3 (0xFE) ---------------------------------------------------
  // 128 slots of stock 4-byte values; all zero = falls through to the layer below.
  async getLayer(layer) {
    this._requireCustom();
    const bytes = [];
    for (let page = 0; page < P.LAYER_PAGES; page++) {
      bytes.push(...(await this.t.query(P.layerGetPacket(layer, page))).slice(8, 64));
    }
    return Array.from({ length: P.SLOTS }, (_, s) => bytes.slice(s * 4, s * 4 + 4));
  },

  async setLayerKey(layer, slot, value) {
    this._requireCustom();
    P.checkValue(value);
    const cur = await this.getLayer(layer);
    cur[slot] = value;
    for (const pkt of P.layerPackets(layer, cur)) await this.t.query(pkt);
    return (await this.getLayer(layer))[slot];
  },

  // ---- Fn layers 2..4 (0xFE 11/12) -------------------------------------------------
  async getFnLayer(layer) {
    this._requireCustom();
    const bytes = [];
    for (let page = 0; page < P.LAYER_PAGES; page++) {
      bytes.push(...(await this.t.query(P.fnLayerGetPacket(layer, page))).slice(8, 64));
    }
    return Array.from({ length: P.SLOTS }, (_, s) => bytes.slice(s * 4, s * 4 + 4));
  },

  async setFnLayerKey(layer, slot, value) {
    this._requireCustom();
    P.checkValue(value);
    const cur = await this.getFnLayer(layer);
    cur[slot] = value;
    for (const pkt of P.fnLayerPackets(layer, cur)) await this.t.query(pkt);
    return (await this.getFnLayer(layer))[slot];
  },

  // ---- text keys (0xFE 13/14) ------------------------------------------------------
  async getText(index) {
    this._requireCustom();
    let len = 0;
    const bytes = [];
    for (let page = 0; page < P.TEXT_PAGES; page++) {
      const r = await this.t.query(P.textGetPacket(index, page));
      if (r[2] === 0xff) throw new Error('text slot out of range');
      len = r[4];
      bytes.push(...r.slice(8, 64));
    }
    return Buffer.from(bytes.slice(0, Math.min(len, P.TEXT_MAX_LEN))).toString('utf8');
  },

  async getTexts() {
    const out = [];
    for (let i = 0; i < P.TEXT_COUNT; i++) out.push(await this.getText(i));
    return out;
  },

  // The keyboard keeps it (saved on its own shortly after).
  async setText(index, text) {
    this._requireCustom();
    for (const pkt of P.textPackets(index, text)) await this.t.query(pkt);
    return this.getText(index);
  },

  // ---- on-board gamepad (0xFD) ------------------------------------------------
  // Keys drive a HID gamepad computed on the keyboard: games see it without
  // this program running. { enabled, keysStopTyping, curve, deadzoneMm, fullMm,
  // buttonMm, bindings: [{ slot, target }] }; with caps 'gamepadPlus' also points (custom
  // curve), antiDeadzone, square, snappy, diagonalDeg (see analog.js, the same math).
  async getBoardGamepad() {
    this._requireCustom();
    const out = P.parseGamepad(await this.t.query(P.gamepadGetPacket()));
    out.bindings = [];
    for (let start = 0; start < P.SLOTS; start += 56) {
      const r = await this.t.query(P.gamepadGetBindPacket(start));
      for (let i = 0; i < r[3]; i++) {
        const v = r[8 + i];
        if (v > 0 && v <= P.GAMEPAD_TARGETS.length) out.bindings.push({ slot: start + i, target: P.GAMEPAD_TARGETS[v - 1] });
      }
    }
    return out;
  },

  // Writes settings and (when given) the full binding list. Bindings replace all.
  async setBoardGamepad({ bindings, ...settings }) {
    this._requireCustom();
    const cur = P.parseGamepad(await this.t.query(P.gamepadGetPacket()));
    const next = { ...cur, ...settings };
    // older open firmware refuses curve 4 and ignores [11..]: ask for these only where they exist
    const plus = next.curve === 'custom' || next.antiDeadzone || next.square || next.snappy || next.diagonalDeg;
    if (plus && !(await this.getCaps()).features.includes('gamepadPlus')) {
      throw Object.assign(new Error('The custom curve, anti-deadzone, square output, snappy joystick and diagonal angle need a newer open firmware'), { status: 400 });
    }
    const pkts = [P.gamepadSetPacket(next)];
    if (bindings) pkts.push(...P.gamepadBindPackets(bindings));
    for (const pkt of pkts) await this.t.query(pkt);
    return this.getBoardGamepad();
  },

  // Software takes over these keys: they stop typing and report events instead.
  async claimKeys(slots) {
    this._requireCustom();
    const claim = new Array(P.SLOTS).fill(0);
    slots.forEach((s) => { if (Number.isInteger(s) && s >= 0 && s < P.SLOTS) claim[s] = 1; });
    for (const pkt of P.claimPackets(claim)) await this.t.query(pkt);
  },

  async releaseKeys() {
    this._requireCustom();
    await this.t.query(P.releaseAllPacket());
  },

  // Calls onEvent({ slot, down }) for claimed keys. Uses the same input
  // collection as the travel stream. Returns a stop function.
  watchKeyEvents(onEvent) {
    this._requireCustom();
    const nodes = openInputNodes();
    for (const node of nodes) {
      node.on('data', (data) => { const e = P.parseKeyEvent(Array.from(data)); if (e) onEvent(e); });
      node.on('error', () => {});
    }
    return () => nodes.forEach((n) => { try { n.close(); } catch { /* closed */ } });
  },

  // Hold keys down from software; repeat within 2 s to keep them held.
  async injectKeys(modifiers = 0, usages = []) {
    this._requireCustom();
    await this.t.send(P.injectPacket(modifiers, usages));
  },

  // ---- play sequence (0xEF): the keyboard plays a timeline on its own clock ------
  // steps: text / JSON for sequence.js, or parsed [{ delay, type, a, b }]. Clears, uploads in
  // chunks, plays; returns the status. The keyboard lets go of everything at the end.
  async _requireSequence() {
    this._requireCustom();
    const { features } = await this.getCaps();
    if (!features.includes('sequence')) {
      throw Object.assign(new Error('Play sequence needs a newer open firmware'), { status: 400 });
    }
    return features;
  },

  async _seqQuery(pkt) {
    const st = P.parseSeqStatus(await this.t.query(pkt));
    if (st.error) throw Object.assign(new Error(`keyboard refused the sequence: ${st.error}`), { status: 400 });
    return st;
  },

  async playSequence(steps, { stopOnKey = false } = {}) {
    const list = Array.isArray(steps) && steps.every((s) => Number.isInteger(s?.type)) ? steps : parseSequence(steps);
    const features = await this._requireSequence();
    if (hasGlide(list) && !features.includes('sequenceGlide')) {
      throw Object.assign(new Error('Mouse glides ("move dx dy over 500ms") need a newer open firmware; a plain "move dx dy" works'), { status: 400 });
    }
    const st = await this._seqQuery(P.seqPacket(P.SEQ.CLEAR));
    if (list.length > st.capacity) throw Object.assign(new Error(`${list.length} steps, the keyboard holds ${st.capacity}`), { status: 400 });
    for (const pkt of P.seqAppendPackets(list)) await this._seqQuery(pkt);
    await this._seqQuery(P.seqPlayPacket(stopOnKey));
    return { ...(await this.sequenceStatus()), lengthMs: sequenceMs(list) };
  },

  async stopSequence() {
    await this._requireSequence();
    return this._seqQuery(P.seqPacket(P.SEQ.STOP));
  },

  // { playing, stopOnKey, step, steps, capacity, ended: done|stopped|key pressed|blocked|cleared|null }
  async sequenceStatus() {
    await this._requireSequence();
    return this._seqQuery(P.seqPacket(P.SEQ.STATUS));
  },

  // Per-key colours over the running effect for ttlMs; [0,0,0] = leave alone.
  async setOverlay(rgbByLed, ttlMs = 2000) {
    this._requireCustom();
    for (const pkt of P.overlayPackets(rgbByLed, ttlMs)) await this.t.send(pkt);
  },

  async clearOverlay() {
    this._requireCustom();
    await this.t.send(P.clearOverlayPacket());
  },

  // Every key's depth in mm right now (no stream needed).
  async snapshotDepth() {
    this._requireCustom();
    const caps = await this.getCaps();
    const depth = new Array(caps.keys).fill(0);
    for (let start = 0; start < caps.keys; start += 28) {
      const r = await this.t.query(P.hostPacket(P.HOST.SNAPSHOT, [start]));
      for (let i = 0; i < r[2]; i++) depth[start + i] = P.wireToMm(r[8 + 2 * i] | (r[9 + 2 * i] << 8), this.info.unitMm);
    }
    return depth;
  },

  // One frame for Live mode: rgbByLed[i] = [r, g, b] in LED chain order.
  // Latest frame wins, as with setLiveColor.
  sendLiveFrame(rgbByLed) {
    this._requireCustom();
    this._frame = rgbByLed;
    if (this._frameBusy) return;
    this._frameBusy = true;
    (async () => {
      try {
        while (this._frame) {
          const f = this._frame;
          this._frame = null;
          for (const pkt of P.liveFramePackets(f)) await this.t.send(pkt);
        }
      } catch {
        // a dropped frame is fine; the next call sends again
      } finally {
        this._frameBusy = false;
      }
    })();
  },
};
