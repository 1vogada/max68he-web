// src/lock.js for the browser build: WebHID gives the page its own handle; there is no
// other program on this side to share the keyboard with, so the lock is a no-op.
module.exports = { acquire() {}, release() {}, fileFor: () => '', startedAt: () => null, FILE: '', OWNER: 'this page', STARTED: 0 };
