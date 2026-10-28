// The Key wizard's Blocks workspace (Blockly JSON), kept on the PC so the blocks re-open exactly as
// built: GET /api/key-blocks -> { workspace } (null: none saved), PUT /api/key-blocks { workspace }
// (null forgets it) -> { workspace }. The key action table on the keyboard is one for all profiles,
// so there is one workspace too, in config/key-blocks.json (git-ignored; the web version's fs stand-in
// keeps it in browser storage). The keyboard's rules stay the truth: the page rebuilds blocks from
// them when nothing is saved and says so when the two drifted apart.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '..', 'config', 'key-blocks.json');
const MAX_BYTES = 60000;       // under the server's 64 KB body limit

function keyBlocksRoutes({ httpError, file = FILE }) {
  const read = () => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')).workspace ?? null; } catch { return null; }
  };
  return {
    'GET /api/key-blocks': async () => ({ workspace: read() }),
    'PUT /api/key-blocks': async (body) => {
      const ws = body?.workspace;
      if (ws !== null && (typeof ws !== 'object' || Array.isArray(ws))) throw httpError(400, 'workspace is a Blockly workspace (JSON object) or null');
      const text = JSON.stringify({ workspace: ws, savedAt: new Date().toISOString() });
      if (text.length > MAX_BYTES) throw httpError(400, `the blocks are too big to keep (${text.length} B, at most ${MAX_BYTES})`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      return { workspace: ws };
    },
  };
}

module.exports = { keyBlocksRoutes };
