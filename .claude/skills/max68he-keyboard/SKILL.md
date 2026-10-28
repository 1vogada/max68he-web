---
name: max68he-keyboard
description: Drive the Attack Shark X68MAX / MAX68HE keyboard through the max68he MCP server (src/mcp.js) and kbcode scripts — switches, lighting, remaps, key action maps, modes, hold bar, mode flash, mouse mode. Use whenever a task reads or changes the keyboard through the max68he tools, or writes a kbcode script.
---

# Driving the keyboard through the max68he MCP

The MCP server (`npm run mcp`, src/mcp.js) talks to the keyboard over USB HID. Every write goes to the
keyboard's flash and is paced (a call can take up to ~12 s). Tools marked "open firmware" are refused on
stock firmware: call `get_capabilities` first and use only what it lists.

## Rules

1. **Look before you write.** Read the current state (`get_key_actions`, `get_switches`, `get_firmware_options`, ...)
   before changing anything.
2. **Add to existing key maps, never replace them.** `set_key_actions` replaces the named key's whole map, and a
   kbcode script keeps the keyboard's other maps unless it calls `kb.resetKeyActions()` (never call it unless
   the user asks).
3. **A key's rules are rewritten together.** When you add a rule to a key that already has rules, restate all
   of its other rules in the same call (e.g. Esc's `In mode Mouse: leave mode Mouse` rule when you add a Tilde
   rule to Esc), or they are lost.
4. **Check before apply.** Run `run_kb_code` with `apply: false` (the default) first and show the user the
   summary of changes; apply only after that, with `apply: true`.
5. **Never flash firmware** or do anything that needs a flash without the user's explicit OK. No MCP tool
   flashes; don't look for a way around that.
6. Name the backtick key `` '`' ``, not `"Grave"`.
7. **Fn + Esc held 2 s leaves every mode**, whatever the maps say: tell the user when they seem stuck in a mode.

## The tools by job

- **Facts:** `get_info`, `get_capabilities`, `list_keys` (key names and slots), `get_options`, `get_firmware_options`,
  `get_scan_stats`, `get_key_depths` (live travel).
- **Switches:** `get_switches`, `set_switch`, `set_all_switches` (actuation, release, rapid trigger, dead zone, in mm), `calibrate_keys`.
- **Lighting:** `get_lighting`, `set_lighting`, `set_board_effect`, `set_key_colors`, `set_key_overlay`.
- **What keys type:** `remap_key`, `get_fn_layer`, `get_macro`, `set_macro_text`, `get_text_keys`, `set_text_key`.
- **Advanced keys** (mod-tap, toggle, snap tap, DKS): `get_advanced_keys`, `set_advanced_key`.
- **Key action maps and modes** (rules the keyboard runs itself): `get_key_actions`, `set_key_actions`, `get_modes`, `set_mode_name`.
- **kbcode:** `get_kb_code_docs` (the full API as TypeScript), `run_kb_code` (check, or apply).
- **Settings and profiles:** `set_profile`, `set_options`, `set_firmware_options`, `set_polling_rate`, `set_scan_timing`,
  `export_profile`, `import_profile`.
- **Gamepad:** `get_board_gamepad`, `set_board_gamepad`.
- **Host-driven (live, not saved):** `claim_keys`, `inject_keys`, `play_sequence`, `stop_sequence`.
- **Games plugin:** `get_games`, `set_game_mode`, `play_game`.

## kbcode recipes

kbcode is the safest way to make several changes: one script, one check, one apply. Rules are
`kb.key(k).when(trigger).if(cond).mode(m).do(action)`; limits are 6 rule slots per key (mouse move takes 2,
3 with `speedBy` pressure / both), 16 keys, 15 conditions and 3 modes.

**Mode toggled by a chord, with a remap inside it:**
```js
const tilde = kb.mode('Tilde', { flash: 'cyan', leaveFlash: true });   // mode flash: 3x on enter, 1x on leave
kb.key('B').when('press').if({ held: ['Fn', 'LCtrl'] }).do(tilde.toggle());
tilde.remap('Esc', '`');
```

**Mouse mode:**
```js
const mouse = kb.mode('Mouse');
kb.key('M').when('hold', 3000).if({ held: ['Fn', 'LCtrl'] }).do(mouse.enter());
kb.key('RShift').when('press').if({ mode: mouse }).do(kb.mouse.button('L'));
kb.key('PgDn').when('press').if({ mode: mouse }).do(kb.mouse.button('R'));
for (const dir of ['Up', 'Down', 'Left', 'Right'])
  kb.key(dir).when('press').mode('while').if({ mode: mouse }).do(kb.mouse.move(dir.toLowerCase(), { shareSpeed: true, keepMs: 150 }));
kb.key('Esc').when('press').if({ mode: mouse }).do(mouse.leave());
```
Speed by key depth: `kb.mouse.move('up', { speedBy: 'pressure', pressFrom: 0.5, pressTo: 3.2 })`.

**Hold bar** (Home, Del, PgUp, PgDn, Right fill while a HOLD rule builds up and flash 3x when it fires):
`kb.holdBar({ on: true, color: 'cyan', escColor: 'red' })`. `escColor` is used for Esc holds (Fn + Esc 2 s,
HOLD rules on Esc); the defaults are green and red.

**Flash the column as a rule action:** `kb.key('P').when('press').if({ held: ['Fn'] }).do(kb.flash('magenta', 5))`.
Black is an error for any flash colour (0, 0, 0 means "default" on the keyboard).

**Other conditions:** `if({ notHeld: ['Fn'] })` (needs key action engine 5), `if({ notMode: 'Mouse' })`.
Triggers: `press`, `release`, `down`/`up` + mm, `hold` + ms, `tap` + ms. Output modes: `press`, `while`,
`tap`, `toggle`, `release`.

**Switches and lighting:**
```js
for (const k of kb.keys.typing) k.actuation(1.2).rapidTrigger({ press: 0.15, release: 0.15 });
kb.lighting.effect('static').color('#ff4400');
```

For anything not shown here, call `get_kb_code_docs` and follow it; don't guess API names.
