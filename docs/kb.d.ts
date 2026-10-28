// kbcode: the `kb` API for scripts that configure the Attack Shark MAX68HE (open firmware) or the X82HE Pro.
// Guide and examples: docs/KBCODE.md.
//
// HOW A SCRIPT WORKS
// - A script is plain JavaScript (loops, ifs, functions, variables). It runs once, in a sandbox: no require,
//   no process, no timers, no fetch, at most 1 second. It DESCRIBES the keyboard by calling `kb`; nothing is
//   sent while it runs. The result is a plan; "check" compares it with the keyboard and lists every change,
//   "apply" writes only what differs. Anything the script does not mention stays as it is on the keyboard.
// - Later calls win: kb.keys.all.actuation(2); kb.key('W').actuation(1)  -> W at 1 mm, the rest at 2 mm.
// - Mistakes are collected, not thrown: every problem comes back as { line, col, message }, all at once,
//   and nothing is written while there is one. Things the connected firmware can't do are errors too.
// - console.log(...) output comes back with its line number (logs).
// - Rules made with key.when(...).do(...) are NOT JavaScript callbacks: they become key action maps that the
//   keyboard itself runs, with no PC program. Script code runs once, at check / apply time, to BUILD them:
//   use loops and ifs to generate rules, not inside them.
//
// UNITS: distances in millimetres (key travel is about 3.5 mm), times in milliseconds, speeds 0..4.

/** The keyboard. The only global besides `console` and the JavaScript built-ins. */
declare const kb: KB;

/** Physical key names (MAX68HE). Names are case-insensitive; aliases: Ctrl/Shift/Alt/Win (= the left one),
 *  Escape, Backspace, Return, CapsLock, Delete, PageUp, PageDown, ArrowUp... A key keeps its physical name
 *  after a remap. A number is a slot (the matrix position, see KeyGroup.slot). */
type KeyName =
  | 'Esc' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '0' | '-' | '=' | 'Bksp' | 'Home'
  | 'Tab' | 'Q' | 'W' | 'E' | 'R' | 'T' | 'Y' | 'U' | 'I' | 'O' | 'P' | '[' | ']' | '\\' | 'Del'
  | 'Caps' | 'A' | 'S' | 'D' | 'F' | 'G' | 'H' | 'J' | 'K' | 'L' | ';' | "'" | 'Enter' | 'PgUp'
  | 'LShift' | 'Z' | 'X' | 'C' | 'V' | 'B' | 'N' | 'M' | ',' | '.' | '/' | 'RShift' | 'Up' | 'PgDn'
  | 'LCtrl' | 'LWin' | 'LAlt' | 'Space' | 'RAlt' | 'Fn' | 'RCtrl' | 'Left' | 'Down' | 'Right'
  | (string & {}) | number;

/** What a key types (remap) or a modTap / toggle / DKS binding sends: a key ('A', 'F13', 'LShift'), a chord
 *  (modifier first: 'Ctrl+C', 'Ctrl+Shift+Esc'), a function ('VolumeUp', 'VolumeDown', 'Mute', 'PlayPause',
 *  'NextTrack', 'PrevTrack', 'MouseLeft', 'MouseRight', 'MouseMiddle', 'MouseBack', 'MouseForward', 'Calculator',
 *  'LockScreen', 'ShowDesktop', 'ProfileNext', 'LedBrightnessUp', 'Fn', 'Disabled'; open firmware: 'MO1'..'MO3'
 *  (layer while held), 'TG1'..'TG3' (layer toggle), 'FwProfile1'..'FwProfile3', 'FwLightingNext',
 *  'FwRapidTriggerToggle'), a macro ('Macro2', 'Macro2:toggle', 'Macro2:hold'; 0..15), a text key ('Text3'; 0..63),
 *  or raw bytes 'raw:00002a00'. */
type KeyValue = string;

/** Colours: '#ff4400', 'ff4400', '#f40', 'rgb(255, 68, 0)', 'hsl(16, 100%, 50%)', a CSS name ('cyan',
 *  'orange', 'rebeccapurple', ...; 'off' = black), [r, g, b] (0..255), or kb.rgb(...) / kb.hsl(...). */
type Color = string | [number, number, number];

/** A mode: 'Mouse' (its name) or the ModeRef from kb.mode('Mouse'), or its number 1..3. */
type ModeName = string | ModeRef | 1 | 2 | 3;

