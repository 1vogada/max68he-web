// Pressure demo: the deepest-pressed key sets the whole board's colour,
// blue (released) -> green -> yellow -> red (bottomed out).
// Usage: node scripts/pressure-demo.js [seconds]   (default 30)
const { Keyboard } = require('..');

const SECONDS = Number(process.argv[2] || 30);
const FULL_MM = 3.5;
const FPS = 40;

// 0..1 depth -> RGB along blue, cyan, green, yellow, red
function heat(t) {
  const stops = [[0, 30, 255], [0, 200, 200], [0, 255, 0], [255, 220, 0], [255, 0, 0]];
  const x = Math.min(Math.max(t, 0), 1) * (stops.length - 1);
  const i = Math.min(Math.floor(x), stops.length - 2);
  const f = x - i;
  return stops[i].map((v, c) => v + (stops[i + 1][c] - v) * f);
}

(async () => {
  const kb = await Keyboard.open();
  const depth = new Map(); // slot -> mm; a key held still sends nothing, so keep the last value
  let reports = 0;
  let stopTravel = null;
  const stop = async () => {
    clearInterval(timer);
    if (stopTravel) await stopTravel().catch(() => {});
    await kb.stopLiveColor().catch((e) => console.error('restore failed:', e.message));
    kb.close();
  };
  let timer;
  try {
    console.log('entering live colour mode (one flash write)...');
    await kb.startLiveColor();
    // A quick sweep so it's obvious the channel works before any key is pressed.
    for (let i = 0; i <= 60; i++) {
      kb.setLiveColor(...heat(i / 60));
      await new Promise((r) => setTimeout(r, 25));
    }
    stopTravel = await kb.startTravel(({ slot, mm }) => {
      reports++;
      if (mm > 0) depth.set(slot, mm); else depth.delete(slot);
    });
    console.log(`press keys for ${SECONDS}s: deeper = hotter colour`);
    timer = setInterval(() => {
      const deepest = Math.max(0, ...depth.values());
      kb.setLiveColor(...heat(deepest / FULL_MM));
    }, 1000 / FPS);
    // Ends early on Ctrl+C, still restoring the lighting below.
    await new Promise((r) => { setTimeout(r, SECONDS * 1000); process.once('SIGINT', r); });
    console.log(`travel reports received: ${reports}`);
  } finally {
    console.log('restoring previous lighting (one flash write)...');
    await stop();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });

