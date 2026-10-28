// kbcode (scripts that describe the keyboard, docs/KBCODE.md):
// POST /api/kbcode/check { code } -> { ok, plan, summary, changes, errors: [{ line, col, message }], logs, notes, compared }
//   runs and checks the script and compares it with the keyboard; never writes. With no keyboard
//   (not plugged in, or held by another program) it still checks and says nothing was compared.
// POST /api/kbcode/apply { code } -> { ok, applied: [text], errors, logs }: refuses on any error,
//   else writes only what differs.
// GET /api/kbcode/docs -> { dts, markdown, examples: [{ name, code }] }
const kbcode = require('../kbcode');

const MAX_CODE = 60000;

function kbcodeRoutes({ keyboard, httpError }) {
  const codeOf = (body) => {
    if (typeof body?.code !== 'string') throw httpError(400, 'code is the script text');
    if (body.code.length > MAX_CODE) throw httpError(400, `the script is too long (${body.code.length} characters, at most ${MAX_CODE})`);
    return body.code;
  };
  return {
    'POST /api/kbcode/check': async (body) => {
      const code = codeOf(body);
      let k = null, why;
      try { k = await keyboard(); } catch (e) {
        if (e.status === 503) throw e;          // being flashed: say so rather than compare with nothing
        why = e.message;
      }
      return kbcode.check(code, { keyboard: k, noKeyboard: why });
    },
    'POST /api/kbcode/apply': async (body) => kbcode.apply(await keyboard(), codeOf(body)),
    'GET /api/kbcode/docs': async () => kbcode.docs(),
  };
}

module.exports = { kbcodeRoutes };
