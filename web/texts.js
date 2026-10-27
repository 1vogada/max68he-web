// Text keys page (open firmware): 64 strings the keyboard types by itself. A key set to
// TextN (Remap, Fn layers, layers) types string N when pressed.
(() => {
  const App = (window.App = window.App || {});
  App.views = App.views || {};

  let texts = null;          // as on the keyboard
  let max = 119;
  let tracker;
  let loading = false;

  const supported = () => (App.st.features ?? []).includes('textKeys');

  function row(i) {
    const r = document.createElement('div');
    r.className = 'text-row';
    r.innerHTML = `<span class="text-name">Text${i}</span>
      <input type="text" spellcheck="false" aria-label="Text ${i}">
      <span class="text-count muted small"></span>
      <button type="button" class="text-assign" data-nodirty>Put on a key…</button>`;
    const input = App.$('input', r);
    input.dataset.index = i;
    input.addEventListener('input', () => count(r));
    App.$('.text-assign', r).onclick = () => {
      if (tracker.dirty) return App.toast('Save the texts first, then put one on a key', true);
      App.pendingKey = `Text${i}`;
      if (App.goto('keymap')) App.toast(`Click the key that should type Text${i}, then Save`);
    };
    return r;
  }

  const bytes = (s) => new TextEncoder().encode(s).length;   // bytes of UTF-8, what the keyboard stores

  function count(r) {
    const input = App.$('input', r);
    const n = bytes(input.value);
    App.$('.text-count', r).textContent = `${n}/${max}`;
    r.classList.toggle('over', n > max);
    r.classList.toggle('changed', texts !== null && input.value !== texts[Number(input.dataset.index)]);
  }

  function fill() {
    const list = App.$('#text-list');
    list.innerHTML = '';
    texts.forEach((s, i) => {
      const r = row(i);
      App.$('input', r).value = s;
      count(r);
      list.append(r);
    });
    filter();
    App.fillTexts?.(texts);
  }

  function filter() {
    const all = App.$('#text-show-all').checked;
    App.$$('#text-list .text-row').forEach((r, i) => {
      r.hidden = !all && !texts[i] && !App.$('input', r).value && i !== firstEmpty();
    });
  }
  const firstEmpty = () => texts.findIndex((s) => !s);

  // one read shared by this page and the key panels
  let reading = null;
  function fetchTexts() {
    reading ??= App.api('POST', '/api/texts')
      .then((r) => { texts = r.texts; max = r.max; return texts; })
      .finally(() => { reading = null; });
    return reading;
  }

  async function load() {
    if (loading) return;
    loading = true;
    App.$('#text-status').textContent = 'Reading the texts from the keyboard…';
    try {
      await fetchTexts();
      App.$('#text-status').textContent = `${texts.filter(Boolean).length} of ${texts.length} slots in use.`;
      fill();
      tracker.clear();
      App.ui.showError(App.$('#text-panel'), null);
    } catch (e) {
      App.$('#text-status').textContent = '';
      App.ui.showError(App.$('#text-panel'), `Could not read the texts: ${e.message}`);
    } finally { loading = false; }
  }

  function init() {
    const { $ } = App;
    const panel = $('#text-panel');
    App.textTyping.mount($('#text-typing'), { instant: true });
    $('#text-show-all').dataset.nodirty = '1';
    $('#text-show-all').onchange = () => texts && filter();
    tracker = App.ui.track(panel, {
      async save() {
        const inputs = App.$$('#text-list input');
        for (const input of inputs) {
          const i = Number(input.dataset.index);
          if (input.value === texts[i]) continue;
          const r = await App.api('POST', '/api/text/set', { index: i, text: input.value });
          texts[i] = r.text;
        }
        fill();
        $('#text-status').textContent = `${texts.filter(Boolean).length} of ${texts.length} slots in use.`;
      },
      discard() { if (texts) fill(); },
    });
  }

  App.views.texts = {
    init,
    selection: () => {
      const reason = supported() ? null : App.ui.firmwareReason('Text keys');
      App.ui.gate(App.$('#text-panel'), reason);
      if (!reason && !texts) load();
    },
  };
  App.textList = () => texts;
  // for the key panels (keymap.js): edit one text in place
  App.texts = {
    supported,
    bytes,
    max: () => max,
    load: () => (texts ? Promise.resolve(texts) : fetchTexts()),
    async set(i, s) {
      const r = await App.api('POST', '/api/text/set', { index: i, text: s });
      texts[i] = r.text;
      if (App.$('#text-list').children.length && !tracker?.dirty) {
        fill();
        App.$('#text-status').textContent = `${texts.filter(Boolean).length} of ${texts.length} slots in use.`;
      }
      return r.text;
    },
  };
})();
