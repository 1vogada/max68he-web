// Web API for My profiles (profiles.js): onboard names and colours, the saved-profile library
// (save the active profile, load one into a slot, swap two slots) and app-linked switching,
// which runs while this server does (appwatch.js), like Wootility's Background service.
const profiles = require('../profiles');
const { watchForeground } = require('../appwatch');

function profileRoutes({ keyboard, conn, drop, isDeviceError, isFlashing, state, httpError, store = profiles.store(), watch = watchForeground }) {
  let stopWatch = null;
  let frontApp = null;
  let lastAuto = null;          // { app, profile, at }: the last switch the rules made
  let watchError = null;
  const seenApps = [];          // recent foreground apps, newest first, for picking a rule

  // runs a keyboard job like a request: a stale handle reopens (connection.js), a device error drops it
  const onKeyboard = (fn) => conn.run(fn, (e) => (isDeviceError(e) ? drop() : undefined));

  async function onFront(app) {
    frontApp = app;
    const i = seenApps.indexOf(app);
    if (i >= 0) seenApps.splice(i, 1);
    seenApps.unshift(app);
    seenApps.length = Math.min(seenApps.length, 20);
    const p = store.profileFor(app);
    if (p === undefined || isFlashing()) return;
    try {
      await onKeyboard(async () => {
        const k = await keyboard();
        if ((await k.getProfile()) === p) return;
        await k.setProfile(p);
        lastAuto = { app, profile: p, at: new Date().toISOString() };
      });
    } catch { /* keyboard unplugged or in use elsewhere: the next app change tries again */ }
  }

  // the watcher runs only while switching is on and there is something to switch to
  function sync() {
    const m = store.meta();
    const want = m.autoSwitch && (m.rules.length > 0 || m.defaultProfile !== null);
    if (want && !stopWatch) {
      watchError = null;
      stopWatch = watch(onFront, (e) => { watchError = e.message; stopWatch = null; });
    } else if (!want && stopWatch) {
      stopWatch();
      stopWatch = null;
      frontApp = null;
    }
  }

  const body400 = (fn) => async (body) => {
    try { return await fn(body ?? {}); } catch (e) { throw e.status ? httpError(e.status, e.message) : e; }
  };

  // export a slot (switching to it), for the swap
  async function exportSlot(k, p) {
    if ((await k.getProfile()) !== p) await k.setProfile(p);
    return k.exportProfile();
  }

  return {
    sync,
    stop: () => { stopWatch?.(); stopWatch = null; },
    routes: {
      'GET /api/profiles': async () => {
        let active = null;
        try { active = await (await keyboard()).getProfile(); } catch { /* not connected */ }
        return { ...store.meta(), library: store.list(), active, frontApp, seenApps, lastAuto, watching: Boolean(stopWatch), watchError };
      },
      // cheap check for the page: did the rules switch the profile meanwhile?
      'GET /api/profiles/active': async () => ({ active: await (await keyboard()).getProfile(), lastAuto }),
      'POST /api/profiles/onboard': body400(async (b) => store.setOnboard(b.profile, { name: b.name, color: b.color })),
      'POST /api/profiles/rules': body400(async (b) => {
        const m = store.setRules({ rules: b.rules, autoSwitch: b.autoSwitch, defaultProfile: b.defaultProfile });
        sync();
        return { ...m, watching: Boolean(stopWatch), watchError };
      }),
      'POST /api/profiles/save': body400(async (b) => {
        const data = await (await keyboard()).exportProfile();
        const m = store.meta();
        return { entry: store.add(data, { name: b.name ?? m.onboard[data.profile].name, color: b.color ?? m.onboard[data.profile].color, from: data.profile }),
          library: store.list() };
      }),
      // replaces everything in onboard profile b.profile with a saved one (the slot's old
      // contents go to config/backups first, as with any import)
      'POST /api/profiles/load': body400(async (b) => {
        const e = store.get(b.id);
        if (![0, 1, 2, 3].includes(b.profile)) throw httpError(400, 'profile is 0..3');
        const k = await keyboard();
        if ((await k.getProfile()) !== b.profile) await k.setProfile(b.profile);
        const r = await k.importProfile(e.data);
        store.setOnboard(b.profile, { name: e.name, color: e.color });
        return { ...r, state: await state() };
      }),
      'POST /api/profiles/update': body400(async (b) => ({ entry: store.update(b.id, { name: b.name, color: b.color }), library: store.list() })),
      'POST /api/profiles/delete': body400(async (b) => { store.remove(b.id); return { library: store.list() }; }),
      // swaps the contents of two onboard slots, names and colours too; ends on the slot that was active
      'POST /api/profiles/swap': body400(async (b) => {
        const [x, y] = [b.a, b.b];
        if (![0, 1, 2, 3].includes(x) || ![0, 1, 2, 3].includes(y) || x === y) throw httpError(400, 'two different profiles 0..3');
        const k = await keyboard();
        const was = await k.getProfile();
        const dx = await exportSlot(k, x), dy = await exportSlot(k, y);
        await k.setProfile(x); await k.importProfile(dy);
        await k.setProfile(y); await k.importProfile(dx);
        if ((await k.getProfile()) !== was) await k.setProfile(was);
        store.swapOnboard(x, y);
        return { meta: store.meta(), state: await state() };
      }),
    },
  };
}

module.exports = { profileRoutes };
