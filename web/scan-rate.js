// Header: the keyboard's real sensor scan rate and key passes, measured live
// (open firmware only), refreshed every 2 s while the page is visible.
(() => {
  const App = (window.App = window.App || {});
  const el = () => document.getElementById('scan-rate');
  const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

  async function tick() {
    const box = el();
    if (!box || document.visibilityState !== 'visible' || !App.st?.info?.custom) { if (box) box.hidden = true; return; }
    try {
      // plain fetch: a failed poll (e.g. while flashing) must not mark the board as disconnected
      const res = await fetch('/api/scan-rate', { method: 'POST' });
      if (!res.ok) throw new Error(res.statusText);
      const r = await res.json();
      if (r.scansPerSec === null) return;          // first sample: the rate needs two
      box.textContent = `· scan ${k(r.scansPerSec)}/s · ${k(r.passesPerSec)} passes/s`;
      box.hidden = false;
    } catch {
      box.hidden = true;                            // flashing, unplugged or an older firmware
    }
  }

  setInterval(tick, 2000);
})();
