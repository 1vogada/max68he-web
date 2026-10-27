// Extra layers (Layer 1-3) are opt-in: Settings > Interface > Extra layers (the
// `layers` UI preference, prefs.js). Off: no Layer 1-3 on Remap's layer row and no MO1-3 /
// TG1-3 in the key picker (ui.js); keys that already hold one still show its name.
(() => {
  const App = (window.App = window.App || {});
  App.views = App.views || {};

  function show() {
    const on = Boolean(App.prefs.get('layers'));
    const box = App.$('#extra-layers');
    box.checked = on;
    App.renderLayers?.();
    if (!on && App.st.view === 'layers') App.goto('keymap');   // its layers went away: go to the main layer
  }

  App.views.extraLayers = {
    init() {
      const box = App.$('#extra-layers');
      box.onchange = () => App.prefs.set('layers', box.checked).then(show);   // saved at once, like the theme
      window.addEventListener('prefschange', show);
      show();
    },
  };
})();
