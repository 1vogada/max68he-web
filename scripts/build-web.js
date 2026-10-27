#!/usr/bin/env node
// Builds the web version into site/ (npm run build:web): the same page as the desktop
// app (web/), plus site/driver.js, the driver bundled for the browser. Node-only modules
// are swapped for web-build/ stand-ins: node-hid -> WebHID, fs -> localStorage, and the
// lock, flasher and app watcher (desktop-only) -> stubs. Plugins are listed at build time.
// Firmware: firmware/ (manifest.json, the open-firmware builds and their licences) goes on the
// site as it is. The public repo has it (publish-firmware.js puts it there); MAX68HE_SITE_FIRMWARE
// may name another folder. Without one the site gets an empty list and hosts no firmware.
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'site');
const SHIMS = path.join(ROOT, 'web-build');
const NODE_SHIMS = ['fs', 'path', 'os', 'crypto', 'child_process', 'http'];
// src modules swapped as a whole (matched by their file name inside src/)
const SRC_SHIMS = { 'lock.js': 'lock.js', 'flasher.js': 'flasher.js', 'appwatch.js': 'appwatch.js' };

function plugins() {
  const dir = path.join(ROOT, 'plugins');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'index.js')))
    .map((d) => {
      const web = path.join(dir, d.name, 'web');
      const files = fs.existsSync(web) ? fs.readdirSync(web).sort() : [];
      return { id: d.name, index: path.join(dir, d.name, 'index.js').replace(/\\/g, '/'), web, files };
    });
}

// src/plugins.js for the page: the plugins found now, with page-relative file paths
function pluginsModule(list) {
  return `module.exports = { ROOT: '/plugins', loadPlugins: () => [${list.map((p) => `{ ...require(${JSON.stringify(p.index)}), id: ${JSON.stringify(p.id)},
    scripts: ${JSON.stringify(p.files.filter((f) => f.endsWith('.js')).map((f) => `plugins/${p.id}/${f}`))},
    styles: ${JSON.stringify(p.files.filter((f) => f.endsWith('.css')).map((f) => `plugins/${p.id}/${f}`))} }`).join(', ')}] };`;
}

const shimPlugin = (list) => ({
  name: 'max68he-web-shims',
  setup(b) {
    b.onResolve({ filter: new RegExp(`^(node:)?(${NODE_SHIMS.join('|')})$`) }, (a) => ({ path: path.join(SHIMS, `${a.path.replace(/^node:/, '')}.js`) }));
    b.onResolve({ filter: /^node-hid$/ }, () => ({ path: path.join(SHIMS, 'node-hid.js') }));
    b.onResolve({ filter: /^\.\.?\// }, (a) => {
      const full = path.resolve(a.resolveDir, a.path);
      const rel = path.relative(path.join(ROOT, 'src'), full).replace(/\\/g, '/');
      const base = rel.replace(/\.js$/, '');
      if (base === 'plugins') return { path: 'plugins', namespace: 'gen' };
      const shim = SRC_SHIMS[`${base}.js`];
      return shim ? { path: path.join(SHIMS, shim) } : undefined;
    });
    b.onLoad({ filter: /.*/, namespace: 'gen' }, () => ({ contents: pluginsModule(list), resolveDir: ROOT, loader: 'js' }));
  },
});

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b); else fs.copyFileSync(a, b);
  }
}

const FIRMWARE = process.env.MAX68HE_SITE_FIRMWARE
  ?? (fs.existsSync(path.join(ROOT, 'firmware', 'manifest.json')) ? path.join(ROOT, 'firmware') : null);

async function build({ outDir = OUT, minify = true, firmwareDir = FIRMWARE } = {}) {
  const list = plugins();
  fs.rmSync(outDir, { recursive: true, force: true });
  copyDir(path.join(ROOT, 'web'), outDir);
  for (const p of list) if (fs.existsSync(p.web)) copyDir(p.web, path.join(outDir, 'plugins', p.id));
  const r = await esbuild.build({
    metafile: true,
    entryPoints: [path.join(SHIMS, 'main.js')],
    bundle: true, format: 'iife', platform: 'browser', target: ['chrome100'],
    outfile: path.join(outDir, 'driver.js'), minify, sourcemap: true, logLevel: 'warning',
    inject: [path.join(SHIMS, 'process.js')],
    define: { __dirname: '"/app/src"', 'process.env.NODE_ENV': '"production"' },
    plugins: [shimPlugin(list)],
  });
  // the driver loads before the page's own scripts; the web version's bar has its own CSS
  const html = path.join(outDir, 'index.html');
  let page = fs.readFileSync(html, 'utf8');
  page = page.replace('<script src="ui.js"></script>', '<script src="driver.js"></script>\n  <script src="ui.js"></script>');
  if (!page.includes('driver.js')) throw new Error('index.html: could not place driver.js before ui.js');
  page = page.replace('</head>', '  <link rel="stylesheet" href="web-version.css">\n</head>');
  fs.writeFileSync(html, page);
  fs.copyFileSync(path.join(SHIMS, 'web-version.css'), path.join(outDir, 'web-version.css'));
  fs.copyFileSync(path.join(SHIMS, 'THIRD_PARTY_NOTICES.md'), path.join(outDir, 'THIRD_PARTY_NOTICES.md'));
  fs.writeFileSync(path.join(outDir, '.nojekyll'), '');   // GitHub Pages: serve files as they are
  if (firmwareDir) copyDir(firmwareDir, path.join(outDir, 'firmware'));
  else {
    fs.mkdirSync(path.join(outDir, 'firmware'));
    fs.writeFileSync(path.join(outDir, 'firmware', 'manifest.json'), '{ "images": [] }\n');   // an empty list
  }
  build.inputs = Object.keys(r.metafile.inputs);          // what went into driver.js (tests check it)
  return outDir;
}

if (require.main === module) {
  build({ minify: !process.argv.includes('--dev') })
    .then((dir) => console.log(`web version built in ${path.relative(ROOT, dir)}/ (serve it, then open index.html in Chrome or Edge)`))
    .catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { build };
