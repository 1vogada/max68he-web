// High-level API for the Attack Shark MAX68HE (ROYUAN gen2, board 2755), and the
// X82HE Pro (board 2356) on its stock firmware, which speaks the same protocol.
// Everything a UI or script needs; no printing, no process exits.
const { Transport, findSettingsPath, openInputNodes, KEY_GAP_MS } = require('./hid');
const P = require('./protocol');
const { slotName } = require('./keys');
const lock = require('./lock');
const models = require('./models');
const { STORED_LIMITS } = require('./limits');

const BOARD_ID = models.DEFAULT.boardId;
const KINDS = new Set(Object.values(P.KIND));

// First thing wrong in switch settings read back for the keys in `slots`, or null.
// `mode` is the mode column read a second time: an empty page reads as plain keys.
function switchReadProblem(sw, slots, mode) {
  for (const s of slots) {
    for (const [f, [lo, hi]] of Object.entries(STORED_LIMITS)) {
      if (!(sw[s][f] >= lo && sw[s][f] <= hi)) return `slot ${s} ${f} ${sw[s][f]} mm`;
    }
    if (!KINDS.has(sw[s].kind)) return `slot ${s} kind ${sw[s].kind}`;
    if ((mode[s] & P.KIND_MASK) !== sw[s].kind || ((mode[s] & P.MODE_RAPID_TRIGGER) !== 0) !== sw[s].rapidTrigger) {
      return `slot ${s} mode differs between two reads`;
    }
  }
  return null;
}

class Keyboard {
  constructor(transport, model = models.DEFAULT) {
    this.model = model;
    this.t = transport ?? new Transport(findSettingsPath(model.pid));
    this.info = null;
  }

  // Takes the cross-process lock first (lock.js): one program at a time per keyboard.
  // key picks the model (models.pick: else MAX68HE_KEYBOARD, else the first plugged in).
  static async open({ key } = {}) {
    const model = models.pick(key);
    lock.acquire(lock.fileFor(model.key));
    try {
      const kb = new Keyboard(undefined, model);
      try {
        await kb.identify();
      } catch (e) {
        kb.close();
        throw e;
      }
      return kb;
    } catch (e) {
      lock.release();
      throw e;
    }
  }

  async identify() {
    const r = await this.t.query(P.packet(P.OP.IDENTIFY));
    // The id is 16 bits (stock replies c3 0a); bytes 3.. carry open-firmware diagnostics.
    const boardId = r[1] | (r[2] << 8);
    const revision = (r[8] << 8) | r[7];
    const m = this.model;
    if (boardId !== m.boardId) {
      throw new Error(`board id ${boardId} is not the ${m.name} (${m.boardId}); refusing to continue`);
    }
    // Stock firmware leaves bytes 3..6 zero; the open fun60-derived firmware puts its
    // boot stage and a running loop counter there. Only the MAX68HE has that firmware,
    // so no open-firmware packet ever goes to another board.
    const custom = m.openFirmware && r.slice(3, 7).some((b) => b !== 0);
    this.info = { boardId, revision, firmware: revision.toString(16), unitMm: P.unitMm(revision), custom,
      model: m.key, modelName: m.name };
    return this.info;
  }

  // ---- simple settings -------------------------------------------------

  async getProfile() {
    return (await this.t.query(P.packet(P.OP.GET_PROFILE)))[1];
  }

  async setProfile(profile) {
    if (![0, 1, 2, 3].includes(profile)) throw new Error('profile must be 0..3');
    await this.t.writeSetting(P.packet(P.OP.SET_PROFILE, [profile]));
  }

  // Polling rate in Hz (8000 .. 125).
  async getReportRate() {
    return P.REPORT_RATES[(await this.t.query(P.packet(P.OP.GET_REPORT_RATE)))[2]] ?? null;
  }

  async setReportRate(hz) {
    await this.t.writeSetting(P.reportRatePacket(hz));
    return this.getReportRate();
  }

  async getSleepTimers() {
    const r = await this.t.query(P.packet(P.OP.GET_SLEEP));
    const u16 = (i) => r[i] | (r[i + 1] << 8);
    return { sleepBt: u16(8), sleep24: u16(10), deepBt: u16(12), deep24: u16(14) };
  }

  // ---- lighting ----------------------------------------------------------

  async getLighting() {
    return P.parseLed(await this.t.query(P.packet(P.OP.GET_LED)));
  }

