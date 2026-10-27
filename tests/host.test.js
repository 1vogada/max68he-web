// Per-key software control packets (open firmware host_api.h): byte layouts must
// match firmware common/host_api.c exactly.
const test = require('node:test');
const assert = require('node:assert');
const P = require('../src/protocol');
const { Keyboard } = require('../src/keyboard');

test('caps reply decodes counts and feature names', () => {
  const caps = P.parseCaps([0xf8, 1, 90, 68, 15, 6, 0xff, 0xff]);
  assert.deepStrictEqual(caps, { api: 1, keys: 90, leds: 68, cols: 15, rows: 6, features: P.HOST_CAPS });
  // older open firmware: the first nine features only
  assert.deepStrictEqual(P.parseCaps([0xf8, 1, 120, 68, 15, 8, 0xff, 0x01]).features, P.HOST_CAPS.slice(0, 9));
  assert.deepStrictEqual(P.parseCaps([0xf8, 1, 0, 0, 0, 0, 0x09, 0]).features, ['travelStream', 'claim']);
});

test('claim: [F9, start, n] + one byte per slot from byte 8, Bit7 checksum', () => {
  const claim = new Array(128).fill(0);
  claim[9] = 1; claim[60] = 1;
  const pkts = P.claimPackets(claim);
  assert.strictEqual(pkts.length, 3);
  assert.deepStrictEqual(pkts[0].slice(0, 3), [0xf9, 0, 56]);
  assert.strictEqual(pkts[0][8 + 9], 1);
  assert.deepStrictEqual(pkts[1].slice(0, 3), [0xf9, 56, 56]);
  assert.strictEqual(pkts[1][8 + 4], 1);
  assert.deepStrictEqual(pkts[2].slice(0, 3), [0xf9, 112, 16]);
  assert.strictEqual(pkts[0][7], P.checksum(pkts[0], 7));
  assert.deepStrictEqual(P.releaseAllPacket().slice(0, 2), [0xf9, 0xff]);
});

test('inject: [FA, modifiers] + usages at 8..13', () => {
  const p = P.injectPacket(0x02, [0x04, 0x05]);
  assert.deepStrictEqual(p.slice(0, 2), [0xfa, 0x02]);
  assert.deepStrictEqual(p.slice(8, 11), [0x04, 0x05, 0]);
  assert.throws(() => P.injectPacket(0, [1, 2, 3, 4, 5, 6, 7]));
});

test('overlay: [FB, start, n<=18, ttl/100ms] + RGB at 8; clear = [FB, FF]', () => {
  const rgb = Array.from({ length: 20 }, (_, i) => (i === 19 ? [255, 0, 0] : [0, 0, 0]));
  const pkts = P.overlayPackets(rgb, 1500);
  assert.strictEqual(pkts.length, 2);
  assert.deepStrictEqual(pkts[0].slice(0, 4), [0xfb, 0, 18, 15]);
  assert.deepStrictEqual(pkts[1].slice(0, 4), [0xfb, 18, 2, 15]);
  assert.deepStrictEqual(pkts[1].slice(11, 14), [255, 0, 0]);
  assert.deepStrictEqual(P.clearOverlayPacket().slice(0, 2), [0xfb, 0xff]);
});

test('key events parse with or without the report ID', () => {
  assert.deepStrictEqual(P.parseKeyEvent([5, 0xa1, 9, 1]), { slot: 9, down: true });
  assert.deepStrictEqual(P.parseKeyEvent([0xa1, 9, 0]), { slot: 9, down: false });
  assert.strictEqual(P.parseKeyEvent([5, 0x1b, 10, 0, 9]), null, 'travel reports are not key events');
});

test('stock firmware is never sent host commands', async () => {
  const sent = [];
  const kb = new Keyboard({ query: async (p) => { sent.push(p); return p; }, send: async (p) => sent.push(p), close() {} });
  kb.info = { custom: false, unitMm: 0.005 };
  for (const call of [() => kb.getCaps(), () => kb.claimKeys([1]), () => kb.injectKeys(0, [4]), () => kb.setOverlay([[1, 2, 3]]),
    () => kb.snapshotDepth(), () => kb.setCustomMode('droplet')]) {
    await assert.rejects(call(), /open firmware/);
  }
  assert.throws(() => kb.watchKeyEvents(() => {}), /open firmware/);
  assert.strictEqual(sent.length, 0);
});

