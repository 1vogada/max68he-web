// kbcode: scripts -> plan (compile, validation with line numbers, the sandbox), plan -> changes
// (diff), and apply against a stub keyboard. The mouse-mode example must compile to exactly the key
// action maps of tests/fixtures/ka-mouse-mode.json and write the same table.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const C = require('../src/kbcode-core');
const K = require('../src/kbcode');
const { EXAMPLES } = require('../src/kbcode-examples');
const { fakeKeyboard } = require('./fixtures/ka-fake');
const { MAX68HE_KEYS } = require('./fixtures/max68he-keys');

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'ka-mouse-mode.json'), 'utf8'));
const example = (name) => EXAMPLES.find((e) => e.name === name).code;
const compile = (code, state = null) => C.compile(code, { state, run: K.runScript });
const errs = async (code, state) => (await compile(code, state)).errors.map((e) => `${e.line}: ${e.message}`);
// a keyboard with everything (engine 3); override what a test needs
const FULL = ['keyActions', 'dksLevels', 'fnLayers', 'textKeys', 'gamepad', 'gamepadPlus', 'sequence', 'sequenceGlide', 'textTyping',
  'compatMode', 'releaseDebounce', 'idleDim', 'optionsLayers', 'fxEffects'];
const STATE = { model: 'max68he', open: true, features: FULL, engine: 3, entries: 16, hostApi: 3, openModes: [0x40, 0x42, 0x46],
  modes: [{ id: 1, name: '' }, { id: 2, name: '' }, { id: 3, name: '' }], profile: 0, unitMm: 0.005 };

test('compile: the task example becomes a plan', async () => {
  const r = await compile(`for (const k of kb.keys.typing) k.actuation(1.2).rapidTrigger({ press: 0.15, release: 0.15 });
kb.lighting.effect('static').color('#ff4400');
kb.keys.wasd.forEach(k => k.color('cyan'));
kb.mode('Mouse');
kb.key('Up').when('press').if({ mode: 'Mouse' }).do(kb.mouse.move('up', { start: 100, max: 1200, rampMs: 1000, shareSpeed: true }));`, STATE);
  assert.deepStrictEqual(r.errors, []);
  const w = r.plan.switches.find((s) => s.key === 'W');
  assert.deepStrictEqual(w, { key: 'W', slot: 14, actuation: 1.2, rapidTrigger: true, rtPress: 0.15, rtRelease: 0.15 });
  assert.ok(r.plan.switches.some((s) => s.key === 'Up') && !r.plan.switches.some((s) => s.key === 'Space'));
  assert.deepStrictEqual(r.plan.lighting, { mode: 1, r: 255, g: 68, b: 0, rainbow: false, presetColour: null });
  assert.deepStrictEqual(r.plan.picture.colors, { 14: '#00ffff', 9: '#00ffff', 15: '#00ffff', 21: '#00ffff' });
  assert.strictEqual(r.plan.picture.show, false);           // an explicit effect wins; the note says the picture is only stored
  assert.ok(r.notes.some((n) => /stored and not shown/.test(n)));
  assert.deepStrictEqual(r.plan.keyActions, { modes: [{ id: 1, name: 'Mouse' }], maps: [{ key: 'Up', rules: [{ when: 'press', if: { mode: 'Mouse' },
    do: { mouseKeys: 'up', start: 100, max: 1200, rampMs: 1000, shareSpeed: true } }] }] });
});

test('compile: the mouse-mode example gives exactly the fixture\'s key action maps', async () => {
  const r = await compile(example('mouse-mode'));
  assert.deepStrictEqual(r.errors, []);
  assert.deepStrictEqual(r.plan.keyActions, FIXTURE);
  // with a keyboard whose mode 1 is named already, and with the Blocks-style wording too
  const s = await compile(example('mouse-mode'), { ...STATE, modes: [{ id: 1, name: 'Mouse' }, { id: 2, name: '' }, { id: 3, name: '' }] });
  assert.deepStrictEqual(s.plan.keyActions, FIXTURE);
});

test('apply: the mouse-mode script writes the same table as the fixture batch; a second apply writes nothing', async () => {
  const v3 = () => fakeKeyboard({ engine: 3, entries: 32, keys: MAX68HE_KEYS });
  const a = v3(), b = v3();
  await a.kb.setKeyActionsBatch(FIXTURE);
  const r = await K.apply(b.kb, example('mouse-mode'));
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.ok(r.applied.some((x) => /Mode 1: named "Mouse"/.test(x)) && r.applied.some((x) => /^Key map Esc:/.test(x)));
  assert.deepStrictEqual([...b.table.entries()].sort(), [...a.table.entries()].sort());
  assert.deepStrictEqual(b.conds, a.conds);
  assert.deepStrictEqual(b.names, a.names);
  const writes = (f) => f.sent.filter((p) => p[0] === 0xee && [2, 5, 7].includes(p[1])).length;
  const before = writes(b);
  const again = await K.apply(b.kb, example('mouse-mode'));
  assert.deepStrictEqual(again.applied, ['Nothing to change: the keyboard already matches the script.']);
  assert.strictEqual(writes(b), before);
});

