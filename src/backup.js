// Profile export/import: everything the board stores for one profile, as raw
// values, so a backup restores exactly. Mixed into Keyboard.prototype.
const fs = require('fs');
const path = require('path');
const P = require('./protocol');
const { keyToMods } = require('./keys');
const { SWITCH_LIMITS } = require('./limits');

const FORMAT = 'max68he-profile';
const H = P.HALL;
const COLUMNS = [H.ACTUATION, H.RELEASE, H.RT_PRESS, H.RT_RELEASE, H.DKS_START, H.MODTAP_TIME, H.DEAD_BOTTOM,
  H.SNAP_PARTNER, H.MODE];
const MM_COLUMNS = [[H.ACTUATION, 'actuation'], [H.RELEASE, 'release'], [H.RT_PRESS, 'rtPress'],
  [H.RT_RELEASE, 'rtRelease'], [H.DEAD_BOTTOM, 'deadZone']];
// importProfile saves the profile it replaces here first (git-ignored)
const BACKUP_DIR = path.join(__dirname, '..', 'config', 'backups');

function isBytes(arr, len, max = 255) {
  return Array.isArray(arr) && arr.length === len && arr.every((v) => Number.isInteger(v) && v >= 0 && v <= max);
}

// Checks everything an import would write, before the first write. Shapes first, then
// values: the switch settings of every slot that holds a key within the same limits as
// the web API and MCP (empty slots go back as they were), and keys, lighting, options
// and DKS levels through the same checks a normal write makes.
function validate(data, info) {
  const bad = (msg) => { throw new Error(`not a valid backup: ${msg}`); };
  if (!data || data.format !== FORMAT || data.version !== 1) bad('unknown format');
  if (data.board?.id !== info.boardId) bad(`made for board ${data.board?.id}, this is ${info.boardId}`);
  for (const c of COLUMNS) {
    if (!isBytes(data.hall?.[c], P.SLOTS, P.WIDE.has(c) ? 0xffff : 0xff)) bad(`switch column ${c}`);
  }
  if (!Array.isArray(data.hall.dks) || data.hall.dks.length !== P.SLOTS || !data.hall.dks.every((a) => isBytes(a, 4))) bad('DKS actions');
  if (!Array.isArray(data.keymap) || data.keymap.length !== 4) bad('keymap layers');
  for (const layer of [...data.keymap, data.fn]) {
    if (!Array.isArray(layer) || layer.length !== P.SLOTS || !layer.every((v) => isBytes(v, 4))) bad('key layer');
  }
  for (const [layer, name] of [...data.keymap.map((l, n) => [l, `layer ${n}`]), [data.fn, 'Fn layer']]) {
    layer.forEach((v, s) => { try { P.checkValue(v); } catch (e) { bad(`${name} slot ${s}: ${e.message}`); } });
  }
  validateSwitches(data.hall, data.keymap[0], info, bad);
  validateRest(data, info, bad);
}

function validateSwitches(hall, base, info, bad) {
  const kinds = new Set(Object.values(P.KIND));
  for (let s = 0; s < P.SLOTS; s++) {
    if (!base[s].some(Boolean)) continue;
    const mode = hall[H.MODE][s];
    const kind = mode & P.KIND_MASK;
    if (!kinds.has(kind)) bad(`slot ${s}: unknown key kind ${kind}`);
    if ((mode & P.MODE_RT_CONTINUOUS) && !info.custom) bad(`slot ${s}: continuous rapid trigger needs the open firmware`);
    for (const [c, field] of MM_COLUMNS) {
      const mm = P.wireToMm(hall[c][s], info.unitMm);
      const [lo, hi] = SWITCH_LIMITS[field];
      if (!(mm >= lo && mm <= hi)) bad(`slot ${s}: ${field} ${mm} mm is outside ${lo}..${hi}`);
    }
    const dksStart = P.wireToMm(hall[H.DKS_START][s], info.unitMm);
    if (kind === P.KIND.dks && dksStart > SWITCH_LIMITS.actuation[1]) bad(`slot ${s}: DKS point ${dksStart} mm`);
    if (kind === P.KIND.modtap && hall[H.MODTAP_TIME][s] < 1) bad(`slot ${s}: mod-tap hold time 0`);
    const partner = hall[H.SNAP_PARTNER][s];
    if (kind === P.KIND.snap && (partner >= P.SLOTS || partner === s)) bad(`slot ${s}: snap partner ${partner}`);
  }
}

function validateRest(data, info, bad) {
  const L = data.lighting;
  if (!L || typeof L !== 'object') bad('lighting');
  try { P.ledPacket(L); } catch (e) { bad(`lighting: ${e.message}`); }
  if (P.OPEN_LIGHT_MODES[L.mode] && !info.custom) bad('lighting: that effect needs the open firmware');
  if (data.pollingRateHz != null && !P.REPORT_RATES.includes(data.pollingRateHz)) bad(`polling rate ${data.pollingRateHz}`);
  if (data.options != null) {
    const { antiMistouch, rtStability, wasdSwap } = data.options;
    if (typeof antiMistouch !== 'boolean' || typeof wasdSwap !== 'boolean') bad('options');
    try { P.optionsPacket({ fnIndex: 0, antiMistouch, rtStability, wasdSwap }); } catch (e) { bad(`options: ${e.message}`); }
  }
  if (data.dksLevels === undefined) return;
  if (typeof data.dksLevels !== 'object' || Array.isArray(data.dksLevels) || data.dksLevels === null) bad('DKS levels');
  for (const [key, d] of Object.entries(data.dksLevels)) {
    if (!/^\d+$/.test(key) || Number(key) >= P.SLOTS) bad(`DKS levels: slot ${key}`);
    try {
      if (!d || !Array.isArray(d.keys) || !Array.isArray(d.levels) || !d.levels.length) throw new Error('needs keys and levels');
      const keys = d.keys.map(keyToMods);
      if (!keys.some((k) => k.mods || k.usage)) throw new Error('no bound key');
      P.dksWritePacket(Number(key), { keys, levels: d.levels, gapMm: d.gapMm ?? 0.1 });
    } catch (e) {
      bad(`DKS levels of slot ${key}: ${e.message}`);
    }
  }
}

