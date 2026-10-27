// Web server against a stubbed keyboard: bad input gets an answer, never a crash.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { Keyboard } = require('../src/keyboard');

// A keyboard that answers the few calls these tests make.
const fake = {
  info: { boardId: 2755, custom: false, unitMm: 0.005 },
  t: { busy: Promise.resolve() },
  async getProfile() { return 0; },
  close() {},
};
const realOpen = Keyboard.open;
const opened = [];
Keyboard.open = async ({ key } = {}) => {
  opened.push(key);
  return { ...fake, model: require('../src/models').byKey(key ?? 'max68he') };
};
const { server } = require('../src/web/server');

let port;
test.before(() => new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); })));
test.after(() => { Keyboard.open = realOpen; server.close(); });

function request(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test('malformed URLs get 400 and the server keeps running', async () => {
  for (const p of ['/%', '/%E0%A4%A', '/plugins/games/%zz', '/%%%']) {
    assert.strictEqual((await request('GET', p)).status, 400, p);
  }
  assert.strictEqual((await request('GET', '/')).status, 200);
});

test('path traversal, wrong host, bad JSON and bad fields are refused', async () => {
  assert.notStrictEqual((await request('GET', '/..%2f..%2fpackage.json')).status, 200);
  assert.strictEqual((await request('GET', '/', undefined, { host: 'evil.example' })).status, 421);
  assert.strictEqual((await request('POST', '/api/ping', '{not json')).status, 400);
  assert.strictEqual((await request('POST', '/api/remap', JSON.stringify({ slot: 999, value: 'A' }))).status, 400);
  assert.strictEqual((await request('POST', '/api/lighting', JSON.stringify({ mode: 'x' }))).status, 400);
  const macro20 = await request('POST', '/api/remap', JSON.stringify({ slot: 8, value: 'raw:09001400' }));
  assert.deepStrictEqual([macro20.status, JSON.parse(macro20.body).error], [400, 'macro index is 0..15']);
  const tooDeep = await request('POST', '/api/switches', JSON.stringify({ actuation: 3.5 }));
  assert.deepStrictEqual([tooDeep.status, JSON.parse(tooDeep.body).error], [400, 'actuation must be 0.1..3.4 mm']);
  assert.strictEqual((await request('POST', '/api/switches', JSON.stringify({ release: 4 }))).status, 400);
  assert.strictEqual((await request('POST', '/api/nope')).status, 404);
  const noConfirm = await request('POST', '/api/fw-reset', JSON.stringify({}));
  assert.deepStrictEqual([noConfirm.status, JSON.parse(noConfirm.body).error], [400, 'confirm with { confirm: "reset all" }']);
  const stock = await request('POST', '/api/fw-reset', JSON.stringify({ confirm: 'reset all' }));
  assert.deepStrictEqual([stock.status, JSON.parse(stock.body).error], [400, 'needs the open firmware']);
  assert.deepStrictEqual(JSON.parse((await request('POST', '/api/ping')).body), { ok: true });
});

test('switching keyboards: unknown ones refused, the next open is the new one, no flashing the X82HE Pro', async () => {
  const post = (p, b) => request('POST', p, JSON.stringify(b), { 'content-type': 'application/json' });
  assert.strictEqual((await request('GET', '/api/keyboards')).status, 200);
  assert.strictEqual((await post('/api/keyboard', { key: 'k100' })).status, 400);
  await post('/api/keyboard', { key: 'x82he' });          // its state() fails on this stub; the switch stands
  await request('POST', '/api/ping');
  assert.strictEqual(opened.at(-1), 'x82he');
  const flash = await post('/api/firmware/flash', { id: 'latest' });
  assert.deepStrictEqual([flash.status, JSON.parse(flash.body).error],
    [400, 'firmware flashing is only for the MAX68HE; switch to it first']);
  await post('/api/keyboard', { key: 'max68he' });
  await request('POST', '/api/ping');
  assert.strictEqual(opened.at(-1), 'max68he');
});
