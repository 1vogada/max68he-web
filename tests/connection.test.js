// Shared connection: device errors drop it after queued work, bad input keeps it,
// and pacing survives a reopen.
const test = require('node:test');
const assert = require('node:assert');
const HID = require('node-hid');
const { Keyboard } = require('../src/keyboard');
const { createConnection, isDeviceError } = require('../src/connection');
const { Transport, deviceError, pace, sentCount } = require('../src/hid');
const P = require('../src/protocol');

function fakeKeyboard(log) {
  return { t: { busy: Promise.resolve() }, close() { log.push('close'); } };
}

function withOpen(fn) {
  const real = Keyboard.open;
  return async () => {
    try { await fn(); } finally { Keyboard.open = real; }
  };
}

test('bad input keeps the connection, a device error drops it', withOpen(async () => {
  const log = [];
  Keyboard.open = async () => fakeKeyboard(log);
  const conn = createConnection();
  const k = await conn.get();
  await conn.fail(new TypeError('slot must be a number'));
  await conn.fail(Object.assign(new Error('profile must be 0..3'), { status: 400 }));
  assert.strictEqual(conn.current, k);
  assert.deepStrictEqual(log, []);
  await conn.fail(deviceError(new Error('could not send feature report')));
  assert.strictEqual(conn.current, null);
  assert.deepStrictEqual(log, ['close']);
  assert.notStrictEqual(await conn.get(), k, 'the next request reopens');
}));

test('drop waits for the work queued on the handle before closing it', withOpen(async () => {
  const log = [];
  let finish;
  const k = fakeKeyboard(log);
  Keyboard.open = async () => k;
  const conn = createConnection();
  await conn.get();
  k.t.busy = new Promise((r) => { finish = r; }).then(() => log.push('work done'));
  const dropped = conn.drop();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(log, [], 'not closed while work is queued');
  finish();
  await dropped;
  assert.deepStrictEqual(log, ['work done', 'close']);
}));

test('a blocked connection refuses to open', async () => {
  const conn = createConnection({ blocked: () => new Error('flashing') });
  await assert.rejects(conn.get(), /flashing/);
});

test('hid marks I/O failures as device errors', async () => {
  const realHID = HID.HID;
  HID.HID = class { sendFeatureReport() { throw new Error('could not write'); } close() {} };
  try {
    const t = new Transport('fake-path');
    const e = await t.send(P.packet(P.OP.GET_PROFILE)).catch((x) => x);
    assert.ok(isDeviceError(e));
    assert.ok(!isDeviceError(new Error('slot out of range')));
  } finally {
    HID.HID = realHID;
  }
});

test('setting pacing holds across a reopened transport', async () => {
  const realHID = HID.HID;
  HID.HID = class { sendFeatureReport() {} close() {} };
  try {
    const pkt = P.packet(P.OP.GET_PROFILE);
    await new Transport('fake-path').writeSetting(pkt, 400);
    const at = pace.setting;
    const t2 = new Transport('fake-path');   // as after a drop and reopen
    await t2.writeSetting(pkt, 400);
    assert.ok(pace.setting - at >= 390, `second write waited ${pace.setting - at} ms`);
  } finally {
    HID.HID = realHID;
  }
});

const unsentError = () => Object.assign(deviceError(new Error('device not connected')), { unsent: true });

test('a stale handle reopens and the request runs once more when nothing was sent', withOpen(async () => {
  const log = [];
  let opens = 0;
  Keyboard.open = async () => { opens++; return fakeKeyboard(log); };
  const conn = createConnection();
  const stale = await conn.get();
  let calls = 0;
  const out = await conn.run(async () => {
    const k = await conn.get();
    if (++calls === 1) throw unsentError();
    return k;
  });
  assert.strictEqual(calls, 2);
  assert.notStrictEqual(out, stale, 'the retry ran on a reopened handle');
  assert.deepStrictEqual(log, ['close']);
  assert.strictEqual(opens, 2);
}));

test('no retry once a packet was sent, or for other errors', withOpen(async () => {
  const realHID = HID.HID;
  HID.HID = class { sendFeatureReport() {} close() {} };
  Keyboard.open = async () => fakeKeyboard([]);
  try {
    const conn = createConnection();
    let calls = 0;
    // a packet went out before the failure: running again could repeat it
    await assert.rejects(conn.run(async () => {
      calls++;
      await new Transport('fake-path').send(P.packet(P.OP.GET_PROFILE));
      throw unsentError();
    }), /not connected/);
    assert.strictEqual(calls, 1);
    calls = 0;
    await assert.rejects(conn.run(async () => { calls++; throw deviceError(new Error('no reply to 0x8')); }), /no reply/);
    await assert.rejects(conn.run(async () => { calls++; throw new TypeError('slot must be a number'); }), /slot/);
    assert.strictEqual(calls, 2, 'each ran once');
    calls = 0;
    await assert.rejects(conn.run(async () => { calls++; throw unsentError(); }), /not connected/);
    assert.strictEqual(calls, 2, 'a second stale failure is not retried again');
  } finally {
    HID.HID = realHID;
  }
}));

test('a failed send is marked unsent and not counted', async () => {
  const realHID = HID.HID;
  let ok = false;
  HID.HID = class { sendFeatureReport() { if (!ok) throw new Error('could not send feature report'); } close() {} };
  try {
    const t = new Transport('fake-path');
    const before = sentCount();
    const e = await t.send(P.packet(P.OP.GET_PROFILE)).catch((x) => x);
    assert.ok(isDeviceError(e) && e.unsent);
    assert.strictEqual(sentCount(), before);
    ok = true;
    await t.send(P.packet(P.OP.GET_PROFILE));
    assert.strictEqual(sentCount(), before + 1);
  } finally {
    HID.HID = realHID;
  }
});
