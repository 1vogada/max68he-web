// Key wizard > Blocks / Modes: the panels around the Blockly workspace (web/key-blocks.js):
// the modes list (make, rename, delete, open a mode's key bindings), the plain-sentence summary
// of everything the blocks do, and how many of a key's 6 rule slots its blocks use.
(() => {
  const App = (window.App = window.App || {});
  const K = () => App.keyBlocksCore;
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let bound = null;                               // the api of key-blocks.js, for the list's buttons

  // "Make a mode", like Scratch's "Make a variable": the first unused of the 3 gets the name
  function makeMode(api) {
    const free = api.modes.find((m) => !m.name);
    if (!free) { App.toast('All 3 modes are in use: rename or delete one on the Modes tab', true); return; }
    const name = prompt('Name of the new mode (for example: Mouse)', '')?.trim();
    if (!name) return;
    if (api.modes.some((m) => m.name.toLowerCase() === name.toLowerCase())) { App.toast(`There is already a mode called ${name}`, true); return; }
    free.name = name.slice(0, 16);
    api.modesChanged();
    App.toast(`Mode ${free.name} made: its blocks are in the Modes category`);
  }

  function focusRename() {
    App.keyBlocksTabs?.show('modes');
    setTimeout(() => App.$('#kb-modes-list input')?.focus(), 50);
  }

  function drawModes(S, api) {
    bound = api;
    const box = App.$('#kb-modes-list');
    if (!box) return;
    box.innerHTML = S.modes.map((m) => {
      const n = api.countBlocksOfMode?.(m.id) ?? 0;
      return `<div class="kb-mode${m.name ? '' : ' unused'}" data-mode="${m.id}">
        <span class="kb-mode-id">Mode ${m.id}</span>
        <input value="${esc(m.name)}" maxlength="16" placeholder="unused" aria-label="Name of mode ${m.id}" data-act="name">
        <span class="chip${m.active ? ' on' : ''}" title="Read from the keyboard every few seconds">${m.active ? 'on now' : 'off'}</span>
        <span class="muted small">${n} block${n === 1 ? '' : 's'} · layer ${m.id}</span>
        <span class="row-buttons">
          <button type="button" data-act="layer" title="The keys this mode remaps, on Remap's layer row (Layer ${m.id})">Key bindings</button>
          ${m.name ? '<button type="button" data-act="delete">Delete</button>' : ''}
        </span></div>`;
    }).join('');
  }

  function onModes(e) {
    const row = e.target.closest('[data-mode]');
    if (!row || !bound) return;
    const m = bound.modes.find((x) => x.id === Number(row.dataset.mode));
    const act = e.target.dataset.act;
    if (e.type === 'change' && act === 'name') {
      const name = e.target.value.trim().slice(0, 16);
      if (name && bound.modes.some((x) => x !== m && x.name.toLowerCase() === name.toLowerCase())) {
        App.toast(`There is already a mode called ${name}`, true); e.target.value = m.name; return;
      }
      if (!name && bound.countBlocksOfMode(m.id) && !confirm(`Clearing the name deletes mode ${m.id}'s ${bound.countBlocksOfMode(m.id)} block(s). Go on?`)) { e.target.value = m.name; return; }
      if (!name) bound.removeBlocksOfMode(m.id);
      m.name = name;
      bound.modesChanged();
    }
    if (e.type === 'click' && act === 'delete') {
      const n = bound.countBlocksOfMode(m.id);
      if (!confirm(`Delete mode ${m.name}${n ? ` and its ${n} block${n === 1 ? '' : 's'}` : ''}? Nothing changes on the keyboard until you save.`)) return;
      bound.removeBlocksOfMode(m.id);
      m.name = '';
      bound.modesChanged();
    }
    if (e.type === 'click' && act === 'layer') bound.openLayer(m.id);
  }

  // what the blocks do, in plain sentences, grouped per mode (key-blocks-core.js summary)
  function drawSummary(S) {
    const box = App.$('#kb-summary-body');
    if (!box) return;
    const groups = S.compiled ? K().summary(S.compiled.blocks, S.modes) : [];
    box.innerHTML = groups.length
      ? groups.map((g) => `<h3 class="small">${esc(g.head)}</h3><ul>${g.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`).join('')
      : '<p class="muted small">Nothing yet: drag a "when" block in from Events.</p>';
  }

  // each key has 6 rule slots on the keyboard; mouse keys take 2 (3 with speed by pressure)
  function drawSlots(S) {
    const box = App.$('#kb-slots');
    if (!box) return;
    const use = S.compiled ? [...K().slotUse(S.compiled.blocks)] : [];
    box.innerHTML = use.length
      ? use.map(([key, n]) => `<span class="chip${n > K().MAX_RULES ? ' kb-over' : ''}" title="rule slots this key's blocks use">${esc(K().keyName(key))} ${n}/${K().MAX_RULES}</span>`).join(' ')
      : '';
  }

  // loaded on demand (after the page's init), so key-blocks.js binds the list's events to onModes
  App.kbPanels = { makeMode, focusRename, drawModes, drawSummary, drawSlots, onModes };
})();
