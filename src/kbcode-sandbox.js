// kbcode sandbox, run as a worker thread by kbcode.js (runScript): its own V8 isolate with a memory
// cap, killed from outside when the script (or its promises) runs too long. Inside it the script runs
// in a fresh node:vm context: no require, process or timers, only `kb` (kbcode-api.js) and `console`.
// The script's realm is never touched from here: errors are described and the result is made into
// JSON inside the sandbox, and only a string goes back to the main thread.
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
const { types } = require('node:util');

const { apiSource, meta, code, timeout } = workerData;
const done = (msg) => parentPort.postMessage(msg);
process.on('unhandledRejection', () => {});   // a script's own failed promise is not the sandbox's problem
const fail = (message, line = 0, col = 0) => done({ error: { line, col, message } });

// a plain own data property, read without running getters or proxy traps
function ownValue(v, key) {
  if (v === null || (typeof v !== 'object' && typeof v !== 'function') || types.isProxy(v)) return undefined;
  const d = Object.getOwnPropertyDescriptor(v, key);
  return d && 'value' in d ? d.value : undefined;
}
const timedOut = (e) => ownValue(e, 'code') === 'ERR_SCRIPT_EXECUTION_TIMEOUT';

// a compile error (V8 puts "file:line", the source line and a caret first); it comes from compiling,
// before any script code ran, so reading it is safe
function syntaxError(e) {
  const lines = String(e?.stack ?? '').split('\n');
  const m = new RegExp(`${meta.file.replace(/\./g, '\\.')}:(\\d+)`).exec(lines[0] ?? '');
  const caret = lines.findIndex((l) => /^\s*\^+\s*$/.test(l));
  fail(`SyntaxError: ${String(e?.message ?? 'syntax error')}`, m ? Number(m[1]) : 0, caret > 0 ? lines[caret].indexOf('^') + 1 : 0);
}

async function main() {
  const ctx = vm.createContext(Object.create(null), { name: 'kbcode', codeGeneration: { strings: true, wasm: false } });
  const opts = { timeout, displayErrors: false };
  vm.runInContext(`(${apiSource})(${JSON.stringify(meta)});`, ctx, { ...opts, filename: 'kbcode-api' });
  let script;
  try {
    script = new vm.Script(code, { filename: meta.file, importModuleDynamically: undefined });
  } catch (e) {
    return syntaxError(e);
  }
  let thrown = null;
  try {
    script.runInContext(ctx, opts);
  } catch (e) {
    if (timedOut(e)) return fail(`the script ran longer than ${timeout} ms (an endless loop?)`);
    thrown = { e };
  }
  // let the script's promises settle (an endless one is stopped by the main thread)
  await new Promise((r) => setImmediate(r));
  if (thrown) {
    ctx.__kbcodeErr = thrown.e;
    try {
      const d = vm.runInContext('__kbcode.describe(__kbcodeErr)', ctx, opts);
      if (typeof d === 'string') return done({ error: JSON.parse(d) });
    } catch { /* the description failed too */ }
    return fail('the script stopped with an error');
  }
  try {
    const json = vm.runInContext('__kbcode.result()', ctx, opts);
    return typeof json === 'string' ? done({ json }) : fail('the script broke the kb API (its result was not readable)');
  } catch (e) {
    return fail(timedOut(e) ? `the script ran longer than ${timeout} ms` : 'the script broke the kb API (its result was not readable)');
  }
}

main().catch((e) => fail(`the sandbox failed: ${e?.message ?? e}`));