test('mouse keys speedBy pressure / both: compile, validation, engine 4, apply and a second apply writes nothing', async () => {
  const code = `kb.mode('Mouse');
kb.key('Up').when('press').mode('while').if({ mode: 'Mouse' }).do(kb.mouse.move('up', { speedBy: 'pressure' }));
kb.key('Left').when('press').mode('while').if({ mode: 'Mouse' }).do(kb.mouse.move('left', { speedBy: 'both', pressFrom: 1, pressTo: 3.5, shareSpeed: true }));`;
  const r = await compile(code, { ...STATE, engine: 4 });
  assert.deepStrictEqual(r.errors, []);
  assert.deepStrictEqual(r.plan.keyActions.maps.map((m) => m.rules[0].do), [
    { mouseKeys: 'up', speedBy: 'pressure' },
    { mouseKeys: 'left', speedBy: 'both', pressFrom: 1, pressTo: 3.5, shareSpeed: true }]);
  assert.deepStrictEqual((await compile(code)).errors, [], 'no keyboard: the newest engine is assumed');
  assert.strictEqual(C.metaFor(null).firmware.engine, 4);
  assert.deepStrictEqual(await errs(code, STATE), [
    '2: mouse keys with speedBy pressure or both need a newer open firmware (key action engine 4)',
    '3: mouse keys with speedBy pressure or both need a newer open firmware (key action engine 4)']);
  const v4 = { ...STATE, engine: 4 };
  const cases = [
    ["kb.key('W').when('press').do(kb.mouse.move('up', { speedBy: 'deep' }))", /^1: W: .*speedBy is time, pressure, both/],
    ["kb.key('W').when('press').do(kb.mouse.move('up', { pressFrom: 1 }))", /^1: W: .*pressFrom \/ pressTo only go with speedBy "pressure" or "both"/],
    ["kb.key('W').when('press').do(kb.mouse.scroll('up', { speedBy: 'both', pressFrom: 3, pressTo: 2 }))", /^1: W: .*pressTo must be at least 0\.1 mm deeper than pressFrom/],
    ["kb.key('W').when('press').do(kb.mouse.move('up', { speedBy: 'pressure', pressTo: 5 }))", /^1: W: .*pressTo is a number within 0\.\.4 mm/],
    ["const p = { speedBy: 'pressure' };\nkb.key('W').when('press').do(kb.mouse.move('up', p));\nkb.key('W').when('hold', 300).do(kb.mouse.move('down', p));\nkb.key('W').when('tap', 200).do(kb.send('A'));",
      /^4: W: .*the rules take 7 of the key's 6 rule slots \(a mouseKeys rule takes 2, 3 with speedBy pressure or both\)/],
  ];
  for (const [c, re] of cases) {
    const got = await errs(c, v4);
    assert.ok(got.some((e) => re.test(e)), `${c}\n -> ${JSON.stringify(got)}`);
  }
  // apply on an engine 4 keyboard; the read-back (with the default depths filled in) matches the script
  const f = fakeKeyboard({ engine: 4, entries: 32, keys: MAX68HE_KEYS });
  const a = await K.apply(f.kb, code);
  assert.ok(a.ok, JSON.stringify(a.errors));
  assert.deepStrictEqual((await f.kb.getKeyActions('Up')).rules[0].do,
    { mouseKeys: 'up', start: 100, max: 1200, rampMs: 1000, curve: 'easeIn', power: 2, speedBy: 'pressure', pressFrom: 0.5, pressTo: 3.2 });
  const again = await K.apply(f.kb, code);
  assert.deepStrictEqual(again.applied, ['Nothing to change: the keyboard already matches the script.']);
  // an engine 3 keyboard: refused before anything is written
  const g = fakeKeyboard({ engine: 3, entries: 32, keys: MAX68HE_KEYS });
  const no = await K.apply(g.kb, code);
  assert.ok(!no.ok && no.errors.some((e) => /key action engine 4/.test(e.message)));
  assert.deepStrictEqual(g.sent.filter((p) => p[0] === 0xee && [2, 5, 7].includes(p[1])), []);
});

test('every example in src/kbcode-examples.js compiles, and docs/KBCODE.md shows each one', async () => {
  const md = fs.readFileSync(path.join(__dirname, '..', 'docs', 'KBCODE.md'), 'utf8');
  for (const e of EXAMPLES) {
    const r = await compile(e.code, STATE);
    assert.deepStrictEqual(r.errors, [], e.name);
    assert.ok(md.includes(e.code.trim()), `KBCODE.md lacks the ${e.name} example`);
  }
  const d = K.docs();
  assert.ok(d.dts.includes('declare const kb: KB') && d.markdown.length > 1000 && d.examples.length === EXAMPLES.length);
});

test('validation: clear errors with line and column, all of them at once', async () => {
  assert.deepStrictEqual(await errs("kb.key('W').actuation(3.6);\nkb.key('Foo').actuation(1);\n  kb.key('A').release('x');\nkb.key('S').rapidTrigger({ press: 0 });"), [
    '1: actuation 3.6 mm is above 3.4',
    '2: no key named "Foo" on the MAX68HE (see kb.layout)',
    '3: release is a number of mm, not "x"',
    '4: rapidTrigger press 0 mm is below 0.01',
  ]);
  const r = await compile("\n\nkb.key('Q').deadZone(9)");
  assert.deepStrictEqual(r.errors, [{ line: 3, col: 13, message: 'deadZone 9 mm is above 3.4' }]);
  const cases = [
    ["kb.lighting.effect('sparkle')", /^1: unknown effect "sparkle" \(Static, Breathing/],
    ["kb.lighting.effect('wave', { direction: 'sideways' })", /^1: Wave direction is Right, Left, Down, Up, not "sideways"/],
    ["kb.lighting.color('blurple')", /^1: "blurple" is not a colour/],
    ["kb.lighting.brightness(7)", /^1: brightness is a whole number 0\.\.4/],
    ["kb.key('W').remap('Bogus')", /^1: unknown key value "Bogus"/],
    ["kb.key('W').remap('A', 'fn9')", /^1: layer is base, fn, fn2/],
    ["kb.key('W').when('press').do(kb.mouse.button('X'))", /^1: W: do: mouse is L, R or M/],
    ["kb.key('W').when('hold', 20000).do(kb.send('A'))", /^1: W: ms is a whole number within 10\.\.10000/],
    ["kb.key('W').when('press').if({ mode: 'Nope' }).do(kb.send('A'))", /^1: W: if: no mode named "Nope" \(declare it: kb\.mode\("Nope"\)\)/],
    ["kb.mode('Mouse'); kb.key('W').when('press').mode('Mouse').do(kb.send('A'))", /^1: \.mode\(\) is how the output acts.*\.if\(\{ mode: "Mouse" \}\)/],
    ["kb.mode('Mouse'); kb.key('W').when('press').do('Mouse')", /^1: W: do: not a keyboard key: Mouse .*\(for the mode use kb\.mode\("Mouse"\)\.enter\(\), \.leave\(\) or \.toggle\(\)\)/],
    ["kb.key('W').when('press')", /^1: \.when\(\.\.\.\) without \.do\(\.\.\.\) does nothing/],
    ["kb.key('W').when('press').if({ held: ['W'] }).do(kb.send('A'))", /a key can not be in the condition of its own rule/],
    ["for (let i = 0; i < 4; i++) kb.key('W').when('press').do(kb.mouse.move('up'))", /^1: W: the rules take 8 of the key's 6 rule slots/],
    ["kb.key('A').snapTap('A')", /^1: snapTap needs two different keys/],
    ["kb.key('A').modTap('LCtrl', 'Esc', 5)", /^1: modTap hold time is 10\.\.2550 ms/],
    ["kb.key('Caps').remap('A'); kb.key('Caps').modTap('LCtrl', 'Esc')", /^1: Caps: modTap sets the key's base mapping itself; drop its remap \(line 1\)/],
    ["kb.pollingRate(3000)", /^1: polling rate is one of 8000, 4000/],
    ["kb.options({ os: 'mac' })", /^1: the driver has no way to set the OS mode/],
    ["kb.text(0, 'x'.repeat(200))", /^1: text 0 is 200 bytes, at most 119/],
    ["kb.macro(16, 'hi')", /^1: macro index is 0\.\.15/],
    ["kb.sequence('W down; fly away')", /^1: sequence: line 1, col 9: don't know "fly away"/],
    ["kb.profile(4)", /^1: profile is 0\.\.3, not 4/],
    ["kb.key('W').dks({ keys: ['W'], levels: [{ depthMm: 2 }, { depthMm: 1 }] })", /^1: dks: level 2 must be deeper than level 1/],
    ["kb.gamepad.settings({ curve: 'wobbly' })", /^1: curve is linear, smooth/],
    ["kb.key('W').bindGamepad('jump')", /^1: gamepad target is one of lx-/],
    ["kb.mode('A'); kb.mode('B'); kb.mode('C'); kb.mode('D')", /^1: at most 3 modes/],
  ];
  for (const [code, re] of cases) {
    const got = await errs(code, STATE);
    assert.ok(got.length && re.test(got[0]), `${code}\n -> ${JSON.stringify(got)}`);
  }
});

test('validation: what the connected firmware lacks is an error, never a silent skip', async () => {
  const stock = { ...STATE, open: false, features: [], engine: 0, openModes: [], modes: null };
  const v1 = { ...STATE, engine: 1, modes: null };
  const v2 = { ...STATE, engine: 2 };
  const none = { ...STATE, features: [] };
  const cases = [
    [stock, "kb.key('W').rapidTrigger({ continuous: true })", /continuous rapid trigger needs the open firmware/],
    [stock, "kb.lighting.effect('droplet')", /the Droplet effect needs the open firmware/],
    [{ ...STATE, openModes: [0x40, 0x42] }, "kb.lighting.effect('lava lamp')", /the Lava lamp effect needs a newer open firmware/],
    [stock, "kb.key('W').when('press').do(kb.send('A'))", /Key action maps need a newer open firmware/],
    [v1, "kb.key('W').when('press').do(kb.mouse.move('up'))", /mouse keys need a newer open firmware \(key action engine 2\)/],
    [v2, "kb.key('W').when('press').do(kb.mouse.move('up', { shareSpeed: true }))", /shareSpeed need a newer open firmware \(key action engine 3\)/],
    [v2, "kb.key('W').when('press').do(kb.mouse.move('up', { speedBy: 'both' }))", /speedBy pressure or both need a newer open firmware \(key action engine 4\)/],
    [none, "kb.key('W').fn('A', 2)", /Fn layer 2 needs a newer open firmware \(feature "fnLayers"/],
    [none, "kb.text(1, 'hi')", /Text keys needs a newer open firmware/],
    [none, "kb.textTyping('block')", /textTyping needs a newer open firmware/],
    [none, "kb.key('W').dks({ keys: ['W'], levels: [{ depthMm: 1 }] })", /Multi-level DKS needs a newer open firmware/],
    [none, "kb.sequence('W tap')", /Play sequence needs a newer open firmware/],
    [stock, "kb.firmwareOptions({ fnHold: true })", /Firmware options needs the open firmware/],
    [v1, "kb.mode('Mouse')", /modes need a newer open firmware \(key action engine 2\)/],
  ];
  for (const [state, code, re] of cases) {
    const got = await errs(code, state);
    assert.ok(got.some((e) => re.test(e)), `${code}\n -> ${JSON.stringify(got)}`);
  }
  // a script can ask what the board has and choose
  const r = await compile("if (kb.firmware.has('keyActions')) kb.key('W').when('press').do(kb.send('A')); else kb.key('W').remap('A');", stock);
  assert.deepStrictEqual(r.errors, []);
  assert.ok(r.plan.remap && !r.plan.keyActions);
});

test('compile: loops, functions, groups, colours, layers, advanced keys and options', async () => {
  const r = await compile(`
function paint(group, hue) { group.color(kb.hsl(hue, 100, 50)); }
kb.keys.rows.forEach((row, i) => paint(row, i * 60));
kb.keys.all.except('Space').deadZone(0.2);
kb.keys.named('Q', 'E').remap('Ctrl+C', 'l1');
kb.key('Home').fn('VolumeUp');
kb.key(85).remap('Mute', { layer: 'fn', os: 'mac' });
kb.key('F').toggle({ repeat: true });
kb.key('A').snapTap('D');
kb.key('Z').dks({ keys: ['Z', 'LShift'], levels: [{ depthMm: 1, actions: [{ down: 'press' }] }, { depthMm: 2.5, actions: [{}, { down: 'tap' }] }] });
kb.lighting.picture(2, { fill: 'rgb(0, 0, 32)' }).brightness(3);
kb.firmwareOptions({ capsColor: 'hsl(120, 100%, 50%)', releaseDebounceMs: 5 });
kb.gamepad.settings({ enabled: true, curve: 'smooth' }).bind('W', 'ly-');
kb.key('S').bindGamepad('LY+');
kb.macro(3, { steps: [{ key: 'LShift', down: true }, { key: 'A', down: true }, { key: 'A', down: false }, { key: 'LShift', down: false, delayMs: 30 }] });
kb.profile(1);
console.log(kb.keys.wasd.names.join(''), kb.layout[4].length, kb.firmware.has('dksLevels'));
`, STATE);
  assert.deepStrictEqual(r.errors, []);
  assert.deepStrictEqual(r.logs, [{ line: 17, text: 'WASD 10 true' }]);
  const p = r.plan;
  assert.strictEqual(p.picture.colors[MAX68HE_KEYS.find((k) => k.name === 'Q').slot], '#ffff00');
  assert.deepStrictEqual([p.picture.index, p.picture.fill, p.picture.show], [2, '#000020', true]);
  assert.strictEqual(p.switches.length, 67);
  assert.deepStrictEqual(p.remap.map((x) => [x.layer, x.key, x.value, x.os]), [['l1', 'Q', 'Ctrl+C', undefined], ['l1', 'E', 'Ctrl+C', undefined],
    ['fn', 'Home', 'VolumeUp', undefined], ['fn', 'Home', 'Mute', 'mac']]);
  assert.deepStrictEqual(p.advanced.map((a) => [a.key, a.kind]), [['F', 'toggle'], ['A', 'snap'], ['Z', 'dks']]);
  assert.deepStrictEqual(p.fwOptions, { capsColor: [0, 255, 0], releaseDebounceMs: 5 });
  assert.deepStrictEqual(p.gamepad.bindings.map((b) => [b.key, b.target]), [['W', 'ly-'], ['S', 'ly+']]);
  assert.deepStrictEqual(p.macros[0].steps.map((s) => [s.usage, s.down, s.delayMs]), [[0xe1, true, 15], [4, true, 15], [4, false, 15], [0xe1, false, 30]]);
  assert.strictEqual(p.profile, 1);
});

test('compile: colours in every form', async () => {
  for (const [c, rgb] of [['#ff4400', [255, 68, 0]], ['FF4400', [255, 68, 0]], ['#f40', [255, 68, 0]], ['rgb(255, 68, 0)', [255, 68, 0]],
    ['hsl(0, 100%, 50%)', [255, 0, 0]], ['hsl(240deg, 100%, 25%)', [0, 0, 128]], ['Cyan', [0, 255, 255]], ['rebeccapurple', [102, 51, 153]], [[1, 2, 3], [1, 2, 3]]]) {
    assert.deepStrictEqual(C.parseColor(c), rgb, String(c));
  }
  for (const c of ['#ff44', 'rgb(300, 0, 0)', 'hsl(0, 200%, 50%)', 'nocolour', [256, 0, 0], 12]) assert.throws(() => C.parseColor(c), /is not a colour/);
  assert.deepStrictEqual((await compile("kb.key('W').color(kb.rgb(1, 2, 3)); kb.key('A').color(kb.hsl(0, 100, 50))")).plan.picture.colors, { 14: '#010203', 9: '#ff0000' });
});

test('sandbox: no way out to Node, and endless scripts stop', async () => {
  const r = await compile(`
const tries = [
  () => this.constructor.constructor('return typeof process')(),
  () => kb.key.constructor('return typeof process')(),
  () => kb.constructor.constructor('return typeof require')(),
  () => Object.getPrototypeOf(kb.keys.all).constructor.constructor('return typeof process')(),
  () => console.log.constructor('return typeof globalThis.process')(),
  () => (function () { return this; })().constructor.constructor('return typeof module')(),
  () => typeof require + typeof process + typeof setTimeout + typeof Atomics + typeof SharedArrayBuffer + typeof WebAssembly,
];
for (const t of tries) { try { console.log(String(t())); } catch (e) { console.log('threw ' + e.name); } }
import('fs').then(() => console.log('imported'), () => console.log('import refused'));
`);
  assert.deepStrictEqual(r.errors, []);
  const out = r.logs.map((l) => l.text);
  assert.ok(out.slice(0, 6).every((t) => t === 'undefined' || t.startsWith('threw')), JSON.stringify(out));
  assert.strictEqual(out[6], 'undefinedundefinedundefinedundefinedundefinedundefined');
  assert.ok(!out.includes('imported'));
  // the API is frozen; a script that changes its own builtins still gets a readable result
  assert.match((await errs("'use strict';\nkb.key = null;"))[0], /^2: TypeError: Cannot assign to read only property 'key'/);
  assert.deepStrictEqual((await compile("JSON.stringify = () => ({}); kb.key('W').actuation(1)")).plan.switches, [{ key: 'W', slot: 14, actuation: 1 }]);
  // throws, endless loops (also in promises), and values that fight back while being described
  assert.deepStrictEqual((await compile('\n\nthrow new Error("boom")')).errors, [{ message: 'Error: boom', line: 3, col: 7 }]);
  assert.deepStrictEqual((await compile('let x = ;')).errors, [{ line: 1, col: 9, message: "SyntaxError: Unexpected token ';'" }]);
  const t0 = Date.now();
  assert.match((await errs('while (true) {}'))[0], /ran longer than 1000 ms/);
  assert.match((await errs('(async () => { for (;;) await 0; })()'))[0], /ran longer than 1000 ms/);
  assert.match((await errs('throw new Proxy({}, { get() { for (;;); }, getPrototypeOf() { for (;;); } })'))[0], /the script stopped/);
  assert.match((await errs('const e = new Error("x"); Object.defineProperty(e, "code", { get() { for (;;); } }); throw e;'))[0], /Error: x/);
  assert.match((await errs('const a = []; for (;;) a.push(new Array(1e6).fill(1));'))[0], /more than 128 MB of memory|ran longer than/);
  assert.ok(Date.now() - t0 < 12000);
});

// ---- diff and apply against a stub keyboard --------------------------------------------------

// A Keyboard stand-in: getters return `cur`, setters record calls (and update cur where a second check reads it).
function stubKeyboard(over = {}) {
  const calls = [];
  const zero = () => Array.from({ length: 128 }, () => [0, 0, 0, 0]);
  const sw = Array.from({ length: 128 }, (_, slot) => ({ slot, actuation: 2, release: 2, rapidTrigger: false, continuousRt: false, rtPress: 0.3, rtRelease: 0.3, deadZone: 0, kind: 0 }));
  const cur = { profile: 0, switches: sw, base: zero(), fn: zero(), lighting: { mode: 1, speed: 2, brightness: 4, option: 0, rainbow: false, presetColour: null, r: 0, g: 0, b: 250 },
    options: { os: 'win', fnIndex: 0, antiMistouch: false, rtStability: 0, wasdSwap: false }, rate: 1000, adv: [], maps: [], ...over };
  const write = (name, fn) => async (...a) => { calls.push([name, ...a]); return fn?.(...a); };
  const k = {
    info: { model: 'max68he', custom: true, unitMm: 0.005 },
    getCaps: async () => ({ api: 3, features: FULL }),
    keyActionsInfo: async () => ({ engine: 3, entries: 16 }),
    getModes: async () => [{ id: 1, name: 'Mouse' }, { id: 2, name: '' }, { id: 3, name: '' }],
    getProfile: async () => cur.profile,
    getSwitches: async () => cur.switches.map((s) => ({ ...s })),
    getKeymap: async () => cur.base,
    getFnKeymap: async () => cur.fn,
    getLighting: async () => ({ ...cur.lighting }),
    getAdvancedKeys: async () => cur.adv,
    getOptions: async () => ({ ...cur.options }),
    getReportRate: async () => cur.rate,
    getKeyActions: async () => cur.maps,
    getFirmwareOptions: async () => ({ capsIndicator: false, capsColor: [255, 255, 255], textTyping: 'keep' }),
    setProfile: write('setProfile', (p) => { cur.profile = p; }),
    setAllSwitches: write('setAllSwitches', (s, slots) => { for (const x of slots) Object.assign(cur.switches[x], s); }),
    setKey: write('setKey', (slot, v, o) => { cur[o.layer][slot] = v; }),
    setLighting: write('setLighting', (c) => { Object.assign(cur.lighting, c); }),
    setPicture: write('setPicture'),
    showPicture: write('showPicture', (i) => { Object.assign(cur.lighting, { mode: 13, option: i }); }),
    setSnap: write('setSnap'),
    setModTap: write('setModTap'),
    clearAdvanced: write('clearAdvanced'),
    setOptions: write('setOptions', (o) => { Object.assign(cur.options, o); }),
    setReportRate: write('setReportRate', (hz) => { cur.rate = hz; }),
    setFirmwareOptions: write('setFirmwareOptions'),
    setKeyActionsBatch: write('setKeyActionsBatch'),
    playSequence: write('playSequence'),
  };
  return { k, calls, cur };
}

test('check never writes; it compares and lists only what differs', async () => {
  const { k, calls } = stubKeyboard();
  const code = `kb.keys.wasd.actuation(2).rapidTrigger({ press: 0.15, release: 0.15 });   // actuation is 2 already
kb.key('Q').actuation(2);                                  // no change at all
kb.key('E').remap('E');                                    // E types nothing now: a change
kb.lighting.color('#0000ff');                              // reads back as 250: the same
kb.options({ wasdSwap: false, antiMistouch: true });
kb.pollingRate(1000);`;
  const r = await K.check(code, { keyboard: k });
  assert.deepStrictEqual(calls, []);
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepStrictEqual(r.summary, [
    'W, A, S, D: rapidTrigger press 0.15 mm (was 0.30 mm), rapidTrigger release 0.15 mm (was 0.30 mm), rapid trigger on (was off)',
    'E on the base layer: E (was nothing)',
    'Options: antiMistouch true (was false)',
  ]);
  assert.strictEqual(r.changes, 3);
  assert.strictEqual(r.compared, true);
});

test('check without a keyboard lists the plan and says nothing was compared', async () => {
  const r = await K.check("kb.key('W').actuation(1)", { noKeyboard: 'not plugged in' });
  assert.ok(r.ok);
  assert.deepStrictEqual(r.summary.slice(0, 1), ['W: actuation 1.00 mm']);
  assert.ok(r.summary.some((s) => /Note: Keyboard not available \(not plugged in\)/.test(s)) && r.summary.some((s) => /nothing was compared/.test(s)));
  assert.strictEqual(r.compared, false);
});

test('diff: groups keys by their new values; key action maps already on the keyboard are kept', async () => {
  const plan = (await compile("kb.keys.named('W', 'A').actuation(1); kb.key('S').actuation(1.5); kb.mode('Mouse'); kb.key('Esc').when('press').if({ mode: 'Mouse' }).do(kb.mode('Mouse').leave());", STATE)).plan;
  const sw = Array.from({ length: 128 }, () => ({ actuation: 2 }));
  sw[9].actuation = 1;    // A is there already
  const esc = { key: 'Esc', slot: 1, press: 0.3, gap: 0.1, alsoType: false, rules: [{ when: 'press', mode: 'press', if: { mode: 'Mouse' }, do: { mode: 'Mouse', action: 'leave' } }] };
  const d = C.diff(plan, { profile: 0, unitMm: 0.005, switches: sw, keyActions: { maps: [esc], modes: [{ id: 1, name: 'Mouse' }], entries: 16 } }, STATE);
  assert.deepStrictEqual(d.writes.switches, [{ slots: [14], settings: { actuation: 1 } }, { slots: [15], settings: { actuation: 1.5 } }]);
  assert.strictEqual(d.writes.keyActions, undefined);
  assert.deepStrictEqual(d.changes.map((c) => c.text), ['W: actuation 1.00 mm (was 2.00 mm)', 'S: actuation 1.50 mm (was 2.00 mm)']);
  // resetKeyActions removes the maps the script doesn't define
  const reset = (await compile("kb.resetKeyActions(); kb.key('W').when('press').do(kb.send('A'))", STATE)).plan;
  const r = C.diff(reset, { keyActions: { maps: [esc], modes: [], entries: 16 } }, STATE);
  assert.deepStrictEqual(r.writes.keyActions.remove, [1]);
  assert.deepStrictEqual(r.writes.keyActions.maps, [{ slot: 14, rules: [{ when: 'press', do: { key: 'A' } }] }]);
  // the table is full with the keyboard's other maps
  const full = Array.from({ length: 16 }, (_, i) => ({ ...esc, key: undefined, slot: 40 + i }));
  assert.match(C.diff(reset, { keyActions: { maps: full, modes: [], entries: 16 } }, STATE).problems[0] ?? '', /^$/);
  assert.match(C.diff({ ...reset, keyActions: { ...reset.keyActions, replace: false } }, { keyActions: { maps: full, modes: [], entries: 16 } }, STATE).problems[0], /holds 16 keys; with the keyboard's other maps this would make 17/);
});

test('apply: writes only the differences through the driver, in order; refuses on errors', async () => {
  const { k, calls } = stubKeyboard({ adv: [{ slot: 21, kind: 'modtap', keys: ['LCtrl', 'Esc'], holdMs: 200 }] });
  const code = `kb.profile(2);
kb.keys.wasd.actuation(1.5);
kb.key('Q').actuation(2);
kb.key('E').fn('VolumeUp');
kb.key('A').snapTap('D');                  // D is mod-tap now: cleared first
kb.keys.wasd.color('red');
kb.lighting.brightness(3);
kb.pollingRate(8000);
kb.mode('Mouse');
kb.key('Up').when('press').if({ mode: 'Mouse' }).do(kb.mouse.move('up'));
kb.sequence('W tap; 50ms; release');`;
  const r = await K.apply(k, code);
  assert.ok(r.ok, JSON.stringify(r.errors));
  const names = calls.map((c) => c[0]);
  assert.deepStrictEqual(names, ['setProfile', 'setKey', 'setAllSwitches', 'clearAdvanced', 'setSnap', 'setPicture', 'setLighting', 'showPicture',
    'setReportRate', 'setKeyActionsBatch', 'playSequence']);
  assert.deepStrictEqual(calls[2], ['setAllSwitches', { actuation: 1.5 }, [14, 9, 15, 21]]);
  assert.deepStrictEqual(calls[3], ['clearAdvanced', 21]);
  assert.deepStrictEqual(calls[4], ['setSnap', 9, 21]);
  assert.deepStrictEqual(calls[5][2][14], [255, 0, 0]);
  assert.deepStrictEqual(calls[5][2][1], [0, 0, 0]);
  assert.deepStrictEqual(calls[9][1], { maps: [{ slot: 82, rules: [{ when: 'press', if: { mode: 'Mouse' }, do: { mouseKeys: 'up' } }] }], remove: [] });
  assert.ok(r.applied[0] === 'Active profile: 2 (was 0)' && r.applied.some((x) => /^W, A, S, D: actuation 1\.50 mm/.test(x)));
  // errors: nothing is written
  const s = stubKeyboard();
  const bad = await K.apply(s.k, "kb.key('W').actuation(1);\nkb.key('A').actuation(9);");
  assert.deepStrictEqual([bad.ok, bad.applied, s.calls], [false, [], []]);
  assert.deepStrictEqual(bad.errors, [{ line: 2, col: 13, message: 'actuation 9 mm is above 3.4' }]);
});

test('apply: a driver failure part way says what was written', async () => {
  const { k } = stubKeyboard();
  k.setLighting = async () => { throw new Error('device not connected'); };
  const r = await K.apply(k, "kb.key('W').actuation(1); kb.lighting.brightness(1);");
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.applied, ['W: actuation 1.00 mm (was 2.00 mm)']);
  assert.match(r.errors[0].message, /^stopped: device not connected \(the lines in applied were written\)/);
});

test('REST routes: check works without a keyboard, apply needs one, docs serve the declaration', async () => {
  const { kbcodeRoutes } = require('../src/web/kbcode-routes');
  const httpError = (status, message) => Object.assign(new Error(message), { status });
  const none = kbcodeRoutes({ keyboard: async () => { throw new Error('MAX68HE not found'); }, httpError });
  const r = await none['POST /api/kbcode/check']({ code: "kb.key('W').actuation(5)" });
  assert.deepStrictEqual([r.ok, r.changes, r.errors], [false, 0, [{ line: 1, col: 13, message: 'actuation 5 mm is above 3.4' }]]);
  assert.ok(Array.isArray(r.summary) && r.plan);
  const ok = await none['POST /api/kbcode/check']({ code: "kb.key('W').actuation(1)" });
  assert.ok(ok.ok && ok.summary.some((x) => /MAX68HE not found/.test(x)));
  await assert.rejects(none['POST /api/kbcode/apply']({ code: '' }), /MAX68HE not found/);
  await assert.rejects(none['POST /api/kbcode/check']({}), (e) => e.status === 400);
  const flashing = kbcodeRoutes({ keyboard: async () => { throw httpError(503, 'the keyboard is being flashed'); }, httpError });
  await assert.rejects(flashing['POST /api/kbcode/check']({ code: '' }), (e) => e.status === 503);
  const { k, calls } = stubKeyboard();
  const withKb = kbcodeRoutes({ keyboard: async () => k, httpError });
  const a = await withKb['POST /api/kbcode/apply']({ code: "kb.key('W').actuation(1)" });
  assert.deepStrictEqual([a.ok, a.applied, calls.length], [true, ['W: actuation 1.00 mm (was 2.00 mm)'], 1]);
  const d = await none['GET /api/kbcode/docs']({});
  assert.ok(d.dts.includes('interface KeyGroup') && d.examples.some((e) => e.name === 'mouse-mode'));
  const { ROUTES } = require('../src/web/server');
  assert.ok(ROUTES['POST /api/kbcode/check'] && ROUTES['POST /api/kbcode/apply'] && ROUTES['GET /api/kbcode/docs']);
});

test('MCP: run_kb_code checks without a keyboard (errors as "line N:C: ..."); get_kb_code_docs serves the declaration', async () => {
  const { Keyboard } = require('../src/keyboard');
  const realOpen = Keyboard.open;
  Keyboard.open = async () => { throw new Error('no keyboard in tests'); };
  try {
    const tools = require('../src/mcp').server._registeredTools;
    const bad = await tools.run_kb_code.handler({ code: "kb.key('W').actuation(9)" }, {});
    assert.strictEqual(bad.isError, true);
    assert.deepStrictEqual(JSON.parse(bad.content[0].text).errors, ['line 1:13: actuation 9 mm is above 3.4']);
    const ok = JSON.parse((await tools.run_kb_code.handler({ code: "kb.key('W').actuation(1)" }, {})).content[0].text);
    assert.deepStrictEqual([ok.ok, ok.compared, ok.summary[0]], [true, false, 'W: actuation 1.00 mm']);
    const apply = await tools.run_kb_code.handler({ code: "kb.key('W').actuation(1)", apply: true }, {});
    assert.ok(apply.isError && /no keyboard in tests/.test(apply.content[0].text));
    const docs = JSON.parse((await tools.get_kb_code_docs.handler({}, {})).content[0].text);
    assert.ok(docs.dts.includes('interface Rule') && docs.examples.length && docs.markdown === undefined);
  } finally {
    Keyboard.open = realOpen;
  }
});
