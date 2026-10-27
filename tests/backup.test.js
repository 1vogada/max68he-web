// Profile import: every value checked before the first write, a copy of the
// profile saved first, and a failure part way says what was written.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Keyboard } = require('../src/keyboard');

const empty = () => Array.from({ length: 128 }, () => [0, 0, 0, 0]);

// One key (Q, slot 8) with 2 mm actuation; slot 100 is empty and holds junk.
function backupData() {
  const hall = {};
  for (const c of [0, 1, 2, 3, 4, 5, 6, 7, 9]) hall[c] = new Array(128).fill(0);
  Object.assign(hall, { dks: empty() });
  hall[0][8] = 400; hall[1][8] = 400; hall[2][8] = 40; hall[3][8] = 40; hall[7][8] = 0x80; hall[9][8] = 0xff;
  hall[0][100] = 0xffff;
  const keymap = [empty(), empty(), empty(), empty()];
  keymap[0][8] = [0, 0, 0x14, 0];
  return {
    format: 'max68he-profile', version: 1, board: { id: 2755 }, profile: 0, hall, keymap, fn: empty(),
    lighting: { mode: 1, speed: 2, brightness: 3, option: 0, rainbow: false, presetColour: null, r: 1, g: 2, b: 3 },
    pollingRateHz: 1000, options: { os: 'win', fnIndex: 0, antiMistouch: false, rtStability: 0, wasdSwap: false },
  };
}

// A keyboard whose reads return an empty profile and whose writes are logged.
function board(log, overrides = {}) {
  const kb = new Keyboard({ async flash() { log.push('switches'); } });
  kb.info = { boardId: 2755, custom: false, unitMm: 0.005 };
  Object.assign(kb, {
    async getProfile() { return 0; },
    async exportProfile() { log.push('export'); return { ...backupData(), exportedAt: '2026-10-22T10:00:00.000Z' }; },
    async getKeymap() { return empty(); },
    async getFnKeymap() { return empty(); },
    async readDksAll() { return empty(); },
    async setKey() { log.push('key'); },
    async hasDksLevels() { return false; },
    async setLighting() { log.push('lighting'); },
    async setReportRate() { log.push('polling'); },
    async setOptions() { log.push('options'); },
  }, overrides);
  return kb;
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'max68he-backup-'));

test('a valid backup: current profile saved first, then written', async () => {
  const log = [];
  const dir = tmp();
  const r = await board(log).importProfile(backupData(), () => {}, { backupDir: dir });
  assert.deepStrictEqual(log, ['export', 'key', 'switches', 'lighting', 'polling', 'options']);
  assert.strictEqual(r.keyWrites, 1);
  assert.strictEqual(JSON.parse(fs.readFileSync(r.backup, 'utf8')).format, 'max68he-profile');
  assert.strictEqual(path.dirname(r.backup), dir);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('bad values are refused before anything is read or written', async () => {
  const cases = [
    [(d) => { d.hall[0][8] = 1000; }, /slot 8: actuation 5 mm is outside/],
    [(d) => { d.hall[1][8] = 0; }, /slot 8: release 0 mm/],
    [(d) => { d.hall[0][8] = 700; }, /slot 8: actuation 3.5 mm is outside 0.1..3.4/],
    [(d) => { d.hall[6][8] = 700; }, /deadZone 3.5 mm/],
    [(d) => { d.hall[7][8] = 0x80 | 9; }, /unknown key kind 9/],
    [(d) => { d.hall[7][8] = 0x40; }, /continuous rapid trigger needs the open firmware/],
    [(d) => { d.hall[7][8] = 7; d.hall[9][8] = 8; }, /snap partner 8/],
    [(d) => { d.hall[7][8] = 3; }, /mod-tap hold time/],
    [(d) => { d.keymap[2][5] = [1, 2, 3, 4.5]; }, /key layer/],
    [(d) => { d.keymap[1][8] = [9, 0, 16, 0]; }, /layer 1 slot 8: macro index is 0..15/],
    [(d) => { d.fn[3] = [11, 0, 64, 0]; }, /Fn layer slot 3: text slot is 0..63/],
    [(d) => { d.lighting.brightness = 9; }, /lighting: brightness/],
    [(d) => { d.lighting.mode = 0x4c; }, /needs the open firmware/],
    [(d) => { d.pollingRateHz = 3000; }, /polling rate 3000/],
    [(d) => { d.options.rtStability = 30; }, /options: rtStability/],
    [(d) => { d.options.wasdSwap = 'yes'; }, /options/],
    [(d) => { d.dksLevels = { abc: {} }; }, /DKS levels: slot abc/],
    [(d) => { d.dksLevels = { 200: {} }; }, /DKS levels: slot 200/],
    [(d) => { d.dksLevels = { 8: { keys: ['A'], levels: [{ depthMm: 9, actions: [] }] } }; }, /DKS levels of slot 8: level 1/],
    [(d) => { d.dksLevels = { 8: { keys: ['none'], levels: [{ depthMm: 1, actions: [] }] } }; }, /no bound key/],
  ];
  for (const [spoil, msg] of cases) {
    const log = [];
    const d = backupData();
    spoil(d);
    const kb = board(log, { async getProfile() { log.push('read'); return 0; } });
    await assert.rejects(kb.importProfile(d, () => {}, { backupDir: null }), (e) => /^not a valid backup/.test(e.message) && msg.test(e.message), String(msg));
    assert.deepStrictEqual(log, [], `${msg}: nothing touched`);
  }
});

test('a failure part way says what was written and where the copy is', async () => {
  const log = [];
  const dir = tmp();
  const kb = board(log, { async setLighting() { throw Object.assign(new Error('could not write'), { device: true }); } });
  const e = await kb.importProfile(backupData(), () => {}, { backupDir: dir }).catch((x) => x);
  assert.match(e.message, /^import stopped: could not write\. Already written: 1 key, switch settings\. The profile from before the import is in .*profile0-/);
  assert.deepStrictEqual(e.written, ['1 key', 'switch settings']);
  assert.ok(e.device, 'still a device error for the server');
  assert.ok(fs.existsSync(e.backup));
  fs.rmSync(dir, { recursive: true, force: true });
});
