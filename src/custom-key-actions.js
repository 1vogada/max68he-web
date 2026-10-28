// Key action maps (open firmware 0xEE, caps 'keyActions'): per key, what happens at which depth /
// after how long held. Engine 2 (feature 'keyModes', INFO [12] >= 2) adds the condition table,
// modes (= user layers 1..3) with names, and mouse keys. The JSON form and validation are in
// key-actions.js / key-modes.js. The driver owns the condition table: a write computes the entries
// its maps need, reuses identical ones, allocates free ones, writes them BEFORE the records and
// clears the ones no record uses AFTER. The keyboard saves the table on its own.
// Mixed into Keyboard.prototype by keyboard.js.
const P = require('./protocol');
const { parseSpec, toRecord, fromRecord, usesModes } = require('./key-actions');
const M = require('./key-modes');

const err = (msg) => Object.assign(new Error(msg), { status: 400 });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const NEEDS_V2 = 'Conditions (if), modes and mouse keys need a newer open firmware (key action engine 2)';
const NEEDS_V3 = 'Mouse keys with shareSpeed need a newer open firmware (key action engine 3)';
const NEEDS_V4 = 'Mouse keys with speedBy pressure or both need a newer open firmware (key action engine 4)';
const NEEDS_V5 = 'Conditions with notHeld need a newer open firmware (key action engine 5)';
const TABLE_ERRORS = { 3: 'bad value', 4: 'bad index', 5: 'in use (a key map uses it)' };
const prefixed = (e, where) => (where && e.status === 400 ? Object.assign(e, { message: `${where}: ${e.message}` }) : e);
const refsOf = (record) => P.decodeKaRecord(record).rules.map((x) => x.cond).filter(Boolean);

// a mode name: string, at most 16 bytes UTF-8, no NUL ('' = unnamed)
function checkModeName(name, where = 'name') {
  if (typeof name !== 'string') throw err(`${where} is a string ('' clears it)`);
  try { P.encodeModeName(name.trim()); } catch (e) { throw err(`${where}: ${e.message}`); }
  return name.trim();
}
const checkModeId = (id, where = 'id') => {
  if (!Number.isInteger(id) || id < 1 || id > P.KA.MODES) throw err(`${where} is a mode number 1..${P.KA.MODES}`);
  return id;
};
function dupName(list) {
  const named = list.filter((m) => m.name).map((m) => m.name.toLowerCase());
  return named.find((n, i) => named.indexOf(n) !== i);
}

