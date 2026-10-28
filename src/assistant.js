// The web UI's Assistant: DeepSeek (OpenAI-compatible chat API, function calling) driving the same
// tools as the MCP server, in-process (createMcpServer + an SDK Client over InMemoryTransport).
// System prompt: the max68he-keyboard skill (.claude/skills/max68he-keyboard/SKILL.md).
// Guard: read-only tools run at once; anything that writes waits for the user's confirm click
// (a kbcode apply shows its dry run first); a tool that would flash is refused outright.
const fs = require('fs');
const path = require('path');
const secrets = require('./secrets');

const API = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-chat';
const MAX_ROUNDS = 10;              // model calls per user message (a confirm continues the count)
const MAX_MESSAGE = 4000;           // characters per user message
const MAX_RESULT = 20000;           // characters of a tool result the model sees
const SKILL = path.join(__dirname, '..', '.claude', 'skills', 'max68he-keyboard', 'SKILL.md');
const MAPS_NOTE = 'The key action maps on the keyboard now (read before your first script; add to them, and restate '
  + 'every other rule of a key you give rules to, e.g. Esc\'s Mouse rule):';

const httpError = (status, msg) => Object.assign(new Error(msg), { status });
const redact = (s) => String(s).replace(/\bsk-[\w-]+/g, 'sk-…');

// read-only: runs without asking; never: refused whatever the user says
const readOnly = (name, args) => /^(get_|list_)/.test(name) || (name === 'run_kb_code' && args?.apply !== true);
const never = (name) => /flash/i.test(name);

// The skill, then the kbcode guide and API (docs/KBCODE.md, docs/kb.d.ts), so it can write scripts.
function systemPrompt(file = SKILL) {
  const text = fs.readFileSync(file, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '');
  const d = require('./kbcode').docs();
  return `${text.trim()}\n\nYou run inside the max68he web UI. To change the keyboard, prefer one kbcode script: read the `
    + 'current maps (get_key_actions), write the script, check it with run_kb_code (apply false), fix it from the errors '
    + 'and check again, then call run_kb_code with apply true; the user sees the script and its dry run and confirms. '
    + 'Other tools that change the keyboard also wait for the user to confirm a card in the chat; if they decline, accept it. '
    + `Keep answers short.\n\n# kbcode guide (docs/KBCODE.md)\n\n${d.markdown}\n\n# kbcode API (docs/kb.d.ts)\n\n${d.dts}`;
}

const resultText = (r) => (r.content ?? []).map((c) => c.text ?? '').join('\n');

