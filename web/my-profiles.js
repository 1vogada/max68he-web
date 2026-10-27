// My profiles (like Wootility's): the 4 onboard profiles with names and colours, a library of
// saved profiles to load into any slot, swapping two slots, and profiles that switch with the
// app in front (rules, run by the web server: profile-routes.js).
(() => {
  const App = (window.App = window.App || {});
  App.views = App.views || {};
  let info = null;                              // GET /api/profiles
  let poll = 0;

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const when = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
  const slotOptions = (sel) => [0, 1, 2, 3].map((p) => `<option value="${p}"${p === sel ? ' selected' : ''}>${p + 1}: ${esc(info.onboard[p].name)}</option>`).join('');

  async function load() {
    info = await App.api('GET', '/api/profiles');
    App.profileMeta = info;
    App.drawProfiles?.();                       // the top bar shows the names
    draw();
    watchSwitches();
  }

  function draw() {
    if (App.st.view !== 'profiles' || !info) return;
    drawOnboard();
    drawLibrary();
    drawApps();
  }

  function drawOnboard() {
    const { st } = App;
    App.$('#profiles-panel').innerHTML = `<h2>Onboard profiles <span class="chip">4 on the keyboard</span></h2>
      <p class="muted small">Each has its own keys, Fn layers, advanced keys, switch settings and lighting. Names and colours stay on this PC.</p>
      <div class="quick-grid">${[0, 1, 2, 3].map((p) => {
        const o = info.onboard[p], on = p === st.profile;
        return `<div class="quick-card profile-card${on ? ' on' : ''}" data-slot="${p}">
          <h3><span class="row"><input type="color" value="${o.color}" data-act="color" aria-label="Colour of profile ${p + 1}">
            <input class="profile-name" value="${esc(o.name)}" maxlength="40" data-act="name" aria-label="Name of profile ${p + 1}"></span>
            ${on ? '<span class="chip">active</span>' : ''}</h3>
          <div class="row-buttons">
            ${on ? '<button type="button" data-act="save" class="primary">Save to library</button>' : '<button type="button" data-act="activate">Make active</button>'}
            <select data-act="swap" aria-label="Swap profile ${p + 1} with"><option value="">Swap with…</option>${[0, 1, 2, 3].filter((q) => q !== p)
              .map((q) => `<option value="${q}">${q + 1}: ${esc(info.onboard[q].name)}</option>`).join('')}</select>
          </div></div>`;
      }).join('')}</div>`;
  }

  function drawLibrary() {
    const box = App.$('#library-panel');
    box.innerHTML = `<h2>Saved profiles <span class="chip">${info.library.length} on this PC</span></h2>
      <p class="muted small">As many as you like. Load one into any onboard profile; what was there is backed up to config/backups first.</p>
      ${info.library.length ? `<div class="library">${info.library.map((e) => `<div class="library-row" data-id="${e.id}">
        <span class="dot" style="background:${e.color}"></span>
        <span><b>${esc(e.name)}</b><span class="muted small"> · saved ${when(e.savedAt)}${e.from !== null && e.from !== undefined ? ` from profile ${e.from + 1}` : ''}</span></span>
        <span class="row-buttons"><select data-act="slot" aria-label="Load into">${slotOptions(App.st.profile)}</select>
          <button type="button" data-act="load">Load</button><button type="button" data-act="rename">Rename</button>
          <button type="button" data-act="delete">Delete</button></span></div>`).join('')}</div>`
        : '<p class="muted">Nothing saved yet: "Save to library" on the active profile keeps a copy here.</p>'}`;
  }

  function drawApps() {
    const box = App.$('#apps-panel');
    const apps = [...new Set([...info.rules.map((r) => r.app), ...(info.seenApps ?? [])])];
    box.innerHTML = `<h2>Linked with an application <span class="chip">${info.rules.length} rule${info.rules.length === 1 ? '' : 's'}</span></h2>
      <label class="toggle"><input type="checkbox" data-act="auto"${info.autoSwitch ? ' checked' : ''}><span class="switch"></span>
        Switch profiles with the app in front</label>
      <p class="muted small">${info.watching ? `Watching. In front now: <b>${esc(info.frontApp ?? '…')}</b>${info.lastAuto ? `; last switch: ${esc(info.lastAuto.app)} → profile ${info.lastAuto.profile + 1}` : ''}.`
        : info.watchError ? `Not watching: ${esc(info.watchError)}` : 'Runs while this page\'s server runs (npm run web), like Wootility\'s background service. Windows only.'}</p>
      <div class="rules">${info.rules.map((r, i) => `<div class="rule-row" data-i="${i}"><input value="${esc(r.app)}" data-act="app" list="seen-apps" aria-label="App">
        <span class="muted">→</span><select data-act="profile">${slotOptions(r.profile)}</select>
        <button type="button" data-act="remove" aria-label="Remove this rule">×</button></div>`).join('')}</div>
      <datalist id="seen-apps">${apps.map((a) => `<option value="${esc(a)}">`).join('')}</datalist>
      <div class="row-buttons"><button type="button" data-act="add">Add an app</button>
        <label class="row">Other apps <select data-act="default"><option value="">keep the profile</option>${[0, 1, 2, 3].map((p) =>
          `<option value="${p}"${p === info.defaultProfile ? ' selected' : ''}>profile ${p + 1}: ${esc(info.onboard[p].name)}</option>`).join('')}</select></label></div>
      <p class="muted small">App names are the program's name without .exe (cs2, valorant, notepad). Apps you switch to while watching show up in the list.</p>`;
  }

  // ---- actions --------------------------------------------------------------------

  const busy = (el, msg, fn) => App.busy(el, msg, async () => { await fn(); await load(); });

  function onOnboard(e) {
    const card = e.target.closest('[data-slot]');
    if (!card) return;
    const p = Number(card.dataset.slot), act = e.target.dataset.act;
    if (e.type === 'click' && act === 'activate') App.$$('#profiles button')[p]?.click();
    if (e.type === 'click' && act === 'save') {
      busy(card, 'Reading the whole profile…', async () => {
        await App.api('POST', '/api/profiles/save', {});
        App.toast(`${info.onboard[p].name} saved to the library`);
      });
    }
    if (e.type === 'change' && (act === 'name' || act === 'color')) {
      App.api('POST', '/api/profiles/onboard', { profile: p, [act]: e.target.value }).then(load, (err) => { App.toast(err.message, true); load(); });
    }
    if (e.type === 'change' && act === 'swap' && e.target.value !== '') {
      const q = Number(e.target.value);
      if (!confirm(`Swap profile ${p + 1} (${info.onboard[p].name}) and profile ${q + 1} (${info.onboard[q].name})? Both are rewritten; this takes a minute or two.`)) { e.target.value = ''; return; }
      busy(App.$('#profiles-panel'), 'Swapping the two profiles… (a minute or two)', async () => {
        const r = await App.api('POST', '/api/profiles/swap', { a: p, b: q });
        App.applyState(r.state);
        App.toast(`Profiles ${p + 1} and ${q + 1} swapped`);
      });
    }
  }

  function onLibrary(e) {
    const row = e.target.closest('[data-id]');
    const act = e.target.dataset.act;
    if (!row || !act || act === 'slot') return;
    const entry = info.library.find((x) => x.id === row.dataset.id);
    if (act === 'load') {
      const p = Number(App.$('[data-act=slot]', row).value);
      if (!confirm(`Replace everything in profile ${p + 1} (${info.onboard[p].name}) with "${entry.name}"? What is there now is backed up to config/backups first.`)) return;
      busy(row, 'Loading the profile… (can take a minute)', async () => {
        const r = await App.api('POST', '/api/profiles/load', { id: entry.id, profile: p });
        App.applyState(r.state);
        App.toast(`"${entry.name}" is now profile ${p + 1}`);
      });
    }
    if (act === 'rename') {
      const name = prompt('New name', entry.name);
      if (name && name.trim() !== entry.name) busy(row, 'Renaming…', () => App.api('POST', '/api/profiles/update', { id: entry.id, name }));
    }
    if (act === 'delete' && confirm(`Delete the saved profile "${entry.name}" from this PC? The keyboard is not changed.`)) {
      busy(row, 'Deleting…', () => App.api('POST', '/api/profiles/delete', { id: entry.id }));
    }
  }

  // the rules as the page shows them now
  function readRules() {
    return App.$$('#apps-panel .rule-row').map((r) => ({ app: App.$('[data-act=app]', r).value, profile: Number(App.$('[data-act=profile]', r).value) }))
      .filter((r) => r.app.trim());
  }

  function saveRules(extra = {}) {
    App.api('POST', '/api/profiles/rules', { rules: readRules(), ...extra })
      .then(() => load(), (err) => { App.toast(err.message, true); load(); });
  }

  function onApps(e) {
    const act = e.target.dataset.act;
    if (e.type === 'click' && act === 'add') {      // a new row; it saves once it has a name
      const row = Object.assign(document.createElement('div'), { className: 'rule-row' });
      row.innerHTML = `<input data-act="app" list="seen-apps" placeholder="app name, e.g. cs2" aria-label="App">
        <span class="muted">→</span><select data-act="profile">${slotOptions(App.st.profile)}</select>
        <button type="button" data-act="remove" aria-label="Remove this rule">×</button>`;
      App.$('#apps-panel .rules').append(row);
      App.$('input', row).focus();
    }
    if (e.type === 'click' && act === 'remove') { e.target.closest('.rule-row').remove(); saveRules(); }
    if (e.type === 'change' && (act === 'app' || act === 'profile')) saveRules();
    if (e.type === 'change' && act === 'auto') saveRules({ autoSwitch: e.target.checked });
    if (e.type === 'change' && act === 'default') saveRules({ defaultProfile: e.target.value === '' ? null : Number(e.target.value) });
  }

  // while the rules may switch profiles, the page follows the keyboard (unless edits are open)
  function watchSwitches() {
    clearInterval(poll);
    if (!info?.watching) return;
    poll = setInterval(async () => {
      if (App.ui.anyDirty?.()) return;
      try {
        const r = await App.api('GET', '/api/profiles/active');
        if (r.active !== App.st.profile) {
          App.applyState(await App.api('GET', '/api/state'));
          App.toast(`Profile ${r.active + 1} (${info.onboard[r.active].name})${r.lastAuto ? ` for ${r.lastAuto.app}` : ''}`);
          if (App.st.view === 'profiles') load();
        }
      } catch { /* keyboard away: try again */ }
    }, 2000);
  }

  App.views.myProfiles = {
    init() {
      for (const [id, fn] of [['#profiles-panel', onOnboard], ['#library-panel', onLibrary], ['#apps-panel', onApps]]) {
        App.$(id).addEventListener('click', fn);
        App.$(id).addEventListener('change', fn);
      }
      window.addEventListener('pagechange', (e) => { if (e.detail === 'profiles') load().catch((err) => App.toast(err.message, true)); });
      window.addEventListener('statechange', draw);
      load().catch(() => { /* not connected yet: the page loads it when opened */ });
    },
  };
})();
