// Play sequence text / JSON -> firmware steps (open firmware 0xEF, see protocol.js SEQ).
//
// Text: statements split by ';' or new lines, '#' starts a comment.
//   120ms | 1.5s | wait 200ms   pause before the next event
//   W down | W up | down W      key or chord (Ctrl+Shift+Esc); up releases in reverse order
//   Space tap [50ms] | Ctrl+C   press and let go (held 20 ms unless given); a bare key = tap
//   release                     let go of everything
//   click L [50ms]              mouse button L / R / M (left, right, middle)
//   mouse down R | mouse up R
//   move 10 -5                  pointer by dx dy pixels at once (down is +y)
//   move 200 0 over 500ms [curve]  glide: the pointer travels dx dy gradually over 1..65535 ms;
//       curve: linear (default) | ease in|out|inout [P 0.3..8, default 2] | sine
//       | expo [K -20..20 not 0, default 5] | smooth | curve points x0,y0 x1,y1 x2,y2 x3,y3 (0..255)
//     The sequence goes on at once (a glide runs in the background, up to 4 at a time; a 5th
//     finishes the oldest at once). It ends when the last step and every glide are done.
//   wheel 2                     wheel notches (up is +)
// JSON: [{ delay?, event: 'down'|'up'|'tap'|'release'|'click'|'mouseDown'|'mouseUp'|'move'|'wheel'|'wait',
//          key?, button?, hold?, dx?, dy?, notches?, ms?,
//          over?, curve?: 'linear'|'easeIn'|'easeOut'|'easeInOut'|'sine'|'expo'|'smooth'|'points', power?, points? }]
//   (move with over = a glide of that many ms; power = P for ease curves, K for expo; points = 4 x [x, y])
// Glide steps: header [delay, GLIDE, dx lo, dx hi], then GLIDE_ARG steps whose delay field is data:
// [dy, ARG, T lo, T hi], [curve id | 0 << 8, ARG, param lo, param hi] (param = P or K * 100),
// and for points [x0 | y0 << 8, ARG, x1, y1], [x2 | y2 << 8, ARG, x3, y3].
// The keyboard lets go of everything when the sequence ends, so end with a pause to keep keys held.
const { parseKey } = require('./keys');
const { SEQ, SEQ_EVENTS } = require('./protocol');
const { CURVE_IDS, CURVE_NAMES, DEFAULT_POWER, glideCurve } = require('../web/glide-core');

const TAP_HOLD_MS = 20;
const MAX_MOVE = 32767;
const MAX_WHEEL = 1000;
const MAX_GLIDE_MS = 0xffff;
const MAX_GLIDES = 4;            // glides running at once on the keyboard
const EV = Object.fromEntries(SEQ_EVENTS.map((n, i) => [n, i]));
const BUTTONS = { l: 1, left: 1, r: 2, right: 2, m: 4, middle: 4 };

const fail = (where, msg) => Object.assign(new Error(`${where}: ${msg}`), { status: 400 });

// "Ctrl+C" -> [0xe0, 0x06]; keyboard keys and modifiers only
function chord(text, where) {
  const parts = String(text ?? '').split('+').map((p) => p.trim());
  if (!parts.length || parts.some((p) => !p)) throw fail(where, `bad key "${text}"`);
  return parts.map((p) => {
    let v;
    try { v = parseKey(p); } catch { throw fail(where, `unknown key "${p}"`); }
    if (v[0] !== 0 || v[1] !== 0 || v[3] !== 0 || v[2] < 0x04 || v[2] > 0xe7) throw fail(where, `"${p}" is not a keyboard key`);
    return v[2];
  });
}

function button(text, where) {
  const b = BUTTONS[String(text ?? '').trim().toLowerCase()];
  if (!b) throw fail(where, `mouse button is L, R or M, not "${text ?? ''}"`);
  return b;
}

