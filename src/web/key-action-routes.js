// Key action maps (open firmware 0xEE, caps 'keyActions'): per key, what happens at which depth
// or after how long held. GET /api/key-actions -> { info, maps } (every key that has a map),
// GET /api/key-actions?key=W (or ?slot=14) -> { map } (null: none), POST /api/key-actions { spec }
// -> { map } as stored, DELETE /api/key-actions { key | slot } -> { removed }. POST
// /api/key-actions/preview { spec } -> the stored form + summary, or { error }; it never touches
// the keyboard. The JSON form, validation and caps check live in the driver (key-actions.js, custom.js).
const { parseSpec, preview } = require('../key-actions');

function keyActionRoutes({ keyboard, httpError }) {
  // { key } or { slot } from a query (strings) or a body
  function refOf(q) {
    const key = q?.key, slot = q?.slot;
    if ((key === undefined) === (slot === undefined)) throw httpError(400, 'give key (like "W") or slot');
    if (key !== undefined) {
      if (typeof key !== 'string' || !key.trim() || key.length > 40) throw httpError(400, 'key is a key name like "W"');
      return { key };
    }
    const n = typeof slot === 'string' && /^\d+$/.test(slot) ? Number(slot) : slot;
    if (!Number.isInteger(n) || n < 0 || n > 127) throw httpError(400, 'slot is 0..127');
    return { slot: n };
  }

  return {
    'GET /api/key-actions': async (q = {}) => {
      if (q.key !== undefined || q.slot !== undefined) {
        const ref = refOf(q);
        return { map: await (await keyboard()).getKeyActions(ref) };
      }
      const k = await keyboard();
      return { info: await k.keyActionsInfo(), maps: await k.getKeyActions() };
    },
    'POST /api/key-actions': async (body) => {
      parseSpec(body);                                   // a mistake in the map never opens the keyboard
      return { map: await (await keyboard()).setKeyActions(body) };
    },
    'DELETE /api/key-actions': async (body) => {
      const ref = refOf(body);
      return (await keyboard()).removeKeyActions(ref);
    },
    'POST /api/key-actions/preview': async (body) => {
      try { return preview(body); } catch (e) {
        if (e.status === 400) return { error: e.message };
        throw e;
      }
    },
  };
}

module.exports = { keyActionRoutes };
