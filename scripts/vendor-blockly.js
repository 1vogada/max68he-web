#!/usr/bin/env node
// Copies Blockly (npm `blockly`, Apache-2.0) into web/vendor/blockly/ so the page serves it itself:
// no CDN at runtime. Runs after `npm install` (postinstall) and before `npm run build:web`. The
// Key wizard's Blocks view loads these files only when it is opened (web/key-blocks.js).
// web/vendor/ is generated (git-ignored). Usage: node scripts/vendor-blockly.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'web', 'vendor', 'blockly');
const FILES = ['blockly_compressed.js', 'msg/en.js'];

function vendorBlockly() {
  // node_modules here, or a shared one on NODE_PATH (blockly's exports hide its package.json from require.resolve)
  const roots = [path.join(ROOT, 'node_modules'), ...(process.env.NODE_PATH ?? '').split(path.delimiter).filter(Boolean)];
  const dir = roots.map((r) => path.join(r, 'blockly')).find((d) => fs.existsSync(path.join(d, 'blockly_compressed.js')));
  if (!dir) throw new Error('blockly is not installed: run npm install');
  const version = require(path.join(dir, 'package.json')).version;
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'msg'), { recursive: true });
  for (const f of FILES) fs.copyFileSync(path.join(dir, f), path.join(OUT, f));
  fs.cpSync(path.join(dir, 'media'), path.join(OUT, 'media'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'web-build', 'APACHE-2.0.txt'), path.join(OUT, 'LICENSE.txt'));
  fs.writeFileSync(path.join(OUT, 'VERSION'), `blockly ${version} (Apache-2.0, Copyright Google LLC), copied from npm by scripts/vendor-blockly.js\n`);
  return { dir: OUT, version };
}

if (require.main === module) {
  try { const r = vendorBlockly(); console.log(`blockly ${r.version} -> ${path.relative(ROOT, r.dir)}`); } catch (e) { console.error(e.message); process.exit(1); }
}

module.exports = { vendorBlockly };
