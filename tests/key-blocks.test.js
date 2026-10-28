// Key wizard "Blocks" view (web/key-blocks-compile.js, web/key-blocks-core.js): Ivo's mouse-mode
// example built from generic blocks compiles to the contract's exact JSON (key-modes-spec.md),
// rules -> blocks -> rules round trips, and what the keyboard can't do becomes a block warning.
const test = require('node:test');
const assert = require('node:assert');
const K = require('../web/key-blocks-core');
const B = require('../web/key-blocks-compile');

const MODES = [{ id: 1, name: 'Mouse' }, { id: 2, name: '' }, { id: 3, name: '' }];
let n = 0;
const blk = (type, fields = {}, more = {}) => ({ type, id: `b${++n}`, fields, ...more });
const chain = (...list) => { for (let i = 0; i < list.length - 1; i++) list[i].next = { block: list[i + 1] }; return list[0]; };
const remap = (key, target) => blk('kb_remap', { MODE: '1', KEY: key, TARGET: target });

// the example as a user drags it: three stacks on the workspace
function exampleWorkspace() {
  const hold = blk('kb_when_held', { KEY: 'M', SECS: 3 }, { x: 20, y: 20 });
  hold.next = { block: blk('kb_if', {}, { inputs: {
    COND: { block: blk('kb_and', {}, { inputs: { A: { block: blk('kb_held', { KEY: 'Fn' }) }, B: { block: blk('kb_held', { KEY: 'LCtrl' }) } } }) },
    DO: { block: blk('kb_mode', { OP: 'enter', MODE: '1' }) } } }) };
  const remaps = Object.assign(chain(remap('RShift', 'mouse:L'), remap('PgDn', 'mouse:R'), remap('Up', 'mk:up'), remap('Down', 'mk:down'),
    remap('Left', 'mk:left'), remap('Right', 'mk:right')), { x: 20, y: 200 });
  const esc = blk('kb_when_pressed', { KEY: 'Esc' }, { x: 20, y: 600 });
  esc.next = { block: blk('kb_while_mode', { MODE: '1' }, { inputs: { DO: { block: blk('kb_mode', { OP: 'leave', MODE: '1' }) } } }) };
  return { blocks: { languageVersion: 0, blocks: [esc, remaps, hold] } };   // creation order differs from reading order
}

const EXAMPLE = [
  { key: 'M', rules: [{ when: 'hold', ms: 3000, if: { held: ['Fn', 'LCtrl'] }, do: { mode: 'Mouse', action: 'enter' } }] },
  { key: 'RShift', rules: [{ when: 'press', if: { mode: 'Mouse' }, do: { mouse: 'L' } }] },
  { key: 'PgDn', rules: [{ when: 'press', if: { mode: 'Mouse' }, do: { mouse: 'R' } }] },
  // Ivo's example shares the speed between the arrows (the blocks' default)
  ...['Up', 'Down', 'Left', 'Right'].map((key) => ({ key, rules: [{ when: 'press', mode: 'while', if: { mode: 'Mouse' }, do: { mouseKeys: key.toLowerCase(), shareSpeed: true, keepMs: 150 } }] })),
  { key: 'Esc', rules: [{ when: 'press', if: { mode: 'Mouse' }, do: { mode: 'Mouse', action: 'leave' } }] },
];

test('the mouse-mode example: workspace JSON -> compile -> the contract\'s exact example JSON', () => {
  const r = B.compile(exampleWorkspace(), { modes: MODES });
  assert.deepStrictEqual(r.warnings, {});
  assert.strictEqual(JSON.stringify(r.batch()), JSON.stringify({ maps: EXAMPLE }), 'same JSON text, key order included');
  assert.deepStrictEqual(r.batch({ stored: ['M', 'W'] }).remove, ['W'], 'keys that lose every block are removed');
});