// One chat (the page has one). conn: the web server's keyboard connection; fetch: injectable for tests.
function createAssistant({ conn, fetch = globalThis.fetch, keyFile = secrets.FILE, skillFile = SKILL } = {}) {
  let client = null, tools = null, messages = [], queue = [], pending = null, rounds = 0, busy = false, seq = 0, sawMaps = false;

  async function connect() {
    if (client) return;
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
    const { createMcpServer } = require('./mcp');
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createMcpServer({ conn }).connect(a);
    const c = new Client({ name: 'max68he-assistant', version: '0.1.0' });
    await c.connect(b);
    tools = (await c.listTools()).tools
      .filter((t) => !never(t.name))
      .map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    client = c;
  }

  async function callModel() {
    const key = secrets.deepseekKey(keyFile);
    if (!key) throw httpError(400, 'No DeepSeek API key: add one in Settings > AI assistant.');
    let res;
    try {
      res = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: MODEL, messages, tools, tool_choice: 'auto' }),
      });
    } catch (e) {
      throw httpError(502, `Could not reach DeepSeek: ${redact(e.message)}`);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const why = res.status === 401 ? 'it refused the API key' : redact(data?.error?.message ?? res.statusText ?? '');
      throw httpError(502, `DeepSeek answered ${res.status}: ${why}`);
    }
    const msg = data?.choices?.[0]?.message;
    if (!msg) throw httpError(502, 'DeepSeek sent no answer');
    return msg;
  }

  async function runTool(name, args) {
    try {
      const r = await client.callTool({ name, arguments: args });
      return { ok: !r.isError, text: resultText(r) };
    } catch (e) {
      return { ok: false, text: `error: ${e.message}` };
    }
  }

  const toolReply = (id, text) => messages.push({ role: 'tool', tool_call_id: id, content: text.slice(0, MAX_RESULT) });

  // Works through the queued tool calls, then asks the model again, until it answers, a write
  // waits for a confirm, or the rounds run out. events: what the page shows.
  async function drive(events) {
    for (;;) {
      while (queue.length) {
        const call = queue.shift();
        const name = call.function?.name;
        let args;
        try { args = JSON.parse(call.function?.arguments || '{}'); } catch { args = null; }
        if (!args || typeof args !== 'object') { toolReply(call.id, 'error: the arguments were not a JSON object'); continue; }
        if (never(name)) {
          toolReply(call.id, 'refused: the assistant never flashes; the user does that on the Updates page');
          events.push({ type: 'tool', name, args, ok: false, result: 'refused: no flashing from the assistant' });
          continue;
        }
        if (name === 'get_key_actions') sawMaps = true;
        let maps = '';
        if (name === 'run_kb_code' && !sawMaps) {   // its code must build on the maps already there
          sawMaps = true;
          const r = await runTool('get_key_actions', {});
          maps = `${MAPS_NOTE}\n${r.text}\n\n`;
          events.push({ type: 'tool', name: 'get_key_actions', args: {}, ok: r.ok, result: r.text.slice(0, 2000) });
        }
        const code = name === 'run_kb_code' && typeof args.code === 'string' ? args.code : undefined;
        if (!readOnly(name, args)) {
          let preview = null;
          if (name === 'run_kb_code') preview = (await runTool('run_kb_code', { ...args, apply: false })).text;
          pending = { id: `p${++seq}`, call, name, args, maps };
          events.push({ type: 'pending', id: pending.id, name, args, preview, code });
          return events;
        }
        const r = await runTool(name, args);
        toolReply(call.id, maps + r.text);
        events.push({ type: 'tool', name, args, ok: r.ok, result: r.text.slice(0, 2000), code });
      }
      if (rounds >= MAX_ROUNDS) {
        events.push({ type: 'assistant', text: `(Stopped after ${MAX_ROUNDS} steps. Say "go on" to continue.)` });
        return events;
      }
      rounds++;
      const msg = await callModel();
      messages.push({ role: 'assistant', content: msg.content ?? '', ...(msg.tool_calls?.length && { tool_calls: msg.tool_calls }) });
      if (msg.content) events.push({ type: 'assistant', text: msg.content });
      if (!msg.tool_calls?.length) return events;
      queue = [...msg.tool_calls];
    }
  }

  async function exclusive(fn) {
    if (busy) throw httpError(409, 'the assistant is still working on the last message');
    busy = true;
    try { return { events: await fn([]) }; } finally { busy = false; }
  }

  return {
    status: () => ({ key: secrets.deepseekStatus(keyFile), pending: pending && { id: pending.id, name: pending.name } }),
    setKey: (key) => secrets.setDeepseekKey(key, keyFile),
    clearKey: () => secrets.clearDeepseekKey(keyFile),
    chat: (text) => exclusive(async (events) => {
      if (typeof text !== 'string' || !text.trim()) throw httpError(400, 'write a message');
      if (text.length > MAX_MESSAGE) throw httpError(400, `a message is at most ${MAX_MESSAGE} characters`);
      if (pending) throw httpError(409, 'confirm or cancel the waiting change first');
      if (!secrets.deepseekKey(keyFile)) throw httpError(400, 'No DeepSeek API key: add one in Settings > AI assistant.');
      await connect();
      if (!messages.length) messages.push({ role: 'system', content: systemPrompt(skillFile) });
      messages.push({ role: 'user', content: text });
      rounds = 0;
      return drive(events);
    }),
    // ok: run the waiting write; else tell the model the user declined. Then carry on.
    confirm: (id, ok) => exclusive(async (events) => {
      if (!pending || pending.id !== id) throw httpError(409, 'no such change is waiting');
      const { call, name, args, maps } = pending;
      pending = null;
      if (ok === true) {
        const r = await runTool(name, args);
        toolReply(call.id, maps + r.text);
        events.push({ type: 'tool', name, args, ok: r.ok, result: r.text.slice(0, 2000) });
      } else {
        toolReply(call.id, `${maps}the user declined this change; nothing was written`);
        events.push({ type: 'tool', name, args, ok: false, result: 'declined' });
      }
      return drive(events);
    }),
    reset: () => { if (busy) throw httpError(409, 'the assistant is still working'); messages = []; queue = []; pending = null; sawMaps = false; return {}; },
  };
}

module.exports = { createAssistant, systemPrompt, readOnly, never, API, MODEL, MAX_ROUNDS };
