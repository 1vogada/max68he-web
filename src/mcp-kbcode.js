// MCP tools for kbcode (docs/KBCODE.md): run_kb_code { code, apply? } and get_kb_code_docs.
// Registered by mcp.js. A dry run (apply false) works with no keyboard too: it checks the script
// and says nothing was compared.
const kbcode = require('./kbcode');

const ABOUT = 'kbcode: a JavaScript script that describes the keyboard through a global `kb` object; loops, ifs, functions '
  + 'and variables run when the script runs (sandboxed, 1 s, no require / process / timers), and the result is a plan of settings. '
  + 'Rules that must react on the keyboard itself (kb.key(k).when(trigger).if(cond).do(action)) become key action maps the '
  + 'keyboard runs on its own (up to 6 rule slots per key, 16 keys, 15 different conditions). Examples: '
  + "for (const k of kb.keys.typing) k.actuation(1.2).rapidTrigger({ press: 0.15, release: 0.15 }); "
  + "kb.lighting.effect('static').color('#ff4400'); kb.keys.wasd.forEach((k) => k.color('cyan')); "
  + "const m = kb.mode('Mouse'); kb.key('Up').when('press').if({ mode: m }).do(kb.mouse.move('up', { shareSpeed: true })); "
  + "kb.mode('Tilde', { flash: 'cyan', leaveFlash: false }) (the hold bar column flashes when the mode turns on / off; newer firmware); "
  + "kb.key('Home').when('press').do(kb.flash('magenta', 5)). "
  + 'Call get_kb_code_docs for the full API (a TypeScript declaration) and more examples.';

function registerKbcodeTools({ server, z, conn }) {
  const reply = (data, isError) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], ...(isError && { isError: true }) });
  // errors as "line 12:5: message" for a reader without the code open
  const withLines = (r) => ({ ...r, errors: kbcode.errorLines(r.errors ?? []) });

  server.registerTool('run_kb_code', {
    description: `${ABOUT} With apply false (the default) nothing is written: the reply lists every change against the keyboard `
      + '(summary) or the errors with line numbers. With apply true it refuses on any error, else writes only what differs '
      + '(flash writes are paced: this can take a while).',
    inputSchema: {
      code: z.string().max(60000).describe('the script'),
      apply: z.boolean().optional().describe('write it to the keyboard (default false: check only)'),
    },
  }, async ({ code, apply = false }) => {
    try {
      if (apply) {
        const r = await conn.run(async () => kbcode.apply(await conn.get(), code));
        return reply(withLines(r), !r.ok);
      }
      let why = null;
      try { await conn.get(); } catch (e) { why = e.message; }
      const r = why ? await kbcode.check(code, { noKeyboard: why }) : await conn.run(async () => kbcode.check(code, { keyboard: await conn.get() }));
      return reply(withLines(r), !r.ok);
    } catch (e) {
      return reply({ error: e.message }, true);
    }
  });

  server.registerTool('get_kb_code_docs', {
    description: 'The kbcode API as a TypeScript declaration (kb.d.ts, enough on its own to write correct scripts) plus worked examples. '
      + 'Set full to also get the guide (docs/KBCODE.md).',
    inputSchema: { full: z.boolean().optional() },
  }, async ({ full = false }) => {
    const d = kbcode.docs();
    return reply({ dts: d.dts, examples: d.examples, ...(full && { markdown: d.markdown }) });
  });
}

module.exports = { registerKbcodeTools };
