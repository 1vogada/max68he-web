// Key action maps (0xEE, caps 'keyActions') as a whole table: read, check, write back and
// compare. Used by the flasher (a firmware update erases the table's flash sector) and by
// profile export / import. The firmware keeps ONE table for all profiles.
// Entry: { slot, key, record: [56 bytes], map }. record is the source of truth; map (the
// key-actions.js JSON with its summary) is only there to read.
const P = require('./protocol');
const { parseSpec, toRecord, fromRecord } = require('./key-actions');

const isBytes = (a, len) => Array.isArray(a) && a.length === len && a.every((v) => Number.isInteger(v) && v >= 0 && v <= 255);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const label = (m) => (m.key ? `${m.key} (slot ${m.slot})` : `slot ${m.slot}`);

// false on stock firmware and open firmware without key action maps
async function hasKeyActions(kb) {
  if (!kb?.info?.custom) return false;
  return (await kb.getCaps()).features.includes('keyActions');
}

// every map on the keyboard (caps checked by the caller or by keyActionRecords)
async function readMaps(kb) {
  const recs = await kb.keyActionRecords();
  const names = new Map((await kb.listKeys()).map((k) => [k.slot, k.name]));
  return recs.map(({ slot, record }) => {
    const key = names.get(slot) ?? null;
    return { slot, key, record, map: fromRecord(record, key ?? undefined) };
  });
}

// Throws (through bad) unless every entry is a map the normal set path would write: the
// record decodes, passes parseSpec and encodes back to the same bytes.
function checkMaps(maps, bad) {
  if (!Array.isArray(maps)) bad('key action maps: maps is a list');
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
    let again;
    try { again = toRecord(parseSpec(fromRecord(m.record)), m.slot); } catch (e) { bad(`${where}: ${e.message}`); }
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

// maps that are not on the keyboard byte for byte: [{ slot, key, why }]
function compareMaps(maps, back) {
  const got = new Map(back.map((r) => [r.slot, r.record]));
  return maps.flatMap((m) => {
    const r = got.get(m.slot);
    if (!r) return [{ slot: m.slot, key: m.key ?? null, why: 'missing after the write' }];
    return r.join() === m.record.join() ? [] : [{ slot: m.slot, key: m.key ?? null, why: 'reads back different' }];
  });
}

// The flasher's restore: write every kept map, read the table back and compare.
// { restored, problems: [{ slot, key, why }] }; a refused key does not stop the others.
async function restoreMaps(kb, maps) {
  const { failed } = await writeMaps(kb, maps, { keepGoing: true });
  const back = await kb.keyActionRecords();
  const bad = new Set(failed.map((f) => f.slot));
  const problems = [...failed.map((f) => ({ slot: f.slot, key: f.key, why: f.error })),
    ...compareMaps(maps, back).filter((p) => !bad.has(p.slot))];
  return { restored: maps.length - problems.length, problems };
}

module.exports = { hasKeyActions, readMaps, checkMaps, writeMaps, compareMaps, restoreMaps, plural, label };
