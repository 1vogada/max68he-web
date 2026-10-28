// Firmware builder page logic without the DOM (web/fw-builder.js; Node tests): feature
// dependencies when a box is ticked or cleared, and how full a flash / RAM bar is.
(function (root) {
  // state = { id: bool }; turning one on turns on what it requires, turning one off turns off
  // what requires it (all the way down). Returns { state, changed: [ids besides id] }.
  function toggle(features, state, id, on) {
    const byId = new Map(features.map((f) => [f.id, f]));
    const next = { ...state }, changed = [];
    const set = (fid, v) => {
      if (next[fid] === v) return;
      next[fid] = v;
      if (fid !== id) changed.push(fid);
      if (v) for (const r of byId.get(fid)?.requires ?? []) set(r, true);
      else for (const f of features) if (f.requires?.includes(fid)) set(f.id, false);
    };
    next[id] = !on;   // so set() always runs for the box itself
    set(id, on);
    return { state: next, changed };
  }

  const defaults = (features) => Object.fromEntries(features.map((f) => [f.id, Boolean(f.default)]));

  // { pct, level: 'ok' | 'warn' (above 95 %) | 'over' (does not fit) }
  function level(used, limit) {
    const pct = limit ? (used / limit) * 100 : 0;
    return { pct, level: pct > 100 ? 'over' : pct > 95 ? 'warn' : 'ok' };
  }

  const api = { toggle, defaults, level };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FwBuilderCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
