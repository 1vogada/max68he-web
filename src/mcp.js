#!/usr/bin/env node
// MCP server (stdio) exposing the keyboard API as tools.
// stdout carries the protocol: never console.log here.
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { createConnection } = require('./connection');
const { parseKey, slotName, textToSteps, describeSteps, FUNCTIONS } = require('./keys');
const { MAX_ACTUATION_MM, SWITCH_LIMITS } = require('./limits');

// Runs a tool body; a device error drops the connection (a stale handle reopens and the
// body runs once more when nothing was sent, see connection.js).
function toolRunner(conn) {
  return (fn) => async (args) => {
    try {
      const data = await conn.run(async () => fn(await conn.get(), args ?? {}));
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `error: ${e.message}` }], isError: true };
    }
  };
}

async function resolveSlot(k, key) {
  if (typeof key === 'number') return key;
  if (/^\d+$/.test(key)) return Number(key);
  const hit = (await k.listKeys()).find((x) => x.name.toLowerCase() === key.toLowerCase());
  if (!hit) throw new Error(`no key named ${key}; call list_keys`);
  return hit.slot;
}

async function switchRows(k, slot) {
  const [keys, sw] = [await k.listKeys(), await k.getSwitches()];
  return keys.filter((x) => slot === undefined || x.slot === slot).map((x) => ({ key: x.name, ...sw[x.slot] }));
}

const mm = (max) => z.number().min(0).max(max);
const lim = (f) => z.number().min(SWITCH_LIMITS[f][0]).max(SWITCH_LIMITS[f][1]);   // same limits as the web API
const switchShape = {
  actuation: lim('actuation').optional().describe(`actuation point in mm (0.1..${MAX_ACTUATION_MM})`),
  release: lim('release').optional().describe('release point in mm when rapid trigger is off'),
  rapidTrigger: z.boolean().optional(),
  continuousRt: z.boolean().optional().describe('open firmware: rapid trigger stays armed until the key is fully up'),
  rtPress: lim('rtPress').optional().describe('rapid trigger press sensitivity in mm (min 0.01)'),
  rtRelease: lim('rtRelease').optional().describe('rapid trigger release sensitivity in mm (min 0.01)'),
  deadZone: lim('deadZone').optional().describe('bottom dead zone in mm'),
};
const WRITE_NOTE = 'Writes to keyboard flash; the server paces flash writes (up to ~12 s per call).';
const OPEN_FW = 'Needs the open X68MAX firmware; refused on stock firmware.';