// "120ms", "1.5s", "200" (ms) -> ms; null when it isn't a time
function timeOf(tok) {
  const m = /^(\d+(?:\.\d+)?)(ms|s)?$/i.exec(String(tok ?? '').trim());
  if (!m) return null;
  const ms = Math.round(Number(m[1]) * (m[2]?.toLowerCase() === 's' ? 1000 : 1));
  return Number.isFinite(ms) ? ms : null;
}

function int(tok, max, what, where) {
  const v = typeof tok === 'number' ? tok : /^[+-]?\d+$/.test(String(tok ?? '').trim()) ? Number(tok) : NaN;
  if (!Number.isInteger(v) || Math.abs(v) > max) throw fail(where, `${what} is a whole number within -${max}..${max}`);
  return v;
}

// Collects steps; a pause is added to the next step's delay (long ones become wait steps).
class Builder {
  constructor() { this.steps = []; this.pending = 0; }
  wait(ms) { this.pending += ms; }
  push(type, a = 0, b = 0) {
    while (this.pending > SEQ.MAX_DELAY) { this.steps.push({ delay: SEQ.MAX_DELAY, type: EV.wait, a: 0, b: 0 }); this.pending -= SEQ.MAX_DELAY; }
    this.steps.push({ delay: this.pending, type, a: a & 0xff, b: b & 0xff });
    this.pending = 0;
  }
  // int8 per step: big moves become several steps at the same moment
  split(total, cb) {
    const n = Math.max(1, ...total.map((v) => Math.ceil(Math.abs(v) / 127)));
    const done = total.map(() => 0);
    for (let i = 1; i <= n; i++) {
      const d = total.map((v, k) => { const to = Math.round((v * i) / n); const x = to - done[k]; done[k] = to; return x; });
      cb(d);
    }
  }
  keys(us, type, hold) {
    if (type !== 'up') us.forEach((u) => this.push(EV.down, u));
    if (type === 'tap') this.wait(hold ?? TAP_HOLD_MS);
    if (type !== 'down') [...us].reverse().forEach((u) => this.push(EV.up, u));
  }
  click(b, hold) { this.push(EV.mouseDown, b); this.wait(hold ?? TAP_HOLD_MS); this.push(EV.mouseUp, b); }
  move(dx, dy) { this.split([dx, dy], ([x, y]) => this.push(EV.move, x, y)); }
  // a header + 2 or 4 arg steps; the args' delay field carries data
  glide(dx, dy, ms, g) {
    this.push(EV.glide, dx, dx >> 8);
    const arg = (delay, a, b) => this.steps.push({ delay: delay & 0xffff, type: EV.glideArg, a: a & 0xff, b: b & 0xff });
    arg(dy, ms, ms >> 8);
    arg(g.id, g.param, g.param >> 8);
    if (g.points) {
      const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = g.points;
      arg(x0 | (y0 << 8), x1, y1);
      arg(x2 | (y2 << 8), x3, y3);
    }
  }
  wheel(n) { this.split([n], ([x]) => this.push(EV.wheel, x)); }
  finish(where) {
    if (this.pending) this.push(EV.wait);
    if (this.steps.length > SEQ.CAPACITY) throw fail(where, `${this.steps.length} steps, the keyboard holds ${SEQ.CAPACITY}`);
    if (!this.steps.length) throw fail(where, 'nothing to play');
    return this.steps;
  }
}

// glide length: 1..65535 ms
function glideMs(tok, where) {
  if (tok === undefined || tok === '') throw fail(where, 'over needs a time like 500ms');
  const ms = typeof tok === 'number' ? Math.round(tok) : timeOf(tok);
  if (ms === null) throw fail(where, `glide time "${tok}" is not like 500ms`);
  if (!Number.isFinite(ms) || ms < 1 || ms > MAX_GLIDE_MS) throw fail(where, `glide time is 1 ms..${MAX_GLIDE_MS} ms`);
  return ms;
}

function num(tok, what, where) {
  const v = typeof tok === 'number' ? tok : /^[+-]?\d+(\.\d+)?$/.test(String(tok ?? '').trim()) ? Number(tok) : NaN;
  if (!Number.isFinite(v)) throw fail(where, `${what} "${tok ?? ''}" is not a number`);
  return v;
}

