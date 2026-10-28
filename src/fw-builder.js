// Firmware feature builder: builds the open firmware with chosen optional parts left out
// (x68max-firmware firmware/features.json; make variables GAMES=0 FX=0 ...), measures its
// flash and RAM, runs the preflight and registers the image, so src/flasher.js lists it as
// "Custom build (games off, …)". Never talks to a keyboard; flashing stays the flash panel's.
//
// Each flag set + firmware source state (commit, plus a hash of uncommitted changes) builds in
// its own dir firmware/build/custom-<key>: objects don't depend on the flags, so two flag sets
// must never share one, and the 'latest' build (build/2755) is never touched. A registered
// build has custom-<key>/image.json (written only after the preflight passed) next to the
// preflight's ry5088_2755_rydfu.bin. Size estimates build into build/fb-size-<key> the same
// way, keep the numbers (build/fb-sizes.json) and delete the dir. One make runs at a time.
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const PROFILE = '2755';
const KEY_RE = /^custom-([0-9a-f]{10})$/;
const LOG_MAX = 3000;
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;

const err = (status, message) => Object.assign(new Error(message), { status });

// what tests replace: the firmware checkout and its source state
const deps = {
  firmwareDir: () => require('./flasher').config().firmwareDir,
  stamp: sourceStamp,
};

// ---- manifest and flags ------------------------------------------------------------

function readManifest(fw = deps.firmwareDir()) {
  const file = path.join(fw, 'firmware', 'features.json');
  let m;
  try { m = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    throw err(501, e.code === 'ENOENT' ? `this firmware has no feature list (${file}); update x68max-firmware` : `features.json: ${e.message}`);
  }
  return checkManifest(m);
}

function checkManifest(m) {
  const list = m?.features;
  if (!Array.isArray(list) || !list.length) throw err(500, 'features.json: no features');
  const ids = list.map((f) => f.id);
  for (const f of list) {
    if (!/^[a-z][a-z0-9_]*$/.test(f.id ?? '') || !/^[A-Z][A-Z0-9_]*$/.test(f.make ?? '') || ![0, 1].includes(f.default))
      throw err(500, `features.json: bad entry ${JSON.stringify(f.id)}`);
    for (const r of f.requires ?? []) if (!ids.includes(r)) throw err(500, `features.json: ${f.id} requires unknown ${r}`);
  }
  if (new Set(ids).size !== ids.length) throw err(500, 'features.json: duplicate ids');
  return { profile: String(m.profile ?? PROFILE), features: list.map((f) => ({
    id: f.id, make: f.make, name: String(f.name ?? f.id), description: String(f.description ?? ''),
    default: f.default === 1, requires: [...(f.requires ?? [])], caps: [...(f.caps ?? [])],
    group: GROUPS.includes(f.group) ? f.group : null, storage: typeof f.storage === 'string' ? f.storage : null,
    cost: memPair(f.cost) })),
  sizes: sizesOf(m.sizes),
  alwaysOn: (Array.isArray(m.alwaysOn) ? m.alwaysOn : []).filter((a) => typeof a?.name === 'string')
    .map((a) => ({ name: a.name, reason: String(a.reason ?? '') })) };
}

// the optional fields (features page): what's missing or malformed is null, so older lists still work
const GROUPS = ['lighting', 'input', 'layers', 'host', 'system', 'games'];
const nat = (v) => Number.isInteger(v) && v >= 0;
const memPair = (o) => (nat(o?.flash) && nat(o?.ram) ? { flash: o.flash, ram: o.ram } : null);
function sizesOf(s) {
  const full = memPair(s?.full), limits = memPair(s?.limits);
  if (!full || !limits || !limits.flash || !limits.ram) return null;
  return { commit: typeof s.commit === 'string' ? s.commit : null, measured: typeof s.measured === 'string' ? s.measured : null, full, limits };
}

