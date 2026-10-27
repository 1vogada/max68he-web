// crypto for the browser build: randomBytes(n).toString('hex') is all the driver uses.
function randomBytes(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return { toString: (enc) => (enc === 'hex' ? [...b].map((x) => x.toString(16).padStart(2, '0')).join('') : String.fromCharCode(...b)) };
}
module.exports = { randomBytes };
