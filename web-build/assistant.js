// src/assistant.js for the browser build: the Assistant keeps its API key on the PC and calls
// DeepSeek from the web UI server, so it needs the desktop app (no key in browser storage).
const why = 'The Assistant needs the desktop app.';
const no = async () => { throw Object.assign(new Error(why), { status: 501 }); };
module.exports = {
  createAssistant: () => ({
    status: () => ({ web: true, reason: why, key: { set: false, masked: null }, pending: null }),
    setKey: no, clearKey: no, chat: no, confirm: no, reset: no,
  }),
};
