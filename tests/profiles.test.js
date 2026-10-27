// My profiles: the store (names, library, rules) and the web routes with a fake keyboard.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { store } = require('../src/profiles');
const { profileRoutes } = require('../src/web/profile-routes');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'max68he-profiles-'));
const exp = (profile, tag) => ({ format: 'max68he-profile', version: 1, profile, tag });

test('onboard names and colours: defaults, set, checked, swapped', () => {
  const s = store(tmp());
  assert.deepStrictEqual(s.meta().onboard.map((o) => o.name), ['Profile 1', 'Profile 2', 'Profile 3', 'Profile 4']);
  s.setOnboard(1, { name: '  CS2  ', color: '#00FF00' });
  assert.deepStrictEqual(s.meta().onboard[1], { name: 'CS2', color: '#00ff00' });
  for (const bad of [{ name: '' }, { name: 'x'.repeat(41) }, { color: 'red' }]) assert.throws(() => s.setOnboard(0, bad), (e) => e.status === 400);
  assert.throws(() => s.setOnboard(4, { name: 'x' }), (e) => e.status === 400);
  s.swapOnboard(0, 1);
  assert.strictEqual(s.meta().onboard[0].name, 'CS2');
  assert.strictEqual(s.meta().onboard[1].name, 'Profile 1');
});

test('library: add, list newest first without data, get, rename, remove; ids are checked', () => {
  const s = store(tmp());
  const a = s.add(exp(0, 'a'), { name: 'Typing' });
  const b = s.add(exp(2, 'b'), { name: 'Rapid', color: '#123456', from: 2 });
  const list = s.list();
  assert.strictEqual(list.length, 2);
  assert.ok(list.every((e) => !('data' in e)));
  assert.strictEqual(s.get(b.id).data.tag, 'b');
  s.update(a.id, { name: 'Writing' });
  assert.ok(s.list().some((e) => e.name === 'Writing'));
  s.remove(a.id);
  assert.deepStrictEqual(s.list().map((e) => e.id), [b.id]);
  for (const id of ['../../etc', 'nothexnothex', a.id]) assert.throws(() => s.get(id), (e) => e.status === 400);
  assert.throws(() => s.add({ format: 'other' }), (e) => e.status === 400);
});

test('rules: app names without .exe, any case; default profile; duplicates refused', () => {
  const s = store(tmp());
  s.setRules({ rules: [{ app: 'CS2.exe', profile: 1 }, { app: 'notepad', profile: 3 }], defaultProfile: 0 });
  assert.strictEqual(s.profileFor('cs2'), 1);
  assert.strictEqual(s.profileFor('NOTEPAD.EXE'), 3);
  assert.strictEqual(s.profileFor('brave'), 0, 'no rule: the default');
  s.setRules({ defaultProfile: null });
  assert.strictEqual(s.profileFor('brave'), undefined, 'no rule, no default: stay');
  assert.throws(() => s.setRules({ rules: [{ app: 'a', profile: 1 }, { app: 'A.exe', profile: 2 }] }), /two rules/);
  assert.throws(() => s.setRules({ rules: [{ app: 'a', profile: 9 }] }), (e) => e.status === 400);
});

function fakeKeyboard() {
  const slots = [exp(0, 'zero'), exp(1, 'one'), exp(2, 'two'), exp(3, 'three')];
  const k = {
    active: 0, log: [],
    async getProfile() { return this.active; },
    async setProfile(p) { this.log.push(`profile ${p}`); this.active = p; },
    async exportProfile() { return { ...slots[this.active], profile: this.active }; },
    async importProfile(d) { this.log.push(`import ${d.tag} into ${this.active}`); slots[this.active] = { ...d }; return { keyWrites: 1 }; },
    slots,
  };
  return k;
}

function routes(k, s = store(tmp()), watch = () => () => {}) {
  const conn = { run: (fn) => fn() };
  return profileRoutes({ keyboard: async () => k, conn, drop: () => {}, isDeviceError: () => false, isFlashing: () => false,
    state: async () => ({ ok: true }), httpError: (status, m) => Object.assign(new Error(m), { status }), store: s, watch });
}

test('save the active profile, load it into another slot (named after it)', async () => {
  const k = fakeKeyboard();
  const r = routes(k);
  const { entry } = await r.routes['POST /api/profiles/save']({ name: 'Mine' });
  assert.strictEqual(entry.from, 0);
  await r.routes['POST /api/profiles/load']({ id: entry.id, profile: 2 });
  assert.deepStrictEqual(k.log, ['profile 2', 'import zero into 2']);
  assert.strictEqual(k.slots[2].tag, 'zero');
  assert.strictEqual((await r.routes['GET /api/profiles']()).onboard[2].name, 'Mine');
});

test('swap: both slots exchange contents and names, the active slot stays active', async () => {
  const k = fakeKeyboard();
  k.active = 3;
  const s = store(tmp());
  s.setOnboard(0, { name: 'Zero' });
  const r = routes(k, s);
  await r.routes['POST /api/profiles/swap']({ a: 0, b: 1 });
  assert.strictEqual(k.slots[0].tag, 'one');
  assert.strictEqual(k.slots[1].tag, 'zero');
  assert.strictEqual(k.active, 3);
  assert.strictEqual(s.meta().onboard[1].name, 'Zero');
  await assert.rejects(r.routes['POST /api/profiles/swap']({ a: 1, b: 1 }), (e) => e.status === 400);
});

test('app-linked switching: the watcher runs only while on, and an app switches the profile', async () => {
  const k = fakeKeyboard();
  let onApp = null, stopped = 0;
  const watch = (cb) => { onApp = cb; return () => { stopped++; }; };
  const r = routes(k, store(tmp()), watch);
  r.sync();
  assert.strictEqual(onApp, null, 'off by default');
  const m = await r.routes['POST /api/profiles/rules']({ autoSwitch: true, rules: [{ app: 'cs2', profile: 2 }] });
  assert.strictEqual(m.watching, true);
  onApp('cs2');
  await new Promise((res) => setTimeout(res, 10));
  assert.strictEqual(k.active, 2);
  assert.strictEqual((await r.routes['GET /api/profiles']()).lastAuto.app, 'cs2');
  onApp('notepad');                       // no rule, no default: stays
  await new Promise((res) => setTimeout(res, 10));
  assert.strictEqual(k.active, 2);
  await r.routes['POST /api/profiles/rules']({ autoSwitch: false });
  assert.strictEqual(stopped, 1);
});
