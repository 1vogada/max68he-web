// Games plugin (plugins/games): state decoding, score text, and the plugin loader.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const P = require('../src/protocol');
const { loadPlugins, ROOT } = require('../src/plugins');

const games = loadPlugins().find((p) => p.id === 'games');

test('the loader finds the games plugin with its web files, routes and MCP tools', () => {
  assert.ok(games, 'plugins/games is loaded');
  assert.deepEqual(games.scripts, ['/plugins/games/games.js']);
  assert.deepEqual(games.styles, ['/plugins/games/games.css']);
  const routes = games.routes({ keyboard: async () => ({}) });
  assert.deepEqual(Object.keys(routes).sort(), ['POST /api/games/mode', 'POST /api/games/play', 'POST /api/games/state']);
  assert.equal(typeof games.mcp, 'function');
});

test('without a plugins folder there are no plugins (the feature bundles out)', () => {
  const hidden = ROOT + '.off-test';
  fs.renameSync(ROOT, hidden);
  try {
    delete require.cache[require.resolve('../src/plugins')];
    assert.deepEqual(require('../src/plugins').loadPlugins(), []);
  } finally {
    fs.renameSync(hidden, ROOT);
    delete require.cache[require.resolve('../src/plugins')];
  }
});

test('game state reply: mode, running game, last scores', () => {
  const r = new Array(64).fill(0);
  r[8] = 1; r[9] = 0; r[10] = 3; r[11] = 10;     // on, page 1, playing game 3 (Reaction test)
  const put = (k, v) => { const o = 12 + 4 * k; r[o] = v & 255; r[o + 1] = (v >> 8) & 255; r[o + 2] = (v >> 16) & 255; r[o + 3] = (v >>> 24) & 255; };
  put(2, 215); put(5, 53); put(8, 187);
  r[52] = (1 << 2) | (1 << 5); r[53] = 1;         // played: reaction, pong, balance
  const s = games.parseState(r);
  assert.equal(s.on, true);
  assert.equal(s.playing, 'Reaction test');
  assert.equal(s.games.length, 10);
  assert.equal(s.games[2].lastScoreText, '215 ms average');
  assert.equal(s.games[5].lastScoreText, '5 – 3');
  assert.equal(s.games[8].lastScoreText, '18.7 s');
  assert.equal(s.games[0].lastScore, null);
});

test('CAPS: the second feature word reports games', () => {
  const r = new Array(64).fill(0);
  r[1] = 3; r[6] = 0xff; r[7] = 0xff; r[8] = 1;
  assert.ok(P.parseCaps(r).features.includes('games'));
  r[8] = 0;
  assert.ok(!P.parseCaps(r).features.includes('games'));
});

test('game packets: 0xFE 8 with action and game', () => {
  const pk = P.hostPacket(0xfe, [8, 3, 4]);
  assert.deepEqual(pk.slice(0, 4), [0xfe, 8, 3, 4]);
  assert.equal(path.basename(path.dirname(require.resolve('../plugins/games'))), 'games');
});
