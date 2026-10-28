# kbcode: configure the keyboard with code

kbcode is JavaScript that describes the keyboard. A script calls a global `kb` object; loops, ifs,
functions and variables work as usual. Nothing is sent while the script runs: running it gives a
**plan**, then

- **check** runs the script, checks every value against the same limits as the driver, compares the
  plan with the keyboard and lists every change in plain words (nothing is written; without a
  keyboard it lists what would be written and says nothing was compared);
- **apply** refuses if anything is wrong, else writes only what differs, through the driver's own
  methods (with their flash pacing).

Anything a script does not mention stays as it is. The whole API, typed and commented, is in
[`kb.d.ts`](kb.d.ts) (an AI can write correct scripts from that file alone).

```js
for (const k of kb.keys.typing) k.actuation(1.2).rapidTrigger({ press: 0.15, release: 0.15 });
kb.lighting.effect('static').color('#ff4400');
kb.mode('Mouse');
kb.key('Up').when('press').if({ mode: 'Mouse' }).do(kb.mouse.move('up', { start: 100, max: 1200, rampMs: 1000, shareSpeed: true }));
```

## Running a script

| Where | Check (dry run) | Apply |
|---|---|---|
| CLI | `node src/cli.js kbcode my.js` (`json kbcode my.js` for JSON) | `node src/cli.js kbcode my.js --apply` |
| REST (web UI server) | `POST /api/kbcode/check { code }` | `POST /api/kbcode/apply { code }` |
| MCP | `run_kb_code { code }` | `run_kb_code { code, apply: true }` |

- `POST /api/kbcode/check` -> `{ ok, plan, summary: [text], changes: n, errors: [{ line, col, message }], logs, notes, compared }`.
  With no keyboard (not plugged in, or another program holds it) it still checks; `compared` is false and
  `summary` ends with a note saying so.
- `POST /api/kbcode/apply` -> `{ ok, applied: [text], errors, logs }`. Any error: nothing is written.
  A device failure part way stops with `stopped: ...`; `applied` lists what was written before it.
- `GET /api/kbcode/docs` -> `{ dts, markdown, examples: [{ name, code }] }` (MCP: `get_kb_code_docs`).

Errors carry the script's line and column: `line 12: actuation 3.6 mm is above 3.4`. All problems are
reported at once. `console.log(...)` output comes back in `logs` with its line.

## The sandbox

A script runs in a worker thread (its own V8 isolate, at most 128 MB) inside a fresh `node:vm` context:
no `require`, `process`, timers, `fetch`, `import`, shared memory or WebAssembly; the `kb` API is frozen
and built inside the sandbox, so nothing from the host process is reachable through it. A script gets
1 second; an endless loop (also one in promises) is stopped and reported, and the worker is killed if it
does not answer. Only a JSON string comes back out of the sandbox, and it is checked again outside.

## Guide

### Keys

