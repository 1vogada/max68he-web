// Many keys at once on one layer (remap presets, and undoing them in one step):
// POST /api/remap/batch { layer, keys: [{ slot, value }] }. Every slot and value is checked
// before the first write, so a bad entry changes nothing; the writes then go one by one,
// paced by the transport like single remaps.
const MAX_KEYS = 128;

// layer as POST /api/remap takes it: base, fn, fn2..fn4 (Fn layers), l1..l3 (user layers)
function layerOf(layer) {
  if (layer === undefined || layer === 'base' || layer === 'fn') return { kind: layer ?? 'base' };
  const fn = /^fn([234])$/.exec(layer);
  if (fn) return { kind: 'fnN', n: Number(fn[1]) };
  const user = /^l([123])$/.exec(layer);
  if (user) return { kind: 'user', n: Number(user[1]) };
  return null;
}

function remapRoutes({ keyboard, state, httpError, intIn, keyValue, slotName }) {
  async function writeKey(k, L, slot, v) {
    if (L.kind === 'fnN') return k.setFnLayerKey(L.n, slot, v);
    if (L.kind === 'user') return k.setLayerKey(L.n, slot, v);
    return k.setKey(slot, v, { layer: L.kind });
  }

  return {
    'POST /api/remap/batch': async (body) => {
      const L = layerOf(body.layer);
      if (!L) throw httpError(400, 'layer is base, fn, fn2..fn4 or l1..l3');
      if (!Array.isArray(body.keys) || !body.keys.length || body.keys.length > MAX_KEYS) throw httpError(400, `keys is a list of 1..${MAX_KEYS}`);
      const seen = new Set();
      const keys = body.keys.map((e, i) => {
        const slot = intIn(e?.slot, 0, 127, `keys[${i}].slot`);
        if (seen.has(slot)) throw httpError(400, `slot ${slot} is in the list twice`);
        seen.add(slot);
        let v;
        try { v = keyValue(e.value); } catch (err) { throw httpError(400, `keys[${i}]: ${err.message}`); }
        return { slot, v };
      });
      const k = await keyboard();
      if (L.kind === 'fnN' && !(await k.getCaps()).features.includes('fnLayers')) throw httpError(400, 'Fn layers 2-4 need a newer open firmware');
      if (L.kind === 'user' && !k.info.custom) throw httpError(400, 'layers need the open firmware');
      const written = [];
      for (const { slot, v } of keys) written.push({ slot, name: slotName(await writeKey(k, L, slot, v)) });
      return { layer: body.layer ?? 'base', written, state: await state() };
    },
  };
}

module.exports = { remapRoutes, layerOf };