const CURVE_LIST = '(linear, ease in|out|inout, sine, expo, smooth, curve points)';

// curve name + power / points -> { name, id, param (the firmware's int16), power?, points? }
function glideSpec(name, power, points, where) {
  if (!CURVE_NAMES.includes(name)) throw fail(where, `unknown curve "${name}" ${CURVE_LIST}`);
  const powered = DEFAULT_POWER[name] !== undefined;
  if (power !== undefined && !powered) throw fail(where, `a power only goes with ease or expo curves, not ${name}`);
  if (points !== undefined && name !== 'points') throw fail(where, `points only go with the points curve, not ${name}`);
  const g = { name, id: CURVE_IDS[name], param: 0 };
  if (name === 'expo') {
    g.param = Math.round(num(power ?? DEFAULT_POWER.expo, 'K', where) * 100);
    if (g.param === 0 || Math.abs(g.param) > 2000) throw fail(where, 'expo K is within -20..20 and not 0');
  } else if (powered) {
    g.param = Math.round(num(power ?? DEFAULT_POWER[name], 'P', where) * 100);
    if (g.param < 30 || g.param > 800) throw fail(where, 'ease P is within 0.3..8');
  } else if (name === 'points') {
    if (!Array.isArray(points) || points.length !== 4 || points.some((p) => !Array.isArray(p) || p.length !== 2)) {
      throw fail(where, 'curve points needs 4 points x,y like 0,0 85,170 170,230 255,255');
    }
    if (points.flat().some((v) => !Number.isInteger(v) || v < 0 || v > 255)) throw fail(where, 'curve point values are whole numbers 0..255');
    if (points.some((p, i) => i && p[0] < points[i - 1][0])) throw fail(where, 'curve point x values must not go down');
    if (points.flat().every((v) => v === 0)) throw fail(where, 'curve points are all 0 (the firmware reads that as linear); use linear');
    g.points = points.map((p) => [...p]);
  }
  if (powered) g.power = g.param / 100;
  return g;
}

const EASE = { in: 'easeIn', out: 'easeOut', inout: 'easeInOut' };

// the tokens after "over T": "ease out 3" | "sine" | "curve points 0,0 ..." -> glideSpec
function textCurve(t, where) {
  if (!t.length) return glideSpec('linear', undefined, undefined, where);
  const w = t.map((x) => x.toLowerCase());
  const done = (n) => { if (t.length > n) throw fail(where, `unexpected "${t.slice(n).join(' ')}"`); };
  if (w[0] === 'ease') {
    if (!EASE[w[1]]) throw fail(where, `ease in, ease out or ease inout, not "${t.join(' ')}"`);
    done(3);
    return glideSpec(EASE[w[1]], t[2], undefined, where);
  }
  if (w[0] === 'expo') { done(2); return glideSpec('expo', t[1], undefined, where); }
  if (w[0] === 'curve') {
    if (w[1] !== 'points') throw fail(where, 'curve points x0,y0 x1,y1 x2,y2 x3,y3');
    const pts = t.slice(2).map((p) => {
      const m = /^(\d+),(\d+)$/.exec(p);
      if (!m) throw fail(where, `point "${p}" is not like 85,170`);
      return [Number(m[1]), Number(m[2])];
    });
    return glideSpec('points', undefined, pts, where);
  }
  if (['linear', 'sine', 'smooth'].includes(w[0])) { done(1); return glideSpec(w[0], undefined, undefined, where); }
  throw fail(where, `unknown curve "${t.join(' ')}" ${CURVE_LIST}`);
}

const KEY_VERBS = ['down', 'up', 'tap'];

