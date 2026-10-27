// Remap presets (like Wootility's): physical key (its label on this board) -> what it sends.
// Layouts change the main layer and list only keys that move; "Default" puts every key back to
// itself (worked out from the board on the page). "Function" fills Fn layer 1 for a 68% board:
// F1-F12 on the number row, ` on Esc, media on the arrows. Fn + Home / Del / PgUp / PgDn stay
// free: the firmware uses them to pick Fn layers. Used by remap-palette.js and the tests.
(() => {
  const row = (from, to) => Object.fromEntries([...from].map((k, i) => [k, to[i]]));
  const PRESETS = {
    default: { name: 'Default', layer: 'base', icon: '⌨', note: 'Every key on the main layer back to what its label says.', keys: null },
    function: { name: 'Function', layer: 'fn', icon: 'ƒ', note: 'Fn layer 1: F1-F12 on 1 to =, ` on Esc, volume on ↑ ↓, tracks on ← →, play / pause on Space, mute on M.',
      keys: { ...Object.fromEntries([...'1234567890-='].map((k, i) => [k, `F${i + 1}`])), Esc: '`',
        Up: 'VolumeUp', Down: 'VolumeDown', Left: 'PrevTrack', Right: 'NextTrack', Space: 'PlayPause', M: 'Mute' } },
    dvorak: { name: 'Dvorak', layer: 'base', icon: 'AOEUI', note: 'Dvorak (US): vowels under the left hand, common consonants under the right.',
      keys: { ...row('QWERTYUIOP[]', ["'", ',', '.', 'P', 'Y', 'F', 'G', 'C', 'R', 'L', '/', '=']),
        ...row("ASDFGHJKL;'", ['A', 'O', 'E', 'U', 'I', 'D', 'H', 'T', 'N', 'S', '-']),
        ...row('ZXCVBNM,./', [';', 'Q', 'J', 'K', 'X', 'B', 'M', 'W', 'V', 'Z']), '-': '[', '=': ']' } },
    colemak: { name: 'Colemak', layer: 'base', icon: 'ARSTD', note: 'Colemak: QWERTY with 17 keys moved; Z X C V and the shortcuts stay put.',
      keys: { ...row('ERTYUIOP', ['F', 'P', 'G', 'J', 'L', 'U', 'Y', ';']), ...row('SDFGJKL;', ['R', 'S', 'T', 'D', 'N', 'E', 'I', 'O']), N: 'K' } },
    workman: { name: 'Workman', layer: 'base', icon: 'ASHTG', note: 'Workman: less sideways finger travel than Colemak.',
      keys: { ...row('WERTYUIOP', ['D', 'R', 'W', 'B', 'J', 'F', 'U', 'P', ';']), ...row('DFGHJKL;', ['H', 'T', 'G', 'Y', 'N', 'E', 'O', 'I']),
        ...row('CVBNM', ['M', 'C', 'V', 'K', 'L']) } },
    leet: { name: '1337', layer: 'base', icon: '1337', note: 'For fun: A E I O S T B G Z type 4 3 1 0 5 7 8 6 2 (those letters are gone until you undo or pick Default).',
      keys: { A: '4', E: '3', I: '1', O: '0', S: '5', T: '7', B: '8', G: '6', Z: '2' } },
    abc: { name: 'ABC', layer: 'base', icon: 'ABC', note: 'Letters in alphabetical order across the rows (A-J top, K-T middle, U-Z bottom); ; moves to M.',
      keys: { ...row('QWERTYUIOP', [...'ABCDEFGHIJ']), ...row('ASDFGHJKL;', [...'KLMNOPQRST']), ...row('ZXCVBNM', [...'UVWXYZ', ';']) } },
  };
  if (typeof module !== 'undefined') module.exports = { PRESETS };
  else { window.App = window.App || {}; window.App.remapPresets = PRESETS; }
})();
