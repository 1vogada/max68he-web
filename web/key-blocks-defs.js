// Key wizard "Blocks" view: the Scratch-like blocks (Blockly, zelos renderer). Loaded with Blockly
// only when the view opens (web/key-blocks.js). Hats are triggers, C-blocks gate on conditions,
// hexagons are conditions, stacks are actions; web/key-blocks-compile.js turns them into rules.
// App.kbDefs.install(Blockly, ctx): ctx = { keys() board key names, modes(), arm(field) }.
(() => {
  const App = (window.App = window.App || {});
  const BOARD = '__board__';
  const COLOURS = {     // Scratch 3 category colours
    events: '#FFBF00', control: '#FFAB19', sensing: '#5CB1D6', operators: '#59C059',
    keys: '#4C97FF', gamepad: '#9966FF', mouse: '#CF63CF', modes: '#FF8C1A', lights: '#FF6680',
  };
  // the flash block's colours (Blockly 12 has no colour field in core): 'default' = green on the keyboard;
  // a colour from the keyboard that is not in the list is added (allowColours)
  const FLASH_COLOURS = [['green (default)', 'default'], ['red', '#ff0000'], ['orange', '#ff8000'], ['yellow', '#ffff00'], ['cyan', '#00ffff'],
    ['blue', '#0000ff'], ['magenta', '#ff00ff'], ['white', '#ffffff'], ['dim white', '#404040']];
  const extraColours = new Set();
  const colourOptions = () => [...FLASH_COLOURS, ...[...extraColours].filter((c) => !FLASH_COLOURS.some(([, v]) => v === c)).map((c) => [c, c])];
  const EXTRA_KEYS = ['Space', 'Enter', 'Tab', 'Bksp', 'Esc', 'Del', 'Ins', 'Home', 'End', 'PgUp', 'PgDn', 'Up', 'Down', 'Left', 'Right',
    ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`), 'LCtrl', 'LShift', 'LAlt', 'LWin', 'RCtrl', 'RShift', 'RAlt', 'RWin', 'PrtSc', 'Menu'];
  const FIRST = ['Fn', 'LCtrl', 'LShift', 'LAlt', 'LWin', 'RCtrl', 'RShift', 'RAlt'];
  const OPS = [['press', 'press'], ['release', 'release'], ['tap', 'tap'], ['toggle', 'toggle']];
  const AXES = [['left stick up', 'LY-'], ['left stick down', 'LY+'], ['left stick left', 'LX-'], ['left stick right', 'LX+'],
    ['right stick up', 'RY-'], ['right stick down', 'RY+'], ['right stick left', 'RX-'], ['right stick right', 'RX+'], ['left trigger', 'LT'], ['right trigger', 'RT']];
  const BUTTONS = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'Back', 'Start', 'LS', 'RS', 'Up', 'Down', 'Left', 'Right'].map((b) => [{ LS: 'left stick click', RS: 'right stick click', Up: 'D-pad up', Down: 'D-pad down', Left: 'D-pad left', Right: 'D-pad right' }[b] ?? b, b]);
  const MOUSE = [['1 (left)', 'L'], ['2 (right)', 'R'], ['3 (middle)', 'M']];
  const DIRS = [['up', 'up'], ['down', 'down'], ['left', 'left'], ['right', 'right'], ['wheel up', 'wheelUp'], ['wheel down', 'wheelDown']];
  const CURVES = [['ease in', 'easeIn'], ['linear', 'linear'], ['ease out', 'easeOut'], ['ease in and out', 'easeInOut'], ['sine', 'sine'], ['exponential', 'expo'], ['smooth', 'smooth']];

  let ctx;
  const numF = (name, value, min, max, precision = 1) => ({ type: 'field_number', name, value, min, max, precision });
  const dd = (name, options) => ({ type: 'field_dropdown', name, options });

  // board key names (Fn and modifiers first), "click a key on the board", plus any name already in use
  const extra = new Set();
  function keyOptions() {
    const board = ctx.keys();
    const names = [...new Set([...FIRST.filter((k) => board.includes(k)), ...board, ...EXTRA_KEYS, ...extra])];
    return [...names.map((k) => [k, k]), ['⌨ click a key on the board…', BOARD]];
  }
  const keyF = (name = 'KEY') => ({ type: 'field_dropdown', name, options: keyOptions });
  function modeOptions() {
    return ctx.modes().map((m) => [m.name ? m.name : `layer ${m.id} (no mode yet)`, String(m.id)]);
  }
  const modeF = () => ({ type: 'field_dropdown', name: 'MODE', options: modeOptions });
  function remapTargets() {
    return [...MOUSE.map(([l, v]) => [`mouse button ${l}`, `mouse:${v}`]), ...DIRS.map(([l, v]) => [l.startsWith('wheel') ? `scroll ${l.slice(6)}` : `mouse ${l}`, `mk:${v}`]),
      ...BUTTONS.map(([l, v]) => [`gamepad ${l}`, `gp:${v}`]), ...[...new Set([...EXTRA_KEYS, ...ctx.keys(), ...extra])].map((k) => [`key ${k}`, `key:${k}`])];
  }

  // block JSON: [type, style, message, args, kind] (kind: hat | stack | c | bool | remap)
  const DEFS = [
    ['kb_when_pressed', 'events', 'when %1 pressed', [keyF()], 'hat'],
    ['kb_when_held', 'events', 'when %1 held for %2 s', [keyF(), numF('SECS', 3, 0.01, 10, 0.01)], 'hat'],
    ['kb_when_tapped', 'events', 'when %1 tapped (let go within %2 s)', [keyF(), numF('WITHIN', 0.2, 0.01, 10, 0.01)], 'hat'],
    ['kb_when_past', 'events', 'when %1 pressed past %2 mm', [keyF(), numF('MM', 2, 0.1, 4, 0.01)], 'hat'],
    ['kb_when_above', 'events', 'when %1 comes back above %2 mm', [keyF(), numF('MM', 1, 0.1, 4, 0.01)], 'hat'],
    ['kb_when_released', 'events', 'when %1 released', [keyF()], 'hat'],
    ['kb_when_mode', 'events', 'when mode %1 %2', [modeF(), dd('EDGE', [['starts', 'start'], ['ends', 'end']])], 'hat'],
    ['kb_if', 'control', 'if %1 then %2 %3', [{ type: 'input_value', name: 'COND', check: 'Boolean' }, { type: 'input_dummy' }, { type: 'input_statement', name: 'DO' }], 'c'],
    ['kb_while_mode', 'control', 'while in mode %1 %2 %3', [modeF(), { type: 'input_dummy' }, { type: 'input_statement', name: 'DO' }], 'c'],
    ['kb_held', 'sensing', '%1 held', [keyF()], 'bool'],
    ['kb_not_held', 'sensing', '%1 not held', [keyF()], 'bool'],
    ['kb_mode_active', 'sensing', 'mode %1 active', [modeF()], 'bool'],
    ['kb_deeper', 'sensing', '%1 deeper than %2 mm', [keyF(), numF('MM', 1.5, 0.1, 4, 0.01)], 'bool'],
    ['kb_and', 'operators', '%1 and %2', [{ type: 'input_value', name: 'A', check: 'Boolean' }, { type: 'input_value', name: 'B', check: 'Boolean' }], 'bool'],
    ['kb_or', 'operators', '%1 or %2', [{ type: 'input_value', name: 'A', check: 'Boolean' }, { type: 'input_value', name: 'B', check: 'Boolean' }], 'bool'],
    ['kb_not', 'operators', 'not %1', [{ type: 'input_value', name: 'X', check: 'Boolean' }], 'bool'],
    ['kb_key', 'keys', '%1 key %2', [dd('OP', OPS), keyF()], 'stack'],
    ['kb_gp_button', 'gamepad', '%1 gamepad %2', [dd('OP', OPS), dd('BUTTON', BUTTONS)], 'stack'],
    ['kb_gp_stick', 'gamepad', 'push %1 to %2 %', [dd('AXIS', AXES), numF('PCT', 100, 1, 100)], 'stack'],
    ['kb_gp_depth', 'gamepad', 'push %1 with the depth from %2 to %3 mm', [dd('AXIS', AXES), numF('FROM', 0.5, 0, 3.9, 0.1), numF('TO', 3.5, 0.1, 4, 0.1)], 'stack'],
    ['kb_mouse_button', 'mouse', '%1 mouse button %2', [dd('OP', OPS), dd('BUTTON', MOUSE)], 'stack'],
    ['kb_mouse_move', 'mouse', 'jump mouse x %1 y %2 px', [numF('X', 10, -127, 127), numF('Y', 0, -127, 127)], 'stack'],
    ['kb_mouse_glide', 'mouse', 'glide mouse x %1 y %2 px in %3 ms %4', [numF('X', 100, -508, 508), numF('Y', 0, -508, 508), numF('MS', 300, 10, 2550, 10), dd('CURVE', [['sine', 'sine'], ...CURVES.filter(([, v]) => v !== 'sine')])], 'stack'],
    ['kb_mouse_keys', 'mouse', 'move mouse %1 %2', [dd('DIR', DIRS), dd('OP', [['while held', 'while'], ['until let go', 'press'], ['on / off', 'toggle']])], 'stack',
      'speed %1 to %2 /s over %3 ms %4 strength %5 %6', [numF('START', 100, 0.1, 2550, 0.1), numF('MAX', 1200, 0.1, 2550, 0.1), numF('RAMP', 1000, 0, 10000, 10), dd('CURVE', CURVES), numF('POWER', 2, -20, 20, 0.1), { type: 'field_image', name: 'PLOT', src: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E', width: 56, height: 24, alt: 'speed curve' }],
      'share speed between directions %1 keep speed %2 ms after letting go', [{ type: 'field_checkbox', name: 'SHARE', checked: true }, numF('KEEP', 150, 0, 1000, 10)],
      'speed by %1 %2 from %3 mm to %4 mm deep %5', [dd('SPEEDBY', [['time', 'time'], ['pressure (how deep)', 'pressure'], ['both', 'both']]), { type: 'input_dummy', name: 'BY' },
        numF('PFROM', 0.5, 0, 3.9, 0.1), numF('PTO', 3.2, 0.1, 4, 0.1), { type: 'input_dummy', name: 'PRESS' }]],
    ['kb_wheel', 'mouse', 'scroll wheel %1 notches', [numF('N', 1, -127, 127)], 'stack'],
    ['kb_mode', 'modes', '%1 mode %2', [dd('OP', [['enter', 'enter'], ['leave', 'leave'], ['toggle', 'toggle'], ['enter while held', 'hold']]), modeF()], 'stack'],
    ['kb_leave_all', 'modes', 'leave every mode', [], 'stack'],
    ['kb_flash', 'lights', 'flash the hold bar %1 times in %2', [numF('TIMES', 3, 1, 15, 1), { type: 'field_dropdown', name: 'COLOR', options: colourOptions }], 'stack'],
    ['kb_remap', 'modes', 'in mode %1 : %2 acts as %3', [modeF(), keyF(), { type: 'field_dropdown', name: 'TARGET', options: remapTargets }], 'remap'],
    ['kb_raw', 'keys', 'rule from the keyboard: %1', [{ type: 'field_label_serializable', name: 'TEXT', text: '' }], 'stack'],
  ];
  const TIPS = {
    kb_when_pressed: 'Runs the blocks under it when this key is pressed. For a chord, put "if <key held>" blocks under it.',
    kb_when_held: 'Runs once the key has been held this long (counted from when the "if" conditions under it became true).',
    kb_when_mode: 'The keyboard can\'t react to a mode starting or ending yet.',
    kb_if: 'Only when the condition is true. The keyboard can test held keys and modes, joined with "and".',
    kb_not_held: 'True while this key is up. Needs firmware with key action engine 5.',
    kb_while_mode: 'Only while this mode is on.',
    kb_deeper: 'The keyboard can\'t test a depth as a condition yet: use "when … pressed past … mm".',
    kb_remap: 'While the mode is on, this key does something else.',
    kb_mouse_keys: 'Keeps moving while on, speeding up from the first speed to the second over the ramp time, along the curve. Pointer px/s (10 to 2550), wheel notches/s (0.1 to 25.5). "Share speed": all directions use one speed, so turning (or adding a second arrow) keeps the speed you built up; "keep speed" holds it this long after you let go, for quick taps between directions (0 = start over at once). Sharing needs the newest open firmware. "Speed by pressure": the deeper you press, the faster (nothing above "from", full speed at "to"); the ramp, sharing and keep do nothing then. "Both": the depth sets how fast it can go, the ramp builds up to that. Pressure needs firmware with key action engine 4.',
    kb_raw: 'A rule from the keyboard that no other block shows exactly. It is saved back as it is.',
    kb_flash: 'Home, Del, PgUp, PgDn and Right flash 1 to 15 times in this colour, once each time the block runs. Needs the newest open firmware (feature "modeFlash"). A mode turning on / off has its own flash: see the Modes tab.',
  };

  // the mouse-keys speed curve as a tiny picture on its block (x = time, or depth with speed by pressure)
  function plotUri(d) {
    const pts = App.keyBlocksCore.speedCurve(d, 20), top = Math.max(d.max, 1), last = pts[pts.length - 1][0] || 1;
    const path = pts.map(([t, v], i) => `${i ? 'L' : 'M'}${(2 + (t / last) * 52).toFixed(1)} ${(22 - (v / top) * 20).toFixed(1)}`).join(' ');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="56" height="24"><rect width="56" height="24" rx="4" fill="#ffffff33"/><path d="${path}" fill="none" stroke="#fff" stroke-width="2"/></svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }

  function install(Blockly, c) {
    ctx = c;
    for (const [type, style, msg, args, kind, msg1, args1, msg2, args2, msg3, args3] of DEFS) {
      const def = { type, style: `kb_${style}`, message0: msg, args0: args, tooltip: TIPS[type] ?? '', inputsInline: kind === 'bool' };
      if (msg1) Object.assign(def, { message1: msg1, args1 });
      if (msg2) Object.assign(def, { message2: msg2, args2 });
      if (msg3) Object.assign(def, { message3: msg3, args3 });
      if (kind === 'hat') def.nextStatement = null;
      if (kind === 'stack' || kind === 'c') Object.assign(def, { previousStatement: null, nextStatement: null });
      if (kind === 'remap') Object.assign(def, { previousStatement: 'remap', nextStatement: 'remap' });
      if (kind === 'bool') def.output = 'Boolean';
      Blockly.Blocks[type] = {
        init() {
          this.jsonInit(def);
          if (kind === 'hat') this.hat = 'cap';
          for (const input of this.inputList) {
            for (const f of input.fieldRow) {
              if (f.name === 'KEY' || f.name === 'TARGET') f.setValidator((v) => (v === BOARD ? (ctx.arm(f), null) : v));
            }
          }
        },
        ...(type === 'kb_mouse_keys' && {
          onchange(e) {
            if (e && e.blockId !== this.id && e.type !== Blockly.Events.BLOCK_CREATE) return;
            const v = (n) => Number(this.getFieldValue(n));
            const by = this.getFieldValue('SPEEDBY') ?? 'time';
            const d = { start: v('START'), max: v('MAX'), rampMs: v('RAMP'), curve: this.getFieldValue('CURVE'), speedBy: by, pressFrom: v('PFROM'), pressTo: v('PTO') };
            d.power = v('POWER');
            const uri = plotUri(d), img = this.getField('PLOT');
            if (img && img.getValue() !== uri) img.setValue(uri);
            // the depths only for pressure / both; with pressure alone the ramp, sharing and keep do nothing
            const press = this.getInput('PRESS');
            if (press && press.isVisible() !== (by !== 'time')) { press.setVisible(by !== 'time'); if (this.rendered) this.render(); }
            for (const n of ['RAMP', 'SHARE', 'KEEP']) { const f = this.getField(n); if (f && f.isEnabled() !== (by !== 'pressure')) f.setEnabled(by !== 'pressure'); }
          },
        }),
      };
    }
  }
  // names that came from the keyboard or a saved workspace stay pickable
  const allowKeys = (names) => names.forEach((n) => n && extra.add(n));
  const allowColours = (list) => list.forEach((c) => typeof c === 'string' && /^#[0-9a-f]{6}$/.test(c) && extraColours.add(c));

  // flash: the keyboard has caps 'modeFlash' (the Lights category only then)
  function toolbox(modes, { flash = false } = {}) {
    const b = (type, fields) => ({ kind: 'block', type, ...(fields && { fields }) });
    const named = modes.filter((m) => m.name);
    const first = named[0] ? String(named[0].id) : '1';
    return {
      kind: 'categoryToolbox',
      contents: [
        { kind: 'category', name: 'Events', colour: COLOURS.events, contents: ['kb_when_pressed', 'kb_when_held', 'kb_when_tapped', 'kb_when_past', 'kb_when_above', 'kb_when_released'].map((t) => b(t, { KEY: 'M' })).concat(b('kb_when_mode', { MODE: first })) },
        { kind: 'category', name: 'Control', colour: COLOURS.control, contents: [b('kb_if'), b('kb_while_mode', { MODE: first })] },
        { kind: 'category', name: 'Sensing', colour: COLOURS.sensing, contents: [b('kb_held', { KEY: 'Fn' }), b('kb_not_held', { KEY: 'Fn' }), b('kb_mode_active', { MODE: first }), b('kb_deeper', { KEY: 'W' })] },
        { kind: 'category', name: 'Operators', colour: COLOURS.operators, contents: [b('kb_and'), b('kb_or'), b('kb_not')] },
        { kind: 'category', name: 'Keys', colour: COLOURS.keys, contents: [b('kb_key', { OP: 'press', KEY: 'Space' }), b('kb_key', { OP: 'release', KEY: 'Space' }), b('kb_key', { OP: 'tap', KEY: 'Space' })] },
        { kind: 'category', name: 'Gamepad', colour: COLOURS.gamepad, contents: [b('kb_gp_button'), b('kb_gp_stick'), b('kb_gp_depth')] },
        { kind: 'category', name: 'Mouse', colour: COLOURS.mouse, contents: [b('kb_mouse_button'), b('kb_mouse_move'), b('kb_mouse_glide'), b('kb_mouse_keys'), b('kb_wheel')] },
        { kind: 'category', name: 'Modes', colour: COLOURS.modes, contents: [
          { kind: 'button', text: 'Make a mode', callbackKey: 'kbMakeMode' },
          ...(named.length ? [{ kind: 'button', text: 'Rename a mode', callbackKey: 'kbRenameMode' },
            b('kb_mode', { OP: 'enter', MODE: first }), b('kb_mode', { OP: 'leave', MODE: first }), b('kb_mode', { OP: 'toggle', MODE: first }), b('kb_leave_all'),
            { kind: 'label', text: 'Key bindings in a mode' }, b('kb_remap', { MODE: first, KEY: 'RShift', TARGET: 'mouse:L' })] : [{ kind: 'label', text: 'Make a mode first (up to 3).' }])] },
        ...(flash ? [{ kind: 'category', name: 'Lights', colour: COLOURS.lights, contents: [b('kb_flash', { TIMES: 3, COLOR: 'default' })] }] : []),
      ],
    };
  }

  // a Blockly theme from the page's colour tokens (dark / light follow the page)
  function theme(Blockly) {
    const css = getComputedStyle(document.documentElement), tok = (n) => css.getPropertyValue(n).trim();
    // Blockly takes #rrggbb only (no alpha): the outline is the colour 25 % darker, like Scratch's
    const darker = (hex) => `#${[1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * 0.75).toString(16).padStart(2, '0')).join('')}`;
    const blockStyles = Object.fromEntries(Object.entries(COLOURS).map(([k, c]) => [`kb_${k}`, { colourPrimary: c, colourSecondary: c, colourTertiary: darker(c), ...(k === 'events' && { hat: 'cap' }) }]));
    // the name becomes a CSS class (.kb-…-theme): letters and digits only, or every renderer rule is dropped
    return Blockly.Theme.defineTheme(`kb-${tok('--bg').replace(/[^a-z0-9]/gi, '') || 'page'}`, {
      base: Blockly.Themes.Zelos ?? Blockly.Themes.Classic,
      blockStyles,
      componentStyles: {
        workspaceBackgroundColour: tok('--surface-2'), toolboxBackgroundColour: tok('--surface'), toolboxForegroundColour: tok('--text'),
        flyoutBackgroundColour: tok('--surface'), flyoutForegroundColour: tok('--text'), flyoutOpacity: 0.96, scrollbarColour: tok('--line'),
        insertionMarkerColour: tok('--text'), insertionMarkerOpacity: 0.3, cursorColour: tok('--accent'),
      },
      fontStyle: { family: 'Inter, system-ui, sans-serif', weight: '600', size: 11 },
    });
  }

  App.kbDefs = { install, toolbox, theme, plotUri, allowKeys, allowColours, BOARD, COLOURS };
})();