test('rules -> blocks -> rules round trips (no saved workspace: rebuilt from the keyboard)', () => {
  const ws = B.decompile(EXAMPLE, MODES);
  assert.ok(ws.blocks.blocks.some((b) => b.type === 'kb_remap'), 'mode-gated presses come back as "acts as" blocks');
  assert.deepStrictEqual(B.compile(ws, { modes: MODES }).batch(), { maps: EXAMPLE });
  const odd = [{ key: 'W', press: 0.5, rules: [
    { when: 'down', at: 2.5, do: { axis: 'LY-', percent: 100 } },
    { when: 'hold', ms: 500, mode: 'toggle', if: { held: ['LShift'], notMode: 'Mouse' }, do: { key: 'E' } },
    { when: 'press', if: { mode: 'Mouse' }, do: { mouseKeys: 'wheelDown', start: 3, max: 20, rampMs: 400, curve: 'expo', power: 3 } },
    { when: 'tap', ms: 200, do: { glide: [100, -50], ms: 300 } },
  ] }];
  const back = B.compile(B.decompile(odd, MODES), { modes: MODES });
  assert.deepStrictEqual(back.warnings, {});
  assert.deepStrictEqual(back.batch({ keyOpts: { W: { press: 0.5 } } }).maps[0].rules, odd[0].rules.map((r, i) => (i === 2 ? { ...r, mode: 'while' } : r)));
});

test('slots: mouse keys take 2 of a key\'s 6; over 6 warns on every block of that key', () => {
  const kb = (d) => K.newBlock({ key: 'Q', when: 'press', do: d });
  assert.strictEqual(K.slotUse([kb({ mouseKeys: 'up', start: 100, max: 1200, rampMs: 1000, curve: 'easeIn', power: 2 }), kb({ gamepad: 'A' })]).get('Q'), 3);
  const hat = blk('kb_when_pressed', { KEY: 'Q' }, { x: 0, y: 0 });
  hat.next = { block: chain(...[1, 2, 3, 4].map(() => blk('kb_mouse_keys', { OP: 'while', DIR: 'up', START: 100, MAX: 1200, RAMP: 1000, CURVE: 'easeIn' }))) };
  const r = B.compile({ blocks: { blocks: [hat] } }, { modes: MODES });
  assert.strictEqual(Object.keys(r.warnings).length, 4);
  assert.match(Object.values(r.warnings)[0][0], /8 rule slots; a key has 6/);
});

test('what the keyboard can\'t do warns on its block: or, not over a depth, depth tests, 4 held keys, mode start, stray blocks', () => {
  const ifWith = (cond, key = 'X') => {
    const hat = blk('kb_when_pressed', { KEY: key }, { x: 0, y: n });
    const c = blk('kb_if', {}, { inputs: { COND: { block: cond }, DO: { block: blk('kb_key', { OP: 'tap', KEY: 'A' }) } } });
    hat.next = { block: c };
    return [hat, c];
  };
  const or = blk('kb_or', {}, { inputs: { A: { block: blk('kb_held', { KEY: 'Fn' }) }, B: { block: blk('kb_held', { KEY: 'LCtrl' }) } } });
  const not = blk('kb_not', {}, { inputs: { X: { block: blk('kb_deeper', { KEY: 'W', MM: 1.5 }) } } });   // not <held> is notHeld now
  const deeper = blk('kb_deeper', { KEY: 'W', MM: 1.5 });
  const and4 = ['Fn', 'LCtrl', 'LAlt', 'LShift'].map((k) => blk('kb_held', { KEY: k }))
    .reduce((a, b) => blk('kb_and', {}, { inputs: { A: { block: a }, B: { block: b } } }));
  const [h4, c4] = ifWith(and4);
  const start = blk('kb_when_mode', { MODE: '1', EDGE: 'start' }, { x: 0, y: 900 });
  const stray = blk('kb_key', { OP: 'tap', KEY: 'A' }, { x: 0, y: 950 });
  const ws = { blocks: { blocks: [ifWith(or)[0], ifWith(not)[0], ifWith(deeper)[0], h4, start, stray] } };
  const w = B.compile(ws, { modes: MODES }).warnings;
  assert.match(w[or.id][0], /"or"/);
  assert.match(w[not.id][0], /"not"/);
  assert.match(w[deeper.id][0], /depth as a condition/);
  assert.match(w[c4.id][0], /at most 3 held \/ not held keys/);
  assert.match(w[start.id][0], /mode starting or ending/);
  assert.match(w[stray.id][0], /under a "when" block/);
  const gone = B.compile({ blocks: { blocks: [Object.assign(remap('A', 'mouse:L'), { fields: { MODE: '2', KEY: 'A', TARGET: 'mouse:L' } })] } }, { modes: MODES });
  assert.match(Object.values(gone.warnings)[0][0], /Mode 2 doesn't exist/);
});

test('summary: a header per mode, then its sentences; the rest after', () => {
  const r = B.compile(exampleWorkspace(), { modes: MODES });
  const g = K.summary(r.blocks, MODES);
  assert.strictEqual(g.length, 2);
  assert.match(g[0].head, /^Mode Mouse \(layer 1\): on with Fn \+ Left Ctrl \+ M \(hold 3\.00 s\); off with Esc \(press\); 7 blocks work only in it\.$/);
  assert.ok(g[0].lines.includes('In mode Mouse, press Up: move the mouse up, 100 -> 1200 px/s over 1 s (ease in), speed shared between directions, kept 150 ms after release'));
  assert.deepStrictEqual(g[1].lines, ['While Fn + Left Ctrl are held, hold 3.00 s M: enter mode Mouse']);
});

test('acceptance, down to the bytes: the blocks-built mouse mode writes the same packets as the driver\'s example fixture', async (t) => {
  const fs = require('fs'), path = require('path');
  const { fakeKeyboard } = require('./fixtures/ka-fake');
  const { MAX68HE_KEYS } = require('./fixtures/max68he-keys');
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'ka-mouse-mode.json'), 'utf8'));
  // Ivo's example shares the speed between the arrows; the fixture may predate the field
  for (const m of fixture.maps) for (const r of m.rules) if ('mouseKeys' in r.do && r.do.shareSpeed === undefined) Object.assign(r.do, { shareSpeed: true, keepMs: 150 });
  try { require('../src/key-actions').parseSpec({ key: 'Up', rules: [{ when: 'press', do: { mouseKeys: 'up', shareSpeed: true } }] }); } catch (e) {
    if (/shareSpeed|unknown field/i.test(e.message)) return t.skip(`the driver doesn't know shareSpeed yet (engine 3, fork 1): ${e.message}`);
    throw e;
  }
  const r = B.compile(exampleWorkspace(), { modes: MODES });
  assert.deepStrictEqual(r.warnings, {});
  const fromBlocks = { modes: MODES.filter((m) => m.name).map(({ id, name }) => ({ id, name })), ...r.batch() };
  assert.deepStrictEqual(fromBlocks.maps, fixture.maps, 'the same rule JSON as the driver\'s fixture');
  // both through the driver (validation + encoding) on a fake engine-2 keyboard: byte-identical writes
  const sent = async (batch) => {
    const f = fakeKeyboard({ engine: 3, entries: 32, keys: MAX68HE_KEYS });
    await f.kb.setKeyActionsBatch(batch);
    return f.sent.filter((p) => p[0] === 0xee && [2, 5, 7].includes(p[1])).map((p) => Buffer.from(p).toString('hex'));
  };
  const a = await sent(fromBlocks), b = await sent(fixture);
  assert.ok(a.length >= 10, `${a.length} writes`);
  assert.deepStrictEqual(a, b);
});

