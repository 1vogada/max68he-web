// "While a text is typing" (open-firmware option textTyping, caps 'textTyping'): one
// 3-way control, shown on the Text keys page (applied at once) and in Settings > Firmware
// options (saved with that form's Save). Both show what the keyboard has; a change
// saved from either one shows in the other.
(() => {
  const App = (window.App = window.App || {});

  const MODES = [
    ['keep', 'Keys keep working', 'Other keys work as usual while a text is typed; what you press mixes into the text.'],
    ['block', "Block other keys until it's done", 'Other keys do nothing until the text is done (keys still held then stay off until let go). '
      + 'Esc stops the text; that Esc press is not sent, so it can\'t close a dialog.'],
    ['stop', 'Stop typing on any key press', 'Pressing any other key stops the rest of the text; that key then works as usual.'],
  ];
  const views = [];   // { host, instant }
  let value = 'keep';

  const supported = () => (App.st?.features ?? []).includes('textTyping');

  function show(v) {
    views.forEach(({ host }) => {
      App.$$('input[type=radio]', host).forEach((r) => { r.checked = r.value === v; });
      App.$('.help', host).textContent = (MODES.find((m) => m[0] === v) ?? MODES[0])[2];
    });
  }

  // instant: a change is written to the keyboard at once; otherwise the host's form saves it
  // (the radios are named textTyping, so form.elements.textTyping.value reads the choice)
  function mount(host, { instant = false } = {}) {
    const name = instant ? 'textTypingNow' : 'textTyping';
    host.classList.add('field', 'text-typing');
    host.innerHTML = `<span class="text-typing-title">While a text is typing</span>
      <div class="seg-tabs" role="radiogroup" aria-label="While a text is typing">${MODES.map(([v, label]) =>
        `<label><input type="radio" name="${name}" value="${v}"><span>${label}</span></label>`).join('')}</div>
      <span class="help"></span>`;
    if (instant) {
      host.dataset.nodirty = '1';    // not part of the surrounding panel's save bar
      host.addEventListener('change', (e) => {
        const v = e.target.value;
        App.$('.help', host).textContent = MODES.find((m) => m[0] === v)[2];
        App.busy(host, 'Saving…', async () => {
          try {
            const r = await App.api('POST', '/api/fw-options', { textTyping: v });
            App.st.fwOptions = r.fwOptions;
            value = r.fwOptions.textTyping;
            App.toast('Saved to the keyboard');
          } finally { show(value); }
        });
      });
    }
    views.push({ host, instant });
    fill(App.st?.fwOptions);
  }

  // from the keyboard's options (null on the stock firmware): every instance shows them
  function fill(o) {
    const ok = Boolean(o) && supported();
    views.forEach(({ host }) => { host.hidden = !ok; });
    if (ok) value = o.textTyping ?? 'keep';
    show(value);
  }

  App.textTyping = { mount, fill, supported };
})();
