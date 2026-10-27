// The bits of Node's process the driver touches, for the browser build (injected).
export const process = globalThis.process ?? {
  env: {}, argv: [], platform: 'browser', versions: {},
  on() {}, exit() {}, nextTick: (fn, ...a) => queueMicrotask(() => fn(...a)),
  uptime: () => performance.now() / 1000, hrtime: { bigint: () => BigInt(Math.round(performance.now() * 1e6)) },
  stdout: { write() {} }, stderr: { write() {} },
};
