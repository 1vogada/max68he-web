// Multi-level DKS (open firmware 0xFE 9/10) against a fake board that stores records
// the way firmware/common/dks.c does.
const test = require('node:test');
const assert = require('node:assert');
const P = require('../src/protocol');
const { keyToMods, modsToName } = require('../src/keys');
const { Keyboard } = require('../src/keyboard');

function fakeBoard({ levels = true } = {}) {
  const mode = new Array(128).fill(0);
  mode[9] = 0x80;                                    // rapid trigger on
  const recs = {};
  const sent = [];
  const reply = (slot) => {
    const out = new Array(64).fill(0);
    out[0] = 0xfe; out[1] = 9; out[2] = slot;
    const r = recs[slot];
    out[5] = 8; out[6] = (mode[slot] & 0x3f) === 2 ? 1 : 0;
    if (r) { out[3] = r.n; out[4] = r.gap; r.data.forEach((b, i) => { out[8 + i] = b; }); }
    return out;
  };
  const t = {
    async query(pkt) {
      sent.push(pkt);
      if (pkt[0] === 0xf8) {                         // CAPS: api 4, CAPS2 bit 1 = DKS levels
        const out = new Array(64).fill(0);
        out[1] = 4; out[8] = levels ? 2 : 0;
        return out;
      }
      if (pkt[0] === 0xfe && pkt[1] === 10) {
        const slot = pkt[2];
        if (pkt[3] === 0) { delete recs[slot]; mode[slot] &= ~0x3f; } else {
          recs[slot] = { n: pkt[3], gap: pkt[4], data: pkt.slice(8, 64) };
          mode[slot] = (mode[slot] & ~0x3f) | 2;
        }
        return reply(slot);
      }
      if (pkt[0] === 0xfe && pkt[1] === 9) return reply(pkt[2]);
      return [pkt[0], 0, 0, 1, 2, 1, 0, 0];
    },
    async queryPage(pkt) {
      const out = new Array(64).fill(0);
      if (pkt[0] === 0xe5 && pkt[1] === 7) for (let i = 0; i < 64; i++) out[i] = mode[pkt[3] * 64 + i] ?? 0;
      return out;
    },
    async writeSetting() {},
    async flash() {},
    close() {},
  };
  const kb = new Keyboard(t);
  kb.info = { unitMm: 0.005, custom: true };
  return { kb, sent, recs, mode };
}

test('key names <-> modifier bits + one key', () => {
  assert.deepStrictEqual(keyToMods('W'), { mods: 0, usage: 0x1a });
  assert.deepStrictEqual(keyToMods('LShift'), { mods: 0x02, usage: 0 });
  assert.deepStrictEqual(keyToMods('Ctrl+Shift+Esc'), { mods: 0x03, usage: 0x29 });
  assert.deepStrictEqual(keyToMods('none'), { mods: 0, usage: 0 });
  assert.strictEqual(modsToName({ mods: 0x03, usage: 0x29 }), 'LCtrl+LShift+Esc');
  assert.strictEqual(modsToName({ mods: 0, usage: 0 }), 'none');
  assert.throws(() => keyToMods('VolumeUp'), /keyboard key/);
  assert.throws(() => keyToMods('A+B'), /one key/);
});

test('write packet: header, keys at 8, levels of 6 bytes at 16, actions down | up << 4', () => {
  const p = P.dksWritePacket(3, {
    keys: [{ mods: 0, usage: 4 }, { mods: 2, usage: 0 }],
    levels: [{ depthMm: 0.5, actions: [{ down: 'tap', up: 'hold' }] }, { depthMm: 2.25, actions: [{}, { down: 'release' }] }],
    gapMm: 0.15,
  });
  assert.deepStrictEqual(p.slice(0, 5), [0xfe, 10, 3, 2, 15]);
  assert.deepStrictEqual(p.slice(8, 12), [0, 4, 2, 0]);
  assert.deepStrictEqual(p.slice(16, 22), [50, 0, 0x31, 0, 0, 0]);
  assert.deepStrictEqual(p.slice(22, 28), [225, 0, 0, 4, 0, 0]);
});

test('write packet validation', () => {
  const l = (depthMm) => ({ depthMm, actions: [] });
  assert.throws(() => P.dksWritePacket(1, { levels: [l(1), l(0.5)] }), /deeper/);
  assert.throws(() => P.dksWritePacket(1, { levels: [l(0.01)] }), /depth/);
  assert.throws(() => P.dksWritePacket(1, { levels: Array.from({ length: 9 }, (_, i) => l(0.1 + i * 0.2)) }), /at most 8/);
  assert.throws(() => P.dksWritePacket(1, { levels: [{ depthMm: 1, actions: [{ down: 'smash' }] }] }), /action/);
});

test('setDksLevels round-trips through the board, keeps rapid trigger, shows in the list', async () => {
  const { kb, mode } = fakeBoard();
  const levels = [1, 2, 3, 3.5].map((depthMm, i) => ({ depthMm, actions: [{ down: i === 0 ? 'hold' : 'none', up: i === 3 ? 'tap' : 'none' }] }));
  const d = await kb.setDksLevels(9, { keys: ['W', 'Ctrl+C'], levels, gapMm: 0.2 });
  assert.strictEqual(d.levels.length, 4);
  assert.deepStrictEqual(d.keys, ['W', 'LCtrl+C', 'none', 'none']);
  assert.strictEqual(d.levels[0].actions[0].down, 'hold');
  assert.strictEqual(d.levels[3].actions[0].up, 'tap');
  assert.strictEqual(mode[9], 0x82);
  const list = await kb.getAdvancedKeys(0);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].kind, 'dks');
  assert.strictEqual(list[0].levels.length, 4);
  assert.strictEqual(list[0].gapMm, 0.2);
});

test('clearAdvanced removes the levels and the DKS kind', async () => {
  const { kb, recs, mode } = fakeBoard();
  await kb.setDksLevels(9, { keys: ['A'], levels: [{ depthMm: 1, actions: [{ down: 'tap' }] }] });
  await kb.clearAdvanced(9);
  assert.strictEqual(recs[9], undefined);
  assert.strictEqual(mode[9], 0x80);
});

test('needs the DKS-levels firmware and at least one bound key', async () => {
  const { kb } = fakeBoard({ levels: false });
  await assert.rejects(kb.setDksLevels(9, { keys: ['A'], levels: [{ depthMm: 1 }] }), /open firmware/);
  const b = fakeBoard();
  await assert.rejects(b.kb.setDksLevels(9, { keys: ['none'], levels: [{ depthMm: 1 }] }), /at least one key/);
});