module.exports = {
  async _requireKeyActions() {
    this._requireCustom();
    if (!(await this.getCaps()).features.includes('keyActions')) {
      throw Object.assign(new Error('Key action maps need a newer open firmware'), { status: 400 });
    }
  },

  // 'W', '12', 12 or { key | slot } -> { slot, name }
  async _kaKey(ref) {
    const r = typeof ref === 'object' && ref !== null ? ref : /^\d+$/.test(String(ref)) ? { slot: Number(ref) } : { key: ref };
    let slot = r.slot;
    if (slot === undefined) {
      try { [slot] = await this.resolveSlots([r.key]); } catch (e) { throw Object.assign(e, { status: 400 }); }
    }
    if (!Number.isInteger(slot) || slot < 0 || slot >= P.SLOTS) throw Object.assign(new Error(`slot is 0..${P.SLOTS - 1}`), { status: 400 });
    const name = (await this.listKeys()).find((k) => k.slot === slot)?.name ?? null;
    return { slot, name };
  },

  async _kaQuery(pkt) {
    const r = await this.t.query(pkt);
    if (r[0] !== P.KA.OP) throw new Error('the keyboard did not answer the key action command');
    if (r[2] > 1) {
      const why = r[2] === 3 ? (r[3] === 0xff ? 'bad key options' : `bad rule ${r[3] + 1}`) : P.KA_ERRORS[r[2]] ?? `error ${r[2]}`;
      throw Object.assign(new Error(`keyboard refused the key map: ${why}`), { status: 400 });
    }
    return r;
  },

  // condition / mode name commands: their own error words
  async _kaTableQuery(pkt, what) {
    const r = await this.t.query(pkt);
    if (r[0] !== P.KA.OP) throw new Error('the keyboard did not answer the key action command');
    if (r[2]) throw Object.assign(new Error(`keyboard refused the ${what}: ${TABLE_ERRORS[r[2]] ?? `error ${r[2]}`}`), { status: 400 });
    return r;
  },

  // { entries (keys that can have a map), maxRules, used, recordBytes, engine (1 .. 5), conditions,
  //   modes, activeModes (bit n-1 = mode n) }
  async keyActionsInfo() {
    await this._requireKeyActions();
    return this._kaInfo();
  },
  async _kaInfo() {
    return P.parseKaInfo(await this._kaQuery(P.kaInfoPacket()));
  },

  async _requireModes() {
    await this._requireKeyActions();
    const info = await this._kaInfo();
    if (info.engine < 2) throw err('Modes need a newer open firmware (key action engine 2)');
    return info;
  },

  // [{ id, name, active }] for modes 1..3 (name '' = unnamed)
  async getModes() {
    await this._requireModes();
    return this._kaModes();
  },
  async _kaModes() {
    const out = [];
    for (let id = 1; id <= P.KA.MODES; id++) {
      const m = P.parseKaMode(await this._kaTableQuery(P.kaModeGetPacket(id), 'mode'));
      out.push({ id, name: m.name, active: Boolean(m.active & (1 << (id - 1))) });
    }
    return out;
  },

  // name '' clears; 1..16 bytes UTF-8; two modes can not share a name. Returns getModes().
  async setModeName(id, name) {
    checkModeId(id);
    const clean = checkModeName(name);
    await this._requireModes();
    const modes = await this._kaModes();
    if (dupName(modes.map((m) => (m.id === id ? { ...m, name: clean } : m)))) throw err(`another mode is already called "${clean}"`);
    await this._kaTableQuery(P.kaModeSetPacket(id, clean), 'mode name');
    return this._kaModes();
  },

  // the 15 condition entries (entry n at [n - 1])
  async _kaConds() {
    const out = [];
    for (let i = 1; i <= P.KA.CONDS; i++) out.push(P.parseKaCond(await this._kaTableQuery(P.kaCondGetPacket(i), 'condition')).entry);
    return out;
  },

  // raw writes for backups (key-map-backup.js checked the values)
  async _kaSetCond(idx, entry) { await this._kaTableQuery(P.kaCondSetPacket(idx, entry), 'condition'); },
  async _kaSetModeName(id, name) { await this._kaTableQuery(P.kaModeSetPacket(id, name), 'mode name'); },

  // fromRecord's context: conditions, mode names and key names
  _kaCtx(conds, modes, keys) {
    const names = new Map(keys.map((k) => [k.slot, k.name]));
    return { conds, modeName: (id) => modes?.find((m) => m.id === id)?.name ?? '', keyName: (slot) => names.get(slot) };
  },

  // key: that key's map, or null when it has none; no key: every key that has one. `if` comes back
  // with key and mode names.
  async getKeyActions(key) {
    await this._requireKeyActions();
    const info = await this._kaInfo();
    const keys = await this.listKeys();
    const ctx = info.engine >= 2 ? this._kaCtx(await this._kaConds(), await this._kaModes(), keys) : this._kaCtx(null, null, keys);
    if (key !== undefined) {
      const { slot, name } = await this._kaKey(key);
      const r = await this._kaQuery(P.kaGetPacket(slot));
      return r[2] === 1 ? null : fromRecord(r.slice(8, 64), name, ctx);
    }
    return (await this._kaRecords()).map(({ slot, record }) => fromRecord(record, ctx.keyName(slot), ctx));
  },

  // every map as the raw 56-byte record: [{ slot, record }] (backups, key-map-backup.js)
  async keyActionRecords() {
    await this._requireKeyActions();
    return this._kaRecords();
  },

  // the whole table, raw: { engine, records, conditions?, modeNames? } (engine 2 adds the last two)
  async keyActionTable() {
    await this._requireKeyActions();
    const { engine } = await this._kaInfo();
    const records = await this._kaRecords();
    if (engine < 2) return { engine, records };
    return { engine, records, conditions: await this._kaConds(), modeNames: (await this._kaModes()).map((m) => m.name) };
  },

  async _kaRecords() {
    const slots = [];
    for (let start = 0; start < P.SLOTS;) {
      const r = await this._kaQuery(P.kaListPacket(start));
      const got = r.slice(8, 8 + Math.min(r[3], 56));
      slots.push(...got);
      if (!got.length || slots.length >= r[4]) break;
      start = got[got.length - 1] + 1;
    }
    const out = [];
    for (const slot of slots) {
      const r = await this._kaQuery(P.kaGetPacket(slot));
      if (r[2] === 0) out.push({ slot, record: r.slice(8, 64) });
    }
    return out;
  },

  // writes one raw record as it is (an all-0 record past the slot byte removes the map);
  // the caller checked caps and the record (key-map-backup.js)
  async _kaSetRecord(slot, record) {
    await this._kaQuery(P.kaSetPacket(slot, record));
  },

  // spec: see key-actions.js; checked before anything is sent. Returns the map as stored.
  async setKeyActions(spec) {
    return (await this._kaBatch({ maps: [spec] }, false)).maps[0];
  },

  async removeKeyActions(key) {
    const r = await this._kaBatch({ maps: [], remove: [key] }, false);
    return { ...r.removed[0], removed: true };
  },

  // { maps: [spec], remove?: [key | slot], modes?: [{ id, name }] }: everything is checked first
  // (shapes, keys, mode names, firmware engine, table and condition space), then written: mode names,
  // conditions, records, removals, then the conditions no record uses are cleared.
  // -> { maps: [stored map], removed: [{ key, slot }], modes? (engine 2) }
  async setKeyActionsBatch(body) {
    return this._kaBatch(body, true);
  },

  async _kaBatch(body, named) {
    if (!isObj(body)) throw err('the batch is { maps: [...], remove?: [key...], modes?: [{ id, name }] }');
    const bad = Object.keys(body).filter((k) => !['maps', 'remove', 'modes'].includes(k));
    if (bad.length) throw err(`unknown field${bad.length > 1 ? 's' : ''} ${bad.map((b) => `"${b}"`).join(', ')}`);
    const { maps = [], remove = [], modes } = body;
    if (!Array.isArray(maps)) throw err('maps is a list of key maps');
    if (!Array.isArray(remove)) throw err('remove is a list of keys (names or slots)');
    const at = (i) => (named ? `maps[${i}]` : '');
    const loose = maps.map((spec, i) => { try { return parseSpec(spec); } catch (e) { throw prefixed(e, at(i)); } });
    const names = modes === undefined ? null : this._kaModeList(modes);
    await this._requireKeyActions();
    const info = await this._kaInfo();
    const v2 = info.engine >= 2;
    if (!v2 && (names || loose.some(usesModes))) throw err(NEEDS_V2);
    if (info.engine < 5 && loose.some(M.usesNotHeld)) throw err(NEEDS_V5);
    if (info.engine < 4 && loose.some(M.speedByPressure)) throw err(NEEDS_V4);
    if (info.engine < 3 && loose.some(M.sharesSpeed)) throw err(NEEDS_V3);

    const keys = await this.listKeys();
    const slotOf = (ref, where) => {
      if (Number.isInteger(ref)) return ref;
      const s = String(ref).trim();
      if (/^\d+$/.test(s) && Number(s) < P.SLOTS) return Number(s);
      const hit = keys.find((k) => k.name.toLowerCase() === s.toLowerCase());
      if (!hit) throw err(`${where ? `${where}: ` : ''}no key named ${s}`);
      return hit.slot;
    };
    const keyName = (slot) => keys.find((k) => k.slot === slot)?.name ?? null;
    const slots = maps.map((spec, i) => slotOf(spec.slot ?? spec.key, at(i)));
    const gone = remove.map((ref, i) => slotOf(isObj(ref) ? ref.slot ?? ref.key : ref, named ? `remove[${i}]` : ''));
    const all = [...slots, ...gone];
    const twice = all.find((s, i) => all.indexOf(s) !== i);
    if (twice !== undefined) throw err(`${keyName(twice) ?? `slot ${twice}`} is in the batch twice`);

    const curModes = v2 ? await this._kaModes() : null;
    const finalModes = curModes && curModes.map((m) => ({ ...m, name: names?.find((x) => x.id === m.id)?.name ?? m.name }));
    if (finalModes && dupName(finalModes)) throw err(`two modes would be called "${dupName(finalModes)}"`);
    const modeOf = (ref, where) => {
      if (Number.isInteger(ref)) return ref;
      const hit = finalModes?.find((m) => m.name && m.name.toLowerCase() === ref.toLowerCase());
      if (!hit) throw err(`${where}: no mode named "${ref}" (name the mode first)`);
      return hit.id;
    };
    const wires = maps.map((spec, i) => {
      try { return parseSpec(spec, { slotOf: (k, w) => slotOf(M.LOOSE.slotOf(k), w), modeOf, self: slots[i] }); } catch (e) { throw prefixed(e, at(i)); }
    });

    const current = await this._kaRecords();
    const touched = new Set(all);
    const after = new Set(current.map((r) => r.slot).filter((s) => !touched.has(s)));
    wires.forEach((w, i) => { if (w.rules.length) after.add(slots[i]); });
    if (after.size > info.entries) throw err(`the key action table is full: ${info.entries} keys can have a map, this would make ${after.size}`);

    // conditions: reuse identical entries, allocate free ones; nothing written yet
    const conds = v2 ? await this._kaConds() : null;
    const table = conds && conds.map((e) => [...e]);
    const keep = new Set(current.filter((r) => !touched.has(r.slot)).flatMap((r) => refsOf(r.record)));
    const used = new Set(), changed = new Set();
    const condIndex = (entry) => {
      let i = table.findIndex((e) => !M.isFree(e) && M.sameEntry(e, entry));
      if (i < 0) {
        const open = [...table.keys()].filter((k) => !keep.has(k + 1) && !used.has(k + 1));
        i = open.find((k) => M.isFree(table[k])) ?? open[0] ?? -1;
        if (i < 0) throw err(`the condition table is full (${P.KA.CONDS} entries): these maps need more different conditions than fit`);
        table[i] = entry;
        changed.add(i + 1);
      }
      used.add(i + 1);
      return i + 1;
    };
    const records = wires.map((w, i) => (w.rules.length ? toRecord(w, slots[i], v2 ? condIndex : undefined) : P.encodeKaRecord({ slot: slots[i] })));
    const clear = v2 ? [...table.keys()].map((k) => k + 1).filter((n) => !M.isFree(table[n - 1]) && !keep.has(n) && !used.has(n)) : [];

    // writes
    for (const m of finalModes ?? []) {
      if (m.name !== curModes[m.id - 1].name) await this._kaSetModeName(m.id, m.name);
    }
    for (const n of changed) if (table[n - 1].join() !== conds[n - 1].join()) await this._kaSetCond(n, table[n - 1]);
    const stored = [];
    for (let i = 0; i < maps.length; i++) {
      const r = await this._kaQuery(P.kaSetPacket(slots[i], records[i]));
      stored.push(r.slice(8, 64));
    }
    for (const slot of gone) await this._kaQuery(P.kaSetPacket(slot, P.encodeKaRecord({ slot })));
    for (const n of clear) { await this._kaSetCond(n, P.KA_COND_FREE); table[n - 1] = [...P.KA_COND_FREE]; }

    const ctx = this._kaCtx(table, finalModes, keys);
    return {
      maps: stored.map((rec, i) => (rec[1] ? fromRecord(rec, keyName(slots[i]) ?? undefined, ctx)
        : { ...(keyName(slots[i]) && { key: keyName(slots[i]) }), slot: slots[i], removed: true })),
      removed: gone.map((slot) => ({ key: keyName(slot), slot })),
      ...(finalModes && { modes: finalModes.map(({ id, name }) => ({ id, name })) }),
    };
  },

  // modes: [{ id, name }] -> checked list
  _kaModeList(modes) {
    if (!Array.isArray(modes)) throw err('modes is a list of { id, name }');
    const out = modes.map((m, i) => {
      if (!isObj(m) || Object.keys(m).some((k) => !['id', 'name', 'active'].includes(k))) throw err(`modes[${i}] is { id, name }`);
      return { id: checkModeId(m.id, `modes[${i}].id`), name: checkModeName(m.name, `modes[${i}].name`) };
    });
    if (out.some((m, i) => out.findIndex((x) => x.id === m.id) !== i)) throw err('modes names a mode twice');
    return out;
  },
};