function statement(B, text, where) {
  const t = text.split(/\s+/);
  const w0 = t[0].toLowerCase(), w1 = (t[1] ?? '').toLowerCase();
  const hold = (tok) => { if (tok === undefined) return undefined; const ms = timeOf(tok); if (ms === null) throw fail(where, `hold time "${tok}" is not like 50ms`); return ms; };
  const done = (n) => { if (t.length > n) throw fail(where, `unexpected "${t.slice(n).join(' ')}"`); };
  const time = timeOf(t[0]);
  if (time !== null) { done(1); return B.wait(time); }
  if (w0 === 'wait') { const ms = timeOf(t[1]); if (ms === null) throw fail(where, 'wait needs a time like 200ms'); done(2); return B.wait(ms); }
  if (w0 === 'release') { done(w1 === 'all' ? 2 : 1); return B.push(EV.release); }
  if (w0 === 'click') { done(3); return B.click(button(t[1], where), hold(t[2])); }
  if (w0 === 'mouse') {
    if (w1 !== 'down' && w1 !== 'up') throw fail(where, 'mouse down <L|R|M> or mouse up <L|R|M>');
    done(3);
    return B.push(w1 === 'down' ? EV.mouseDown : EV.mouseUp, button(t[2], where));
  }
  if (w0 === 'move') {
    if (t.length < 3) throw fail(where, 'move needs dx and dy');
    const dx = int(t[1], MAX_MOVE, 'dx', where), dy = int(t[2], MAX_MOVE, 'dy', where);
    if (t.length === 3) return B.move(dx, dy);
    if (t[3].toLowerCase() !== 'over') throw fail(where, `unexpected "${t.slice(3).join(' ')}" (a glide is move dx dy over 500ms)`);
    return B.glide(dx, dy, glideMs(t[4], where), textCurve(t.slice(5), where));
  }
  if (w0 === 'wheel') { done(2); return B.wheel(int(t[1], MAX_WHEEL, 'wheel', where)); }
  if (KEY_VERBS.includes(w0)) {                                  // "down W"
    if (!t[1]) throw fail(where, `${w0} needs a key`);
    done(w0 === 'tap' ? 3 : 2);
    return B.keys(chord(t[1], where), w0, w0 === 'tap' ? hold(t[2]) : undefined);
  }
  const verb = KEY_VERBS.includes(w1) ? w1 : t.length === 1 ? 'tap' : null;   // "W down", bare "W"
  if (!verb) throw fail(where, `don't know "${text}"`);
  done(verb === 'tap' && t.length > 1 ? 3 : 2);
  return B.keys(chord(t[0], where), verb, verb === 'tap' ? hold(t[2]) : undefined);
}

