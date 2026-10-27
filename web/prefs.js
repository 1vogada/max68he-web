// UI preferences shared by every browser on this PC: the server keeps them in
// config/ui.json (/api/ui-prefs). If the server can't, this browser's storage stands in.
(() => {
  const App = (window.App = window.App || {});
  const KEY = 'max68he.prefs';
  const DEFAULTS = { marqueeEverywhere: false, layers: false, fnLayers: 1 };
  let prefs = { ...DEFAULTS };

  const local = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } };
  const keep = () => { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* storage off */ } };

  async function call(method, body) {
    const res = await fetch('/api/ui-prefs', { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body && JSON.stringify(body) });
    if (!res.ok) throw new Error(`ui-prefs ${res.status}`);
    return res.json();
  }

  const ready = call('GET').catch(() => local())
    .then((p) => { prefs = { ...DEFAULTS, ...p }; window.dispatchEvent(new Event('prefschange')); });

  App.prefs = {
    ready,
    get: (k) => prefs[k],
    async set(k, v) {
      prefs = { ...prefs, [k]: v };
      try { prefs = { ...DEFAULTS, ...(await call('POST', { [k]: v })) }; } catch { keep(); }
      window.dispatchEvent(new Event('prefschange'));
      return prefs[k];
    },
  };
})();
