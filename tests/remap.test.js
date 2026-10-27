// Remap presets (web/remap-presets.js) and the batch remap route (src/web/remap-routes.js).
const test = require('node:test');
const assert = require('node:assert');
const { PRESETS } = require('../web/remap-presets');
const { remapRoutes, layerOf } = require('../src/web/remap-routes');
const { parseKey, slotName } = require('../src/keys');
const { httpError, intIn, keyValue } = require('../src/web/validate');

const sorted = (a) => [...a].sort();

test('every preset key and value is a name the driver takes', () => {
  for (const [id, p] of Object.entries(PRESETS)) {
    for (const [from, to] of Object.entries(p.keys ?? {})) {
      assert.doesNotThrow(() => parseKey(from), `${id}: key ${from}`);
      assert.doesNotThrow(() => parseKey(to), `${id}: value ${to}`);
    }
  }
});

test('layouts only reshuffle: no key lost, none doubled', () => {
  for (const id of ['dvorak', 'colemak', 'workman', 'abc']) {
    const k = PRESETS[id].keys;
    assert.deepStrictEqual(sorted(Object.values(k)), sorted(Object.keys(k)), `${id} is a permutation`);
  }
  assert.strictEqual(PRESETS.dvorak.keys.S, 'O');
  assert.strictEqual(PRESETS.colemak.keys.N, 'K');
  assert.strictEqual(PRESETS.workman.keys.D, 'H');
  assert.deepStrictEqual(sorted(Object.values(PRESETS.abc.keys).filter((v) => /^[A-Z]$/.test(v))), [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']);
});

test('Function fills Fn layer 1 and leaves the Fn layer pickers alone', () => {
  const f = PRESETS.function;
  assert.strictEqual(f.layer, 'fn');
  assert.strictEqual(f.keys['1'], 'F1');
  assert.strictEqual(f.keys['='], 'F12');
  for (const k of ['Home', 'Del', 'PgUp', 'PgDn']) assert.ok(!(k in f.keys), `${k} stays for the firmware`);
});

test('layer names as POST /api/remap takes them', () => {
  assert.deepStrictEqual(layerOf(undefined), { kind: 'base' });
  assert.deepStrictEqual(layerOf('fn'), { kind: 'fn' });
  assert.deepStrictEqual(layerOf('fn3'), { kind: 'fnN', n: 3 });
  assert.deepStrictEqual(layerOf('l2'), { kind: 'user', n: 2 });
  assert.strictEqual(layerOf('fn5'), null);
  assert.strictEqual(layerOf('l4'), null);
});

function fake({ custom = true, fnLayers = true } = {}) {
  const log = [];
  return {
    log,
    info: { custom },
    async getCaps() { return { features: fnLayers ? ['fnLayers'] : [] }; },
    async setKey(slot, v, { layer }) { log.push(`${layer} ${slot}`); return v; },
    async setFnLayerKey(n, slot, v) { log.push(`fn${n} ${slot}`); return v; },
    async setLayerKey(n, slot, v) { log.push(`l${n} ${slot}`); return v; },
  };
}
const routesFor = (k) => remapRoutes({ keyboard: async () => k, state: async () => ({ ok: 1 }), httpError, intIn, keyValue, slotName })['POST /api/remap/batch'];

test('batch: writes every key on the layer and names what each now sends', async () => {
  const k = fake();
  const r = await routesFor(k)({ layer: 'fn2', keys: [{ slot: 8, value: 'F1' }, { slot: 14, value: 'Mute' }] });
  assert.deepStrictEqual(k.log, ['fn2 8', 'fn2 14']);
  assert.deepStrictEqual(r.written.map((w) => w.name), ['F1', 'Mute']);
  assert.deepStrictEqual(r.state, { ok: 1 });
  await routesFor(k)({ keys: [{ slot: 9, value: 'B' }] });
  assert.strictEqual(k.log.at(-1), 'base 9');
});

test('batch: one bad entry, a repeated slot or a missing feature writes nothing', async () => {
  for (const [body, re] of [
    [{ keys: [{ slot: 8, value: 'Q' }, { slot: 9, value: 'NoSuchKey' }] }, /keys\[1\]/],
    [{ keys: [{ slot: 8, value: 'Q' }, { slot: 8, value: 'W' }] }, /twice/],
    [{ keys: [{ slot: 200, value: 'Q' }] }, /slot/],
    [{ keys: [] }, /1\.\.128/],
    [{ layer: 'x', keys: [{ slot: 8, value: 'Q' }] }, /layer/],
  ]) {
    const k = fake();
    await assert.rejects(routesFor(k)(body), (e) => e.status === 400 && re.test(e.message));
    assert.deepStrictEqual(k.log, [], JSON.stringify(body));
  }
  const old = fake({ fnLayers: false });
  await assert.rejects(routesFor(old)({ layer: 'fn3', keys: [{ slot: 8, value: 'Q' }] }), /newer open firmware/);
  assert.deepStrictEqual(old.log, []);
});