`kb.key('W')`, `kb.key(14)` (a slot) and the groups `kb.keys.all`, `typing` (letters, digits, punctuation
and arrows, like the web UI's Typing pick), `letters`, `digits`, `wasd`, `arrows`, `modifiers`, `mods`,
`nav`, `rows[0..4]`, `named('Q', 'E')`, `except('Space')`. Every key setter works on a group and returns
it, so calls chain; groups iterate (`for (const k of kb.keys.wasd)`) and have `forEach`, `map`, `filter`,
`some`, `every`, `at`, `except`, `and`. `kb.layout` is the key names per row.

Keys are physical: `kb.key('Caps')` is the Caps Lock key even after it was remapped (the MAX68HE's slots
are its matrix positions). Names are case-insensitive, with aliases (`Ctrl`, `Shift`, `Alt`, `Win` = the
left one, `Escape`, `Backspace`, `PageUp`, ...).

### Switches (per profile)

`actuation(mm)` and `release(mm)` 0.1..3.4, `deadZone(mm)` 0..3.4, `rapidTrigger(true | false |
{ press, release, continuous })` with sensitivities 0.01..4 mm (`continuous` needs the open firmware), or
`switches({ ... })` with the driver's field names. Keys getting the same new values are written in one
bulk flash write each.

### What keys type

`remap(value, layer)` with a key value like the rest of the driver: `'A'`, `'Ctrl+C'`, `'VolumeUp'`,
`'MouseLeft'`, `'Macro2:toggle'`, `'Text3'`, `'MO1'`, `'Disabled'`, `'raw:00002a00'`. Layers: `'base'`
(default), `'fn'` (= `key.fn(value)`), `'fn2'`..`'fn4'` (`key.fn(value, 2)`), `'l1'`..`'l3'` or a mode name
(user layers = modes), and `{ layer: 'fn', os: 'mac' }` for another OS's Fn layer.

### Lighting and per-key colours

`kb.lighting.effect(name, opts)`, `.color(c)`, `.rainbow()`, `.speed(0..4)`, `.brightness(0..4)`,
`.direction(d)` (Wave, Flow, Spring, Neon, Loop), `.option(n)`. Effects by name: the stock ones and, on the
open firmware, its own (Droplet, Heatmap, Fire, Aurora, the pressure effects ...); one this firmware lacks
is an error. Colours: `'#ff4400'`, `'#f40'`, `'rgb(255, 68, 0)'`, `'hsl(16, 100%, 50%)'`, CSS names,
`[r, g, b]`, `kb.rgb()`, `kb.hsl()`.

`key.color(c)` paints a stored picture (`kb.lighting.picture(n, { fill, show })`, picture 0 by default,
other keys get `fill`, black by default). The picture is shown as the lighting unless the script picks
another effect (then it is stored only, and a note says so). The keyboard can't read pictures back, so
a script with colours writes its picture on every apply.

### Advanced keys

`modTap(hold, tap, holdMs)`, `toggle(key?, { repeat })`, `snapTap(other)`, `dks({ keys, levels, gapMm })`
(multi-level, open firmware) or `dks({ firstPointMm, secondPointMm, bindings })` (stock 2-point), and
`plain()`. A key has one kind; switching kinds clears the old one first. modTap, toggle and DKS set the
key's base mapping themselves, so a base-layer remap on the same key is an error.

### Rules the keyboard runs (key action maps)

```js
kb.key('E').when('hold', 300).if({ held: ['Fn'] }).mode('press').do(kb.gamepad.button('B'));
```

- `when`: `'press'`, `'release'`, `'down'`/`'past'` + mm, `'up'`/`'above'` + mm, `'hold'` + ms, `'tap'` + ms.
- `if`: `{ held: [keys], notHeld: [keys], mode: 'Mouse' | [..], notMode: ... }`; several `.if()` calls add up.
  `notHeld` (keys that must be up, e.g. `.if({ mode: 'Tilde', notHeld: 'Fn' })`) needs key action engine 5;
  held + notHeld name at most 3 keys.
- `mode` (how the output acts, the driver's rule `mode`): `press`, `while`, `tap`, `toggle`, `release`.
- `do`: `kb.send('Ctrl+C')`, `kb.mouse.button('L')`, `kb.mouse.move('up', opts)`, `kb.mouse.scroll('down')`,
  `kb.mouse.jump(dx, dy)`, `kb.mouse.glide(dx, dy, ms)`, `kb.mouse.wheel(n)`, `kb.gamepad.button('A')`,
  `kb.gamepad.axis('LY-', 40)`, `kb.gamepad.axisDepth('RT', 0.5, 3)`, `mode.enter()` / `.leave()` /
  `.toggle()`, `kb.leaveAllModes()`, or the driver's JSON (`{ key: 'Esc' }`).
- Mouse move / scroll options: `start`, `max`, `rampMs`, `curve`, `power`; `shareSpeed` + `keepMs` (engine 3);
  `speedBy: 'time'` (default, the speed builds over `rampMs`), `'pressure'` (the speed follows how deep the key
  is: start speed at `pressFrom`, max at `pressTo` mm and deeper, nothing moves while shallower than `pressFrom`;
  0 <= from < to <= 4, 0.1 mm steps, default 0.5 -> 3.2) or `'both'` (the depth sets the top speed, the ramp
  builds up to it); pressure / both need engine 4:
  `kb.mouse.move('up', { speedBy: 'pressure', pressFrom: 0.5, pressTo: 3.2 })`.
- Modes: `const m = kb.mode('Mouse')` declares a mode name (it reuses the keyboard's mode of that name,
  else a free one of the 3); `m.remap('H', 'Left')` = "in this mode, H acts as Left".
- `key.actionMap({ press, gap, alsoType })` sets the map's own options.
- `kb.resetKeyActions()` removes the keyboard's other maps (otherwise they are kept).

These compile 1:1 to the driver's key action maps (`src/key-actions.js`, the same JSON the Key wizard and
the Blocks view write), with the same limits: 6 rule slots per key (mouse move / scroll take 2, 3 with speedBy pressure / both), 16 keys,
15 different conditions, 3 modes. Script loops and ifs run once, to generate rules; what the keyboard can't
test is an error that says why (no "or": make two rules; no depth as a condition: use `when('down', mm)`).

### The rest

`kb.profile(n)` (made active first; check then lists the per-profile parts as planned and compares them on
apply), `kb.macro(i, 'text' | { text | steps, repeat, delayMs })`, `kb.text(i, 'text')`, `kb.options({ antiMistouch,
rtStability, wasdSwap })` (the OS mode has no setter in the driver: `os` other than 'win' is an error),
`kb.pollingRate(hz)`, `kb.firmwareOptions({ ... })`, `kb.textTyping('block')`, `kb.gamepad.settings({ ... })`,
`key.bindGamepad('ly-')` / `kb.gamepad.bind(key, target)`, `kb.sequence(text)` (played after the writes, on apply
only), and `kb.firmware.has('feature')` to branch on what the keyboard has.

## Examples

These are in `src/kbcode-examples.js` too (served by the docs route; the tests compile each one).

### Fast typing keys, snap tap on A / D, a lit WASD (gaming)

```js
// every typing key: shallow actuation and rapid trigger
for (const k of kb.keys.typing) k.actuation(1.2).rapidTrigger({ press: 0.15, release: 0.15 });
// strafing: pressing A lets go of D and the other way round
kb.key('A').snapTap('D');
// WASD cyan, everything else dim blue, shown as the lighting
kb.lighting.picture(0, { fill: '#000020' }).brightness(4);
kb.keys.wasd.forEach((k) => k.color('cyan'));
```

### A colour per row (per-key picture), computed in a loop (rainbow-rows)

```js
kb.keys.rows.forEach((row, i) => {
  row.color(kb.hsl(i * 60, 100, 50));
});
kb.lighting.effect('picture').brightness(3);
```

### Mouse mode (the tests/fixtures/ka-mouse-mode.json example as code) (mouse-mode)

```js
// Fn + Ctrl + M held 3 s turns mouse mode on. In it the arrows move the pointer
// (sharing their speed), Right Shift / PgDn click, Esc leaves.
const mouse = kb.mode('Mouse');
kb.key('M').when('hold', 3000).if({ held: ['Fn', 'LCtrl'] }).do(mouse.enter());
kb.key('RShift').when('press').if({ mode: mouse }).do(kb.mouse.button('L'));
kb.key('PgDn').when('press').if({ mode: mouse }).do(kb.mouse.button('R'));
for (const dir of ['Up', 'Down', 'Left', 'Right']) {
  kb.key(dir).when('press').mode('while').if({ mode: mouse })
    .do(kb.mouse.move(dir.toLowerCase(), { shareSpeed: true, keepMs: 150 }));
}
kb.key('Esc').when('press').if({ mode: mouse }).do(mouse.leave());
```

### Analog walk / run and tap / hold on the on-board engine (walk-run)

```js
// W: a light press walks (left stick 40 % up), past 2.5 mm runs (100 %)
kb.key('W').when('press').do(kb.gamepad.axis('LY-', 40));
kb.key('W').when('down', 2.5).do(kb.gamepad.axis('LY-', 100));
// E: a quick tap is A, holding it 300 ms is B
kb.key('E').when('tap', 300).do(kb.gamepad.button('A'));
kb.key('E').when('hold', 300).do(kb.gamepad.button('B'));
// C: a deep press toggles crouch (Left Ctrl stays down until the next deep press)
kb.key('C').when('down', 2.5).mode('toggle').do(kb.send('LCtrl'));
```

### A Nav mode: Fn + N toggles it, H J K L act as arrows inside it; Caps as mod-tap (nav-layer)

```js
const nav = kb.mode('Nav');
kb.key('N').when('press').if({ held: ['Fn'] }).do(nav.toggle());   // N alone still types N
const arrows = { H: 'Left', J: 'Down', K: 'Up', L: 'Right' };
for (const [key, arrow] of Object.entries(arrows)) nav.remap(key, arrow);
// Caps on its own: a tap is Esc, holding it is Left Ctrl
kb.key('Caps').modTap('LCtrl', 'Esc', 200);
```

### Text keys, a macro and the Fn layer (texts-macros)

```js
kb.text(0, 'Best regards,\nIvo');
kb.key('E').fn('Text0');             // Fn + E types the text
kb.macro(1, { text: 'git status', delayMs: 10 });
kb.key('G').fn('Macro1');            // Fn + G plays macro 1
kb.key('Home').fn('End');            // Fn + Home = End
kb.key('PgUp').fn('VolumeUp');
kb.key('PgDn').fn('VolumeDown');
```

### Options, firmware options and lighting (settings)

```js
kb.pollingRate(8000);
kb.options({ antiMistouch: false, rtStability: 0 });
kb.firmwareOptions({ capsIndicator: true, capsColor: 'orange', idleMinutes: 10 });
kb.textTyping('block');
kb.lighting.effect('wave', { direction: 'left', speed: 3 }).color('rgb(255, 0, 128)').brightness(4);
```

The mouse-mode example is `tests/fixtures/ka-mouse-mode.json` as code: it compiles to exactly that
file's `{ modes, maps }`, and applying it writes the same records, conditions and mode names (a test checks
both).