test('gamepad: settings packet in centi-mm, curve index, bindings 56 per packet', () => {
  const s = P.gamepadSetPacket({ enabled: true, keysStopTyping: false, curve: 'smooth', deadzoneMm: 0.3, fullMm: 3.2, buttonMm: 1.2 });
  assert.deepStrictEqual(s.slice(0, 2), [0xfd, 1]);
  assert.deepStrictEqual(s.slice(8, 17), [1, 0, 1, 30, 0, 64, 1, 120, 0]);
  assert.strictEqual(s[7], P.checksum(s, 7));
  assert.throws(() => P.gamepadSetPacket({ curve: 'smooth', deadzoneMm: 2, fullMm: 1, buttonMm: 1 }));
  const pk = P.gamepadBindPackets([{ slot: 14, target: 'ly-' }, { slot: 60, target: 'a' }]);
  assert.strictEqual(pk.length, 3);
  assert.deepStrictEqual(pk[0].slice(0, 4), [0xfd, 2, 0, 56]);
  assert.strictEqual(pk[0][8 + 14], 3);
  assert.strictEqual(pk[1][8 + 4], 11);
  assert.deepStrictEqual(pk[2].slice(1, 4), [2, 112, 16]);
  const back = P.parseGamepad([0xfd, 0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 20, 0, 0x2c, 1, 100, 0]);
  assert.deepStrictEqual(back, { enabled: true, keysStopTyping: true, curve: 'aggressive', deadzoneMm: 0.2, fullMm: 3, buttonMm: 1, targetCount: 0, mouseSpeed: 0,
    square: false, snappy: false, antiDeadzone: 0, diagonalDeg: 0, points: [[0, 0], [85, 85], [170, 170], [255, 255]], outputType: 0 });
  const withMouse = P.gamepadSetPacket({ curve: 'linear', deadzoneMm: 0.3, fullMm: 3.2, buttonMm: 1.2, mouseSpeed: 1200 });
  assert.strictEqual(withMouse[18], 60);
  assert.strictEqual(P.GAMEPAD_TARGETS.indexOf('wheel-down') + 1, 33);
});

test('firmware options: packet layout, parse, validation', () => {
  const p = P.fwOptionsPacket({ capsIndicator: true, capsColor: [255, 0, 16], snapMode: 'neutral', statusGuide: false, idleMinutes: 5, layerIndicator: true });
  assert.deepStrictEqual(p.slice(0, 2), [0xfe, 1]);
  assert.deepStrictEqual(p.slice(8, 16), [1, 255, 0, 16, 1, 0, 5, 1]);
  assert.strictEqual(p[7], P.checksum(p, 7));
  assert.deepStrictEqual(P.parseFwOptions(p), { capsIndicator: true, capsColor: [255, 0, 16], snapMode: 'neutral', statusGuide: false, idleMinutes: 5, layerIndicator: true, fnHold: false, unicode: 'windows', perf: false, textTyping: 'keep',
    compatMode: false, releaseDebounceMs: 0, dimMinutes: 0, dimPercent: 30 });
  assert.throws(() => P.fwOptionsPacket({ snapMode: 'both', idleMinutes: 0 }));
  const h = P.fwOptionsPacket({ capsIndicator: false, snapMode: 'last', idleMinutes: 0, fnHold: true });
  assert.strictEqual(h[16], 1, 'fnHold is options byte 8');
  assert.strictEqual(P.parseFwOptions(h).fnHold, true);
  const q = P.fwOptionsPacket({ snapMode: 'last', idleMinutes: 0, perf: true });
  assert.strictEqual(q[18], 1, 'performance mode is options byte 10');
  assert.strictEqual(P.parseFwOptions(q).perf, true);
  assert.strictEqual(q[19], 0, 'text typing defaults to keep (0)');
  P.TEXT_TYPING_MODES.forEach((m, i) => {
    const t = P.fwOptionsPacket({ snapMode: 'last', idleMinutes: 0, textTyping: m });
    assert.strictEqual(t[19], i, `textTyping ${m} is options byte 11 = ${i}`);
    assert.strictEqual(P.parseFwOptions(t).textTyping, m);
  });
  assert.throws(() => P.fwOptionsPacket({ snapMode: 'last', idleMinutes: 0, textTyping: 'never' }), /textTyping is keep, block, stop/);
  const junk = P.fwOptionsPacket({ snapMode: 'last', idleMinutes: 0 });
  junk[19] = 7;
  assert.strictEqual(P.parseFwOptions(junk).textTyping, 'keep', 'an unknown byte reads as keep');
  assert.ok(P.parseCaps([0, 4, 0, 0, 0, 0, 0, 0, 0x80, 0]).features.includes('textTyping'), 'CAPS2 bit 7');
});