/** Remap layers: 'base' (default), 'fn' (Fn layer 1), 'fn2'..'fn4' (open firmware 'fnLayers'), 'l1'..'l3'
 *  (user layers = modes 1..3; a mode name works too). { layer: 'fn', os: 'mac' } edits the Fn layer of
 *  another OS ('win' default, 'mac', 'android', 'ios'). */
type Layer = 'base' | 'fn' | 'fn1' | 'fn2' | 'fn3' | 'fn4' | 'l1' | 'l2' | 'l3' | string | ModeRef | { layer?: string; os?: 'win' | 'mac' | 'android' | 'ios' };

interface KB {
  /** 'max68he' or 'x82he' (the connected keyboard; 'max68he' with none). */
  readonly model: string;
  /** Key names per row, top to bottom, as on the board. */
  readonly layout: readonly (readonly string[])[];
  /** What the connected firmware has. With no keyboard connected known is false and has() answers true. */
  readonly firmware: {
    readonly known: boolean;
    readonly open: boolean;
    /** key action engine: 0 none, 1 maps, 2 + conditions / modes / mouse keys, 3 + shared mouse speed,
     *  4 + mouse speed by key depth (speedBy) */
    readonly engine: number;
    readonly features: readonly string[];
    /** e.g. has('keyActions'), has('dksLevels'), has('fnLayers'), has('textKeys'), has('gamepad'), has('sequence') */
    has(feature: string): boolean;
  };

  /** One key by name or slot: kb.key('W'), kb.key('Up'), kb.key(14). */
  key(name: KeyName | KeyGroup): KeyGroup;
  readonly keys: {
    /** every key */
    readonly all: KeyGroup;
    /** letters, digits, punctuation and the arrows (the web UI's "Typing" pick) */
    readonly typing: KeyGroup;
    readonly letters: KeyGroup;
    readonly digits: KeyGroup;
    readonly wasd: KeyGroup;
    readonly arrows: KeyGroup;
    /** LCtrl, LShift, LAlt, LWin, RAlt, RCtrl, RShift */
    readonly modifiers: KeyGroup;
    /** the non-typing keys: Shift, Ctrl, Alt, Win, Fn, Caps, Tab, Esc, Enter, Space, Bksp, Del, PgUp, PgDn */
    readonly mods: KeyGroup;
    /** Home, Del, PgUp, PgDn (and End, Ins where the board has them) */
    readonly nav: KeyGroup;
    /** the rows, top (0, Esc 1 2 ...) to bottom (4, LCtrl ...) */
    readonly rows: readonly KeyGroup[];
    row(n: number): KeyGroup;
    named(...names: (KeyName | KeyGroup)[]): KeyGroup;
    /** every key except these */
    except(...names: (KeyName | KeyGroup)[]): KeyGroup;
  };

  /** Make this profile (0..3) active first; everything else then goes into it. */
  profile(n: 0 | 1 | 2 | 3): KB;

  readonly lighting: Lighting;

  /** Declare (or refer to) a mode by name. Modes are the open firmware's user layers 1..3; the keyboard has 3.
   *  Without a number it reuses the keyboard's mode of that name, else takes a free one. Rules test modes with
   *  .if({ mode }) and switch them with mode.enter() / .leave() / .toggle(). Needs key action engine 2. */
  mode(name: string, id?: 1 | 2 | 3): ModeRef;
  /** Action: leave every mode. */
  leaveAllModes(): Action;
  /** Remove every key action map on the keyboard that this script does not define (default: they are kept). */
  resetKeyActions(): KB;

  /** Action: a keyboard key or chord ('Esc', 'LShift', 'Ctrl+C'; keyboard keys and modifiers only). */
  send(key: string): Action;
  readonly mouse: MouseActions;
  readonly gamepad: GamepadApi;