// { id: true|false } for every feature (missing = default); unknown ids, non-boolean values and
// a feature on without what it requires are refused (400)
function normalizeFlags(manifest, flags) {
  if (flags == null) flags = {};
  if (typeof flags !== 'object' || Array.isArray(flags)) throw err(400, 'flags is an object { feature: true|false }');
  const known = new Map(manifest.features.map((f) => [f.id, f]));
  for (const [k, v] of Object.entries(flags)) {
    if (!known.has(k)) throw err(400, `unknown feature "${k}" (known: ${[...known.keys()].join(', ')})`);
    if (typeof v !== 'boolean' && v !== 0 && v !== 1) throw err(400, `${k}: true or false`);
  }
  const out = {};
  for (const f of manifest.features) out[f.id] = k(flags, f.id) ? Boolean(flags[f.id]) : f.default;
  for (const f of manifest.features) {
    const missing = out[f.id] ? f.requires.filter((r) => !out[r]) : [];
    if (missing.length) throw err(400, `${f.name} needs ${missing.map((r) => known.get(r).name).join(', ')}`);
  }
  return out;
}
const k = (o, key) => Object.prototype.hasOwnProperty.call(o, key);

const makeVars = (manifest, flags) => manifest.features.map((f) => `${f.make}=${flags[f.id] ? 1 : 0}`);

// "Custom build (games off, pressure lighting off)": what differs from the default build
function label(manifest, flags) {
  const diff = manifest.features.filter((f) => flags[f.id] !== f.default).map((f) => `${f.name.toLowerCase()} ${flags[f.id] ? 'on' : 'off'}`);
  return `Custom build (${diff.length ? diff.join(', ') : 'all features'})`;
}

// commit + a hash of uncommitted changes under firmware/ and scripts/ (null: not a git checkout)
function sourceStamp(fw) {
  const git = (args) => cp.execFileSync('git', ['-C', fw, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const head = git(['rev-parse', '--short=7', 'HEAD']).trim();
    const diff = git(['diff', 'HEAD', '--', 'firmware', 'scripts']);
    return diff ? `${head}+${crypto.createHash('sha1').update(diff).digest('hex').slice(0, 8)}` : head;
  } catch { return null; }
}

const buildKey = (stamp, vars) => crypto.createHash('sha1').update(`${stamp ?? 'unknown'}|${PROFILE}|${vars.join(' ')}`).digest('hex').slice(0, 10);

// ---- size report ---------------------------------------------------------------------

// the last "SIZE-REPORT {json}" line of make's output (firmware/gen/features.py size)
function parseSizeReport(text) {
  const line = String(text).split(/\r?\n/).reverse().find((l) => l.startsWith('SIZE-REPORT '));
  if (!line) throw err(500, 'the build printed no size report');
  let r;
  try { r = JSON.parse(line.slice(12)); } catch (e) { throw err(500, `size report: ${e.message}`); }
  const n = (v) => Number.isInteger(v) && v >= 0;
  if (!n(r?.flash?.used) || !n(r.flash.limit) || !n(r?.ram?.used) || !n(r.ram.limit) || !r.flash.limit || !r.ram.limit)
    throw err(500, 'size report: flash / ram used and limit missing');
  return { flash: { used: r.flash.used, limit: r.flash.limit }, ram: { used: r.ram.used, limit: r.ram.limit, reserved: r.ram.reserved ?? 0 },
    sections: r.sections ?? {}, flags: r.flags ?? {} };
}

// ---- running make / node -------------------------------------------------------------

// tools/env.sh: w64devkit (make, sh, gcc), the Arm toolchain and Python first on PATH
function toolEnv(fw) {
  const env = { ...process.env };
  const key = Object.keys(env).find((x) => x.toUpperCase() === 'PATH') ?? 'PATH';
  const dirs = [['w64devkit', 'bin'], ['arm', 'bin'], ['python']].map((p) => path.join(fw, 'tools', ...p)).filter((d) => fs.existsSync(d));
  env[key] = [...dirs, env[key]].filter(Boolean).join(path.delimiter);
  return env;
}
function makeExe(fw) {
  const local = path.join(fw, 'tools', 'w64devkit', 'bin', 'make.exe');
  return process.platform === 'win32' && fs.existsSync(local) ? local : 'make';
}

// runs a program, every stdout / stderr line to onLine; resolves { code, out } (out = stdout)
// cp.spawn is looked up per call so the tests can stub it
function run(exe, args, { cwd, env, onLine = () => {}, timeoutMs = BUILD_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let out = '', done = false, child;
    const parts = { stdout: '', stderr: '' };
    const feed = (which, d) => {
      if (which === 'stdout') out += d;
      const lines = (parts[which] + d).split(/\r\n|\r|\n/);
      parts[which] = lines.pop();
      lines.filter((l) => l.trim()).forEach((l) => onLine(l));
    };
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const w of ['stdout', 'stderr']) if (parts[w].trim()) onLine(parts[w]);
      resolve({ out, ...r });
    };
    try { child = cp.spawn(exe, args, { cwd, env, windowsHide: true }); } catch (e) { return finish({ code: null, error: e.message }); }
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d) => feed('stdout', d));
    child.stderr?.on('data', (d) => feed('stderr', d));
    child.on('error', (e) => finish({ code: null, error: e.message }));
    child.on('close', (code) => finish({ code }));
    const timer = setTimeout(() => { child.kill(); finish({ code: null, error: 'timed out' }); }, timeoutMs);
  });
}

