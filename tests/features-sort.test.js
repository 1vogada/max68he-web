// Features page: sort and filter (web/features-core.js view / inUse)
const test = require('node:test');
const assert = require('node:assert');
const C = require('../web/features-core');

const F = [
  { id: 'macros', name: 'Macros', description: 'stored key sequences', group: 'input', cost: { flash: 3000, ram: 100 } },
  { id: 'fx', name: 'Key effects', description: 'reactive lighting', group: 'lighting', cost: { flash: 9000, ram: 50 } },
  { id: 'games', name: 'Games', description: 'snake', group: 'games', cost: { flash: 5000, ram: 900 } },
  { id: 'watchdog', name: 'Watchdog', description: 'restarts a hung keyboard', group: 'system' },
];
const ids = (sections) => sections.map((s) => [s.id, s.features.map((f) => f.id)]);

test('inUse: true when the rule fires, false when known and quiet, null when unknown', () => {
  assert.strictEqual(C.inUse(F[0], { macros: 2 }), true);
  assert.strictEqual(C.inUse(F[0], { macros: 0 }), false);
  assert.strictEqual(C.inUse(F[0], {}), null);
  assert.strictEqual(C.inUse(F[1], { lightingMode: 0x44 }), true);
  assert.strictEqual(C.inUse(F[2], { macros: 2 }), null);       // no use check for games
  assert.strictEqual(C.inUse(F[3], {}), true);
});

test('in use first: used, not used, unknown, each by name', () => {
  assert.deepStrictEqual(ids(C.view(F, { sort: 'use' }, { macros: 1, lightingMode: 0 })),
    [['used', ['macros', 'watchdog']], ['unused', ['fx']], ['unknown', ['games']]]);
  assert.deepStrictEqual(ids(C.view(F, {}, {})), [['used', ['watchdog']], ['unknown', ['games', 'fx', 'macros']]]);
});

test('flash / RAM: biggest saving first, no cost last', () => {
  assert.deepStrictEqual(ids(C.view(F, { sort: 'flash' })), [['all', ['fx', 'games', 'macros', 'watchdog']]]);
  assert.deepStrictEqual(ids(C.view(F, { sort: 'ram' })), [['all', ['games', 'macros', 'fx', 'watchdog']]]);
});

test('name and group', () => {
  assert.deepStrictEqual(ids(C.view(F, { sort: 'name' })), [['all', ['games', 'fx', 'macros', 'watchdog']]]);
  assert.deepStrictEqual(ids(C.view(F, { sort: 'group' })),
    [['lighting', ['fx']], ['input', ['macros']], ['system', ['watchdog']], ['games', ['games']]]);
});

test('filter searches name and description; off only', () => {
  assert.deepStrictEqual(ids(C.view(F, { sort: 'name', filter: ' LIGHT ' })), [['all', ['fx']]]);
  assert.deepStrictEqual(ids(C.view(F, { sort: 'name', filter: 'snake' })), [['all', ['games']]]);
  assert.deepStrictEqual(C.view(F, { sort: 'name', filter: 'nothing like it' }), []);
  assert.deepStrictEqual(ids(C.view(F, { sort: 'name', offOnly: true }, {}, { games: false, fx: true })), [['all', ['games']]]);
});

test('every sort is offered', () => {
  assert.deepStrictEqual(C.SORTS.map(([v]) => v), ['use', 'flash', 'ram', 'name', 'group']);
});

// shaped like the real keyboard's GET /api/key-actions (Mouse + Tilde modes, notHeld, pressure mouse keys)
const KA = {
  info: { entries: 16, used: 3, engine: 5, modes: 3 },
  maps: [
    { key: 'Esc', slot: 1, rules: [{ when: 'press', if: { mode: 'Mouse' }, do: { mode: 'Mouse', action: 'leave' } },
      { when: 'tap', ms: 3000, if: { notHeld: ['Fn'], mode: 'Tilde' }, do: { key: '`' } }] },
    { key: 'RShift', slot: 76, rules: [{ when: 'press', if: { mode: 'Mouse' }, do: { mouse: 'L' } }] },
    { key: 'W', slot: 30, rules: [{ when: 'press', if: { mode: 'Mouse' }, do: { move: 'up', speedBy: 'pressure' } }] },
  ],
  modes: [{ id: 1, name: 'Mouse', active: false }, { id: 2, name: 'Tilde', active: false }, { id: 3, name: '', active: false }],
};

test('use from the real key-actions answer: maps, modes, mouse keys, pressure speed', () => {
  assert.deepStrictEqual(C.useFromKeyActions(KA),
    { keyActionMaps: 3, glideActions: 0, mouseActions: 2, pressureMouse: 1, modes: 2 });
  assert.deepStrictEqual(C.useFromKeyActions({}), { keyActionMaps: 0, glideActions: 0, mouseActions: 0, pressureMouse: 0, modes: 0 });
  const use = { ...C.useFromKeyActions(KA), lightingMode: 66 };
  const f = (id) => ({ id, name: id });
  for (const id of ['keyact', 'modes', 'mousekeys', 'mk_pressure', 'droplet']) assert.strictEqual(C.inUse(f(id), use), true, id);
  for (const id of ['glide', 'fx', 'pfx']) assert.strictEqual(C.inUse(f(id), use), false, id);
});

test('use from the advanced keys list', () => {
  assert.deepStrictEqual(C.useFromAdvanced([{ kind: 'dks', levels: [1, 2, 3] }, { kind: 'dks', levels: [1, 2] }, { kind: 'snap' }, { kind: 'rt' }]),
    { dksKeys: 2, dksMultiLevel: 1, advancedKeys: 1 });
  assert.deepStrictEqual(C.useFromAdvanced(), { dksKeys: 0, dksMultiLevel: 0, advancedKeys: 0 });
});
