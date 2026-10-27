// Games plugin: game mode on the keyboard (Fn+Ctrl+G) and its 10 on-board games.
// Needs firmware built with GAMES=1 (CAPS feature 'games'). Remove this folder to
// ship the driver without it.
const P = require('../../src/protocol');

// Firmware order (common/games/gamemode.c). key = how to start it from the menu.
const GAMES = [
  { name: 'Whack-a-mole', key: '1', how: 'Letter keys light up: hit them before they fade. It gets faster; three misses and it is over (lives on 1 2 3).', score: 'hits' },
  { name: 'Simon', key: '2', how: 'Q, P, Z and / flash a sequence: repeat it. One more step every round.', score: 'rounds' },
  { name: 'Reaction test', key: '3', how: 'Wait for a key to turn white, then hit it. 5 rounds; pressing early is a foul.', score: 'ms', lower: true },
  { name: 'Rhythm', key: '4', how: 'Notes fall down four lanes (3-E-D, 4-R-F, 7-U-J, 8-I-K): hit D F J K as they land. Ten misses ends it.', score: 'hits' },
  { name: 'Snake', key: '5', how: 'Plays on the typing keys (numbers, letters, punctuation). Steer with the arrows or WASD; eat the red dot. Past an edge you come back in on the other side; only running into yourself ends it.', score: 'length' },
  { name: 'Pong', key: '6', how: 'Two players. How deep you press Left Ctrl (left paddle) or the Right arrow (right paddle) sets its height. First to 5.', score: 'pong' },
  { name: 'Memory', key: '7', how: '12 letter keys hide 6 colour pairs. Find them all in as few tries as you can.', score: 'tries', lower: true },
  { name: 'Pressure precision', key: '8', how: 'Hold any key at the depth the white number key shows (your depth is blue) until it locks. 8 rounds; faster is more points.', score: 'points' },
  { name: 'Balance', key: '9', how: 'Keep the white dot on the home row away from the red edges: A pushes left, L pushes right, as hard as you press. The wind keeps growing.', score: 'seconds' },
  { name: 'Charge-and-throw', key: '] then 1', how: 'Hold a key to charge; the power on the number row swings up and down. Let go to throw along the top row and land in the green zone. 6 throws.', score: 'points' },
];

function formatScore(g, v) {
  if (g.score === 'ms') return `${v} ms average`;
  if (g.score === 'seconds') return `${(v / 10).toFixed(1)} s`;
  if (g.score === 'pong') return `${Math.floor(v / 10)} – ${v % 10}`;
  return `${v} ${g.score}`;
}

const packet = (action, game = 0) => P.hostPacket(0xfe, [8, action, game]);

function parseState(r) {
  const played = r[52] | (r[53] << 8);
  return {
    on: r[8] === 1, page: r[9], playing: r[10] ? GAMES[r[10] - 1]?.name ?? null : null,
    games: GAMES.map((g, k) => {
      const v = (r[12 + 4 * k] | (r[13 + 4 * k] << 8) | (r[14 + 4 * k] << 16) | (r[15 + 4 * k] << 24)) | 0;
      const was = Boolean(played & (1 << k));
      return { index: k, ...g, lastScore: was ? v : null, lastScoreText: was ? formatScore(g, v) : null };
    }),
  };
}

async function supported(k) {
  return Boolean(k.info?.custom) && (await k.getCaps()).features.includes('games');
}

async function state(k) {
  if (!(await supported(k))) return { supported: false, games: GAMES.map((g, index) => ({ index, ...g })) };
  return { supported: true, ...parseState(await k.t.query(packet(0))) };
}

async function command(k, action, game = 0) {
  if (!(await supported(k))) throw Object.assign(new Error('this firmware has no games (needs a GAMES=1 build)'), { status: 400 });
  return { supported: true, ...parseState(await k.t.query(packet(action, game))) };
}

function gameIndex(v) {
  if (Number.isInteger(v) && v >= 0 && v < GAMES.length) return v;
  const k = GAMES.findIndex((g) => g.name.toLowerCase() === String(v).toLowerCase());
  if (k < 0) throw Object.assign(new Error(`game is one of: ${GAMES.map((g) => g.name).join(', ')}`), { status: 400 });
  return k;
}

module.exports = {
  name: 'Games',
  GAMES, parseState, formatScore,

  routes: ({ keyboard }) => ({
    'POST /api/games/state': async () => state(await keyboard()),
    'POST /api/games/mode': async (body) => command(await keyboard(), body.on ? 1 : 2),
    'POST /api/games/play': async (body) => command(await keyboard(), 3, gameIndex(body.game)),
  }),

  mcp: ({ server, z, tool, OPEN_FW }) => {
    server.registerTool('get_games', {
      description: 'Game mode (Fn+Ctrl+G on the keyboard): whether it is on, which game runs, and every game with how to play and its last score. ' + OPEN_FW,
    }, tool((k) => state(k)));
    server.registerTool('set_game_mode', {
      description: 'Turn game mode on or off. While on, no key reaches the PC (Esc or unplugging always gets out). ' + OPEN_FW,
      inputSchema: { on: z.boolean() },
    }, tool((k, { on }) => command(k, on ? 1 : 2)));
    server.registerTool('play_game', {
      description: 'Start an on-board game (enters game mode): ' + GAMES.map((g) => g.name).join(', ') + '. ' + OPEN_FW,
      inputSchema: { game: z.string().describe('game name, e.g. "Snake"') },
    }, tool((k, { game }) => command(k, 3, gameIndex(game))));
  },
};
