// MCP tools for key action maps (open firmware 0xEE, caps 'keyActions'): get_key_actions and
// set_key_actions. Registered by mcp.js; the JSON form is key-actions.js / web/key-actions-core.js.
const RULE_HELP = 'Each rule: { when, at?, ms?, mode?, do }. '
  + 'when: "press" (passes the press depth, light press), "down" (goes past at mm), "up" (comes back above at mm), '
  + '"hold" (still pressed ms after the press, 10..10000), "tap" (let go within ms), "release" (all the way up). '
  + 'at: 0.1..4 mm (0.01 steps) for down / up. '
  + 'mode: "while" (on only while the condition holds; default for down), "press" (on until the key is all the way up; default for press / hold), '
  + '"tap" (a 15 ms tap, or once for move / glide / wheel; default for up / tap / release), "toggle" (flips on / off, stays on after key-up), "release" (turns that output off). '
  + 'do: { key: "Shift" | "Ctrl+C" } (keyboard keys and modifiers), { gamepad: A|B|X|Y|LB|RB|Back|Start|LS|RS|Up|Down|Left|Right }, '
  + '{ axis: LX-|LX+|LY-|LY+|RX-|RX+|RY-|RY+|LT|RT, percent: 1..100 } (LY- = left stick up), '
  + '{ axis, from: mm, to: mm } (level follows the depth between from and to, 0.1 mm steps), { mouse: L|R|M }, '
  + '{ move: [dx, dy] } (-128..127 px, down = +dy), { glide: [dx, dy], ms } (+-508 px over 10..2550 ms), { wheel: n } (up = +).';

const EXAMPLES = 'Examples. Walk / run on W: { key: "W", rules: [{ when: "press", do: { axis: "LY-", percent: 40 } }, '
  + '{ when: "down", at: 2.5, do: { axis: "LY-", percent: 100 } }] }. '
  + 'Tap / hold on E: { key: "E", rules: [{ when: "tap", ms: 300, do: { gamepad: "A" } }, { when: "hold", ms: 300, do: { gamepad: "B" } }] }. '
  + 'Hold 3 s for Esc: { key: "Q", rules: [{ when: "hold", ms: 3000, do: { key: "Esc" } }] }. '
  + 'Toggle crouch on a deep press: { key: "C", rules: [{ when: "down", at: 2.5, mode: "toggle", do: { key: "LCtrl" } }] }.';

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
      + `Up to 6 rules per key. ${RULE_HELP} ${EXAMPLES} The keyboard saves it on its own. Firmware caps "keyActions". ${OPEN_FW}`,
    inputSchema: {
      key: keyArg.describe('key name like "W" or a slot number'),
      press: z.number().min(0.01).max(4).optional().describe('what counts as pressed, mm (default 0.3)'),
      gap: z.number().min(0.01).max(0.5).optional().describe('hysteresis, mm (default 0.1): a depth counts as left this far above it'),
      alsoType: z.boolean().optional().describe('the key still types its own key too (default false)'),
      rules: z.array(z.record(z.string(), z.any())).max(6).describe('the rules, in order'),
    },
  }, tool((k, { key, ...rest }) => k.setKeyActions({ ...(typeof key === 'number' ? { slot: key } : { key }), ...rest })));
}

module.exports = { registerKeyActionTools };
