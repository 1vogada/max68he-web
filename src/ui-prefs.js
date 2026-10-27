// Web UI preferences that hold for every browser on this PC, kept in config/ui.json
// (local, git-ignored). No file means every preference has its default.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'config', 'ui.json');
const DEFAULTS = {
  marqueeEverywhere: false,   // selection box on every drawn keyboard
  layers: false,              // the Layers page (Layer 1-3) and MO1-3 / TG1-3 in the key picker
  fnLayers: 1,                // Fn layers on Remap's layer row (Add layer), 1..4; ones in use always show
};
const RANGES = { fnLayers: [1, 4] };   // whole numbers in this range

function read(file = FILE) {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* defaults */ }
  const out = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (typeof saved?.[k] === typeof DEFAULTS[k]) out[k] = saved[k];
  return out;
}

// Merges known keys of the right type into the file; anything else is refused.
function write(changes, file = FILE) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw badRequest('preferences must be an object');
  const next = read(file);
  for (const [k, v] of Object.entries(changes)) {
    if (!(k in DEFAULTS)) throw badRequest(`unknown preference: ${k}`);
    if (typeof v !== typeof DEFAULTS[k]) throw badRequest(`${k} must be a ${typeof DEFAULTS[k]}`);
    const r = RANGES[k];
    if (r && !(Number.isInteger(v) && v >= r[0] && v <= r[1])) throw badRequest(`${k} must be a whole number ${r[0]}..${r[1]}`);
    next[k] = v;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 1));
  return next;
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

const routes = (file = FILE) => ({
  'GET /api/ui-prefs': async () => read(file),
  'POST /api/ui-prefs': async (body) => write(body, file),
});

module.exports = { FILE, DEFAULTS, read, write, routes };
