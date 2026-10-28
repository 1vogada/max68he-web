// Features page logic without the DOM (web/features.js; Node tests): rows by group, what a
// switch costs or frees, the projected flash / RAM of a choice, and the warnings when a feature
// switched off is in use. Dependencies (on pulls in what it requires, off drops what requires
// it) are fw-builder-core's toggle().
(function (root) {
  const FB = typeof module !== 'undefined' && module.exports ? require('./fw-builder-core') : root.FwBuilderCore;

  const GROUPS = [['lighting', 'Lighting'], ['input', 'Keys and input'], ['layers', 'Layers'], ['host', 'App connection'],
    ['system', 'System'], ['games', 'Games'], ['other', 'Other']];
  // where the first features go when an older features.json has no "group"
  const FALLBACK_GROUP = { games: 'games', fx: 'lighting', pfx: 'lighting', droplet: 'lighting', sequence: 'input', text: 'input',
    watchdog: 'system' };
  const groupOf = (f) => f.group ?? FALLBACK_GROUP[f.id] ?? 'other';

  // [{ id, label, features: [...] }] in GROUPS order, empty groups left out
  function grouped(features) {
    return GROUPS.map(([id, label]) => ({ id, label, features: features.filter((f) => groupOf(f) === id) }))
      .filter((g) => g.features.length);
  }

  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

  // what flipping the switch does: on now -> "−3.4 KB flash, −1.2 KB RAM" (freed), off now -> "+…"
  function costText(f, on) {
    if (!f.cost) return 'size unknown';
    const s = on ? '−' : '+', part = (v, what) => (v ? `${s}${kb(v)} ${what}` : `no ${what}`);
    return `${part(f.cost.flash, 'flash')}, ${part(f.cost.ram, 'RAM')}`;
  }

  // every feature that requires id, all the way down
  function dependents(features, id) {
    const out = new Set(), walk = (x) => { for (const f of features) if (f.requires?.includes(x) && !out.has(f.id)) { out.add(f.id); walk(f.id); } };
    walk(id);
    return out;
  }

  // the switched-off features whose cost counts: a cost is measured with what requires the feature
  // off too, so a feature off because something it requires is off is already in that one's cost
  function counted(features, state) {
    const off = features.filter((f) => state[f.id] === false);
    const inside = new Set(off.flatMap((f) => [...dependents(features, f.id)]));
    return off.filter((f) => !inside.has(f.id));
  }

  // { known: true, flash, ram, limits, freed } = sizes.full − Σ cost of what's off (an estimate), or
  // { known: false, why, missing: [ids] } when the list has no sizes or an off feature no cost
  function projection(manifest, state) {
    const sizes = manifest.sizes, feats = manifest.features ?? [];
    if (!sizes?.full || !sizes?.limits) return { known: false, why: 'no sizes in this feature list', missing: [] };
    const off = counted(feats, state), missing = off.filter((f) => !f.cost).map((f) => f.id);
    if (missing.length) return { known: false, why: 'size unknown for some features switched off', missing };
    const freed = off.reduce((a, f) => ({ flash: a.flash + f.cost.flash, ram: a.ram + f.cost.ram }), { flash: 0, ram: 0 });
    return { known: true, flash: sizes.full.flash - freed.flash, ram: sizes.full.ram - freed.ram, limits: sizes.limits, freed };
  }

  // the two bars: [{ name, used, limit, pct, level, text }]
  function bars(flash, ram, limits) {
    return [['Flash', flash, limits.flash], ['RAM', ram, limits.ram]].map(([name, used, limit]) => {
      const { pct, level } = FB.level(used, limit);
      return { name, used, limit, pct, level, text: `${kb(used)} of ${kb(limit)} · ${pct.toFixed(1)} %` };
    });
  }
  // the keyboard's memory report (state.memory, CAPS word 3) as bars; null when it has none
  function currentBars(mem) {
    if (!mem?.flashSize || !mem?.ramSize) return null;
    return bars(mem.flashUsed, mem.ramStatic + mem.ramReserved, { flash: mem.flashSize, ram: mem.ramSize });
  }

  // ---- in use ------------------------------------------------------------------------
  // use = what the keyboard has set (web/features.js reads it from the existing APIs; a field
  // left out = not known, no warning): { textKeys, sequencePlaying, glideActions, lightingMode,
  // keyActionMaps, macros, gamepadBindings, dksKeys, dksMultiLevel, advancedKeys, modes,
  // mouseActions, userLayerKeys, fnLayerKeys, calibratedKeys, pressureMouse }
  const n = (v, one, many = `${one}s`) => `${v} ${v === 1 ? one : many}`;
  const inRange = (m, a, b) => Number.isInteger(m) && m >= a && m <= b;
  const RULES = {
    text: (u) => u.textKeys > 0 && `${n(u.textKeys, 'saved text')}: text keys type nothing in this build.`,
    text_typing: (u) => u.textKeys > 0 && `${n(u.textKeys, 'saved text')}: the keyboard can't type them in this build.`,
    sequence: (u) => (u.sequencePlaying ? 'A sequence is playing right now: it stops.' : null),
    glide: (u) => u.glideActions > 0 && `Mouse glides in ${n(u.glideActions, 'key action')} stop.`,
    fx: (u) => inRange(u.lightingMode, 0x43, 0x4b) && 'The lighting effect in use is a key-reactive one: it shows a plain colour.',
    pfx: (u) => inRange(u.lightingMode, 0x4c, 0x59) && 'The lighting effect in use is a pressure effect: it shows a plain colour.',
    droplet: (u) => u.lightingMode === 0x42 && 'The lighting effect in use is Droplet: it shows a plain colour.',
    keyact: (u) => u.keyActionMaps > 0 && `${n(u.keyActionMaps, 'key')} with key action maps (Key wizard / Blocks) go back to plain keys.`,
    modes: (u) => u.modes > 0 && `${n(u.modes, 'named mode')} in use: mode switching stops.`,
    mousekeys: (u) => u.mouseActions > 0 && `Mouse movement in ${n(u.mouseActions, 'key action')} stops working.`,
    mk_pressure: (u) => u.pressureMouse > 0 && `Depth-controlled mouse speed in ${n(u.pressureMouse, 'key action')}: one speed only.`,
    macros: (u) => u.macros > 0 && `${n(u.macros, 'macro')} stored: macro keys do nothing.`,
    gamepad: (u) => u.gamepadBindings > 0 && `${n(u.gamepadBindings, 'key')} bound to the on-board gamepad: no gamepad.`,
    dks: (u) => u.dksKeys > 0 && `${n(u.dksKeys, 'dynamic keystroke key')}: they type like plain keys.`,
    dks_levels: (u) => u.dksMultiLevel > 0 && `${n(u.dksMultiLevel, 'key')} with more than two DKS levels use two.`,
    advkeys: (u) => u.advancedKeys > 0 && `${n(u.advancedKeys, 'key')} with snap tap, mod-tap or toggle act as plain keys.`,
    user_layers: (u) => u.userLayerKeys > 0 && `${n(u.userLayerKeys, 'key')} set on layers 1-3: layer keys do nothing.`,
    fn_layers: (u) => u.fnLayerKeys > 0 && `${n(u.fnLayerKeys, 'key')} set on Fn layers 2-4: only Fn layer 1 works.`,
    calib: (u) => u.calibratedKeys > 0 && `${n(u.calibratedKeys, 'calibrated key')}: every key uses the default travel range.`,
    watchdog: () => 'A hung keyboard no longer restarts by itself. Off only for debugging with a probe attached.',
  };

  // [{ id, name, text }] for every feature switched off whose rule fires; the data stays stored
  function warnings(features, state, use = {}) {
    const out = [];
    for (const f of features) {
      if (state[f.id] !== false) continue;
      const text = RULES[f.id]?.(use);
      if (text) out.push({ id: f.id, name: f.name, text });
    }
    return out;
  }

  // "Also off: Mouse keys, Pressure mouse." after a switch flipped (toggle().changed)
  function dependencyNote(features, changed, on) {
    if (!changed.length) return '';
    const name = (id) => features.find((f) => f.id === id)?.name ?? id;
    return `${on ? 'Also on (needed)' : 'Also off (needs it)'}: ${changed.map(name).join(', ')}.`;
  }

  // "Needs Key actions." / "Needed by Modes, Mouse keys." under a row
  function relations(features, f) {
    const name = (id) => features.find((x) => x.id === id)?.name ?? id;
    const by = features.filter((x) => x.requires?.includes(f.id)).map((x) => x.name);
    return [f.requires?.length ? `Needs ${f.requires.map(name).join(', ')}.` : '', by.length ? `Needed by ${by.join(', ')}.` : '']
      .filter(Boolean).join(' ');
  }

  // the use fields from GET /api/key-actions ({ maps: [{ key, rules: [{ do, if }] }], modes: [{ id, name }] })
  function useFromKeyActions(r = {}) {
    const maps = (r.maps ?? []).map((m) => JSON.stringify(m));
    return { keyActionMaps: maps.length, glideActions: maps.filter((m) => /"glide"/.test(m)).length,
      mouseActions: maps.filter((m) => /"(mouse|mouseKeys|move|wheel)"/.test(m)).length,
      pressureMouse: maps.filter((m) => /"speedBy":"(pressure|both)"/.test(m)).length,
      modes: (r.modes ?? []).filter((m) => m?.name).length };
  }
  // the use fields from POST /api/advanced/list's keys ([{ kind: 'dks' | 'snap' | 'modtap' | 'toggle', levels }])
  function useFromAdvanced(keys = []) {
    const dks = keys.filter((k) => k.kind === 'dks');
    return { dksKeys: dks.length, dksMultiLevel: dks.filter((k) => (k.levels?.length ?? 0) > 2).length,
      advancedKeys: keys.filter((k) => ['snap', 'modtap', 'toggle'].includes(k.kind)).length };
  }

  // ---- sorting and filtering (the list's toolbar) ----------------------------------------------
  // the `use` fields each rule reads: a feature is "in use" when its rule fires, "not in use" when
  // those fields are known and it doesn't, unknown (null) otherwise
  const USE_FIELDS = { text: ['textKeys'], text_typing: ['textKeys'], sequence: ['sequencePlaying'], glide: ['glideActions'],
    fx: ['lightingMode'], pfx: ['lightingMode'], droplet: ['lightingMode'], keyact: ['keyActionMaps'], modes: ['modes'],
    mousekeys: ['mouseActions'], mk_pressure: ['pressureMouse'], macros: ['macros'], gamepad: ['gamepadBindings'],
    dks: ['dksKeys'], dks_levels: ['dksMultiLevel'], advkeys: ['advancedKeys'], user_layers: ['userLayerKeys'],
    fn_layers: ['fnLayerKeys'], calib: ['calibratedKeys'] };
  function inUse(f, use = {}) {
    if (f.id === 'watchdog') return true;                 // always doing its job
    const fields = USE_FIELDS[f.id];
    if (!fields || !RULES[f.id] || fields.some((k) => use[k] === undefined)) return null;
    return Boolean(RULES[f.id](use));
  }

  const SORTS = [['use', 'In use first'], ['flash', 'Biggest flash saving'], ['ram', 'Biggest RAM saving'],
    ['name', 'Name A–Z'], ['group', 'Group']];

  // sections to show: [{ id, label, features }]; opts { sort, filter, offOnly }
  function view(features, { sort = 'use', filter = '', offOnly = false } = {}, use = {}, state = {}) {
    const q = filter.trim().toLowerCase();
    const list = features.filter((f) => (!offOnly || state[f.id] === false)
      && (!q || `${f.name} ${f.description ?? ''} ${f.id}`.toLowerCase().includes(q)));
    const byName = (a, b) => a.name.localeCompare(b.name);
    const one = (fs) => (fs.length ? [{ id: 'all', label: '', features: fs }] : []);
    if (sort === 'group') return grouped(list);
    if (sort === 'name') return one([...list].sort(byName));
    if (sort === 'flash' || sort === 'ram') {
      const cost = (f) => f.cost?.[sort] ?? -1;
      return one([...list].sort((a, b) => cost(b) - cost(a) || byName(a, b)));
    }
    const part = (v) => list.filter((f) => inUse(f, use) === v).sort(byName);
    return [{ id: 'used', label: 'In use', features: part(true) }, { id: 'unused', label: 'Not in use', features: part(false) },
      { id: 'unknown', label: 'Use not known (?)', features: part(null) }].filter((s) => s.features.length);
  }

  const api = { GROUPS, groupOf, grouped, kb, costText, dependents, counted, projection, bars, currentBars, warnings,
    dependencyNote, relations, toggle: FB.toggle, defaults: FB.defaults, RULES, inUse, SORTS, view, useFromKeyActions, useFromAdvanced };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FeaturesCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
