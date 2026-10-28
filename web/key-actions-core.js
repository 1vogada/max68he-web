// Key action maps (open firmware 0xEE, caps 'keyActions'): per key, what happens at which depth
// or after how long held. The JSON form's names and defaults, the plain-English summary, and the
// Key wizard's questions and templates. Used by src/key-actions.js (Node, which adds the byte
// form and full validation) and by the Gamepad page's Key wizard (web/key-wizard.js).
//
// Rule JSON: { when: down|up|hold|tap|press|release, at?: mm (down/up), ms?: (hold/tap),
//   mode?: press|release|tap|toggle|while, do: { key } | { gamepad } | { axis, percent } |
//   { axis, from, to } | { mouse } | { move: [dx, dy] } | { glide: [dx, dy], ms } | { wheel } }
(() => {
  const TRIGGERS = ['down', 'up', 'hold', 'tap', 'press', 'release'];         // wire = index + 1
  const MODES = ['press', 'release', 'tap', 'toggle', 'while'];               // wire = index + 1
  const OUTPUTS = ['key', 'gamepad', 'axis', 'axisDepth', 'mouse', 'move', 'glide', 'wheel'];   // wire = index + 1
  // gamepad.h targets: GP_LX_NEG..GP_RT = 1..10 (axes), GP_A..GP_RIGHT = 11..24 (buttons)
  const AXES = ['LX-', 'LX+', 'LY-', 'LY+', 'RX-', 'RX+', 'RY-', 'RY+', 'LT', 'RT'];
  const BUTTONS = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'Back', 'Start', 'LS', 'RS', 'Up', 'Down', 'Left', 'Right'];
  const MOUSE_BITS = { L: 1, R: 2, M: 4 };
  const ONCE = ['move', 'glide', 'wheel'];                                    // happen once: modes tap / press only
  const DEFAULT_MODE = { down: 'while', up: 'tap', hold: 'press', tap: 'tap', press: 'press', release: 'tap' };
  const DEFAULTS = { pressMm: 0.3, gapMm: 0.1 };

  const AXIS_TEXT = {
    'LX-': 'left stick left', 'LX+': 'left stick right', 'LY-': 'left stick up', 'LY+': 'left stick down',
    'RX-': 'right stick left', 'RX+': 'right stick right', 'RY-': 'right stick up', 'RY+': 'right stick down',
    LT: 'left trigger', RT: 'right trigger',
  };
  const BUTTON_TEXT = { LS: 'left stick click', RS: 'right stick click', Up: 'D-pad up', Down: 'D-pad down', Left: 'D-pad left', Right: 'D-pad right' };

  // which output a rule's `do` names (null when none)
  function outputKind(d) {
    if (!d || typeof d !== 'object') return null;
    if ('key' in d) return 'key';
    if ('gamepad' in d) return 'gamepad';
    if ('axis' in d) return 'from' in d || 'to' in d ? 'axisDepth' : 'axis';
    if ('mouse' in d) return 'mouse';
    if ('move' in d) return 'move';
    if ('glide' in d) return 'glide';
    if ('wheel' in d) return 'wheel';
    return null;
  }

  // the mode a rule gets when it names none: once-outputs (move, glide, wheel) happen once (tap)
  const defaultMode = (rule) => (ONCE.includes(outputKind(rule?.do)) ? 'tap' : DEFAULT_MODE[rule?.when] ?? 'press');

  // modes the firmware takes for a trigger and an output
  function allowedModes(when, kind) {
    return MODES.filter((m) => !(m === 'while' && ['up', 'tap', 'release'].includes(when))
      && !(kind === 'axisDepth' && !['press', 'while', 'toggle'].includes(m))
      && !(ONCE.includes(kind) && !['tap', 'press'].includes(m)));
  }

  // ---- plain English ---------------------------------------------------------------

  const mm = (v) => `${Number(v).toFixed(2)} mm`;
  const time = (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : `${Number((ms / 1000).toFixed(2))} s`);
  const keyText = (k) => String(k).split('+').map((p) => p.trim().replace(/^L(Ctrl|Shift|Alt|Win)$/, '$1')).join('+');
  const px = (v, pos, neg) => `${Math.abs(v)} px ${v >= 0 ? pos : neg}`;

  function outputText(d) {
    switch (outputKind(d)) {
      case 'key': return keyText(d.key);
      case 'gamepad': return BUTTON_TEXT[d.gamepad] ?? `${d.gamepad}`;
      case 'axis': return `${AXIS_TEXT[d.axis] ?? d.axis} ${d.percent} %`;
      case 'axisDepth': return `${AXIS_TEXT[d.axis] ?? d.axis}, deeper = further (${mm(d.from)} to ${mm(d.to)})`;
      case 'mouse': {
        const names = { L: 'left', R: 'right', M: 'middle' };
        const list = String(d.mouse).split('+').map((b) => names[b.trim().toUpperCase()] ?? b);
        return `the ${list.join(' and ')} mouse button${list.length > 1 ? 's' : ''}`;
      }
      case 'move': {
        const [dx, dy] = d.move;
        return `moves the mouse ${[dx && px(dx, 'right', 'left'), dy && px(dy, 'down', 'up')].filter(Boolean).join(' and ') || 'nowhere'}`;
      }
      case 'glide': {
        const [dx, dy] = d.glide;
        return `glides the mouse ${[dx && px(dx, 'right', 'left'), dy && px(dy, 'down', 'up')].filter(Boolean).join(' and ') || 'nowhere'} over ${time(d.ms)}`;
      }
      case 'wheel': return `scrolls ${Math.abs(d.wheel)} notch${Math.abs(d.wheel) === 1 ? '' : 'es'} ${d.wheel > 0 ? 'up' : 'down'}`;
      default: return 'nothing';
    }
  }

  function whenText(r) {
    switch (r.when) {
      case 'press': return 'Light press';
      case 'down': return `Past ${mm(r.at)}`;
      case 'up': return `Back above ${mm(r.at)}`;
      case 'hold': return `Held ${time(r.ms)}`;
      case 'tap': return `Quick tap (let go within ${time(r.ms)})`;
      case 'release': return 'Let go';
      default: return String(r.when);
    }
  }

  function actionText(r) {
    if (r.do && typeof r.do === 'object' && 'flash' in r.do) {   // the FLASH output (caps 'modeFlash'): no mode, fires once
      const n = r.do.times ?? 3, c = r.do.flash;
      return `flashes the hold bar ${n} time${n === 1 ? '' : 's'}${typeof c === 'string' ? ` in ${c}` : Array.isArray(c) ? ` in rgb(${c.join(', ')})` : ''}`;
    }
    const kind = outputKind(r.do), o = outputText(r.do), mode = r.mode ?? defaultMode(r);
    if (ONCE.includes(kind)) return o;
    const axis = kind === 'axis' || kind === 'axisDepth';
    switch (mode) {
      case 'press': case 'while': return axis ? o : `${mode === 'while' ? 'holds' : 'presses'} ${o}`;
      case 'tap': return axis ? `flicks ${o}` : `taps ${o}`;
      case 'toggle': return `turns ${o} on or off`;
      case 'release': return `lets go of ${axis ? AXIS_TEXT[r.do.axis] ?? r.do.axis : o}`;
      default: return o;
    }
  }

  const ruleText = (r) => `${whenText(r)}: ${actionText(r)}.`;
  // one sentence per rule, plus one when the key still types its own key
  function summary(spec) {
    const out = (spec?.rules ?? []).map(ruleText);
    if (spec?.alsoType) out.push('It still types its own key too.');
    return out;
  }

  // ---- the Key wizard: questions, answers and templates ------------------------------
  // Answers: { light, deep, bottom, tap, hold }, each { do: output | null, mode, at | ms }.

  const QUESTIONS = [
    { id: 'light', when: 'press', mode: 'press', title: 'Light press', ask: () => 'What happens on a light press?' },
    { id: 'deep', when: 'down', mode: 'while', at: 2.0, title: 'Deeper press', ask: (a) => `…when you press past ${mm(a.at)}?` },
    { id: 'bottom', when: 'down', mode: 'while', at: 3.2, title: 'At the bottom', ask: () => '…at the bottom?' },
    { id: 'tap', when: 'tap', mode: 'tap', ms: 200, title: 'Quick tap', ask: (a) => `…on a quick tap (let go within ${time(a.ms)})?` },
    { id: 'hold', when: 'hold', mode: 'press', ms: 3000, title: 'Keep holding', ask: (a) => `…if you keep holding for ${time(a.ms)}?` },
  ];
  const BOTTOM_FROM = 3.0;                       // a lone depth rule this deep reads as "at the bottom"

  function blankAnswers() {
    return Object.fromEntries(QUESTIONS.map((q) => [q.id, { do: null, mode: q.mode, ...(q.at !== undefined && { at: q.at }), ...(q.ms !== undefined && { ms: q.ms }) }]));
  }

  const TEMPLATES = [
    { id: 'walkRun', name: 'Walk / run', icon: '↑ ⇈', note: 'Light press: left stick up 40 %. Deep press: 100 %.',
      answers: { light: { do: { axis: 'LY-', percent: 40 } }, deep: { at: 2.5, do: { axis: 'LY-', percent: 100 } } } },
    { id: 'walkRunSprint', name: 'Walk / run / sprint', icon: '↑ ⇈ ⇪', note: 'Walk / run, and at the bottom also Shift (or LB) to sprint.',
      answers: { light: { do: { axis: 'LY-', percent: 40 } }, deep: { at: 2.2, do: { axis: 'LY-', percent: 100 } }, bottom: { at: 3.2, do: { key: 'LShift' } } },
      alternatives: { bottom: [{ key: 'LShift' }, { gamepad: 'LB' }] } },
    { id: 'aimShoot', name: 'Aim and shoot', icon: '◎ ✸', note: 'Half press: right trigger 50 % (aim). At the bottom: right trigger 100 % (fire).',
      answers: { deep: { at: 1.5, do: { axis: 'RT', percent: 50 } }, bottom: { at: 3.2, do: { axis: 'RT', percent: 100 } } },
      alternatives: { bottom: [{ axis: 'RT', percent: 100 }, { mouse: 'L' }] } },
    { id: 'tapHold', name: 'Tap / hold', icon: 'A | B', note: 'A quick tap presses A; holding it for 0.5 s presses B instead.',
      answers: { tap: { ms: 500, do: { gamepad: 'A' } }, hold: { ms: 500, do: { gamepad: 'B' } } } },
    { id: 'holdTo', name: 'Hold to …', icon: '⏱', note: 'Hold the key for a few seconds (up to 10) to do something.',
      answers: { hold: { ms: 3000, do: null } } },
    { id: 'toggleDeep', name: 'Toggle on deep press', icon: '⇵', note: 'A deep press switches something on; the next deep press switches it off.',
      answers: { deep: { at: 2.5, mode: 'toggle', do: { key: 'LCtrl' } } } },
    { id: 'scratch', name: 'Start from scratch', icon: '∅', note: 'Every question starts at "nothing".', answers: {} },
  ];

  function templateAnswers(id) {
    const t = TEMPLATES.find((x) => x.id === id);
    if (!t) throw new Error(`unknown template ${id}`);
    const a = blankAnswers();
    for (const [q, v] of Object.entries(t.answers)) a[q] = { ...a[q], ...v, do: v.do ? { ...v.do } : null };
    return a;
  }

  // answers (+ key options and rules the wizard doesn't ask about) -> the JSON spec
  function answersToSpec({ key, slot, pressMm = DEFAULTS.pressMm, gapMm = DEFAULTS.gapMm, alsoType = false, answers, extra = [] }) {
    const rules = [];
    for (const q of QUESTIONS) {
      const a = answers?.[q.id];
      if (!a?.do) continue;
      const r = { when: q.when };
      if (q.when === 'down') r.at = a.at;
      if (q.when === 'hold' || q.when === 'tap') r.ms = a.ms;
      r.mode = allowedModes(q.when, outputKind(a.do)).includes(a.mode) ? a.mode : defaultMode({ when: q.when, do: a.do });
      r.do = a.do;
      rules.push(r);
    }
    return { ...(key !== undefined && { key }), ...(slot !== undefined && { slot }), press: pressMm, gap: gapMm, alsoType, rules: [...rules, ...extra] };
  }

  // a stored spec -> answers; rules no question covers stay in `extra` (kept as they are)
  function specToAnswers(spec) {
    const answers = blankAnswers(), extra = [], used = new Set();
    const take = (id, r, more) => { used.add(id); answers[id] = { ...answers[id], ...more, mode: r.mode ?? defaultMode(r), do: r.do }; };
    const rules = spec?.rules ?? [];
    const downs = rules.filter((r) => r.when === 'down').sort((x, y) => x.at - y.at);
    const deepRule = downs.length >= 2 || (downs[0] && downs[0].at < BOTTOM_FROM) ? downs[0] : null;
    const bottomRule = downs.length >= 2 ? downs[1] : downs[0] && downs[0].at >= BOTTOM_FROM ? downs[0] : null;
    for (const r of rules) {
      // a flash has no mode (its mode byte is the count): no question takes it, it is kept as it is
      if (r.do && typeof r.do === 'object' && 'flash' in r.do) extra.push(r);
      else if (r.when === 'press' && !used.has('light')) take('light', r, {});
      else if (r === deepRule) take('deep', r, { at: r.at });
      else if (r === bottomRule) take('bottom', r, { at: r.at });
      else if (r.when === 'tap' && !used.has('tap')) take('tap', r, { ms: r.ms });
      else if (r.when === 'hold' && !used.has('hold')) take('hold', r, { ms: r.ms });
      else extra.push(r);
    }
    return { pressMm: spec?.press ?? DEFAULTS.pressMm, gapMm: spec?.gap ?? DEFAULTS.gapMm, alsoType: Boolean(spec?.alsoType), answers, extra };
  }

  const api = {
    TRIGGERS, MODES, OUTPUTS, AXES, BUTTONS, MOUSE_BITS, ONCE, DEFAULT_MODE, DEFAULTS, AXIS_TEXT, BUTTON_TEXT,
    QUESTIONS, TEMPLATES, BOTTOM_FROM,
    outputKind, defaultMode, allowedModes, outputText, whenText, actionText, ruleText, summary, mm, time,
    blankAnswers, templateAnswers, answersToSpec, specToAnswers,
  };
  if (typeof module !== 'undefined') module.exports = api;
  else { window.App = window.App || {}; window.App.keyActions = api; }
})();
