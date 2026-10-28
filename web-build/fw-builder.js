// src/fw-builder.js for the browser build: building firmware runs make, so it needs the desktop app.
const job = { running: false, log: [], ok: null, error: null, id: null, label: null, flags: null, size: null };
const no = async () => { throw Object.assign(new Error('Building firmware needs the desktop app.'), { status: 501 }); };
module.exports = {
  job, web: true, status: () => job, registered: () => [], size: no, build: no,
  features: () => ({ available: false, web: true, reason: 'Building firmware needs the desktop app.', features: [], sizes: null, alwaysOn: [] }),
};
