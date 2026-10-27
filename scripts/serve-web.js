#!/usr/bin/env node
// Serves the built web version (site/, from npm run build:web) on http://localhost:6880.
// WebHID needs a secure page; localhost counts. Usage: node scripts/serve-web.js [port]
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'site');
const PORT = Number(process.argv[2] || 6880);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.map': 'application/json', '.json': 'application/json' };

http.createServer((req, res) => {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end(); }
  const file = path.normalize(path.join(ROOT, rel === '/' ? 'index.html' : rel));
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, '127.0.0.1', () => console.log(`web version: http://localhost:${PORT} (open it in Chrome or Edge)`));
