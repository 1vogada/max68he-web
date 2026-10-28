// Synth page (plugin): the keyboard as a pressure-sensitive instrument, like a Seaboard.
// Every key is a note (rows go up in fourths, or three scale steps), and its live depth is
// the expression: how hard you strike sets the attack, how deep you hold sets the volume and
// the brightness, and pushing near the bottom adds vibrato. Space is the sustain pedal: held
// down, notes ring on, and the deeper it goes the bigger the room. Played keys glow in their
// note's colour on the keyboard (MAX68HE open firmware) and on the board here.
(() => {
  const App = window.App;
  if (!App?.addView) return;
  const { $ } = App;

  App.addView({ id: 'synth', label: 'Synth', icon: '♫', after: 'travel', title: 'Analog synth',
    hint: 'Play the keyboard like an instrument: strike harder for a sharper attack, press deeper for louder and brighter, push near the bottom for vibrato. Space is the sustain pedal (deeper = bigger room).' });

  const SCALES = {
    'Pentatonic minor': [0, 3, 5, 7, 10], 'Pentatonic major': [0, 2, 4, 7, 9], Blues: [0, 3, 5, 6, 7, 10],
    Major: [0, 2, 4, 5, 7, 9, 11], 'Natural minor': [0, 2, 3, 5, 7, 8, 10], Dorian: [0, 2, 3, 5, 7, 9, 10],
    'Harmonic minor': [0, 2, 3, 5, 7, 8, 11], Chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  };
  // waves, detune (cents), octave shift, filter range (Hz), resonance, attack / release (s), reverb send
  const SOUNDS = {
    'Glass pad': { waves: ['sine', 'triangle'], detune: 5, oct: 0, cut: [700, 7000], q: 1, atk: 0.02, rel: 1.4, wet: 0.55 },
    'Saw lead': { waves: ['sawtooth', 'sawtooth'], detune: 12, oct: 0, cut: [250, 8000], q: 7, atk: 0.004, rel: 0.3, wet: 0.25 },
    'Warm strings': { waves: ['sawtooth', 'sawtooth'], detune: 22, oct: 0, cut: [300, 3200], q: 1.5, atk: 0.25, rel: 1.8, wet: 0.65 },
    Organ: { waves: ['sine', 'sine'], detune: 1200, oct: 0, cut: [1500, 9000], q: 0.7, atk: 0.008, rel: 0.12, wet: 0.35 },
    'Square bass': { waves: ['square', 'sawtooth'], detune: 6, oct: -1, cut: [120, 2400], q: 5, atk: 0.003, rel: 0.18, wet: 0.08 },
    Pluck: { waves: ['triangle', 'square'], detune: 3, oct: 0, cut: [400, 6000], q: 2, atk: 0.002, rel: 0.5, wet: 0.4, pluck: 1.1 },
  };
  const NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
  const CHORDS = [   // interval sets from the root, most specific first
    ['maj7', [0, 4, 7, 11]], ['m7', [0, 3, 7, 10]], ['7', [0, 4, 7, 10]], ['m7♭5', [0, 3, 6, 10]], ['dim7', [0, 3, 6, 9]],
    ['add9', [0, 2, 4, 7]], ['6', [0, 4, 7, 9]], ['m6', [0, 3, 7, 9]],
    ['', [0, 4, 7]], ['m', [0, 3, 7]], ['dim', [0, 3, 6]], ['aug', [0, 4, 8]], ['sus4', [0, 5, 7]], ['sus2', [0, 2, 7]], ['5', [0, 7]],
  ];
  const START_MM = 0.25, STOP_MM = 0.15, FULL_MM = 3.3, VIBRATO_MM = 2.6;

  const S = {
    ctx: null, on: false, es: null, voices: new Map(), notes: new Map(), depth: new Map(), lastAt: new Map(),
    pedal: 0, held: new Set(), glowOn: true, glowAt: 0, glowSent: '', sparks: [], raf: 0,
    opts: { sound: 'Glass pad', scale: 'Pentatonic minor', root: 9, octave: 3, volume: 0.7, room: 0.5 },
  };
  try { Object.assign(S.opts, JSON.parse(localStorage.getItem('max68he.synth') || '{}')); } catch { /* defaults */ }
  const keep = () => { try { localStorage.setItem('max68he.synth', JSON.stringify(S.opts)); } catch { /* fine */ } };

  // ---- the page -----------------------------------------------------------------------------

  const panel = document.createElement('section');
  panel.className = 'panel wide synth-panel';
  panel.dataset.views = 'synth';
  const opt = (o) => Object.keys(o).map((n) => `<option>${n}</option>`).join('');
  panel.innerHTML = `
    <div class="synth-head">
      <h2>Analog synth <span class="chip" id="sy-status">stopped</span></h2>
      <div class="synth-chord" id="sy-chord" aria-live="polite"></div>
    </div>
    <div class="synth-stage">
      <canvas id="sy-scope" height="180"></canvas>
      <button type="button" class="primary synth-start" id="sy-start">▶ Start the synth</button>
    </div>
    <div class="synth-controls">
      <label>Sound <select id="sy-sound">${opt(SOUNDS)}</select></label>
      <label>Scale <select id="sy-scale">${opt(SCALES)}</select></label>
      <label>Root <select id="sy-root">${NAMES.map((n, i) => `<option value="${i}">${n}</option>`).join('')}</select></label>
      <label>Octave <input type="number" id="sy-octave" min="1" max="6" step="1"></label>
      <label>Volume <input type="range" id="sy-volume" min="0" max="1" step="0.01"></label>
      <label>Room <input type="range" id="sy-room" min="0" max="1" step="0.01"></label>
      <label class="synth-check"><input type="checkbox" id="sy-glow" checked> Light up the played keys</label>
    </div>
    <p class="muted small">Keys type as usual in other programs; on this page they only play. Strike harder for a sharper
      attack, hold deeper for louder and brighter, push near the bottom for vibrato. <b>Space</b> is the sustain pedal.</p>`;
  $('section.panels').append(panel);

  const els = { sound: $('#sy-sound'), scale: $('#sy-scale'), root: $('#sy-root'), octave: $('#sy-octave'), volume: $('#sy-volume'), room: $('#sy-room') };
  for (const [k, el] of Object.entries(els)) {
    el.value = S.opts[k];
    el.oninput = () => {
      S.opts[k] = el.type === 'range' || el.type === 'number' || k === 'root' ? Number(el.value) : el.value;
      keep();
      if (k === 'volume' && S.master) S.master.gain.setTargetAtTime(S.opts.volume, S.ctx.currentTime, 0.05);
      if (['scale', 'root', 'octave'].includes(k)) { layoutNotes(); App.paintKeys(); }
    };
  }
  $('#sy-glow').onchange = (e) => { S.glowOn = e.target.checked; if (!S.glowOn) clearGlow(); };
  $('#sy-start').onclick = () => (S.on ? stop() : start());

  // ---- notes on the board -------------------------------------------------------------------

  // Rows from the board's own drawing (so any layout works), bottom row first; Space is the pedal.
  function layoutNotes() {
    S.notes.clear();
    const keys = [...App.keyEls].filter(([, el]) => el.dataset.name !== 'Space')
      .map(([slot, el]) => { const r = el.getBoundingClientRect(); return { slot, x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    if (!keys.length) return;
    const ys = [...new Set(keys.map((k) => Math.round(k.y)))].sort((a, b) => b - a);
    const rowOf = (y) => ys.findIndex((v) => Math.abs(v - y) < 6);
    const scale = SCALES[S.opts.scale];
    const rowStep = scale.length === 12 ? 5 : 3;   // fourths, or three scale steps
    const base = 12 * (S.opts.octave + 1) + S.opts.root;
    const rows = new Map();
    for (const k of keys) { const r = rowOf(Math.round(k.y)); if (!rows.has(r)) rows.set(r, []); rows.get(r).push(k); }
    for (const [r, list] of rows) {
      list.sort((a, b) => a.x - b.x).forEach((k, col) => {
        const deg = col + r * rowStep;
        S.notes.set(k.slot, base + 12 * Math.floor(deg / scale.length) + scale[deg % scale.length]);
      });
    }
  }
  const noteName = (m) => `${NAMES[m % 12]}${Math.floor(m / 12) - 1}`;
  const hueOf = (m) => (m % 12) * 30;
  function hsl(h, s, l) {   // -> [r, g, b] 0..255
    const a = s * Math.min(l, 1 - l);
    const f = (n) => { const k = (n + h / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
    return [f(0), f(8), f(4)];
  }

  // ---- sound --------------------------------------------------------------------------------

  function impulse(ctx, seconds) {   // a decaying noise tail for the reverb
    const n = Math.floor(ctx.sampleRate * seconds), buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n) ** 3; }
    return buf;
  }

  function buildAudio() {
    const ctx = S.ctx = new AudioContext();
    S.master = ctx.createGain(); S.master.gain.value = S.opts.volume;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -18; comp.ratio.value = 4;
    S.bus = ctx.createGain(); S.bus.gain.value = 0.35;
    S.send = ctx.createGain(); S.send.gain.value = 0.4;
    const verb = ctx.createConvolver(); verb.buffer = impulse(ctx, 3.2);
    const delay = ctx.createDelay(1); delay.delayTime.value = 0.32;
    const fb = ctx.createGain(); fb.gain.value = 0.28;
    S.analyser = ctx.createAnalyser(); S.analyser.fftSize = 2048;
    S.bus.connect(comp); S.bus.connect(S.send);
    S.send.connect(verb); S.send.connect(delay); delay.connect(fb); fb.connect(delay);
    verb.connect(comp); delay.connect(comp);
    comp.connect(S.master); S.master.connect(S.analyser); S.analyser.connect(ctx.destination);
  }

  function noteOn(slot, mm, speed) {
    const midi = S.notes.get(slot);
    if (midi === undefined || S.voices.has(slot)) return;
    const p = SOUNDS[S.opts.sound], ctx = S.ctx, t = ctx.currentTime;
    const freq = 440 * 2 ** ((midi + 12 * p.oct - 69) / 12);
    const v = { slot, midi, p, oscs: [], filter: ctx.createBiquadFilter(), amp: ctx.createGain(), lfo: ctx.createOscillator(), vib: ctx.createGain() };
    v.filter.type = 'lowpass'; v.filter.Q.value = p.q; v.filter.frequency.value = p.cut[0];
    v.lfo.frequency.value = 5.5; v.vib.gain.value = 0; v.lfo.connect(v.vib);
    p.waves.forEach((w, i) => {
      const o = ctx.createOscillator();
      o.type = w; o.frequency.value = freq; o.detune.value = i ? p.detune : (p.detune >= 100 ? 0 : -p.detune / 2);   // >= 100: an interval, not a spread
      v.vib.connect(o.detune); o.connect(v.filter); o.start(t); v.oscs.push(o);
    });
    v.amp.gain.value = 0;
    v.filter.connect(v.amp); v.amp.connect(S.bus); v.lfo.start(t);
    // a hard strike opens the filter for a moment and lands louder
    const strike = Math.min(1, speed / 25);
    v.filter.frequency.setValueAtTime(p.cut[0] + (p.cut[1] - p.cut[0]) * (0.35 + 0.65 * strike), t);
    v.amp.gain.setValueAtTime(0, t);
    v.amp.gain.linearRampToValueAtTime(0.25 + 0.35 * strike, t + p.atk + 0.005);
    if (p.pluck) v.amp.gain.setTargetAtTime(0, t + p.atk, p.pluck / 3);
    S.voices.set(slot, v);
    spark(slot, midi, strike);
    express(v, mm);
  }

  // depth -> volume, brightness and (near the bottom) vibrato, smoothed so the stream never clicks
  function express(v, mm) {
    const t = S.ctx.currentTime, p = v.p;
    const lvl = Math.max(0, Math.min(1, (mm - 0.2) / (FULL_MM - 0.2))) ** 0.8;
    if (!p.pluck) v.amp.gain.setTargetAtTime(0.08 + 0.5 * lvl, t + p.atk, 0.03);
    v.filter.frequency.setTargetAtTime(p.cut[0] + (p.cut[1] - p.cut[0]) * lvl ** 1.6, t, 0.025);
    v.vib.gain.setTargetAtTime(mm > VIBRATO_MM ? Math.min(1, (mm - VIBRATO_MM) / 0.7) * 38 : 0, t, 0.06);
  }

  function noteOff(slot) {
    const v = S.voices.get(slot);
    if (!v) return;
    S.voices.delete(slot);
    const t = S.ctx.currentTime, rel = v.p.rel * (1 + 2.5 * S.pedal);
    v.amp.gain.cancelScheduledValues(t);
    v.amp.gain.setValueAtTime(v.amp.gain.value, t);
    v.amp.gain.setTargetAtTime(0, t, rel / 4);
    const end = t + rel + 0.2;
    v.oscs.forEach((o) => o.stop(end)); v.lfo.stop(end);
    setTimeout(() => { try { v.amp.disconnect(); } catch { /* gone */ } }, (rel + 0.4) * 1000);
  }

  // ---- the live depth stream ------------------------------------------------------------------

  function onTravel({ slot, mm }) {
    const now = performance.now(), prev = S.depth.get(slot) ?? 0, dt = Math.max(1, now - (S.lastAt.get(slot) ?? now - 8));
    S.depth.set(slot, mm); S.lastAt.set(slot, now);
    if (App.keyEls.get(slot)?.dataset.name === 'Space') {   // sustain pedal; deeper = bigger room
      S.pedal = Math.max(0, Math.min(1, (mm - 0.3) / 2.5));
      const t = S.ctx.currentTime;
      S.send.gain.setTargetAtTime(0.4 * (0.4 + S.opts.room * 1.2) * (1 + 1.5 * S.pedal), t, 0.08);
      if (mm < STOP_MM) for (const s of S.held) if (!((S.depth.get(s) ?? 0) >= STOP_MM)) noteOff(s);
      if (mm < STOP_MM) S.held.clear();
      return;
    }
    const v = S.voices.get(slot);
    if (!v && mm >= START_MM) noteOn(slot, mm, ((mm - prev) / dt) * 100);   // mm per 10 ms
    else if (v && mm < STOP_MM) { if (S.pedal > 0.05) S.held.add(slot); else noteOff(slot); }
    else if (v) express(v, mm);
    S.dirty = true;
  }

  // ---- glow: on the keyboard (overlay) and on the board here ---------------------------------

  function glowFrame() {
    const out = [];
    for (const [slot, v] of S.voices) {
      const mm = S.depth.get(slot) ?? 0;
      out.push([slot, ...hsl(hueOf(v.midi), 1, 0.12 + 0.38 * Math.min(1, mm / FULL_MM))]);
    }
    return out;
  }
  function sendGlow(now) {
    if (!S.glowOn || S.glowBlocked) return;
    const keys = glowFrame(), sig = JSON.stringify(keys);
    if (sig === S.glowSent && now - S.glowAt < 350) return;   // unchanged: just keep it alive
    if (now - S.glowAt < 40) return;                           // ~25 frames a second at most
    S.glowSent = sig; S.glowAt = now;
    App.api('POST', '/api/synth/glow', { keys, ttlMs: 600 }).catch((e) => {
      S.glowBlocked = true;
      $('#sy-glow').checked = false;
      App.toast(`Keyboard glow off: ${e.message}`, true);
    });
  }
  function clearGlow() { S.glowSent = ''; App.api('POST', '/api/synth/clear').catch(() => {}); }

  App.views = App.views || {};
  App.views.synth = {
    paint(slot, el) {
      const midi = S.notes.get(slot), val = $('.val', el), v = S.voices.get(slot);
      el.classList.remove('sel');
      $('.bar', el).style.width = '0';
      const mm = S.depth.get(slot) ?? 0;
      $('.fill', el).style.height = `${Math.min(mm / 3.6, 1) * 100}%`;
      if (el.dataset.name === 'Space') { val.textContent = 'pedal'; el.style.background = S.pedal > 0.05 ? 'var(--accent)' : 'var(--cap)'; return true; }
      if (midi === undefined) { val.textContent = ''; return true; }
      val.textContent = noteName(midi);
      const [r, g, b] = hsl(hueOf(midi), 0.9, v ? 0.35 + 0.25 * Math.min(1, mm / FULL_MM) : 0.16);
      el.style.background = `rgb(${r}, ${g}, ${b})`;
      el.style.color = v ? '#fff' : '';
      return true;
    },
    keyDown() { return true; },   // clicking the board doesn't select anything here
    travel: (t) => S.on && onTravel(t),   // feed a { slot, mm } reading by hand (tests, demos)
  };

  // ---- scope, sparks and the chord name -----------------------------------------------------

  function spark(slot, midi, strike) {
    const el = App.keyEls.get(slot), cv = $('#sy-scope');
    if (!el || !cv) return;
    S.sparks.push({ x: Math.random() * cv.clientWidth, y: cv.clientHeight, vy: 0.6 + 1.6 * strike, life: 1, hue: hueOf(midi), name: noteName(midi), size: 12 + 14 * strike });
  }

  function chordName() {
    const pcs = [...new Set([...S.voices.values()].map((v) => v.midi % 12))];
    if (pcs.length < 2) return pcs.length ? NAMES[pcs[0]] : '';
    const lowest = Math.min(...[...S.voices.values()].map((v) => v.midi)) % 12;
    for (const [name, iv] of CHORDS) {
      for (const root of pcs) {
        const set = new Set(pcs.map((p) => (p - root + 12) % 12));
        if (set.size === iv.length && iv.every((i) => set.has(i))) return `${NAMES[root]}${name}${root !== lowest ? `/${NAMES[lowest]}` : ''}`;
      }
    }
    return pcs.map((p) => NAMES[p]).join(' · ');
  }

  function frame(now) {
    S.raf = requestAnimationFrame(frame);
    const cv = $('#sy-scope'), g = cv.getContext('2d');
    if (cv.width !== cv.clientWidth * devicePixelRatio) { cv.width = cv.clientWidth * devicePixelRatio; cv.height = 180 * devicePixelRatio; }
    const W = cv.width, H = cv.height, dpr = devicePixelRatio;
    g.fillStyle = 'rgba(10, 10, 16, 0.28)'; g.fillRect(0, 0, W, H);
    // waveform, coloured by the newest note
    const data = new Uint8Array(S.analyser.fftSize);
    S.analyser.getByteTimeDomainData(data);
    const newest = [...S.voices.values()].pop();
    g.lineWidth = 2 * dpr; g.strokeStyle = newest ? `hsl(${hueOf(newest.midi)}, 100%, 62%)` : 'rgba(255,255,255,.35)';
    g.shadowBlur = newest ? 14 * dpr : 0; g.shadowColor = g.strokeStyle;
    g.beginPath();
    for (let i = 0; i < data.length; i++) { const x = (i / data.length) * W, y = (data[i] / 255) * H; i ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.stroke(); g.shadowBlur = 0;
    // rising note sparks
    g.textAlign = 'center';
    S.sparks = S.sparks.filter((s) => (s.life -= 0.008) > 0);
    for (const s of S.sparks) {
      s.y -= s.vy; s.x += Math.sin((1 - s.life) * 9) * 0.6;
      g.globalAlpha = s.life; g.fillStyle = `hsl(${s.hue}, 100%, 65%)`;
      g.font = `600 ${s.size * dpr}px Inter, sans-serif`; g.fillText(s.name, s.x * dpr, s.y * dpr);
    }
    g.globalAlpha = 1;
    $('#sy-chord').textContent = chordName();
    if (S.dirty) { S.dirty = false; App.paintKeys(); }
    sendGlow(now);
  }

  // ---- start / stop -------------------------------------------------------------------------

  // keys still type in other programs; on this page they only play
  const swallow = (e) => { if (S.on && App.st.view === 'synth' && !e.target.closest?.('input, select, textarea')) e.preventDefault(); };
  window.addEventListener('keydown', swallow, true);

  async function start() {
    if (!S.ctx) buildAudio();
    await S.ctx.resume();
    layoutNotes();
    S.on = true; S.glowBlocked = false;
    S.es = new EventSource('/api/travel');
    S.es.onmessage = (e) => { try { onTravel(JSON.parse(e.data)); } catch { /* skip a bad line */ } };
    S.es.addEventListener('error', () => { $('#sy-status').textContent = 'no key stream (keyboard connected by cable?)'; });
    $('#sy-status').textContent = 'playing';
    $('#sy-start').textContent = '■ Stop';
    panel.classList.add('live');
    cancelAnimationFrame(S.raf); S.raf = requestAnimationFrame(frame);
    App.paintKeys();
  }

  function stop() {
    S.on = false;
    S.es?.close(); S.es = null;
    for (const slot of [...S.voices.keys()]) noteOff(slot);
    S.held.clear(); S.pedal = 0; S.depth.clear();
    cancelAnimationFrame(S.raf);
    clearGlow();
    $('#sy-status').textContent = 'stopped';
    $('#sy-start').textContent = '▶ Start the synth';
    panel.classList.remove('live');
    App.paintKeys();
  }

  window.addEventListener('pagechange', (e) => { if (e.detail !== 'synth' && S.on) stop(); else if (e.detail === 'synth') { layoutNotes(); App.paintKeys(); } });
  window.addEventListener('resize', () => { if (App.st.view === 'synth') layoutNotes(); });
  window.addEventListener('beforeunload', () => { if (S.on) navigator.sendBeacon?.('/api/synth/clear'); });
})();
