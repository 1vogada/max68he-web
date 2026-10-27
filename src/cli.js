#!/usr/bin/env node
// Command-line front end for the library. Every command is one API call.
const { Keyboard } = require('./keyboard');
const { parseKey, slotName, textToSteps, describeSteps, FUNCTIONS } = require('./keys');

const HELP = `usage: max68he <command> [args]

  Works on the MAX68HE, or the X82HE Pro when only that one is plugged in;
  set MAX68HE_KEYBOARD=x82he (or max68he) to pick one.

  info                         board id, firmware, profile, lighting
  keys                         slots that hold a key, with names
  switches [key|slot]          actuation / release / rapid trigger (mm)
  set-switch <key|slot|all> [--actuation mm] [--release mm] [--rt on|off]
             [--rt-press mm] [--rt-release mm] [--dead mm] [--rt-continuous on|off]
             [--except key,key,...]   (with "all": leave these keys alone)
  lighting                     current lighting
  set-lighting [--mode n] [--speed 0-4] [--brightness 0-4] [--option n]
               [--color rrggbb | --rainbow | --preset 0-6]
  profile [0-3]                show or switch profile
  polling [hz]                 show or set polling rate (8000 4000 2000 1000 500 250 125)
  fn-keys                      Fn-layer mappings
  remap <key|slot> <value> [--fn] [--os win|mac]
                               value: A, Ctrl+C, VolumeUp, Macro2:toggle, Disabled, raw:xxxxxxxx
  functions                    named values remap accepts besides keys
  macro <0-31>                 show a macro
  set-macro <0-31> --text "hello" [--repeat n] [--delay ms]
  picture <0-4> --color rrggbb [--keys Q,W,E]   store per-key colours (others off)
  show-picture <0-4>           switch lighting to a stored picture
  advanced                     keys using snap tap, mod-tap, toggle or DKS
  snap <key> <key>             snap tap (SOCD) between two keys
  modtap <key> <hold> <tap> [--ms 200]
  toggle <key> [--repeat]
  plain <key>                  remove snap/mod-tap/toggle/DKS from a key
  options [--wasd on|off] [--protect on|off] [--rt-stability 0-125]
  scan [--settle us] [--adc-div 0-15] [--sample 0-7] [--background on|off] [--reset]
                               scan rate and timing (open firmware); flags tune it live
  export <file.json>           back up the active profile
  import <file.json>           restore a backup into the active profile
  json <command>               same output as JSON (info, keys, switches, lighting)`;

function parseFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) continue;
    const key = args[i].slice(2);
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

