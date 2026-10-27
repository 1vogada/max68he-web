// "Play a sequence" (Macros tab, open firmware caps 'sequence'): the keyboard plays a timed
// list of key / mouse input on its own clock. The text is parsed by the driver
// (src/sequence.js); while it plays the status is polled for the step counter. Under the text
// a plot shows where the pointer goes over time (move / glide steps).
(() => {
  const App = (window.App = window.App || {});
  App.views = App.views || {};

  const POLL_MS = 250;
  const ENDS = {
    done: 'Finished.', stopped: 'Stopped.', 'key pressed': 'Stopped: a key was pressed.',
    blocked: 'Stopped: game mode, calibration or the USB link got in the way.', cleared: 'Stopped.',
  };
  let timer = null;
  let gen = 0;                 // a poll answer from before Play / Stop is dropped

  const supported = () => (App.st?.features ?? []).includes('sequence');
  const panel = () => App.$('#seq-panel');

  function show(s) {
    const playing = Boolean(s?.playing);
    App.$('#seq-stop').disabled = !playing || !supported();
    App.$('#seq-play').textContent = playing ? 'Play again' : 'Play';
    panel().classList.toggle('seq-playing', playing);
    App.$('#seq-status').textContent = !s ? ''
      : playing ? `Playing step ${Math.min(s.step + 1, s.steps)} of ${s.steps}…`
        : ENDS[s.ended] ?? (s.steps ? `${s.steps} steps loaded.` : '');
  }

  function poll() {
    clearTimeout(timer);
    const g = gen;
    timer = setTimeout(async () => {
      if (App.st.view !== 'macros') return;           // the next visit reads it again
      try {
        const s = await App.api('GET', '/api/sequence/status');
        if (g !== gen) return;
        show(s);
        if (s.playing) poll();
      } catch (e) { App.$('#seq-status').textContent = e.message; }
    }, POLL_MS);
  }

  async function refresh() {
    if (!supported()) return show(null);
    try { const s = await App.api('GET', '/api/sequence/status'); show(s); if (s.playing) poll(); } catch { show(null); }
  }

  // ---- preview: where the pointer goes over time (x solid, y dashed), glides shaded ----------
  // The server parses the text (POST /api/sequence/preview, never touches the keyboard); the
  // curves are drawn here with the firmware's formulas (glide-core.js).
  const PREVIEW_MS = 200;
  const W = 320, H = 120, L = 36, R = 6, T = 8, B = 16;
  let previewTimer = null;
  let previewGen = 0;
  const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s` : `${ms} ms`);

  function plot(lengthMs, moves) {
    const G = App.glide;
    const ms = moves.map((m) => ({ ...m, f: m.curve ? G.glideCurve(m.curve, m.power, m.points) : null }));
    const span = Math.max(1, lengthMs);
    const times = new Set(Array.from({ length: 301 }, (_, i) => (span * i) / 300));
    for (const m of ms) {
      const end = m.start + (m.cut ?? m.duration);
      [m.start - 1e-3, m.start, end - 1e-3, end].forEach((t) => { if (t >= 0 && t <= span) times.add(t); });
    }
    const pts = [...times].sort((a, b) => a - b).map((t) => {
      let x = 0, y = 0;
      for (const m of ms) { const [dx, dy] = G.movePos(m, t); x += dx; y += dy; }
      return [t, x, y];
    });
    const top = Math.max(1, ...pts.map(([, x, y]) => Math.max(Math.abs(x), Math.abs(y))));
    const w = W - L - R, h = H - T - B;
    const px = (t) => (L + (t / span) * w).toFixed(1);
    const py = (v) => (T + (1 - (v + top) / (2 * top)) * h).toFixed(1);
    const line = (k) => pts.map((p, i) => `${i ? 'L' : 'M'}${px(p[0])} ${py(p[k])}`).join('');
    const label = (x, y, text, anchor = 'end') => `<text class="seq-plot-label" x="${x}" y="${y}" text-anchor="${anchor}">${text}</text>`;
    App.$('#seq-plot').innerHTML = [
      ...ms.filter((m) => m.duration).map((m) => `<rect class="seq-plot-glide" x="${px(m.start)}" y="${T}" width="${(((m.cut ?? m.duration) / span) * w).toFixed(1)}" height="${h}"/>`),
      `<line class="seq-plot-zero" x1="${L}" x2="${W - R}" y1="${py(0)}" y2="${py(0)}"/>`,
      `<path class="seq-plot-y" d="${line(2)}"/>`, `<path class="seq-plot-x" d="${line(1)}"/>`,
      label(L - 4, T + 8, `+${top}`), label(L - 4, Number(py(0)) + 3, '0'), label(L - 4, H - B, `-${top}`),
      label(L, H - 4, '0', 'start'), label(W - R, H - 4, fmtMs(lengthMs)),
    ].join('');
    const glides = ms.filter((m) => m.curve).length;
    const end = pts[pts.length - 1];
    App.$('#seq-plot-info').textContent = `· ends at x ${end[1]}, y ${end[2]} after ${fmtMs(lengthMs)}${glides ? ` · ${glides} glide${glides > 1 ? 's' : ''}` : ''}`;
    return glides;
  }

  function previewMsg(text, error = false) {
    const el = App.$('#seq-preview-msg');
    el.textContent = text;
    el.classList.toggle('seq-error', error);
  }

  async function preview() {
    const text = App.$('#seq-text').value;
    const g = ++previewGen;
    if (!/\bmove\b/i.test(text)) { App.$('#seq-preview').hidden = true; return previewMsg(''); }
    try {
      const r = await App.api('POST', '/api/sequence/preview', { text });
      if (g !== previewGen) return;
      if (r.error) throw new Error(r.error);
      App.$('#seq-preview').hidden = !r.moves.length;
      const glides = r.moves.length ? plot(r.lengthMs, r.moves) : 0;
      const f = App.st?.features ?? [];
      previewMsg(glides && f.includes('sequence') && !f.includes('sequenceGlide')
        ? 'The firmware on this keyboard can\'t play glides yet ("move … over"); flash the latest build.' : '');
    } catch (e) {
      if (g !== previewGen) return;
      App.$('#seq-preview').hidden = true;
      previewMsg(e.message, true);
    }
  }
  const schedulePreview = () => { clearTimeout(previewTimer); previewTimer = setTimeout(preview, PREVIEW_MS); };

  function gate() {
    App.ui.gate(panel(), supported() ? null : App.ui.firmwareReason('Play sequence'));
    if (!supported()) show(null);
  }

  function init() {
    const p = panel();
    App.$('#seq-play').onclick = () => App.busy(p, 'Sending the sequence…', async () => {
      const text = App.$('#seq-text').value;
      if (!text.trim()) throw new Error('Type a sequence first');
      gen++;
      const s = await App.api('POST', '/api/sequence/play', { text, stopOnKey: App.$('#seq-stop-key').checked });
      show(s);
      App.toast(`Playing ${s.steps} steps (${(s.lengthMs / 1000).toFixed(s.lengthMs < 10000 ? 2 : 0)} s)`);
      poll();
    });
    App.$('#seq-stop').onclick = () => App.busy(p, null, async () => {
      gen++; clearTimeout(timer);
      show(await App.api('POST', '/api/sequence/stop'));
    });
    App.$('#seq-text').addEventListener('input', schedulePreview);
    window.addEventListener('statechange', gate);
    window.addEventListener('pagechange', (e) => { if (e.detail === 'macros') { gate(); refresh(); } });
    gate();
  }

  App.views.sequence = { init, supported };
})();
