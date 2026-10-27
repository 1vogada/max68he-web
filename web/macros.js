// Macros panel: store text as a macro (0-15), read even-numbered ones back.
(() => {
  const App = (window.App = window.App || {});
  App.views = App.views || {};

  let tracker;
  let slot = 0;

  function show(m) {
    const f = App.$('#macro-form');
    const out = App.$('#macro-content');
    if (m.unreadable) {
      out.textContent = 'Odd-numbered macros cannot be read back from this firmware (they still play). Typing new text replaces it.';
      f.elements.text.value = '';
    } else if (m.steps.length) {
      out.textContent = `Stored: “${m.text}”, ${m.repeat === 1 ? 'once' : `${m.repeat} times`}.`;
      f.elements.text.value = m.text;
      f.elements.repeat.value = m.repeat;
    } else {
      out.textContent = 'This slot is empty.';
      f.elements.text.value = '';
      f.elements.repeat.value = 1;
    }
  }

  async function read() {
    const f = App.$('#macro-form');
    const index = Number(f.elements.index.value);
    App.$('#macro-content').textContent = 'Reading…';
    try {
      show(await App.api('POST', '/api/macro/get', { index }));
      App.ui.showError(f, null);
    } catch (e) {
      App.$('#macro-content').textContent = '';
      App.ui.showError(f, `Could not read macro ${index}: ${e.message}`);
    }
    tracker.clear();
  }

  function init() {
    const { $, api } = App;
    const f = $('#macro-form');
    for (let i = 0; i < 16; i++) f.elements.index.add(new Option(`Macro ${i}`, i));
    f.elements.index.dataset.nodirty = '1';
    f.elements.index.closest('label').dataset.nodirty = '1';
    f.elements.index.onchange = () => {
      if (tracker.dirty && !App.ui.confirmLeave()) { f.elements.index.value = slot; return; }
      slot = Number(f.elements.index.value);
      read();
    };
    tracker = App.ui.track(f, {
      async save() {
        const body = {
          index: Number(f.elements.index.value),
          text: f.elements.text.value,
          repeat: Number(f.elements.repeat.value) || 1,
          delayMs: Number(f.elements.delay.value) || 15,
        };
        if (!body.text) throw new Error('Type the text the macro should type first');
        show(await api('POST', '/api/macro/set', body));
      },
      discard: read,
    });
    $('#macro-assign').onclick = () => {
      const n = Number(f.elements.index.value);
      if (tracker.dirty) return App.toast('Save the macro first, then put it on a key', true);
      App.pendingKey = `Macro${n}`;
      if (App.goto('keymap')) App.toast(`Click the key that should play Macro ${n}, then Save`);
    };
  }

  // Not a keyboard view; registered for its init hook only.
  App.views.macros = { init: () => { init(); setTimeout(read, 0); } };
})();
