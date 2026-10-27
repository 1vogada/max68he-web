// Play sequence: text / JSON parsing (sequence.js), packets (protocol.js, must match
// firmware common/seq.h) and the driver calls with a fake transport (custom.js).
const test = require('node:test');
const assert = require('node:assert');
const P = require('../src/protocol');
const { parseSequence, sequenceMs } = require('../src/sequence');
const { Keyboard } = require('../src/keyboard');
const { sequenceRoutes } = require('../src/web/sequence-routes');

const E = Object.fromEntries(P.SEQ_EVENTS.map((n, i) => [n, i]));
const st = (delay, type, a = 0, b = 0) => ({ delay, type, a, b });

test('caps: "sequence" is CAPS2 bit 13, bits 9..12 are placeholders', () => {
  const caps = P.parseCaps([0xf8, 4, 120, 68, 15, 8, 0, 0, 0x00, 0x20]);
  assert.deepStrictEqual(caps.features, ['sequence']);
  assert.strictEqual(P.parseCaps([0xf8, 4, 120, 68, 15, 8, 0, 0, 0xff, 0x01]).features.includes('sequence'), false);
});

test('text: keys, chords, taps, pauses, release', () => {
  assert.deepStrictEqual(parseSequence('W down; 120ms; Space tap; 30ms; release'), [
    st(0, E.down, 0x1a), st(120, E.down, 0x2c), st(20, E.up, 0x2c), st(30, E.release)]);
  // a chord goes down in order and up in reverse; a given hold time; bare key = tap
  assert.deepStrictEqual(parseSequence('Ctrl+C tap 50ms\nA'), [
    st(0, E.down, 0xe0), st(0, E.down, 0x06), st(50, E.up, 0x06), st(0, E.up, 0xe0), st(0, E.down, 0x04), st(20, E.up, 0x04)]);
  assert.deepStrictEqual(parseSequence('down LShift; 1.5s; up shift'), [st(0, E.down, 0xe1), st(1500, E.up, 0xe1)]);
  assert.deepStrictEqual(parseSequence('# comment only\nwait 5ms; Esc down # held\nrelease all'), [st(5, E.down, 0x29), st(0, E.release)]);
});

test('text: a trailing pause becomes a wait step, long pauses are split at 65535 ms', () => {
  assert.deepStrictEqual(parseSequence('W down; 2s'), [st(0, E.down, 0x1a), st(2000, E.wait)]);
  assert.deepStrictEqual(parseSequence('70s; W tap'), [st(65535, E.wait), st(4465, E.down, 0x1a), st(20, E.up, 0x1a)]);
  assert.strictEqual(sequenceMs(parseSequence('70s; W tap')), 70020);
});

test('text: mouse buttons, movement in int8 pieces, wheel', () => {
  assert.deepStrictEqual(parseSequence('click L; mouse down R; mouse up right; wheel -2'), [
    st(0, E.mouseDown, 1), st(20, E.mouseUp, 1), st(0, E.mouseDown, 2), st(0, E.mouseUp, 2), st(0, E.wheel, 0xfe)]);
  const mv = parseSequence('move 300 -5');
  assert.strictEqual(mv.length, 3);
  assert.ok(mv.every((s) => s.type === E.move && s.delay === 0));
  const dx = mv.reduce((t, s) => t + (s.a << 24 >> 24), 0), dy = mv.reduce((t, s) => t + (s.b << 24 >> 24), 0);
  assert.deepStrictEqual([dx, dy], [300, -5]);
  assert.ok(mv.every((s) => Math.abs(s.a << 24 >> 24) <= 127));
});

