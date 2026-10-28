// Writes tests/fixtures/ka-mouse-mode.hex: the 0xEE packets the driver writes for the acceptance
// example (tests/fixtures/ka-mouse-mode.json: Fn + Ctrl + M held 3 s -> mouse mode) on a fake MAX68HE
// with key action engine 3, one 64-byte packet per line as hex, in write order (MODE_SET, COND_SET,
// SET). The firmware's end-to-end test replays them. Also the pressure variant
// (ka-mouse-mode-pressure.json / .hex: the arrows on speedBy 'pressure', engine 4) and Ivo's tilde mode
// (ka-tilde-mode.json / .hex: Fn + LCtrl + B toggles Tilde, Esc types ` there unless Fn is held, engine 5).
// Run: node scripts/ka-fixture.js
const fs = require('fs');
const path = require('path');
const { fakeKeyboard } = require('../tests/fixtures/ka-fake');
const { MAX68HE_KEYS } = require('../tests/fixtures/max68he-keys');

const DIR = path.join(__dirname, '..', 'tests', 'fixtures');
const WRITES = [2, 5, 7];   // SET, COND_SET, MODE_SET
const VARIANTS = { 'ka-mouse-mode': 3, 'ka-mouse-mode-pressure': 4, 'ka-tilde-mode': 5 };   // fixture name -> engine

// -> the written packets (arrays of 64 bytes), from an empty table
async function fixturePackets(name = 'ka-mouse-mode') {
  const spec = JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8'));
  const f = fakeKeyboard({ engine: VARIANTS[name], entries: 32, keys: MAX68HE_KEYS });
  await f.kb.setKeyActionsBatch(spec);
  return f.sent.filter((p) => p[0] === 0xee && WRITES.includes(p[1]));
}

const toHex = (packets) => `${packets.map((p) => p.map((b) => b.toString(16).padStart(2, '0')).join('')).join('\n')}\n`;

if (require.main === module) {
  (async () => {
    for (const name of Object.keys(VARIANTS)) {
      const packets = await fixturePackets(name);
      const file = path.join(DIR, `${name}.hex`);
      fs.writeFileSync(file, toHex(packets));
      console.log(`${packets.length} packets -> ${file}`);
    }
  })().catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { fixturePackets, toHex, VARIANTS };
