// The MCP server's keyboard connection closes after IDLE_MS without a call, releasing the
// cross-process lock (lock.js), so the web UI can open the keyboard; the next call reopens.
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.MAX68HE_LOCK_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'max68he-lock-')), 'kb.lock');
const test = require('node:test');
const assert = require('node:assert');
const cp = require('child_process');
const lock = require('../src/lock');
const { Keyboard } = require('../src/keyboard');
const { createConnection } = require('../src/connection');
const { createMcpServer, IDLE_MS } = require('../src/mcp');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Another process (as the web UI would) tries to take the keyboard lock: 'ok' or the error.
const otherProcess = () => cp.execFileSync(process.execPath, ['-e',
  `try { require(${JSON.stringify(path.join(__dirname, '..', 'src', 'lock.js'))}).acquire(); console.log('ok'); } catch (e) { console.log(e.message); }`],
{ encoding: 'utf8', env: process.env }).trim();

test('an idle MCP connection lets go of the keyboard; the next call reopens it', async () => {
  assert.strictEqual(IDLE_MS, 5000);
  let opened = 0, closed = 0;
  const realOpen = Keyboard.open;
  Keyboard.open = async () => {          // a keyboard that takes and gives back the real lock
    lock.acquire(lock.fileFor('max68he'));
    opened++;
    return {
      t: { busy: Promise.resolve() },
      listKeys: async () => [{ slot: 0, name: 'Esc' }],
      close() { closed++; lock.release(); },
    };
  };
  try {
    const server = createMcpServer({ conn: createConnection({ idleMs: 200 }) });
    const listKeys = server._registeredTools.list_keys.handler ?? server._registeredTools.list_keys.callback;
    const r1 = await listKeys({});
    assert.ok(!r1.isError, r1.content[0].text);
    assert.match(otherProcess(), /in use by/, 'held right after a call');
    await sleep(500);
    assert.strictEqual(closed, 1, 'closed after the idle time');
    assert.strictEqual(otherProcess(), 'ok', 'another program can open the keyboard now');
    const r2 = await listKeys({});
    assert.ok(!r2.isError);
    assert.strictEqual(opened, 2, 'the next call reopened it');
  } finally {
    Keyboard.open = realOpen;
  }
});

test('the timer waits for a running call and restarts after it', async () => {
  let closed = 0;
  const kb = { t: { busy: Promise.resolve() }, close() { closed++; } };
  const realOpen = Keyboard.open;
  Keyboard.open = async () => kb;
  try {
    const conn = createConnection({ idleMs: 100 });
    await conn.run(async () => { await conn.get(); await sleep(250); });   // longer than idleMs
    assert.strictEqual(closed, 0, 'not closed during the call');
    await sleep(50);
    assert.strictEqual(closed, 0, 'countdown starts when the call ends');
    await sleep(150);
    assert.strictEqual(closed, 1);
    const plain = createConnection();                                        // no idleMs: stays open
    await plain.run(() => plain.get());
    await sleep(150);
    assert.strictEqual(closed, 1);
  } finally {
    Keyboard.open = realOpen;
  }
});
