// Stats page (open firmware): how often each key was pressed since power-up,
// as a heatmap on the board, plus totals, keys per minute and the top keys.
(() => {
  const App = (window.App = window.App || {});
  App.views = App.views || {};

  let data = null;          // { total, counts[128] }
  let timer = null;
  const history = [];       // [ms, total] for keys per minute

  function heat(v) {        // 0..1 -> blue .. red
    const h = 240 - 240 * v;
    return `hsl(${h} 85% 50%)`;
  }

  function paint(slot, el) {
    const n = data?.counts[slot] ?? 0;
    const max = Math.max(1, ...(data?.counts ?? [1]));
    App.$('.val', el).textContent = n ? String(n) : '';
    el.classList.toggle('sel', App.st.selected.has(slot));
    el.style.background = n ? `color-mix(in srgb, ${heat(n / max)} ${25 + 60 * (n / max)}%, var(--cap))` : 'var(--cap)';
    return true;
  }

  function render() {
    const { $ } = App;
    if (!data) return;
    $('#stats-total').textContent = data.total.toLocaleString();
    const now = Date.now();
    history.push([now, data.total]);
    while (history.length && now - history[0][0] > 60000) history.shift();
    const [t0, n0] = history[0];
    const mins = (now - t0) / 60000;
    $('#stats-kpm').textContent = mins > 0.05 ? Math.round((data.total - n0) / mins) : '…';
    const top = data.counts.map((n, slot) => ({ slot, n })).filter((x) => x.n).sort((a, b) => b.n - a.n).slice(0, 10);
    $('#stats-top').innerHTML = top.length
      ? top.map((x) => `<li><span>${App.keyEls.get(x.slot)?.dataset.name ?? `slot ${x.slot}`}</span><b>${x.n.toLocaleString()}</b></li>`).join('')
      : '<li class="muted">No presses yet: type something and watch the keys light up.</li>';
    if (App.st.view === 'stats') App.paintKeys();
  }

  async function poll() {
    try {
      data = await App.api('POST', '/api/stats');
      App.ui.showError(App.$('#stats-panel'), null);
      render();
    } catch (e) {
      App.ui.showError(App.$('#stats-panel'), `Could not read the counters: ${e.message} (trying again)`);
    }
  }

  function start() {
    const reason = App.pageReason('stats');
    App.ui.gate(App.$('#stats-panel'), reason);
    if (reason || timer) return;
    poll();
    timer = setInterval(poll, 2000);
  }
  function stop() { clearInterval(timer); timer = null; }

  function init() {
    const { $, api, toast } = App;
    $('#stats-reset').onclick = async () => {
      if (!confirm('Set every key counter back to 0?')) return;
      try {
        data = await api('POST', '/api/stats/reset');
        history.length = 0;
        render();
        toast('Counters reset');
      } catch (e) { toast(e.message, true); }
    };
    window.addEventListener('pagechange', (e) => { if (e.detail === 'stats') start(); else stop(); });
  }

  App.views.stats = { init, paint, keyDown: () => true, selection: () => {} };
})();
