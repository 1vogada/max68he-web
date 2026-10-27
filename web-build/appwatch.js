// src/appwatch.js for the browser build: a web page can't see which app is in front.
function watchForeground(onApp, onError = () => {}) {
  onError(new Error('switching profiles with the app in front needs the desktop app'));
  return () => {};
}
module.exports = { watchForeground };
