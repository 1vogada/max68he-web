// The Blocks workspace kept on the PC (src/web/key-blocks-routes.js), on a file of its own.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { keyBlocksRoutes } = require('../src/web/key-blocks-routes');

const httpError = (status, message) => Object.assign(new Error(message), { status });
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'max68he-kb-')), 'config', 'key-blocks.json');

test('none saved -> null; PUT keeps it, GET gives it back; null forgets it', async () => {
  const r = keyBlocksRoutes({ httpError, file: tmp() });
  assert.deepStrictEqual(await r['GET /api/key-blocks'](), { workspace: null });
  const ws = { blocks: { languageVersion: 0, blocks: [{ type: 'kb_when_pressed', id: 'a', fields: { KEY: 'M' } }] } };
  await r['PUT /api/key-blocks']({ workspace: ws });
  assert.deepStrictEqual(await r['GET /api/key-blocks'](), { workspace: ws });
  await r['PUT /api/key-blocks']({ workspace: null });
  assert.deepStrictEqual(await r['GET /api/key-blocks'](), { workspace: null });
});

test('refused: not an object, an array, too big; a broken file reads as none', async () => {
  const file = tmp();
  const r = keyBlocksRoutes({ httpError, file });
  for (const workspace of ['x', 3, [1], undefined]) await assert.rejects(r['PUT /api/key-blocks']({ workspace }), (e) => e.status === 400);
  await assert.rejects(r['PUT /api/key-blocks']({ workspace: { big: 'x'.repeat(70000) } }), /too big/);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json');
  assert.deepStrictEqual(await r['GET /api/key-blocks'](), { workspace: null });
});
