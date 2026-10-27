// One-line descriptions of the lighting effects, shown under the Effect picker.
// Stock firmware draws modes 1-19 itself; the open firmware draws them with its
// own code (led_effects.c / fx.c), which so far only implements some of them.
(() => {
  const App = (window.App = window.App || {});
  const NOT_YET = 'Not drawn by the open firmware yet: shows as a plain static colour.';
  const VENDOR = "Attack Shark's own animation, drawn by the stock firmware.";

  // [stock firmware, open firmware]
  const STOCK = {
    1: ['One steady colour.', 'One steady colour.'],
    2: ['One colour slowly fading in and out.', 'One colour fading in and out; with Rainbow the colour drifts too.'],
    3: [VENDOR, 'Neon: the board drifts through colours row by row with a slow pulse.'],
    4: ['A rainbow scrolls across the board in the chosen direction.', 'A rainbow scrolls across the board in the chosen direction.'],
    5: ['Each key press sends a ring of light outward.', 'Each key press sends a ring of light across the board.'],
    6: [VENDOR, NOT_YET],
    7: [VENDOR, NOT_YET],
    8: [VENDOR, NOT_YET],
    9: [VENDOR, NOT_YET],
    10: [VENDOR, NOT_YET],
    11: [VENDOR, NOT_YET],
    12: [VENDOR, NOT_YET],
    14: [VENDOR, NOT_YET],
    15: [VENDOR, NOT_YET],
    16: [VENDOR, 'The whole board shows one colour that cycles through the rainbow.'],
    17: [VENDOR, NOT_YET],
    18: [VENDOR, NOT_YET],
    19: [VENDOR, NOT_YET],
  };

  // open-firmware effects (marked ★)
  const OPEN = {
    0x40: 'Every key cycles through colours from its own random start, so the board shimmers.',
    0x42: 'Droplet: the deeper you press a key, the brighter and wider it glows; nearby glows merge like water.',
    0x43: 'Pressed keys light up and fade out.',
    0x44: 'Each key press sends a ring of light across the board.',
    0x45: 'Heatmap: keys glow by how often you pressed them lately, blue (rare) to red (a lot).',
    0x46: 'Each key shows how far it is pressed, green to yellow to red.',
    0x47: 'Random keys twinkle like stars.',
    0x48: 'Drops fall down the columns, Matrix style.',
    0x49: 'Flames rise from the bottom row.',
    0x4a: 'Slow green, teal and violet northern lights.',
    0x4b: 'Like Ripple, but the rings are rainbow coloured and keep going.',
    // pressure effects: depth, press speed and hold time
    0x4c: 'Trampoline: the board is a stretchy sheet. Keys push it down as deep as you press; let go and waves bounce around.',
    0x4d: 'Liquid dye: pressing drips coloured ink (more when deeper) that spreads, drifts and mixes with other keys\' colours.',
    0x4e: 'Frost: the board is frozen. A press melts a hole as wide as it is deep, and it slowly freezes over again.',
    0x4f: 'Lava lamp: blobs drift around; pressing heats them so they rise, merge, cool and sink.',
    0x50: 'Charge shot: hold a key deep to charge it up to white-hot; let go to fire a burst as big as the charge.',
    0x51: 'Impact: hitting the bottom sends a shockwave sized by how hard you hit. Gentle typing stays calm.',
    0x52: 'Sparks: fast presses throw sparks that fall away; slow presses only glow.',
    0x53: 'Lightning: hold two or more keys and arcs jump between them, brighter the harder you press.',
    0x54: 'Gravity: a flowing rainbow gets pulled and twisted toward the keys you press.',
    0x55: 'Squeeze: the more pressure on the whole board, the brighter it gets, blue through red to white.',
    0x56: 'Actuation trainer: blue warming to yellow as a key nears its actuation point, green when it triggers, orange flash on a rapid-trigger reset.',
    0x57: 'WASD gauge: only W A S D (or your gamepad keys) light, as a green-to-red gauge of how far they are pressed.',
    0x58: 'Spotlight: dark board; each pressed key is a torch that widens with depth and leaves an afterglow.',
    0x59: 'Pressure paint: keys paint the board. Depth sets the brush size, press speed the colour (slow blue, fast red).',
  };

  // analog effects: use how far (and how fast) keys are pressed, not just pressed / not pressed
  App.isAnalogEffect = (mode) => mode === 0x42 || mode === 0x46 || (mode >= 0x4c && mode <= 0x59);

  App.effectInfo = (mode, openFirmware) => {
    if (OPEN[mode]) return OPEN[mode];
    const s = STOCK[mode];
    return s ? s[openFirmware ? 1 : 0] : '';
  };
})();