  // Merges `changes` into the current lighting and writes it.
  async setLighting(changes) {
    const cur = await this.getLighting();
    const next = { ...cur, ...changes };
    if (P.OPEN_LIGHT_MODES[next.mode] && !this.info.custom) {
      throw Object.assign(new Error('that effect needs the open firmware'), { status: 400 });
    }
    await this.t.writeSetting(P.ledPacket(next));
    return this.getLighting();
  }

  // ---- keymap ------------------------------------------------------------

  // 128 slots of [kind, a, b, c] for the active-profile layer.
  async getKeymap(profile, sublayer = 0) {
    const p = profile ?? await this.getProfile();
    const bytes = [];
    for (let page = 0; page < 8; page++) {
      bytes.push(...await this.t.queryPage(P.packet(P.OP.GET_KEYMAP, [p, 0xff, page, sublayer])));
    }
    return Array.from({ length: P.SLOTS }, (_, s) => bytes.slice(s * 4, s * 4 + 4));
  }

  // Fn layer for one host OS layer: 128 slots of 4 bytes. All zero = the
  // key falls through to the base layer.
  async getFnKeymap(profile, os = 'win') {
    const p = profile ?? await this.getProfile();
    const bytes = [];
    for (let page = 0; page < 8; page++) bytes.push(...await this.t.queryPage(P.fnGetPage(p, page, os)));
    return Array.from({ length: P.SLOTS }, (_, s) => bytes.slice(s * 4, s * 4 + 4));
  }

  // Remaps one key. value: 4 bytes (see keys.parseKey). layer 'base' or 'fn'.
  // Returns the slot's value read back from the board.
  // sublayer (base only): 0 is the keymap; 1..3 hold advanced-key bindings.
  async setKey(slot, value, { layer = 'base', profile, os = 'win', sublayer = 0 } = {}) {
    const p = profile ?? await this.getProfile();
    if (layer === 'base') {
      await this.t.writeSetting(P.keymapSetOne(p, slot, value, sublayer), KEY_GAP_MS);
      return (await this.getKeymap(p, sublayer))[slot];
    }
    if (layer === 'fn') {
      await this.t.writeSetting(P.fnSetOne(p, slot, value, os), KEY_GAP_MS);
      return (await this.getFnKeymap(p, os))[slot];
    }
    throw new Error("layer is 'base' or 'fn'");
  }

  // ---- per-key colour pictures -------------------------------------------
  // Five stored pictures; light mode 13 shows one. The board cannot read a
  // picture back reliably, so callers keep their own copy.

  // rgbBySlot: array indexed by slot of [r, g, b] (missing = off).
  async setPicture(pic, rgbBySlot) {
    await this.t.flash(P.userPicPages(pic, rgbBySlot));
  }

  async showPicture(pic, brightness) {
    const cur = await this.getLighting();
    return this.setLighting({ mode: 13, option: pic, brightness: brightness ?? cur.brightness });
  }

  // ---- macros --------------------------------------------------------------

  // Firmware 5.04 reads macros at twice the stride it stores them (verified:
  // GET 1 returns macro 2), so macro n is read with index n/2 and odd macros
  // cannot be read back at all. Playback is unaffected. Returns null for odd.
  // The open firmware keeps that stride and serves odd macro n at GET 8 + (n-1)/2.
  async getMacro(index) {
    P.checkMacroIndex(index);
    if (index % 2 && !this.info.custom) return null;
    const get = index % 2 ? 8 + (index - 1) / 2 : index / 2;
    const bytes = [];
    for (let page = 0; page < 4; page++) {
      bytes.push(...await this.t.queryPage(P.packet(P.OP.GET_MACRO, [get, page])));
    }
    return P.decodeMacro(bytes);
  }

  // steps: [{ usage, down, delayMs }]. Assign it with setKey(slot, [9, mode, index, 0]).
  // Returns the macro read back, or null for odd indexes (see getMacro).
  async setMacro(index, steps, repeat = 1) {
    await this.t.flash(P.macroPages(index, P.encodeMacro(steps, repeat)));
    return this.getMacro(index);
  }

  // Slots that hold a key, with their names: [{ slot, name, value }]
  async listKeys(profile) {
    const map = await this.getKeymap(profile);
    return map.map((value, slot) => ({ slot, name: slotName(value), value }))
      .filter((k) => k.name);
  }

  // Key names or slot numbers -> slots. Throws on an unknown name.
  async resolveSlots(keys) {
    const known = await this.listKeys();
    return keys.map((key) => {
      if (Number.isInteger(key)) return key;
      if (/^\d+$/.test(key)) return Number(key);
      const hit = known.find((k) => k.name.toLowerCase() === String(key).trim().toLowerCase());
      if (!hit) throw new Error(`no key named ${key}`);
      return hit.slot;
    });
  }

