// src/flasher.js for the browser build: flashing runs ry-flash, a program, so it needs
// the desktop app for now (porting the updater protocol to WebHID would lift this).
const job = { running: false, log: [], ok: null, error: null, outcome: null, inUpdater: false };
module.exports = {
  job, web: true,
  listImages: () => [],
  flasherPresent: () => false,
  config: () => ({ flasher: 'the desktop app (flashing is not available in the web version yet)', firmwareDir: '' }),
  flash: async () => { throw Object.assign(new Error('Flashing needs the desktop app for now.'), { status: 501 }); },
  classify: () => ({ kind: 'stop' }), run: async () => ({ code: null }), describeExit: () => '',
};