function parseText(text) {
  const B = new Builder();
  String(text).split(/\r?\n/).forEach((line, li) => {
    const code = line.replace(/#.*/, '');
    let col = 0;
    for (const part of code.split(';')) {
      const lead = part.length - part.trimStart().length;
      const s = part.trim();
      if (s) statement(B, s, `line ${li + 1}, col ${col + lead + 1}`);
      col += part.length + 1;
    }
  });
  return B.finish('sequence');
}

function parseJson(list) {
  if (!Array.isArray(list)) throw fail('sequence', 'JSON form is a list of steps');
  const B = new Builder();
  list.forEach((s, i) => {
    const where = `step ${i + 1}`;
    if (!s || typeof s !== 'object') throw fail(where, 'not an object');
    if (s.delay !== undefined) { const ms = timeOf(s.delay); if (ms === null) throw fail(where, 'delay is milliseconds'); B.wait(ms); }
    const ms = (v) => (v === undefined ? undefined : timeOf(v) ?? (() => { throw fail(where, 'hold is milliseconds'); })());
    switch (s.event) {
      case 'down': case 'up': case 'tap': return B.keys(chord(s.key, where), s.event, ms(s.hold));
      case 'release': return B.push(EV.release);
      case 'click': return B.click(button(s.button, where), ms(s.hold));
      case 'mouseDown': case 'mouseUp': return B.push(EV[s.event], button(s.button, where));
      case 'move': {
        const dx = int(s.dx ?? 0, MAX_MOVE, 'dx', where), dy = int(s.dy ?? 0, MAX_MOVE, 'dy', where);
        if (s.over === undefined) {
          if (s.curve !== undefined || s.power !== undefined || s.points !== undefined) throw fail(where, 'curve, power and points need over (the glide time)');
          return B.move(dx, dy);
        }
        if (s.curve !== undefined && typeof s.curve !== 'string') throw fail(where, 'curve is a name like easeOut');
        return B.glide(dx, dy, glideMs(s.over, where), glideSpec(s.curve ?? 'linear', s.power, s.points, where));
      }
      case 'wheel': return B.wheel(int(s.notches, MAX_WHEEL, 'notches', where));
      case 'wait': { const w = timeOf(s.ms ?? 0); if (w === null) throw fail(where, 'ms is milliseconds'); return B.wait(w); }
      default: throw fail(where, `event is one of down, up, tap, release, click, mouseDown, mouseUp, move, wheel, wait`);
    }
  });
  return B.finish('sequence');
}

// text (or a JSON list as text) or a list of step objects -> [{ delay, type, a, b }]
function parseSequence(input) {
  if (Array.isArray(input)) return parseJson(input);
  if (typeof input !== 'string') throw fail('sequence', 'give the sequence as text or a list of steps');
  if (input.trim().startsWith('[')) {
    let list;
    try { list = JSON.parse(input); } catch (e) { throw fail('sequence', `bad JSON (${e.message})`); }
    return parseJson(list);
  }
  return parseText(input);
}

const i16 = (lo, hi) => ((lo | (hi << 8)) << 16) >> 16;

// Steps -> when the pointer moves: { lengthMs, moves: [{ start, duration, dx, dy, curve, power?,
// points?, cut? }] }. A plain move has duration 0 and curve null (its int8 pieces at one instant
// are joined); a glide pushed out by a 5th one gets cut (ms after its start, when its remainder
// is added at once). lengthMs = when the last step has fired and every glide has finished.
function timeline(steps) {
  const moves = [];
  let t = 0, last = null;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    t += s.delay;
    if (s.type === EV.move) {
      const dx = s.a << 24 >> 24, dy = s.b << 24 >> 24;
      if (last && last.start === t) { last.dx += dx; last.dy += dy; } else moves.push(last = { start: t, duration: 0, dx, dy, curve: null });
      continue;
    }
    last = null;
    if (s.type !== EV.glide) continue;
    const [a1, a2, a3, a4] = steps.slice(i + 1, i + 5);
    const m = { start: t, duration: a1.a | (a1.b << 8), dx: i16(s.a, s.b), dy: (a1.delay << 16) >> 16, curve: CURVE_NAMES[a2.delay & 0xff] };
    if (DEFAULT_POWER[m.curve] !== undefined) m.power = i16(a2.a, a2.b) / 100;
    if (m.curve === 'points') m.points = [[a3.delay & 0xff, a3.delay >> 8], [a3.a, a3.b], [a4.delay & 0xff, a4.delay >> 8], [a4.a, a4.b]];
    i += m.points ? 4 : 2;
    const running = moves.filter((g) => g.duration && g.start + (g.cut ?? g.duration) > t);
    if (running.length >= MAX_GLIDES) running[0].cut = t - running[0].start;
    moves.push(m);
  }
  const lengthMs = moves.reduce((end, m) => Math.max(end, m.start + (m.cut ?? m.duration)), t);
  return { lengthMs, moves };
}

// total length in ms (for status displays), glides included
const sequenceMs = (steps) => timeline(steps).lengthMs;

// text / JSON -> { lengthMs, moves } with each glide's curve function f(0..1), for previews
function sequenceMoves(input) {
  const tl = timeline(parseSequence(input));
  return { ...tl, moves: tl.moves.map((m) => ({ ...m, f: m.curve ? glideCurve(m.curve, m.power, m.points) : null })) };
}

const hasGlide = (steps) => steps.some((s) => s.type === EV.glide);

module.exports = { parseSequence, sequenceMs, timeline, sequenceMoves, hasGlide, glideCurve, TAP_HOLD_MS };
