// Play sequence mouse glides ("move dx dy over T [curve]"): text / JSON parsing, the step bytes
// (must match the firmware contract: header GLIDE + 2 or 4 GLIDE_ARG steps), the timeline /
// length, the caps gate and the curve formulas shared with the web preview (web/glide-core.js).
const test = require('node:test');
const assert = require('node:assert');
const P = require('../src/protocol');
const { parseSequence, sequenceMs, timeline, sequenceMoves } = require('../src/sequence');
const { glideCurve, movePos } = require('../web/glide-core');
const { Keyboard } = require('../src/keyboard');
const { sequenceRoutes } = require('../src/web/sequence-routes');

const st = (delay, type, a = 0, b = 0) => ({ delay, type, a, b });
const G = 8, A = 9;
// the 5-byte steps as the APPEND packet carries them
const bytes = (steps) => P.seqAppendPackets(steps).flatMap((p) => p.slice(8, 8 + p[4] * 5));

test('protocol: GLIDE = 8, GLIDE_ARG = 9; "sequenceGlide" is CAPS2 bit 14', () => {
  assert.strictEqual(P.SEQ_EVENTS.indexOf('glide'), G);
  assert.strictEqual(P.SEQ_EVENTS.indexOf('glideArg'), A);
  assert.strictEqual(P.SEQ_EVENTS.length, 10);
  assert.deepStrictEqual(P.parseCaps([0xf8, 4, 120, 68, 15, 8, 0, 0, 0x00, 0x40]).features, ['sequenceGlide']);
  assert.deepStrictEqual(P.parseCaps([0xf8, 4, 120, 68, 15, 8, 0, 0, 0x00, 0x60]).features, ['sequence', 'sequenceGlide']);
});

test('encoding: one glide of each curve, bytes as in the contract table', () => {
  const one = (src, want) => assert.deepStrictEqual(bytes(parseSequence(src)), want, src);
  // head [delay, 8, dx lo, dx hi], arg1 [dy lo, dy hi, 9, T lo, T hi], arg2 [curve, 0, 9, param lo, param hi]
  one('move 300 -2 over 500ms', [0, 0, G, 0x2c, 0x01, 0xfe, 0xff, A, 0xf4, 0x01, 0, 0, A, 0, 0]);
  one('120ms; move -1 1 over 1.5s ease in', [120, 0, G, 0xff, 0xff, 1, 0, A, 0xdc, 0x05, 1, 0, A, 200, 0]);
  one('move 0 -32767 over 65535 ease out 3', [0, 0, G, 0, 0, 0x01, 0x80, A, 0xff, 0xff, 2, 0, A, 0x2c, 0x01]);
  one('move 32767 5 over 1ms ease inout 0.3', [0, 0, G, 0xff, 0x7f, 5, 0, A, 1, 0, 3, 0, A, 30, 0]);
  one('move 10 0 over 20 sine', [0, 0, G, 10, 0, 0, 0, A, 20, 0, 4, 0, A, 0, 0]);
  one('move 10 0 over 20 expo', [0, 0, G, 10, 0, 0, 0, A, 20, 0, 5, 0, A, 0xf4, 0x01]);
  one('move 10 0 over 20 expo -5', [0, 0, G, 10, 0, 0, 0, A, 20, 0, 5, 0, A, 0x0c, 0xfe]);
  one('move 10 0 over 20 smooth', [0, 0, G, 10, 0, 0, 0, A, 20, 0, 6, 0, A, 0, 0]);
  // points: arg3 [x0, y0, 9, x1, y1], arg4 [x2, y2, 9, x3, y3]
  one('move 10 0 over 20 curve points 0,1 64,200 192,230 255,254', [0, 0, G, 10, 0, 0, 0, A, 20, 0, 7, 0, A, 0, 0,
    0, 1, A, 64, 200, 192, 230, A, 255, 254]);
});

test('text: every form; plain move unchanged; case does not matter', () => {
  const g = (src) => parseSequence(src).slice(0, 3);
  assert.deepStrictEqual(g('MOVE 1 2 OVER 3MS Ease InOut'), g('move 1 2 over 3ms ease inout 2'));
  assert.deepStrictEqual(g('move 1 2 over 3 linear'), g('move 1 2 over 3'));
  assert.deepStrictEqual(g('move 1 2 over 3 ease in 2.555'), [st(0, G, 1, 0), st(2, A, 3, 0), st(1, A, 0, 1)], 'P rounded to 1/100 (256)');
  assert.deepStrictEqual(parseSequence('move 300 -5').map((s) => s.type), [6, 6, 6], 'plain move keeps int8 move steps');
  assert.deepStrictEqual(parseSequence('move 5 -5'), [st(0, 6, 5, 0xfb)]);
  // a glide then a key: the key's delay counts from the glide's start, args carry no delay
  assert.deepStrictEqual(parseSequence('move 1 0 over 1s; 100ms; A down').slice(3), [st(100, 1, 0x04)]);
  assert.strictEqual(parseSequence('move 1 0 over 9ms curve points 0,0 0,0 255,255 255,255').length, 5);
});

