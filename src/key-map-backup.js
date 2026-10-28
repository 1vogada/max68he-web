// Key action maps (0xEE, caps 'keyActions') as a whole table: read, check, write back and
// compare. Used by the flasher (a firmware update erases the table's flash sector) and by
// profile export / import. The firmware keeps ONE table for all profiles.
// Entry: { slot, key, record: [56 bytes], map }. record is the source of truth; map (the
// key-actions.js JSON with its summary) is only there to read. Key action engine 2 adds the
// condition table (15 raw 4-byte entries) and the 3 mode names: a table is { maps, conditions?,
// modeNames? }; restore order is names, conditions, records, then unused conditions are cleared.
const P = require('./protocol');
const { parseSpec, toRecord, fromRecord } = require('./key-actions');
const M = require('./key-modes');

const isBytes = (a, len) => Array.isArray(a) && a.length === len && a.every((v) => Number.isInteger(v) && v >= 0 && v <= 255);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const label = (m) => (m.key ? `${m.key} (slot ${m.slot})` : `slot ${m.slot}`);

// false on stock firmware and open firmware without key action maps
async function hasKeyActions(kb) {
  if (!kb?.info?.custom) return false;
  return (await kb.getCaps()).features.includes('keyActions');
}

// the whole table: { maps, conditions?, modeNames? } (engine 2 adds the last two)
async function readTable(kb) {
  const t = await kb.keyActionTable();
  const keys = await kb.listKeys();
  const names = new Map(keys.map((k) => [k.slot, k.name]));
  const modes = t.modeNames?.map((name, i) => ({ id: i + 1, name }));
  const ctx = kb._kaCtx(t.conditions ?? null, modes ?? null, keys);
  const maps = t.records.map(({ slot, record }) => {
    const key = names.get(slot) ?? null;
    return { slot, key, record, map: fromRecord(record, key ?? undefined, ctx) };
  });
  return { maps, ...(t.conditions && { conditions: t.conditions, modeNames: t.modeNames }) };
}

// every map on the keyboard (caps checked by the caller or by keyActionRecords)
async function readMaps(kb) {
  return (await readTable(kb)).maps;
}

const refsOf = (record) => P.decodeKaRecord(record).rules.map((x) => x.cond).filter(Boolean);
// true when the table needs key action engine 2 (conditions, modes, mouse keys)
function needsEngine2(table) {
  return (table.modeNames ?? []).some(Boolean) || (table.maps ?? []).some((m) => P.decodeKaRecord(m.record).rules
    .some((x) => x.cond || x.trigger === P.KA.ARG || x.output === M.OUT.MODE || x.output === M.OUT.MOUSE_KEYS));
}

// conditions: 15 entries the firmware takes; modeNames: 3 names of at most 16 bytes
function checkExtras(t, bad) {
  if (t.conditions !== undefined) {
    if (!Array.isArray(t.conditions) || t.conditions.length !== P.KA.CONDS) bad(`key action conditions: ${P.KA.CONDS} entries`);
    t.conditions.forEach((e, i) => { const why = M.entryProblem(e); if (why) bad(`key action condition ${i + 1}: ${why}`); });
  }
  if (t.modeNames !== undefined) {
    if (!Array.isArray(t.modeNames) || t.modeNames.length !== P.KA.MODES) bad(`mode names: ${P.KA.MODES} names`);
    t.modeNames.forEach((n, i) => {
      if (typeof n !== 'string') bad(`mode name ${i + 1}: not a string`);
      try { P.encodeModeName(n); } catch (e) { bad(`mode name ${i + 1}: ${e.message}`); }
    });
    const named = t.modeNames.filter(Boolean).map((n) => n.toLowerCase());
    if (new Set(named).size !== named.length) bad('mode names: two modes share a name');
  }
}

// Throws (through bad) unless every entry is a map the normal set path would write: the
// record decodes, passes parseSpec and encodes back to the same bytes.
function checkMaps(maps, bad, conditions) {
  if (!Array.isArray(maps)) bad('key action maps: maps is a list');
  const ctx = { conds: conditions };
  const raw = { slotOf: (k) => k, modeOf: (m) => m };
  const condIndex = (entry) => 1 + conditions.findIndex((e) => e.join() === entry.join());
  const seen = new Set();
  maps.forEach((m, i) => {
    const where = `key action map ${i}`;
    if (!m || typeof m !== 'object' || Array.isArray(m)) bad(`${where}: not an object`);
    if (!Number.isInteger(m.slot) || m.slot < 0 || m.slot >= P.SLOTS) bad(`${where}: slot is 0..${P.SLOTS - 1}`);
    if (seen.has(m.slot)) bad(`${where}: slot ${m.slot} twice`);
    seen.add(m.slot);
    if (!isBytes(m.record, P.KA.RECORD)) bad(`${where}: record is ${P.KA.RECORD} bytes`);
    if (m.record[0] !== m.slot) bad(`${where}: the record is for slot ${m.record[0]}, not ${m.slot}`);
    if (!m.record[1]) bad(`${where}: no rules`);
    const missing = refsOf(m.record).find((n) => n > P.KA.CONDS || !conditions || M.isFree(conditions[n - 1]));
    if (missing !== undefined) bad(`${where}: a rule uses condition entry ${missing}, which is not in the file`);
    let again;
    try { again = toRecord(parseSpec(fromRecord(m.record, undefined, ctx), { ...raw, self: m.slot }), m.slot, condIndex); } catch (e) { bad(`${where}: ${e.message}`); }
    if (again.join() !== m.record.join()) bad(`${where}: the record is not one this driver writes`);
  });
}

