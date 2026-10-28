// API keys the PC keeps for the web UI (the Assistant page's DeepSeek key), in config/secrets.json
// (local, git-ignored, never published). The key is read here and sent only to the API it belongs
// to: the page gets "set (sk-…abcd)" at most. Never log it or put it in a URL.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'config', 'secrets.json');
const KEY_MIN = 8, KEY_MAX = 200;

const badRequest = (msg) => Object.assign(new Error(msg), { status: 400 });

function read(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  } catch { return {}; }
}

function write(data, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}

// A key as pasted: printable ASCII, no spaces or line breaks, KEY_MIN..KEY_MAX characters.
function checkKey(key) {
  if (typeof key !== 'string' || !key.length) throw badRequest('paste the API key');
  if (/\s/.test(key)) throw badRequest('the API key has spaces or line breaks in it');
  if (key.length < KEY_MIN || key.length > KEY_MAX) throw badRequest(`an API key is ${KEY_MIN}..${KEY_MAX} characters`);
  if (!/^[\x21-\x7e]+$/.test(key)) throw badRequest('the API key has characters an API key doesn\'t have');
  return key;
}

const mask = (key) => `${key.startsWith('sk-') ? 'sk-' : ''}…${key.slice(-4)}`;

const deepseekKey = (file = FILE) => (typeof read(file).deepseek === 'string' ? read(file).deepseek : null);

// What the page may see: { set, masked }
function deepseekStatus(file = FILE) {
  const k = deepseekKey(file);
  return { set: Boolean(k), masked: k ? mask(k) : null };
}

function setDeepseekKey(key, file = FILE) {
  write({ ...read(file), deepseek: checkKey(key) }, file);
  return deepseekStatus(file);
}

function clearDeepseekKey(file = FILE) {
  const { deepseek, ...rest } = read(file);
  if (deepseek !== undefined) write(rest, file);
  return deepseekStatus(file);
}

module.exports = { FILE, checkKey, mask, deepseekKey, deepseekStatus, setDeepseekKey, clearDeepseekKey };
