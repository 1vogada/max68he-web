// Games page (plugin): game mode status, every game with how to play, last
// scores, and buttons to start them on the keyboard.
(() => {
  const App = window.App;
  if (!App?.addView) return;
  const { $, api, toast, busy } = App;

  App.addView({ id: 'games', label: 'Games', icon: '🎮', after: 'stats', title: 'Games', board: false,
    hint: 'The keyboard is the console: Fn+Ctrl+G turns game mode on or off. While it is on no key reaches the PC; Esc leaves a game, Esc again (or holding Esc, or unplugging) leaves game mode.' });

  const panel = document.createElement('section');
  panel.className = 'panel wide games-panel';
  panel.dataset.views = 'games';
  panel.innerHTML = `
    <div class="games-head">
      <h2>Game mode <span class="chip" id="gm-status">…</span></h2>
      <button type="button" id="gm-toggle" class="primary">Start game mode</button>
    </div>
    <p class="muted small">On the keyboard: <b>Fn + Ctrl + G</b> opens the menu. Keys <b>1 … 9</b> light green, one per game;
      <b>[</b> and <b>]</b> light up when there are more pages. Pick a game with its number key.</p>
    <p class="muted small" id="gm-unsupported" hidden>This keyboard's firmware has no games. They need the open firmware built with GAMES=1.</p>
    <div class="games-grid" id="gm-grid"></div>`;
  $('section.panels').append(panel);

  let timer = 0;

  function render(s) {
    $('#gm-unsupported').hidden = s.supported;
    $('#gm-toggle').hidden = !s.supported;
    $('#gm-status').textContent = !s.supported ? 'not available' : s.on ? (s.playing ? `playing ${s.playing}` : 'on, in the menu') : 'off';
    $('#gm-toggle').textContent = s.on ? 'Leave game mode' : 'Start game mode';
    $('#gm-toggle').dataset.on = s.on ? '1' : '';
    const grid = $('#gm-grid');
    grid.innerHTML = '';
    for (const g of s.games) {
      const card = document.createElement('div');
      card.className = 'game-card' + (s.playing === g.name ? ' playing' : '');
      card.innerHTML = `<div class="game-top"><span class="game-key">${g.key}</span><h3></h3></div>
        <p class="small"></p>
        <p class="small muted game-score"></p>`;
      card.querySelector('h3').textContent = g.name;
      card.querySelector('p').textContent = g.how;
      card.querySelector('.game-score').textContent = g.lastScoreText ? `Last: ${g.lastScoreText}${g.lower ? ' (lower is better)' : ''}` : '';
      if (s.supported) {
        const b = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Play' });
        b.onclick = () => busy(card, `Starting ${g.name}…`, async () => { render(await api('POST', '/api/games/play', { game: g.index })); toast(`${g.name} is running on the keyboard`); });
        card.append(b);
      }
      grid.append(card);
    }
  }

  async function refresh() {
    try { render(await api('POST', '/api/games/state')); } catch (e) { $('#gm-status').textContent = e.message; }
  }

  $('#gm-toggle').onclick = () => busy(panel, 'Switching game mode…', async () => {
    render(await api('POST', '/api/games/mode', { on: !$('#gm-toggle').dataset.on }));
  });

  // poll while the page is open: the keyboard changes state on its own (Esc, game over)
  App.views.games = {
    selection: () => {
      clearInterval(timer);
      if (App.st.view !== 'games') return;
      refresh();
      timer = setInterval(() => (App.st.view === 'games' ? refresh() : clearInterval(timer)), 1500);
    },
  };
  if (App.st.view === 'games') App.views.games.selection();
})();
