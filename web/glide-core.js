// Mouse glide curves for play sequences ("move 200 0 over 500ms ease out"): the same formulas
// as the open firmware, f(t) for t = 0..1 of the glide's time. Used by src/sequence.js (Node)
// and by the Macros-tab preview (web/sequence.js) in the browser.
(() => {
  // name -> firmware curve id (step arg2 byte 0)
  const CURVE_IDS = { linear: 0, easeIn: 1, easeOut: 2, easeInOut: 3, sine: 4, expo: 5, smooth: 6, points: 7 };
  const CURVE_NAMES = Object.keys(CURVE_IDS);
  // default P (ease) / K (expo); the firmware gets it * 100 as an int16
  const DEFAULT_POWER = { easeIn: 2, easeOut: 2, easeInOut: 2, expo: 5 };

  // The polyline through 4 points (0..255 each), like the gamepad custom curve: y0 before x0,
  // y3 after x3, equal x = a step (its upper end).
  function polyline(points, t) {
    const x = t * 255;
    if (x < points[0][0]) return points[0][1] / 255;
    let i = 3;
    while (points[i][0] > x) i--;
    if (i === 3) return points[3][1] / 255;
    const [x0, y0] = points[i], [x1, y1] = points[i + 1];
    return (y0 + ((y1 - y0) * (x - x0)) / (x1 - x0)) / 255;
  }

  // curve: name or id; param: P for ease curves, K for expo (the real value, not * 100)
  function glideCurve(curve, param, points) {
    const name = typeof curve === 'number' ? CURVE_NAMES[curve] : curve;
    const p = param ?? DEFAULT_POWER[name];
    switch (name) {
      case 'linear': return (t) => t;
      case 'easeIn': return (t) => t ** p;
      case 'easeOut': return (t) => 1 - (1 - t) ** p;
      case 'easeInOut': return (t) => (t < 0.5 ? (2 * t) ** p / 2 : 1 - (2 * (1 - t)) ** p / 2);
      case 'sine': return (t) => (1 - Math.cos(Math.PI * t)) / 2;
      case 'expo': return (t) => Math.expm1(p * t) / Math.expm1(p);
      case 'smooth': return (t) => t * t * (3 - 2 * t);
      case 'points': return (t) => polyline(points, t);
      default: throw new Error(`unknown glide curve "${curve}"`);
    }
  }

  // Pointer offset of one move at time t (ms) of the sequence: { start, duration, cut?, dx, dy, f }.
  // Before the start nothing, from start + duration (or the cut, when a 5th glide pushed it out)
  // exactly (dx, dy), in between round(d * f).
  function movePos(m, t) {
    if (t < m.start) return [0, 0];
    const end = m.start + (m.cut ?? m.duration);
    if (!m.duration || t >= end) return [m.dx, m.dy];
    const f = m.f((t - m.start) / m.duration);
    const r = (v) => (v < 0 ? -Math.round(-v) : Math.round(v));   // halves away from 0, like the firmware
    return [r(m.dx * f), r(m.dy * f)];
  }

  const api = { CURVE_IDS, CURVE_NAMES, DEFAULT_POWER, glideCurve, movePos, polyline };
  if (typeof module !== 'undefined') module.exports = api;
  else { window.App = window.App || {}; window.App.glide = api; }
})();
