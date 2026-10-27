// Undo / redo (like Wootility's arrows): pages record each change they write to the keyboard
// with the way back (App.history.push({ label, undo, redo })); the top bar's ↶ ↷ and
// Ctrl+Z / Ctrl+Y (Ctrl+Shift+Z) step through them. A profile switch starts a new history,
// since the steps belong to the profile they were made in.
(() => {
  const App = (window.App = window.App || {});
  App.views = App.views || {};
  const MAX = 50;
  const done = [], undone = [];
  let running = false, profile = null;

  function refresh() {
    const u = App.$('#undo'), r = App.$('#redo');
    if (!u) return;
    u.disabled = running || !done.length;
    r.disabled = running || !undone.length;
    u.title = done.length ? `Undo: ${done[done.length - 1].label} (Ctrl+Z)` : 'Nothing to undo';
    r.title = undone.length ? `Redo: ${undone[undone.length - 1].label} (Ctrl+Y)` : 'Nothing to redo';
  }

  function push(step) {
    done.push(step);
    if (done.length > MAX) done.shift();
    undone.length = 0;
    refresh();
  }

  async function step(from, to, dir) {
    if (running || !from.length || !App.ui.confirmLeave()) return;
    const h = from.pop();
    running = true;
    refresh();
    try {
      App.toast(`${dir === 'undo' ? 'Undoing' : 'Redoing'}: ${h.label}…`);
      await h[dir]();
      to.push(h);
      App.toast(`${dir === 'undo' ? 'Undone' : 'Redone'}: ${h.label}`);
    } catch (e) {
      from.push(h);                             // still there to try again
      App.toast(`Could not ${dir}: ${e.message}`, true);
    } finally {
      running = false;
      refresh();
    }
  }

  // a step while another one runs would interleave with it: pages check this before writing
  App.history = {
    push,
    undo: () => step(done, undone, 'undo'),
    redo: () => step(undone, done, 'redo'),
    get running() { return running; },
  };

  App.views.history = {
    init() {
      App.$('#undo').onclick = App.history.undo;
      App.$('#redo').onclick = App.history.redo;
      document.addEventListener('keydown', (e) => {
        if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
        if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;   // their own undo
        const k = e.key.toLowerCase();
        if (k === 'z' && !e.shiftKey) { e.preventDefault(); App.history.undo(); }
        else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); App.history.redo(); }
      });
      window.addEventListener('statechange', () => {
        if (profile !== null && App.st.profile !== profile) { done.length = 0; undone.length = 0; }
        profile = App.st.profile;
        refresh();
      });
      refresh();
    },
  };
})();
