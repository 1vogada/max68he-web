// MCP tools for key action maps (open firmware 0xEE, caps 'keyActions'): get_key_actions,
// set_key_actions (one key or a `maps` batch), get_modes and set_mode_name (engine 2, 'keyModes').
// Registered by mcp.js; the JSON form is key-actions.js / key-modes.js / web/key-actions-core.js.
const RULE_HELP = 'Each rule: { when, at?, ms?, mode?, do }. '
  + 'when: "press" (passes the press depth, light press), "down" (goes past at mm), "up" (comes back above at mm), '
  + '"hold" (still pressed ms after the press, 10..10000), "tap" (let go within ms), "release" (all the way up). '
  + 'at: 0.1..4 mm (0.01 steps) for down / up. '
  + 'mode: "while" (on only while the condition holds; default for down), "press" (on until the key is all the way up; default for press / hold), '
  + '"tap" (a 15 ms tap, or once for move / glide / wheel; default for up / tap / release), "toggle" (flips on / off, stays on after key-up), "release" (turns that output off). '
  + 'do: { key: "Shift" | "Ctrl+C" } (keyboard keys and modifiers), { gamepad: A|B|X|Y|LB|RB|Back|Start|LS|RS|Up|Down|Left|Right }, '
  + '{ axis: LX-|LX+|LY-|LY+|RX-|RX+|RY-|RY+|LT|RT, percent: 1..100 } (LY- = left stick up), '
  + '{ axis, from: mm, to: mm } (level follows the depth between from and to, 0.1 mm steps), { mouse: L|R|M }, '
  + '{ move: [dx, dy] } (-128..127 px, down = +dy), { glide: [dx, dy], ms } (+-508 px over 10..2550 ms), { wheel: n } (up = +). '
  + 'Newer firmware ("keyModes", key action engine 2) adds: if: { held?: ["Fn", "LCtrl"] (1..3 keys that must be held; Ctrl / Shift / Alt / Win = the left one), '
  + 'notHeld?: same (keys that must NOT be held; engine 5; held + notHeld at most 3 keys, a key not in both), '
  + 'mode?: "Mouse" | 1 | [..] (all these modes active), notMode?: same (none of them active) } (a rule fires only while its if is true; '
  + 'a key with a map types normally when none of its rules\' if is true at the press); '
  + 'do: { mode: "Mouse" | 1..3, action: "enter" | "leave" | "toggle" } (modes are user layers 1..3; mode "while" + enter = only while held), '
  + '{ leaveAllModes: true }, { mouseKeys: up|down|left|right|wheelUp|wheelDown, start?, max?, rampMs?, curve?, power?, shareSpeed?, keepMs?, speedBy?, pressFrom?, pressTo? } '
  + '(accelerating pointer / wheel while on; px/s 10..2550 (default 100 -> 1200) or notches/s 0.1..25.5 (default 2 -> 10), rampMs 0..10000 (1000), '
  + 'curve linear|easeIn|easeOut|easeInOut|sine|expo|smooth (easeIn), power: ease 0.3..8 (2), expo -20..20 not 0 (5); default mode while; takes 2 of the 6 rule slots; '
  + 'shareSpeed: true = the speed built up is shared between directions (pointer keys share one, wheel keys another) and kept keepMs '
  + '0..1000 ms (default 150, 10 ms steps; only with shareSpeed) after the last one is let go; needs key action engine 3; '
  + 'speedBy: "time" (default: speed builds over rampMs), "pressure" (speed follows how deep the key is pressed between pressFrom and pressTo; '
  + 'rampMs / keepMs / shareSpeed have no effect; no movement while shallower than pressFrom) or "both" (the depth sets the top speed, rampMs builds up to it); '
  + 'pressFrom / pressTo: mm, 0 <= from < to <= 4, 0.1 mm steps (default 0.5 -> 3.2; only with pressure / both); '
  + 'pressure / both take 3 of the 6 rule slots and need key action engine 4). '
  + 'Mode names must exist on the keyboard (set_mode_name, or modes in the batch).';

