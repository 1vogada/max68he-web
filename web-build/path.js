// path for the browser build: POSIX-style, enough for the driver's config file names.
const sep = '/';
function normalize(p) {
  const abs = String(p).startsWith('/');
  const out = [];
  for (const part of String(p).replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else if (!abs) out.push('..'); } else out.push(part);
  }
  return (abs ? '/' : '') + out.join('/') || (abs ? '/' : '.');
}
const join = (...parts) => normalize(parts.filter((x) => x !== '').join('/'));
const resolve = (...parts) => normalize(parts.reduce((acc, p) => (String(p).startsWith('/') ? p : `${acc}/${p}`), '/'));
const dirname = (p) => { const n = normalize(p); const i = n.lastIndexOf('/'); return i > 0 ? n.slice(0, i) : i === 0 ? '/' : '.'; };
const basename = (p, ext) => { const b = normalize(p).split('/').pop(); return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b; };
const extname = (p) => { const b = basename(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i) : ''; };
module.exports = { sep, normalize, join, resolve, dirname, basename, extname, posix: null };
module.exports.posix = module.exports;