  /** Macro 0..15 (assign it with remap('Macro2') or fn('Macro2:toggle')). A string = { text }.
   *  text: 1..60 characters typed on the US layout; steps: [{ key, down, delayMs? }], one plain key per step.
   *  repeat 1..100 (default 1), delayMs 1..1000 between steps (default 15). */
  macro(index: number, def: string | { text?: string; steps?: { key: string; down: boolean; delayMs?: number }[]; repeat?: number; delayMs?: number }): KB;
  /** Text key 0..63: the keyboard types it (any character; at most 119 bytes UTF-8). Assign with remap('Text0'). Open firmware 'textKeys'. */
  text(index: number, text: string): KB;
  /** Play a sequence on the keyboard's own clock after the writes (apply only; check never plays). Text form of
   *  the driver: "W down; 120ms; Space tap; 30ms; release", "click L", "move 10 -5", "move 300 0 over 500ms ease out",
   *  "wheel 2". Up to 512 steps; everything is let go at the end. Open firmware 'sequence'. */
  sequence(text: string, opts?: { stopOnKey?: boolean }): KB;

  /** antiMistouch, rtStability 0..125 in steps of 25, wasdSwap (swaps WASD and the arrows). os can't be set (see Layer). */
  options(o: { antiMistouch?: boolean; rtStability?: 0 | 25 | 50 | 75 | 100 | 125; wasdSwap?: boolean }): KB;
  /** Polling rate in Hz. */
  pollingRate(hz: 8000 | 4000 | 2000 | 1000 | 500 | 250 | 125): KB;
  /** Open firmware options. Some need a newer build (feature in brackets). */
  firmwareOptions(o: {
    capsIndicator?: boolean; capsColor?: Color;
    /** snap tap when both keys are down: last pressed wins, neutral (neither), first, deeper (the one pressed further) */
    snapMode?: 'last' | 'neutral' | 'first' | 'deeper';
    statusGuide?: boolean;
    /** lighting off after N idle minutes, 0 = never */
    idleMinutes?: number;
    layerIndicator?: boolean;
    /** Fn layers 2-4 only while Fn is held */
    fnHold?: boolean;
    /** how text keys type non-US characters */
    unicode?: 'windows' | 'linux' | 'mac';
    perf?: boolean;
    /** other keys while a text key types: keep working, block, or stop the text ('textTyping') */
    textTyping?: 'keep' | 'block' | 'stop';
    /** 6KRO boot keyboard ('compatMode') */
    compatMode?: boolean;
    /** 0..10 ms ('releaseDebounce') */
    releaseDebounceMs?: number;
    /** dim after N idle minutes (0 = never) to dimPercent 0..100 ('idleDim') */
    dimMinutes?: number; dimPercent?: number;
  }): KB;
  /** = firmwareOptions({ textTyping: m }) */
  textTyping(m: 'keep' | 'block' | 'stop'): KB;

  /** Colour helpers: return '#rrggbb'. rgb 0..255 each; hsl: hue 0..360, saturation and lightness 0..100. */
  rgb(r: number, g: number, b: number): string;
  hsl(h: number, s: number, l: number): string;
}

/** One key or many. Every setter applies to each key and returns the same group, so calls chain:
 *  kb.keys.wasd.actuation(1.2).rapidTrigger({ press: 0.1, release: 0.1 }).color('cyan').
 *  Iterable (for...of gives one-key groups), with forEach / map / filter / some / every / at. */
interface KeyGroup extends Iterable<KeyGroup> {
  readonly length: number;
  readonly names: string[];
  readonly slots: number[];
  /** the key's name / slot when the group is one key */
  readonly name: string | undefined;
  readonly slot: number | undefined;
  forEach(fn: (key: KeyGroup, i: number) => void): void;
  map<T>(fn: (key: KeyGroup, i: number) => T): T[];
  filter(fn: (key: KeyGroup, i: number) => boolean): KeyGroup;
  some(fn: (key: KeyGroup, i: number) => boolean): boolean;
  every(fn: (key: KeyGroup, i: number) => boolean): boolean;
  at(i: number): KeyGroup | undefined;
  has(name: KeyName): boolean;
  except(...names: (KeyName | KeyGroup)[]): KeyGroup;
  and(...names: (KeyName | KeyGroup)[]): KeyGroup;