test('text errors: curve, P, K, T, points, numbers, ranges', () => {
  const bad = (src, re) => assert.throws(() => parseSequence(src), (e) => re.test(e.message) && e.status === 400, src);
  bad('move 1 1 over 1s wobble', /line 1, col 1: unknown curve "wobble"/);
  bad('move 1 1 over 1s ease sideways', /ease in, ease out or ease inout/);
  bad('move 1 1 over 1s ease', /ease in, ease out or ease inout/);
  bad('move 1 1 over 1s ease in fast', /P "fast" is not a number/);
  bad('move 1 1 over 1s ease in 0.2', /ease P is within 0.3..8/);
  bad('move 1 1 over 1s ease out 8.1', /ease P is within 0.3..8/);
  bad('move 1 1 over 1s ease in 2 3', /unexpected "3"/);
  bad('move 1 1 over 1s expo 0', /expo K is within -20..20 and not 0/);
  bad('move 1 1 over 1s expo 0.001', /not 0/);
  bad('move 1 1 over 1s expo 21', /expo K is within -20..20/);
  bad('move 1 1 over 1s expo -20.5', /expo K is within -20..20/);
  bad('move 1 1 over 1s expo x', /K "x" is not a number/);
  bad('move 1 1 over 1s sine 2', /unexpected "2"/);
  bad('move 1 1 over', /over needs a time like 500ms/);
  bad('move 1 1 over soon', /glide time "soon" is not like 500ms/);
  bad('move 1 1 over 0ms', /glide time is 1 ms..65535 ms/);
  bad('move 1 1 over 66s', /glide time is 1 ms..65535 ms/);
  bad('move 1 1 later 5ms', /unexpected "later 5ms"/);
  bad('move 1 1 over 1s curve', /curve points x0,y0/);
  bad('move 1 1 over 1s curve points 0,0 1,1 2,2', /needs 4 points/);
  bad('move 1 1 over 1s curve points 0,0 1,1 2,2 3,3 4,4', /needs 4 points/);
  bad('move 1 1 over 1s curve points 0,0 1,1 2,2 3,256', /0..255/);
  bad('move 1 1 over 1s curve points 0,0 1 2,2 3,3', /point "1" is not like 85,170/);
  bad('move 1 1 over 1s curve points 0,0 100,1 99,2 255,3', /x values must not go down/);
  bad('move 1 1 over 1s curve points 0,0 0,0 0,0 0,0', /all 0/);
  bad('move 32768 0 over 1s', /dx is a whole number within -32767..32767/);
  bad('move 0 -32768 over 1s', /dy is a whole number within -32767..32767/);
  bad('move x 1 over 1s', /dx is a whole number/);
});

test('JSON form: glides of each curve and its errors', () => {
  const g = (step) => parseSequence([step]);
  assert.deepStrictEqual(g({ event: 'move', dx: 300, dy: -2, over: 500 }), parseSequence('move 300 -2 over 500ms'));
  assert.deepStrictEqual(g({ event: 'move', dx: 1, dy: 2, over: '1.5s', curve: 'easeOut', power: 3 }), parseSequence('move 1 2 over 1.5s ease out 3'));
  assert.deepStrictEqual(g({ event: 'move', dx: 1, dy: 2, over: 9, curve: 'expo', power: -2 }), parseSequence('move 1 2 over 9 expo -2'));
  for (const c of ['linear', 'easeIn', 'easeInOut', 'sine', 'smooth']) assert.strictEqual(g({ event: 'move', dx: 1, over: 9, curve: c }).length, 3, c);
  assert.deepStrictEqual(g({ event: 'move', dx: 1, dy: 0, over: 9, curve: 'points', points: [[0, 0], [10, 20], [30, 40], [255, 255]] }),
    parseSequence('move 1 0 over 9 curve points 0,0 10,20 30,40 255,255'));
  assert.deepStrictEqual(g({ event: 'move', dx: 5, dy: -5 }), [st(0, 6, 5, 0xfb)], 'no over = plain move');
  const bad = (step, re) => assert.throws(() => g(step), (e) => re.test(e.message) && e.status === 400, JSON.stringify(step));
  bad({ event: 'move', dx: 1, over: 9, curve: 'bounce' }, /step 1: unknown curve "bounce"/);
  bad({ event: 'move', dx: 1, over: 9, curve: 3 }, /curve is a name/);
  bad({ event: 'move', dx: 1, curve: 'sine' }, /need over/);
  bad({ event: 'move', dx: 1, over: 0 }, /glide time is 1 ms/);
  bad({ event: 'move', dx: 1, over: 70000 }, /glide time is 1 ms/);
  bad({ event: 'move', dx: 1, over: 9, curve: 'easeIn', power: 9 }, /ease P/);
  bad({ event: 'move', dx: 1, over: 9, curve: 'expo', power: 0 }, /expo K/);
  bad({ event: 'move', dx: 1, over: 9, curve: 'sine', power: 2 }, /power only goes with ease or expo/);
  bad({ event: 'move', dx: 1, over: 9, curve: 'linear', points: [] }, /points only go with the points curve/);
  bad({ event: 'move', dx: 1, over: 9, curve: 'points' }, /needs 4 points/);
  bad({ event: 'move', dx: 1, over: 9, curve: 'points', points: [[0, 0], [1, 1], [2, 2], [3, 1.5]] }, /whole numbers 0..255/);
  bad({ event: 'move', dx: 1, over: 9, curve: 'points', points: [[0, 0], [9, 1], [2, 2], [3, 3]] }, /must not go down/);
  bad({ event: 'move', dx: -32768, over: 9 }, /dx is a whole number/);
});

