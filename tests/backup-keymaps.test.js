// Profile export / import with the key action map table (global in the firmware): exported as
// raw records, checked before the first write, and the board's table replaced by the file's.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fakeKeyboard } = require('./fixtures/ka-fake');

const empty = () => Array.from({ length: 128 }, () => [0, 0, 0, 0]);
const LIGHT = { mode: 1, speed: 2, brightness: 3, option: 0, rainbow: false, presetColour: null, r: 1, g: 2, b: 3 };
const OPTIONS = { os: 'win', fnIndex: 0, antiMistouch: false, rtStability: 0, wasdSwap: false };

// a fake open-firmware keyboard with an empty profile; the profile writes are no-ops
function board(opts) {
  const f = fakeKeyboard(opts);
  Object.assign(f.kb, {
    async getProfile() { return 0; },
    async readColumn() { return new Array(128).fill(0); },
    async readDksAll() { return empty(); },
    async getKeymap() { return empty(); },
    async getFnKeymap() { return empty(); },
    async hasDksLevels() { return false; },
    async getLighting() { return { ...LIGHT }; },
    async getReportRate() { return 1000; },
    async getOptions() { return { ...OPTIONS }; },
    async setKey() {}, async setLighting() {}, async setReportRate() {}, async setOptions() {},
  });
  return f;
}
const MAPS = [
  { key: 'W', rules: [{ when: 'press', do: { axis: 'LY-', percent: 40 } }, { when: 'down', at: 2.5, do: { axis: 'LY-', percent: 100 } }] },
  { slot: 9, rules: [{ when: 'hold', ms: 3000, do: { gamepad: 'LB' } }] },
  { key: 'D', alsoType: true, rules: [{ when: 'tap', ms: 200, do: { glide: [-200, 40], ms: 1000 } }] },
];
async function withMaps(maps, opts) {
  const f = board(opts);
  for (const m of maps) await f.kb.setKeyActions(m);
  f.sent.length = 0;
  return f;
}
const sorted = (table) => [...table].sort((a, b) => a[0] - b[0]);
const kaSent = (f, op) => f.sent.filter((p) => Array.isArray(p) && p[0] === 0xee && (op === undefined || p[1] === op));
const file = (data) => JSON.parse(JSON.stringify(data));   // as written to disk and read back
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'max68he-backup-ka-'));

test('export: the whole table as raw records plus the readable form, marked global', async () => {
  const a = await withMaps(MAPS);
  const d = await a.kb.exportProfile();
  assert.strictEqual(d.version, 1);
  assert.strictEqual(d.keyActions.scope, 'global');
  assert.match(d.keyActions.note, /one table for all profiles/);
  assert.deepStrictEqual(d.keyActions.maps.map((m) => [m.slot, m.record]), sorted(a.table));
  assert.deepStrictEqual(d.keyActions.maps.map((m) => m.key), ['A', 'W', 'D']);
  assert.deepStrictEqual(d.keyActions.maps[1].map.summary, ['Light press: left stick up 40 %.', 'Past 2.50 mm: left stick up 100 %.']);
  assert.ok(!('keyActions' in await board({ caps2: 0x7fff }).kb.exportProfile()), 'no section without keyActions');
  assert.ok(!('keyActions' in await board({ custom: false }).kb.exportProfile()), 'none on stock');
  assert.deepStrictEqual((await board().kb.exportProfile()).keyActions.maps, [], 'an empty table is exported as empty');
});

