#!/usr/bin/env node
// Copies CodeMirror 5 (npm `codemirror@5`, MIT) into web/vendor/codemirror/ so the page serves it itself:
// no CDN at runtime. Runs after `npm install` (postinstall, after vendor-blockly.js) and before
// `npm run build:web`. The Key wizard's Code tab loads these files only when it is opened (web/kb-code.js).
// web/vendor/ is generated (git-ignored). Usage: node scripts/vendor-codemirror.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'web', 'vendor', 'codemirror');
// the editor, JavaScript colouring, brackets, hints (autocomplete) and the lint gutter (Check's errors)
const FILES = ['lib/codemirror.js', 'lib/codemirror.css', 'mode/javascript/javascript.js',
  'addon/edit/matchbrackets.js', 'addon/edit/closebrackets.js', 'addon/hint/show-hint.js', 'addon/hint/show-hint.css',
  'addon/hint/javascript-hint.js', 'addon/lint/lint.js', 'addon/lint/lint.css', 'LICENSE'];

function vendorCodemirror() {
  const roots = [path.join(ROOT, 'node_modules'), ...(process.env.NODE_PATH ?? '').split(path.delimiter).filter(Boolean)];
  const dir = roots.map((r) => path.join(r, 'codemirror')).find((d) => fs.existsSync(path.join(d, 'lib', 'codemirror.js')));
  if (!dir) throw new Error('codemirror is not installed: run npm install');
  const version = require(path.join(dir, 'package.json')).version;
  fs.rmSync(OUT, { recursive: true, force: true });
  for (const f of FILES) {
    const to = path.join(OUT, f === 'LICENSE' ? 'LICENSE.txt' : f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(dir, f), to);
  }
  fs.writeFileSync(path.join(OUT, 'VERSION'), `codemirror ${version} (MIT, Copyright Marijn Haverbeke and others), copied from npm by scripts/vendor-codemirror.js\n`);
  return { dir: OUT, version };
}

if (require.main === module) {
  try { const r = vendorCodemirror(); console.log(`codemirror ${r.version} -> ${path.relative(ROOT, r.dir)}`); } catch (e) { console.error(e.message); process.exit(1); }
}

module.exports = { vendorCodemirror };