test('sequenceMs and timeline count glide durations (max of start + duration)', () => {
  assert.strictEqual(sequenceMs(parseSequence('move 100 0 over 2s; 500ms')), 2000);
  assert.strictEqual(sequenceMs(parseSequence('A tap; move 1 0 over 1s; 300ms; B tap')), 20 + 1000);
  assert.strictEqual(sequenceMs(parseSequence('move 1 0 over 1s; 1.5s; A tap')), 1520);
  assert.strictEqual(sequenceMs(parseSequence('70s; move 1 1 over 100ms')), 70100, 'wait steps before a glide count');
  assert.strictEqual(sequenceMs(parseSequence('move 1 0 over 65535ms curve points 0,0 1,1 2,2 3,3')), 65535, 'arg delay fields are data');
  const tl = timeline(parseSequence('move 300 0; 10ms; move 5 -5 over 250ms ease out 3'));
  assert.deepStrictEqual(tl, { lengthMs: 260, moves: [
    { start: 0, duration: 0, dx: 300, dy: 0, curve: null }, { start: 10, duration: 250, dx: 5, dy: -5, curve: 'easeOut', power: 3 }] });
  // a 5th running glide finishes the oldest at once
  const five = timeline(parseSequence('move 1 0 over 1s; 10ms; move 1 0 over 1s; 10ms; move 1 0 over 1s; 10ms; move 1 0 over 1s; 10ms; move 1 0 over 100ms'));
  assert.strictEqual(five.moves[0].cut, 40);
  assert.ok(five.moves.slice(1).every((m) => m.cut === undefined));
  assert.strictEqual(five.lengthMs, 1030);
});

test('glideCurve at 0, .25, .5, .75, 1 for every curve', () => {
  const at = [0, 0.25, 0.5, 0.75, 1];
  const check = (f, want, what) => at.forEach((t, i) => assert.ok(Math.abs(f(t) - want[i]) < 1e-5, `${what} at ${t}: ${f(t)} != ${want[i]}`));
  check(glideCurve('linear'), [0, 0.25, 0.5, 0.75, 1], 'linear');
  check(glideCurve('easeIn'), [0, 0.0625, 0.25, 0.5625, 1], 'easeIn P2 (default)');
  check(glideCurve('easeIn', 3), [0, 0.015625, 0.125, 0.421875, 1], 'easeIn P3');
  check(glideCurve('easeOut', 2), [0, 0.4375, 0.75, 0.9375, 1], 'easeOut P2');
  check(glideCurve('easeInOut', 2), [0, 0.125, 0.5, 0.875, 1], 'easeInOut P2');
  check(glideCurve('easeInOut', 3), [0, 0.0625, 0.5, 0.9375, 1], 'easeInOut P3');
  check(glideCurve('sine'), [0, 0.146447, 0.5, 0.853553, 1], 'sine');
  check(glideCurve('expo'), [0, 0.016894, 0.075858, 0.281665, 1], 'expo K5 (default)');
  check(glideCurve('expo', -5), [0, 0.718335, 0.924142, 0.983106, 1], 'expo K-5');
  check(glideCurve('smooth'), [0, 0.15625, 0.5, 0.84375, 1], 'smooth');
  check(glideCurve('points', 0, [[0, 0], [64, 128], [192, 128], [255, 255]]), [0, 127.5 / 255, 128 / 255, 128 / 255, 1], 'points');
  check(glideCurve(7, 0, [[50, 20], [128, 20], [128, 255], [200, 100]]), [20 / 255, 20 / 255, 20 / 255, (255 - (155 * 63.25) / 72) / 255, 100 / 255], 'points: y0 before x0, flat, step down, y3 at the end');
  check(glideCurve(1, 2), [0, 0.0625, 0.25, 0.5625, 1], 'by curve id');
  assert.throws(() => glideCurve('bounce'), /unknown glide curve/);
});

