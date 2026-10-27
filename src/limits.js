// Switch limits of the MAX68HE (board 2755) in mm, one place for the web API,
// the MCP server, the CLI (through protocol.mmToWire) and profile import.
// Full travel is about 3.5 mm; the stock firmware caps actuation at 3.4.
const MAX_ACTUATION_MM = 3.4;     // actuation and release point (DKS second point too)
const SWITCH_LIMITS = {
  actuation: [0.1, MAX_ACTUATION_MM], release: [0.1, MAX_ACTUATION_MM], rtPress: [0.01, 4], rtRelease: [0.01, 4], deadZone: [0, 3.4],
};

// What a key's settings may read back as before a write puts them back: the firmware's
// own clamps (earlier writes went up to 4 mm). Outside them the read was wrong.
const STORED_LIMITS = { ...SWITCH_LIMITS, actuation: [0.1, 4], release: [0.1, 4] };

module.exports = { MAX_ACTUATION_MM, SWITCH_LIMITS, STORED_LIMITS };