  // Slots of every key except the given ones.
  async slotsExcept(keys) {
    const skip = new Set(await this.resolveSlots(keys));
    return (await this.listKeys()).map((k) => k.slot).filter((s) => !skip.has(s));
  }

  // ---- magnetic switches -------------------------------------------------

  async readColumn(subop) {
    const wide = P.WIDE.has(subop);
    const bytes = [];
    for (let page = 0; page < (wide ? 4 : 2); page++) {
      bytes.push(...await this.t.queryPage(P.packet(P.OP.GET_HALL, [subop, 1, page])));
    }
    return Array.from({ length: P.SLOTS }, (_, s) => (wide ? bytes[s * 2] | (bytes[s * 2 + 1] << 8) : bytes[s]));
  }

  // Per-slot switch settings in millimetres for the active profile.
  async getSwitches() {
    const u = this.info.unitMm;
    const H = P.HALL;
    const [act, rel, rtp, rtr, dead, mode] = [
      await this.readColumn(H.ACTUATION), await this.readColumn(H.RELEASE),
      await this.readColumn(H.RT_PRESS), await this.readColumn(H.RT_RELEASE),
      await this.readColumn(H.DEAD_BOTTOM), await this.readColumn(H.MODE),
    ];
    return Array.from({ length: P.SLOTS }, (_, s) => ({
      slot: s,
      actuation: P.wireToMm(act[s], u),
      release: P.wireToMm(rel[s], u),
      rapidTrigger: (mode[s] & P.MODE_RAPID_TRIGGER) !== 0,
      continuousRt: (mode[s] & P.MODE_RT_CONTINUOUS) !== 0,
      rtPress: P.wireToMm(rtp[s], u),
      rtRelease: P.wireToMm(rtr[s], u),
      deadZone: P.wireToMm(dead[s], u),
      kind: mode[s] & P.KIND_MASK,
    }));
  }

  // Switch settings to write back: untouched slots go back as read, and a hall page
  // has no echo to check (a read during a save comes back empty). So every slot that
  // holds a key must read sane; one more read if not, else the write is refused.
  async _switchesForWrite() {
    for (let attempt = 1; ; attempt++) {
      const keys = (await this.listKeys()).map((k) => k.slot);
      const sw = await this.getSwitches();
      const bad = keys.length ? switchReadProblem(sw, keys, await this.readColumn(P.HALL.MODE)) : 'no keys in the keymap';
      if (!bad) return sw;
      if (attempt === 2) throw new Error(`switch settings read back wrong twice (${bad}); nothing written`);
    }
  }

  // Changes plain switch settings on one key. Keeps its advanced kind.
  // settings: { actuation, release, rapidTrigger, continuousRt, rtPress, rtRelease, deadZone } (mm)
  // continuousRt (open firmware): rapid trigger stays armed until the key is fully up.
  async setSwitch(slot, settings) {
    const cur = (await this._switchesForWrite())[slot];
    const next = { ...cur, ...settings };
    const u = this.info.unitMm;
    const H = P.HALL;
    const modeByte = this._switchMode(cur.kind, next.rapidTrigger, next.continuousRt);
    // Untouched fields go back as the exact raw counts read, not clamped.
    const wire = (field, sub) => (settings[field] !== undefined
      ? P.mmToWire(sub, next[field], u) : Math.round(cur[field] / u));
    const cols = [
      [H.MODE, modeByte],
      [H.ACTUATION, wire('actuation', H.ACTUATION)],
      [H.RELEASE, wire('release', H.RELEASE)],
      [H.RT_PRESS, wire('rtPress', H.RT_PRESS)],
      [H.RT_RELEASE, wire('rtRelease', H.RT_RELEASE)],
      [H.DEAD_BOTTOM, wire('deadZone', H.DEAD_BOTTOM)],
    ];
    await this.t.flash(cols.map(([sub, v], i) => P.hallSetOne(sub, slot, v, i === cols.length - 1)));
  }

  // Mode byte: advanced kind + rapid trigger (+ continuous RT on the open firmware only).
  _switchMode(kind, rapidTrigger, continuousRt) {
    return (kind & P.KIND_MASK) | (rapidTrigger ? P.MODE_RAPID_TRIGGER : 0)
      | (continuousRt && this.info.custom ? P.MODE_RT_CONTINUOUS : 0);
  }

