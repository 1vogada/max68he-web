// Gamepad tester: what the PC really receives, read with the browser's Gamepad API (the
// keyboard's on-board gamepad, or any other controller). Runs only while its tab is open.
(() => {
  const App = (window.App = window.App || {});
  let raf = 0, pick = null;

  const pads = () => [...(navigator.getGamepads?.() ?? [])].filter(Boolean);
  // the keyboard's gamepad first (its name carries the USB ids 3151 / 502d)
  const ours = (p) => /3151|502d|x68|max68/i.test(p.id);

  function frame() {
    raf = requestAnimationFrame(frame);
    const list = pads();
    const p = list.find((x) => x.index === pick) ?? list.find(ours) ?? list[0];
    const body = App.$('#gpt-body');
    App.$('#gpt-note').hidden = Boolean(p);
    if (!p) { App.$('#gpt-name').textContent = 'no controller'; body.innerHTML = ''; return; }
    pick = p.index;
    App.$('#gpt-name').textContent = ours(p) ? 'this keyboard' : 'another controller';
    if (!body.firstChild || body.dataset.pad !== p.id) {
      body.dataset.pad = p.id;
      body.innerHTML = `<p class="small muted">${App.ui.escape?.(p.id) ?? p.id.replace(/</g, '&lt;')}${list.length > 1
        ? ` <button type="button" class="gpt-next">Next controller (${list.length})</button>` : ''}</p>
        <div class="gpt-axes">${p.axes.map((_, i) => `<div class="gpt-axis"><span>Axis ${i} <b data-v></b></span><div class="gpt-bar"><i></i></div></div>`).join('')}</div>
        <div class="gpt-buttons">${p.buttons.map((_, i) => `<span>${i}</span>`).join('')}</div>`;
      const next = App.$('.gpt-next', body);
      if (next) next.onclick = () => { const i = list.indexOf(p); pick = list[(i + 1) % list.length].index; };
    }
    App.$$('.gpt-axis', body).forEach((el, i) => {
      const v = p.axes[i] ?? 0;
      App.$('[data-v]', el).textContent = v.toFixed(3);
      const bar = App.$('i', el);
      bar.style.left = `${50 + Math.min(v, 0) * 50}%`;
      bar.style.width = `${Math.abs(v) * 50}%`;
    });
    App.$$('.gpt-buttons span', body).forEach((el, i) => {
      const b = p.buttons[i];
      el.classList.toggle('lit', Boolean(b?.pressed || b?.value > 0.05));
      el.title = b ? `button ${i}: ${b.value.toFixed(2)}` : '';
    });
  }

  App.gpTester = {
    start() { if (!raf) frame(); },
    stop() { cancelAnimationFrame(raf); raf = 0; },
  };
})();
