// Shared UI building blocks for every page: save bars (one save pattern), the key
// picker, open-firmware notes, inline errors and the colour theme.
(() => {
  const App = (window.App = window.App || {});
  const q = (s, el = document) => el.querySelector(s);
  const ui = (App.ui = {});

  // ---- save bars -------------------------------------------------------------
  // A tracked panel keeps its edits on the page until Save. Discard puts back what the
  // keyboard has. Leaving the page or switching profile with unsaved edits asks first.

  const trackers = new Set();

  ui.track = (panel, { save, discard, saveLabel = 'Save', note = '' }) => {
    const bar = document.createElement('div');
    bar.className = 'savebar';
    bar.innerHTML = `<span class="savebar-state" aria-live="polite"><span class="dot"></span><span class="txt"></span></span>
      <span class="savebar-note muted small"></span>
      <button type="button" class="discard">Discard</button>
      <button type="button" class="primary save">${saveLabel}</button>`;
    panel.append(bar);
    const t = { panel, dirty: false, ready: true, why: '' };
    const sync = () => {
      panel.classList.toggle('is-dirty', t.dirty);
      q('.txt', bar).textContent = t.dirty ? 'Unsaved changes' : 'Matches the keyboard';
      q('.savebar-note', bar).textContent = t.dirty ? note : t.why;
      q('.save', bar).disabled = !t.dirty || !t.ready;
      q('.discard', bar).disabled = !t.dirty;
    };
    t.mark = () => { t.dirty = true; sync(); };
    t.clear = () => { t.dirty = false; sync(); };
    // ready = false: nothing to save to yet (no key selected); why says what to do
    t.setReady = (ready, why = '') => { t.ready = ready; t.why = ready ? '' : why; sync(); };
    t.discard = () => { discard?.(); t.clear(); };
    t.save = () => App.busy(panel, 'Saving…', async () => { await save(); t.clear(); App.toast('Saved to the keyboard'); });
    q('.save', bar).onclick = t.save;
    q('.discard', bar).onclick = t.discard;
    const touched = (e) => { if (!e.target.closest('[data-nodirty]') && e.target.closest('input, select, textarea')) t.mark(); };
    panel.addEventListener('input', touched);
    panel.addEventListener('change', touched);
    panel.addEventListener('submit', (e) => { e.preventDefault(); if (t.dirty && t.ready) t.save(); });
    trackers.add(t);
    sync();
    return t;
  };

  const shown = (el) => el.offsetParent !== null || getComputedStyle(el).position === 'fixed';

  // the visible title text of a panel (no chips, no text hidden on this page)
  function panelName(panel) {
    const h = q('h2', panel);
    if (!h) return 'this panel';
    let text = '';
    const walk = (n) => {
      if (n.nodeType === 3) { text += n.textContent; return; }
      if (n.nodeType !== 1 || n.classList.contains('chip') || (n !== h && !shown(n))) return;
      n.childNodes.forEach(walk);
    };
    walk(h);
    return text.replace(/\s+/g, ' ').trim() || 'this panel';
  }

  // true = go ahead (nothing unsaved, or the user chose to drop it)
  ui.confirmLeave = () => {
    const open = [...trackers].filter((t) => t.dirty && shown(t.panel));
    if (!open.length) return true;
    const names = open.map((t) => `"${panelName(t.panel)}"`).join(', ');
    if (!confirm(`You have unsaved changes in ${names}. Leave without saving them?`)) return false;
    open.forEach((t) => t.discard());
    return true;
  };

  // any panel with unsaved edits (pages that refresh on their own wait for these)
  ui.anyDirty = () => [...trackers].some((t) => t.dirty);

  window.addEventListener('beforeunload', (e) => {
    if ([...trackers].some((t) => t.dirty)) { e.preventDefault(); e.returnValue = ''; }
  });

  // ---- inline errors ------------------------------------------------------------

  ui.showError = (el, msg) => {
    const panel = el?.closest?.('.panel, .stage') ?? null;
    if (!panel) return;
    let box = q(':scope > .panel-error', panel);
    if (!msg) { box?.remove(); return; }
    if (!box) {
      box = document.createElement('div');
      box.className = 'panel-error';
      box.setAttribute('role', 'alert');
      box.innerHTML = '<span class="msg"></span><button type="button" class="icon" title="Dismiss">×</button>';
      q('button', box).onclick = () => box.remove();
      const bar = q(':scope > .savebar', panel);
      if (bar) bar.before(box); else panel.append(box);
    }
    q('.msg', box).textContent = msg;
  };

  // ---- open-firmware notes --------------------------------------------------------
  // reason = null: available. Otherwise the controls inside el are disabled and a short
  // sentence says why.

  ui.gate = (el, reason) => {
    let note = q(':scope > .gate', el);
    el.classList.toggle('gated', Boolean(reason));
    el.querySelectorAll('input, select, textarea, button').forEach((c) => {
      if (c.closest('.gate')) return;
      if (reason) { if (!c.disabled) { c.disabled = true; c.dataset.gated = '1'; } } else if (c.dataset.gated) { c.disabled = false; delete c.dataset.gated; }
    });
    if (!reason) { note?.remove(); return; }
    if (!note) {
      note = document.createElement('p');
      note.className = 'gate';
      const head = q(':scope > h2', el);
      if (head) head.after(note); else el.prepend(note);
    }
    note.textContent = reason;
  };

  ui.firmwareReason = (need) => {
    const info = App.st.info;
    if (!info) return 'Connect the keyboard first.';
    if (info.model && info.model !== 'max68he') return `${need}: only on the MAX68HE with the open firmware. The ${info.modelName} runs its stock firmware.`;
    if (!info.custom) return `${need}: only with the open firmware. This keyboard runs the stock firmware ${App.fwText?.() ?? ''}.`;
    return `${need}: not in the open firmware build on this keyboard yet. Flash the latest build to use it.`;
  };

  // ---- key picker -------------------------------------------------------------------

  const MODS = [['Ctrl', 'LCtrl'], ['Shift', 'LShift'], ['Alt', 'LAlt'], ['Win', 'LWin']];
  const NAV = ['Esc', 'Enter', 'Bksp', 'Tab', 'Space', 'Caps', 'Ins', 'Del', 'Home', 'End', 'PgUp', 'PgDn',
    'Up', 'Down', 'Left', 'Right', 'PrtSc', 'ScrLk', 'Pause', 'Menu', 'NumLock'];
  const SYMBOLS = ['-', '=', '[', ']', '\\', ';', "'", '`', ',', '.', '/', 'ISO\\'];
  const MODIFIERS = ['LCtrl', 'LShift', 'LAlt', 'LWin', 'RCtrl', 'RShift', 'RAlt', 'RWin'];

  function categories(only) {
    const fns = App.st.functions ?? [];
    const custom = Boolean(App.st.info?.custom);
    const pick = (re) => fns.filter((n) => re.test(n));
    const cats = [
      ['Letters', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')],
      ['Numbers', '1234567890'.split('')],
      ['F-keys', Array.from({ length: 24 }, (_, i) => `F${i + 1}`)],
      ['Navigation', NAV],
      ['Symbols', SYMBOLS],
      ['Modifiers', MODIFIERS],
    ];
    if (only !== 'keyboard') {
      cats.push(
        ['Media', pick(/^(Volume|Mute|Play|Next|Prev|Stop|Media|Calculator|Mail|MyComputer|Search|Browser|Screen|System|Lock|ShowDesktop)/)],
        ['Mouse', pick(/^Mouse/)],
        ['Layers', [...pick(/^Fn$/), ...(custom && App.prefs?.get('layers') ? pick(/^(MO|TG)\d/) : [])]],   // MO/TG: Interface > Extra layers
        ['Macros', Array.from({ length: 16 }, (_, i) => `Macro${i}`)],
        ...((App.st.features ?? []).includes('textKeys') ? [['Text', Array.from({ length: 64 }, (_, i) => `Text${i}`)]] : []),
        ['Keyboard', [...pick(/^(Profile|Led)/), ...(custom ? pick(/^Fw/) : []), 'Disabled']],
      );
    }
    return cats.filter(([, keys]) => keys.length);
  }

  let pop = null;
  let popInput = null;
  let choosing = false;
  function closePicker() { pop?.remove(); pop = null; popInput = null; document.removeEventListener('pointerdown', outside, true); }
  function outside(e) {
    if (pop && !pop.contains(e.target) && !e.target.closest('.kp-btn') && e.target !== popInput) closePicker();
  }

  // best matches first: exact name, then names starting with it, then names containing it
  function rank(names, term) {
    const s = term.toLowerCase();
    const score = (n) => { const l = n.toLowerCase(); return l === s ? 0 : l.startsWith(s) ? 1 : s.length > 1 && l.includes(s) ? 2 : 9; };
    return names.filter((n) => score(n) < 9).sort((x, y) => score(x) - score(y) || x.length - y.length).slice(0, 60);
  }

  // typed = opened by typing in the key field itself: that field is the search box
  function openPicker(input, only, typed = false) {
    closePicker();
    const cats = categories(only);
    const all = [...new Set(cats.flatMap(([, keys]) => keys))];
    pop = document.createElement('div');
    pop.className = 'kp-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Pick a key');
    popInput = input;
    const mods = new Set();
    pop.innerHTML = `<div class="kp-top"${typed ? ' hidden' : ''}>
        <input type="search" class="kp-search" placeholder="Search keys…" aria-label="Search keys" data-nodirty>
        <button type="button" class="icon kp-close" title="Close">×</button></div>
      <div class="kp-mods"><span class="muted small">Hold with</span>${MODS.map(([l]) => `<button type="button" data-mod="${l}">${l}</button>`).join('')}</div>
      <div class="kp-tabs seg-tabs">${cats.map(([c], i) => `<button type="button" data-cat="${i}">${c}</button>`).join('')}</div>
      <div class="kp-grid"></div>
      <p class="muted small kp-help"></p>`;
    const grid = q('.kp-grid', pop);
    const help = q('.kp-help', pop);
    let cat = 0;
    let prefix = '';                     // "Ctrl+Shift" typed before the key name
    const show = (names, note = '') => {
      grid.innerHTML = '';
      names.forEach((n, i) => {
        const b = Object.assign(document.createElement('button'), { type: 'button', textContent: n });
        if (typed && i === 0) b.classList.add('top');
        b.onclick = () => choose(n);
        grid.append(b);
      });
      if (!names.length) grid.innerHTML = '<p class="muted small">No key with that name. Save takes what you typed as it is.</p>';
      help.textContent = note;
    };
    const showCat = (i) => {
      cat = i;
      pop.querySelectorAll('[data-cat]').forEach((b) => b.classList.toggle('on', Number(b.dataset.cat) === i));
      show(cats[i][1], cats[i][0] === 'Macros' ? 'Plays the macro once per press. Type :hold or :toggle after it for other modes.'
        : cats[i][0] === 'Text' ? 'Types that string when pressed. Write it in the box under the key field.' : '');
      if (cats[i][0] === 'Text') {
        const t = App.textList?.();
        grid.querySelectorAll('button').forEach((b, k) => { b.title = t?.[k] ? `types “${t[k]}”` : 'empty: write it after picking'; if (t && !t[k]) b.classList.add('dim'); });
      }
    };
    const filter = (text) => {
      const parts = String(text).split('+');
      const term = parts.pop().trim();
      prefix = parts.map((p) => p.trim()).filter(Boolean).join('+');
      if (!term) { if (prefix) show([], `Combination: ${prefix} + the key you pick.`); else showCat(cat); return; }
      pop.querySelectorAll('[data-cat]').forEach((b) => b.classList.remove('on'));
      show(rank(all, term), prefix ? `Combination: ${prefix} + the key you pick.` : 'Enter takes the first one; Esc closes.');
    };
    const choose = (name) => {
      const keyboardKey = cats.slice(0, 6).some(([, keys]) => keys.includes(name));
      const held = [...(prefix ? [prefix] : []), ...mods];
      input.value = held.length && keyboardKey && !MODIFIERS.includes(name) ? `${held.join('+')}+${name}` : name;
      choosing = true;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      choosing = false;
      closePicker();
      input.focus();
    };
    pop.filter = filter;
    pop.pickTop = () => { const b = q('button', grid); if (b) b.click(); return Boolean(b); };
    pop.querySelectorAll('[data-cat]').forEach((b) => { b.onclick = () => showCat(Number(b.dataset.cat)); });
    pop.querySelectorAll('[data-mod]').forEach((b) => {
      b.onclick = () => {
        const m = b.dataset.mod;
        if (mods.has(m)) mods.delete(m); else mods.add(m);
        b.classList.toggle('on', mods.has(m));
      };
    });
    q('.kp-close', pop).onclick = closePicker;
    const search = q('.kp-search', pop);
    search.oninput = () => {
      const s = search.value.trim().toLowerCase();
      if (!s) { showCat(cat); return; }
      show([...new Set(cats.flatMap(([, keys]) => keys))].filter((n) => n.toLowerCase().includes(s)).slice(0, 60));
    };
    search.onkeydown = (e) => {
      if (e.key === 'Escape') closePicker();
      if (e.key === 'Enter') { e.preventDefault(); q('button', grid)?.click(); }
    };
    document.body.append(pop);
    const r = input.getBoundingClientRect();
    const w = Math.min(420, window.innerWidth - 24);
    pop.style.width = `${w}px`;
    pop.style.left = `${Math.max(12, Math.min(r.left, window.innerWidth - w - 12))}px`;
    pop.style.top = `${r.bottom + window.scrollY + 6}px`;
    if (typed) filter(input.value); else { showCat(0); search.focus(); }
    document.addEventListener('pointerdown', outside, true);
  }

  // Adds a "Pick" button to a key input; typing in the input shows the same picker, filtered.
  // only: 'keyboard' (letters, modifiers…) or 'all'.
  ui.keyPicker = (input, { only = 'all' } = {}) => {
    if (input.dataset.picker) return;
    input.dataset.picker = only;
    input.removeAttribute('list');                  // the browser's own suggestion list is replaced by the picker
    input.autocomplete = 'off';
    const wrap = document.createElement('span');
    wrap.className = 'kp-wrap';
    input.replaceWith(wrap);
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'kp-btn', textContent: 'Pick…' });
    b.setAttribute('aria-label', 'Pick a key from a list');
    b.onclick = () => (pop && popInput === input ? closePicker() : openPicker(input, only));
    input.addEventListener('input', () => {
      if (choosing) return;
      if (!input.value.trim()) { if (popInput === input) closePicker(); return; }
      if (popInput === input && pop?.filter) pop.filter(input.value); else openPicker(input, only, true);
    });
    input.addEventListener('keydown', (e) => {
      if (popInput !== input) return;
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); pop.pickTop(); }
      if (e.key === 'Escape') closePicker();
    });
    wrap.append(input, b);
  };
  ui.closePicker = closePicker;
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePicker(); });

  // ---- theme ---------------------------------------------------------------------------

  const THEME_KEY = 'max68he.theme';
  ui.theme = () => { try { return localStorage.getItem(THEME_KEY) || 'system'; } catch { return 'system'; } };
  ui.setTheme = (t) => {
    try { localStorage.setItem(THEME_KEY, t); } catch { /* storage off */ }
    if (t === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
    window.dispatchEvent(new Event('themechange'));
  };
  ui.setTheme(ui.theme());
  // CSS colour token as a string (for canvas drawing)
  ui.token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
})();