  // Same plain settings on every slot, or only on `slots` when given.
  // One bulk flash write. Each key keeps its advanced kind.
  async setAllSwitches(settings, slots) {
    const cur = await this._switchesForWrite();
    const only = slots ? new Set(slots) : null;
    const changes = (k, field) => (!only || only.has(k.slot)) && settings[field] !== undefined;
    const pick = (k, field) => (changes(k, field) ? settings[field] : k[field]);
    const u = this.info.unitMm;
    const H = P.HALL;
    // Untouched values go back as the exact raw counts read, not clamped.
    const col = (field, sub) => cur.map((k) => (changes(k, field)
      ? P.mmToWire(sub, settings[field], u) : Math.round(k[field] / u)));
    const columns = [
      [H.MODE, cur.map((k) => this._switchMode(k.kind, pick(k, 'rapidTrigger'), pick(k, 'continuousRt')))],
      [H.ACTUATION, col('actuation', H.ACTUATION)],
      [H.RELEASE, col('release', H.RELEASE)],
      [H.RT_PRESS, col('rtPress', H.RT_PRESS)],
      [H.RT_RELEASE, col('rtRelease', H.RT_RELEASE)],
      [H.DEAD_BOTTOM, col('deadZone', H.DEAD_BOTTOM)],
    ];
    const packets = columns.flatMap(([sub, vals], i) => P.hallSetAll(sub, vals, i === columns.length - 1));
    await this.t.flash(packets);
  }

  // ---- live colour ---------------------------------------------------------
  // Mode 21 takes one colour for the whole board, streamed over 0x0E without
  // touching flash. Entering and leaving the mode are the only flash writes.

  async startLiveColor() {
    if (this.live) return;
    this.live = { restore: await this.getLighting(), pending: null, sending: false };
    await this.setLighting({ mode: 21 });
  }

  // Latest frame wins: calls made while a frame is on the wire replace each
  // other, so a fast producer never builds a queue.
  setLiveColor(r, g, b) {
    const live = this.live;
    if (!live) throw new Error('call startLiveColor first');
    live.pending = [r, g, b];
    if (live.sending) return;
    live.sending = true;
    (async () => {
      try {
        while (live.pending && this.live === live) {
          const [pr, pg, pb] = live.pending;
          live.pending = null;
          await this.t.send(P.screenColorPacket(pr, pg, pb));
        }
      } catch {
        // a dropped frame is fine; the next call sends again
      } finally {
        live.sending = false;
      }
    })();
  }

  // Leaves live mode and puts back the lighting from before.
  async stopLiveColor() {
    const live = this.live;
    if (!live) return;
    this.live = null;
    await this.setLighting(live.restore);
  }

  // ---- live travel -------------------------------------------------------

  // Calls onTravel({ slot, mm }) as keys move; 0 mm on release. Cable only.
  // A key held still sends nothing. Returns a stop function.
  async startTravel(onTravel) {
    if (this.travelNodes) throw new Error('travel stream already running');
    const u = this.info.unitMm;
    this.travelNodes = openInputNodes(this.model.pid);
    for (const node of this.travelNodes) {
      node.on('data', (data) => {
        const t = P.parseTravel(Array.from(data));
        if (t) onTravel({ slot: t.slot, mm: P.wireToMm(t.counts, u) });
      });
      node.on('error', () => {});
    }
    await this.t.send(P.packet(P.OP.TRAVEL_STREAM, [1]));
    return () => this.stopTravel();
  }

  async stopTravel() {
    if (!this.travelNodes) return;
    const nodes = this.travelNodes;
    this.travelNodes = null;
    try {
      await this.t.send(P.packet(P.OP.TRAVEL_STREAM, [0]));
    } finally {
      nodes.forEach((n) => { try { n.close(); } catch { /* already closed */ } });
    }
  }

  close() {
    if (this.travelNodes) {
      this.travelNodes.forEach((n) => { try { n.close(); } catch { /* already closed */ } });
      this.travelNodes = null;
      // fire and forget (WebHID answers with a promise: a rejection there is ignored too)
      try { Promise.resolve(this.t.dev.sendFeatureReport([0, ...P.packet(P.OP.TRAVEL_STREAM, [0])])).catch(() => {}); } catch { /* gone */ }
    }
    try { this.t.close(); } finally { lock.release(); }
  }
}

Object.assign(Keyboard.prototype, require('./advanced'), require('./backup'), require('./custom'), require('./custom-key-actions'),
  require('./calibration'));

module.exports = { Keyboard, BOARD_ID };
