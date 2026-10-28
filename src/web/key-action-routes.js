// Key action maps (open firmware 0xEE, caps 'keyActions'): per key, what happens at which depth
// or after how long held. GET /api/key-actions -> { info, maps, modes, engine } (every key that has a
// map; modes [{ id, name, active }] on engine 2, else null), GET /api/key-actions?key=W (or ?slot=14)
// -> { map } (null: none), POST /api/key-actions { spec } -> { map } as stored, DELETE
// /api/key-actions { key | slot } -> { removed }, POST /api/key-actions/batch { maps, remove?, modes? }
// -> { maps, removed, modes? }. POST /api/key-actions/preview { spec } -> the stored form + summary, or
// { error }; it never touches the keyboard (mode and key names in `if` are not looked up). Modes
// (engine 2): GET /api/modes -> { modes }, POST /api/modes { id, name } -> { modes }. The JSON form,
// validation and caps check live in the driver (key-actions.js, key-modes.js, custom-key-actions.js).
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
      const info = await k.keyActionsInfo();
      return { info, maps: await k.getKeyActions(), modes: info.engine >= 2 ? await k.getModes() : null, engine: info.engine };
    },
    'POST /api/key-actions': async (body) => {
      parseSpec(body);                                   // a mistake in the map never opens the keyboard
      return { map: await (await keyboard()).setKeyActions(body) };
    },
    'POST /api/key-actions/batch': async (body) => {
      if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.maps)) {
        throw httpError(400, 'the batch is { maps: [...], remove?: [key...], modes?: [{ id, name }] }');
      }
      body.maps.forEach((m, i) => {
        try { parseSpec(m); } catch (e) { throw httpError(400, `maps[${i}]: ${e.message}`); }
      });
      return (await keyboard()).setKeyActionsBatch(body);
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
    'GET /api/modes': async () => ({ modes: await (await keyboard()).getModes() }),
    'POST /api/modes': async (body) => {
      const id = body?.id;
      if (!Number.isInteger(id) || id < 1 || id > 3) throw httpError(400, 'id is a mode number 1..3');
      if (typeof body.name !== 'string') throw httpError(400, "name is a string ('' clears it)");
      return { modes: await (await keyboard()).setModeName(id, body.name) };
    },
  };
}

module.exports = { keyActionRoutes };