const num = (v, name) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${name} needs a number`);
  return n;
};

// 'Q', 'esc' or a slot number -> slot
async function resolveSlot(kb, target) {
  if (/^\d+$/.test(target)) return Number(target);
  const keys = await kb.listKeys();
  const hit = keys.find((k) => k.name.toLowerCase() === target.toLowerCase());
  if (!hit) throw new Error(`no key named ${target}; see 'keys'`);
  return hit.slot;
}

function switchSettings(f) {
  const s = {};
  if (f.actuation !== undefined) s.actuation = num(f.actuation, 'actuation');
  if (f.release !== undefined) s.release = num(f.release, 'release');
  if (f['rt-press'] !== undefined) s.rtPress = num(f['rt-press'], 'rt-press');
  if (f['rt-release'] !== undefined) s.rtRelease = num(f['rt-release'], 'rt-release');
  if (f.dead !== undefined) s.deadZone = num(f.dead, 'dead');
  if (f.rt !== undefined) {
    if (!['on', 'off'].includes(f.rt)) throw new Error('--rt is on or off');
    s.rapidTrigger = f.rt === 'on';
  }
  if (f['rt-continuous'] !== undefined) {
    if (!['on', 'off'].includes(f['rt-continuous'])) throw new Error('--rt-continuous is on or off');
    s.continuousRt = f['rt-continuous'] === 'on';
  }
  if (!Object.keys(s).length) throw new Error('nothing to change');
  return s;
}

function lightingChanges(f) {
  const c = {};
  for (const k of ['mode', 'speed', 'brightness', 'option']) if (f[k] !== undefined) c[k] = num(f[k], k);
  if (f.rainbow) Object.assign(c, { rainbow: true, presetColour: null });
  if (f.preset !== undefined) Object.assign(c, { presetColour: num(f.preset, 'preset'), rainbow: false });
  if (f.color !== undefined) {
    if (!/^[0-9a-f]{6}$/i.test(f.color)) throw new Error('--color is rrggbb');
    const v = parseInt(f.color, 16);
    Object.assign(c, { r: v >> 16, g: (v >> 8) & 0xff, b: v & 0xff, rainbow: false, presetColour: null });
  }
  if (!Object.keys(c).length) throw new Error('nothing to change');
  return c;
}

async function switchTable(kb, only) {
  const [keys, sw] = [await kb.listKeys(), await kb.getSwitches()];
  return keys.filter((k) => only === undefined || k.slot === only)
    .map((k) => ({ ...sw[k.slot], key: k.name }));
}

function printSwitches(rows) {
  console.log('slot key       actuate  release  RT   press  release  dead  kind');
  for (const r of rows) {
    const mm = (v) => v.toFixed(2).padStart(5);
    console.log(`${String(r.slot).padStart(4)} ${r.key.padEnd(9)} ${mm(r.actuation)}    ${mm(r.release)}   ${r.rapidTrigger ? 'on ' : 'off'} ${mm(r.rtPress)}  ${mm(r.rtRelease)}  ${mm(r.deadZone)}  ${r.kind}`);
  }
}

async function run(argv) {
  let [cmd, ...rest] = argv;
  const asJson = cmd === 'json';
  if (asJson) [cmd, ...rest] = rest;
  if (!cmd || cmd === 'help' || cmd === '--help') return console.log(HELP);

  const kb = await Keyboard.open();
  const out = (data, pretty) => (asJson ? console.log(JSON.stringify(data, null, 2)) : pretty(data));
  try {
    const f = parseFlags(rest);
    switch (cmd) {
      case 'info': {
        const data = { ...kb.info, profile: await kb.getProfile(), lighting: await kb.getLighting(),
          pollingRateHz: await kb.getReportRate(), sleep: await kb.getSleepTimers() };
        return out(data, (d) => console.log(d));
      }
      case 'keys':
        return out(await kb.listKeys(), (ks) => ks.forEach((k) => console.log(`${String(k.slot).padStart(4)}  ${k.name}`)));
      case 'switches': {
        const only = rest[0] !== undefined ? await resolveSlot(kb, rest[0]) : undefined;
        return out(await switchTable(kb, only), printSwitches);
      }
      case 'set-switch': {
        if (!rest[0] || rest[0].startsWith('--')) throw new Error('set-switch needs a key, slot or "all"');
        const s = switchSettings(f);
        if (rest[0] === 'all') {
          const except = typeof f.except === 'string' ? f.except.split(',') : [];
          await kb.setAllSwitches(s, except.length ? await kb.slotsExcept(except) : undefined);
          return printSwitches(await switchTable(kb));
        }
        const slot = await resolveSlot(kb, rest[0]);
        await kb.setSwitch(slot, s);
        return printSwitches(await switchTable(kb, slot));
      }
      case 'lighting':
        return out(await kb.getLighting(), (d) => console.log(d));
      case 'set-lighting':
        return console.log(await kb.setLighting(lightingChanges(f)));
      case 'profile':
        if (rest[0] !== undefined) await kb.setProfile(num(rest[0], 'profile'));
        return console.log(`profile ${await kb.getProfile()}`);
      case 'polling':
        if (rest[0] !== undefined) return console.log(`polling ${await kb.setReportRate(num(rest[0], 'hz'))} Hz`);
        return console.log(`polling ${await kb.getReportRate()} Hz`);
      case 'fn-keys': {
        const names = Object.fromEntries((await kb.listKeys()).map((k) => [k.slot, k.name]));
        const fn = (await kb.getFnKeymap()).map((v, slot) => ({ slot, key: names[slot] ?? `slot${slot}`, fn: slotName(v) }))
          .filter((x) => x.fn);
        return out(fn, (rows) => rows.forEach((r) => console.log(`Fn+${r.key.padEnd(8)} -> ${r.fn}`)));
      }
      case 'remap': {
        if (rest.length < 2) throw new Error('remap needs a key and a value');
        const slot = await resolveSlot(kb, rest[0]);
        const got = await kb.setKey(slot, parseKey(rest[1]), { layer: f.fn ? 'fn' : 'base', os: f.os || 'win' });
        return console.log(`${f.fn ? 'Fn+' : ''}${rest[0]} -> ${slotName(got) ?? (f.fn ? 'falls through' : 'disabled')}`);
      }
      case 'functions':
        return console.log(Object.keys(FUNCTIONS).join('\n'));
      case 'macro': {
        const m = await kb.getMacro(num(rest[0], 'index'));
        if (!m) return console.log('odd macros cannot be read back on this firmware (playback works)');
        return out(m, (d) => console.log(`repeat ${d.repeat}: ${describeSteps(d.steps) || '(empty)'}`));
      }
      case 'set-macro': {
        if (typeof f.text !== 'string') throw new Error('set-macro needs --text');
        const steps = textToSteps(f.text, f.delay ? num(f.delay, 'delay') : 15);
        const m = await kb.setMacro(num(rest[0], 'index'), steps, f.repeat ? num(f.repeat, 'repeat') : 1);
        return console.log(`macro ${rest[0]}: ${m ? `${m.steps.length} steps stored` : 'stored (odd macros cannot be read back)'}. Assign: remap <key> Macro${rest[0]}`);
      }
      case 'picture': {
        if (!/^[0-9a-f]{6}$/i.test(f.color || '')) throw new Error('picture needs --color rrggbb');
        const v = parseInt(f.color, 16);
        const rgb = [v >> 16, (v >> 8) & 0xff, v & 0xff];
        const slots = typeof f.keys === 'string' ? await kb.resolveSlots(f.keys.split(',')) : (await kb.listKeys()).map((k) => k.slot);
        const colours = [];
        slots.forEach((s) => { colours[s] = rgb; });
        await kb.setPicture(num(rest[0], 'picture'), colours);
        return console.log(`picture ${rest[0]} stored (${slots.length} keys). Show it: show-picture ${rest[0]}`);
      }
      case 'show-picture':
        return console.log(await kb.showPicture(num(rest[0], 'picture')));
      case 'advanced':
        return out(await kb.getAdvancedKeys(), (ks) => (ks.length ? ks.forEach((k) => console.log(JSON.stringify(k))) : console.log('none')));
      case 'snap': {
        await kb.setSnap(await resolveSlot(kb, rest[0]), await resolveSlot(kb, rest[1]));
        return console.log(`snap tap: ${rest[0]} + ${rest[1]}`);
      }
      case 'modtap': {
        await kb.setModTap(await resolveSlot(kb, rest[0]), parseKey(rest[1]), parseKey(rest[2]), f.ms ? num(f.ms, 'ms') : 200);
        return console.log(`${rest[0]}: hold ${rest[1]}, tap ${rest[2]}`);
      }
      case 'toggle':
        await kb.setToggle(await resolveSlot(kb, rest[0]), parseKey(rest[0]), Boolean(f.repeat));
        return console.log(`${rest[0]} toggles`);
      case 'plain':
        await kb.clearAdvanced(await resolveSlot(kb, rest[0]));
        return console.log(`${rest[0]} is a plain key`);
      case 'options': {
        const onOff = (v, name) => { if (!['on', 'off'].includes(v)) throw new Error(`--${name} is on or off`); return v === 'on'; };
        const c = {};
        if (f.wasd !== undefined) c.wasdSwap = onOff(f.wasd, 'wasd');
        if (f.protect !== undefined) c.antiMistouch = onOff(f.protect, 'protect');
        if (f['rt-stability'] !== undefined) c.rtStability = num(f['rt-stability'], 'rt-stability');
        return console.log(Object.keys(c).length ? await kb.setOptions(c) : await kb.getOptions());
      }
      case 'scan': {
        const t = {};
        if (f.settle !== undefined) t.settleUs = num(f.settle, 'settle');
        if (f['adc-div'] !== undefined) t.adcDiv = num(f['adc-div'], 'adc-div');
        if (f.sample !== undefined) t.sample = num(f.sample, 'sample');
        if (f.background !== undefined) t.background = f.background === 'on';
        if (f.reset !== undefined) t.resetMax = true;
        if (Object.keys(t).length) await kb.setScanTiming(t);
        return out(await kb.getScanStats(1000), (d) => console.log(d));
      }
      case 'export': {
        if (!/.json$/i.test(rest[0] || '')) throw new Error('export needs a .json file name');
        require('fs').writeFileSync(rest[0], JSON.stringify(await kb.exportProfile(), null, 1));
        return console.log(`profile saved to ${rest[0]}`);
      }
      case 'import': {
        const r = await kb.importProfile(JSON.parse(require('fs').readFileSync(rest[0], 'utf8')), (step) => process.stdout.write(`${step.padEnd(30)}`));
        return console.log(`
restored (${r.keyWrites} keys changed)`);
      }
      default:
        throw new Error(`unknown command ${cmd}\n\n${HELP}`);
    }
  } finally {
    kb.close();
  }
}

run(process.argv.slice(2)).catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });
