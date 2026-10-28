// Key wizard "Blocks" view: Scratch-like blocks (Blockly, web/key-blocks-defs.js) <-> the driver's
// key action rules. Pure: works on Blockly's workspace JSON (Blockly.serialization.workspaces.save),
// so Node tests need no Blockly. compile(json, { modes }) -> { blocks (key-blocks-core blocks, each
// with `src` = the Blockly block id), warnings: { blockId: [text] }, batch(opts) }; anything the
// keyboard can't do becomes a warning on its block, never dropped. decompile(maps, modes) -> a
// workspace JSON that compiles back to the same rules (no saved workspace: rebuild from the keyboard).
(() => {
  const K = typeof module !== 'undefined' ? require('./key-blocks-core') : window.App.keyBlocksCore;

  // hat blocks: the trigger each one stands for
  const HATS = {
    kb_when_pressed: () => ({ when: 'press' }),
    kb_when_released: () => ({ when: 'release' }),
    kb_when_tapped: (f) => ({ when: 'tap', ms: Math.round(Number(f.WITHIN) * 1000) }),
    kb_when_held: (f) => ({ when: 'hold', ms: Math.round(Number(f.SECS) * 1000) }),
    kb_when_past: (f) => ({ when: 'down', at: Number(f.MM) }),
    kb_when_above: (f) => ({ when: 'up', at: Number(f.MM) }),
  };
  const OP_MODE = { press: 'press', release: 'release', tap: 'tap', toggle: 'toggle', while: 'while' };
  const MK_OP = { while: 'while', press: 'press', toggle: 'toggle' };
  // "acts as" targets of the remap block: value -> [`do`, mode]
  function remapTarget(v) {
    const [kind, x] = String(v).split(':');
    if (kind === 'mouse') return [{ mouse: x }, 'press'];
    if (kind === 'mk') return [{ mouseKeys: x }, 'while'];
    if (kind === 'gp') return [{ gamepad: x }, 'press'];
    if (kind === 'key') return [{ key: x }, 'press'];
    return [null, 'press'];
  }
  const num = (v) => Number(v);
  const modeId = (v) => Number(v);

  // an action block -> [`do`, mode] (do null: not an action)
  function action(t, f, blk = {}) {
    switch (t) {
      case 'kb_key': return [{ key: f.KEY }, OP_MODE[f.OP]];
      case 'kb_gp_button': return [{ gamepad: f.BUTTON }, OP_MODE[f.OP]];
      case 'kb_gp_stick': return [{ axis: f.AXIS, percent: num(f.PCT) }, null];
      case 'kb_gp_depth': return [{ axis: f.AXIS, from: num(f.FROM), to: num(f.TO) }, null];
      case 'kb_mouse_button': return [{ mouse: f.BUTTON }, OP_MODE[f.OP]];
      case 'kb_mouse_move': return [{ move: [num(f.X), num(f.Y)] }, 'tap'];
      case 'kb_mouse_glide': return [{ glide: [num(f.X), num(f.Y)], ms: num(f.MS) }, 'tap'];
      case 'kb_wheel': return [{ wheel: num(f.N) }, 'tap'];
      case 'kb_mouse_keys': {
        const d = { mouseKeys: f.DIR, start: num(f.START), max: num(f.MAX), rampMs: num(f.RAMP), curve: f.CURVE };
        d.power = K.hasPower(d.curve) ? (f.POWER !== undefined ? num(f.POWER) : K.mouseKeysDo(d.mouseKeys, d).power) : null;
        if (d.curve === 'expo' && f.POWER === undefined) d.power = 5;
        // checkbox: Blockly saves 'TRUE' / 'FALSE'; a block saved before the field existed shares (new-block default)
        d.shareSpeed = f.SHARE === undefined ? true : f.SHARE === true || f.SHARE === 'TRUE';
        d.keepMs = d.shareSpeed ? (f.KEEP === undefined ? K.MK_SHARE.keepMs : num(f.KEEP)) : null;
        // speed by: a block saved before the field goes by time; the depths keep their defaults
        d.speedBy = f.SPEEDBY ?? 'time';
        d.pressFrom = f.PFROM === undefined ? K.MK_PRESS.from : num(f.PFROM);
        d.pressTo = f.PTO === undefined ? K.MK_PRESS.to : num(f.PTO);
        return [d, MK_OP[f.OP] ?? 'while'];
      }
      case 'kb_mode': return f.OP === 'hold' ? [{ mode: modeId(f.MODE), action: 'enter' }, 'while'] : [{ mode: modeId(f.MODE), action: f.OP }, 'press'];
      case 'kb_leave_all': return [{ leaveAllModes: true }, 'press'];
      // the hold bar flashes TIMES times; COLOR 'default' = green (true), else '#rrggbb'
      case 'kb_flash': return [{ flash: !f.COLOR || f.COLOR === 'default' ? true : String(f.COLOR).toLowerCase(), times: num(f.TIMES ?? K.FLASH.times) }, 'press'];
      case 'kb_raw': { try { const r = JSON.parse(blk.data); return [r.do, r.mode ?? null]; } catch { return [null, null]; } }
      default: return [null, null];
    }
  }
  const ACTIONS = ['kb_key', 'kb_gp_button', 'kb_gp_stick', 'kb_gp_depth', 'kb_mouse_button', 'kb_mouse_move', 'kb_mouse_glide', 'kb_wheel', 'kb_mouse_keys', 'kb_mode', 'kb_leave_all', 'kb_flash', 'kb_raw'];
  const C_BLOCKS = ['kb_if', 'kb_while_mode'];

  // engine: the keyboard's key action engine, so blocks it can't run (e.g. shared speed before 3) warn;
  // flash: the keyboard has caps 'modeFlash' (false: flash blocks warn; undefined: not checked)
  function compile(json, { modes = [], engine, flash } = {}) {
    const warnings = {}, out = [];
    const warn = (id, msg) => { (warnings[id] ??= []).includes(msg) || warnings[id].push(msg); };
    const named = (id) => modes.some((m) => m.id === id && m.name);
    const checkMode = (blk, id) => { if (!named(id)) warn(blk.id, `Mode ${id} doesn't exist any more: make it again or pick another.`); };

    // a condition (boolean blocks) -> what the keyboard can test: held / not held keys, modes on / off
    function cond(blk, into, owner) {
      if (!blk) { warn(owner.id, 'Put a condition in this block.'); return; }
      const f = blk.fields ?? {}, sub = (n) => blk.inputs?.[n]?.block;
      switch (blk.type) {
        case 'kb_held': into.held.push(f.KEY); break;
        case 'kb_not_held': into.notHeld.push(f.KEY); break;
        case 'kb_mode_active': checkMode(blk, modeId(f.MODE)); into.modes.push(modeId(f.MODE)); break;
        case 'kb_and': cond(sub('A'), into, blk); cond(sub('B'), into, blk); break;
        case 'kb_not': {
          const x = sub('X');
          if (x?.type === 'kb_mode_active') { checkMode(x, modeId(x.fields.MODE)); into.notModes.push(modeId(x.fields.MODE)); }
          else if (x?.type === 'kb_held') into.notHeld.push(x.fields.KEY);
          else warn(blk.id, 'The keyboard can only test "not" around "mode … active" or "… held".');
          break;
        }
        case 'kb_or': warn(blk.id, 'The keyboard can\'t test "or": make two blocks, one for each side.'); break;
        case 'kb_deeper': warn(blk.id, 'The keyboard can\'t test a depth as a condition: use "when [key] pressed past … mm" instead.'); break;
        default: warn(blk.id, 'The keyboard can\'t test this as a condition.');
      }
    }

    // the statements under a hat or a C-block, with the conditions gathered so far
    function stack(blk, trig, ctx) {
      for (let b = blk; b; b = b.next?.block) {
        const f = b.fields ?? {};
        if (C_BLOCKS.includes(b.type)) {
          const c = { held: [...ctx.held], notHeld: [...ctx.notHeld], modes: [...ctx.modes], notModes: [...ctx.notModes], owner: b };
          if (b.type === 'kb_if') cond(b.inputs?.COND?.block, c, b);
          else { checkMode(b, modeId(f.MODE)); c.modes.push(modeId(f.MODE)); }
          stack(b.inputs?.DO?.block, trig, c);
          continue;
        }
        if (!ACTIONS.includes(b.type)) { warn(b.id, 'This block can\'t go here.'); continue; }
        const [d, mode] = action(b.type, f, b);
        if (!d) { warn(b.id, 'This block is incomplete.'); continue; }
        if (K.kindOf(d) === 'mode') checkMode(b, d.mode);
        if (b.type === 'kb_mouse_glide' && f.CURVE && f.CURVE !== 'sine') warn(b.id, 'A key\'s glide always uses the sine curve on the keyboard: pick "sine".');
        if (b.type === 'kb_mouse_move' && [num(f.X), num(f.Y)].some((v) => v < -128 || v > 127)) warn(b.id, 'A jump goes at most 127 px each way: use a glide for more.');
        if (b.type === 'kb_mouse_glide' && ([num(f.X), num(f.Y)].some((v) => v < -508 || v > 508) || !(num(f.MS) >= 10 && num(f.MS) <= 2550))) warn(b.id, 'A glide goes at most 508 px each way, over 10 to 2550 ms.');
        const held = [...ctx.held], notHeld = [...ctx.notHeld];
        const kb = K.newBlock({ key: trig.key, ...trig.rule, held: [...new Set(held)], notHeld: [...new Set(notHeld)], modes: [...new Set(ctx.modes)], notModes: [...new Set(ctx.notModes)], do: d });
        kb.mode = mode ?? K.driverDefaultMode(kb.when, d);
        kb.src = b.id;
        kb.hat = trig.id;
        kb.condSrc = ctx.owner?.id ?? null;
        if (held.length !== new Set(held).size || notHeld.length !== new Set(notHeld).size) warn(ctx.owner?.id ?? b.id, 'A held key is listed twice.');
        if (kb.held.length + kb.notHeld.length > K.MAX_HELD) warn(ctx.owner?.id ?? b.id, `The keyboard tests at most ${K.MAX_HELD} held / not held keys at once.`);
        if (kb.held.includes(kb.key) || kb.notHeld.includes(kb.key)) warn(ctx.owner?.id ?? b.id, `${kb.key} can't be held as a condition of its own block.`);
        if (kb.held.some((k) => kb.notHeld.includes(k))) warn(ctx.owner?.id ?? b.id, 'A key can\'t be held and not held at once.');
        if (kb.modes.some((id) => kb.notModes.includes(id))) warn(ctx.owner?.id ?? b.id, 'A mode can\'t be on and off at once.');
        if (!K.allowedModes(kb.when, d).includes(kb.mode)) warn(b.id, `This doesn't work this way with "${K.trigText(kb).replace(/ \(.*/, '')}": pick another option.`);
        out.push(kb);
      }
    }

    const tops = [...(json?.blocks?.blocks ?? [])].sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0));
    for (const top of tops) {
      const f = top.fields ?? {};
      if (HATS[top.type]) {
        if (!f.KEY || f.KEY === '__board__') { warn(top.id, 'Pick a key.'); continue; }
        stack(top.next?.block, { key: f.KEY, rule: HATS[top.type](f), id: top.id }, { held: [], notHeld: [], modes: [], notModes: [], owner: null });
      } else if (top.type === 'kb_when_mode') {
        warn(top.id, 'The keyboard can\'t react to a mode starting or ending yet: put these blocks under a key\'s "when" block with "while in mode".');
      } else if (top.type === 'kb_remap') {
        for (let b = top; b; b = b.next?.block) {
          const g = b.fields ?? {}, [d, mode] = remapTarget(g.TARGET), id = modeId(g.MODE);
          checkMode(b, id);
          if (!d || !g.KEY) { warn(b.id, 'Pick a key and what it acts as.'); continue; }
          const kb = K.newBlock({ key: g.KEY, when: 'press', modes: [id], do: K.kindOf(d) === 'mouseKeys' ? K.mouseKeysDo(d.mouseKeys) : d });
          kb.mode = mode;
          kb.src = b.id;
          kb.hat = b.id;
          out.push(kb);
        }
      } else if (ACTIONS.includes(top.type) || C_BLOCKS.includes(top.type)) {
        warn(top.id, 'Put this under a "when" block, or it does nothing.');
      }
    }

    // limits across blocks: rule slots per key, condition table, value ranges
    for (const [key, n] of K.slotUse(out)) {
      if (n > K.MAX_RULES) for (const b of out.filter((x) => x.key === key)) warn(b.src, `${key} would need ${n} rule slots; a key has ${K.MAX_RULES} (mouse keys take 2, 3 with speed by pressure).`);
    }
    for (const p of K.check(out, modes, { engine, flash })) {
      if (/rule slots|can't be both|listed twice|held keys|held and not held|on and off|doesn't exist|doesn't go with/.test(p.msg)) continue;   // said above, in block words
      const b = out.find((x) => x.id === p.id);
      if (b) warn(b.src, p.msg); else for (const x of out.filter((y) => y.condSrc)) warn(x.condSrc, p.msg);
    }
    return {
      blocks: out, warnings, ok: Object.keys(warnings).length === 0,
      batch: (opts = {}) => K.toBatch(out, { modes, ...opts }),
    };
  }

  // ---- rules -> blocks ---------------------------------------------------------------------

  let seq = 0;
  const id = () => `kb${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const chain = (list) => { for (let i = 0; i < list.length - 1; i++) list[i].next = { block: list[i + 1] }; return list[0]; };
  const REMAP_MODE = { mouse: 'press', key: 'press', gamepad: 'press' };

  function actionBlock(b) {
    const d = b.do, kind = K.kindOf(d), mk = (type, fields) => ({ type, id: id(), fields });
    const raw = () => ({ ...mk('kb_raw', { TEXT: K.doText(b, []) }), data: JSON.stringify(K.ruleOf({ ...b, held: [], notHeld: [], modes: [], notModes: [] }, [])) });
    const ops = ['press', 'release', 'tap', 'toggle'];
    switch (kind) {
      case 'key': return ops.includes(b.mode) ? mk('kb_key', { OP: b.mode, KEY: d.key }) : raw();
      case 'gamepad': return ops.includes(b.mode) ? mk('kb_gp_button', { OP: b.mode, BUTTON: d.gamepad }) : raw();
      case 'mouse': return ops.includes(b.mode) && ['L', 'R', 'M'].includes(d.mouse) ? mk('kb_mouse_button', { OP: b.mode, BUTTON: d.mouse }) : raw();
      case 'axis': return b.mode === K.driverDefaultMode(b.when, d) ? mk('kb_gp_stick', { AXIS: d.axis, PCT: d.percent }) : raw();
      case 'axisDepth': return b.mode === K.driverDefaultMode(b.when, d) ? mk('kb_gp_depth', { AXIS: d.axis, FROM: d.from, TO: d.to }) : raw();
      case 'move': return b.mode === 'tap' ? mk('kb_mouse_move', { X: d.move[0], Y: d.move[1] }) : raw();
      case 'glide': return b.mode === 'tap' ? mk('kb_mouse_glide', { X: d.glide[0], Y: d.glide[1], MS: d.ms, CURVE: 'sine' }) : raw();
      case 'wheel': return b.mode === 'tap' ? mk('kb_wheel', { N: d.wheel }) : raw();
      case 'mouseKeys': return mk('kb_mouse_keys', { OP: b.mode, DIR: d.mouseKeys, START: d.start, MAX: d.max, RAMP: d.rampMs, CURVE: d.curve, POWER: d.power ?? 2,
        SHARE: d.shareSpeed ? 'TRUE' : 'FALSE', KEEP: d.keepMs ?? K.MK_SHARE.keepMs,
        SPEEDBY: d.speedBy ?? 'time', PFROM: d.pressFrom ?? K.MK_PRESS.from, PTO: d.pressTo ?? K.MK_PRESS.to });
      case 'mode':
        if (b.mode === 'while' && d.action === 'enter') return mk('kb_mode', { OP: 'hold', MODE: String(d.mode) });
        return b.mode === 'press' ? mk('kb_mode', { OP: d.action, MODE: String(d.mode) }) : raw();
      case 'leaveAllModes': return b.mode === 'press' ? mk('kb_leave_all', {}) : raw();
      case 'flash': {
        const c = K.flashRgb(d.flash);
        return mk('kb_flash', { TIMES: d.times ?? K.FLASH.times, COLOR: c ? K.hexOf(c) : 'default' });
      }
      default: return raw();
    }
  }
  function condBlock(c) {
    const atoms = [...c.held.map((k) => ({ type: 'kb_held', id: id(), fields: { KEY: k } })),
      ...c.notHeld.map((k) => ({ type: 'kb_not_held', id: id(), fields: { KEY: k } })),
      ...c.modes.map((m) => ({ type: 'kb_mode_active', id: id(), fields: { MODE: String(m) } })),
      ...c.notModes.map((m) => ({ type: 'kb_not', id: id(), inputs: { X: { block: { type: 'kb_mode_active', id: id(), fields: { MODE: String(m) } } } } }))];
    return atoms.reduce((acc, a) => (acc ? { type: 'kb_and', id: id(), inputs: { A: { block: acc }, B: { block: a } } } : a), null);
  }
  function remapOf(b) {
    if (b.when !== 'press' || b.held.length || b.notHeld.length || b.notModes.length || b.modes.length !== 1) return null;
    const d = b.do, kind = K.kindOf(d);
    let target = null;
    if (kind === 'mouse' && ['L', 'R', 'M'].includes(d.mouse) && b.mode === REMAP_MODE.mouse) target = `mouse:${d.mouse}`;
    if (kind === 'gamepad' && b.mode === REMAP_MODE.gamepad) target = `gp:${d.gamepad}`;
    if (kind === 'key' && b.mode === REMAP_MODE.key && !d.key.includes('+')) target = `key:${d.key}`;
    if (kind === 'mouseKeys' && b.mode === 'while' && JSON.stringify(K.mouseKeysDo(d.mouseKeys)) === JSON.stringify({ ...K.mouseKeysDo(d.mouseKeys), ...d })) target = `mk:${d.mouseKeys}`;
    return target && { type: 'kb_remap', id: id(), fields: { MODE: String(b.modes[0]), KEY: b.key, TARGET: target } };
  }

  function decompile(maps, modes = []) {
    const { blocks } = K.fromMaps(maps, modes), tops = [];
    let y = 20, remaps = [];
    const place = (blk, h) => { blk.x = 20; blk.y = y; y += h; tops.push(blk); };
    const flushRemaps = () => { if (remaps.length) place(chain(remaps), 30 + remaps.length * 48); remaps = []; };
    const hats = new Map();
    for (const b of blocks) {
      const r = remapOf(b);
      if (r) { remaps.push(r); continue; }
      flushRemaps();
      const hk = JSON.stringify([b.key, b.when, b.ms ?? null, b.at ?? null]);
      if (!hats.has(hk)) {
        const type = { press: 'kb_when_pressed', release: 'kb_when_released', tap: 'kb_when_tapped', hold: 'kb_when_held', down: 'kb_when_past', up: 'kb_when_above' }[b.when];
        const fields = { KEY: b.key, ...(b.when === 'hold' && { SECS: b.ms / 1000 }), ...(b.when === 'tap' && { WITHIN: b.ms / 1000 }), ...(b.at !== undefined && (b.when === 'down' || b.when === 'up') && { MM: b.at }) };
        const hat = { type, id: id(), fields, groups: new Map() };
        hats.set(hk, hat);
        place(hat, 0);
      }
      const hat = hats.get(hk), ck = JSON.stringify([b.held, b.notHeld, b.modes, b.notModes]);
      if (!hat.groups.has(ck)) hat.groups.set(ck, { c: b, acts: [] });
      hat.groups.get(ck).acts.push(actionBlock(b));
    }
    flushRemaps();
    // build the hats' stacks now that every rule is in its group, and space the rows
    y = 20;
    for (const t of tops) {
      t.y = y;
      if (t.groups) {
        const parts = [];
        let rows = 1;
        for (const { c, acts } of t.groups.values()) {
          const cb = condBlock(c);
          if (cb) { parts.push({ type: 'kb_if', id: id(), inputs: { COND: { block: cb }, DO: { block: chain(acts) } } }); rows += acts.length + 2; } else { parts.push(...acts); rows += acts.length; }
        }
        delete t.groups;
        if (parts.length) t.next = { block: chain(parts) };
        y += 40 + rows * 46;
      } else {
        let n = 0;
        for (let b = t; b; b = b.next?.block) n++;
        y += 30 + n * 48;
      }
    }
    return { blocks: { languageVersion: 0, blocks: tops } };
  }

  const api = { HATS, ACTIONS, C_BLOCKS, compile, decompile, remapTarget };
  if (typeof module !== 'undefined') module.exports = api;
  else { window.App = window.App || {}; window.App.keyBlocksCompile = api; }
})();