const EXAMPLES = 'Examples. Walk / run on W: { key: "W", rules: [{ when: "press", do: { axis: "LY-", percent: 40 } }, '
  + '{ when: "down", at: 2.5, do: { axis: "LY-", percent: 100 } }] }. '
  + 'Tap / hold on E: { key: "E", rules: [{ when: "tap", ms: 300, do: { gamepad: "A" } }, { when: "hold", ms: 300, do: { gamepad: "B" } }] }. '
  + 'Hold 3 s for Esc: { key: "Q", rules: [{ when: "hold", ms: 3000, do: { key: "Esc" } }] }. '
  + 'Toggle crouch on a deep press: { key: "C", rules: [{ when: "down", at: 2.5, mode: "toggle", do: { key: "LCtrl" } }] }. '
  + 'Mouse mode (batch): { modes: [{ id: 1, name: "Mouse" }], maps: [{ key: "M", rules: [{ when: "hold", ms: 3000, if: { held: ["Fn", "LCtrl"] }, do: { mode: "Mouse", action: "enter" } }] }, '
  + '{ key: "RShift", rules: [{ when: "press", if: { mode: "Mouse" }, do: { mouse: "L" } }] }, '
  + '{ key: "Up", rules: [{ when: "press", mode: "while", if: { mode: "Mouse" }, do: { mouseKeys: "up", shareSpeed: true, keepMs: 150 } }] }, '
  + '{ key: "Esc", rules: [{ when: "press", if: { mode: "Mouse" }, do: { mode: "Mouse", action: "leave" } }] }] }.';

function registerKeyActionTools({ server, z, tool, OPEN_FW }) {
  const keyArg = z.union([z.string(), z.number().int().min(0).max(127)]);
  server.registerTool('get_key_actions', {
    description: 'Per-key action maps: what a key does at which press depth and after how long it is held (gamepad, keyboard keys, mouse). '
      + 'With key: that key\'s map (null when it has none); without: every key that has a map plus the table size. '
      + `Each map comes with a plain-English summary. Firmware caps "keyActions". ${OPEN_FW}`,
    inputSchema: { key: keyArg.optional().describe('key name like "W" or a slot number; omit for all') },
  }, tool(async (k, { key }) => (key === undefined
    ? { info: await k.keyActionsInfo(), maps: await k.getKeyActions() }
    : { map: await k.getKeyActions(key) })));

  server.registerTool('set_key_actions', {
    description: 'Give a key an action map: outputs to the gamepad, keyboard keys or mouse by press depth and hold time. '
      + 'Replaces the key\'s whole map; an empty rules list removes it. A key with a map stops typing its own key unless alsoType. '
      + 'Several keys at once: maps (a list of { key, press?, gap?, alsoType?, rules }), remove (keys whose maps go) and modes '
      + '([{ id: 1..3, name }], named first); everything is checked before anything is written. '
      + `Up to 6 rules per key. ${RULE_HELP} ${EXAMPLES} The keyboard saves it on its own. Firmware caps "keyActions". ${OPEN_FW}`,
    inputSchema: {
      key: keyArg.optional().describe('key name like "W" or a slot number (one key; or use maps)'),
      press: z.number().min(0.01).max(4).optional().describe('what counts as pressed, mm (default 0.3)'),
      gap: z.number().min(0.01).max(0.5).optional().describe('hysteresis, mm (default 0.1): a depth counts as left this far above it'),
      alsoType: z.boolean().optional().describe('the key still types its own key too (default false)'),
      rules: z.array(z.record(z.string(), z.any())).max(6).optional().describe('the rules, in order'),
      maps: z.array(z.record(z.string(), z.any())).optional().describe('several key maps at once, each { key | slot, press?, gap?, alsoType?, rules }'),
      remove: z.array(keyArg).optional().describe('keys whose maps are removed (with maps)'),
      modes: z.array(z.object({ id: z.number().int().min(1).max(3), name: z.string() })).optional().describe('mode names to set first (newer firmware)'),
    },
  }, tool((k, { key, maps, remove, modes, ...rest }) => {
    const one = key === undefined ? null : { ...(typeof key === 'number' ? { slot: key } : { key }), rules: [], ...rest };
    if (maps === undefined && remove === undefined && modes === undefined) {
      if (!one) throw new Error('give key and rules, or maps');
      return k.setKeyActions(one);
    }
    return k.setKeyActionsBatch({ maps: [...(maps ?? []), ...(one ? [one] : [])], ...(remove && { remove }), ...(modes && { modes }) });
  }));

  server.registerTool('get_modes', {
    description: 'Key action modes 1..3 (they are user layers 1..3): their names and which are active now. Rules use them in if: { mode } '
      + `and do: { mode, action }. Newer open firmware (key action engine 2, "keyModes"). ${OPEN_FW}`,
  }, tool((k) => k.getModes()));

  server.registerTool('set_mode_name', {
    description: `Name a key action mode (1..3) so rules can say if: { mode: "Mouse" }. '' clears the name; 1..16 bytes UTF-8; names are unique. ${OPEN_FW}`,
    inputSchema: { id: z.number().int().min(1).max(3).describe('mode 1..3'), name: z.string().max(16).describe("the name ('' clears it)") },
  }, tool((k, { id, name }) => k.setModeName(id, name)));
}

module.exports = { registerKeyActionTools };
