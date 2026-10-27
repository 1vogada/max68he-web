// Cross-process keyboard lock, on a lock file of its own (never the real one).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'max68he-lock-')), 'keyboard.lock');
process.env.MAX68HE_LOCK_FILE = FILE;
const lock = require('../src/lock');
const { Keyboard } = require('../src/keyboard');

const write = (holder) => fs.writeFileSync(FILE, typeof holder === 'string' ? holder : JSON.stringify(holder));
const ownerPid = () => JSON.parse(fs.readFileSync(FILE, 'utf8')).pid;

test.afterEach(() => { lock.release(); fs.rmSync(FILE, { force: true }); });
test.after(() => fs.rmSync(path.dirname(FILE), { recursive: true, force: true }));

test('take, take again in the same process, give back', () => {
  assert.strictEqual(lock.FILE, FILE);
  lock.acquire();
  assert.strictEqual(ownerPid(), process.pid);
  lock.acquire();
  lock.release();
  assert.ok(!fs.existsSync(FILE));
});

test('a live holder refuses with its name', () => {
  write({ pid: process.ppid, owner: 'the web UI' });
  assert.throws(() => lock.acquire(), (e) => e.status === 409 && /in use by the web UI \(pid \d+\)/.test(e.message));
  lock.release();
  assert.ok(fs.existsSync(FILE), 'release leaves a lock it does not hold');
});

test('a holder that is gone is stale and replaced', () => {
  const dead = cp.spawnSync(process.execPath, ['-e', '']).pid;
  write({ pid: dead, owner: 'the CLI' });
  lock.acquire();
  assert.strictEqual(ownerPid(), process.pid);
});

test('an unreadable lock counts only while it may still be being written', () => {
  write('');
  assert.throws(() => lock.acquire(), /in use by another program/);
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(FILE, old, old);
  lock.acquire();
  assert.strictEqual(ownerPid(), process.pid);
});

test('Keyboard.open refuses before touching the device while another program holds it', async () => {
  write({ pid: process.ppid, owner: 'the MCP server' });
  await assert.rejects(Keyboard.open(), /the keyboard is in use by the MCP server/);
});

test('the lock keeps its start time, and the OS agrees with it', () => {
  lock.acquire();
  const h = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  assert.strictEqual(h.started, lock.STARTED);
  const os = lock.startedAt(process.pid);
  assert.ok(os !== null && Math.abs(os - lock.STARTED) < 3000, `OS says ${os}, the lock says ${lock.STARTED}`);
});

test('a live holder that started when the lock says still holds it', () => {
  write({ pid: process.ppid, started: lock.startedAt(process.ppid), owner: 'the web UI' });
  assert.throws(() => lock.acquire(), /in use by the web UI/);
});

test('a reused pid (alive, but started at another time) is stale and replaced', () => {
  write({ pid: process.ppid, started: Date.now() - 86400000, owner: 'the web UI' });   // "a day ago"
  lock.acquire();
  assert.strictEqual(ownerPid(), process.pid);
});
