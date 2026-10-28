// Fake open firmware for key action map tests: CAPS plus a key action table like the 0xEE
// contract (entries, max 6 rules, LIST 2 slots per page so paging is exercised). engine: 2 adds
// INFO v2 ([12] engine, [13] 15 conditions, [14] 3 modes, [15] active modes), the condition table
// (COND_GET / COND_SET: bad entry 3, bad idx 4, clearing a used entry 5) and mode names (MODE_GET /
// MODE_SET), and SET refuses a rule that names an unused condition (3 + rule index). Engine 1
// refuses any condition bits (an unknown trigger byte) and the new sub-commands. Engine 3 (engine: 3)
// takes an ARG rule's mode / c bit 0 (mouse keys shared speed); engine 2 refuses them (bad rule). Engine 4
// (engine: 4) takes c bits 1..2 (speed by pressure: 1, both: 2; 3 refused) with the DEPTH rule right after
// the ARG rule ([0x0F, 0, 0, 0, FROM, TO, 0, 0], 0 <= FROM < TO <= 40); engine 3 refuses those bits, and
// every engine refuses an ARG rule that is not right after a mouse keys rule (or its DEPTH rule) or a
// missing DEPTH rule (3 + rule index; a missing DEPTH rule: the ARG rule's, as the firmware). Engine 5
// (engine: 5) takes condition key bytes 0x80..0xFE (slot & 0x7F must not be held); older ones refuse them.
// caps3 (CAPS word 3): with bit 9 'modeFlash' a FLASH rule (output 11) is taken with its count (mode byte)
// 1..15; without it, or with another count, refused (3 + rule index), as the firmware does.
// set(slot, body) may return an error code (refused) or other bytes to store instead.
const { Keyboard } = require('../../src/keyboard');
const M = require('../../src/key-modes');

const KEYS = [{ slot: 14, name: 'W' }, { slot: 9, name: 'A' }, { slot: 15, name: 'S' }, { slot: 21, name: 'D' }, { slot: 3, name: 'E' }];
const FREE = [0xff, 0xff, 0xff, 0];
const ruleCond = (body, i) => body[8 + i * 8] >> 4;
// the index of the first ARG / DEPTH rule this engine refuses (undefined: none)
function badArgRule(body, engine) {
  const n = Math.min(body[1], 6), at = (i) => body.slice(8 + i * 8, 16 + i * 8), isArg = (i) => i < n && (at(i)[0] & 0x0f) === 15;
  for (let i = 0; i < n; i++) {
    if (!isArg(i)) continue;
    const prev = i ? at(i - 1) : null, x = at(i);
    if (!prev || isArg(i - 1) || prev[4] !== 9) return i;                         // not right after a mouse keys rule
    if (engine < 3 && (x[1] || x[7])) return i;
    if (x[7] & (engine < 4 ? ~1 : ~7) || ((x[7] >> 1) & 3) === 3) return i;     // SPEEDBY bits (engine 4), 3 refused
    if (!((x[7] >> 1) & 3)) continue;
    if (!isArg(i + 1)) return i;                                                 // the DEPTH rule is missing: the ARG
    const d = at(i + 1);
    if (d[0] !== 0x0f || d[1] || d[2] || d[3] || d[6] || d[7] || !(d[4] < d[5]) || d[5] > 40) return i + 1;
    i++;
  }
  return undefined;
}