module.exports = {
  async _dksLevelsAll(mode) {
    const out = {};
    for (let s = 0; s < P.SLOTS; s++) {
      if ((mode[s] & P.KIND_MASK) !== P.KIND.dks) continue;
      const { keys, levels, gapMm } = await this.getDks(s);
      if (levels.length) out[s] = { keys, levels, gapMm };
    }
    return out;
  },

  async exportProfile() {
    const profile = await this.getProfile();
    const hall = {};
    for (const c of COLUMNS) hall[c] = await this.readColumn(c);
    hall.dks = await this.readDksAll();
    const keymap = [];
    for (let l = 0; l < 4; l++) keymap.push(await this.getKeymap(profile, l));
    return {
      format: FORMAT,
      version: 1,
      exportedAt: new Date().toISOString(),
      board: { id: this.info.boardId, firmware: this.info.firmware },
      profile,
      hall,
      keymap,
      fn: await this.getFnKeymap(profile),
      lighting: await this.getLighting(),
      pollingRateHz: await this.getReportRate(),
      options: await this.getOptions(),
      // multi-level DKS records (open firmware with DKS levels), by slot
      ...(await this.hasDksLevels() ? { dksLevels: await this._dksLevelsAll(hall[H.MODE]) } : {}),
    };
  },

  // Restores a backup into the active profile. Everything is checked first, and the
  // profile as it was is saved to backupDir (null: no copy). Only differing keys are
  // written; switch columns go in one bulk flash write. onStep(text) reports progress.
  // A failure part way names what was already written and where the copy is.
  async importProfile(data, onStep = () => {}, { backupDir = BACKUP_DIR } = {}) {
    validate(data, this.info);
    const profile = await this.getProfile();
    let backup = null;
    if (backupDir) {
      onStep('saving the current profile');
      const before = await this.exportProfile();
      fs.mkdirSync(backupDir, { recursive: true });
      backup = path.join(backupDir, `profile${profile}-${before.exportedAt.replace(/[:.]/g, '-')}.json`);
      fs.writeFileSync(backup, JSON.stringify(before, null, 1));
    }
    const done = { keys: 0, parts: [] };
    try {
      await this._importWrites(data, profile, onStep, done);
    } catch (e) {
      const written = [done.keys && `${done.keys} key${done.keys === 1 ? '' : 's'}`, ...done.parts].filter(Boolean);
      throw Object.assign(new Error(`import stopped: ${e.message}. Already written: ${written.join(', ') || 'nothing'}.`
        + (backup ? ` The profile from before the import is in ${backup}.` : '')),
      { status: e.status, device: e.device, written, backup });
    }
    return { keyWrites: done.keys, backup };
  },

  async _importWrites(data, profile, onStep, done) {
    for (let l = 0; l < 4; l++) {
      const cur = await this.getKeymap(profile, l);
      for (let s = 0; s < P.SLOTS; s++) {
        if (cur[s].join() === data.keymap[l][s].join()) continue;
        onStep(`key ${s} on layer ${l}`);
        await this.setKey(s, data.keymap[l][s], { profile, sublayer: l });
        done.keys++;
      }
    }
    const fn = await this.getFnKeymap(profile);
    for (let s = 0; s < P.SLOTS; s++) {
      if (fn[s].join() === data.fn[s].join()) continue;
      onStep(`Fn key ${s}`);
      await this.setKey(s, data.fn[s], { layer: 'fn', profile });
      done.keys++;
    }
    onStep('switch settings');
    const packets = COLUMNS.flatMap((c) => P.hallSetAll(c, data.hall[c], false));
    const curDks = await this.readDksAll();
    for (let s = 0; s < P.SLOTS; s++) {
      if (curDks[s].join() !== data.hall.dks[s].join()) packets.push(P.dksActionsPacket(s, data.hall.dks[s], false));
    }
    // Commit once, on a last packet that rewrites the mode of slot 0 unchanged.
    packets.push(P.hallSetOne(H.MODE, 0, data.hall[H.MODE][0], true));
    await this.t.flash(packets);
    done.parts.push('switch settings');
    if (data.dksLevels && await this.hasDksLevels()) {   // after the stock columns, which re-convert DKS keys
      for (const [slot, d] of Object.entries(data.dksLevels)) {
        onStep(`DKS levels of key ${slot}`);
        await this.setDksLevels(Number(slot), d);
        done.parts.push(`DKS levels of key ${slot}`);
      }
    }
    onStep('lighting and options');
    await this.setLighting(data.lighting);
    done.parts.push('lighting');
    if (data.pollingRateHz) {
      await this.setReportRate(data.pollingRateHz);
      done.parts.push('polling rate');
    }
    if (data.options) {
      const { antiMistouch, rtStability, wasdSwap } = data.options;
      await this.setOptions({ antiMistouch, rtStability, wasdSwap });
      done.parts.push('options');
    }
  },
};
