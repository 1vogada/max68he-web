// Gamepad curve editor (Configuration tab): draws depth -> output for the response settings,
// with the 4 custom-curve points as handles you drag. Same math as src/analog.js.
(() => {
  const App = (window.App = window.App || {});
  const PAD = 10;                               // px around the plot
  const MAX_MM = 4;

  function polyline(points, t) {
    const x = t * 255;
    if (x < points[0][0]) return points[0][1] / 255;
    let i = 3;
    while (points[i][0] > x) i--;                // the last point at or before x (a step: its upper end)
    if (i === 3) return points[3][1] / 255;
    const [x0, y0] = points[i], [x1, y1] = points[i + 1];
    return (y0 + ((y1 - y0) * (x - x0)) / (x1 - x0)) / 255;
  }
  const CURVES = {
    linear: (t) => t, smooth: (t) => t * t * (3 - 2 * t), aggressive: Math.sqrt, instant: (t) => (t > 0 ? 1 : 0),
    custom: (t, p) => polyline(p, t),
  };

  // plot geometry: mm 0..4 left to right, output 0..1 bottom to top
  function frame(c) {
    const w = c.width - PAD * 2, h = c.height - PAD * 2;
    return { w, h, x: (mm) => PAD + (mm / MAX_MM) * w, y: (v) => PAD + (1 - v) * h };
  }
  const handleMm = (s, px) => s.deadzoneMm + (px / 255) * (s.fullMm - s.deadzoneMm);

  function draw(c, s) {
    const g = c.getContext('2d');
    const f = frame(c);
    const tok = App.ui.token;
    g.clearRect(0, 0, c.width, c.height);
    g.fillStyle = tok('--line');                // dead zone and beyond full press, shaded
    g.globalAlpha = 0.35;
    g.fillRect(f.x(0), PAD, f.x(s.deadzoneMm) - f.x(0), f.h);
    g.fillRect(f.x(s.fullMm), PAD, f.x(MAX_MM) - f.x(s.fullMm), f.h);
    g.globalAlpha = 1;
    g.strokeStyle = tok('--line');
    g.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {              // 1 mm grid, quarter output grid
      g.beginPath(); g.moveTo(f.x(i) + 0.5, PAD); g.lineTo(f.x(i) + 0.5, PAD + f.h); g.stroke();
      g.beginPath(); g.moveTo(PAD, f.y(i / 4) + 0.5); g.lineTo(PAD + f.w, f.y(i / 4) + 0.5); g.stroke();
    }
    const fn = CURVES[s.curve] ?? CURVES.linear;
    g.strokeStyle = tok('--accent');
    g.lineWidth = 2.5;
    g.beginPath();
    for (let i = 0; i <= f.w; i++) {
      const mm = (i / f.w) * MAX_MM;
      const t = mm <= s.deadzoneMm ? 0 : fn(Math.min((mm - s.deadzoneMm) / (s.fullMm - s.deadzoneMm), 1), s.points);
      const v = mm > s.deadzoneMm && s.antiDeadzone ? s.antiDeadzone / 100 + t * (1 - s.antiDeadzone / 100) : t;
      if (i) g.lineTo(PAD + i, f.y(v)); else g.moveTo(PAD + i, f.y(v));
    }
    g.stroke();
    if (s.curve !== 'custom') return;
    g.fillStyle = tok('--accent');
    g.strokeStyle = tok('--surface');
    g.lineWidth = 2;
    for (const [px, py] of s.points) {
      g.beginPath(); g.arc(f.x(handleMm(s, px)), f.y(py / 255), 6, 0, Math.PI * 2); g.fill(); g.stroke();
    }
  }

  // Dragging a handle (or clicking near one on a built-in curve) calls onChange(points);
  // x stays between its neighbours, both in whole 0..255 steps.
  function attach(c, getSettings, onChange) {
    let drag = -1;
    const pos = (e) => {
      const r = c.getBoundingClientRect();
      return [((e.clientX - r.left) * c.width) / r.width, ((e.clientY - r.top) * c.height) / r.height];
    };
    const toPoint = (s, [mx, my]) => {
      const f = frame(c);
      const mm = ((mx - PAD) / f.w) * MAX_MM;
      const px = Math.round(((mm - s.deadzoneMm) / (s.fullMm - s.deadzoneMm)) * 255);
      return [Math.max(0, Math.min(255, px)), Math.max(0, Math.min(255, Math.round((1 - (my - PAD) / f.h) * 255)))];
    };
    c.addEventListener('pointerdown', (e) => {
      const s = getSettings();
      if (!s) return;
      const f = frame(c);
      const [mx, my] = pos(e);
      let best = -1, dist = 18;
      s.points.forEach(([px, py], i) => {
        const d = Math.hypot(f.x(handleMm(s, px)) - mx, f.y(py / 255) - my);
        if (d < dist) { dist = d; best = i; }
      });
      if (best < 0) return;
      drag = best;
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      if (drag < 0) return;
      const s = getSettings();
      const pts = s.points.map((p) => [...p]);
      const [px, py] = toPoint(s, pos(e));
      const lo = drag ? pts[drag - 1][0] : 0, hi = drag < 3 ? pts[drag + 1][0] : 255;
      pts[drag] = [Math.max(lo, Math.min(hi, px)), py];
      onChange(pts);
    });
    const end = () => { drag = -1; };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
  }

  App.gpCurve = { draw, attach };
})();