test('movePos: rounded along the curve, exactly (dx, dy) at the end even if f(1) is not 1', () => {
  const m = { start: 100, duration: 200, dx: 101, dy: -7, f: glideCurve('linear') };
  assert.deepStrictEqual(movePos(m, 99), [0, 0]);
  assert.deepStrictEqual(movePos(m, 150), [25, -2]);
  assert.deepStrictEqual(movePos(m, 300), [101, -7]);
  const short = { start: 0, duration: 100, dx: 50, dy: 0, f: glideCurve('points', 0, [[0, 0], [10, 10], [20, 20], [255, 100]]) };
  assert.deepStrictEqual(movePos(short, 99.9), [20, 0]);
  assert.deepStrictEqual(movePos(short, 100), [50, 0]);
  assert.deepStrictEqual(movePos({ ...short, cut: 10 }, 10), [50, 0], 'a cut glide adds its remainder at once');
  const mv = sequenceMoves('move 10 0 over 100ms ease in');
  assert.strictEqual(mv.moves[0].f(0.5), 0.25);
});

// fake open firmware answering CAPS and the 0xEF commands
function fakeKeyboard(caps2) {
  const sent = [];
  let count = 0, playing = 0;
  const t = {
    async query(p) {
      sent.push(p);
      const r = [...p];
      if (p[0] === 0xf8) { r[8] = caps2 & 0xff; r[9] = caps2 >> 8; return r; }
      r[2] = 0;
      if (p[1] === 1) count = 0;
      if (p[1] === 2) count += p[4];
      if (p[1] === 3) playing = 1;
      Object.assign(r, { 8: playing, 12: count & 0xff, 13: count >> 8, 14: 0, 15: 2 });
      return r;
    },
    async send(p) { sent.push(p); },
    close() {},
  };
  const kb = new Keyboard(t);
  kb.info = { custom: true, unitMm: 0.005 };
  return { kb, sent };
}

test('caps gate: glides need "sequenceGlide", plain sequences do not', async () => {
  const old = fakeKeyboard(1 << 13);
  await assert.rejects(old.kb.playSequence('A tap; move 100 0 over 1s'), (e) => e.status === 400 && /glides .* need a newer open firmware/.test(e.message));
  assert.ok(!old.sent.some((p) => p[0] === 0xef), 'nothing sent to 0xEF');
  assert.strictEqual((await old.kb.playSequence('A tap; move 100 0')).playing, true);
  await assert.rejects(old.kb.playSequence([{ event: 'move', dx: 1, over: 5 }]), /glides/);
  const nu = fakeKeyboard((1 << 13) | (1 << 14));
  const out = await nu.kb.playSequence('move 100 0 over 1s ease out; 100ms; A tap');
  assert.strictEqual(out.lengthMs, 1000);
  assert.strictEqual(out.steps, 5);
});

test('preview route parses only, never opens the keyboard; MCP description has glide examples', async () => {
  let opened = 0;
  const httpError = (status, m) => Object.assign(new Error(m), { status });
  const R = sequenceRoutes({ keyboard: async () => { opened++; throw new Error('no'); }, httpError });
  const r = await R['POST /api/sequence/preview']({ text: 'move 10 0 over 1s sine; move 3 4' });
  assert.deepStrictEqual(r, { lengthMs: 1000, moves: [{ start: 0, duration: 1000, dx: 10, dy: 0, curve: 'sine' }, { start: 0, duration: 0, dx: 3, dy: 4, curve: null }] });
  assert.match((await R['POST /api/sequence/preview']({ text: 'move 1 1 over 1s wobble' })).error, /line 1, col 1: unknown curve "wobble"/);
  await assert.rejects(R['POST /api/sequence/preview']({}), (e) => e.status === 400);
  assert.strictEqual(opened, 0);
  const { server } = require('../src/mcp');
  assert.match(server._registeredTools.play_sequence.description, /move 300 0 over 500ms.*ease out.*curve points/);
});
