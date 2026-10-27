// Play sequence (open firmware 0xEF): the keyboard plays a timed list of key / mouse
// input on its own clock. POST /api/sequence/play { text | steps, stopOnKey },
// POST /api/sequence/stop, GET /api/sequence/status. Parsing and the caps check
// live in the driver (sequence.js, custom.js); here only the request shape is checked.
// POST /api/sequence/preview { text } -> { lengthMs, moves } (sequence.js timeline) for the plot.
const { parseSequence, timeline } = require('../sequence');

const MAX_TEXT = 20000;
const MAX_STEPS = 2000;

function sequenceRoutes({ keyboard, httpError }) {
  return {
    'POST /api/sequence/play': async (body) => {
      const { text, steps, stopOnKey } = body ?? {};
      if ((text === undefined) === (steps === undefined)) throw httpError(400, 'give text or steps');
      if (text !== undefined && (typeof text !== 'string' || text.length > MAX_TEXT)) throw httpError(400, `text is a string of up to ${MAX_TEXT} characters`);
      if (steps !== undefined && (!Array.isArray(steps) || steps.length > MAX_STEPS)) throw httpError(400, `steps is a list of up to ${MAX_STEPS}`);
      if (stopOnKey !== undefined && typeof stopOnKey !== 'boolean') throw httpError(400, 'stopOnKey is true or false');
      const k = await keyboard();
      try {
        return await k.playSequence(text ?? steps, { stopOnKey: !!stopOnKey });
      } catch (e) {
        if (e.status || e.device) throw e;             // keyboard trouble keeps its own status
        throw httpError(400, e.message);               // a mistake in the sequence is the request's
      }
    },
    // where the pointer goes (for the editor's preview); parses only, never touches the keyboard.
    // A mistake in the text is a normal answer { error } (the editor shows it while typing).
    'POST /api/sequence/preview': async (body) => {
      const { text } = body ?? {};
      if (typeof text !== 'string' || text.length > MAX_TEXT) throw httpError(400, `text is a string of up to ${MAX_TEXT} characters`);
      try {
        const { lengthMs, moves } = timeline(parseSequence(text));
        return { lengthMs, moves };
      } catch (e) { return { error: e.message }; }
    },
    'POST /api/sequence/stop': async () => (await keyboard()).stopSequence(),
    'GET /api/sequence/status': async () => (await keyboard()).sequenceStatus(),
  };
}

module.exports = { sequenceRoutes };
