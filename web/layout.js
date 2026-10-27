// Physical layouts, one per keyboard model (src/models.js key), 16 units wide.
// Each key: name as the keymap reports it (resolved to a slot at load), or a fixed
// { slot, label } or { slot, name }; w = width in key units (default 1).
// X82HE Pro: fixed slots from its stock keymap (6 slots per matrix column), so a
// remapped key stays in place; the knob's turns are slots 90 / 91, its press 92.
const x82 = (names, first, step = 6) => names.map((n, i) => [{ slot: first + i * step, name: n }]);
window.LAYOUTS = {
  max68he: [
    [['Esc'], ['1'], ['2'], ['3'], ['4'], ['5'], ['6'], ['7'], ['8'], ['9'], ['0'], ['-'], ['='],
      ['Bksp', 2], [{ slot: 85, label: 'Home' }]],
    [['Tab', 1.5], ['Q'], ['W'], ['E'], ['R'], ['T'], ['Y'], ['U'], ['I'], ['O'], ['P'], ['['], [']'],
      ['\\', 1.5], ['Del']],
    [['Caps', 1.75], ['A'], ['S'], ['D'], ['F'], ['G'], ['H'], ['J'], ['K'], ['L'], [';'], ["'"],
      ['Enter', 2.25], ['PgUp']],
    [['LShift', 2.25], ['Z'], ['X'], ['C'], ['V'], ['B'], ['N'], ['M'], [','], ['.'], ['/'],
      ['RShift', 1.75], ['Up'], ['PgDn']],
    [['LCtrl', 1.25], ['LWin', 1.25], ['LAlt', 1.25], ['Space', 6.25], ['RAlt'], ['Fn'], ['RCtrl'],
      ['Left'], ['Down'], ['Right']],
  ],
  x82he: [
    [[{ slot: 0, name: 'Esc' }], ...x82(['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'], 6),
      [{ slot: 92, name: 'Knob' }], [{ slot: 78, name: 'Del' }], [{ slot: 84, name: 'Ins' }]],
    [...x82(['`', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '='], 1),
      [{ slot: 79, name: 'Bksp' }, 2], [{ slot: 85, name: 'Home' }]],
    [[{ slot: 2, name: 'Tab' }, 1.5], ...x82(['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P', '[', ']'], 8),
      [{ slot: 80, name: '\\' }, 1.5], [{ slot: 86, name: 'PgUp' }]],
    [[{ slot: 3, name: 'Caps' }, 1.75], ...x82(['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', ';', "'"], 9),
      [{ slot: 81, name: 'Enter' }, 2.25], [{ slot: 87, name: 'PgDn' }]],
    [[{ slot: 4, name: 'LShift' }, 2.25], ...x82(['Z', 'X', 'C', 'V', 'B', 'N', 'M', ',', '.', '/'], 16),
      [{ slot: 76, name: 'RShift' }, 1.75], [{ slot: 82, name: 'Up' }], [{ slot: 88, name: 'End' }]],
    [[{ slot: 5, name: 'LCtrl' }, 1.25], [{ slot: 17, name: 'LWin' }, 1.25], [{ slot: 23, name: 'LAlt' }, 1.25],
      [{ slot: 41, name: 'Space' }, 6.25], [{ slot: 59, name: 'RAlt' }], [{ slot: 65, name: 'Fn' }],
      [{ slot: 71, name: 'RCtrl' }], [{ slot: 77, name: 'Left' }], [{ slot: 83, name: 'Down' }], [{ slot: 89, name: 'Right' }]],
  ],
};
window.LAYOUT = window.LAYOUTS.max68he;   // app.js switches it to the connected keyboard's

// Short labels for drawing.
window.LABELS = {
  LShift: 'Shift', RShift: 'Shift', LCtrl: 'Ctrl', RCtrl: 'Ctrl', LAlt: 'Alt', RAlt: 'Alt',
  LWin: 'Win', Bksp: '⌫', Enter: 'Enter', Left: '←', Right: '→', Up: '↑', Down: '↓', Space: '',
};

// Selection groups for quick picks.
window.GROUPS = {
  typing: (name) => /^([A-Z0-9]|[-=[\]\\;',./`])$/.test(name) || ['Left', 'Right', 'Up', 'Down'].includes(name),
  wasd: (name) => ['W', 'A', 'S', 'D'].includes(name),
  mods: (name) => /Shift|Ctrl|Alt|Win|Fn|Caps|Tab|Esc|Enter|Space|Bksp|Del|PgUp|PgDn/.test(name),
};
