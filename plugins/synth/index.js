// Synth plugin: the keyboard as a pressure-sensitive instrument. The page plays the sound
// (Web Audio) from the live travel stream; this side lights the keys being played with the
// open firmware's per-key overlay, which clears itself if the page stops sending.
// Remove this folder to ship the driver without it.

// MAX68HE (board 2755): LED chain index -> matrix site (build/2755/board_keymap.h led_site),
// and a stock slot's site is (slot / 6) * 8 + slot % 6 (keyscan.h ks_site_of_slot).
const LED_SITE_2755 = [1, 9, 17, 25, 33, 41, 49, 57, 65, 73, 81, 89, 97, 105, 113, 114, 106, 98, 90, 82, 74, 66, 58,
  50, 42, 34, 26, 18, 10, 2, 3, 11, 19, 27, 35, 43, 51, 59, 67, 75, 83, 91, 107, 115, 116, 108, 100, 92, 84, 76, 68,
  60, 52, 44, 36, 28, 20, 4, 5, 13, 21, 53, 77, 85, 93, 101, 109, 117];
const ledOfSlot = (slot) => LED_SITE_2755.indexOf(Math.floor(slot / 6) * 8 + (slot % 6));

// Latest frame wins: frames posted while one is on the wire replace each other.
let pending = null;
let sending = false;
function pump(k) {
  if (sending) return;
  sending = true;
  (async () => {
    try {
      while (pending) {
        const f = pending;
        pending = null;
        await (f.clear ? k.clearOverlay() : k.setOverlay(f.rgb, f.ttlMs));
      }
    } catch {
      // a dropped frame is fine; the next one goes out
    } finally {
      sending = false;
    }
  })();
}

function routes({ keyboard, httpError, intIn }) {
  const glowing = async () => {
    const k = await keyboard();
    if (k.info.model !== 'max68he' || !k.info.custom) throw httpError(400, 'lighting the played keys needs the MAX68HE with the open firmware');
    return k;
  };
  return {
    // { keys: [[slot, r, g, b], ...], ttlMs }: those keys glow, every other key shows the lighting effect
    'POST /api/synth/glow': async (body) => {
      const k = await glowing();
      if (!Array.isArray(body.keys) || body.keys.length > 128) throw httpError(400, 'keys is up to 128 [slot, r, g, b]');
      const rgb = Array.from({ length: LED_SITE_2755.length }, () => [0, 0, 0]);
      for (const e of body.keys) {
        if (!Array.isArray(e) || e.length !== 4 || !e.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) throw httpError(400, 'each key is [slot, r, g, b] (0..255)');
        const led = ledOfSlot(e[0]);
        if (led >= 0) rgb[led] = e.slice(1);
      }
      pending = { rgb, ttlMs: intIn(body.ttlMs ?? 600, 100, 5000, 'ttlMs') };
      pump(k);
      return { ok: true };
    },
    'POST /api/synth/clear': async () => {
      const k = await glowing();
      pending = { clear: true };
      pump(k);
      return { ok: true };
    },
  };
}

module.exports = { name: 'Synth', routes, ledOfSlot };
