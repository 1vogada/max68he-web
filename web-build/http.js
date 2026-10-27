// http for the browser build: src/web/server.js builds its server at load; in the page its
// routes are called directly (web-build/main.js), so the server object never listens.
module.exports = { createServer: () => ({ listen() {}, address: () => null, on() {}, close() {} }) };