test('round trip: a board with other maps ends with exactly the file\'s; the copy from before has its old maps', async () => {
  const a = await withMaps(MAPS);
  const data = file(await a.kb.exportProfile());
  // W differs, E is not in the file, A and D are missing
  const b = await withMaps([{ key: 'W', rules: [{ when: 'press', do: { gamepad: 'A' } }] }, { key: 'E', rules: [{ when: 'press', do: { wheel: 1 } }] }]);
  const old = sorted(b.table);
  const dir = tmp();
  const r = await b.kb.importProfile(data, () => {}, { backupDir: dir });
  assert.deepStrictEqual(sorted(b.table), sorted(a.table));
  assert.deepStrictEqual(r.keyMaps, { written: 3, removed: 1 });
  const before = JSON.parse(fs.readFileSync(r.backup, 'utf8'));
  assert.deepStrictEqual(before.keyActions.maps.map((m) => [m.slot, m.record]), old, 'the pre-import copy holds the maps it replaced');
  b.sent.length = 0;
  const again = await b.kb.importProfile(data, () => {}, { backupDir: null });
  assert.deepStrictEqual(again.keyMaps, { written: 0, removed: 0 });
  assert.strictEqual(kaSent(b, 2).length, 0, 'the same maps are not rewritten');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a file with an empty table clears the board\'s maps', async () => {
  const data = file(await board().kb.exportProfile());
  const b = await withMaps(MAPS);
  const r = await b.kb.importProfile(data, () => {}, { backupDir: null });
  assert.strictEqual(b.table.size, 0);
  assert.deepStrictEqual(r.keyMaps, { written: 0, removed: 3 });
});

test('firmware without keyActions: maps not written, a note says so', async () => {
  const data = file(await (await withMaps(MAPS)).kb.exportProfile());
  for (const opts of [{ caps2: 0x7fff }, { custom: false }]) {
    const b = board(opts);
    const r = await b.kb.importProfile(data, () => {}, { backupDir: null });
    assert.deepStrictEqual(kaSent(b), [], 'no 0xEE at all');
    assert.deepStrictEqual(r.notes, ['The file has key action maps, but this firmware has none; they were not written.']);
    assert.ok(!r.keyMaps);
  }
});

test('an older export without the section imports and leaves the maps alone', async () => {
  const data = file(await (await withMaps(MAPS)).kb.exportProfile());
  delete data.keyActions;
  const b = await withMaps([{ key: 'E', rules: [{ when: 'press', do: { wheel: 1 } }] }]);
  const old = sorted(b.table);
  const r = await b.kb.importProfile(data, () => {}, { backupDir: null });
  assert.deepStrictEqual(sorted(b.table), old);
  assert.deepStrictEqual(kaSent(b, 2), []);
  assert.ok(!r.keyMaps && !r.notes);
});

test('a bad key action section is refused before anything is read or written', async () => {
  const good = file(await (await withMaps(MAPS)).kb.exportProfile());
  const rec = (i) => good.keyActions.maps[i].record;
  const cases = [
    [(d) => { d.keyActions = []; }, /key action maps$/],
    [(d) => { d.keyActions.scope = 'profile'; }, /key action maps$/],
    [(d) => { d.keyActions.maps = {}; }, /maps is a list/],
    [(d) => { d.keyActions.maps[0] = null; }, /key action map 0: not an object/],
    [(d) => { d.keyActions.maps[1].slot = 200; }, /key action map 1: slot is 0..127/],
    [(d) => { d.keyActions.maps[2].slot = 9; d.keyActions.maps[2].record = rec(0); }, /key action map 2: slot 9 twice/],
    [(d) => { d.keyActions.maps[0].record = rec(0).slice(0, 55); }, /key action map 0: record is 56 bytes/],
    [(d) => { d.keyActions.maps[0].record = rec(1); }, /key action map 0: the record is for slot 14, not 9/],
    [(d) => { d.keyActions.maps[0].record[1] = 0; }, /key action map 0: no rules/],
    [(d) => { d.keyActions.maps[0].record[8] = 9; }, /key action map 0: rules\[0\]: when is/],
    [(d) => { d.keyActions.maps[1].record[14] = 0; }, /key action map 1: rules\[0\]\.do: percent is a whole number/],
    [(d) => { d.keyActions.maps[0].record[40] = 7; }, /key action map 0: the record is not one this driver writes/],
  ];
  for (const [spoil, msg] of cases) {
    const d = file(good);
    spoil(d);
    const b = await withMaps([{ key: 'E', rules: [{ when: 'press', do: { wheel: 1 } }] }]);
    await assert.rejects(b.kb.importProfile(d, () => {}, { backupDir: null }), (e) => /^not a valid backup/.test(e.message) && msg.test(e.message), String(msg));
    assert.deepStrictEqual(b.sent, [], `${msg}: nothing sent`);
  }
});

test('a refused map part way: the import error says how many map changes were written', async () => {
  const data = file(await (await withMaps(MAPS)).kb.exportProfile());
  const b = board({ set: (slot) => (slot === 21 ? 2 : undefined) });
  const e = await b.kb.importProfile(data, () => {}, { backupDir: null }).catch((x) => x);
  assert.match(e.message, /^import stopped: keyboard refused the key map: the key action table is full\. Already written: .*options, 2 key action map changes\.$/);
});
