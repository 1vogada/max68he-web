// kbcode: the `kb` object a script sees. sandboxApi runs INSIDE the sandbox realm (its source is
// passed as text, so it uses nothing from outside: no requires, no closures), builds `kb` from
// plain data (META: layout, groups, firmware), and only records what the script asks for as plain
// operations with their line numbers. The host reads them back as one JSON string
// (__kbcode.result()) and checks everything there (kbcode-core.js). Nothing here touches a device.
// Environment-neutral: the same text can run in node:vm (kbcode.js) or a browser worker later.

function sandboxApi(META) {
  'use strict';
  const G = globalThis;
  const ErrorC = Error, freeze = Object.freeze, keysOf = Object.keys, isArray = Array.isArray, stringify = JSON.stringify;
  const ops = [];
  const pending = [];                 // rule builders still waiting for .do(...)
  const MODE_REFS = new WeakMap();    // ModeRef -> name
  const HANDLES = new WeakMap();      // key group -> [{ slot, name }]
  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const FRAME = new RegExp(`(?:^|[\\s(])${esc(META.file)}:(\\d+):(\\d+)`);

  // where the script called us: the first stack frame in the script's own file
  function where(stack) {
    let s = stack;
    if (s === undefined) {
      const limit = ErrorC.stackTraceLimit;
      ErrorC.stackTraceLimit = 50;
      s = new ErrorC().stack;
      ErrorC.stackTraceLimit = limit;
    }
    const lines = String(s ?? '').split('\n');
    for (const l of lines) {
      const m = FRAME.exec(l);
      if (m) return { line: Number(m[1]), col: Number(m[2]) };
    }
    return { line: 0, col: 0 };
  }
  const rec = (op, data) => { ops.push({ op, ...data, at: where() }); };
  const problem = (message) => rec('error', { message });

  // script values -> plain JSON (modes -> their name, keys -> their name), so the host never
  // sees the script's objects
  function clone(v, depth = 0) {
    if (depth > 24) return { $bad: 'nested too deep' };
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number') return Number.isFinite(v) ? v : { $bad: String(v) };
    if (v === undefined) return undefined;
    if (MODE_REFS.has(v)) return MODE_REFS.get(v);
    if (HANDLES.has(v)) { const h = HANDLES.get(v); return h.length === 1 ? h[0].name : h.map((k) => k.name); }
    if (isArray(v)) return v.map((x) => clone(x, depth + 1) ?? null);
    if (typeof v === 'object') {
      const o = {};
      for (const k of keysOf(v)) { const x = clone(v[k], depth + 1); if (x !== undefined) o[k] = x; }
      return o;
    }
    return { $bad: typeof v };
  }

  // ---- keys -----------------------------------------------------------------------------
  const KEYS = META.keys;                                   // [{ slot, name }] in layout order
  const BY_NAME = new Map();
  for (const k of KEYS) BY_NAME.set(k.name.toLowerCase(), k);
  for (const [alias, name] of META.aliases) if (!BY_NAME.has(alias)) BY_NAME.set(alias, BY_NAME.get(name.toLowerCase()));
  const BY_SLOT = new Map(KEYS.map((k) => [k.slot, k]));

  function lookup(ref) {
    if (HANDLES.has(ref)) return HANDLES.get(ref);
    if (typeof ref === 'number') {
      if (BY_SLOT.has(ref)) return [BY_SLOT.get(ref)];
      problem(`no key in slot ${ref} on the ${META.modelName}`);
      return [];
    }
    if (typeof ref === 'string' && BY_NAME.has(ref.trim().toLowerCase())) return [BY_NAME.get(ref.trim().toLowerCase())];
    problem(`no key named ${stringify(ref)} on the ${META.modelName} (see kb.layout)`);
    return [];
  }
  const keyList = (refs) => {
    const out = [];
    for (const r of refs.flat()) for (const k of lookup(r)) if (!out.includes(k)) out.push(k);
    return out;
  };
  const slotsOf = (list) => list.map((k) => k.slot);

  // a rule under construction: key.when(...).if(...).mode(...).do(...)
  function ruleBuilder(list, base) {
    const state = { at: where(), done: false };
    pending.push(state);
    const next = (extra) => { state.done = true; return ruleBuilder(list, { ...base, ...extra }); };
    const b = {
      if(cond) {
        const c = clone(cond);
        if (!c || typeof c !== 'object' || isArray(c)) { problem('if takes { held?, notHeld?, mode?, notMode? }'); return next({}); }
        const prev = base.if ?? {};
        const join = (a, x) => (a === undefined ? x : x === undefined ? a : [...[a].flat(), ...[x].flat()]);
        const merged = { ...prev, ...c };
        for (const f of ['held', 'notHeld', 'mode', 'notMode']) if (prev[f] !== undefined && c[f] !== undefined) merged[f] = join(prev[f], c[f]);
        for (const f of ['held', 'notHeld']) if (merged[f] !== undefined && !isArray(merged[f])) merged[f] = [merged[f]];
        return next({ if: merged });
      },
      mode(how) { return next({ mode: clone(how) }); },
      do(...actions) {
        state.done = true;
        if (!actions.length) problem('.do() needs an action, like kb.send("Esc") or kb.mouse.button("L")');
        for (const a of actions) {
          const d = typeof a === 'string' ? { key: a } : clone(a);
          rec('rule', { slots: slotsOf(list), rule: { ...base, do: d } });
        }
        const again = ruleBuilder(list, base);
        pending.pop();          // a chained .do() is optional
        return again;
      },
    };
    return freeze(b);
  }

  function group(list) {
    const slots = slotsOf(list);
    const each = (op, data) => { if (slots.length) rec(op, { slots, ...data }); return g; };
    const g = {
      get length() { return list.length; },
      get names() { return list.map((k) => k.name); },
      get slots() { return [...slots]; },
      get name() { return list.length === 1 ? list[0].name : undefined; },
      get slot() { return list.length === 1 ? list[0].slot : undefined; },
      [Symbol.iterator]() { return list.map((k) => group([k]))[Symbol.iterator](); },
      forEach(fn) { list.forEach((k, i) => fn(group([k]), i)); },
      map(fn) { return list.map((k, i) => fn(group([k]), i)); },
      filter(fn) { return group(list.filter((k, i) => fn(group([k]), i))); },
      some(fn) { return list.some((k, i) => fn(group([k]), i)); },
      every(fn) { return list.every((k, i) => fn(group([k]), i)); },
      at(i) { const k = list.at(i); return k ? group([k]) : undefined; },
      has(ref) { return lookup(ref).every((k) => list.includes(k)); },
      except(...refs) { const out = keyList(refs); return group(list.filter((k) => !out.includes(k))); },
      and(...refs) { return group([...list, ...keyList(refs).filter((k) => !list.includes(k))]); },
      toString() { return list.map((k) => k.name).join(', '); },
      toJSON() { return list.map((k) => k.name); },

      // switches (mm)
      actuation(mm) { return each('switch', { fields: { actuation: clone(mm) } }); },
      release(mm) { return each('switch', { fields: { release: clone(mm) } }); },
      deadZone(mm) { return each('switch', { fields: { deadZone: clone(mm) } }); },
      rapidTrigger(v = true) {
        const x = clone(v);
        if (typeof x === 'boolean') return each('switch', { fields: { rapidTrigger: x } });
        if (!x || typeof x !== 'object' || isArray(x)) { problem('rapidTrigger takes true, false or { press, release, continuous }'); return g; }
        const { press, release, continuous, ...rest } = x;
        const fields = { rapidTrigger: true, ...(press !== undefined && { rtPress: press }), ...(release !== undefined && { rtRelease: release }),
          ...(continuous !== undefined && { continuousRt: continuous }) };
        for (const k of keysOf(rest)) fields[k] = rest[k];    // unknown names: the host names them
        return each('switch', { fields, rt: true });
      },
      switches(s) { return each('switch', { fields: clone(s) ?? {} }); },

      // what the key types, per layer
      remap(value, layer) { return each('remap', { value: clone(value), layer: clone(layer) }); },
      fn(value, n = 1) { return each('remap', { value: clone(value), layer: n === 1 ? 'fn' : `fn${clone(n)}` }); },

      // per-key colour (the stored picture)
      color(c) { return each('color', { color: clone(c) }); },

      // advanced keys
      modTap(hold, tap, holdMs) { return each('advanced', { kind: 'modtap', hold: clone(hold), tap: clone(tap), holdMs: clone(holdMs) }); },
      toggle(key, opts) {
        const o = typeof key === 'object' && key !== null && !HANDLES.has(key) ? key : opts;
        const k = o === key ? undefined : key;
        return each('advanced', { kind: 'toggle', key: clone(k), repeat: clone(o?.repeat) });
      },
      snapTap(other) { const o = lookup(other); return each('advanced', { kind: 'snap', partner: o.length === 1 ? o[0].slot : null }); },
      dks(def) { return each('advanced', { kind: 'dks', def: clone(def) }); },
      plain() { return each('advanced', { kind: 'plain' }); },

      // on-board gamepad binding (null unbinds)
      bindGamepad(target) { return each('bind', { target: clone(target) }); },

      // key action maps (rules the keyboard runs on its own)
      when(trigger, value) {
        const t = clone(trigger);
        const v = clone(value);
        const base = { when: t };
        if (v !== undefined) base[['down', 'up', 'past', 'above'].includes(t) ? 'at' : 'ms'] = v;
        return ruleBuilder(list, base);
      },
      actionMap(opts) { return each('map', { opts: clone(opts) ?? {} }); },
    };
    freeze(g);
    HANDLES.set(g, list);
    return g;
  }

  const rows = freeze(META.rows.map((r) => group(r.map((s) => BY_SLOT.get(s)))));
  const named = (slots) => group(slots.map((s) => BY_SLOT.get(s)).filter(Boolean));
  const keysApi = {
    all: group(KEYS),
    rows,
    row: (n) => rows[n] ?? (problem(`row is 0..${rows.length - 1}`), group([])),
    named: (...refs) => group(keyList(refs)),
    except: (...refs) => group(KEYS.filter((k) => !keyList(refs).includes(k))),
  };
  for (const [name, slots] of Object.entries(META.groups)) keysApi[name] = named(slots);

  // ---- modes ------------------------------------------------------------------------------
  function modeRef(name, id) {
    const n = clone(name);
    rec('mode', { name: n, id: clone(id) });
    const ref = freeze({
      name: n,
      enter: () => freeze({ mode: n, action: 'enter' }),
      leave: () => freeze({ mode: n, action: 'leave' }),
      toggle: () => freeze({ mode: n, action: 'toggle' }),
      // in this mode, `key` acts as `action` (like the Blocks "in mode … key acts as" block)
      remap(key, action) {
        const d = typeof action === 'string' ? { key: action } : clone(action);
        const mk = d && typeof d === 'object' && 'mouseKeys' in d;
        rec('rule', { slots: slotsOf(keyList([key])), rule: { when: 'press', mode: mk ? 'while' : 'press', if: { mode: n }, do: d } });
        return ref;
      },
      toString: () => String(n),
    });
    MODE_REFS.set(ref, n);
    return ref;
  }

  // ---- actions for .do(...) --------------------------------------------------------------
  const opts = (o) => { const x = clone(o); return x && typeof x === 'object' && !isArray(x) ? x : x === undefined ? {} : { $bad: 'options object' }; };
  const DIRS = { up: 'up', down: 'down', left: 'left', right: 'right' };
  const mouse = freeze({
    button: (b = 'L') => freeze({ mouse: clone(b) }),
    move: (dir, o) => freeze({ mouseKeys: DIRS[dir] ?? clone(dir), ...opts(o) }),
    scroll: (dir, o) => freeze({ mouseKeys: dir === 'up' ? 'wheelUp' : dir === 'down' ? 'wheelDown' : clone(dir), ...opts(o) }),
    jump: (dx, dy) => freeze({ move: [clone(dx), clone(dy)] }),
    glide: (dx, dy, ms) => freeze({ glide: [clone(dx), clone(dy)], ms: clone(ms) }),
    wheel: (n) => freeze({ wheel: clone(n) }),
  });
  const gamepad = freeze({
    button: (b) => freeze({ gamepad: clone(b) }),
    axis: (axis, percent) => freeze({ axis: clone(axis), percent: clone(percent) }),
    axisDepth: (axis, from, to) => freeze({ axis: clone(axis), from: clone(from), to: clone(to) }),
    settings(s) { rec('gamepad', { settings: clone(s) ?? {} }); return gamepad; },
    bind(key, target) { const l = keyList([key]); if (l.length) rec('bind', { slots: slotsOf(l), target: clone(target) }); return gamepad; },
  });

  // ---- lighting ---------------------------------------------------------------------------
  const lighting = {};
  const light = (field, value) => { rec('lighting', { field, value: clone(value) }); return lighting; };
  Object.assign(lighting, {
    effect(name, o) {
      light('effect', name);
      const x = opts(o);
      for (const k of keysOf(x)) light(k, x[k]);
      return lighting;
    },
    color: (c) => light('color', c),
    speed: (n) => light('speed', n),
    brightness: (n) => light('brightness', n),
    direction: (d) => light('direction', d),
    option: (n) => light('option', n),
    rainbow: (on = true) => light('rainbow', on),
    picture: (n, o) => { rec('picture', { index: clone(n), opts: opts(o) }); return lighting; },
  });
  freeze(lighting);

  // ---- colours (helpers; strings like '#ff4400', 'rgb(…)', 'hsl(…)' and CSS names work too) ----
  const hex2 = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  function rgb(r, g, b) {
    if (![r, g, b].every((v) => typeof v === 'number' && v >= 0 && v <= 255)) { problem('rgb takes three numbers 0..255'); return '#000000'; }
    return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  }
  function hsl(h, s, l) {
    if (![h, s, l].every((v) => typeof v === 'number' && Number.isFinite(v)) || s < 0 || s > 100 || l < 0 || l > 100) {
      problem('hsl takes hue 0..360, saturation 0..100 and lightness 0..100'); return '#000000';
    }
    const S = s / 100, L = l / 100, k = (n) => (n + h / 30) % 12, a = S * Math.min(L, 1 - L);
    const f = (n) => L - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return rgb(f(0) * 255, f(8) * 255, f(4) * 255);
  }

  // ---- kb -----------------------------------------------------------------------------------
  const fw = META.firmware;
  const kb = freeze({
    model: META.model,
    layout: freeze(META.rows.map((r) => freeze(r.map((s) => BY_SLOT.get(s).name)))),
    firmware: freeze({ known: fw.known, open: fw.open, engine: fw.engine, features: freeze([...fw.features]),
      has: (f) => !fw.known || fw.features.includes(f) }),
    key: (ref) => group(lookup(ref)),
    keys: freeze(keysApi),
    profile(n) { rec('profile', { value: clone(n) }); return kb; },
    lighting,
    mode: modeRef,
    leaveAllModes: () => freeze({ leaveAllModes: true }),
    resetKeyActions() { rec('resetKeyActions', {}); return kb; },
    send: (key) => freeze({ key: clone(key) }),
    mouse,
    gamepad,
    macro(index, def) { rec('macro', { index: clone(index), def: typeof def === 'string' ? { text: def } : clone(def) }); return kb; },
    text(index, text) { rec('text', { index: clone(index), text: clone(text) }); return kb; },
    sequence(text, o) { rec('sequence', { text: clone(text), opts: opts(o) }); return kb; },
    options(o) { rec('options', { value: opts(o) }); return kb; },
    pollingRate(hz) { rec('polling', { value: clone(hz) }); return kb; },
    firmwareOptions(o) { rec('fwOptions', { value: opts(o) }); return kb; },
    textTyping(m) { rec('fwOptions', { value: { textTyping: clone(m) } }); return kb; },
    rgb,
    hsl,
  });

  const show = (v) => { try { return typeof v === 'string' ? v : stringify(clone(v)) ?? String(v); } catch { return String(v); } };
  const consoleApi = freeze({
    log: (...a) => { rec('log', { text: a.map(show).join(' ') }); },
    warn: (...a) => { rec('log', { text: a.map(show).join(' ') }); },
    error: (...a) => { rec('log', { text: a.map(show).join(' ') }); },
  });

  // no blocking waits, no wasm, no shared memory in a script
  for (const name of ['Atomics', 'SharedArrayBuffer', 'WebAssembly']) { try { delete G[name]; } catch { /* not there */ } }
  const define = (name, value) => Object.defineProperty(G, name, { value, enumerable: false, writable: false, configurable: false });
  define('kb', kb);
  define('console', consoleApi);
  define('__kbcode', freeze({
    // what the script asked for, as one JSON string
    result() {
      const open = pending.filter((s) => !s.done).map((s) => ({ op: 'error', message: '.when(...) without .do(...) does nothing', at: s.at }));
      return stringify({ ops: [...ops, ...open] });
    },
    // an uncaught throw -> { message, line, col } as JSON (runs in here, so a hostile getter stays in the sandbox)
    describe(e) {
      let message = 'the script stopped', stack = '';
      try { message = e instanceof Error ? `${e.name}: ${e.message}` : `the script threw ${show(e)}`; } catch { /* keep */ }
      try { stack = e instanceof Error ? String(e.stack) : ''; } catch { /* none */ }
      return stringify({ message: String(message).slice(0, 500), ...where(stack) });
    },
  }));
}

module.exports = { sandboxApi, API_SOURCE: sandboxApi.toString() };
