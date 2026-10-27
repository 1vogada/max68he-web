// fs for the browser build: the files the driver keeps in config/ (UI prefs, gamepad
// mapping, profile names, saved profiles, backups) live in localStorage under one prefix.
// Only the synchronous calls the driver uses exist. Directories are implied by file paths.
const PREFIX = 'max68he.fs:';
const BACKUPS_KEPT = 5;          // config/backups: the newest few (localStorage holds ~5 MB)
const store = () => globalThis.localStorage;
const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
const notFound = (p) => Object.assign(new Error(`ENOENT: no such file or directory, '${p}'`), { code: 'ENOENT' });

function keys() {
  const s = store(), out = [];
  for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k.startsWith(PREFIX)) out.push(k.slice(PREFIX.length)); }
  return out;
}

function readFileSync(p) {
  const v = store().getItem(PREFIX + norm(p));
  if (v === null) throw notFound(p);
  return v;
}

function writeFileSync(p, data) {
  const f = norm(p);
  try {
    store().setItem(PREFIX + f, String(data));
  } catch {
    throw Object.assign(new Error('The browser storage for this page is full: delete saved profiles or export and clear them.'), { status: 507 });
  }
  if (/\/backups\/[^/]+$/.test(f)) {                       // keep only the newest backups
    const dir = f.slice(0, f.lastIndexOf('/') + 1);
    keys().filter((k) => k.startsWith(dir)).sort().slice(0, -BACKUPS_KEPT).forEach((k) => store().removeItem(PREFIX + k));
  }
}

const existsSync = (p) => { const f = norm(p); return keys().some((k) => k === f || k.startsWith(`${f}/`)); };
const mkdirSync = () => {};
const unlinkSync = (p) => { if (!existsSync(p)) throw notFound(p); store().removeItem(PREFIX + norm(p)); };

function readdirSync(p) {
  const dir = `${norm(p)}/`;
  const names = [...new Set(keys().filter((k) => k.startsWith(dir)).map((k) => k.slice(dir.length).split('/')[0]))];
  if (!names.length) throw notFound(p);
  return names.sort();
}

function readFile(p, cb) { try { cb(null, readFileSync(p)); } catch (e) { cb(e); } }

module.exports = { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync, readFile, PREFIX };