test('mouse keys "share speed": new blocks share, old rules without the field stay off, keepMs, engine 3, summary', () => {
  const mkBlock = (fields) => ({ blocks: { languageVersion: 0, blocks: [{ ...blk('kb_when_pressed', { KEY: 'Up' }, { x: 0, y: 0 }),
    next: { block: blk('kb_mouse_keys', { OP: 'while', DIR: 'up', START: 100, MAX: 1200, RAMP: 1000, CURVE: 'easeIn', POWER: 2, ...fields }) } }] } });
  const doOf = (ws) => B.compile(ws, { modes: MODES }).batch().maps[0].rules[0].do;
  assert.deepStrictEqual(doOf(mkBlock({ SHARE: 'TRUE', KEEP: 150 })), { mouseKeys: 'up', shareSpeed: true, keepMs: 150 }, 'on: keepMs always written, as in the driver example');
  assert.deepStrictEqual(doOf(mkBlock({ SHARE: 'TRUE', KEEP: 300 })), { mouseKeys: 'up', shareSpeed: true, keepMs: 300 });
  assert.deepStrictEqual(doOf(mkBlock({ SHARE: 'FALSE', KEEP: 300 })), { mouseKeys: 'up' }, 'off: neither field');
  assert.deepStrictEqual(doOf(mkBlock({})), { mouseKeys: 'up', shareSpeed: true, keepMs: 150 }, 'a block saved before the field: shares');
  // a rule stored without shareSpeed comes back as a block with sharing OFF and saves back unchanged
  const old = [{ key: 'Up', rules: [{ when: 'press', mode: 'while', do: { mouseKeys: 'up' } }] }];
  const ws = B.decompile(old, MODES);
  assert.ok(JSON.stringify(ws).includes('"SHARE":"FALSE"'));
  assert.deepStrictEqual(B.compile(ws, { modes: MODES }).batch().maps, old);
  // and one stored with sharing + keepMs round trips
  const kept = [{ key: 'Up', rules: [{ when: 'press', mode: 'while', do: { mouseKeys: 'up', shareSpeed: true, keepMs: 400 } }] }];
  assert.deepStrictEqual(B.compile(B.decompile(kept, MODES), { modes: MODES }).batch().maps, kept);
  // keepMs out of range / not in 10 ms steps, and a keyboard on engine 2, warn on the block
  const warns = (w, opts) => Object.values(B.compile(w, { modes: MODES, ...opts }).warnings).flat().join(' ');
  assert.match(warns(mkBlock({ SHARE: 'TRUE', KEEP: 1005 })), /0 to 1000 ms/);
  assert.match(warns(mkBlock({ SHARE: 'TRUE', KEEP: 155 })), /10 ms steps/);
  assert.match(warns(mkBlock({ SHARE: 'TRUE', KEEP: 150 }), { engine: 2 }), /newer open firmware.*engine 3/);
  assert.strictEqual(warns(mkBlock({ SHARE: 'TRUE', KEEP: 150 }), { engine: 3 }), '');
  assert.strictEqual(warns(mkBlock({ SHARE: 'FALSE' }), { engine: 2 }), '', 'no sharing: fine on engine 2');
  const b = K.fromMaps(kept, MODES).blocks[0];
  assert.match(K.sentence(b, MODES), /speed shared between directions, kept 400 ms after release/);
});