function fakeKeyboard({ caps2 = 1 << 15, caps3 = 0, entries = 4, custom = true, set = () => undefined, engine = 1, keys = KEYS, active = 0 } = {}) {
  const sent = [], table = new Map();
  const conds = Array.from({ length: 15 }, () => [...FREE]), names = ['', '', ''];
  const used = (idx) => [...table.values()].some((b) => [...Array(b[1]).keys()].some((i) => ruleCond(b, i) === idx));
  function setRecord(r, slot, body) {
    const rules = [...Array(Math.min(body[1], 6)).keys()];
    const badCond = rules.find((i) => ruleCond(body, i) && (engine < 2 || M.isFree(conds[ruleCond(body, i) - 1])));
    const badArg = badArgRule(body, engine);
    const flashOk = (caps3 & 0x8200) === 0x8200;
    const badFlash = rules.find((i) => (body[8 + i * 8] & 0x0f) !== 15 && body[12 + i * 8] === 11 && (!flashOk || body[9 + i * 8] < 1 || body[9 + i * 8] > 15));
    if (slot >= 128 || body[0] !== slot) r[2] = 4;
    else if (body[1] > 6) { r[2] = 3; r[3] = 0xff; }
    else if (badCond !== undefined) { r[2] = 3; r[3] = badCond; }
    else if (badArg !== undefined) { r[2] = 3; r[3] = badArg; }
    else if (badFlash !== undefined) { r[2] = 3; r[3] = badFlash; }
    else if (!body[1]) table.delete(slot);
    else if (!table.has(slot) && table.size >= entries) r[2] = 2;
    else { table.set(slot, body); r.splice(8, 56, ...body); }
  }
  function condCmd(r, p, idx) {
    r[3] = idx;
    if (idx < 1 || idx > 15) { r[2] = 4; return; }
    if (p[1] === 4) { r.splice(8, 4, ...conds[idx - 1]); return; }
    const e = p.slice(8, 12);
    if (M.entryProblem(e) || (engine < 5 && e.slice(0, 3).some((k) => k !== 0xff && k >= 128))) r[2] = 3;   // not held: engine 5
    else if (M.isFree(e) && used(idx)) r[2] = 5;
    else conds[idx - 1] = e;
  }
  function modeCmd(r, p, n) {
    r[3] = n;
    if (n < 1 || n > 3) { r[2] = 4; return; }
    if (p[1] === 6) {
      const b = [...Buffer.from(names[n - 1])];
      r[4] = active;
      r.splice(8, 16, ...b, ...new Array(16 - b.length).fill(0));
      return;
    }
    const b = p.slice(8, 24), end = b.indexOf(0) < 0 ? 16 : b.indexOf(0);
    if (b.slice(end).some(Boolean)) r[2] = 3;
    else names[n - 1] = Buffer.from(b.slice(0, end)).toString('utf8');
  }
  const t = {
    async query(p) {
      sent.push(p);
      const r = [...p];
      if (p[0] === 0xf8) { r[8] = caps2 & 0xff; r[9] = caps2 >> 8; r[10] = caps3 & 0xff; r[11] = caps3 >> 8; return r; }
      if (p[0] !== 0xee) return r;
      r.fill(0, 2);
      const slot = p[2];
      if (p[1] === 0) Object.assign(r, { 8: entries, 9: 6, 10: table.size, 11: 56 }, engine >= 2 && { 12: engine, 13: 15, 14: 3, 15: active });
      if (p[1] === 1) { r[3] = slot; if (table.has(slot)) r.splice(8, 56, ...table.get(slot)); else r[2] = 1; }
      if (p[1] === 2) {
        let body = p.slice(8, 64);
        const hook = set(slot, body);
        if (typeof hook === 'number') r[2] = hook;
        else if (Array.isArray(hook)) body = hook;
        if (hook === undefined || Array.isArray(hook)) setRecord(r, slot, body);
      }
      if (p[1] === 3) {
        const list = [...table.keys()].sort((x, y) => x - y).filter((s) => s >= slot).slice(0, 2);
        Object.assign(r, { 3: list.length, 4: table.size });
        list.forEach((s, i) => { r[8 + i] = s; });
      }
      if (p[1] >= 4 && engine < 2) r[2] = 4;
      else if (p[1] === 4 || p[1] === 5) condCmd(r, p, slot);
      else if (p[1] === 6 || p[1] === 7) modeCmd(r, p, slot);
      return r;
    },
    async send(p) { sent.push(p); },
    async flash(packets) { sent.push(...packets); },
    close() {},
  };
  const kb = new Keyboard(t);
  kb.info = { boardId: 2755, firmware: 'test', custom, unitMm: 0.005 };
  kb.listKeys = async () => keys;
  kb.closed = 0;
  kb.close = () => { kb.closed++; };
  return { kb, sent, table, conds, names };
}

module.exports = { fakeKeyboard };