test('text errors say where (line, column) and what', () => {
  const bad = (src, re) => assert.throws(() => parseSequence(src), (e) => re.test(e.message) && e.status === 400, src);
  bad('W down; Foo tap', /line 1, col 9: unknown key "Foo"/);
  bad('W down\n  click X', /line 2, col 3: mouse button is L, R or M/);
  bad('W sideways', /line 1, col 1: don't know "W sideways"/);
  bad('MouseLeft down', /not a keyboard key/);
  bad('Space tap soon', /hold time "soon"/);
  bad('move 10', /move needs dx and dy/);
  bad('move 1.5 2', /dx is a whole number/);
  bad('wheel 5000', /wheel is a whole number/);
  bad('wait', /wait needs a time/);
  bad('mouse sideways L', /mouse down/);
  bad('release now', /unexpected "now"/);
  bad('', /nothing to play/);
  bad('A; '.repeat(300), /600 steps, the keyboard holds 512/);
  assert.strictEqual(parseSequence('A down; '.repeat(512)).length, 512);
});

test('JSON form, as a list or as text', () => {
  const list = [{ event: 'down', key: 'W' }, { delay: 120, event: 'tap', key: 'Ctrl+C', hold: 30 }, { event: 'click', button: 'R' },
    { event: 'move', dx: 5, dy: -5 }, { event: 'wheel', notches: 1 }, { event: 'wait', ms: 10 }, { event: 'release' }];
  const want = [st(0, E.down, 0x1a), st(120, E.down, 0xe0), st(0, E.down, 0x06), st(30, E.up, 0x06), st(0, E.up, 0xe0),
    st(0, E.mouseDown, 2), st(20, E.mouseUp, 2), st(0, E.move, 5, 0xfb), st(0, E.wheel, 1), st(10, E.release)];
  assert.deepStrictEqual(parseSequence(list), want);
  assert.deepStrictEqual(parseSequence(JSON.stringify(list)), want);
  assert.throws(() => parseSequence([{ event: 'jump' }]), /step 1: event is one of/);
  assert.throws(() => parseSequence([{ event: 'down', key: 'W' }, { event: 'down', key: 'Nope' }]), /step 2: unknown key "Nope"/);
  assert.throws(() => parseSequence('[1, 2'), /bad JSON/);
  assert.throws(() => parseSequence(42), /text or a list/);
});

test('packets: [EF, sub] with Bit7 checksum, APPEND [EF, 2, start lo, hi, n] + 5-byte steps', () => {
  const play = P.seqPlayPacket(true);
  assert.deepStrictEqual(play.slice(0, 3), [0xef, 3, 1]);
  assert.strictEqual(play[7], P.checksum(play, 7));
  assert.deepStrictEqual(P.seqPacket(P.SEQ.STOP).slice(0, 2), [0xef, 4]);
  const steps = Array.from({ length: 25 }, (_, i) => st(300 + i, E.down, 0x04 + i));
  const pkts = P.seqAppendPackets(steps);
  assert.strictEqual(pkts.length, 3);
  assert.deepStrictEqual(pkts.map((p) => p.slice(0, 5)), [[0xef, 2, 0, 0, 11], [0xef, 2, 11, 0, 11], [0xef, 2, 22, 0, 3]]);
  assert.deepStrictEqual(pkts[1].slice(8, 13), [(311) & 0xff, 311 >> 8, E.down, 0x04 + 11, 0]);
  assert.deepStrictEqual(pkts[2].slice(8 + 2 * 5, 8 + 3 * 5), [(324) & 0xff, 324 >> 8, E.down, 0x04 + 24, 0]);
  assert.ok(pkts.every((p) => p.length === 64 && p[7] === P.checksum(p, 7)));
  const big = P.seqAppendPackets(Array.from({ length: 300 }, () => st(0, E.wait)));
  assert.deepStrictEqual(big[big.length - 1].slice(0, 5), [0xef, 2, 297 & 0xff, 297 >> 8, 3]);
});

test('status reply decodes', () => {
  const r = new Array(64).fill(0);
  Object.assign(r, { 0: 0xef, 2: 0, 8: 1, 9: 1, 10: 5, 11: 1, 12: 6, 13: 1, 14: 0, 15: 2, 16: 3 });
  assert.deepStrictEqual(P.parseSeqStatus(r), { error: null, playing: true, stopOnKey: true, step: 261, steps: 262, capacity: 512, ended: 'key pressed' });
  r[2] = 3;
  assert.strictEqual(P.parseSeqStatus(r).error, 'too many steps');
});

// Fake open firmware: answers CAPS and keeps a sequence buffer like seq.c.
function fakeKeyboard({ caps2 = 1 << 13, refuse } = {}) {
  const sent = [];
  const seq = { count: 0, playing: 0, flags: 0 };
  const t = {
    async query(p) {
      sent.push(p);
      const r = [...p];
      if (p[0] === 0xf8) { r[8] = caps2 & 0xff; r[9] = caps2 >> 8; return r; }
      if (p[0] !== 0xef) return r;
      r[2] = 0;
      if (p[1] === 1) seq.count = 0;
      if (p[1] === 2) { if (refuse === 'append' || p[2] + (p[3] << 8) !== seq.count) r[2] = 2; else seq.count += p[4]; }
      if (p[1] === 3) { seq.playing = 1; seq.flags = p[2]; }
      if (p[1] === 4) seq.playing = 0;
      Object.assign(r, { 8: seq.playing, 9: seq.flags, 12: seq.count & 0xff, 13: seq.count >> 8, 14: 0, 15: 2 });
      return r;
    },
    async send(p) { sent.push(p); },
    close() {},
  };
  const kb = new Keyboard(t);
  kb.info = { custom: true, unitMm: 0.005 };
  return { kb, sent, seq };
}

test('playSequence: clear, chunks in order, play; status back', async () => {
  const { kb, sent, seq } = fakeKeyboard();
  const out = await kb.playSequence('A tap; '.repeat(12), { stopOnKey: true });
  const ops = sent.filter((p) => p[0] === 0xef).map((p) => p[1]);
  assert.deepStrictEqual(ops, [1, 2, 2, 2, 3, 0], 'clear, 3 appends (24 steps), play, status');
  assert.strictEqual(seq.count, 24);
  assert.deepStrictEqual(sent.find((p) => p[0] === 0xef && p[1] === 3).slice(0, 3), [0xef, 3, 1]);
  assert.strictEqual(out.playing, true);
  assert.strictEqual(out.stopOnKey, true);
  assert.strictEqual(out.lengthMs, 12 * 20);
  assert.strictEqual((await kb.stopSequence()).playing, false);
  assert.strictEqual((await kb.sequenceStatus()).steps, 24);
});

test('a parse error sends nothing; a refused chunk stops before PLAY', async () => {
  const a = fakeKeyboard();
  await assert.rejects(a.kb.playSequence('Nope tap'), /unknown key/);
  assert.strictEqual(a.sent.length, 0);
  const b = fakeKeyboard({ refuse: 'append' });
  await assert.rejects(b.kb.playSequence('A tap'), /keyboard refused the sequence: chunk out of order/);
  assert.ok(!b.sent.some((p) => p[0] === 0xef && p[1] === 3), 'no PLAY after a refused chunk');
});

test('caps gating: firmware without "sequence" and stock firmware get no 0xEF', async () => {
  const { kb, sent } = fakeKeyboard({ caps2: 0x1ff });
  for (const call of [() => kb.playSequence('A tap'), () => kb.stopSequence(), () => kb.sequenceStatus()]) {
    await assert.rejects(call(), /Play sequence needs a newer open firmware/);
  }
  assert.ok(!sent.some((p) => p[0] === 0xef));
  const stock = fakeKeyboard();
  stock.kb.info = { custom: false, unitMm: 0.005 };
  await assert.rejects(stock.kb.playSequence('A tap'), /open firmware/);
  assert.strictEqual(stock.sent.length, 0);
});

test('web routes check the request shape before touching the keyboard', async () => {
  const httpError = (status, msg) => Object.assign(new Error(msg), { status });
  let opened = 0;
  const { kb } = fakeKeyboard();
  const R = sequenceRoutes({ keyboard: async () => { opened++; return kb; }, httpError });
  await assert.rejects(R['POST /api/sequence/play']({}), /give text or steps/);
  await assert.rejects(R['POST /api/sequence/play']({ text: 'A', steps: [] }), /give text or steps/);
  await assert.rejects(R['POST /api/sequence/play']({ text: 5 }), /text is a string/);
  await assert.rejects(R['POST /api/sequence/play']({ text: 'A', stopOnKey: 'yes' }), /stopOnKey/);
  assert.strictEqual(opened, 0);
  assert.strictEqual((await R['POST /api/sequence/play']({ text: 'A tap', stopOnKey: true })).playing, true);
  assert.strictEqual((await R['POST /api/sequence/stop']()).playing, false);
  assert.strictEqual((await R['GET /api/sequence/status']()).steps, 2);
});

test('MCP tools are registered with the anti-cheat note', () => {
  const { server } = require('../src/mcp');
  const t = server._registeredTools;
  assert.ok(t.play_sequence && t.stop_sequence);
  assert.match(t.play_sequence.description, /In online games with anti-cheat, automated input can break their rules\./);
  assert.ok(t.play_sequence.inputSchema.safeParse({ text: 'A tap', stopOnKey: true }).success);
});

test('play route: a mistake in the sequence answers 400, keyboard trouble keeps its status', async () => {
  const { sequenceRoutes } = require('../src/web/sequence-routes');
  const httpError = (status, m) => Object.assign(new Error(m), { status });
  const play = (impl) => sequenceRoutes({ keyboard: async () => ({ playSequence: impl }), httpError })['POST /api/sequence/play'];
  await assert.rejects(play(async () => { throw new Error('line 1: unknown key Foo'); })({ text: 'Foo tap' }), (e) => e.status === 400 && /Foo/.test(e.message));
  await assert.rejects(play(async () => { throw Object.assign(new Error('no reply'), { device: true }); })({ text: 'A tap' }), (e) => e.device && !e.status);
  await assert.rejects(play(async () => { throw httpError(400, 'needs a newer open firmware'); })({ text: 'A tap' }), (e) => e.status === 400);
});
