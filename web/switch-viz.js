// Switch view next to the travel sliders: a magnetic switch beside a travel gauge
// (0 mm at the top) with the settings drawn on it, so you can see how deep
// "1.20 mm" is. Two looks of the same switch, picked with a 3D / 2D toggle (kept
// per browser): 3D is isometric, like the stock app's; 2D is the same switch cut
// in half and seen from the side. The stem rests at the top (0 mm) and only moves
// with live travel: the selected key, or with none selected, the key you press.
// Both are drawn in mm, so the stem drops exactly its travel.
//
// App.switchViz(el) -> { draw({ travel, live, name, lines: [{ mm, label, color, dashed }],
//   zones: [{ from, to, label, color }], arrows: [{ at, mm, up, label, color }] }) }
(() => {
  const App = (window.App = window.App || {});
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const W = 400, H = 250, GT = 30, GB = 206, GX = 200, LX = 250;  // gauge top (0 mm) .. bottom (full travel), bar x, label column
  const CX = 80, HT = 9.8;                             // switch centre x; housing top (mm)
  const PZ = HT - 0.3, CZ = HT + 0.3, CH = CZ + 3.7;   // stem plate bottom / top, cross top at rest (mm): 3.5 mm down leaves 0.5 mm of cross out
  const depthOf = (o) => Math.max(0, Math.min(o.travel ?? 3.5, o.live ?? 0));   // at rest unless a key is down
  const shift = (px) => `style="transform:translateY(${px.toFixed(2)}px)"`;

  // ---- 3D: isometric, S px per mm ---------------------------------------------
  const S = 6, CY = 166, COS = Math.cos(Math.PI / 6);
  const P = (x, y, z) => [CX + (x - y) * COS * S, CY + (x + y) * 0.5 * S - z * S];
  const pts = (list) => list.map((p) => P(...p).map((n) => n.toFixed(1)).join(',')).join(' ');
  const poly = (list, cls) => `<polygon points="${pts(list)}" class="${cls}"/>`;
  // square block, centred, bottom half-width b, top t (b != t: a frustum): the top and the two sides facing us
  const block = (b, t, z0, z1, cls) => poly([[-t, -t, z1], [t, -t, z1], [t, t, z1], [-t, t, z1]], `${cls} top`)
    + poly([[b, -b, z0], [b, b, z0], [t, t, z1], [t, -t, z1]], `${cls} r`)
    + poly([[-b, b, z0], [b, b, z0], [t, t, z1], [-t, t, z1]], `${cls} l`);
  const sides = (x0, x1, y0, y1, z0, z1, cls) => poly([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], `${cls} r`)
    + poly([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], `${cls} l`);

  function iso(d, id) {
    const parts = [];
    // grey bottom housing, teal top housing with its window, the hole the stem runs in
    const yz = (z) => 7 + (6.4 - 7) * (z - 5) / 3.6;   // the top housing's front-left face at height z
    parts.push(block(6.6, 7.6, 0, 4.4, 'sv3-low') + block(7.6, 7.6, 4.4, 5, 'sv3-low'));
    parts.push(block(7, 6.4, 5, 8.6, 'sv3-up') + block(6.4, 4.8, 8.6, HT, 'sv3-up b'));
    parts.push(poly([[-5.4, yz(6), 6], [-1.8, yz(6), 6], [-1.8, yz(7.9), 7.9], [-5.4, yz(7.9), 7.9]], 'sv3-win'));
    parts.push(poly([[-5.4, yz(6), 6], [-1.8, yz(6), 6], [-1.8, yz(6) - 1, 6.3], [-5.4, yz(6) - 1, 6.3]], 'sv3-sill'));
    parts.push(poly([[-3.4, -3.4, HT], [3.4, -3.4, HT], [3.4, 3.4, HT], [-3.4, 3.4, HT]], 'sv3-hole'));
    // the stem: at rest its plate sits in the hole just proud of the top and only the cross sticks
    // out; pressed, it all sinks, so it is only seen above the hole's front edges
    const [lx] = P(-3.4, 3.4, HT), [rx] = P(3.4, -3.4, HT);
    parts.push(`<clipPath id="${id}h"><polygon points="${pts([[-3.4, 3.4, HT], [3.4, 3.4, HT], [3.4, -3.4, HT]])} ${rx.toFixed(1)},0 ${lx.toFixed(1)},0"/></clipPath>`);
    parts.push(`<g clip-path="url(#${id}h)"><g class="sv3-move" ${shift(d * S)}>`
      + sides(-2.4, 2.4, -2.4, 2.4, HT - 4, PZ, 'sv3-stem') + block(3.2, 3.2, PZ, CZ, 'sv3-stem')
      + sides(-2, -0.6, -0.6, 0.6, CZ, CH, 'sv3-stem') + sides(-0.6, 0.6, -2, -0.6, CZ, CH, 'sv3-stem')
      + sides(0.6, 2, -0.6, 0.6, CZ, CH, 'sv3-stem') + sides(-0.6, 0.6, 0.6, 2, CZ, CH, 'sv3-stem')
      + poly([[-2, -0.6, CH], [-0.6, -0.6, CH], [-0.6, -2, CH], [0.6, -2, CH], [0.6, -0.6, CH], [2, -0.6, CH],
        [2, 0.6, CH], [0.6, 0.6, CH], [0.6, 2, CH], [-0.6, 2, CH], [-0.6, 0.6, CH], [-2, 0.6, CH]], 'sv3-stem top') + '</g></g>');
    return parts.join('');
  }

  // ---- 2D: the same switch cut in half, seen from the side, S2 px per mm -------
  // Cut faces in the housing colours, the inside behind them darker. The stem
  // (slider, up-stop wings, magnet in its foot, plate, cross) moves as one; the
  // spring between the wings and the housing floor squeezes.
  const S2 = 10, Z0 = 198, FLOOR = 1, SPRING = 7.4;   // y of z = 0 (housing bottom); floor top; spring top at rest (mm)
  const sy = (z) => Z0 - z * S2;
  const flat = (list, cls) => `<polygon points="${list.map(([x, z]) => `${(CX + x * S2).toFixed(1)},${sy(z).toFixed(1)}`).join(' ')}" class="${cls}"/>`;
  const rect = (x0, x1, z0, z1, cls) => flat([[x0, z0], [x1, z0], [x1, z1], [x0, z1]], cls);
  const both = (list, cls) => flat(list, cls) + flat(list.map(([x, z]) => [-x, z]), cls);  // a wall and its mirror

  function cut(d) {
    const parts = [];
    parts.push(rect(-7.9, 7.9, -1.6, 0, 'sv3-pcb') + rect(-1.1, 1.1, 0, 0.7, 'sv3-sensor'));
    parts.push(rect(-4.6, 4.6, FLOOR, 5, 'sv3-in-low') + rect(-1.4, 1.4, 0.7, FLOOR, 'sv3-in-low'));
    parts.push(rect(-4.6, 4.6, 5, 8.6, 'sv3-in-up') + rect(-3.4, 3.4, 8.6, HT, 'sv3-in-up'));
    // spring: zig-zag around the slider's foot, drawn at rest and squeezed with scaleY from the floor
    const coils = 6, step = (SPRING - FLOOR) / (coils * 2);
    let zig = `M${CX - 3.5 * S2} ${sy(SPRING)}`;
    for (let i = 1; i <= coils * 2; i++) zig += ` L${CX + (i % 2 ? 3.5 : -3.5) * S2} ${sy(SPRING - i * step).toFixed(1)}`;
    parts.push(`<path d="${zig}" class="sv3-spring" ${squeeze(d)}/>`);
    parts.push(`<g class="sv3-move" ${shift(d * S2)}>`
      + rect(-2.4, 2.4, 5, PZ, 'sv3-stem l') + rect(-4.2, 4.2, SPRING, SPRING + 1, 'sv3-stem l')
      + rect(-1.6, 1.6, 5.7, 6.4, 'sv3-mag-n') + rect(-1.6, 1.6, 5, 5.7, 'sv3-mag-s')
      + rect(-3.2, 3.2, PZ, CZ, 'sv3-stem top') + rect(-2, 2, CZ, CH, 'sv3-stem l') + rect(-0.6, 0.6, CZ, CH, 'sv3-stem top') + '</g>');
    // housing walls, cut: grey bottom (floor with the sensor window), teal top with its bevel and hole
    parts.push(both([[-6.6, 0], [-1.4, 0], [-1.4, FLOOR], [-4.6, FLOOR], [-4.6, 5], [-7.6, 5], [-7.6, 4.4]], 'sv3-low l'));
    parts.push(both([[-7, 5], [-4.6, 5], [-4.6, 8.6], [-3.4, 8.6], [-3.4, HT], [-4.8, HT], [-6.4, 8.6]], 'sv3-up l'));
    return parts.join('');
  }
  const squeeze = (d) => `style="transform-origin:0 ${sy(FLOOR)}px;transform:scaleY(${((SPRING - FLOOR - d) / (SPRING - FLOOR)).toFixed(4)})"`;

  // ---- the gauge, shared: bar filled down to the depth, ticks every 0.1 mm, numbers
  // every 0.5 mm; zone bands, setting lines and rapid-trigger arrows beside it
  function wrap(s, n = 24) {                           // a label in lines of about n characters
    const out = [''];
    for (const w of String(s).split(' ')) {
      const cur = out[out.length - 1];
      if (cur && (cur + ' ' + w).length > n) out.push(w); else out[out.length - 1] = cur ? `${cur} ${w}` : w;
    }
    return out;
  }

  function gauge(o, T, d, id) {
    const span = GB - GT, parts = [], labels = [];
    const y = (mm) => GT + (Math.max(0, Math.min(T, mm)) / T) * span;
    const bar = `x="${GX}" y="${GT - 7}" width="16" height="${span + 14}" rx="8"`;
    parts.push(`<clipPath id="${id}g"><rect ${bar}/></clipPath><rect ${bar} class="sv3-bar"/>`);
    // the fill fills the rounded top too, so a shallow press reads as a level, not a mark; empty at 0
    parts.push(`<g clip-path="url(#${id}g)"><rect x="${GX}" y="${GT - 7 - span}" width="16" height="${span + 7}" class="sv3-fill sv3-depth${d < 0.005 ? ' empty' : ''}" ${shift(d / T * span)}/>`
      + (o.zones ?? []).map((z) => `<rect x="${GX}" y="${Math.min(y(z.from), y(z.to))}" width="16" height="${Math.max(2, Math.abs(y(z.to) - y(z.from)))}" fill="${z.color}" opacity="0.45"/>`).join('')
      + '</g>');
    for (let i = 0; i <= Math.round(T * 10); i++) {
      const yy = y(i / 10).toFixed(1), major = i % 5 === 0;
      parts.push(`<line x1="${major ? GX - 12 : GX - 8}" x2="${GX - 4}" y1="${yy}" y2="${yy}" class="sv-tick${major ? '' : ' minor'}"/>`
        + `<line x1="${GX + 20}" x2="${major ? GX + 28 : GX + 24}" y1="${yy}" y2="${yy}" class="sv-tick${major ? '' : ' minor'}"/>`);
      if (major) parts.push(`<text x="${GX - 15}" y="${(+yy + 3.5).toFixed(1)}" class="sv-num" text-anchor="end">${(i / 10).toFixed(2)}</text>`);
    }
    for (const z of o.zones ?? []) {
      const a = y(z.from), b = y(z.to);
      parts.push(`<rect x="${GX + 31}" y="${Math.min(a, b)}" width="5" height="${Math.max(2, Math.abs(b - a))}" fill="${z.color}" opacity="0.7" rx="1"/>`);
      if (z.label) labels.push({ y: (a + b) / 2, x: GX + 37, text: z.label, color: z.color });
    }
    for (const l of o.lines ?? []) {
      const yy = y(l.mm);
      parts.push(`<line x1="${GX - 6}" x2="${GX + 30}" y1="${yy}" y2="${yy}" stroke="${l.color}" stroke-width="2" ${l.dashed ? 'stroke-dasharray="4 3"' : ''}/>`);
      labels.push({ y: yy, x: GX + 31, text: l.label, color: l.color });
    }
    for (const a of o.arrows ?? []) {
      const y0 = y(a.at), y1 = y(a.up ? a.at - a.mm : a.at + a.mm), x = GX + 42;
      parts.push(`<line x1="${x}" x2="${x}" y1="${y0}" y2="${y1}" stroke="${a.color}" stroke-width="2.5"/>`
        + `<path d="M${x - 4} ${y1 + (a.up ? 5 : -5)} L${x} ${y1} L${x + 4} ${y1 + (a.up ? 5 : -5)}" fill="none" stroke="${a.color}" stroke-width="2"/>`);
      labels.push({ y: (y0 + y1) / 2, x: x + 2, text: a.label, color: a.color });
    }
    // stack the labels top to bottom near their marks, never overlapping, then pull back inside the picture
    labels.sort((a, b) => a.y - b.y);
    let next = 0;
    for (const l of labels) { l.rows = wrap(l.text); l.h = l.rows.length * 12; l.top = Math.max(l.y - l.h / 2, next); next = l.top + l.h + 2; }
    let floor = H - 2;
    for (const l of [...labels].reverse()) { l.top = Math.min(l.top, floor - l.h); floor = l.top - 2; }
    for (const l of labels) {
      const mid = l.top + l.h / 2;
      parts.push(`<path d="M${l.x} ${l.y.toFixed(1)} L${LX - 3} ${mid.toFixed(1)}" stroke="${l.color}" stroke-width="1" opacity="0.6" fill="none"/>`);
      parts.push(`<text y="${(l.top + 9).toFixed(1)}" class="sv-lab" fill="${l.color}">${l.rows.map((r, i) => `<tspan x="${LX}" dy="${i ? 12 : 0}">${esc(r)}</tspan>`).join('')}</text>`);
    }
    // the depth across the bar, drawn last so the setting lines don't hide it
    parts.push(`<line x1="${GX + 1}" x2="${GX + 15}" y1="${GT}" y2="${GT}" class="sv3-now sv3-depth${d < 0.005 ? ' empty' : ''}" ${shift(d / T * span)}/>`);
    return parts.join('');
  }

  function svg(o, id, look) {
    const T = o.travel ?? 3.5, d = depthOf(o);
    return `<svg viewBox="0 0 ${W} ${H}" class="switch-viz sv3${look === '2d' ? ' sv3-cut' : ''}" data-mm="${look === '2d' ? S2 : S}" role="img" aria-label="Switch travel with the settings marked">`
      + (look === '2d' ? cut(d) : iso(d, id)) + gauge(o, T, d, id)
      + `<text x="${CX}" y="${H - 18}" class="sv-num sv3-name" text-anchor="middle"></text>`
      + `<text x="${CX}" y="${H - 4}" class="sv-num sv3-mm" text-anchor="middle"></text></svg>`;
  }

  // the parts that follow the depth, changed in place so live travel glides
  function place(root, o) {
    const T = o.travel ?? 3.5, d = depthOf(o), live = o.live !== undefined && o.live !== null;
    const el = root.querySelector('.sv3'), mm = Number(el.dataset.mm);
    for (const g of root.querySelectorAll('.sv3-move')) g.style.transform = `translateY(${(d * mm).toFixed(2)}px)`;
    for (const g of root.querySelectorAll('.sv3-depth')) {
      g.style.transform = `translateY(${(d / T * (GB - GT)).toFixed(2)}px)`;
      g.classList.toggle('empty', d < 0.005);
    }
    const spring = root.querySelector('.sv3-spring');
    if (spring) spring.style.transform = `scaleY(${((SPRING - FLOOR - d) / (SPRING - FLOOR)).toFixed(4)})`;
    el.classList.toggle('live', live);
    root.querySelector('.sv3-name').textContent = live && o.name ? o.name : '';
    root.querySelector('.sv3-mm').textContent = live ? `pressed ${d.toFixed(2)} mm` : `${d.toFixed(2)} mm`;
  }

  // 3D or 2D, the same on every page; kept in this browser when storage allows
  const KEY = 'max68he.switchView';
  let look = (() => { try { return localStorage.getItem(KEY) === '2d' ? '2d' : '3d'; } catch { return '3d'; } })();
  let count = 0;

  App.switchViz = (el) => {
    const id = `svz${++count}`;
    el.innerHTML = `<div class="sv-holder"></div><div class="seg-tabs sv-mode" role="group" aria-label="Switch drawing">`
      + '<button type="button" data-look="3d">3D</button><button type="button" data-look="2d">2D</button></div>';
    const holder = el.firstElementChild, tabs = el.lastElementChild;
    let model = null, shape = '';
    function draw(o) {
      model = o;
      for (const b of tabs.children) { b.classList.toggle('on', b.dataset.look === look); b.setAttribute('aria-pressed', b.dataset.look === look); }
      const s = look + JSON.stringify({ ...o, live: null, name: null });  // depth alone: no rebuild
      if (s !== shape) { shape = s; holder.innerHTML = svg(o, id, look); }
      place(holder, o);
    }
    tabs.addEventListener('click', (e) => {
      const pick = e.target.closest('[data-look]')?.dataset.look;
      if (!pick || pick === look) return;
      look = pick;
      try { localStorage.setItem(KEY, pick); } catch { /* storage off */ }
      window.dispatchEvent(new Event('switchlookchange'));
    });
    window.addEventListener('switchlookchange', () => { if (model) draw(model); });
    return { draw };
  };
  App.switchVizSvg = (o, l = '3d') => svg(o, 'svzx', l);
})();
