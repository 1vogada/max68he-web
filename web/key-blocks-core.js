// Key wizard "Blocks" view (web/key-blocks.js): behaviours built from generic blocks, WHEN a key
// does something IF conditions hold DO an action. Pure helpers shared by the page and the tests:
// blocks <-> the driver's batch JSON (POST /api/key-actions/batch { maps, remove }), slot use per
// key (6 rules a key, mouse keys take 2, 3 with speed by pressure), the condition table (15 entries), the "for several keys"
// copy helper and the plain sentences.
//
// Block: { id, key, when, at?, ms?, mode, held: [key names], notHeld: [key names], modes: [mode ids], notModes: [ids], do }
// `do` is the driver's rule `do`, except a mode change names its mode by id: { mode: 1, action }.
// Modes: [{ id: 1..3, name, active? }] (name '' = not created).
(() => {
  const KA = typeof module !== 'undefined' ? require('./key-actions-core') : window.App.keyActions;
  const GL = typeof module !== 'undefined' ? require('./glide-core') : window.App.glide;

  const MAX_RULES = 6, MAX_HELD = 3, MAX_CONDITIONS = 15, MAX_MODES = 3, NOT_HELD_ENGINE = 5;   // MAX_HELD: held + not held
  const TRIGGERS = ['press', 'release', 'tap', 'hold', 'down', 'up'];
  const DIRS = ['up', 'down', 'left', 'right', 'wheelUp', 'wheelDown'];
  const CURVES = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'sine', 'expo', 'smooth'];
  const CURVE_TEXT = { linear: 'linear', easeIn: 'ease in', easeOut: 'ease out', easeInOut: 'ease in and out', sine: 'sine', expo: 'exponential', smooth: 'smooth' };
  const MK_DEFAULTS = { pointer: { start: 100, max: 1200 }, wheel: { start: 2, max: 10 }, rampMs: 1000, curve: 'easeIn' };
  // shareSpeed: one speed for all pointer directions (one for the wheel) across rules that share, so
  // turning keeps the speed; keepMs: how long the speed is kept after letting go (only with sharing).
  // The JSON's default is off (old rules unchanged); new blocks start with it on. Needs engine 3.
  const MK_SHARE = { keepMs: 150, maxKeepMs: 1000, engine: 3 };
  // speedBy: what sets the speed. 'time' (the ramp, as before), 'pressure' (how deep the key is,
  // pressFrom -> pressTo mm: slowest at from, nothing above it, fastest at to) or 'both' (the depth sets
  // the ceiling, the ramp builds up to it). Not 'time': a DEPTH rule follows, 3 slots. Needs engine 4.
  const SPEED_BY = ['time', 'pressure', 'both'];
  const MK_PRESS = { from: 0.5, to: 3.2, maxMm: 4, engine: 4 };
  const MODE_ACTIONS = ['enter', 'leave', 'toggle'];
  // kinds of action a block can do, in the order the page offers them
  const MOD_TEXT = { LCtrl: 'Left Ctrl', RCtrl: 'Right Ctrl', LShift: 'Left Shift', RShift: 'Right Shift', LAlt: 'Left Alt', RAlt: 'Right Alt', LWin: 'Left Win', RWin: 'Right Win' };
  const ALIAS = { Ctrl: 'LCtrl', Shift: 'LShift', Alt: 'LAlt', Win: 'LWin' };

  const clone = (x) => JSON.parse(JSON.stringify(x));
  const isWheel = (dir) => dir === 'wheelUp' || dir === 'wheelDown';
  const hasPower = (curve) => ['easeIn', 'easeOut', 'easeInOut', 'expo'].includes(curve);

  function kindOf(d) {
    if (!d || typeof d !== 'object') return null;
    if ('mouseKeys' in d) return 'mouseKeys';
    if ('leaveAllModes' in d) return 'leaveAllModes';
    if ('mode' in d && 'action' in d) return 'mode';
    return KA.outputKind(d);
  }

  function mouseKeysDo(dir, from) {
    const unit = isWheel(dir) ? 'wheel' : 'pointer';
    const keepSpeed = from && isWheel(from.mouseKeys) === isWheel(dir);
    return { mouseKeys: dir, start: keepSpeed ? from.start : MK_DEFAULTS[unit].start, max: keepSpeed ? from.max : MK_DEFAULTS[unit].max,
      rampMs: from?.rampMs ?? MK_DEFAULTS.rampMs, curve: from?.curve ?? MK_DEFAULTS.curve, power: from?.power ?? GL.DEFAULT_POWER[from?.curve ?? MK_DEFAULTS.curve] ?? null,
      shareSpeed: from ? Boolean(from.shareSpeed) : true, keepMs: from ? (from.shareSpeed ? from.keepMs ?? MK_SHARE.keepMs : null) : MK_SHARE.keepMs,
      speedBy: from?.speedBy ?? 'time', pressFrom: from?.pressFrom ?? MK_PRESS.from, pressTo: from?.pressTo ?? MK_PRESS.to };
  }
  const byPressure = (d) => Boolean(d) && d.speedBy !== undefined && d.speedBy !== 'time';
  const mm1 = (v) => Math.round(Number(v) * 10) / 10;   // depths go to the keyboard in 0.1 mm

  // ---- modes ("how long") ------------------------------------------------------------

  // what the driver assumes when a rule names no mode
  function driverDefaultMode(when, d) {
    const kind = kindOf(d);
    if (kind === 'mouseKeys') return 'while';
    if (KA.ONCE.includes(kind)) return 'tap';
    return KA.DEFAULT_MODE[when] ?? 'press';
  }
  function allowedModes(when, d) {
    const kind = kindOf(d), noWhile = ['up', 'tap', 'release'].includes(when);
    if (kind === 'mouseKeys') return ['while', 'press', 'toggle'].filter((m) => !(m === 'while' && noWhile));
    if (kind === 'mode') return ['press', 'tap', ...(d.action === 'enter' && !noWhile ? ['while'] : [])];
    if (kind === 'leaveAllModes') return ['press', 'tap'];
    return KA.allowedModes(when, kind);
  }
  const fitMode = (b) => (allowedModes(b.when, b.do).includes(b.mode) ? b.mode
    : allowedModes(b.when, b.do).includes(driverDefaultMode(b.when, b.do)) ? driverDefaultMode(b.when, b.do) : allowedModes(b.when, b.do)[0]);

  // ---- blocks -------------------------------------------------------------------------

  let nextId = 1;
  function newBlock(over = {}) {
    const b = { id: nextId++, key: null, when: 'press', held: [], notHeld: [], modes: [], notModes: [], do: null, ...clone(over) };
    if (b.when === 'hold' && b.ms === undefined) b.ms = 1000;
    if (b.when === 'tap' && b.ms === undefined) b.ms = 200;
    if (b.when === 'down' && b.at === undefined) b.at = 2;
    if (b.when === 'up' && b.at === undefined) b.at = 1;
    b.mode = b.do ? fitMode(b) : b.mode ?? 'press';
    return b;
  }
  const modeById = (modes, id) => modes.find((m) => m.id === id);
  const modeRef = (modes, id) => modeById(modes, id)?.name || id;   // the name when it has one, else the id
  function modeIdOf(modes, ref) {
    if (typeof ref === 'number') return ref;
    const hit = modes.find((m) => m.name && m.name.toLowerCase() === String(ref).toLowerCase());
    if (!hit) throw new Error(`no mode named "${ref}"`);
    return hit.id;
  }
  const list = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
  const one = (arr) => (arr.length === 1 ? arr[0] : arr);

  // a block -> the driver's rule JSON (fields in the order the driver documents them)
  function ruleOf(b, modes) {
    const r = { when: b.when };
    if (b.when === 'down' || b.when === 'up') r.at = b.at;
    if (b.when === 'hold' || b.when === 'tap') r.ms = b.ms;
    const kind = kindOf(b.do);
    if (kind === 'mouseKeys' || b.mode !== driverDefaultMode(b.when, b.do)) r.mode = b.mode;
    const cond = {};
    if (b.held.length) cond.held = [...b.held];
    if (b.notHeld?.length) cond.notHeld = [...b.notHeld];
    if (b.modes.length) cond.mode = one(b.modes.map((id) => modeRef(modes, id)));
    if (b.notModes.length) cond.notMode = one(b.notModes.map((id) => modeRef(modes, id)));
    if (Object.keys(cond).length) r.if = cond;
    r.do = doOut(b.do, modes);
    return r;
  }
  function doOut(d, modes) {
    switch (kindOf(d)) {
      case 'mode': return { mode: modeRef(modes, d.mode), action: d.action };
      case 'mouseKeys': {
        const unit = isWheel(d.mouseKeys) ? 'wheel' : 'pointer', o = { mouseKeys: d.mouseKeys };
        if (d.start !== MK_DEFAULTS[unit].start) o.start = d.start;
        if (d.max !== MK_DEFAULTS[unit].max) o.max = d.max;
        if (d.rampMs !== MK_DEFAULTS.rampMs) o.rampMs = d.rampMs;
        if (d.curve !== MK_DEFAULTS.curve) o.curve = d.curve;
        if (hasPower(d.curve) && d.power !== null && d.power !== undefined && d.power !== GL.DEFAULT_POWER[d.curve]) o.power = d.power;
        if (d.shareSpeed) {                // keepMs always with sharing, as the driver's own example writes it
          o.shareSpeed = true;
          o.keepMs = d.keepMs ?? MK_SHARE.keepMs;
        }
        if (byPressure(d)) {              // the depths always with pressure, so the rule reads on its own
          o.speedBy = d.speedBy;
          o.pressFrom = mm1(d.pressFrom ?? MK_PRESS.from);
          o.pressTo = mm1(d.pressTo ?? MK_PRESS.to);
        }
        return o;
      }
      default: return clone(d);
    }
  }

  // blocks -> { maps, remove }: one map per key, keys in the order their first block comes;
  // keyOpts keeps a stored key's press / gap / alsoType; stored = keys that have a map now
  function toBatch(blocks, { modes = [], keyOpts = {}, stored = [] } = {}) {
    const byKey = new Map();
    for (const b of blocks) {
      if (!b.key || !b.do) continue;
      if (!byKey.has(b.key)) byKey.set(b.key, []);
      byKey.get(b.key).push(ruleOf(b, modes));
    }
    const maps = [...byKey].map(([key, rules]) => {
      const o = keyOpts[key] ?? {}, m = { key };
      if (o.press !== undefined && o.press !== KA.DEFAULTS.pressMm) m.press = o.press;
      if (o.gap !== undefined && o.gap !== KA.DEFAULTS.gapMm) m.gap = o.gap;
      if (o.alsoType) m.alsoType = true;
      m.rules = rules;
      return m;
    });
    const remove = stored.filter((k) => !byKey.has(k));
    return remove.length ? { maps, remove } : { maps };
  }

  // stored maps (GET /api/key-actions, or a batch body) -> blocks + the keys' options
  function fromMaps(maps, modes = []) {
    const blocks = [], keyOpts = {};
    for (const m of maps ?? []) {
      const key = m.key ?? `slot ${m.slot}`;
      keyOpts[key] = { press: m.press, gap: m.gap, alsoType: Boolean(m.alsoType) };
      for (const r of m.rules ?? []) {
        const c = r.if ?? {};
        let d = clone(r.do);
        const kind = kindOf(d);
        if (kind === 'mode') d = { mode: modeIdOf(modes, d.mode), action: d.action };
        if (kind === 'mouseKeys') {
          const base = mouseKeysDo(d.mouseKeys);
          d = { ...base, ...d };
          // a stored rule without shareSpeed has it off (the JSON's default), not the new-block default
          d.shareSpeed = r.do.shareSpeed === true;
          d.keepMs = d.shareSpeed ? r.do.keepMs ?? MK_SHARE.keepMs : null;
          d.speedBy = r.do.speedBy ?? 'time';
          d.pressFrom = r.do.pressFrom ?? MK_PRESS.from;
          d.pressTo = r.do.pressTo ?? MK_PRESS.to;
          if (!hasPower(d.curve)) d.power = null; else if (d.power === undefined || d.power === null) d.power = GL.DEFAULT_POWER[d.curve];
        }
        const b = newBlock({ key, when: r.when, ...(r.at !== undefined && { at: r.at }), ...(r.ms !== undefined && { ms: r.ms }),
          held: list(c.held).map((k) => ALIAS[k] ?? k), notHeld: list(c.notHeld).map((k) => ALIAS[k] ?? k), modes: list(c.mode).map((x) => modeIdOf(modes, x)), notModes: list(c.notMode).map((x) => modeIdOf(modes, x)), do: d });
        b.mode = r.mode ?? driverDefaultMode(r.when, d);
        blocks.push(b);
      }
    }
    return { blocks, keyOpts };
  }

  // ---- limits -------------------------------------------------------------------------

  const ruleSlots = (b) => (kindOf(b.do) === 'mouseKeys' ? (byPressure(b.do) ? 3 : 2) : 1);
  // key -> rule slots its blocks take (mouse keys take 2: the move and its ARG rule; 3 with speed by
  // pressure / both: + the DEPTH rule)
  function slotUse(blocks) {
    const use = new Map();
    for (const b of blocks) if (b.key && b.do) use.set(b.key, (use.get(b.key) ?? 0) + ruleSlots(b));
    return use;
  }
  const condKey = (b) => (b.held.length || b.notHeld.length || b.modes.length || b.notModes.length
    ? JSON.stringify([[...b.held].sort(), [...b.notHeld].sort(), [...b.modes].sort(), [...b.notModes].sort()]) : null);
  const conditionCount = (blocks) => new Set(blocks.filter((b) => b.key && b.do).map(condKey).filter(Boolean)).size;

  // what would stop a save: [{ id (block) | null, msg }]
  // engine: the keyboard's key action engine (undefined: not known, nothing checked against it)
  function check(blocks, modes = [], { engine } = {}) {
    const out = [], use = slotUse(blocks);
    const bad = (b, msg) => out.push({ id: b ? b.id : null, msg });
    for (const b of blocks) {
      if (!b.key) bad(b, 'Pick the key this block listens to.');
      if (!b.do) bad(b, 'Pick what it does.');
      if (b.held.length + b.notHeld.length > MAX_HELD) bad(b, `At most ${MAX_HELD} held / not held keys.`);
      if (b.key && [...b.held, ...b.notHeld].includes(b.key)) bad(b, `${b.key} can't be both the key and a held key.`);
      if (new Set(b.held).size !== b.held.length || new Set(b.notHeld).size !== b.notHeld.length) bad(b, 'A held key is listed twice.');
      if (b.held.some((k) => b.notHeld.includes(k))) bad(b, 'A key can\'t be held and not held at once.');
      if (b.notHeld.length && engine !== undefined && engine < NOT_HELD_ENGINE) bad(b, '"Not held" needs a newer open firmware on the keyboard (key action engine 5): flash the latest build.');
      if (b.modes.some((id) => b.notModes.includes(id))) bad(b, 'A mode can\'t be both on and off.');
      for (const id of [...b.modes, ...b.notModes, ...(kindOf(b.do) === 'mode' ? [b.do.mode] : [])]) if (!(id >= 1 && id <= MAX_MODES)) bad(b, `Mode ${id} doesn't exist.`);
      if ((b.when === 'hold' || b.when === 'tap') && !(b.ms >= 10 && b.ms <= 10000)) bad(b, 'The time must be 0.01 to 10 s.');
      if ((b.when === 'down' || b.when === 'up') && !(b.at >= 0.1 && b.at <= 4)) bad(b, 'The depth must be 0.10 to 4.00 mm.');
      if (b.do && !allowedModes(b.when, b.do).includes(b.mode)) bad(b, 'That "how long" doesn\'t go with this trigger and action.');
      if (kindOf(b.do) === 'mouseKeys') {
        const w = isWheel(b.do.mouseKeys), lo = w ? 0.1 : 10, hi = w ? 25.5 : 2550;
        if (!(b.do.start >= lo && b.do.max <= hi && b.do.start <= b.do.max)) bad(b, `Speeds must be ${lo} to ${hi} ${w ? 'notches/s' : 'px/s'}, start no faster than max.`);
        if (!(b.do.rampMs >= 0 && b.do.rampMs <= 10000)) bad(b, 'The ramp must be 0 to 10 s.');
        if (b.do.shareSpeed) {
          const k = b.do.keepMs;
          if (!(Number.isInteger(k) && k >= 0 && k <= MK_SHARE.maxKeepMs && k % 10 === 0)) bad(b, `Keep the speed 0 to ${MK_SHARE.maxKeepMs} ms after letting go, in 10 ms steps.`);
          if (engine !== undefined && engine < MK_SHARE.engine) bad(b, 'Sharing the speed between directions needs a newer open firmware on the keyboard (key action engine 3): flash the latest build, or untick "share speed".');
        }
        if (b.do.speedBy !== undefined && !SPEED_BY.includes(b.do.speedBy)) bad(b, `Speed goes by ${SPEED_BY.join(', ')}.`);
        else if (byPressure(b.do)) {
          const f = mm1(b.do.pressFrom), t = mm1(b.do.pressTo);
          if (!(f >= 0 && t <= MK_PRESS.maxMm && f < t)) bad(b, `The depths must be 0.0 to ${MK_PRESS.maxMm.toFixed(1)} mm, "from" less than "to" (0.1 mm steps).`);
          if (engine !== undefined && engine < MK_PRESS.engine) bad(b, 'Speed by how deep you press needs a newer open firmware on the keyboard (key action engine 4): flash the latest build, or set "speed by" to time.');
        }
      }
    }
    for (const [key, n] of use) {
      if (n > MAX_RULES) {
        const first = blocks.find((b) => b.key === key && b.do);
        bad(first, `${key} uses ${n} of its ${MAX_RULES} rule slots (mouse keys take 2, 3 with speed by pressure). Move some blocks to another key or remove them.`);
      }
    }
    if (conditionCount(blocks) > MAX_CONDITIONS) bad(null, `The blocks use ${conditionCount(blocks)} different IF conditions; the keyboard keeps ${MAX_CONDITIONS}. Make blocks share conditions.`);
    return out;
  }

  // ---- sentences ------------------------------------------------------------------------

  const keyName = (k) => MOD_TEXT[k] ?? k;
  const modeName = (modes, id) => { const m = modeById(modes, id); return m?.name ? m.name : `layer ${id}`; };
  const andList = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

  function condText(b, modes) {
    const parts = [];
    if (b.held.length) parts.push(`While ${b.held.map(keyName).join(' + ')} ${b.held.length > 1 ? 'are' : 'is'} held`);
    if (b.modes.length) parts.push(`${parts.length ? 'in' : 'In'} mode ${andList(b.modes.map((id) => modeName(modes, id)))}`);
    if (b.notModes.length) parts.push(`${parts.length ? 'outside' : 'Outside'} mode ${andList(b.notModes.map((id) => modeName(modes, id)))}`);
    if (b.notHeld.length) parts.push(`${parts.length ? 'while' : 'While'} ${b.notHeld.map(keyName).join(' + ')} ${b.notHeld.length > 1 ? 'are' : 'is'} not held`);
    return parts.join(', ');
  }
  function trigText(b) {
    switch (b.when) {
      case 'press': return 'press';
      case 'release': return 'let go';
      case 'tap': return `quick tap (let go within ${KA.time(b.ms)})`;
      case 'hold': return `hold ${(b.ms / 1000).toFixed(2)} s`;
      case 'down': return `past ${KA.mm(b.at)}`;
      case 'up': return `back above ${KA.mm(b.at)}`;
      default: return String(b.when);
    }
  }
  const HOW = { press: 'until released', while: 'while held', toggle: 'on / off each time', tap: 'a quick tap', release: 'lets go of it' };
  function doText(b, modes) {
    const d = b.do, kind = kindOf(d);
    if (!d) return 'nothing yet';
    if (kind === 'mode') return `${d.action} mode ${modeName(modes, d.mode)}${b.mode === 'while' ? ' (only while held)' : ''}`;
    if (kind === 'leaveAllModes') return 'leave every mode';
    if (kind === 'mouseKeys') {
      const w = isWheel(d.mouseKeys), u = w ? 'notches/s' : 'px/s';
      const what = w ? `scroll ${d.mouseKeys === 'wheelUp' ? 'up' : 'down'}` : `move the mouse ${d.mouseKeys}`;
      const curveName = CURVE_TEXT[d.curve] ?? d.curve, depths = `${mm1(d.pressFrom ?? MK_PRESS.from).toFixed(2)} -> ${KA.mm(mm1(d.pressTo ?? MK_PRESS.to))}`;
      let curve = d.rampMs ? ` over ${KA.time(d.rampMs)} (${curveName})` : ' at once';
      if (d.speedBy === 'pressure') curve = `, speed by how deep you press, ${depths} (${curveName})`;
      if (d.speedBy === 'both') curve = `, up to a speed set by how deep you press (${depths})${d.rampMs ? `, building over ${KA.time(d.rampMs)}` : ''} (${curveName})`;
      // with pressure alone the ramp, sharing and keeping do nothing, so the sentence leaves them out
      const share = d.shareSpeed && d.speedBy !== 'pressure' ? `, speed shared between directions, kept ${d.keepMs ?? MK_SHARE.keepMs} ms after release` : '';
      return `${what}, ${d.start} -> ${d.max} ${u}${curve}${share}${b.mode === 'toggle' ? ', on / off each time' : b.mode === 'press' ? ' until released' : ''}`;
    }
    if (kind === 'mouse') return `mouse button ${({ L: 'left', R: 'right', M: 'middle' })[d.mouse] ?? d.mouse} (${HOW[b.mode] ?? b.mode})`;
    if (KA.ONCE.includes(kind)) return KA.outputText(d);
    return `${KA.outputText(d)} (${HOW[b.mode] ?? b.mode})`;
  }
  function sentence(b, modes = []) {
    const c = condText(b, modes);
    return `${c ? `${c}, ` : ''}${c ? trigText(b) : trigText(b).replace(/^./, (x) => x.toUpperCase())}${b.key ? ` ${b.key}` : ''}: ${doText(b, modes)}`;
  }

  // the whole set in plain words: one group per mode (header + its blocks), then the rest
  function summary(blocks, modes = []) {
    const ready = blocks.filter((b) => b.key && b.do), groups = [];
    for (const m of modes.filter((x) => x.name || ready.some((b) => b.modes.includes(x.id) || (kindOf(b.do) === 'mode' && b.do.mode === x.id)))) {
      const inMode = ready.filter((b) => b.modes.includes(m.id));
      const by = (act) => ready.filter((b) => kindOf(b.do) === 'mode' && b.do.mode === m.id && (b.do.action === act || b.do.action === 'toggle'))
        .map((b) => `${[...b.held, b.key].map(keyName).join(' + ')} (${trigText(b)})`);
      const on = by('enter'), off = [...by('leave'), ...ready.filter((b) => kindOf(b.do) === 'leaveAllModes').map((b) => `${b.key} (${trigText(b)})`)];
      const head = `Mode ${modeName(modes, m.id)} (layer ${m.id}): ${on.length ? `on with ${andList(on)}` : 'nothing turns it on yet'}; `
        + `${off.length ? `off with ${andList(off)}` : 'off only with Fn + Esc held 2 s or a reset'}; ${inMode.length} block${inMode.length === 1 ? '' : 's'} work only in it.`;
      groups.push({ mode: m.id, head, lines: inMode.map((b) => sentence(b, modes)) });
    }
    const rest = ready.filter((b) => !b.modes.length);
    if (rest.length) groups.push({ mode: null, head: 'Outside the modes (or in any mode)', lines: rest.map((b) => sentence(b, modes)) });
    return groups;
  }

  // mouse keys speed over time, for the page's small plot: [[t ms, speed]...]; with speed by pressure
  // or both, over the key's depth instead: [[mm, speed]...] from 0 to 4 mm (no movement above "from";
  // for both this is the ceiling the ramp builds up to)
  function speedCurve(d, n = 24) {
    if (byPressure(d)) {
      const f = GL.glideCurve(d.curve, hasPower(d.curve) ? d.power : undefined);
      const lo = mm1(d.pressFrom ?? MK_PRESS.from), hi = Math.max(mm1(d.pressTo ?? MK_PRESS.to), lo + 0.1);
      return Array.from({ length: n + 1 }, (_, i) => {
        const x = (i / n) * MK_PRESS.maxMm;
        return [x, x < lo ? 0 : d.start + (d.max - d.start) * f(Math.min((x - lo) / (hi - lo), 1))];
      });
    }
    const f = d.rampMs ? GL.glideCurve(d.curve, hasPower(d.curve) ? d.power : undefined) : () => 1;
    const span = Math.max(d.rampMs, 1);
    return Array.from({ length: n + 1 }, (_, i) => {
      const t = (i / n) * span * 1.15;
      return [t, d.start + (d.max - d.start) * f(Math.min(t / span, 1))];
    });
  }

  const api = {
    MAX_RULES, MAX_HELD, MAX_CONDITIONS, MAX_MODES, TRIGGERS, DIRS, CURVES, CURVE_TEXT, MK_DEFAULTS, MK_SHARE, SPEED_BY, MK_PRESS, MODE_ACTIONS, MOD_TEXT,
    kindOf, mouseKeysDo, byPressure, driverDefaultMode, allowedModes, fitMode, isWheel, hasPower,
    newBlock, toBatch, fromMaps, ruleOf, modeIdOf,
    ruleSlots, slotUse, conditionCount, check,
    keyName, modeName, condText, trigText, doText, sentence, summary, speedCurve,
  };
  if (typeof module !== 'undefined') module.exports = api;
  else { window.App = window.App || {}; window.App.keyBlocksCore = api; }
})();
