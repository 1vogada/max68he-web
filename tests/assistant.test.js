// The Assistant (src/assistant.js): DeepSeek mocked (no network), the MCP tools in-process with no
// keyboard. The key store (src/secrets.js) never hands the key back.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const secrets = require('../src/secrets');
const { createAssistant, systemPrompt, API, MODEL, MAX_ROUNDS } = require('../src/assistant');
const { assistantRoutes } = require('../src/web/assistant-routes');

const KEY = 'sk-test.not.a.key.WXYZ';   // dots: the public-repo scan must not take it for a real key
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'max68he-sec-')), 'secrets.json');
const noKeyboard = { run: (fn) => fn(), get: () => Promise.reject(new Error('no keyboard in tests')) };

// A DeepSeek stand-in: answers from the list in order, records each request.
function mockFetch(answers) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const msg = typeof answers === 'function' ? answers(calls.length) : answers[calls.length - 1];
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: msg }] }) };
  };
  return { fetch, calls };
}
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

test('key store: checks the key, saves it, shows only a masked form, clears it', () => {
  const f = tmpFile();
  for (const bad of ['', '   ', 'sk-has space1234', 'short', 'x'.repeat(201), 'sk-ключ12345678', 42]) {
    assert.throws(() => secrets.setDeepseekKey(bad, f), (e) => e.status === 400, String(bad));
  }
  assert.deepStrictEqual(secrets.deepseekStatus(f), { set: false, masked: null });
  const st = secrets.setDeepseekKey(KEY, f);
  assert.deepStrictEqual(st, { set: true, masked: 'sk-…WXYZ' });
  assert.ok(!JSON.stringify(st).includes(KEY.slice(3, -4)));
  assert.strictEqual(secrets.deepseekKey(f), KEY);
  assert.deepStrictEqual(secrets.clearDeepseekKey(f), { set: false, masked: null });
  assert.strictEqual(secrets.deepseekKey(f), null);
});

test('routes: the key goes in, never comes back out', async () => {
  const keyFile = tmpFile();
  const R = assistantRoutes({ conn: noKeyboard, keyFile, fetch: () => assert.fail('no network') });
  await R['POST /api/assistant/key']({ key: KEY });
  for (const r of [await R['GET /api/assistant'](), await R['POST /api/assistant/key']({ key: KEY })]) {
    assert.ok(!JSON.stringify(r).includes(KEY), 'key in a reply');
  }
  assert.strictEqual((await R['GET /api/assistant']()).key.masked, 'sk-…WXYZ');
  assert.strictEqual((await R['DELETE /api/assistant/key']()).set, false);
});

test('no key: chat refuses and points to Settings, without calling DeepSeek', async () => {
  const a = createAssistant({ conn: noKeyboard, keyFile: tmpFile(), fetch: () => assert.fail('no network') });
  await assert.rejects(a.chat('hi'), /Settings > AI assistant/);
});

test('loop: read-only tools run, a write waits for a confirm, the answer comes back', async () => {
  const keyFile = tmpFile();
  secrets.setDeepseekKey(KEY, keyFile);
  const { fetch, calls } = mockFetch([
    { content: null, tool_calls: [call('c1', 'get_kb_code_docs', {})] },
    { content: 'Setting Q.', tool_calls: [call('c2', 'set_switch', { key: 'Q', actuation: 1.2 })] },
    { content: 'Left Q as it was.' },
  ]);
  const a = createAssistant({ conn: noKeyboard, keyFile, fetch });
  const r1 = await a.chat('make Q lighter');
  assert.deepStrictEqual(r1.events.map((e) => e.type), ['tool', 'assistant', 'pending']);
  assert.strictEqual(r1.events[0].name, 'get_kb_code_docs');
  assert.ok(r1.events[0].ok);
  const p = r1.events[2];
  assert.strictEqual(p.name, 'set_switch');
  // the request: right URL and model, key only in the header, the skill as system prompt, OpenAI tools
  assert.strictEqual(calls[0].url, API);
  assert.ok(!calls[0].url.includes(KEY));
  assert.strictEqual(calls[0].init.headers.authorization, `Bearer ${KEY}`);
  assert.strictEqual(calls[0].body.model, MODEL);
  assert.strictEqual(calls[0].body.messages[0].role, 'system');
  assert.match(calls[0].body.messages[0].content, /Check before apply/);
  assert.doesNotMatch(calls[0].body.messages[0].content, /^---/);
  const names = calls[0].body.tools.map((t) => t.function.name);
  for (const n of ['get_info', 'set_switch', 'run_kb_code', 'set_key_actions']) assert.ok(names.includes(n), n);
  assert.ok(calls[0].body.tools.every((t) => t.type === 'function' && t.function.parameters?.type === 'object'));
  assert.strictEqual(calls.length, 2, 'stopped at the write');
  await assert.rejects(a.chat('another'), /confirm or cancel/);
  await assert.rejects(a.confirm('nope', true), /no such change/);
  const r2 = await a.confirm(p.id, false);
  assert.deepStrictEqual(r2.events.map((e) => [e.type, e.result ?? e.text]), [['tool', 'declined'], ['assistant', 'Left Q as it was.']]);
  const toolMsg = calls[2].body.messages.find((m) => m.tool_call_id === 'c2');
  assert.match(toolMsg.content, /declined/);
});

