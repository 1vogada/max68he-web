// Mode flash (open-firmware options modeFlash, caps 'modeFlash'): per key action mode 1..3, an "on" switch +
// colour (3 flashes of the hold bar column when the mode turns on, default green) and an "off" switch + colour
// (1 flash when it turns off, default dim white). Shown in Firmware > Options (saved with that form's
// Save) and on the Key wizard's Modes tab (saved at once). Hidden on firmware without it (no caps bit, or
// options shorter than 44 bytes). Black can't be picked: the keyboard reads 0,0,0 as the default colour.
(() => {
  const App = (window.App = window.App || {});

  const DEF = { enterColor: [0, 255, 0], leaveColor: [64, 64, 64] };
  const views = [];   // { host, instant }
  let names = ['', '', ''];

  const supported = () => (App.st?.features ?? []).includes('modeFlash') && Boolean(App.st?.fwOptions?.modeFlash);
  const hex = (c) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  const rgb = (h) => { const v = parseInt(h.slice(1), 16); return [v >> 16, (v >> 8) & 0xff, v & 0xff]; };
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const label = (n) => (names[n - 1] ? `Mode ${n} · ${esc(names[n - 1])}` : `Mode ${n}`);

  function rows() {
    return [1, 2, 3].map((n) => `<div class="mf-row" data-mode="${n}">
      <span class="mf-name">${label(n)}</span>
      <label class="toggle" title="3 flashes when mode ${n} turns on"><input type="checkbox" data-mf="enter" aria-label="Mode ${n}: flash 3 times when it turns on"><span class="switch"></span> On</label>
      <input type="color" data-mf="enterColor" aria-label="Mode ${n}: colour when it turns on" title="Colour when it turns on (default green)">
      <label class="toggle" title="1 flash when mode ${n} turns off"><input type="checkbox" data-mf="leave" aria-label="Mode ${n}: flash once when it turns off"><span class="switch"></span> Off</label>
      <input type="color" data-mf="leaveColor" aria-label="Mode ${n}: colour when it turns off" title="Colour when it turns off (default dim white)">
    </div>`).join('');
  }

  // one row -> { mode, enter, enterColor, leave, leaveColor }; black is refused here, before anything is sent
  function rowValue(row) {
    const v = (k) => App.$(`[data-mf=${k}]`, row);
    const out = { mode: Number(row.dataset.mode), enter: v('enter').checked, leave: v('leave').checked };
    for (const k of ['enterColor', 'leaveColor']) {
      const c = rgb(v(k).value);
      if (!c.some(Boolean)) throw new Error(`Mode ${out.mode}: black can't flash (the keyboard reads it as the default colour). Pick another colour.`);
      out[k] = c;
    }
    return out;
  }
  // every row of a view -> the modeFlash change list (all 3 modes)
  const read = (host) => App.$$('.mf-row', host).map(rowValue);

  // instant: a change is written to the keyboard at once (only that mode); otherwise the host's form saves it
  function mount(host, { instant = false } = {}) {
    if (!host || views.some((x) => x.host === host)) return;
    host.classList.add('mode-flash');
    host.innerHTML = `<span class="mode-flash-title">Mode flash</span>
      <p class="muted small">Home, Del, PgUp, PgDn and Right flash 3 times when a mode turns on (On) and once when it turns off (Off), so you
        can see Fn + Ctrl + B (or any mode switch) worked. Off is dim white, not red: the Esc hold bar already flashes red.${instant
    ? ' A change here is saved to the keyboard at once (a firmware option, also in Firmware → Options).' : ''}</p>
      <div class="mf-rows">${rows()}</div>`;
    host.addEventListener('input', (e) => { if (e.target.type === 'checkbox') dim(e.target.closest('.mf-row')); });
    if (instant) {
      host.dataset.nodirty = '1';    // not part of the surrounding panel's save bar
      host.addEventListener('change', (e) => {
        const row = e.target.closest('.mf-row');
        if (!row) return;
        dim(row);
        App.busy(host, 'Saving…', async () => {
          try {
            const r = await App.api('POST', '/api/fw-options', { modeFlash: [rowValue(row)] });
            App.st.fwOptions = r.fwOptions;
            App.fillFirmware?.(r.fwOptions);
            App.toast('Saved to the keyboard');
          } finally { fill(App.st.fwOptions); }   // a refused change (black, older firmware) shows what the keyboard has
        });
      });
    }
    views.push({ host, instant });
    fill(App.st?.fwOptions);
  }

  // a switched-off flash: its colour is greyed out
  function dim(row) {
    for (const k of ['enter', 'leave']) App.$(`[data-mf=${k}Color]`, row).disabled = !App.$(`[data-mf=${k}]`, row).checked;
  }

  // from the keyboard's options (null on the stock firmware): every instance shows them
  function fill(o) {
    const ok = Boolean(o?.modeFlash) && supported();
    views.forEach(({ host }) => {
      host.hidden = !ok;
      if (!ok) return;
      for (const e of o.modeFlash) {
        const row = App.$(`.mf-row[data-mode="${e.mode}"]`, host);
        if (!row) continue;
        App.$('[data-mf=enter]', row).checked = e.enter !== false;
        App.$('[data-mf=leave]', row).checked = e.leave !== false;
        App.$('[data-mf=enterColor]', row).value = hex(e.enterColor ?? DEF.enterColor);
        App.$('[data-mf=leaveColor]', row).value = hex(e.leaveColor ?? DEF.leaveColor);
        dim(row);
      }
    });
  }

  // mode names (Key wizard > Modes) next to the numbers
  function setNames(list) {
    names = [0, 1, 2].map((i) => list?.[i] ?? '');
    views.forEach(({ host }) => App.$$('.mf-row', host).forEach((row) => { App.$('.mf-name', row).innerHTML = label(Number(row.dataset.mode)); }));
  }

  App.modeFlash = { mount, fill, read, supported, names: setNames };
})();
