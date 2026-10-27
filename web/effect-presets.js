// Ready-made lighting looks for the RGB settings > Effects page. A click only fills
// the form; the user saves as usual. Each preset lists the effects it can use, best
// first, so the same preset works on stock and open firmware (or is left out).
(() => {
  const PRESETS = [
    { name: 'Calm rainbow', modes: [4], brightness: 2, speed: 0, option: 0, colour: 'rainbow' },
    { name: 'Reactive white', modes: [0x43, 5], brightness: 4, speed: 2, colour: '#ffffff' },
    { name: 'Focus orange', modes: [1], brightness: 3, speed: 0, colour: '#ff8a3d' },
    { name: 'Ocean breathing', modes: [2], brightness: 3, speed: 1, colour: '#1e90ff' },
    { name: 'Press depth', modes: [0x46, 0x42], brightness: 4, speed: 2, colour: 'rainbow' },
    { name: 'Aurora', modes: [0x4a], brightness: 3, speed: 1, colour: 'rainbow' },
    { name: 'Fire', modes: [0x49], brightness: 4, speed: 2, colour: 'rainbow' },
    // there is no "off" effect: a black static colour leaves every key dark
    { name: 'Off', modes: [1], brightness: 0, speed: 0, colour: '#000000' },
  ];

  // the presets this keyboard can show; available = the effect numbers it offers
  function presetsFor(available) {
    const have = new Set([...available].map(Number));
    return PRESETS.flatMap((p) => {
      const mode = p.modes.find((m) => have.has(m));
      return mode === undefined ? [] : [{ ...p, mode }];
    });
  }

  // a preset as a lighting state (the shape fillLightForm takes); with rainbow the
  // custom colour stays what it was, so switching back to Colour loses nothing
  function toLighting(p, current = {}) {
    const rgb = p.colour === 'rainbow' ? [current.r ?? 255, current.g ?? 255, current.b ?? 255]
      : [1, 3, 5].map((i) => parseInt(p.colour.slice(i, i + 2), 16));
    return { mode: p.mode, option: p.option ?? 0, brightness: p.brightness, speed: p.speed,
      r: rgb[0], g: rgb[1], b: rgb[2], rainbow: p.colour === 'rainbow', presetColour: null };
  }

  const api = { PRESETS, presetsFor, toLighting };
  if (typeof module !== 'undefined') module.exports = api;
  if (typeof window === 'undefined') return;

  const App = (window.App = window.App || {});

  // (Re)draw the preset buttons into el; apply(lighting) fills the form.
  function render(el, available, current, apply) {
    const list = presetsFor(available);
    el.hidden = !list.length;
    const row = el.querySelector('.preset-row');
    row.replaceChildren(...list.map((p) => {
      const b = Object.assign(document.createElement('button'), { type: 'button', textContent: p.name });
      b.title = 'Fills the form; nothing changes on the keyboard until you Save';
      b.onclick = () => apply(toLighting(p, current()));
      return b;
    }));
  }

  App.effectPresets = { render, presetsFor, toLighting };
})();
