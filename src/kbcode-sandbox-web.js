// kbcode sandbox for the browser (the web version), the counterpart of kbcode-sandbox.js: a fresh
// dedicated worker per script (its own thread and global scope, no DOM, no WebHID), killed from outside
// when it runs too long. Before the script runs, the worker gives up every way out: network, storage,
// timers, other workers and loading code. Only a string (the result JSON, or an error) comes back, and
// the page reads nothing else from the worker.

// The worker's code, as text (it runs from a blob: URL). Mirrors kbcode-sandbox.js.
function workerMain() {
  'use strict';
  const post = self.postMessage.bind(self);
  const later = self.setTimeout.bind(self);
  const geval = self.eval;
  const fail = (message, line = 0, col = 0) => post({ error: { line, col, message } });

  // everything that reaches outside the worker or loads code, on the global and its prototypes
  const OUT = ['fetch', 'XMLHttpRequest', 'WebSocket', 'WebTransport', 'EventSource', 'importScripts', 'indexedDB',
    'caches', 'BroadcastChannel', 'Worker', 'SharedWorker', 'MessageChannel', 'MessagePort', 'RTCPeerConnection',
    'Request', 'Response', 'Headers', 'navigator', 'location', 'postMessage', 'close', 'onmessage', 'onmessageerror',
    'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'requestAnimationFrame', 'reportError', 'storage'];
  function lockDown() {
    for (let p = self; p; p = Object.getPrototypeOf(p)) {
      for (const n of OUT) { try { delete p[n]; } catch { /* not configurable */ } }
    }
    for (const n of OUT) {
      try { Object.defineProperty(self, n, { value: undefined, writable: false, configurable: false }); } catch { /* fine */ }
    }
  }

  // V8 gives a syntax error no position: it is on the first line where a prefix of the script fails
  // with the same message as the whole script (Function only compiles, it runs nothing)
  function syntaxLine(code, message) {
    const lines = code.split('\n');
    if (/end of input/i.test(message)) return lines.length;
    for (let n = 1; n <= lines.length; n++) {
      try { new Function(lines.slice(0, n).join('\n')); } catch (e) { if (String(e && e.message) === message) return n; }
    }
    return 0;
  }

  self.onmessage = (ev) => {
    const { apiSource, meta, code } = ev.data;
    lockDown();
    try {
      geval(`(${apiSource})(${JSON.stringify(meta)});`);
    } catch (e) {
      return fail(`the sandbox failed: ${e && e.message}`);
    }
    try {
      new Function(code);   // compile only
    } catch (e) {
      const message = String((e && e.message) || 'syntax error');
      return fail(`SyntaxError: ${message}`, syntaxLine(code, message), 0);
    }
    let thrown = null;
    try {
      geval(`${code}\n//# sourceURL=${meta.file}`);
    } catch (e) {
      thrown = { e };
    }
    // let the script's promises settle (an endless one is stopped by the page)
    later(() => {
      if (thrown) {
        self.__kbcodeErr = thrown.e;
        try {
          const d = geval('__kbcode.describe(__kbcodeErr)');
          if (typeof d === 'string') return post({ error: JSON.parse(d) });
        } catch { /* the description failed too */ }
        return fail('the script stopped with an error');
      }
      try {
        const json = geval('__kbcode.result()');
        return typeof json === 'string' ? post({ json }) : fail('the script broke the kb API (its result was not readable)');
      } catch {
        return fail('the script broke the kb API (its result was not readable)');
      }
    }, 0);
  };
}

const BOOT_MS = 1000;   // the worker's start, on top of the script's own time
const fail = (message) => ({ error: { line: 0, col: 0, message } });

// -> Promise<{ json } | { error }>, like kbcode.js runScript on Node
function runScriptWeb(apiSource, meta, code, { timeout = 1000 } = {}) {
  return new Promise((resolve) => {
    let worker, url, timer, settled = false;
    const end = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { worker?.terminate(); } catch { /* gone */ }
      if (url) URL.revokeObjectURL(url);
      resolve(r);
    };
    try {
      url = URL.createObjectURL(new Blob([`(${workerMain})();`], { type: 'text/javascript' }));
      worker = new Worker(url);
    } catch (e) {
      return end(fail(`kbcode could not start its sandbox in this browser (${e?.message ?? e})`));
    }
    timer = setTimeout(() => end(fail(`the script ran longer than ${timeout} ms (an endless loop?)`)), timeout + BOOT_MS);
    worker.onmessage = (e) => {
      const m = e.data;
      if (typeof m?.json === 'string') return end({ json: m.json });
      const er = m?.error;
      if (er && typeof er.message === 'string') {
        return end({ error: { line: Number(er.line) || 0, col: Number(er.col) || 0, message: er.message.slice(0, 500) } });
      }
      return end(fail('the sandbox answered nothing'));
    };
    worker.onerror = (e) => { e.preventDefault?.(); end(fail('the sandbox stopped')); };
    worker.postMessage({ apiSource, meta, code });
  });
}

module.exports = { runScriptWeb, workerMain };
