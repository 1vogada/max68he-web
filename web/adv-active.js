// "Active advanced keys" list on the Advanced keys page: every key with an extra
// function, click a row to select that key, × to make it a plain key again.
// The row helpers are plain functions so the tests can load this file in Node.
(() => {
  const LABEL = { snap: 'Snap tap', modtap: 'Mod-tap', toggle: 'Toggle', toggleRepeat: 'Toggle', dks: 'DKS' };

  // One row per key, except a snap tap pair (both keys point at each other) is one row:
  // clearing either key clears both, so listing them twice would only confuse.
  function activeRows(list) {
    const bySlot = new Map(list.map((a) => [a.slot, a]));
    return [...list].sort((a, b) => a.slot - b.slot).filter((a) => {
      if (a.kind !== 'snap') return true;
      const p = bySlot.get(a.partner);
      return !(p && p.kind === 'snap' && p.partner === a.slot && p.slot < a.slot);
    });
  }

  const shown = (keys) => (keys ?? []).filter((k) => k && k !== 'none');

  // short text for one row; name(slot) gives a key's label on the board
  function summary(a, name) {
    if (a.kind === 'snap') return `${name(a.slot)} ↔ ${name(a.partner)}`;
    if (a.kind === 'modtap') return `${name(a.slot)}: hold ${a.keys[0]}, tap ${a.keys[1]} (${a.holdMs} ms)`;
    if (a.kind === 'toggle' || a.kind === 'toggleRepeat') return `${name(a.slot)}: toggles ${a.keys[0]}${a.kind === 'toggleRepeat' ? ', repeating' : ''}`;
    if (a.levels) return `${name(a.slot)}: ${a.levels.length} level${a.levels.length === 1 ? '' : 's'}, ${shown(a.keys).join(', ') || 'no keys'}`;
    return `${name(a.slot)}: ${a.firstPointMm}–${a.secondPointMm} mm, ${shown(a.keys).join(', ') || 'no keys'}`;
  }

  const api = { activeRows, summary, LABEL };
  if (typeof module !== 'undefined') module.exports = api;
  if (typeof window === 'undefined') return;

  const App = (window.App = window.App || {});

  // el: the panel; list: advanced keys; hooks: { name, select, remove, selected }
  function render(el, list, { name, select, remove, selected }) {
    const rows = activeRows(list);
    el.querySelector('.aa-count').textContent = String(list.length);
    const ul = el.querySelector('.aa-list');
    ul.replaceChildren();
    el.querySelector('.aa-empty').hidden = rows.length > 0;
    for (const a of rows) {
      const li = document.createElement('li');
      li.className = 'aa-row';
      li.classList.toggle('on', selected === a.slot || (a.kind === 'snap' && selected === a.partner));
      const pick = Object.assign(document.createElement('button'), { type: 'button', className: 'aa-pick', title: 'Select this key on the board' });
      const kind = Object.assign(document.createElement('span'), { className: 'chip', textContent: LABEL[a.kind] ?? a.kind });
      const text = Object.assign(document.createElement('span'), { className: 'aa-text', textContent: summary(a, name) });
      pick.append(kind, text);
      pick.onclick = () => select(a.slot);
      const what = a.kind === 'snap' ? `snap tap on ${name(a.slot)} and ${name(a.partner)}` : `the ${LABEL[a.kind]} on ${name(a.slot)}`;
      const del = Object.assign(document.createElement('button'), { type: 'button', className: 'aa-del', textContent: '×', title: `Remove ${what}` });
      del.setAttribute('aria-label', `Remove ${what}`);
      del.onclick = () => { if (confirm(`Remove ${what}? The key${a.kind === 'snap' ? 's go' : ' goes'} back to typing normally.`)) remove(a.slot); };
      li.append(pick, del);
      ul.append(li);
    }
  }

  App.advActive = { render, activeRows, summary };
})();
