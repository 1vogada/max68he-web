// The Assistant page and Settings > AI assistant (src/assistant.js, src/secrets.js):
//   GET /api/assistant -> { key: { set, masked }, pending }
//   POST /api/assistant/key { key } / DELETE /api/assistant/key -> { set, masked } (the key never comes back)
//   POST /api/assistant/chat { message } -> { events }   POST /api/assistant/confirm { id, ok } -> { events }
//   POST /api/assistant/reset
const { createAssistant } = require('../assistant');

function assistantRoutes({ conn, ...opts }) {
  const a = createAssistant({ conn, ...opts });
  return {
    'GET /api/assistant': async () => a.status(),
    'POST /api/assistant/key': async (body) => a.setKey(body?.key),
    'DELETE /api/assistant/key': async () => a.clearKey(),
    'POST /api/assistant/chat': async (body) => a.chat(body?.message),
    'POST /api/assistant/confirm': async (body) => a.confirm(body?.id, body?.ok),
    'POST /api/assistant/reset': async () => a.reset(),
  };
}

module.exports = { assistantRoutes };
