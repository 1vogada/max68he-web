// Live view of the keyboard's on-board gamepad (open firmware): reads the HID
// game controller reports straight from the keyboard and prints sticks,
// triggers, buttons and D-pad, plus the depth of every bound key.
//   node scripts/gamepad-monitor.js [seconds]      (default 60, Ctrl+C to stop)
const HID = require('node-hid');
const { Keyboard } = require('../src/keyboard');

const seconds = Number(process.argv[2]) || 60;
const BUTTONS = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'Back', 'Start', 'LS', 'RS'];
const HAT = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];
const s16 = (b, i) => ((b[i] | (b[i + 1] << 8)) << 16) >> 16;
const bar = (v, w = 10) => {                         // -1..1 as a centred bar
  const p = Math.round(((v + 1) / 2) * w * 2);
  return '[' + Array.from({ length: w * 2 + 1 }, (_, i) => (i === w ? '|' : i === p ? '#' : '-')).join('') + ']';
};

(async () => {
  const info = HID.devices().find((d) => d.vendorId === 0x3151 && d.usagePage === 1 && d.usage === 5);
  if (!info) throw new Error('no game controller on the keyboard: flash the gamepad build');
  const k = await Keyboard.open();
  const g = await k.getBoardGamepad();
  if (!g.enabled) console.log('note: the on-board gamepad is switched off (web UI > Gamepad > On the keyboard)');
  console.log(`bindings: ${g.bindings.map((b) => `${b.slot}->${b.target}`).join(' ') || 'none'}`);
  const pad = new HID.HID(info.path);
  let rep = null, reports = 0;
  pad.on('data', (b) => { if (b[0] === 4) { rep = b; reports++; } });
  pad.on('error', (e) => console.error('read error:', e.message));
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const depth = await k.snapshotDepth();
    const keys = g.bindings.map((b) => `${b.target}:${depth[b.slot].toFixed(2)}`).join(' ');
    let line = `reports ${reports}  `;
    if (rep) {
      const ax = [1, 3, 5, 7].map((i) => s16(rep, i) / 32767);
      const btn = rep[11] | (rep[12] << 8);
      line += `L ${bar(ax[0])}${bar(ax[1])} R ${bar(ax[2])}${bar(ax[3])} LT ${String(rep[9]).padStart(3)} RT ${String(rep[10]).padStart(3)}`
        + ` ${BUTTONS.filter((_, i) => btn & (1 << i)).join('+')} ${HAT[rep[13]] ?? ''}`;
    } else line += '(no report yet: press a bound key)';
    process.stdout.write(`\r${line}  | ${keys}   `);
    await new Promise((r) => setTimeout(r, 50));
  }
  pad.close(); k.close(); console.log();
})().catch((e) => { console.error(e.message); process.exit(1); });