  // ---- magnetic switch settings (per profile) ----
  /** Actuation point in mm, 0.1..3.4. */
  actuation(mm: number): KeyGroup;
  /** Release point in mm (used while rapid trigger is off), 0.1..3.4. */
  release(mm: number): KeyGroup;
  /** Bottom dead zone in mm, 0..3.4. */
  deadZone(mm: number): KeyGroup;
  /** true / false, or on with sensitivities: press / release 0.01..4 mm; continuous (open firmware): stays armed until the key is fully up. */
  rapidTrigger(on?: boolean | { press?: number; release?: number; continuous?: boolean }): KeyGroup;
  /** All at once: { actuation, release, rapidTrigger, rtPress, rtRelease, continuousRt, deadZone }. */
  switches(s: { actuation?: number; release?: number; rapidTrigger?: boolean; rtPress?: number; rtRelease?: number; continuousRt?: boolean; deadZone?: number }): KeyGroup;

  // ---- what the key types ----
  /** Remap on a layer (default the base layer): remap('Esc'), remap('Ctrl+C', 'fn2'), remap('Left', 'Nav'). */
  remap(value: KeyValue, layer?: Layer): KeyGroup;
  /** = remap(value, n === 1 ? 'fn' : 'fn' + n): what Fn + this key does (Fn layers 2..4: open firmware). */
  fn(value: KeyValue, n?: 1 | 2 | 3 | 4): KeyGroup;

  // ---- per-key colour ----
  /** This key's colour in the stored picture (kb.lighting.picture). Keys without one get the picture's fill. */
  color(c: Color): KeyGroup;

  // ---- advanced keys (one kind per key; they set the key's base mapping themselves, so no remap on 'base' too) ----
  /** Tap sends `tap`, holding past holdMs (10..2550, default 200) sends `hold`. */
  modTap(hold: KeyValue, tap: KeyValue, holdMs?: number): KeyGroup;
  /** A press latches `key` (default: the key's own name) down, the next press lets go; repeat re-sends it while latched. */
  toggle(key?: KeyValue | { repeat?: boolean }, opts?: { repeat?: boolean }): KeyGroup;
  /** Snap tap (SOCD) with the other key: pressing one lets go of the other. One key in this group. */
  snapTap(other: KeyName | KeyGroup): KeyGroup;
  /** Dynamic keystroke. Multi-level (open firmware 'dksLevels'): keys = up to 4 bound keys ('none' = unbound);
   *  levels 1..8, each deeper (0.05..5 mm) with per bound key what happens going down past it and coming back up
   *  ('none' | 'tap' | 'press' | 'hold' | 'release'); gapMm 0..1 (default 0.1).
   *  Or the stock 2-point form: cells [A press past point 1, B past point 2, C release past 2, D release past 1],
   *  each 0 nothing, 1 tap, 2 press, 3 hold. */
  dks(def:
    | { keys: string[]; levels: { depthMm: number; actions?: { down?: DksAction; up?: DksAction }[] }[]; gapMm?: number }
    | { firstPointMm: number; secondPointMm: number; bindings: { key: KeyValue; cells: [number, number, number, number] }[] }): KeyGroup;
  /** Back to a plain key (no snap tap, mod-tap, toggle or DKS). */
  plain(): KeyGroup;

  // ---- on-board gamepad (open firmware 'gamepad') ----
  /** Bind to a gamepad target, null to unbind: 'lx-' 'lx+' 'ly-' (left stick up) 'ly+' 'rx-' 'rx+' 'ry-' 'ry+' 'lt' 'rt'
   *  'a' 'b' 'x' 'y' 'lb' 'rb' 'back' 'start' 'ls' 'rs' 'up' 'down' 'left' 'right' 'mouse-left' 'mouse-right' 'mouse-up'
   *  'mouse-down' 'mouse1' 'mouse2' 'mouse3' 'wheel-up' 'wheel-down'. */
  bindGamepad(target: string | null): KeyGroup;

  // ---- key action maps: rules the keyboard runs itself (open firmware 'keyActions') ----
  /** Start a rule. Triggers: 'press' (passes the light press depth), 'release' (back all the way up),
   *  'down' / 'past' + mm 0.1..4 (goes deeper than that), 'up' / 'above' + mm (comes back above it),
   *  'hold' + ms 10..10000 (still down that long after the press), 'tap' + ms (let go within ms). */
  when(trigger: 'press' | 'release'): Rule;
  when(trigger: 'down' | 'past' | 'up' | 'above', mm: number): Rule;
  when(trigger: 'hold' | 'tap', ms: number): Rule;
  /** The key's map settings: press depth 0.01..4 mm (default 0.3), gap 0.01..0.5 mm (default 0.1, hysteresis),
   *  alsoType: the key still types its own key too (default false: a key with a map stops typing, except when
   *  none of its rules' if is true at the press). */
  actionMap(opts: { press?: number; gap?: number; alsoType?: boolean }): KeyGroup;
}

type DksAction = 'none' | 'tap' | 'press' | 'hold' | 'release';

/** A rule being built: key.when(...).if(...).mode(...).do(action). Nothing happens until .do(). Limits the
 *  keyboard enforces (and check reports): 6 rule slots per key (a mouse.move / scroll rule takes 2), 16 keys
 *  with maps, 15 different conditions across all maps. Conditions can only test held / not held keys and modes (and/not),
 *  not "or" (make two rules) and not a depth (use when('down', mm)). */
interface Rule {
  /** Only while this holds: held = 1..3 keys that must be down (not the rule's own key); notHeld = keys that must
   *  be up (key action engine 5; held + notHeld at most 3 keys); mode = all these modes on; notMode = none of these
   *  on. Several .if() calls add up (and). */
  if(cond: { held?: KeyName | KeyName[]; notHeld?: KeyName | KeyName[]; mode?: ModeName | ModeName[]; notMode?: ModeName | ModeName[] }): Rule;
  /** How the output acts (the driver's rule "mode"; not a kb.mode): 'press' (on until the key is up), 'while'
   *  (only while the trigger holds), 'tap' (a short tap, or once), 'toggle' (flips on / off), 'release' (turns it off).
   *  Defaults: press / hold -> press, down -> while, up / tap / release -> tap; jump / glide / wheel happen once
   *  (tap or press); mouse.move / scroll -> while; mode enter / leave / toggle -> press ('while' + enter = only
   *  while held). */
  mode(how: 'press' | 'while' | 'tap' | 'toggle' | 'release'): Rule;
  /** Add the rule (one per action). Returns the rule so more .do() calls can follow. A string is kb.send(string). */
  do(...actions: (Action | string)[]): Rule;
}

/** An output of a rule. Also accepted: the driver's JSON form, e.g. { key: 'Esc' }, { mouseKeys: 'up', max: 800 }. */
interface Action { readonly [field: string]: unknown }

interface ModeRef {
  readonly name: string;
  enter(): Action;
  leave(): Action;
  toggle(): Action;
  /** In this mode, `key` acts as `action` (a press rule with if: { mode }); a string is a key: nav.remap('H', 'Left'). */
  remap(key: KeyName, action: Action | string): ModeRef;
}

interface MouseActions {
  /** Mouse button 'L' | 'R' | 'M' (or 'L+R'); default 'L'. */
  button(b?: string): Action;
  /** Accelerating pointer while the rule is on (engine 2). px/s 10..2550: start (100) -> max (1200) over rampMs
   *  0..10000 (1000) along curve 'linear' | 'easeIn' (default) | 'easeOut' | 'easeInOut' | 'sine' | 'expo' | 'smooth';
   *  power: ease 0.3..8 (2), expo -20..20 not 0 (5). shareSpeed (engine 3): the speed built up is shared between
   *  directions and kept keepMs 0..1000 (150) after the last one is let go. speedBy (engine 4): 'time' (default: the
   *  speed builds over rampMs), 'pressure' (the speed follows how deep the key is between pressFrom and pressTo mm,
   *  0 <= from < to <= 4, 0.1 mm steps, default 0.5 -> 3.2: start speed at from, max at to and deeper, no movement
   *  while shallower than from; rampMs / shareSpeed / keepMs do nothing) or 'both' (the depth sets the top speed,
   *  the rampMs ramp builds up to it; shareSpeed shares the ramp). Takes 2 of a key's 6 rule slots, 3 with
   *  speedBy 'pressure' or 'both'. */
  move(dir: 'up' | 'down' | 'left' | 'right', opts?: MouseKeysOptions): Action;
  /** The wheel, the same way: notches/s 0.1..25.5, start 2 -> max 10. */
  scroll(dir: 'up' | 'down', opts?: MouseKeysOptions): Action;
  /** Move the pointer at once by dx, dy (-128..127 px; down is +dy). Happens once. */
  jump(dx: number, dy: number): Action;
  /** Glide dx, dy (-512..508 px, 4 px steps) over ms 10..2550 (sine curve). Happens once. */
  glide(dx: number, dy: number, ms: number): Action;
  /** Wheel notches, up is + (-128..127, not 0). Happens once. */
  wheel(n: number): Action;
}

interface MouseKeysOptions {
  start?: number; max?: number; rampMs?: number;
  curve?: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'sine' | 'expo' | 'smooth';
  power?: number; shareSpeed?: boolean; keepMs?: number;
  /** what sets the speed (engine 4 for 'pressure' / 'both'); pressFrom / pressTo only with those */
  speedBy?: 'time' | 'pressure' | 'both'; pressFrom?: number; pressTo?: number;
}

interface GamepadApi {
  /** Action: a gamepad button 'A' 'B' 'X' 'Y' 'LB' 'RB' 'Back' 'Start' 'LS' 'RS' 'Up' 'Down' 'Left' 'Right'. */
  button(b: string): Action;
  /** Action: a stick direction or trigger at percent 1..100: axis 'LX-' 'LX+' 'LY-' (left stick up) 'LY+' 'RX-' 'RX+' 'RY-' 'RY+' 'LT' 'RT'. */
  axis(axis: string, percent: number): Action;
  /** Action: the axis follows the key's depth from `from` to `to` mm (0 <= from < to <= 4, 0.1 mm steps). Mode press, while or toggle. */
  axisDepth(axis: string, from: number, to: number): Action;
  /** On-board gamepad settings (open firmware 'gamepad'): enabled, keysStopTyping, curve 'linear' | 'smooth' |
   *  'aggressive' | 'instant' | 'custom', deadzoneMm < fullMm (0..4), buttonMm, mouseSpeed 20..5100 px/s;
   *  with 'gamepadPlus': points (4 x [x, y] 0..255, curve 'custom'), antiDeadzone 0..100, square, snappy, diagonalDeg 0 | 10..80. */
  settings(s: {
    enabled?: boolean; keysStopTyping?: boolean; curve?: 'linear' | 'smooth' | 'aggressive' | 'instant' | 'custom';
    deadzoneMm?: number; fullMm?: number; buttonMm?: number; mouseSpeed?: number;
    points?: [number, number][]; antiDeadzone?: number; square?: boolean; snappy?: boolean; diagonalDeg?: number;
  }): GamepadApi;
  /** = kb.key(key).bindGamepad(target) */
  bind(key: KeyName, target: string | null): GamepadApi;
}

interface Lighting {
  /** Effect by name (case and spaces don't matter) or mode number. Stock: Static, Breathing, Spectrum, Wave,
   *  Ripple, Star dots, Flow, Key shadow, Layers, Sine, Spring, Neon, Picture (the per-key colours), Radiant,
   *  Loop, Colour grid, Snowfall, Meteor, Silent snow. Open firmware: Random rainbow, Droplet, Reactive,
   *  Ripple (firmware), Heatmap, Key depth, Starlight, Rain, Fire, Aurora, Splash, Trampoline, Liquid dye, Frost,
   *  Lava lamp, Charge shot, Impact, Sparks, Lightning, Gravity, Squeeze, Actuation trainer, WASD gauge,
   *  Spotlight, Pressure paint. opts may set color, speed, brightness, direction, option, rainbow. */
  effect(name: string | number, opts?: { color?: Color; speed?: number; brightness?: number; direction?: string; option?: number; rainbow?: boolean }): Lighting;
  /** The effect's colour (rainbow off). */
  color(c: Color): Lighting;
  /** Rainbow colours instead of one colour. */
  rainbow(on?: boolean): Lighting;
  /** 0..4, 4 = fastest */
  speed(n: number): Lighting;
  /** 0..4, 4 = brightest */
  brightness(n: number): Lighting;
  /** Wave: Right Left Down Up; Flow: Zigzag Spiral; Spring: Outward Inward; Neon: Right Left; Loop: CCW CW. */
  direction(d: string): Lighting;
  /** The raw effect option 0..15. */
  option(n: number): Lighting;
  /** Which stored picture (0..4) key.color() paints; fill = keys without a colour (default black); show (default
   *  true) makes it the lighting unless the script picks another effect. A picture can't be read back from the
   *  keyboard, so it is written on every apply. */
  picture(n: number, opts?: { fill?: Color; show?: boolean }): Lighting;
}

declare const console: { log(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void };
