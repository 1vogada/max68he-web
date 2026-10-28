// Firmware feature builder (src/fw-builder.js; Features page, web/features.js + web/fw-builder.js):
// GET  /api/firmware/features -> { available, reason?, profile, features: [{ id, name, description, default, requires, caps,
//   group, storage, cost: { flash, ram } | null }], sizes: { commit, measured, full, limits } | null, alwaysOn: [{ name, reason }], stamp, job }
// POST /api/firmware/size { flags: { id: bool } } -> { flash: { used, limit }, ram: { used, limit, reserved }, key, cached }
//   builds the flag set once (not registered) and caches the numbers; unknown flags 400
// POST /api/firmware/build { flags } -> { started, key, label }; one at a time (409), progress:
// GET  /api/firmware/build -> { running, log, ok, error, id, label, size }; id = the image for POST /api/firmware/flash
const fwb = require('../fw-builder');

function fwBuilderRoutes() {
  return {
    'GET /api/firmware/features': async () => fwb.features(),
    'POST /api/firmware/size': async (body) => fwb.size(body),
    'POST /api/firmware/build': async (body) => fwb.build(body),
    'GET /api/firmware/build': async () => fwb.status(),
  };
}

module.exports = { fwBuilderRoutes };
