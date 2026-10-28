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
    compatMode: false, releaseDebounceMs: 0, dimMinutes: 0, dimPercent: 30, holdBar: true, holdBarColor: [0, 255, 0], holdBarEscColor: [255, 0, 0],
    modeFlash: [1, 2, 3].map((mode) => ({ mode, enter: true, enterColor: [0, 255, 0], leave: true, leaveColor: [64, 64, 64] })) });
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

test('hold progress bar: options bytes 16..19, defaults from 0s, caps word 3 bit 8, only to firmware that has it', async () => {
  const base = { snapMode: 'last', idleMinutes: 0 };
  assert.deepStrictEqual(P.fwOptionsPacket(base).slice(24, 28), [0, 0, 255, 0], 'default: on (bit0 = 0), green');
  const p = P.fwOptionsPacket({ ...base, holdBar: false, holdBarColor: [255, 16, 1] });
  assert.deepStrictEqual(p.slice(24, 28), [1, 255, 16, 1], 'off = bit0, colour at 17..19');
  assert.deepStrictEqual([P.parseFwOptions(p).holdBar, P.parseFwOptions(p).holdBarColor], [false, [255, 16, 1]]);
  const old = P.fwOptionsPacket(base); old.fill(0, 24, 28);                   // older firmware / image: no such bytes
  assert.deepStrictEqual([P.parseFwOptions(old).holdBar, P.parseFwOptions(old).holdBarColor], [true, [0, 255, 0]], '0s read as on, green');
  const w3 = (v) => P.parseCaps([0, 4, 0, 0, 0, 0, 0, 0, 0, 0, v & 0xff, v >> 8]).features;
  assert.ok(w3(0xc100).includes('holdBar') && !w3(0xc000).includes('holdBar') && !w3(0x8100).includes('holdBar'), 'CAPS3 bit 8 (with the build bit)');
  const { Keyboard } = require('../src/keyboard');
  const sent = [];
  const make = (caps3) => {
    const t = { async query(pkt) {
      if (pkt[0] === P.HOST.CAPS) return [0, 4, 0, 0, 0, 0, 0, 0, 0, 0, caps3 & 0xff, caps3 >> 8];
      if (pkt[0] === 0xfe && pkt[1] === 1) { sent.push(pkt); return pkt; }
      return P.fwOptionsPacket(base);
    } };
    const kb = new Keyboard(t);
    kb.info = { custom: true };
    return kb;
  };
  await assert.rejects(make(0).setFirmwareOptions({ holdBar: false }), /Hold progress bar needs/);
  assert.deepStrictEqual(P.fwOptionsPacket(base).slice(28, 32), [255, 0, 0, 0], 'Esc colour bytes 20..22 default red, 23 = 0');
  const e = P.fwOptionsPacket({ ...base, holdBarEscColor: [1, 2, 3] });
  assert.deepStrictEqual([e.slice(28, 32), P.parseFwOptions(e).holdBarEscColor], [[1, 2, 3, 0], [1, 2, 3]]);
  const z = P.fwOptionsPacket(base); z.fill(0, 28, 32);
  assert.deepStrictEqual(P.parseFwOptions(z).holdBarEscColor, [255, 0, 0], 'Esc colour 0s read as red');
  for (const len of [16, 20]) { const r = P.fwOptionsPacket(base); r[2] = len; assert.ok(!('holdBarEscColor' in P.parseFwOptions(r)), `[2] = ${len}: no Esc colour`); }
  const r24 = P.fwOptionsPacket(base); r24[2] = 24; assert.ok(P.parseFwOptions(r24).holdBarEscColor, '[2] = 24: Esc colour');
  await assert.rejects(make(0).setFirmwareOptions({ holdBarColor: [1, 2, 3] }), /Hold progress bar needs/);
  assert.strictEqual(sent.length, 0);
  const o = await make(0xc100).setFirmwareOptions({ holdBar: false, holdBarColor: [0, 0, 255] });
  assert.deepStrictEqual(sent.at(-1).slice(24, 28), [1, 0, 0, 255]);
  assert.deepStrictEqual([o.holdBar, o.holdBarColor], [false, [0, 0, 255]]);
  await make(0xc100).setFirmwareOptions({ holdBarEscColor: [9, 8, 7] });
  assert.deepStrictEqual(sent.at(-1).slice(28, 31), [9, 8, 7], 'Esc colour written');
  const pre = (() => { const t = { async query(pkt) {
    if (pkt[0] === P.HOST.CAPS) return [0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0x00, 0xc1];
    if (pkt[0] === 0xfe && pkt[1] === 1) { sent.push(pkt); return pkt; }
    const r = P.fwOptionsPacket(base); r[2] = 20; return r;
  } }; const kb = new Keyboard(t); kb.info = { custom: true }; return kb; })();
  const n = sent.length;
  await assert.rejects(pre.setFirmwareOptions({ holdBarEscColor: [1, 1, 1] }), /Esc colour needs a newer/);
  assert.strictEqual(sent.length, n, 'nothing written to firmware without the Esc colour');
});

// firmware 0xFE as vendor_proto.c does it: GET answers [2] = its option length and the bytes at [8..];
// SET stores exactly that many bytes from [8..] (the rest of the report is ignored) and echoes them
function optionsFirmware({ len = P.FW_OPTS_LEN, caps3 = 0xc300, stored } = {}) {
  const sent = [];
  let opts = stored ?? [0, 255, 255, 255, 0, 0, 0, 0, ...new Array(len - 8).fill(0)];
  const reply = () => { const r = new Array(64).fill(0); r[0] = 0xfe; r[2] = len; r.splice(8, len, ...opts); return r; };
  const t = { async query(pkt) {
    if (pkt[0] === P.HOST.CAPS) return [0, 4, 0, 0, 0, 0, 0, 0, 0x80, 0x0e, caps3 & 0xff, caps3 >> 8];   // + textTyping, compat, debounce, dim
    if (pkt[0] === 0xfe && pkt[1] === 1) { sent.push(pkt); opts = pkt.slice(8, 8 + len); }
    return reply();
  } };
  const kb = new Keyboard(t);
  kb.info = { custom: true };
  return { kb, sent, opts: () => opts };
}

test('mode flash: options bytes 24..43 (off bits, enter / leave colours per mode), encode / decode round trip', () => {
  const base = { snapMode: 'last', idleMinutes: 0 };
  const dflt = (mode) => ({ mode, enter: true, enterColor: [0, 255, 0], leave: true, leaveColor: [64, 64, 64] });
  assert.deepStrictEqual(P.fwOptionsPacket(base).slice(32, 52), new Array(20).fill(0), 'no modeFlash: the packet ends at byte 23');
  const all = P.fwOptionsPacket({ ...base, modeFlash: [1, 2, 3].map(dflt) });
  assert.deepStrictEqual(all.slice(32, 52), new Array(20).fill(0), 'defaults go as 0 (all on, 0,0,0 colours)');
  const list = [{ ...dflt(1), enter: false, leaveColor: [1, 2, 3] }, { ...dflt(2), enterColor: [0, 0, 255], leave: false },
    { ...dflt(3), enter: false, leave: false, enterColor: [9, 9, 9], leaveColor: [255, 0, 0] }];
  const p = P.fwOptionsPacket({ ...base, modeFlash: list });
  const o = p.slice(8, 52);
  assert.strictEqual(o[24], 0x01 | 0x20 | 0x04 | 0x40, 'bit n-1 = no enter flash, bit n+3 = no leave flash');
  assert.deepStrictEqual([o.slice(25, 28), o.slice(28, 31)], [[0, 0, 0], [1, 2, 3]], 'mode 1 at 25 / 28');
  assert.deepStrictEqual([o.slice(31, 34), o.slice(34, 37)], [[0, 0, 255], [0, 0, 0]], 'mode 2 at 31 / 34');
  assert.deepStrictEqual([o.slice(37, 40), o.slice(40, 43), o[43]], [[9, 9, 9], [255, 0, 0], 0], 'mode 3 at 37 / 40, 43 reserved');
  assert.deepStrictEqual(P.parseFwOptions(p).modeFlash, list, 'round trip');
  assert.deepStrictEqual(P.parseModeFlash(new Array(44).fill(0)), [1, 2, 3].map(dflt), '0s read as on, green / dim white');
  // the firmware's own example: mode 2 blue on, dark red off
  const fw = new Array(44).fill(0); fw[33] = 0xff; fw[34] = 0x20;
  assert.deepStrictEqual(P.parseModeFlash(fw)[1], { mode: 2, enter: true, enterColor: [0, 0, 255], leave: true, leaveColor: [0x20, 0, 0] });
  // option length: 44 has modeFlash, 16 / 20 / 24 (firmware before it) leave it out
  for (const len of [16, 20, 24]) { const r = P.fwOptionsPacket(base); r[2] = len; assert.ok(!('modeFlash' in P.parseFwOptions(r)), `[2] = ${len}: no modeFlash`); }
  const r44 = P.fwOptionsPacket(base); r44[2] = 44; assert.ok(P.parseFwOptions(r44).modeFlash, '[2] = 44: modeFlash');
  // merging changes: per mode, per field; bad values throw
  const m = P.mergeModeFlash(list, [{ mode: 2, leave: true }, { mode: 3, enterColor: [1, 1, 1] }]);
  assert.deepStrictEqual(m, [list[0], { ...list[1], leave: true }, { ...list[2], enterColor: [1, 1, 1] }]);
  for (const [bad, re] of [[[{ mode: 1, enterColor: [0, 0, 0] }], /black/], [[{ mode: 4 }], /mode is 1..3/], [[{ mode: 1, blink: true }], /unknown field "blink"/],
    [[{ mode: 1, enter: 1 }], /enter is true or false/], [[{ mode: 1, leaveColor: [1, 2] }], /leaveColor is \[r, g, b\]/], [[{ mode: 1 }, { mode: 1 }], /twice/], [{ mode: 1 }, /a list/]]) {
    assert.throws(() => P.mergeModeFlash(list, bad), re, JSON.stringify(bad));
  }
});

test('mode flash: caps word 3 bit 9 (with bit 15), only to firmware that has it', async () => {
  const w3 = (v) => P.parseCaps([0, 4, 0, 0, 0, 0, 0, 0, 0, 0, v & 0xff, v >> 8]).features;
  assert.ok(w3(0x8200).includes('modeFlash') && w3(0xc200).includes('modeFlash'), 'bit 15 + bit 9');
  assert.ok(!w3(0x0200).includes('modeFlash') && !w3(0x8000).includes('modeFlash') && !w3(0xc100).includes('modeFlash'), 'no word 3 / no bit 9');
  // caps without bit 9: refused before anything is written
  for (const caps3 of [0xc100, 0]) {
    const f = optionsFirmware({ caps3 });
    await assert.rejects(f.kb.setFirmwareOptions({ modeFlash: [{ mode: 1, enter: false }] }), /Mode flash needs a newer open firmware \(feature "modeFlash"\)/);
    assert.strictEqual(f.sent.length, 0, `caps3 ${caps3.toString(16)}: nothing written`);
  }
  // bad changes: nothing written either
  const f = optionsFirmware();
  await assert.rejects(f.kb.setFirmwareOptions({ modeFlash: [{ mode: 2, leaveColor: [0, 0, 0] }] }), (e) => /black/.test(e.message) && e.status === 400);
  assert.strictEqual(f.sent.length, 0);
});

test('mode flash: read-modify-write keeps bytes 0..23 and the other modes', async () => {
  const stored = [1, 255, 0, 16, 3, 1, 7, 1, 1, 2, 0, 1, 1, 4, 3, 40, 1, 9, 8, 7, 6, 5, 4, 0,
    0x10, 1, 2, 3, 4, 5, 6, 0, 0, 0, 0, 0, 0, 11, 12, 13, 14, 15, 16, 0];
  const f = optionsFirmware({ stored: [...stored] });
  const o = await f.kb.setFirmwareOptions({ modeFlash: [{ mode: 2, enter: false, enterColor: [0, 0, 255] }] });
  const w = f.sent.at(-1);
  assert.deepStrictEqual(w.slice(8, 32), stored.slice(0, 24), 'bytes 0..23 written back as read');
  assert.strictEqual(w[8 + 24], 0x10 | 0x02, 'mode 1 leave off kept, mode 2 enter off added');
  assert.deepStrictEqual(w.slice(8 + 25, 8 + 31), stored.slice(25, 31), 'mode 1 colours kept');
  assert.deepStrictEqual(w.slice(8 + 31, 8 + 37), [0, 0, 255, 0, 0, 0], 'mode 2 enter colour');
  assert.deepStrictEqual(w.slice(8 + 37, 8 + 44), stored.slice(37, 44), 'mode 3 colours kept, 43 = 0');
  assert.deepStrictEqual(o.modeFlash[1], { mode: 2, enter: false, enterColor: [0, 0, 255], leave: true, leaveColor: [64, 64, 64] }, 'the echo, parsed');
  // another option changes: the mode flash bytes go back as they were
  await f.kb.setFirmwareOptions({ idleMinutes: 9 });
  assert.deepStrictEqual(f.sent.at(-1).slice(8 + 24, 8 + 44), f.sent.at(-2).slice(8 + 24, 8 + 44));
  assert.strictEqual(f.sent.at(-1)[8 + 6], 9);
  // a 44-byte firmware built without MODEFLASH (no caps bit): changes refused, the stored bytes kept on other writes
  const g = optionsFirmware({ caps3: 0xc100, stored: [...stored] });
  await g.kb.setFirmwareOptions({ idleMinutes: 1 });
  assert.deepStrictEqual(g.opts().slice(24), stored.slice(24), 'mode flash bytes untouched');
});

test('mode flash: firmware with 24 option bytes gets exactly 24 (old firmware path)', async () => {
  const stored = [0, 255, 255, 255, 1, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 0, 255, 0, 0, 0];
  const f = optionsFirmware({ len: 24, caps3: 0xc300, stored: [...stored] });
  const o = await f.kb.setFirmwareOptions({ idleMinutes: 3 });
  assert.ok(!('modeFlash' in o), 'no modeFlash read back');
  const w = f.sent.at(-1);
  assert.deepStrictEqual(w.slice(8, 32), [...stored.slice(0, 6), 3, ...stored.slice(7)], 'its 24 bytes');
  assert.deepStrictEqual(w.slice(32), new Array(32).fill(0), 'nothing past byte 23');
  await assert.rejects(f.kb.setFirmwareOptions({ modeFlash: [{ mode: 1, enter: false }] }), /Mode flash needs a newer/, 'even with the caps bit');
  assert.strictEqual(f.sent.length, 1, 'refused before writing');
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
