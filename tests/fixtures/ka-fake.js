// Fake open firmware for key action map tests: CAPS plus a key action table like the 0xEE
// contract (entries, max 6 rules, LIST 2 slots per page so paging is exercised).
// set(slot, body) may return an error code (refused) or other bytes to store instead.
const { Keyboard } = require('../../src/keyboard');

function fakeKeyboard({ caps2 = 1 << 15, entries = 4, custom = true, set = () => undefined } = {}) {
  const sent = [], table = new Map();
  const t = {
    async query(p) {
      sent.push(p);
      const r = [...p];
      if (p[0] === 0xf8) { r[8] = caps2 & 0xff; r[9] = caps2 >> 8; return r; }
      if (p[0] !== 0xee) return r;
      r.fill(0, 2);
      const slot = p[2];
      if (p[1] === 0) Object.assign(r, { 8: entries, 9: 6, 10: table.size, 11: 56 });
      if (p[1] === 1) { r[3] = slot; if (table.has(slot)) r.splice(8, 56, ...table.get(slot)); else r[2] = 1; }
      if (p[1] === 2) {
        let body = p.slice(8, 64);
        const hook = set(slot, body);
        if (typeof hook === 'number') r[2] = hook;
        else if (Array.isArray(hook)) body = hook;
        if (hook === undefined || Array.isArray(hook)) {
          if (slot >= 128 || body[0] !== slot) r[2] = 4;
          else if (body[1] > 6) { r[2] = 3; r[3] = 0xff; }
          else if (!body[1]) table.delete(slot);
          else if (!table.has(slot) && table.size >= entries) r[2] = 2;
          else { table.set(slot, body); r.splice(8, 56, ...body); }
        }
      }
      if (p[1] === 3) {
        const list = [...table.keys()].sort((x, y) => x - y).filter((s) => s >= slot).slice(0, 2);
        Object.assign(r, { 3: list.length, 4: table.size });
        list.forEach((s, i) => { r[8 + i] = s; });
      }
      return r;
    },
    async send(p) { sent.push(p); },
    async flash(packets) { sent.push(...packets); },
    close() {},
  };
  const kb = new Keyboard(t);
  kb.info = { boardId: 2755, firmware: 'test', custom, unitMm: 0.005 };
  kb.listKeys = async () => [{ slot: 14, name: 'W' }, { slot: 9, name: 'A' }, { slot: 15, name: 'S' }, { slot: 21, name: 'D' }, { slot: 3, name: 'E' }];
  kb.closed = 0;
  kb.close = () => { kb.closed++; };
  return { kb, sent, table };
}

module.exports = { fakeKeyboard };
