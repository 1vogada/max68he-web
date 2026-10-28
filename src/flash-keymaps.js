// The flasher's key action map backup: a firmware update erases the flash sector the open
// firmware keeps its key action maps in (0x08027800, one table for all profiles), so the maps
// are read before the flash, kept in memory and in config/backups/keymaps-<time>.json, and
// written back once the keyboard is back. open() gives a keyboard (or null); it is closed here.
const fs = require('fs');
const path = require('path');
const { hasKeyActions, readTable, restoreMaps, plural, label } = require('./key-map-backup');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const close = (kb) => { try { kb?.close(); } catch { /* already gone */ } };

// -> { maps, table, file, keyMaps } to go on (table: { maps, conditions?, modeNames? }), or { stop } (nothing flashed). A keyboard that does not
// open (stock updater mode, unplugged) does not stop a flash: there is nothing to read.
async function keepKeyMaps(open, { backupDir, say }) {
  let kb;
  try {
    kb = await open();
    if (!kb) throw new Error('no keyboard');
  } catch (e) {
    say(`Key maps: could not open the keyboard to read them (${e.message}); flashing without a key map backup.`);
    return { maps: null, keyMaps: null };
  }
  try {
    let maps, table;
    try {
      if (!(await hasKeyActions(kb))) return { maps: null, keyMaps: null };   // stock or older open firmware
      table = await readTable(kb);
      ({ maps } = table);
    } catch (e) {
      return { stop: `Could not read the key action maps before flashing (${e.message}), so they could not be kept. Nothing was flashed; try again` };
    }
    const named = (table.modeNames ?? []).filter(Boolean);
    if (!maps.length && !named.length) {
      say('No key maps to keep.');
      return { maps, table, file: null, keyMaps: { kept: 0, restored: 0, file: null, error: null } };
    }
    const at = new Date().toISOString();
    const file = path.join(backupDir, `keymaps-${at.replace(/[:.]/g, '-')}.json`);
    try {
      fs.mkdirSync(backupDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ format: 'max68he-keymaps', version: table.conditions ? 2 : 1, savedAt: at,
        board: { id: kb.info.boardId, firmware: kb.info.firmware }, scope: 'global', maps,
        ...(table.conditions && { conditions: table.conditions, modeNames: table.modeNames }) }, null, 1));
    } catch (e) {
      return { stop: `Could not save the key action maps to ${file} (${e.message}). Nothing was flashed; try again` };
    }
    say(`Kept ${plural(maps.length, 'key map')} (${maps.map(label).join(', ')})${named.length ? ` and mode names (${named.join(', ')})` : ''} in memory and in ${file}.`);
    return { maps, table, file, keyMaps: { kept: maps.length, restored: 0, file, error: null } };
  } finally {
    close(kb);
  }
}

// Writes the kept maps (table: with conditions and mode names) back after a good flash and checks
// them; never throws. Fills keyMaps.
async function restoreKeyMaps(open, maps, keyMaps, { say, tries = 8, waitMs = 1500, table }) {
  const where = `The backup is in ${keyMaps.file}.`;
  const problem = (msg) => { keyMaps.error = msg; say(`Key maps: ${msg}. ${where}`); };
  let kb = null, why = 'not found';
  for (let i = 0; i < tries && !kb; i++) {   // the keyboard may still be re-enumerating
    if (i) await sleep(waitMs);
    try { kb = await open(); } catch (e) { why = e.message; }
  }
  if (!kb) return problem(`the keyboard could not be opened after the flash (${why}), so the ${plural(maps.length, 'map')} were not restored`);
  try {
    if (!(await hasKeyActions(kb))) return problem(`the new firmware has no key action maps, so the ${plural(maps.length, 'map')} were not restored`);
    const r = await restoreMaps(kb, table ?? maps);
    keyMaps.restored = r.restored;
    if (!r.problems.length) return say(`Restored ${plural(r.restored, 'key map')}.`);
    problem(`restored ${r.restored} of ${maps.length}; not restored: ${r.problems.map((p) => `${label(p)}: ${p.why}`).join('; ')}`);
  } catch (e) {
    problem(`restoring failed (${e.message}); restored ${keyMaps.restored} of ${maps.length}`);
  } finally {
    close(kb);
  }
}

module.exports = { keepKeyMaps, restoreKeyMaps };