test('guard: a kbcode apply shows its dry run first; flashing is refused; rounds are capped', async () => {
  const keyFile = tmpFile();
  secrets.setDeepseekKey(KEY, keyFile);
  const code = "kb.key('Q').actuation(1.2);";
  let m = mockFetch([{ content: '', tool_calls: [call('k1', 'run_kb_code', { code, apply: true })] }]);
  let r = await createAssistant({ conn: noKeyboard, keyFile, fetch: m.fetch }).chat('apply it');
  assert.deepStrictEqual(r.events.map((e) => e.type), ['tool', 'pending'], 'maps read, then the card');
  assert.match(r.events[1].preview, /nothing was compared|no keyboard|summary/i);

  m = mockFetch([{ content: '', tool_calls: [call('f1', 'flash_firmware', {})] }, { content: 'ok, no flash' }]);
  r = await createAssistant({ conn: noKeyboard, keyFile, fetch: m.fetch }).chat('flash it');
  assert.deepStrictEqual(r.events.map((e) => [e.type, e.ok]), [['tool', false], ['assistant', undefined]]);
  assert.match(r.events[0].result, /no flashing/);

  m = mockFetch(() => ({ content: '', tool_calls: [call('x', 'list_keys', {})] }));
  r = await createAssistant({ conn: noKeyboard, keyFile, fetch: m.fetch }).chat('loop forever');
  assert.strictEqual(m.calls.length, MAX_ROUNDS);
  assert.match(r.events.at(-1).text, /Stopped after/);
});

test('DeepSeek errors come back without the key', async () => {
  const keyFile = tmpFile();
  secrets.setDeepseekKey(KEY, keyFile);
  const fetch = async () => ({ ok: false, status: 400, statusText: 'Bad', json: async () => ({ error: { message: `bad key ${KEY}` } }) });
  await assert.rejects(createAssistant({ conn: noKeyboard, keyFile, fetch }).chat('hi'), (e) => !e.message.includes(KEY) && /400/.test(e.message));
});

test('system prompt is the skill body', () => {
  const p = systemPrompt();
  assert.match(p, /^# Driving the keyboard/);
  assert.match(p, /Fn \+ Esc held 2 s/);
});

test('kbcode: maps read first, the script is checked, then applied only after the confirm', async () => {
  const keyFile = tmpFile();
  secrets.setDeepseekKey(KEY, keyFile);
  const code = "const t = kb.mode('Tilde');\nkb.key('B').when('press').if({ held: ['Fn', 'LCtrl'] }).do(t.toggle());\nt.remap('Esc', '`');";
  const { fetch, calls } = mockFetch([
    { content: 'Checking.', tool_calls: [call('s1', 'run_kb_code', { code })] },
    { content: '', tool_calls: [call('s2', 'run_kb_code', { code, apply: true })] },
    { content: 'Done.' },
  ]);
  let gets = 0;
  const conn = { run: (fn) => fn(), get: () => { gets++; return Promise.reject(new Error('no keyboard in tests')); } };
  const a = createAssistant({ conn, keyFile, fetch });
  const r1 = await a.chat('make a Tilde mode');
  assert.deepStrictEqual(r1.events.map((e) => [e.type, e.name]),
    [['assistant', undefined], ['tool', 'get_key_actions'], ['tool', 'run_kb_code'], ['pending', 'run_kb_code']]);
  assert.strictEqual(r1.events[2].code, code, 'the script shows in the chat');
  assert.strictEqual(r1.events[3].code, code);
  assert.ok(r1.events[3].preview, 'the apply card carries the dry run');
  const checked = calls[1].body.messages.find((m) => m.tool_call_id === 's1').content;
  assert.match(checked, /^The key action maps on the keyboard now/, 'maps go with the first check');
  assert.match(calls[0].body.messages[0].content, /kbcode API \(docs\/kb\.d\.ts\)[\s\S]*declare/, 'kb.d.ts in the prompt');
  assert.match(calls[0].body.messages[0].content, /# kbcode: configure the keyboard with code/, 'KBCODE.md in the prompt');
  const before = gets;
  const r2 = await a.confirm(r1.events[3].id, true);
  assert.ok(gets > before, 'the apply ran on the keyboard connection');
  assert.deepStrictEqual(r2.events.map((e) => e.type), ['tool', 'assistant']);
  assert.strictEqual(r2.events[0].args.apply, true);
  assert.match(r2.events[0].result, /no keyboard/);
  assert.strictEqual(r2.events[1].text, 'Done.');
});
