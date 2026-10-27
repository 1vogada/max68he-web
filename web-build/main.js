// Browser entry of the web version (scripts/build-web.js bundles this to site/driver.js).
// The page (web/*.js) is the same as the desktop app's: it calls /api/... with fetch and
// opens /api/travel and /api/analog as EventSource. Here those never reach a server:
// they go to the same route handlers, running in the page over WebHID.
const hid = require('node-hid');                    // web-build/node-hid.js (WebHID)
const { callRoute, streams } = require('../src/web/server');
const webFlash = require('./web-flash');            // the Updates page's flashing over WebHID

const ready = hid.init().catch(() => false);        // devices granted on an earlier visit
const realFetch = globalThis.fetch.bind(globalThis);
const RealEventSource = globalThis.EventSource;

const apiPath = (url) => {
  const u = new URL(url, location.href);
  return u.origin === location.origin && u.pathname.includes('/api/') ? u.pathname.slice(u.pathname.indexOf('/api/')) : null;
};
const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

globalThis.fetch = async (input, init = {}) => {
  const p = apiPath(typeof input === 'string' ? input : input.url);
  if (!p) return realFetch(input, init);
  await ready;
  // like the server: a GET's query string (?key=W) is its body
  let body = Object.fromEntries(new URL(typeof input === 'string' ? input : input.url, location.href).searchParams);
  if (init.body) { try { body = JSON.parse(init.body); } catch { return json(400, { error: 'invalid JSON' }); } }
  try {
    return json(200, await callRoute(`${(init.method ?? 'GET').toUpperCase()} ${p}`, body));
  } catch (e) {
    return json(e.status || 500, { error: e.message });
  }
};

// EventSource for the two live streams: a "response" the server code writes SSE text to.
class PageEventSource extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
    this.onmessage = null;
    this.onerror = null;
    const p = apiPath(url);
    const which = p === '/api/analog' ? 'Analog' : 'Travel';
    this.res = {
      write: (text) => {
        let event = 'message', data = '';
        for (const line of String(text).split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7);
          else if (line.startsWith('data: ')) data = line.slice(6);
        }
        if (!data) return;
        const e = new MessageEvent(event, { data });
        if (event === 'message') this.onmessage?.(e); else this.onerror?.(e);
        this.dispatchEvent(e);
      },
      end: () => { this.readyState = 2; },
    };
    ready.then(() => {
      if (this.readyState === 2) return;
      this.readyState = 1;
      if (which === 'Analog') this.res.write(`data: ${JSON.stringify(streams.analogState())}\n\n`);
      return streams[`add${which}Client`](this.res);
    }).catch((e) => this.res.write(`event: error\ndata: ${JSON.stringify(e.message)}\n\n`));
    this.which = which;
  }

  close() {
    if (this.readyState === 2) return;
    this.readyState = 2;
    streams[`remove${this.which}Client`](this.res).catch(() => {});
  }
}
globalThis.EventSource = function EventSource(url, opts) {
  return apiPath(url) ? new PageEventSource(url) : new RealEventSource(url, opts);
};

// ---- connecting -------------------------------------------------------------------
// WebHID needs one click to grant the keyboard; after that the browser remembers it.

function connectBar() {
  const bar = document.createElement('div');
  bar.className = 'web-connect';
  bar.innerHTML = hid.supported()
    ? `<span>Web version: the page talks to the keyboard over USB in this browser (WebHID).
        Click <b>Connect keyboard</b> and pick your MAX68HE (it may be listed twice: pick either).</span>
       <button type="button" class="primary">Connect keyboard</button>`
    : '<span>This browser has no WebHID. Use Chrome, Edge or Opera on a computer, or the desktop app.</span>';
  bar.querySelector('button')?.addEventListener('click', async () => {
    try {
      if (await hid.request()) location.reload();      // start over with the keyboard
    } catch (e) { if (e.name !== 'NotFoundError') alert(e.message); }
  });
  document.querySelector('.main')?.prepend(bar);
  return bar;
}

document.addEventListener('DOMContentLoaded', async () => {
  document.documentElement.dataset.web = '1';
  const bar = connectBar();
  // the desktop flash panel appears when the page initialises (maintenance.js); ours goes after it
  for (let i = 0; i < 50 && !webFlash.mount(); i++) await new Promise((r) => setTimeout(r, 200));
  const sync = () => { bar.hidden = hid.devices().length > 0; };
  await ready;
  sync();
  // plugged back in: the page's Reconnect button (or the next request) picks it up
  hid.onChange(sync);
});
