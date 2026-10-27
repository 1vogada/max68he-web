// Profiles beyond the keyboard's four slots (like Wootility's My profiles), kept on this PC:
// - names and colours for the 4 onboard profiles,
// - a library of saved profiles (each an export from backup.js, plus a name and colour),
// - app rules: which onboard profile to switch to when an app is in front (appwatch.js).
// Everything lives under config/ (git-ignored): profiles.json and profiles/<id>.json.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', 'config');
const COLORS = ['#ff8a3d', '#4f8cff', '#3fb950', '#d6a516', '#f85149', '#a371f7', '#39c5cf', '#8b949e'];
const META_DEFAULTS = () => ({
  onboard: [0, 1, 2, 3].map((p) => ({ name: `Profile ${p + 1}`, color: COLORS[p] })),
  rules: [],               // [{ app: 'cs2', profile: 1 }]: app = process name without .exe, any case
  autoSwitch: false,       // switch by the rules while the web UI runs
  defaultProfile: null,    // 0..3 when no rule matches, null = stay
});

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

const text = (v, what, max = 40) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw badRequest(`${what} is 1..${max} characters`);
  return v.trim();
};
const color = (v) => {
  if (typeof v !== 'string' || !/^#[0-9a-f]{6}$/i.test(v)) throw badRequest('colour is #rrggbb');
  return v.toLowerCase();
};
const slot = (v, what = 'profile') => {
  if (![0, 1, 2, 3].includes(v)) throw badRequest(`${what} is 0..3`);
  return v;
};
const appName = (v) => text(v, 'app name', 80).replace(/\.exe$/i, '').toLowerCase();

function store(root = ROOT) {
  const metaFile = path.join(root, 'profiles.json');
  const libDir = path.join(root, 'profiles');
  const entryFile = (id) => {
    if (typeof id !== 'string' || !/^[0-9a-f]{12}$/.test(id)) throw badRequest('unknown saved profile');
    return path.join(libDir, `${id}.json`);
  };

  function meta() {
    const m = META_DEFAULTS();
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { /* defaults */ }
    // keep only what still checks out, so a hand-edited or old file can't break the page
    if (Array.isArray(saved.onboard)) {
      saved.onboard.slice(0, 4).forEach((o, i) => {
        try { m.onboard[i].name = text(o?.name, 'name'); } catch { /* keep the default */ }
        try { m.onboard[i].color = color(o?.color); } catch { /* keep the default */ }
      });
    }
    if (Array.isArray(saved.rules)) {
      m.rules = saved.rules.flatMap((r) => { try { return [{ app: appName(r.app), profile: slot(r.profile) }]; } catch { return []; } });
    }
    m.autoSwitch = saved.autoSwitch === true;
    m.defaultProfile = [0, 1, 2, 3].includes(saved.defaultProfile) ? saved.defaultProfile : null;
    return m;
  }

  function writeMeta(m) {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(metaFile, JSON.stringify(m, null, 1));
    return m;
  }

  return {
    meta,

    // name and / or colour of one onboard profile
    setOnboard(p, { name, color: c } = {}) {
      const m = meta();
      slot(p);
      if (name !== undefined) m.onboard[p].name = text(name, 'name');
      if (c !== undefined) m.onboard[p].color = color(c);
      return writeMeta(m);
    },

    // the onboard names follow their profiles when two slots swap
    swapOnboard(a, b) {
      const m = meta();
      [m.onboard[slot(a)], m.onboard[slot(b)]] = [m.onboard[b], m.onboard[a]];
      return writeMeta(m);
    },

    setRules({ rules, autoSwitch, defaultProfile } = {}) {
      const m = meta();
      if (rules !== undefined) {
        if (!Array.isArray(rules) || rules.length > 50) throw badRequest('rules are a list of at most 50');
        const seen = new Set();
        m.rules = rules.map((r) => {
          const app = appName(r?.app);
          if (seen.has(app)) throw badRequest(`${app} has two rules`);
          seen.add(app);
          return { app, profile: slot(r.profile, 'rule profile') };
        });
      }
      if (autoSwitch !== undefined) m.autoSwitch = Boolean(autoSwitch);
      if (defaultProfile !== undefined) m.defaultProfile = defaultProfile === null ? null : slot(defaultProfile, 'default profile');
      return writeMeta(m);
    },

    // which onboard profile the rules want with this app in front; undefined = leave it
    profileFor(app) {
      const m = meta();
      const name = String(app ?? '').replace(/\.exe$/i, '').toLowerCase();
      const hit = m.rules.find((r) => r.app === name);
      if (hit) return hit.profile;
      return m.defaultProfile ?? undefined;
    },

    // saved profiles, newest first, without their (large) data
    list() {
      let files = [];
      try { files = fs.readdirSync(libDir).filter((f) => /^[0-9a-f]{12}\.json$/.test(f)); } catch { /* none yet */ }
      return files.flatMap((f) => {
        try {
          const e = JSON.parse(fs.readFileSync(path.join(libDir, f), 'utf8'));
          return [{ id: e.id, name: e.name, color: e.color, savedAt: e.savedAt, from: e.from }];
        } catch { return []; }
      }).sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
    },

    get(id) {
      try { return JSON.parse(fs.readFileSync(entryFile(id), 'utf8')); } catch (e) {
        if (e.status) throw e;
        throw badRequest('unknown saved profile');
      }
    },

    // data: an export (backup.js); from: the onboard profile it came from, for the label
    add(data, { name, color: c, from } = {}) {
      if (!data || data.format !== 'max68he-profile') throw badRequest('not a profile export');
      const id = crypto.randomBytes(6).toString('hex');
      const e = { id, name: text(name ?? `Saved ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, 'name'),
        color: color(c ?? COLORS[this.list().length % COLORS.length]), savedAt: new Date().toISOString(), from: from ?? null, data };
      fs.mkdirSync(libDir, { recursive: true });
      fs.writeFileSync(entryFile(id), JSON.stringify(e));
      return { id, name: e.name, color: e.color, savedAt: e.savedAt, from: e.from };
    },

    update(id, { name, color: c } = {}) {
      const e = this.get(id);
      if (name !== undefined) e.name = text(name, 'name');
      if (c !== undefined) e.color = color(c);
      fs.writeFileSync(entryFile(id), JSON.stringify(e));
      return { id, name: e.name, color: e.color, savedAt: e.savedAt, from: e.from };
    },

    remove(id) {
      const f = entryFile(id);
      if (!fs.existsSync(f)) throw badRequest('unknown saved profile');
      fs.unlinkSync(f);
    },
  };
}

module.exports = { store, COLORS };
