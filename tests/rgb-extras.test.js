// Pure helpers behind the web UI's effect presets, recent colours and active advanced keys list.
const test = require('node:test');
const assert = require('node:assert');
const presets = require('../web/effect-presets');
const recent = require('../web/recent-colours');
const active = require('../web/adv-active');

const STOCK = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 19];

test('presets: stock firmware gets only presets with a stock effect, falling back where listed', () => {
  const got = presets.presetsFor(STOCK.map(String));
  const names = got.map((p) => p.name);
  assert.deepStrictEqual(names, ['Calm rainbow', 'Reactive white', 'Focus orange', 'Ocean breathing', 'Off']);
  assert.strictEqual(got.find((p) => p.name === 'Reactive white').mode, 5);   // Ripple instead of open Reactive
});

test('presets: open firmware uses its own effects first and adds the depth ones', () => {
  const open = [...STOCK, 0x40, 0x42, 0x43, 0x46, 0x49, 0x4a];
  const got = Object.fromEntries(presets.presetsFor(open).map((p) => [p.name, p.mode]));
  assert.strictEqual(got['Reactive white'], 0x43);
  assert.strictEqual(got['Press depth'], 0x46);
  assert.strictEqual(got.Fire, 0x49);
  // base open firmware (no fx effects): Droplet still gives a depth preset
  assert.strictEqual(Object.fromEntries(presets.presetsFor([...STOCK, 0x40, 0x42]).map((p) => [p.name, p.mode]))['Press depth'], 0x42);
  assert.deepStrictEqual(presets.presetsFor([]), []);
});

test('presets: toLighting gives the form a full lighting state', () => {
  const [orange] = presets.presetsFor([1]).filter((p) => p.name === 'Focus orange');
  assert.deepStrictEqual(presets.toLighting(orange), { mode: 1, option: 0, brightness: 3, speed: 0, r: 255, g: 138, b: 61, rainbow: false, presetColour: null });
  const [calm] = presets.presetsFor([4]);
  // rainbow keeps the colour the form had
  assert.deepStrictEqual(presets.toLighting(calm, { r: 1, g: 2, b: 3 }), { mode: 4, option: 0, brightness: 2, speed: 0, r: 1, g: 2, b: 3, rainbow: true, presetColour: null });
});

test('recent colours: newest first, deduped, case folded, capped, junk ignored', () => {
  assert.strictEqual(recent.normHex('#AbC123'), '#abc123');
  assert.strictEqual(recent.normHex('abc123'), '#abc123');
  for (const bad of ['', null, '#abc', 'red', '#12345g', 42]) assert.strictEqual(recent.normHex(bad), null);
  assert.deepStrictEqual(recent.pushRecent([], '#FF0000'), ['#ff0000']);
  assert.deepStrictEqual(recent.pushRecent(['#00ff00', '#ff0000'], '#FF0000'), ['#ff0000', '#00ff00']);
  assert.deepStrictEqual(recent.pushRecent(['#00ff00', 'junk'], 'nope'), ['#00ff00']);
  let list = [];
  for (let i = 0; i < 12; i++) list = recent.pushRecent(list, `#0000${i.toString(16).padStart(2, '0')}`);
  assert.strictEqual(list.length, recent.MAX);
  assert.strictEqual(list[0], '#00000b');
  assert.deepStrictEqual(recent.pushRecent(null, null), []);
});

test('active advanced keys: a snap tap pair is one row, others one row each, by slot', () => {
  const list = [
    { slot: 9, kind: 'snap', partner: 2, keys: ['d'] },
    { slot: 2, kind: 'snap', partner: 9, keys: ['a'] },
    { slot: 5, kind: 'modtap', keys: ['lctrl', 'esc'], holdMs: 200 },
    { slot: 1, kind: 'toggleRepeat', keys: ['lshift'] },
    { slot: 7, kind: 'snap', partner: 30, keys: ['x'] },   // partner not snap any more: keep the row
  ];
  assert.deepStrictEqual(active.activeRows(list).map((a) => a.slot), [1, 2, 5, 7]);
  assert.deepStrictEqual(active.activeRows([]), []);
});

test('active advanced keys: row text', () => {
  const name = (s) => ({ 1: 'Caps', 2: 'A', 9: 'D', 5: 'Esc', 6: 'F' }[s] ?? `slot ${s}`);
  assert.strictEqual(active.summary({ slot: 2, kind: 'snap', partner: 9 }, name), 'A ↔ D');
  assert.strictEqual(active.summary({ slot: 5, kind: 'modtap', keys: ['lctrl', 'esc'], holdMs: 200 }, name), 'Esc: hold lctrl, tap esc (200 ms)');
  assert.strictEqual(active.summary({ slot: 1, kind: 'toggleRepeat', keys: ['lshift'] }, name), 'Caps: toggles lshift, repeating');
  assert.strictEqual(active.summary({ slot: 6, kind: 'dks', keys: ['f', 'none'], firstPointMm: 0.5, secondPointMm: 2 }, name), 'F: 0.5–2 mm, f');
  assert.strictEqual(active.summary({ slot: 6, kind: 'dks', keys: ['none'], levels: [{ depthMm: 1 }] }, name), 'F: 1 level, no keys');
});
