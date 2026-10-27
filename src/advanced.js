// Advanced keys (DKS, mod-tap, toggle, snap tap), keyboard options and
// profile backup. Mixed into Keyboard.prototype by keyboard.js.
// Shapes: vendor gen2 class (setSnapKeySimple, setMagnetismInfoSimple) and
// sharkfin docs/PROTOCOL.md "Magnetic switches".
const P = require('./protocol');
const { slotName, keyToMods, modsToName } = require('./keys');

const H = P.HALL;
// Bad input, not a device fault: callers (the web server) answer 400 and keep the connection.
const userError = (msg) => Object.assign(new Error(msg), { status: 400 });
const KIND_NAMES = Object.fromEntries(Object.entries(P.KIND).map(([k, v]) => [v, k]));
const ZERO = [0, 0, 0, 0];
const sublayersFor = { dks: 4, modtap: 2, toggle: 1, toggleRepeat: 1, snap: 0, normal: 0 };

module.exports = {
  // ---- options ----------------------------------------------------------

  async getOptions() {
    return P.parseOptions(await this.t.query(P.packet(P.OP.GET_OPTIONS)));
  },

  // Read-modify-write: { antiMistouch, rtStability (0..125 step 25), wasdSwap }.
  async setOptions(changes) {
    const next = { ...(await this.getOptions()), ...changes };
    await this.t.writeSetting(P.optionsPacket(next));
    return this.getOptions();
  },

  // ---- multi-level DKS (open firmware with 'dksLevels') ----------------------

  async hasDksLevels() {
    if (!this.info?.custom) return false;
    try { return (await this.getCaps()).features.includes('dksLevels'); } catch { return false; }
  },

  // { keys: [4 names, 'none' = unbound], gapMm, levels: [{ depthMm, actions: [4 x { down, up }] }], maxLevels }
  async getDks(slot) {
    const d = P.parseDks(await this.t.query(P.dksReadPacket(slot)));
    return { ...d, keys: d.keys.map(modsToName) };
  },

  // keys: up to 4 names ('W', 'LShift', 'Ctrl+C', 'none'); levels: 1..8, each deeper than the last.
  // The key becomes DKS (rapid trigger kept); the keyboard saves it on its own.
  async setDksLevels(slot, { keys, levels, gapMm = 0.1 }) {
    if (!(await this.hasDksLevels())) throw userError('multi-level DKS needs the open firmware with DKS levels');
    if (!Array.isArray(levels) || !levels.length || levels.length > P.DKS_MAX_LEVELS) throw userError(`1..${P.DKS_MAX_LEVELS} levels`);
    if (!Array.isArray(keys) || keys.length > 4) throw userError('up to 4 bound keys');
    let mu;
    try { mu = keys.map(keyToMods); } catch (e) { throw userError(e.message); }
    if (!mu.some((k) => k.mods || k.usage)) throw userError('bind at least one key');
    let pkt;
    try { pkt = P.dksWritePacket(slot, { keys: mu, levels, gapMm }); } catch (e) { throw userError(e.message); }
    const d = P.parseDks(await this.t.query(pkt));
    if (d.levels.length !== levels.length) throw new Error('the keyboard did not take the DKS levels');
    return { ...d, keys: d.keys.map(modsToName) };
  },

  // ---- reading advanced keys ---------------------------------------------

  async readDksAll() {
    const bytes = [];
    for (let page = 0; page < 8; page++) {
      bytes.push(...await this.t.queryPage(P.packet(P.OP.GET_HALL, [H.DKS_ALL, 1, page])));
    }
    return Array.from({ length: P.SLOTS }, (_, s) => [0, 1, 2, 3].map((i) => bytes[i * P.SLOTS + s]));
  },

  // Every key whose kind is not plain, with its bound keys by sub-layer.
  async getAdvancedKeys(profile) {
    const p = profile ?? await this.getProfile();
    const u = this.info.unitMm;
    const [mode, dksStart, mtTime, partner, dks, act] = [
      await this.readColumn(H.MODE), await this.readColumn(H.DKS_START), await this.readColumn(H.MODTAP_TIME),
      await this.readColumn(H.SNAP_PARTNER), await this.readDksAll(), await this.readColumn(H.ACTUATION),
    ];
    const slots = mode.map((m, s) => s).filter((s) => (mode[s] & P.KIND_MASK) !== 0 && KIND_NAMES[mode[s] & P.KIND_MASK]);
    if (!slots.length) return [];
    const layers = [await this.getKeymap(p, 0)];
    for (let l = 1; l < 4; l++) layers.push(await this.getKeymap(p, l));
    const levels = slots.some((s) => (mode[s] & P.KIND_MASK) === P.KIND.dks) && await this.hasDksLevels();
    const out = [];
    for (const s of slots) {
      if (levels && (mode[s] & P.KIND_MASK) === P.KIND.dks) {
        const d = await this.getDks(s);
        out.push({ slot: s, kind: 'dks', rapidTrigger: (mode[s] & 0x80) !== 0, keys: d.keys, gapMm: d.gapMm, levels: d.levels, maxLevels: d.maxLevels });
        continue;
      }
      out.push(this._advEntry(s, mode, dksStart, mtTime, partner, dks, act, layers, u));
    }
    return out;
  },

  // one advanced key in the stock format (and DKS on firmware without levels)
  _advEntry(s, mode, dksStart, mtTime, partner, dks, act, layers, u) {
    const kind = KIND_NAMES[mode[s] & P.KIND_MASK];
    const keys = layers.slice(0, sublayersFor[kind]).map((layer) => slotName(layer[s]) ?? 'none');
    const out = { slot: s, kind, rapidTrigger: (mode[s] & 0x80) !== 0, keys };
    if (kind === 'dks') {
      out.firstPointMm = P.wireToMm(dksStart[s], u);
      out.secondPointMm = P.wireToMm(act[s], u);
      out.cells = dks[s].map(P.dksCells);
    }
    if (kind === 'modtap') out.holdMs = mtTime[s] * 10;
    if (kind === 'snap') out.partner = partner[s];
    return out;
  },

  // ---- writing advanced keys ---------------------------------------------

  async _modeByte(slot, kind) {
    const mode = (await this.readColumn(H.MODE))[slot];
    return (mode & ~P.KIND_MASK & 0xff) | P.KIND[kind];   // keep the RT bits
  },

  // Sub-layer key writes (flash, paced like key writes) for one slot.
  async _setSublayers(slot, values, profile) {
    const p = profile ?? await this.getProfile();
    for (let l = 0; l < values.length; l++) await this.setKey(slot, values[l], { profile: p, sublayer: l });
  },

  // Snap tap / SOCD: pressing one releases the other. Both keys become snap.
  async setSnap(slotA, slotB) {
    if (slotA === slotB) throw userError('snap needs two different keys');
    for (const s of [slotA, slotB]) {
      const kind = KIND_NAMES[(await this.readColumn(H.MODE))[s] & P.KIND_MASK];
      if (kind && kind !== 'normal' && kind !== 'snap') throw userError(`slot ${s} is ${kind}; clear it first`);
    }
    await this.t.flash([
      P.hallSetOne(H.MODE, slotA, await this._modeByte(slotA, 'snap'), false),
      P.hallSetOne(H.MODE, slotB, await this._modeByte(slotB, 'snap'), false),
      P.hallSetOne(H.SNAP_PARTNER, slotA, slotB, false),
      P.hallSetOne(H.SNAP_PARTNER, slotB, slotA, true),
    ]);
  },

  // Mod-tap: tap sends `tap`, holding past holdMs sends `hold`.
  // The hold key replaces the key's base mapping (sub-layer 0).
  async setModTap(slot, hold, tap, holdMs = 200) {
    if (!Number.isInteger(holdMs) || holdMs < 10 || holdMs > 2550) throw userError('holdMs is 10..2550');
    await this._setSublayers(slot, [hold, tap]);
    await this.t.flash([
      P.hallSetOne(H.MODTAP_TIME, slot, Math.round(holdMs / 10), false),
      P.hallSetOne(H.MODE, slot, await this._modeByte(slot, 'modtap'), true),
    ]);
  },

  // Toggle: a press latches `key` down, the next press releases it.
  // repeat: while latched, the key is re-sent rapidly.
  async setToggle(slot, key, repeat = false) {
    await this._setSublayers(slot, [key]);
    await this.t.flash([P.hallSetOne(H.MODE, slot, await this._modeByte(slot, repeat ? 'toggleRepeat' : 'toggle'), true)]);
  },

  // Dynamic keystroke: up to 4 bindings [{ key: [4 bytes], cells: [A,B,C,D] }].
  // firstPointMm is the shallow point; secondPointMm (the key's actuation) the deep one.
  async setDks(slot, { firstPointMm, secondPointMm, bindings }) {
    if (!Array.isArray(bindings) || !bindings.length || bindings.length > 4) throw userError('1..4 DKS bindings');
    if (!(firstPointMm < secondPointMm)) throw userError('first point must be shallower than the second');
    const u = this.info.unitMm;
    const keys = [0, 1, 2, 3].map((i) => bindings[i]?.key ?? ZERO);
    const actions = [0, 1, 2, 3].map((i) => (bindings[i] ? P.dksActionByte(bindings[i].cells) : 0));
    await this._setSublayers(slot, keys);
    await this.t.flash([
      P.hallSetOne(H.DKS_START, slot, P.mmToWire(H.DKS_START, firstPointMm, u), false),
      P.hallSetOne(H.ACTUATION, slot, P.mmToWire(H.ACTUATION, secondPointMm, u), false),
      P.dksActionsPacket(slot, actions, false),
      P.hallSetOne(H.MODE, slot, await this._modeByte(slot, 'dks'), true),
    ]);
  },

  // Back to a plain key. Clears sub-layers 1..3 and, for snap, the partner too.
  async clearAdvanced(slot) {
    const mode = await this.readColumn(H.MODE);
    const kind = KIND_NAMES[mode[slot] & P.KIND_MASK];
    const packets = [];
    if (kind === 'snap') {
      const partner = (await this.readColumn(H.SNAP_PARTNER))[slot];
      if (partner < P.SLOTS && (mode[partner] & P.KIND_MASK) === P.KIND.snap) {
        packets.push(P.hallSetOne(H.MODE, partner, mode[partner] & ~P.KIND_MASK & 0xff, false));
        packets.push(P.hallSetOne(H.SNAP_PARTNER, partner, P.NO_PARTNER, false));
      }
      packets.push(P.hallSetOne(H.SNAP_PARTNER, slot, P.NO_PARTNER, false));
    } else if (kind === 'dks' && await this.hasDksLevels()) {
      await this.t.query(P.dksWritePacket(slot, { levels: [] }));   // removes the levels and the DKS kind
      return;
    } else if (kind === 'dks') {
      packets.push(P.dksActionsPacket(slot, ZERO, false));
    } else if (kind === 'modtap') {
      packets.push(P.hallSetOne(H.MODTAP_TIME, slot, 0, false));
    }
    packets.push(P.hallSetOne(H.MODE, slot, mode[slot] & ~P.KIND_MASK & 0xff, true));
    await this.t.flash(packets);
    if (sublayersFor[kind] > 1) {
      const p = await this.getProfile();
      for (let l = 1; l < sublayersFor[kind]; l++) await this.setKey(slot, ZERO, { profile: p, sublayer: l });
    }
  },
};
