// One long-lived keyboard connection for a server process (web UI, MCP), so the
// transport's pacing and queue hold across requests. Concurrent first requests
// share one open; separate opens would close each other.
const { Keyboard } = require('./keyboard');
const { sentCount } = require('./hid');

// Device trouble (hid.js marks it) as opposed to bad input or a bug: only this
// is worth closing the keyboard for.
const isDeviceError = (e) => e?.device === true;

// blocked() returns an error while nothing may open the keyboard (a flash runs).
// key() names the model to open (models.js); undefined lets Keyboard.open pick.
// idleMs: close the keyboard (and its cross-process lock, lock.js) after this long with no
// request, so another program (the web UI) can open it; the next request reopens. Flash pacing
// is per process (hid.js pace), so it holds across the reopen. Omitted: stays open.
function createConnection({ blocked = () => null, key = () => undefined, idleMs = 0 } = {}) {
  let kb = null;
  let opening = null;
  let closing = null;
  let active = 0;
  let idle = null;

  // (re)starts the idle countdown once no request is running
  function rest() {
    clearTimeout(idle);
    idle = null;
    if (idleMs > 0 && active === 0 && (kb || opening)) {
      idle = setTimeout(() => { idle = null; if (active === 0) drop(); }, idleMs);
      idle.unref?.();
    }
  }

  function get() {
    const why = blocked();
    if (why) return Promise.reject(why);
    if (kb) return Promise.resolve(kb);
    if (!opening) {
      opening = (async () => {
        if (closing) await closing;   // the old handle goes first
        kb = await Keyboard.open({ key: key() });
        return kb;
      })().finally(() => { opening = null; });
    }
    return opening.finally(rest);
  }

  // Closes the keyboard once the work already queued on it has run, so requests
  // in flight finish on the handle they started with. The next get() reopens.
  function drop() {
    const k = kb;
    kb = null;
    if (!k) return closing ?? Promise.resolve();
    closing = (async () => {
      for (let b; b !== k.t.busy;) { b = k.t.busy; await b; }   // work queued meanwhile too
      try { k.close(); } catch { /* already gone */ }
    })().finally(() => { closing = null; });
    return closing;
  }

  // After a failed request: drop only on device errors.
  const fail = (e) => (isDeviceError(e) ? drop() : Promise.resolve());

  // Runs one request. A handle gone stale (the keyboard was replugged or flashed) fails
  // on its first send; when no packet at all reached the keyboard meanwhile, the request
  // runs once more on a reopened handle instead of failing. onFail(e) runs after each failure.
  async function run(fn, onFail = fail) {
    active++;
    clearTimeout(idle);
    try {
      return await attempt(fn, onFail);
    } finally {
      active--;
      rest();
    }
  }

  async function attempt(fn, onFail) {
    const before = sentCount();
    try {
      return await fn();
    } catch (e) {
      await onFail(e);
      if (!(e?.unsent && sentCount() === before)) throw e;
    }
    try {
      return await fn();
    } catch (e) {
      await onFail(e);
      throw e;
    }
  }

  return { get, drop, fail, run, get current() { return kb; }, get opening() { return opening; } };
}

module.exports = { createConnection, isDeviceError };
