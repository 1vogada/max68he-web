// Web UI preferences (src/ui-prefs.js) against a temporary config file.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const prefs = require('../src/ui-prefs');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'max68he-ui-')), 'config', 'ui.json');

test('no file: defaults, selection box only on the multi-key pages', () => {
  assert.deepStrictEqual(prefs.read(tmpFile()), { marqueeEverywhere: false, layers: false, fnLayers: 1 });
});

test('write merges, creates config/, and reads back', async () => {
  const file = tmpFile();
  assert.deepStrictEqual(prefs.write({ marqueeEverywhere: true }, file), { marqueeEverywhere: true, layers: false, fnLayers: 1 });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { marqueeEverywhere: true, layers: false, fnLayers: 1 });
  const r = prefs.routes(file);
  assert.deepStrictEqual(await r['GET /api/ui-prefs'](), { marqueeEverywhere: true, layers: false, fnLayers: 1 });
  assert.deepStrictEqual(await r['POST /api/ui-prefs']({ marqueeEverywhere: false }), { marqueeEverywhere: false, layers: false, fnLayers: 1 });
});

test('unknown keys and wrong types are refused with 400 and leave the file alone', () => {
  const file = tmpFile();
  prefs.write({ marqueeEverywhere: true }, file);
  for (const bad of [{ other: 1 }, { marqueeEverywhere: 'yes' }, { layers: 1 }, { layers: 'on' }, [], null]) {
    assert.throws(() => prefs.write(bad, file), (e) => e.status === 400);
  }
  assert.deepStrictEqual(prefs.read(file), { marqueeEverywhere: true, layers: false, fnLayers: 1 });
});

test('a broken or odd file falls back to the defaults', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json');
  assert.deepStrictEqual(prefs.read(file), { marqueeEverywhere: false, layers: false, fnLayers: 1 });
  fs.writeFileSync(file, JSON.stringify({ marqueeEverywhere: 1, layers: 'yes', junk: true }));
  assert.deepStrictEqual(prefs.read(file), { marqueeEverywhere: false, layers: false, fnLayers: 1 });
});

test('extra layers: off by default, switched on and off on its own, an old file keeps the other keys', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ marqueeEverywhere: true }));   // written before layers existed
  assert.deepStrictEqual(prefs.read(file), { marqueeEverywhere: true, layers: false, fnLayers: 1 });
  assert.deepStrictEqual(prefs.write({ layers: true, fnLayers: 1 }, file), { marqueeEverywhere: true, layers: true, fnLayers: 1 });
  assert.deepStrictEqual(prefs.write({ layers: false, fnLayers: 1 }, file), { marqueeEverywhere: true, layers: false, fnLayers: 1 });
});

test('Fn layers shown on Remap: 1 by default, a whole number 1..4', () => {
  const file = tmpFile();
  assert.strictEqual(prefs.write({ fnLayers: 3 }, file).fnLayers, 3);
  for (const bad of [0, 5, 2.5, '2', true]) assert.throws(() => prefs.write({ fnLayers: bad }, file), (e) => e.status === 400);
  assert.strictEqual(prefs.read(file).fnLayers, 3);
});
