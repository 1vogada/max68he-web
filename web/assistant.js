// Assistant page (DeepSeek driving the MCP tools, src/assistant.js) and Settings > AI assistant
// (the key: saved on the PC, shown only as "set (sk-…abcd)"). Writes wait for a Confirm click here.
(() => {
  const App = (window.App = window.App || {});
  App.views = App.views || {};
  const $ = (s, r = document) => r.querySelector(s);
  const NO_KEY = 'No DeepSeek API key yet: add one in Settings > AI assistant.';

  const el = (tag, cls, text) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, text != null ? { textContent: text } : {});
  const short = (o) => { const t = JSON.stringify(o); return t.length > 160 ? `${t.slice(0, 160)}…` : t; };

  const panel = el('section', 'panel wide as-panel');
  panel.dataset.views = 'assistant';
  panel.innerHTML = `<h2>Assistant</h2>
    <p class="muted small" id="as-note" hidden></p>
    <div id="as-log" class="as-log" aria-live="polite"></div>
    <form id="as-form" class="as-form" autocomplete="off">
      <textarea name="message" rows="2" maxlength="4000" placeholder="e.g. make a Tilde mode: Fn + Ctrl + B toggles it, Esc types \` in it"></textarea>
      <div class="row-buttons"><button type="submit">Send</button><button type="button" id="as-reset">New chat</button></div>
    </form>`;

  let status = null;

  // a kbcode script the assistant wrote: shown, with a button that puts it in the Key wizard's Code tab
  function script(code) {
    const box = el('div', 'as-code');
    const open = el('button', '', 'Open in Code tab');
    open.type = 'button';
    open.onclick = async () => {
      App.goto('wizard');
      document.querySelector('#kw-style [data-kw="code"]')?.click();
      try { await App.kbCode.open(code); } catch (err) { App.toast?.(err.message); }
    };
    box.append(el('pre', '', code), open);
    return box;
  }

  function show(e) {
    const log = $('#as-log');
    if (e.type === 'user' || e.type === 'assistant' || e.type === 'error') {
      log.append(el('div', `as-msg as-${e.type}`, e.text));
    } else if (e.type === 'tool') {
      const d = el('details', `as-tool${e.ok ? '' : ' as-bad'}`);
      const { code, ...rest } = e.args ?? {};
      d.append(el('summary', '', `${e.ok ? '⚙' : '✕'} ${e.name} ${short(e.code ? rest : e.args)}`), el('pre', '', e.result));
      log.append(...(e.code ? [script(e.code)] : []), d);
    } else if (e.type === 'pending') {
      const c = el('div', 'as-pending');
      c.append(el('p', '', e.code ? 'Apply this script to the keyboard? Its dry run:' : `Change the keyboard: ${e.name}`));
      if (e.code) c.append(script(e.code));
      c.append(el('pre', '', e.preview ?? JSON.stringify(e.args, null, 2)));
      const row = el('div', 'row-buttons');
      const yes = el('button', '', 'Confirm'), no = el('button', '', 'Cancel');
      yes.type = no.type = 'button';
      yes.onclick = () => { row.remove(); send('/api/assistant/confirm', { id: e.id, ok: true }); };
      no.onclick = () => { row.remove(); send('/api/assistant/confirm', { id: e.id, ok: false }); };
      row.append(yes, no);
      c.append(row);
      log.append(c);
    }
    log.scrollTop = log.scrollHeight;
  }

  async function send(url, body) {
    const f = $('#as-form');
    f.elements.message.disabled = true;
    const wait = el('div', 'as-msg as-wait', '…');
    $('#as-log').append(wait);
    try {
      (await App.api('POST', url, body)).events.forEach(show);
    } catch (err) {
      show({ type: 'error', text: err.message });
    } finally {
      wait.remove();
      f.elements.message.disabled = false;
      f.elements.message.focus();
    }
  }

  function showKey(k) {
    const s = $('#ai-key-status');
    if (s) s.textContent = k?.set ? `Key set (${k.masked}).` : 'No key saved.';
    const note = $('#as-note');
    const off = status?.web ? status.reason : (k?.set ? '' : NO_KEY);
    note.hidden = !off;
    note.textContent = off;
    $('#as-form').hidden = Boolean(off);
  }

  async function refresh() {
    try {
      status = await App.api('GET', '/api/assistant');
      showKey(status.key);
    } catch (err) { $('#as-note').hidden = false; $('#as-note').textContent = err.message; }
  }

  function init() {
    App.addView({ id: 'assistant', label: 'Assistant', icon: '✧', after: 'stats', board: false,
      hint: 'Ask DeepSeek to set up the keyboard. It uses the same tools as the MCP server; every change waits for your Confirm.' });
    $('.panels').append(panel);
    $('#as-form').onsubmit = (ev) => {
      ev.preventDefault();
      const m = ev.target.elements.message;
      const text = m.value.trim();
      if (!text) return;
      m.value = '';
      show({ type: 'user', text });
      send('/api/assistant/chat', { message: text });
    };
    $('#as-form').elements.message.onkeydown = (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); $('#as-form').requestSubmit(); }
    };
    $('#as-reset').onclick = async () => {
      try { await App.api('POST', '/api/assistant/reset'); $('#as-log').replaceChildren(); } catch (err) { show({ type: 'error', text: err.message }); }
    };
    const kf = $('#ai-key-form');
    kf.onsubmit = async (ev) => {
      ev.preventDefault();
      try {
        showKey(await App.api('POST', '/api/assistant/key', { key: kf.elements.key.value.trim() }));
        App.toast?.('DeepSeek key saved');
      } catch (err) { $('#ai-key-status').textContent = err.message; }
      kf.elements.key.value = '';
    };
    $('#ai-key-clear').onclick = async () => {
      try { showKey(await App.api('DELETE', '/api/assistant/key')); } catch (err) { $('#ai-key-status').textContent = err.message; }
    };
    refresh();
  }

  window.addEventListener('pagechange', () => { if (['assistant', 'settings'].includes(App.st?.view)) refresh(); });
  App.views.assistantPage = { init };
})();
