// kbcode examples: served by GET /api/kbcode/docs, listed in docs/KBCODE.md, and every one is
// compiled by the tests (tests/kbcode.test.js), so they stay correct.
const EXAMPLES = [
  {
    name: 'gaming',
    title: 'Fast typing keys, snap tap on A / D, a lit WASD',
    code: `// every typing key: shallow actuation and rapid trigger
for (const k of kb.keys.typing) k.actuation(1.2).rapidTrigger({ press: 0.15, release: 0.15 });
// strafing: pressing A lets go of D and the other way round
kb.key('A').snapTap('D');
// WASD cyan, everything else dim blue, shown as the lighting
kb.lighting.picture(0, { fill: '#000020' }).brightness(4);
kb.keys.wasd.forEach((k) => k.color('cyan'));
`,
  },
  {
    name: 'rainbow-rows',
    title: 'A colour per row (per-key picture), computed in a loop',
    code: `kb.keys.rows.forEach((row, i) => {
  row.color(kb.hsl(i * 60, 100, 50));
});
kb.lighting.effect('picture').brightness(3);
`,
  },
  {
    name: 'mouse-mode',
    title: 'Mouse mode (the tests/fixtures/ka-mouse-mode.json example as code)',
    code: `// Fn + Ctrl + M held 3 s turns mouse mode on. In it the arrows move the pointer
// (sharing their speed), Right Shift / PgDn click, Esc leaves.
const mouse = kb.mode('Mouse');
kb.key('M').when('hold', 3000).if({ held: ['Fn', 'LCtrl'] }).do(mouse.enter());
kb.key('RShift').when('press').if({ mode: mouse }).do(kb.mouse.button('L'));
kb.key('PgDn').when('press').if({ mode: mouse }).do(kb.mouse.button('R'));
for (const dir of ['Up', 'Down', 'Left', 'Right']) {
  kb.key(dir).when('press').mode('while').if({ mode: mouse })
    .do(kb.mouse.move(dir.toLowerCase(), { shareSpeed: true, keepMs: 150 }));
}
kb.key('Esc').when('press').if({ mode: mouse }).do(mouse.leave());
`,
  },
  {
    name: 'walk-run',
    title: 'Analog walk / run and tap / hold on the on-board engine',
    code: `// W: a light press walks (left stick 40 % up), past 2.5 mm runs (100 %)
kb.key('W').when('press').do(kb.gamepad.axis('LY-', 40));
kb.key('W').when('down', 2.5).do(kb.gamepad.axis('LY-', 100));
// E: a quick tap is A, holding it 300 ms is B
kb.key('E').when('tap', 300).do(kb.gamepad.button('A'));
kb.key('E').when('hold', 300).do(kb.gamepad.button('B'));
// C: a deep press toggles crouch (Left Ctrl stays down until the next deep press)
kb.key('C').when('down', 2.5).mode('toggle').do(kb.send('LCtrl'));
`,
  },
  {
    name: 'nav-layer',
    title: 'A Nav mode: Fn + N toggles it, H J K L act as arrows inside it; Caps as mod-tap',
    code: `const nav = kb.mode('Nav');
kb.key('N').when('press').if({ held: ['Fn'] }).do(nav.toggle());   // N alone still types N
const arrows = { H: 'Left', J: 'Down', K: 'Up', L: 'Right' };
for (const [key, arrow] of Object.entries(arrows)) nav.remap(key, arrow);
// Caps on its own: a tap is Esc, holding it is Left Ctrl
kb.key('Caps').modTap('LCtrl', 'Esc', 200);
`,
  },
  {
    name: 'texts-macros',
    title: 'Text keys, a macro and the Fn layer',
    code: `kb.text(0, 'Best regards,\\nIvo');
kb.key('E').fn('Text0');             // Fn + E types the text
kb.macro(1, { text: 'git status', delayMs: 10 });
kb.key('G').fn('Macro1');            // Fn + G plays macro 1
kb.key('Home').fn('End');            // Fn + Home = End
kb.key('PgUp').fn('VolumeUp');
kb.key('PgDn').fn('VolumeDown');
`,
  },
  {
    name: 'settings',
    title: 'Options, firmware options and lighting',
    code: `kb.pollingRate(8000);
kb.options({ antiMistouch: false, rtStability: 0 });
kb.firmwareOptions({ capsIndicator: true, capsColor: 'orange', idleMinutes: 10 });
kb.textTyping('block');
kb.lighting.effect('wave', { direction: 'left', speed: 3 }).color('rgb(255, 0, 128)').brightness(4);
`,
  },
];

module.exports = { EXAMPLES };