test('firmware options round 5: compatibility mode, release debounce, dim after idle (bytes 12..15)', () => {
  const base = { snapMode: 'last', idleMinutes: 10 };
  const p = P.fwOptionsPacket({ ...base, compatMode: true, releaseDebounceMs: 4, dimMinutes: 3, dimPercent: 40 });
  assert.deepStrictEqual(p.slice(20, 24), [1, 4, 3, 40], 'options bytes 12..15');
  const o = P.parseFwOptions(p);
  assert.deepStrictEqual([o.compatMode, o.releaseDebounceMs, o.dimMinutes, o.dimPercent, o.idleMinutes], [true, 4, 3, 40, 10]);
  assert.deepStrictEqual(P.fwOptionsPacket(base).slice(20, 24), [0, 0, 0, 0], 'defaults: all off (what older firmware stores)');
  assert.deepStrictEqual(P.fwOptionsPacket({ ...base, dimPercent: 50 }).slice(20, 24), [0, 0, 0, 0], 'no dim level without dim minutes');
  assert.strictEqual(P.fwOptionsPacket({ ...base, dimMinutes: 2 })[23], 30, 'dim level defaults to 30 %');
  assert.strictEqual(P.parseFwOptions(P.fwOptionsPacket(base)).dimPercent, 30, 'a stored 0 reads as the firmware default 30 %');
  assert.throws(() => P.fwOptionsPacket({ ...base, releaseDebounceMs: 11 }), /releaseDebounceMs is 0..10/);
  assert.throws(() => P.fwOptionsPacket({ ...base, releaseDebounceMs: 2.5 }), /releaseDebounceMs/);
  assert.throws(() => P.fwOptionsPacket({ ...base, dimMinutes: 256 }), /dimMinutes is 0..255/);
  assert.throws(() => P.fwOptionsPacket({ ...base, dimMinutes: 1, dimPercent: 101 }), /dimPercent is 0..100/);
  assert.throws(() => P.fwOptionsPacket({ snapMode: 'last' }), /idleMinutes/);
  const caps = P.parseCaps([0, 4, 0, 0, 0, 0, 0, 0, 0, 0x1e]).features;
  for (const f of ['compatMode', 'releaseDebounce', 'idleDim', 'resetFe']) assert.ok(caps.includes(f), `CAPS2 ${f}`);
  assert.deepStrictEqual(P.fwFactoryResetPacket().slice(0, 5), [0xfe, 17, 0x52, 0x53, 0x54], 'reset: 0xFE 17 "RST"');
  assert.ok(!P.FORBIDDEN.has(P.fwFactoryResetPacket()[0]) && P.FORBIDDEN.has(0x01), '0x01 stays refused, 0xFE 17 is allowed');
});