test('mouse keys "speed by" pressure / both: compile, defaults, round trip, 3 slots, engine 4, summary, plot over depth', () => {
  const mkBlock = (fields) => ({ blocks: { languageVersion: 0, blocks: [{ ...blk('kb_when_pressed', { KEY: 'Up' }, { x: 0, y: 0 }),
    next: { block: blk('kb_mouse_keys', { OP: 'while', DIR: 'up', START: 100, MAX: 1200, RAMP: 1000, CURVE: 'easeIn', POWER: 2, SHARE: 'TRUE', KEEP: 150, ...fields }) } }] } });
  const doOf = (ws) => B.compile(ws, { modes: MODES }).batch().maps[0].rules[0].do;
  const shared = { mouseKeys: 'up', shareSpeed: true, keepMs: 150 };
  assert.deepStrictEqual(doOf(mkBlock({})), shared, 'a block saved before the field: by time, nothing new written');
  assert.deepStrictEqual(doOf(mkBlock({ SPEEDBY: 'time', PFROM: 1, PTO: 2 })), shared, 'time: no speedBy / depths');
  assert.deepStrictEqual(doOf(mkBlock({ SPEEDBY: 'pressure' })), { ...shared, speedBy: 'pressure', pressFrom: 0.5, pressTo: 3.2 }, 'pressure: default depths written');
  assert.deepStrictEqual(doOf(mkBlock({ SPEEDBY: 'both', PFROM: 0.83, PTO: 2.5 })), { ...shared, speedBy: 'both', pressFrom: 0.8, pressTo: 2.5 }, 'both: rounded to 0.1 mm');
  // new blocks go by time with the default depths ready
  assert.deepStrictEqual([K.mouseKeysDo('up').speedBy, K.mouseKeysDo('up').pressFrom, K.mouseKeysDo('up').pressTo], ['time', 0.5, 3.2]);
  // rules -> blocks -> rules, with and without the fields
  const maps = [{ key: 'Up', rules: [{ when: 'press', mode: 'while', do: { mouseKeys: 'up', speedBy: 'pressure', pressFrom: 0.5, pressTo: 3.2 } }] },
    { key: 'Left', rules: [{ when: 'press', mode: 'while', do: { mouseKeys: 'left', rampMs: 600, shareSpeed: true, keepMs: 200, speedBy: 'both', pressFrom: 1, pressTo: 3.5 } }] },
    { key: 'Down', rules: [{ when: 'press', mode: 'while', do: { mouseKeys: 'down' } }] }];
  const ws = B.decompile(maps, MODES);
  assert.deepStrictEqual(B.compile(ws, { modes: MODES }).batch().maps, maps);
  assert.ok(JSON.stringify(ws).includes('"SPEEDBY":"time"'), 'an old rule shows "speed by time"');
  // a stored pressure rule without depths gets the defaults
  const bare = K.fromMaps([{ key: 'Up', rules: [{ when: 'press', do: { mouseKeys: 'up', speedBy: 'pressure' } }] }], MODES).blocks[0];
  assert.deepStrictEqual([bare.do.pressFrom, bare.do.pressTo, bare.do.shareSpeed], [0.5, 3.2, false]);
  // slots: 3 with pressure / both, 2 by time; two pressure blocks + one by time = 8 > 6 warns
  const kb = (by) => K.newBlock({ key: 'Q', when: 'press', do: K.mouseKeysDo('up', { ...K.mouseKeysDo('up'), speedBy: by }) });
  assert.deepStrictEqual(['time', 'pressure', 'both'].map((by) => K.ruleSlots(kb(by))), [2, 3, 3]);
  assert.strictEqual(K.slotUse([kb('pressure'), kb('pressure')]).get('Q'), 6);
  const hat = blk('kb_when_pressed', { KEY: 'Q' }, { x: 0, y: 0 });
  hat.next = { block: chain(...['pressure', 'both', 'time'].map((by) => blk('kb_mouse_keys', { OP: 'while', DIR: 'up', START: 100, MAX: 1200, RAMP: 1000, CURVE: 'easeIn', SPEEDBY: by }))) };
  const over = B.compile({ blocks: { blocks: [hat] } }, { modes: MODES });
  assert.strictEqual(Object.keys(over.warnings).length, 3);
  assert.match(Object.values(over.warnings)[0][0], /8 rule slots; a key has 6 \(mouse keys take 2, 3 with speed by pressure\)/);
  // bad depths, engine 3
  const warns = (w, opts) => Object.values(B.compile(w, { modes: MODES, ...opts }).warnings).flat().join(' ');
  assert.match(warns(mkBlock({ SPEEDBY: 'pressure', PFROM: 3, PTO: 2 })), /"from" less than "to"/);
  assert.match(warns(mkBlock({ SPEEDBY: 'both', PFROM: 0, PTO: 4.5 })), /0\.0 to 4\.0 mm/);
  assert.match(warns(mkBlock({ SPEEDBY: 'pressure' }), { engine: 3 }), /newer open firmware.*engine 4/);
  assert.strictEqual(warns(mkBlock({ SPEEDBY: 'pressure' }), { engine: 4 }), '');
  assert.strictEqual(warns(mkBlock({ SPEEDBY: 'time' }), { engine: 3 }), '', 'by time: fine on engine 3');
  // sentences: pressure leaves out the ramp and sharing; both keeps them
  const [up, left] = K.fromMaps(maps, MODES).blocks;
  assert.strictEqual(K.sentence(up, MODES), 'Press Up: move the mouse up, 100 -> 1200 px/s, speed by how deep you press, 0.50 -> 3.20 mm (ease in)');
  assert.strictEqual(K.sentence(left, MODES), 'Press Left: move the mouse left, 100 -> 1200 px/s, up to a speed set by how deep you press (1.00 -> 3.50 mm), building over 600 ms (ease in), speed shared between directions, kept 200 ms after release');
  // the plot goes over the depth: 0 above "from", the max from "to" on
  const pts = K.speedCurve(up.do, 40);
  assert.strictEqual(pts[pts.length - 1][0], 4);
  assert.strictEqual(pts.find(([x]) => x === 0.4)[1], 0);
  assert.strictEqual(pts.find(([x]) => x === 0.5)[1], 100);
  assert.strictEqual(pts.find(([x]) => Math.abs(x - 3.6) < 1e-9)[1], 1200);
});

test('restored maps: an existing mouse-keys block shows shareSpeed / keepMs, and the tick box works when the map had none', () => {
  const field = (ws) => ws.blocks.blocks[0].next.block.fields;
  const withIt = B.decompile([{ key: 'Up', rules: [{ when: 'press', do: { mouseKeys: 'up', shareSpeed: true, keepMs: 300 } }] }], MODES);
  assert.deepStrictEqual([field(withIt).SHARE, field(withIt).KEEP], ['TRUE', 300]);
  const without = B.decompile([{ key: 'Up', rules: [{ when: 'press', do: { mouseKeys: 'up', rampMs: 500 } }] }], MODES);
  assert.deepStrictEqual([field(without).SHARE, field(without).KEEP], ['FALSE', 150], 'off, with the default keep ready');
  field(without).SHARE = 'TRUE';            // Ivo ticks it
  assert.deepStrictEqual(B.compile(without, { modes: MODES }).batch().maps[0].rules[0].do, { mouseKeys: 'up', rampMs: 500, shareSpeed: true, keepMs: 150 });
});
