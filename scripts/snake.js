// One white LED with a fading tail runs along the LED chain (index 0 -> last) on a
// dark board. Needs the open firmware (LED overlay). Usage: node scripts/snake.js [seconds]
// The overlay treats 0,0,0 as "show the effect through", so the background is 0,0,1.
const { Keyboard } = require('..');

(async () => {
  const kb = await Keyboard.open();
  const T = (Number(process.argv[2]) || 5) * 1000, N = 68, TAIL = 6, DARK = [0, 0, 1];
  console.log('starting in 1 s, watch the keyboard...');
  await new Promise((r) => setTimeout(r, 1000));
  const t0 = Date.now();
  while (Date.now() - t0 < T) {
    const head = (Date.now() - t0) / T * (N + TAIL);
    const leds = Array.from({ length: N }, (_, i) => {
      const d = head - i;
      if (d < 0 || d >= TAIL) return DARK;
      const v = Math.max(1, Math.round(255 * (1 - d / TAIL)));
      return [v, v, v];
    });
    await kb.setOverlay(leds, 500);
    await new Promise((r) => setTimeout(r, 40));
  }
  await kb.clearOverlay();
  kb.close();
  console.log('done');
})().catch((e) => { console.error(e.message); process.exit(1); });