test('firmware options round 5: each new option only goes to firmware that has it', async () => {
  const { Keyboard } = require('../src/keyboard');
  const sent = [];
  const make = (caps2hi) => {
    const t = { async query(pkt) {
      if (pkt[0] === P.HOST.CAPS) return [0, 4, 0, 0, 0, 0, 0, 0, 0x80, caps2hi];
      if (pkt[0] === 0xfe && pkt[1] === 1) { sent.push(pkt); return pkt; }
      return P.fwOptionsPacket({ snapMode: 'last', idleMinutes: 0 });
    } };
    const kb = new Keyboard(t);
    kb.info = { custom: true };
    return kb;
  };
  for (const [change, msg] of [[{ compatMode: true }, /Compatibility mode needs/], [{ releaseDebounceMs: 3 }, /Release debounce needs/],
    [{ dimMinutes: 2 }, /Dim lighting after idle.* needs/]]) {
    await assert.rejects(make(0).setFirmwareOptions(change), msg);
  }
  assert.strictEqual(sent.length, 0, 'nothing written to older firmware');
  await make(0).setFirmwareOptions({ idleMinutes: 5, compatMode: false, releaseDebounceMs: 0, dimMinutes: 0, dimPercent: 60 });
  assert.deepStrictEqual(sent.at(-1).slice(20, 24), [0, 0, 0, 0], 'older firmware: reserved bytes stay 0');
  const o = await make(0x0e).setFirmwareOptions({ compatMode: true, releaseDebounceMs: 5, dimMinutes: 2, dimPercent: 25 });
  assert.deepStrictEqual(sent.at(-1).slice(20, 24), [1, 5, 2, 25]);
  assert.deepStrictEqual([o.compatMode, o.releaseDebounceMs, o.dimMinutes, o.dimPercent], [true, 5, 2, 25]);
  await assert.rejects(make(0x02).setFirmwareOptions({ dimMinutes: 2 }), /needs a newer/, 'compat bit alone does not allow dim');
});

test('factory reset: 0xFE 17 only on open firmware that reports it, reply checked', async () => {
  const { Keyboard } = require('../src/keyboard');
  const sent = [];
  const make = (caps2hi, ok = 1, custom = true) => {
    const t = { async query(pkt) {
      if (pkt[0] === P.HOST.CAPS) return [0, 4, 0, 0, 0, 0, 0, 0, 0, caps2hi];
      sent.push(pkt);
      return [0xfe, 17, ok];
    } };
    const kb = new Keyboard(t);
    kb.info = { custom };
    return kb;
  };
  await assert.rejects(make(0x10, 1, false).factoryReset(), /open firmware/);
  await assert.rejects(make(0x0e).factoryReset(), /newer open firmware/);
  assert.strictEqual(sent.length, 0, 'nothing sent without the caps bit');
  assert.deepStrictEqual(await make(0x10).factoryReset(), { reset: true });
  assert.deepStrictEqual(sent.at(-1).slice(0, 5), [0xfe, 17, 0x52, 0x53, 0x54]);
  await assert.rejects(make(0x10, 0).factoryReset(), /did not confirm/);
});

test('firmware options: textTyping only goes to firmware that has it', async () => {
  const { Keyboard } = require('../src/keyboard');
  const sent = [];
  const make = (caps2) => {
    const t = { async query(pkt) {
      if (pkt[0] === P.HOST.CAPS) return [0, 4, 0, 0, 0, 0, 0, 0, caps2, 0];
      if (pkt[0] === 0xfe && pkt[1] === 1) { sent.push(pkt); return pkt; }
      return P.fwOptionsPacket({ snapMode: 'last', idleMinutes: 0 });
    } };
    const kb = new Keyboard(t);
    kb.info = { custom: true };
    return kb;
  };
  await assert.rejects(make(0).setFirmwareOptions({ textTyping: 'block' }), /newer open firmware/);
  assert.strictEqual(sent.length, 0, 'nothing written to older firmware');
  assert.strictEqual((await make(0).setFirmwareOptions({ perf: true })).textTyping, 'keep', 'other options still work there');
  assert.strictEqual((await make(0x80).setFirmwareOptions({ textTyping: 'stop' })).textTyping, 'stop');
  assert.strictEqual(sent.at(-1)[19], 2);
});

test('Fn layers 2..4: same paging as user layers, sub 11 set / 12 get', () => {
  const v = Array.from({ length: 128 }, () => [0, 0, 0, 0]);
  v[3] = [11, 0, 7, 0];
  const pk = P.fnLayerPackets(3, v);
  assert.strictEqual(pk.length, 10);
  assert.deepStrictEqual(pk[0].slice(0, 4), [0xfe, 11, 3, 0]);
  assert.deepStrictEqual(pk[0].slice(8 + 12, 8 + 16), [11, 0, 7, 0]);
  assert.deepStrictEqual(P.fnLayerGetPacket(2, 4).slice(0, 4), [0xfe, 12, 2, 4]);
  assert.throws(() => P.fnLayerPackets(1, v), /stock Fn map/);
});

test('text keys: UTF-8 in 3 pages of 56 bytes, byte length in the header', () => {
  const s = 'x'.repeat(100) + '!';
  const pk = P.textPackets(9, s);
  assert.strictEqual(pk.length, 3);
  assert.deepStrictEqual(pk[1].slice(0, 5), [0xfe, 14, 9, 1, 101]);
  assert.strictEqual(pk[1][8 + 100 - 56], '!'.charCodeAt(0));
  assert.throws(() => P.textPackets(9, 'x'.repeat(120)), /120 of 119 bytes/);
  assert.throws(() => P.textPackets(64, 'a'), /0\.\.63/);
  const lenny = P.textPackets(1, '( ͡° ͜ʖ ͡°)');
  assert.strictEqual(lenny[0][4], 17, 'the Lenny face is 17 bytes of UTF-8');
  assert.deepStrictEqual(lenny[0].slice(10, 12), [0xcd, 0xa1], 'U+0361 as UTF-8');
  assert.throws(() => P.textPackets(1, '😀'.repeat(30)), /120 of 119 bytes/);
  assert.throws(() => P.textPackets(1, 'ab'), /control characters/);
  assert.strictEqual(P.parseFwOptions(P.fwOptionsPacket({ snapMode: 'last', idleMinutes: 0, unicode: 'mac' })).unicode, 'mac');
  assert.deepStrictEqual(require('../src/keys').parseKey('Text12'), [11, 0, 12, 0]);
  assert.strictEqual(require('../src/keys').slotName([11, 0, 12, 0]), 'Text12');
});

test('layers: 10 pages of 56 bytes, slot values in order', () => {
  const v = Array.from({ length: 128 }, () => [0, 0, 0, 0]);
  v[15] = [0, 0, 0x4a, 0]; v[127] = [10, 0xe0, 0xf9, 0];
  const pk = P.layerPackets(2, v);
  assert.strictEqual(pk.length, 10);
  assert.deepStrictEqual(pk[1].slice(0, 4), [0xfe, 2, 2, 1]);
  assert.strictEqual(pk[1][8 + 15 * 4 - 56 + 2], 0x4a);
  assert.deepStrictEqual(pk[9].slice(8 + 127 * 4 - 504, 8 + 127 * 4 - 504 + 4), [10, 0xe0, 0xf9, 0]);
  assert.throws(() => P.layerPackets(4, v));
});

test('gamepad plus: flags, anti-deadzone, angle, curve points at [11..22], parsed back', () => {
  const pts = [[0, 10], [40, 120], [110, 210], [255, 255]];
  const s = P.gamepadSetPacket({ curve: 'custom', deadzoneMm: 0.3, fullMm: 3.2, buttonMm: 1.2, square: true, snappy: true,
    antiDeadzone: 20, diagonalDeg: 30, points: pts });
  assert.strictEqual(s[10], 4, 'curve 4 = custom');
  assert.deepStrictEqual(s.slice(19, 31), [3, 20, 30, 0, 10, 40, 120, 110, 210, 255, 255, 0]);
  const r = [...s]; r[17] = 33;   // the GET reply echoes [11..22]; [9] is the target count
  const back = P.parseGamepad(r);
  assert.deepStrictEqual({ ...back, targetCount: undefined, mouseSpeed: undefined },
    { enabled: false, keysStopTyping: false, curve: 'custom', deadzoneMm: 0.3, fullMm: 3.2, buttonMm: 1.2, targetCount: undefined,
      mouseSpeed: undefined, square: true, snappy: true, antiDeadzone: 20, diagonalDeg: 30, points: pts, outputType: 0 });
  assert.throws(() => P.gamepadSetPacket({ curve: 'linear', deadzoneMm: 0.3, fullMm: 3.2, buttonMm: 1.2, antiDeadzone: 101 }));
  assert.throws(() => P.gamepadSetPacket({ curve: 'linear', deadzoneMm: 0.3, fullMm: 3.2, buttonMm: 1.2, diagonalDeg: 5 }));
  assert.ok(P.HOST_CAPS2 ? P.HOST_CAPS2.includes('gamepadPlus') : P.parseCaps([0, 4, 0, 0, 0, 0, 0, 0, 0, 1]).features.includes('gamepadPlus'));
});
