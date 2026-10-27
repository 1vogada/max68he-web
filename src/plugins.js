// Optional features ship as plugins: a folder plugins/<name>/ with an index.js.
// Delete the folder and the feature is gone; nothing in the core refers to it.
//
// index.js exports { name, routes?, mcp? }:
//   routes({ keyboard, httpError, intIn }) -> { 'POST /api/...': async (body) => data }
//   mcp({ server, z, tool, OPEN_FW })      registers MCP tools
// Files in plugins/<name>/web/ are served at /plugins/<name>/...; its .js and
// .css files load into the web UI after the page starts.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'plugins');

function loadPlugins() {
  if (!fs.existsSync(ROOT)) return [];
  return fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(ROOT, d.name, 'index.js')))
    .map((d) => {
      const dir = path.join(ROOT, d.name);
      const web = path.join(dir, 'web');
      const files = fs.existsSync(web) ? fs.readdirSync(web).sort() : [];
      return {
        ...require(path.join(dir, 'index.js')),
        id: d.name,
        webDir: web,
        scripts: files.filter((f) => f.endsWith('.js')).map((f) => `/plugins/${d.name}/${f}`),
        styles: files.filter((f) => f.endsWith('.css')).map((f) => `/plugins/${d.name}/${f}`),
      };
    });
}

module.exports = { loadPlugins, ROOT };