// Writes maps as raw records. replace: maps not in the list are removed first (frees table
// entries) and records already on the keyboard are skipped. keepGoing: a refused key goes to
// failed instead of stopping. onStep(text) reports progress.
async function writeMaps(kb, maps, { replace = false, keepGoing = false, onStep = () => {} } = {}) {
  const out = { written: [], removed: [], failed: [] };
  const cur = replace ? new Map((await kb.keyActionRecords()).map((r) => [r.slot, r.record])) : new Map();
  const want = new Set(maps.map((m) => m.slot));
  const one = async (m, record, list) => {
    try {
      await kb._kaSetRecord(m.slot, record);
      list.push(m.slot);
    } catch (e) {
      if (!keepGoing) throw Object.assign(e, { keyMaps: out });   // what was already written
      out.failed.push({ slot: m.slot, key: m.key ?? null, error: e.message });
    }
  };
  for (const slot of cur.keys()) {
    if (want.has(slot)) continue;
    onStep(`removing the key map of slot ${slot}`);
    await one({ slot }, P.encodeKaRecord({ slot }), out.removed);
  }
  for (const m of maps) {
    if (cur.get(m.slot)?.join() === m.record.join()) continue;
    onStep(`key map of ${label(m)}`);
    await one(m, m.record, out.written);
  }
  return out;
}

// Writes a whole table: mode names, conditions (the used ones), records (writeMaps), then clears
// conditions no record on the board uses (and, when the table lists conditions, that it has unused).
// -> writeMaps' result plus { conditions, modeNames } (entries / names written). Engine 1: maps only.
async function writeTable(kb, table, opts = {}) {
  const { onStep = () => {} } = opts;
  const v2 = (await kb._kaInfo()).engine >= 2;
  let names = 0, conds = 0;
  const cur = v2 ? await kb._kaConds() : null;
  if (v2 && table.modeNames) {
    const now = await kb._kaModes();
    for (let id = 1; id <= P.KA.MODES; id++) {
      if (now[id - 1].name === table.modeNames[id - 1]) continue;
      onStep(`name of mode ${id}`);
      await kb._kaSetModeName(id, table.modeNames[id - 1]);
      names++;
    }
  }
  if (v2 && table.conditions) {
    for (let n = 1; n <= P.KA.CONDS; n++) {
      const e = table.conditions[n - 1];
      if (M.isFree(e) || e.join() === cur[n - 1].join()) continue;
      onStep(`condition ${n}`);
      await kb._kaSetCond(n, e);
      cur[n - 1] = e;
      conds++;
    }
  }
  const out = await writeMaps(kb, table.maps, opts);
  if (v2) {
    const used = new Set((await kb.keyActionRecords()).flatMap((r) => refsOf(r.record)));
    for (let n = 1; n <= P.KA.CONDS; n++) {
      if (M.isFree(cur[n - 1]) || used.has(n) || (table.conditions && !M.isFree(table.conditions[n - 1]))) continue;
      await kb._kaSetCond(n, P.KA_COND_FREE);
      conds++;
    }
  }
  return { ...out, conditions: conds, modeNames: names };
}

// conditions / names that differ from the board's: [{ slot: null, key, why }]
function compareExtras(table, back) {
  const out = [];
  if (table.conditions && back.conditions) {
    table.conditions.forEach((e, i) => {
      if (!M.isFree(e) && e.join() !== back.conditions[i].join()) out.push({ slot: null, key: `condition ${i + 1}`, why: 'reads back different' });
    });
  }
  if (table.modeNames && back.modeNames) {
    table.modeNames.forEach((n, i) => { if (n !== back.modeNames[i]) out.push({ slot: null, key: `mode ${i + 1} name`, why: 'reads back different' }); });
  }
  return out;
}

// maps that are not on the keyboard byte for byte: [{ slot, key, why }]
function compareMaps(maps, back) {
  const got = new Map(back.map((r) => [r.slot, r.record]));
  return maps.flatMap((m) => {
    const r = got.get(m.slot);
    if (!r) return [{ slot: m.slot, key: m.key ?? null, why: 'missing after the write' }];
    return r.join() === m.record.join() ? [] : [{ slot: m.slot, key: m.key ?? null, why: 'reads back different' }];
  });
}

// The flasher's restore: write every kept map (with its conditions and mode names), read the
// table back and compare. kept: the maps list or { maps, conditions?, modeNames? }.
// { restored, problems: [{ slot, key, why }] }; a refused key does not stop the others.
async function restoreMaps(kb, kept) {
  const table = Array.isArray(kept) ? { maps: kept } : kept;
  const { maps } = table;
  if (needsEngine2(table) && (await kb._kaInfo()).engine < 2) {
    return { restored: 0, problems: [{ slot: null, key: 'key maps', why: 'the maps use conditions, modes or mouse keys, which the new firmware does not have' }] };
  }
  const { failed } = await writeTable(kb, table, { keepGoing: true });
  const back = await kb.keyActionTable();
  const bad = new Set(failed.map((f) => f.slot));
  const problems = [...failed.map((f) => ({ slot: f.slot, key: f.key, why: f.error })),
    ...compareMaps(maps, back.records).filter((p) => !bad.has(p.slot))];
  const extras = compareExtras(table, back);
  return { restored: maps.length - problems.length, problems: [...problems, ...extras] };
}

module.exports = { hasKeyActions, readTable, readMaps, checkMaps, checkExtras, needsEngine2, writeTable, writeMaps, compareMaps,
  compareExtras, restoreMaps, plural, label };
