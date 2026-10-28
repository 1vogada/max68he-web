// The MAX68HE (board 2755) factory keymap as listKeys() reads it: stock slot = column * 6 + row,
// from x68max-firmware firmware/profiles/2755.toml (vendor factory keymap). The driver resolves key
// names through the live keymap; this is that keymap on a board nobody has remapped.
const COLUMNS = [
  [null, 'Esc', 'Tab', 'Caps', 'LShift', 'LCtrl'], [null, '1', 'Q', 'A', null, 'LWin'], [null, '2', 'W', 'S', 'Z', 'LAlt'],
  [null, '3', 'E', 'D', 'X'], [null, '4', 'R', 'F', 'C'], [null, '5', 'T', 'G', 'V'], [null, '6', 'Y', 'H', 'B', 'Space'],
  [null, '7', 'U', 'J', 'N'], [null, '8', 'I', 'K', 'M'], [null, '9', 'O', 'L', ',', 'RAlt'], [null, '0', 'P', ';', '.', 'Fn'],
  [null, '-', '[', "'", '/', 'RCtrl'], [null, '=', ']', null, 'RShift', 'Left'], [null, 'Bksp', '\\', 'Enter', 'Up', 'Down'],
  [null, 'Home', 'Del', 'PgUp', 'PgDn', 'Right'],
];
const MAX68HE_KEYS = COLUMNS.flatMap((rows, col) => rows.map((name, row) => name && { slot: col * 6 + row, name }).filter(Boolean))
  .sort((a, b) => a.slot - b.slot);

module.exports = { MAX68HE_KEYS };
