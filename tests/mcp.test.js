// The MCP server module loads and registers its tools without stdio or the keyboard.
const test = require('node:test');
const assert = require('node:assert');
const { Keyboard } = require('../src/keyboard');

test('mcp.js loads, registers every tool and opens nothing', () => {
  let opened = 0;
  const realOpen = Keyboard.open;
  Keyboard.open = async () => { opened++; throw new Error('no keyboard in tests'); };
  try {
    const { server } = require('../src/mcp');
    const tools = server._registeredTools;
    for (const name of ['get_info', 'set_switch', 'set_board_effect', 'get_capabilities', 'import_profile']) {
      assert.ok(tools[name], `${name} is registered`);
    }
    assert.match(tools.set_board_effect.description, /open X68MAX firmware/);
    assert.strictEqual(opened, 0);
  } finally {
    Keyboard.open = realOpen;
  }
});

test('MCP switch tools take actuation and release up to 3.4 mm, like the web API', () => {
  const { server } = require('../src/mcp');
  const { MAX_ACTUATION_MM } = require('../src/limits');
  assert.strictEqual(MAX_ACTUATION_MM, 3.4);
  for (const name of ['set_switch', 'set_all_switches']) {
    const schema = server._registeredTools[name].inputSchema;
    assert.ok(schema.safeParse({ key: 'Q', actuation: 3.4, release: 3.4 }).success, name);
    assert.ok(!schema.safeParse({ key: 'Q', actuation: 3.5 }).success, name);
    assert.ok(!schema.safeParse({ key: 'Q', release: 4 }).success, name);
  }
  assert.ok(!server._registeredTools.set_advanced_key.inputSchema.safeParse({ key: 'Q', type: 'dks', secondPointMm: 3.5 }).success);
});

test('MCP set_firmware_options takes the round 5 options with their limits', () => {
  const { server } = require('../src/mcp');
  const shape = server._registeredTools.set_firmware_options.inputSchema.shape ?? server._registeredTools.set_firmware_options.inputSchema;
  for (const k of ['compatMode', 'releaseDebounceMs', 'dimMinutes', 'dimPercent']) assert.ok(shape[k], `${k} in the schema`);
  assert.ok(shape.releaseDebounceMs.safeParse(10).success && !shape.releaseDebounceMs.safeParse(11).success, 'release debounce 0..10');
  assert.ok(!shape.dimPercent.safeParse(101).success && shape.compatMode.safeParse(true).success);
});