let chain = Promise.resolve();
function exclusive(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

// make in firmware/ for one flag set into build/<dir>; resolves the parsed size report
async function make(fw, manifest, flags, dir, onLine) {
  const args = [`-j${Math.max(1, os.cpus().length)}`, `PROFILE=${PROFILE}`, `GENDIR=build/${dir}`,
    `TARGET=build/${dir}/ry5088_${PROFILE}`, ...makeVars(manifest, flags), 'size-report'];
  const r = await run(makeExe(fw), args, { cwd: path.join(fw, 'firmware'), env: toolEnv(fw), onLine });
  if (r.code !== 0) throw err(500, `make failed (${r.error ?? `exit ${r.code}`})`);
  return parseSizeReport(r.out);
}

// ---- size estimates (cached per flag set and source state) ----------------------------

const cacheFile = (fw) => path.join(fw, 'firmware', 'build', 'fb-sizes.json');
function readCache(fw) { try { return JSON.parse(fs.readFileSync(cacheFile(fw), 'utf8')); } catch { return {}; } }
function writeCache(fw, key, report) {
  const c = readCache(fw);
  c[key] = report;
  fs.mkdirSync(path.dirname(cacheFile(fw)), { recursive: true });
  fs.writeFileSync(cacheFile(fw), JSON.stringify(c));
}

function plan(body) {
  const fw = deps.firmwareDir(), manifest = readManifest(fw);
  const flags = normalizeFlags(manifest, body?.flags);
  const vars = makeVars(manifest, flags), stamp = deps.stamp(fw);
  return { fw, manifest, flags, vars, stamp, key: buildKey(stamp, vars) };
}

// { flash, ram, sections, flags, key, cached } for body.flags; builds (not registered) if not cached
async function size(body) {
  const p = plan(body);
  const hit = () => (p.stamp ? readCache(p.fw)[p.key] : null);
  if (hit()) return { ...hit(), key: p.key, cached: true };
  return exclusive(async () => {
    if (hit()) return { ...hit(), key: p.key, cached: true };
    const dir = `fb-size-${p.key}`;
    try {
      const rep = await make(p.fw, p.manifest, p.flags, dir, () => {});
      if (p.stamp) writeCache(p.fw, p.key, rep);
      return { ...rep, key: p.key, cached: false };
    } finally { fs.rmSync(path.join(p.fw, 'firmware', 'build', dir), { recursive: true, force: true }); }
  });
}

// ---- builds ------------------------------------------------------------------------------

const job = { running: false, log: [], ok: null, error: null, id: null, label: null, flags: null, size: null, startedAt: null, finishedAt: null };

const stockImage = (fw) => path.join(fw, 'stock', PROFILE, 'fw_at32.bin');

// starts a build (409 while one runs); progress in job (GET /api/firmware/build)
function build(body) {
  if (job.running) throw err(409, 'a firmware build is already running');
  const p = plan(body);
  if (!fs.existsSync(stockImage(p.fw))) throw err(400, `the preflight needs the stock image at ${stockImage(p.fw)} (its chip-ID header goes in front of the app)`);
  const name = label(p.manifest, p.flags), dir = `custom-${p.key}`;
  const abs = path.join(p.fw, 'firmware', 'build', dir);
  Object.assign(job, { running: true, log: [], ok: null, error: null, id: null, label: name, flags: p.flags, size: null,
    startedAt: new Date().toISOString(), finishedAt: null });
  const say = (l) => { job.log.push(l); if (job.log.length > LOG_MAX) job.log.splice(0, job.log.length - LOG_MAX); };
  const done = exclusive(async () => {
    const existing = registered(p.fw).find((x) => x.key === p.key);
    if (existing) {
      say(`Already built: ${existing.label} (firmware ${existing.stamp ?? 'unknown'}).`);
      return Object.assign(job, { ok: true, id: existing.id, size: existing.size });
    }
    fs.rmSync(path.join(abs, 'image.json'), { force: true });
    say(`Building ${name} from firmware ${p.stamp ?? '(not a git checkout)'}: ${p.vars.join(' ')}`);
    const size = await make(p.fw, p.manifest, p.flags, dir, say);
    job.size = size;
    if (p.stamp) writeCache(p.fw, p.key, size);
    say(`Flash ${size.flash.used} of ${size.flash.limit} B, RAM ${size.ram.used} of ${size.ram.limit} B.`);
    say('Preflight (offline image checks)…');
    const pf = await run(process.execPath, [path.join('scripts', 'preflight.js'), PROFILE, path.join('stock', PROFILE, 'fw_at32.bin'),
      path.join('firmware', 'build', dir)], { cwd: p.fw, env: toolEnv(p.fw), onLine: say, timeoutMs: 60000 });
    if (pf.code !== 0 || !/PREFLIGHT PASSED/.test(pf.out)) throw err(500, 'the preflight failed: this build is not offered for flashing');
    const id = `custom:${p.key}`;
    fs.writeFileSync(path.join(abs, 'image.json'), JSON.stringify({ id, key: p.key, label: name, flags: p.flags, vars: p.vars,
      stamp: p.stamp, profile: PROFILE, size, preflight: 'passed', builtAt: new Date().toISOString() }, null, 2));
    fs.rmSync(path.join(abs, 'obj'), { recursive: true, force: true });   // objects: ~MBs, not needed any more
    say(`Done: "${name}" is in the firmware list.`);
    return Object.assign(job, { ok: true, id });
  });
  done.catch((e) => { say(`Error: ${e.message}`); Object.assign(job, { ok: false, error: e.message }); })
    .finally(() => Object.assign(job, { running: false, finishedAt: new Date().toISOString() }));
  return { started: true, key: p.key, label: name };
}

// registered custom builds, newest first (image.json with a passed preflight and its image)
function registered(fw = deps.firmwareDir()) {
  const base = path.join(fw, 'firmware', 'build');
  let dirs = [];
  try { dirs = fs.readdirSync(base).filter((d) => KEY_RE.test(d)); } catch { return []; }
  const out = [];
  for (const d of dirs) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(base, d, 'image.json'), 'utf8'));
      const file = path.join(base, d, `ry5088_${PROFILE}_rydfu.bin`);
      if (m.preflight !== 'passed' || m.key !== KEY_RE.exec(d)[1] || !fs.existsSync(file)) continue;
      out.push({ ...m, id: `custom:${m.key}`, file });
    } catch { /* not registered */ }
  }
  return out.sort((a, b) => String(b.builtAt).localeCompare(String(a.builtAt)));
}

// GET /api/firmware/features: the manifest for the page (available: false with a reason when not)
function features() {
  try {
    const fw = deps.firmwareDir(), manifest = readManifest(fw);
    return { available: true, profile: manifest.profile, features: manifest.features, sizes: manifest.sizes, alwaysOn: manifest.alwaysOn,
      stamp: deps.stamp(fw), job: status() };
  } catch (e) { return { available: false, reason: e.message, features: [] }; }
}
const status = () => ({ ...job, log: [...job.log] });

module.exports = { deps, job, status, readManifest, checkManifest, normalizeFlags, makeVars, label, parseSizeReport, buildKey,
  sourceStamp, toolEnv, run, size, build, registered, features, PROFILE, GROUPS };
