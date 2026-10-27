// Recently used colours: a row of swatches under a colour picker (lighting effect
// colour, paint brush). Kept per browser in localStorage; the list helper is a plain
// function so the tests can load this file in Node.
(() => {
  const MAX = 8;

  // '#AbC123' or 'abc123' -> '#abc123'; anything else -> null
  function normHex(v) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(v ?? '').trim());
    return m ? `#${m[1].toLowerCase()}` : null;
  }

  // newest first, no duplicates, at most max
  function pushRecent(list, hex, max = MAX) {
    const clean = (list ?? []).map(normHex).filter(Boolean);
    const h = normHex(hex);
    return (h ? [h, ...clean.filter((x) => x !== h)] : clean).slice(0, max);
  }

  const api = { normHex, pushRecent, MAX };
  if (typeof module !== 'undefined') module.exports = api;
  if (typeof window === 'undefined') return;

  const App = (window.App = window.App || {});
  const storeKey = (name) => `max68he.recentColours.${name}`;
  const rows = new Map();   // name -> [render functions]

  function read(name) {
    try { return pushRecent(JSON.parse(localStorage.getItem(storeKey(name)) || '[]'), null); } catch { return []; }
  }

  function push(name, hex) {
    const list = pushRecent(read(name), hex);
    try { localStorage.setItem(storeKey(name), JSON.stringify(list)); } catch { /* storage off */ }
    (rows.get(name) ?? []).forEach((draw) => draw(list));
  }

  // Swatch row placed after `after`; a click sets `input` like a normal edit (input +
  // change events, so the panel's save bar and listeners react), then calls onPick.
  function mount(after, input, name, onPick) {
    const row = document.createElement('div');
    row.className = 'recent-colours';
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', 'Recently used colours');
    const draw = (list) => {
      row.hidden = !list.length;
      row.replaceChildren(Object.assign(document.createElement('span'), { className: 'muted small', textContent: 'Recent' }));
      for (const hex of list) {
        const b = Object.assign(document.createElement('button'), { type: 'button', className: 'swatch', title: hex });
        b.style.background = hex;
        b.setAttribute('aria-label', `Use colour ${hex}`);
        b.onclick = () => {
          if (input.value.toLowerCase() !== hex) {
            input.value = hex;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }
          onPick?.(hex);
        };
        row.append(b);
      }
    };
    after.after(row);
    rows.set(name, [...(rows.get(name) ?? []), draw]);
    draw(read(name));
    return row;
  }

  App.recentColours = { mount, push, read };
})();