// The tools on a fresh McpServer. conn: the keyboard connection to use; the web server passes
// its own (the Assistant page, src/assistant.js), `npm run mcp` gets one that closes the keyboard
// after IDLE_MS without a call (the web UI can open it then; flash pacing holds, see connection.js).
const IDLE_MS = 5000;
function createMcpServer({ conn = createConnection({ idleMs: IDLE_MS }) } = {}) {
  const tool = toolRunner(conn);
  const server = new McpServer({ name: 'max68he', version: '0.1.0' });

  server.registerTool('get_info', {
    description: 'Board id, firmware, active profile, lighting and sleep timers of the Attack Shark MAX68HE.',
  }, tool(async (k) => ({
    ...k.info, profile: await k.getProfile(), lighting: await k.getLighting(),
    pollingRateHz: await k.getReportRate(), sleepSeconds: await k.getSleepTimers(),
  })));

  server.registerTool('list_keys', {
    description: 'Keymap slots that hold a key in the active profile, with key names. Slots identify keys in other tools.',
  }, tool((k) => k.listKeys()));

  server.registerTool('get_switches', {
    description: 'Hall-effect settings in mm (actuation, release, rapid trigger, dead zone) for every key or one key.',
    inputSchema: { key: z.union([z.string(), z.number().int()]).optional().describe('key name like "Q" or "Esc", or a slot number; omit for all') },
  }, tool(async (k, { key }) => switchRows(k, key === undefined ? undefined : await resolveSlot(k, key))));

  server.registerTool('set_switch', {
    description: `Change hall-effect settings on one key; unspecified fields keep their value. ${WRITE_NOTE}`,
    inputSchema: { key: z.union([z.string(), z.number().int()]).describe('key name or slot'), ...switchShape },
  }, tool(async (k, { key, ...settings }) => {
    const slot = await resolveSlot(k, key);
    if (!Object.keys(settings).length) throw new Error('nothing to change');
    await k.setSwitch(slot, settings);
    return switchRows(k, slot);
  }));

  server.registerTool('set_all_switches', {
    description: 'Apply the same hall-effect settings to many keys in one write: every key, only `keys`, '
      + `or every key except \`exceptKeys\`. Unspecified fields keep each key's value. ${WRITE_NOTE}`,
    inputSchema: {
      ...switchShape,
      keys: z.array(z.union([z.string(), z.number().int()])).optional().describe('only these keys'),
      exceptKeys: z.array(z.union([z.string(), z.number().int()])).optional().describe('every key but these'),
    },
  }, tool(async (k, { keys, exceptKeys, ...settings }) => {
    if (!Object.keys(settings).length) throw new Error('nothing to change');
    if (keys && exceptKeys) throw new Error('give keys or exceptKeys, not both');
    const slots = keys ? await k.resolveSlots(keys) : exceptKeys ? await k.slotsExcept(exceptKeys) : undefined;
    await k.setAllSwitches(settings, slots);
    return switchRows(k);
  }));

  server.registerTool('get_lighting', {
    description: 'Current backlight mode, speed (0-4), brightness (0-4), option, colour.',
  }, tool((k) => k.getLighting()));

  server.registerTool('set_lighting', {
    description: 'Change the backlight; unspecified fields keep their value. Modes: 1 static, 2 breathing, '
      + '3 spectrum, 4 wave (option 0-3: right/left/down/up), 5 ripple, 6 star dots, 7 flow, 8 key shadow, '
      + '9 layers, 10 sine, 11 spring, 12 neon, 14 radiant, 15 loop, 16 colour grid, 17 snowfall, '
      + `18 meteor, 19 silent snow. ${WRITE_NOTE}`,
    inputSchema: {
      mode: z.number().int().min(1).max(19).refine((m) => m !== 13, 'mode 13 unsupported').optional(),
      speed: z.number().int().min(0).max(4).optional(),
      brightness: z.number().int().min(0).max(4).optional(),
      option: z.number().int().min(0).max(15).optional(),
      color: z.string().regex(/^#?[0-9a-fA-F]{6}$/).optional().describe('hex colour like "ff0000"'),
      rainbow: z.boolean().optional(),
      presetColour: z.number().int().min(0).max(6).optional()
        .describe('built-in colour: 0 red, 1 orange, 2 yellow, 3 green, 4 cyan, 5 blue, 6 magenta'),
    },
  }, tool(async (k, { color, rainbow, presetColour, ...rest }) => {
    const changes = { ...rest };
    if (rainbow) Object.assign(changes, { rainbow: true, presetColour: null });
    if (presetColour !== undefined) Object.assign(changes, { presetColour, rainbow: false });
    if (color) {
      const v = parseInt(color.replace('#', ''), 16);
      Object.assign(changes, { r: v >> 16, g: (v >> 8) & 0xff, b: v & 0xff, rainbow: false, presetColour: null });
    }
    if (!Object.keys(changes).length) throw new Error('nothing to change');
    return k.setLighting(changes);
  }));

  server.registerTool('set_board_effect', {
    description: 'Pick a lighting effect rendered by the open firmware itself (no PC needed), by name. Pressure effects use how deep, '
      + 'how fast and how long keys are pressed: Trampoline, Liquid dye, Frost, Lava lamp, Charge shot, Impact, Sparks, Lightning, '
      + 'Gravity, Squeeze, Actuation trainer, WASD gauge, Spotlight, Pressure paint. color = single colour (else the effect\'s own), '
      + 'rainbow = multi-colour. Unavailable effects are refused. ' + OPEN_FW,
    inputSchema: {
      effect: z.string().describe('effect name, e.g. "Trampoline" (case-insensitive)'),
      speed: z.number().int().min(0).max(4).optional(),
      brightness: z.number().int().min(0).max(4).optional(),
      color: z.string().regex(/^#?[0-9a-fA-F]{6}$/).optional(),
      rainbow: z.boolean().optional(),
    },
  }, tool(async (k, { effect, color, rainbow, ...rest }) => {
    const P = require('./protocol');
    const modes = P.openModesFor(k.info.custom ? await k.getCaps() : null);
    const hit = Object.entries(modes).find(([, name]) => name.toLowerCase() === effect.toLowerCase());
    if (!hit) throw new Error(`effect is one of: ${Object.values(modes).join(', ')}`);
    const changes = { mode: Number(hit[0]), ...rest };
    if (rainbow) Object.assign(changes, { rainbow: true, presetColour: null });
    if (color) {
      const v = parseInt(color.replace('#', ''), 16);
      Object.assign(changes, { r: v >> 16, g: (v >> 8) & 0xff, b: v & 0xff, rainbow: false, presetColour: null });
    } else if (!rainbow) Object.assign(changes, { r: 0, g: 0, b: 0, rainbow: false, presetColour: null });
    return k.setLighting(changes);
  }));

  server.registerTool('set_profile', {
    description: 'Switch the active profile (0-3). Each profile has its own keymap and switch settings.',
    inputSchema: { profile: z.number().int().min(0).max(3) },
  }, tool(async (k, { profile }) => {
    await k.setProfile(profile);
    return { profile: await k.getProfile() };
  }));

  const keyArg = z.union([z.string(), z.number().int()]);

  server.registerTool('get_fn_layer', {
    description: 'Fn-layer mappings: what each key does while Fn is held (keys not listed fall through to their base function).',
  }, tool(async (k) => {
    const names = Object.fromEntries((await k.listKeys()).map((x) => [x.slot, x.name]));
    return (await k.getFnKeymap()).map((v, slot) => ({ slot, key: names[slot] ?? null, fn: slotName(v) }))
      .filter((x) => x.fn);
  }));

  server.registerTool('remap_key', {
    description: 'Remap one key on the base layer or the Fn layer. value examples: "A", "Esc", "Ctrl+C", '
      + '"Ctrl+Shift+Esc", "Macro2" or "Macro2:toggle"/"Macro2:hold", "Disabled", "raw:00002a00", or a named '
      + `function: ${Object.keys(FUNCTIONS).join(', ')}. Saved to the keyboard.`,
    inputSchema: {
      key: keyArg.describe('key to change: name from list_keys or slot number'),
      value: z.string().describe('what the key should do'),
      layer: z.enum(['base', 'fn']).optional().describe('default base'),
    },
  }, tool(async (k, { key, value, layer = 'base' }) => {
    const slot = await resolveSlot(k, key);
    const got = await k.setKey(slot, parseKey(value), { layer });
    return { slot, layer, now: slotName(got) ?? (layer === 'fn' ? 'falls through to base' : 'disabled') };
  }));

  server.registerTool('set_polling_rate', {
    description: 'Set the USB polling rate in Hz.',
    inputSchema: { hz: z.union([8000, 4000, 2000, 1000, 500, 250, 125].map((v) => z.literal(v))) },
  }, tool(async (k, { hz }) => ({ pollingRateHz: await k.setReportRate(hz) })));

  server.registerTool('get_macro', {
    description: 'Read macro 0-15. Firmware 5.04 cannot read back odd-numbered macros (they still play).',
    inputSchema: { index: z.number().int().min(0).max(15) },
  }, tool(async (k, { index }) => {
    const m = await k.getMacro(index);
    return m ? { ...m, readable: describeSteps(m.steps) } : { index, note: 'odd macros cannot be read back on this firmware' };
  }));

  server.registerTool('set_macro_text', {
    description: 'Store macro 0-15 that types the given text (US layout). Assign it to a key with remap_key value "Macro<n>". '
      + WRITE_NOTE,
    inputSchema: {
      index: z.number().int().min(0).max(15),
      text: z.string().min(1).max(60),
      repeat: z.number().int().min(1).max(100).optional(),
      delayMs: z.number().int().min(1).max(1000).optional(),
    },
  }, tool(async (k, { index, text, repeat = 1, delayMs = 15 }) => {
    const m = await k.setMacro(index, textToSteps(text, delayMs), repeat);
    return { index, stored: true, steps: m ? m.steps.length : 'not readable (odd index)' };
  }));

  server.registerTool('set_key_colors', {
    description: 'Store a per-key colour picture (slot 0-4) and show it. colors maps key names or slots to hex colours; '
      + 'keys not listed are off unless defaultColor is given. ' + WRITE_NOTE,
    inputSchema: {
      picture: z.number().int().min(0).max(4),
      colors: z.record(z.string(), z.string().regex(/^#?[0-9a-fA-F]{6}$/)),
      defaultColor: z.string().regex(/^#?[0-9a-fA-F]{6}$/).optional(),
      show: z.boolean().optional().describe('switch lighting to this picture, default true'),
    },
  }, tool(async (k, { picture, colors, defaultColor, show = true }) => {
    const hex = (h) => { const v = parseInt(h.replace('#', ''), 16); return [v >> 16, (v >> 8) & 0xff, v & 0xff]; };
    const rgb = [];
    if (defaultColor) (await k.listKeys()).forEach((x) => { rgb[x.slot] = hex(defaultColor); });
    const names = Object.keys(colors);
    const slots = await k.resolveSlots(names);
    slots.forEach((s, i) => { rgb[s] = hex(colors[names[i]]); });
    await k.setPicture(picture, rgb);
    return { picture, keys: rgb.filter(Boolean).length, lighting: show ? await k.showPicture(picture) : undefined };
  }));

  server.registerTool('get_advanced_keys', {
    description: 'Keys using snap tap, mod-tap, toggle or dynamic keystroke (DKS), with their settings.',
  }, tool((k) => k.getAdvancedKeys()));

  const cell = z.number().int().min(0).max(3);
  server.registerTool('set_advanced_key', {
    description: 'Make a key a snap tap / mod-tap / toggle / DKS key, or "clear" it back to plain. '
      + 'snap: needs partner (pressing one releases the other). modtap: hold, tap, holdMs. toggle: key, repeat. '
      + 'dks: firstPointMm < secondPointMm and 1-4 bindings {key, cells:[press past first, press past second, '
      + 'release past second, release past first]} with 0 none, 1 tap, 2 press until next event, 3 hold until full release. '
      + 'Multi-level DKS (open firmware with DKS levels, preferred there): dksKeys (up to 4 key names) and levels '
      + '(1-8, each deeper than the last, depthMm 0.05-5) with per bound key {down, up} actions: none, tap, press '
      + '(until the next event), hold (until fully up), release; gapMm (default 0.1) is how far above a level it counts as left. '
      + WRITE_NOTE,
    inputSchema: {
      key: keyArg,
      type: z.enum(['clear', 'snap', 'modtap', 'toggle', 'dks']),
      partner: keyArg.optional(),
      hold: z.string().optional(),
      tap: z.string().optional(),
      holdMs: z.number().int().min(10).max(2550).optional(),
      toggleKey: z.string().optional(),
      repeat: z.boolean().optional(),
      firstPointMm: z.number().min(0.1).max(MAX_ACTUATION_MM - 0.1).optional(),
      secondPointMm: z.number().min(0.2).max(MAX_ACTUATION_MM).optional().describe('the key actuation point'),
      bindings: z.array(z.object({ key: z.string(), cells: z.array(cell).length(4) })).min(1).max(4).optional(),
      dksKeys: z.array(z.string()).min(1).max(4).optional(),
      levels: z.array(z.object({
        depthMm: z.number().min(0.05).max(5),
        actions: z.array(z.object({ down: z.enum(['none', 'tap', 'press', 'hold', 'release']).default('none'),
          up: z.enum(['none', 'tap', 'press', 'hold', 'release']).default('none') })).max(4),
      })).min(1).max(8).optional(),
      gapMm: z.number().min(0).max(1).optional(),
    },
  }, tool(async (k, a) => {
    const slot = await resolveSlot(k, a.key);
    const need = (v, name) => { if (v === undefined) throw new Error(`${a.type} needs ${name}`); return v; };
    if (a.type === 'clear') await k.clearAdvanced(slot);
    else if (a.type === 'snap') await k.setSnap(slot, await resolveSlot(k, need(a.partner, 'partner')));
    else if (a.type === 'modtap') await k.setModTap(slot, parseKey(need(a.hold, 'hold')), parseKey(need(a.tap, 'tap')), a.holdMs ?? 200);
    else if (a.type === 'toggle') await k.setToggle(slot, parseKey(need(a.toggleKey, 'toggleKey')), Boolean(a.repeat));
    else if (a.levels) {
      await k.setDksLevels(slot, { keys: need(a.dksKeys, 'dksKeys'), levels: a.levels, gapMm: a.gapMm ?? 0.1 });
    } else {
      await k.setDks(slot, {
        firstPointMm: need(a.firstPointMm, 'firstPointMm'),
        secondPointMm: need(a.secondPointMm, 'secondPointMm'),
        bindings: need(a.bindings, 'bindings').map((b) => ({ key: parseKey(b.key), cells: b.cells })),
      });
    }
    return (await k.getAdvancedKeys()).find((x) => x.slot === slot) ?? { slot, kind: 'normal' };
  }));

  server.registerTool('get_text_keys', {
    description: 'The 64 strings the keyboard types by itself (open firmware with text keys). A key set to TextN '
      + '(set_key / remap, on any layer or Fn layer) types string N when pressed.',
  }, tool(async (k) => (await k.getTexts()).map((text, index) => ({ index, text })).filter((x) => x.text)));

  server.registerTool('set_text_key', {
    description: 'Set string N (0-63, up to 119 bytes of UTF-8) that the keyboard types when a TextN key is pressed. Plain characters are typed '
      + 'with the US layout; others (accents, symbols, emoji, lenny faces) through the system Unicode input set by set_firmware_options unicode '
      + '(windows needs HKCU Input Method EnableHexNumpad=1). '
      + WRITE_NOTE,
    inputSchema: { index: z.number().int().min(0).max(63), text: z.string().max(119) },
  }, tool(async (k, { index, text }) => ({ index, text: await k.setText(index, text) })));

  server.registerTool('get_options', {
    description: 'Keyboard options: WASD/arrow swap, accidental-touch protection, rapid-trigger stability.',
  }, tool((k) => k.getOptions()));

  server.registerTool('set_options', {
    description: 'Change keyboard options; unspecified ones keep their value.',
    inputSchema: {
      wasdSwap: z.boolean().optional(),
      antiMistouch: z.boolean().optional(),
      rtStability: z.union([0, 25, 50, 75, 100, 125].map((v) => z.literal(v))).optional(),
    },
  }, tool(async (k, changes) => k.setOptions(changes)));

  server.registerTool('export_profile', {
    description: 'Back up the active profile (keys, Fn layer, advanced keys, switch settings, lighting, options) to a JSON file.',
    inputSchema: { path: z.string().describe('absolute path of the .json file to write') },
  }, tool(async (k, { path }) => {
    if (!/.json$/i.test(path)) throw new Error('path must end in .json');
    const data = await k.exportProfile();
    require('fs').writeFileSync(path, JSON.stringify(data, null, 1));
    return { written: path, profile: data.profile };
  }));

  server.registerTool('import_profile', {
    description: 'Restore a backup JSON (from export_profile or the web UI) into the active profile. Overwrites it. ' + WRITE_NOTE,
    inputSchema: { path: z.string().describe('absolute path of the .json backup') },
  }, tool(async (k, { path }) => k.importProfile(JSON.parse(require('fs').readFileSync(path, 'utf8')))));

  server.registerTool('get_capabilities', {
    description: 'What the keyboard firmware supports: stock or open firmware, and for the open firmware the per-key API version, key/LED counts and features. ' + OPEN_FW,
  }, tool(async (k) => (k.info.custom ? { firmware: 'open', ...(await k.getCaps()) } : { firmware: 'stock' })));

  server.registerTool('get_firmware_options', {
    description: 'Open-firmware options: Caps Lock indicator and colour, snap tap resolution, status guide, idle lighting timeout, layer indicator, '
      + 'hold bar, and on newer firmware modeFlash (per key action mode 1..3: enter / leave flash on or off and their colours). ' + OPEN_FW,
  }, tool((k) => k.getFirmwareOptions()));

  server.registerTool('set_firmware_options', {
    description: 'Change open-firmware options; unspecified ones keep their value. snapMode decides which of two snap-tap partners wins '
      + 'when both are down: last pressed, neither (neutral), first pressed, or deeper pressed ("Rappy Snappy"). ' + OPEN_FW,
    inputSchema: {
      snapMode: z.enum(require('./protocol').SNAP_MODES).optional(),
      capsIndicator: z.boolean().optional(),
      capsColor: z.array(z.number().int().min(0).max(255)).length(3).optional(),
      statusGuide: z.boolean().optional(),
      idleMinutes: z.number().int().min(0).max(255).optional().describe('0 = never'),
      layerIndicator: z.boolean().optional(),
      fnHold: z.boolean().optional().describe('Fn+Home/Del/PgUp/PgDn picks Fn layer 1-4: true = only while held, false = it stays'),
      perf: z.boolean().optional().describe('performance mode: no lighting drawn (LEDs off), more time for the keys'),
      unicode: z.enum(require('./protocol').UNICODE_MODES).optional()
        .describe('how text keys type non-US characters: windows (Alt+numpad+ hex, needs EnableHexNumpad), linux (Ctrl+Shift+U), mac (Unicode Hex Input)'),
      textTyping: z.enum(require('./protocol').TEXT_TYPING_MODES).optional()
        .describe('other keys while a text key is typing: keep (they work, default), block (ignored until it is done; Esc stops the text), stop (any press stops the text, then works)'),
      compatMode: z.boolean().optional()
        .describe('compatibility mode: report only a 6-key boot keyboard, no NKRO (for BIOS, consoles, KVMs); a 7th key is left out'),
      releaseDebounceMs: z.number().int().min(0).max(require('./protocol').RELEASE_DEBOUNCE_MAX).optional()
        .describe('release debounce: a released key stays down this many ms so a bouncing release is not sent; presses are not delayed. 0 = off'),
      dimMinutes: z.number().int().min(0).max(255).optional()
        .describe('dim the lighting after this many idle minutes (0 = never), before idleMinutes turns it off'),
      dimPercent: z.number().int().min(0).max(100).optional().describe('brightness while dimmed, % (default 30)'),
      holdBar: z.boolean().optional()
        .describe('hold progress bar (caps holdBar): while a key action HOLD rule builds up, Home/Del/PgUp/PgDn/Right fill over its hold time and flash 3 times when it fires; default on'),
      holdBarEscColor: z.array(z.number().int().min(0).max(255)).length(3).optional()
        .describe('hold progress bar colour [r, g, b] while an Esc hold drives it (Fn+Esc 2 s leave-all-modes, a key action HOLD rule on Esc); default [255, 0, 0] red ([0, 0, 0] also means red)'),
      holdBarColor: z.array(z.number().int().min(0).max(255)).length(3).optional()
        .describe('hold progress bar colour [r, g, b] (default [0, 255, 0] green; [0, 0, 0] also means green)'),
      modeFlash: z.array(z.object({
        mode: z.number().int().min(1).max(3).describe('key action mode 1..3'),
        enter: z.boolean().optional().describe('flash 3 times when the mode turns on (default true)'),
        enterColor: z.array(z.number().int().min(0).max(255)).length(3).optional().describe('[r, g, b] of the enter flash (default [0, 255, 0] green)'),
        leave: z.boolean().optional().describe('flash once when the mode turns off (default true)'),
        leaveColor: z.array(z.number().int().min(0).max(255)).length(3).optional().describe('[r, g, b] of the leave flash (default [64, 64, 64] dim white)'),
      }).strict()).max(3).optional()
        .describe('mode flash (caps modeFlash): the hold bar column (Home/Del/PgUp/PgDn/Right) flashes 3 times when a key action mode turns on, '
          + 'once when it turns off. Per mode; list only the modes and fields to change, the rest keep their value. '
          + 'Black [0, 0, 0] is refused (the keyboard reads 0, 0, 0 as the default colour). Firmware without modeFlash refuses it.'),
    },
  }, tool(async (k, changes) => k.setFirmwareOptions(changes)));

  server.registerTool('calibrate_keys', {
    description: 'Per-key travel calibration. start: the keyboard mutes every key and the user presses each key to the bottom once '
      + '(LEDs: red to do, yellow pressed, green done); status: progress; finish: keep and save the measured keys; cancel; '
      + 'reset: every key back to the default range (saved). ' + OPEN_FW,
    inputSchema: { action: z.enum(['status', 'start', 'finish', 'cancel', 'reset']) },
  }, tool((k, { action }) => k.calibration(action)));

  server.registerTool('get_scan_stats', {
    description: 'Measure the key scan for ~1 s: scans/s (sensor frames), passes/s (key-processing loops), pass timing and the scan settings. ' + OPEN_FW,
  }, tool((k) => k.getScanStats(1000)));

  server.registerTool('set_scan_timing', {
    description: 'Tune the key scan live (not saved; a replug restores the defaults). settleUs: row settle time; adcDiv: ADC clock = 216 MHz / (adcDiv + 2); '
      + 'sample: ADC sample time code 0-7 (1.5 .. 239.5 cycles); background: background scanning. Check noise with get_key_depths afterwards. ' + OPEN_FW,
    inputSchema: {
      settleUs: z.number().int().min(1).max(200).optional(),
      adcDiv: z.number().int().min(0).max(15).optional(),
      sample: z.number().int().min(0).max(7).optional(),
      background: z.boolean().optional(),
      resetMax: z.boolean().optional(),
    },
  }, tool(async (k, t) => k.setScanTiming(t)));

  server.registerTool('get_board_gamepad', {
    description: 'On-board analog gamepad: whether it runs, response settings and key bindings. ' + OPEN_FW,
  }, tool(async (k) => k.getBoardGamepad()));

  server.registerTool('set_board_gamepad', {
    description: 'Configure the gamepad the keyboard itself presents to games (no PC software needed). '
      + 'bindings replaces all bindings when given. Targets: ' + require('./protocol').GAMEPAD_TARGETS.join(' ') + '. ' + OPEN_FW,
    inputSchema: {
      enabled: z.boolean().optional(),
      keysStopTyping: z.boolean().optional().describe('bound keys stop typing while the gamepad runs'),
      curve: z.enum(['linear', 'smooth', 'aggressive', 'instant', 'custom']).optional(),
      deadzoneMm: mm(4).optional(), fullMm: mm(4).optional(), buttonMm: mm(4).optional(),
      points: z.array(z.tuple([z.number().int().min(0).max(255), z.number().int().min(0).max(255)])).length(4).optional()
        .describe("custom curve: 4 [x, y] points 0..255, x from the dead zone to full press, y the output, left to right"),
      antiDeadzone: z.number().int().min(0).max(100).optional().describe('% where sticks and triggers start once pressed (beats a game\'s own dead zone)'),
      square: z.boolean().optional().describe('full diagonal gives full x and y (square stick)'),
      snappy: z.boolean().optional().describe('opposite keys on one axis: the deeper one wins instead of cancelling'),
      diagonalDeg: z.number().int().min(0).max(80).optional().describe('0 = off, else 10..80: where two equal keys point'),
      bindings: z.array(z.object({ key: keyArg, target: z.string() })).optional(),
    },
  }, tool(async (k, { bindings, ...settings }) => {
    const b = bindings && await Promise.all(bindings.map(async ({ key, target }) => ({ slot: (await k.resolveSlots([key]))[0], target })));
    return k.setBoardGamepad({ ...settings, ...(b && { bindings: b }) });
  }));

  server.registerTool('claim_keys', {
    description: 'Software takes over keys: they stop typing and report press/release events instead (empty list releases all). ' + OPEN_FW,
    inputSchema: { keys: z.array(keyArg).describe('key names or slots; [] releases every claimed key') },
  }, tool(async (k, { keys }) => {
    if (!keys.length) { await k.releaseKeys(); return { claimed: [] }; }
    const slots = await k.resolveSlots(keys);
    await k.claimKeys(slots);
    return { claimed: slots };
  }));

  server.registerTool('inject_keys', {
    description: 'Press keys from software (they stay down ~2 s unless refreshed; empty releases). Modifiers bits: 1 LCtrl, 2 LShift, 4 LAlt, 8 LWin. ' + OPEN_FW,
    inputSchema: { keys: z.array(z.string()).max(6), modifiers: z.number().int().min(0).max(255).optional() },
  }, tool(async (k, { keys, modifiers = 0 }) => {
    const usages = keys.map((n) => { const v = parseKey(n); if (v[0] !== 0 || v[1] !== 0) throw new Error(`${n} is not a plain key`); return v[2]; });
    await k.injectKeys(modifiers, usages);
    return { pressed: keys, modifiers };
  }));

  const SEQ_NOTE = 'In online games with anti-cheat, automated input can break their rules.';
  server.registerTool('play_sequence', {
    description: 'The keyboard plays a timed sequence of key (and mouse) input on its own clock, so the PC sees real input with exact timing. '
      + 'Text: statements split by ";" or new lines: "W down; 120ms; Space tap; 30ms; release", "Ctrl+C tap", "Space tap 50ms", "click L", '
      + '"mouse down R", "move 10 -5", "wheel 2", "1.5s". Or JSON steps [{ delay, event: down|up|tap|release|click|mouseDown|mouseUp|move|wheel|wait, key, button, dx, dy, notches }]. '
      + 'Mouse glides (firmware caps "sequenceGlide") move the pointer gradually instead of in one jump: "move 300 0 over 500ms" (linear), '
      + '"move 0 -200 over 1s ease out" (ease in|out|inout [P 0.3..8, default 2]), "move 100 100 over 400ms sine", "... expo [K -20..20, not 0, default 5]", '
      + '"... smooth", "move 200 0 over 800ms curve points 0,0 64,200 192,230 255,255" (4 x,y points 0..255, x not going down). '
      + 'A glide runs in the background (the next step follows at once; up to 4 at a time) and the sequence ends after it. '
      + 'JSON: { event: "move", dx, dy, over: ms, curve: linear|easeIn|easeOut|easeInOut|sine|expo|smooth|points, power, points: [[x,y] x4] }. '
      + `Up to 512 steps; everything is let go at the end. ${SEQ_NOTE} ${OPEN_FW}`,
    inputSchema: {
      text: z.string().optional().describe('the sequence in the text form'),
      steps: z.array(z.record(z.string(), z.any())).optional().describe('the sequence as JSON steps (instead of text)'),
      stopOnKey: z.boolean().optional().describe('stop as soon as a key is pressed on the keyboard'),
    },
  }, tool((k, { text, steps, stopOnKey = false }) => {
    if ((text === undefined) === (steps === undefined)) throw new Error('give text or steps');
    return k.playSequence(text ?? steps, { stopOnKey });
  }));

  server.registerTool('stop_sequence', {
    description: `Stop a playing sequence (everything it holds is let go) and return the status. ${OPEN_FW}`,
  }, tool((k) => k.stopSequence()));

  server.registerTool('set_key_overlay', {
    description: 'Light chosen keys on top of the running lighting effect for a while (e.g. notifications). ' + OPEN_FW,
    inputSchema: {
      colors: z.record(z.string(), z.string().regex(/^#?[0-9a-fA-F]{6}$/)).describe('LED index -> hex colour'),
      seconds: z.number().min(0.1).max(25).optional(),
    },
  }, tool(async (k, { colors, seconds = 2 }) => {
    const caps = await k.getCaps();
    const rgb = Array.from({ length: caps.leds }, () => [0, 0, 0]);
    for (const [led, hex] of Object.entries(colors)) {
      const i = Number(led);
      if (!Number.isInteger(i) || i < 0 || i >= caps.leds) throw new Error(`LED index ${led} out of range 0..${caps.leds - 1}`);
      const v = parseInt(hex.replace('#', ''), 16);
      rgb[i] = [v >> 16, (v >> 8) & 0xff, v & 0xff];
    }
    await k.setOverlay(rgb, seconds * 1000);
    return { leds: Object.keys(colors).length, seconds };
  }));

  server.registerTool('get_key_depths', {
    description: 'Current press depth (mm) of every key, from one snapshot. ' + OPEN_FW,
  }, tool(async (k) => {
    const depth = await k.snapshotDepth();
    const names = Object.fromEntries((await k.listKeys()).map((x) => [x.slot, x.name]));
    return depth.map((mm, slot) => ({ slot, key: names[slot] ?? null, mm })).filter((d) => d.mm > 0 || d.key);
  }));

  require('./mcp-key-actions').registerKeyActionTools({ server, z, tool, OPEN_FW });   // get_key_actions, set_key_actions, get_modes, set_mode_name
  require('./mcp-kbcode').registerKbcodeTools({ server, z, conn });   // run_kb_code, get_kb_code_docs

  // optional features (plugins/<name>/) add their own tools
  for (const p of require('./plugins').loadPlugins()) p.mcp?.({ server, z, tool, OPEN_FW });
  return server;
}

const conn = createConnection({ idleMs: IDLE_MS });
const server = createMcpServer({ conn });

// Loaded by a test it only builds the tools: no stdio, no keyboard.
if (require.main === module) {
  process.on('SIGINT', async () => { await conn.drop(); process.exit(0); });
  server.connect(new StdioServerTransport()).catch((e) => {
    process.stderr.write(`max68he mcp failed: ${e.message}\n`);
    process.exit(1);
  });
}

module.exports = { server, createMcpServer, IDLE_MS };
