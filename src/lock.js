// Cross-process lock on the keyboard. The web UI, the MCP server and the CLI each
// queue and pace their own writes, so only one of them may have it open at a time.
// A file in the temp folder names the holder; a holder whose process is gone
// (crashed, killed) no longer counts. The pid alone is not enough: Windows hands a
// dead holder's pid to new processes, so the file also keeps the holder's start time
// and a live pid that started at another time is someone else.
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FILE = process.env.MAX68HE_LOCK_FILE || path.join(os.tmpdir(), 'max68he-keyboard.lock');
// One lock per keyboard model: the MAX68HE keeps the original file name.
const fileFor = (key) => (!key || key === 'max68he' ? FILE : FILE.replace(/(\.lock)?$/, `-${key}.lock`));
const NAMES = { 'server.js': 'the web UI', 'mcp.js': 'the MCP server', 'cli.js': 'the CLI' };
const script = path.basename(process.argv[1] ?? '');
const OWNER = NAMES[script] ?? (script ? `node ${script}` : 'node');
const HALF_WRITTEN_MS = 3000;   // an unreadable lock younger than this is being written
const SAME_START_MS = 3000;     // start times this close are the same process (ps has 1 s steps)
const STARTED = Math.round(Date.now() - process.uptime() * 1000);   // this process

let held = null;                // the lock file this process holds

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// When a process started (ms since 1970), from the OS; null if that can't be found out.
function startedAt(pid) {
  try {
    const out = process.platform === 'win32'
      ? cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-Process -Id ${Number(pid)}).StartTime.ToUniversalTime().ToString('o')`], { encoding: 'utf8', timeout: 8000, windowsHide: true })
      : cp.execFileSync('ps', ['-o', 'lstart=', '-p', String(Number(pid))], { encoding: 'utf8', timeout: 8000 });
    const ms = Date.parse(out.trim());
    return Number.isFinite(ms) ? ms : null;
  } catch { return null; }
}

// The holder named in the lock still runs: its pid is alive and, when the file has a
// start time, that pid started then (else the pid was reused). Unknown counts as running.
function holderRuns(h) {
  if (!alive(h.pid)) return false;
  if (!Number.isFinite(h.started)) return true;   // written before start times were kept
  const s = startedAt(h.pid);
  return s === null || Math.abs(s - h.started) <= SAME_START_MS;
}

function holder(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function inUse(who, pid) {
  return Object.assign(new Error(`the keyboard is in use by ${who}${pid ? ` (pid ${pid})` : ''}; close it first`), { status: 409 });
}

// Takes the lock, or throws "the keyboard is in use by ..." (status 409).
function acquire(file = FILE, owner = OWNER) {
  if (held === file) return;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, started: STARTED, owner, since: new Date().toISOString() }), { flag: 'wx' });
      held = file;
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let raw = null;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { /* gone meanwhile: try again */ }
    let h = null;
    try { h = JSON.parse(raw); } catch { /* half written or garbage */ }
    if (h?.pid === process.pid) { held = file; return; }
    if (h && Number.isInteger(h.pid) && holderRuns(h)) throw inUse(h.owner ?? 'another program', h.pid);
    if (!h && raw !== null) {
      let age = Infinity;
      try { age = Date.now() - fs.statSync(file).mtimeMs; } catch { /* gone meanwhile */ }
      if (age < HALF_WRITTEN_MS) throw inUse('another program');
    }
    // stale: remove it unless someone replaced it meanwhile, then try once more
    try { if (raw !== null && fs.readFileSync(file, 'utf8') === raw) fs.unlinkSync(file); } catch { /* gone already */ }
  }
  throw inUse('another program');
}

// Gives the lock back if this process holds it.
function release() {
  const file = held;
  held = null;
  if (!file) return;
  try { if (holder(file)?.pid === process.pid) fs.unlinkSync(file); } catch { /* gone already */ }
}

process.on('exit', release);

module.exports = { acquire, release, fileFor, startedAt, FILE, OWNER, STARTED };