## The plan

`check` returns the plan, plain JSON with the driver's vocabulary, only the parts the script names:

```js
{ format: 'kbcode-plan', version: 1, model: 'max68he',
  profile, switches: [{ key, slot, actuation, rapidTrigger, rtPress, ... }],
  remap: [{ layer, os?, slot, key, value, bytes }], macros: [{ index, repeat, steps, text? }], texts: [{ index, text }],
  advanced: [{ slot, key, kind: 'modtap' | 'toggle' | 'snap' | 'dks' | 'plain', ... }],
  lighting: { mode, speed, brightness, option, r, g, b, rainbow, presetColour }, picture: { index, colors: { slot: '#rrggbb' }, fill, show },
  options, pollingRateHz, fwOptions, gamepad: { settings, bindings: [{ key, slot, target }] },
  keyActions: { modes: [{ id, name }], maps: [{ key, press?, gap?, alsoType?, rules }], replace? },
  sequence: { text, stopOnKey, steps, ms } }
```

Apply maps each part onto the existing driver calls: `setProfile`, `setKey` / `setFnLayerKey` /
`setLayerKey`, `setMacro`, `setText`, `setAllSwitches`, `clearAdvanced` / `setModTap` / `setToggle` /
`setSnap` / `setDks` / `setDksLevels`, `setPicture`, `setLighting`, `showPicture`, `setOptions`,
`setReportRate`, `setFirmwareOptions`, `setBoardGamepad`, `setKeyActionsBatch`, `playSequence`.

## How it is built

- `src/kbcode-api.js`: the `kb` object, run inside the sandbox from its source text; records operations
  with their line numbers.
- `src/kbcode-core.js`: pure (no Node-only APIs): layouts, colours, effects, plan building and validation
  (with `limits.js`, `keys.js`, `protocol.js`, `key-actions.js`, `key-modes.js`, `sequence.js`), and the diff.
  The browser-only web version can reuse it once it has a sandbox runner of its own (a worker); today the
  kbcode routes there answer that no sandbox is available.
- `src/kbcode-sandbox.js`: the worker that runs a script (`node:vm` inside a worker thread).
- `src/kbcode.js`: starts that worker (`runScript`), reads the keyboard, check and apply.
- `src/web/kbcode-routes.js`, `src/mcp-kbcode.js`, `src/cli.js` (`kbcode`): the three front ends.
- `docs/kb.d.ts`: the API declaration. Tests: `tests/kbcode.test.js`.

## Known limits

- Per-key pictures can't be read back, so they are always rewritten; odd macros on the stock firmware too.
- The OS mode (win / mac) has no setter in the driver.
- Each check or apply starts a worker for the script (some tens of ms).
- The web version (browser only) has no sandbox runner yet, so its kbcode routes answer with that error.
