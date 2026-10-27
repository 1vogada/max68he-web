# Roadmap: beat Wootility on every feature (2026-10-27)

Goal: everything Wootility (v5.4) does, done as well or better, on a keyboard at a quarter of the price.
Compared from Wootility's own pages (Quick settings, My profiles, Actuation, Rapid trigger, RGB, Remap,
Advanced keys, Gamepad, Settings, Switch selector, Interface, Background service).

Status: ✅ have it (as good or better) · 🟡 partly · ❌ missing. Work: **fw** firmware, **drv** driver/server, **ui** web page.

## Already ahead of Wootility

Open firmware (anyone can change it), AI/MCP control, macros, text keys (Unicode), up to 8 DKS levels
(they have 4), 4 Fn layers + 3 extra layers, analog mouse from key depth, per-key travel calibration,
key stats, live analog view, on-board games, depth-reactive lighting effects, per-key paint with 5
pictures, scan-speed figures, one-click flashing with recovery, timed key / mouse sequences played by the keyboard itself (no PC jitter), with mouse glides along curves; per-key action maps with a Key wizard (depth / hold / tap -> keys, gamepad, mouse) (fw `4f1637a`, flashed 2026-10-27; maps kept over updates by the flasher).

## Gamepad (first: on par or better)

| Feature | Wootility | Us | Work |
|---|---|---|---|
| Gamepad from key depth, sticks / triggers / buttons / D-pad | ✅ | ✅ on the keyboard, no PC software | |
| Xbox controller (XInput), works in every PC game | ✅ | ❌ DirectInput only | fw: XInput interface + MS OS descriptors (risky, own phase) |
| Controller type choice | ✅ Xbox / DirectInput | ❌ | fw + ui |
| Curve editor, draggable points, presets (Linear, Aggro, Slow, Smooth) | ✅ | ✅ (fw `f2350e6`, flashed 2026-10-27) | |
| Anti-deadzone | ✅ | ✅ | |
| Angle adjustment (diagonals) | ✅ | ✅ | |
| Square joystick output | ✅ | ✅ | |
| Snappy joystick (opposite keys: stronger wins) | ✅ | ✅ | |
| Keyboard keys on/off while gamepad runs | ✅ | ✅ "bound keys stop typing" | |
| Graphical button palette, drag onto keys, right-click removes | ✅ | ✅ (and click-to-paint) | |
| Gamepad tester (what Windows sees) | ✅ | ✅ (plus the preview from depth) | |
| Setup / Configuration / Tester tabs | ✅ | ✅ | |
| Analog mouse from key depth | ❌ | ✅ | |
| Better than them: curve per binding, deadzone per stick, presets per game, gamepad on/off key | ❌ | ❌ | fw + ui, after the above |

## Profiles

| Feature | Wootility | Us | Work |
|---|---|---|---|
| 4 onboard profiles, switch, export / import | ✅ | ✅ | |
| Profile names, icons, colours | ✅ | ✅ names, colours (no icons) | |
| Unlimited saved profiles, load into a slot, swap slots | ✅ (by drag) | ✅ (buttons) | ui: drag and drop |
| Profiles that switch with the active app | ✅ (Background service) | ✅ while the web server runs | drv: start with Windows |
| Undo / redo | ✅ | ✅ actuation / RT, remap, lighting, gamepad | ui: advanced keys, macros, texts |
| Quick settings page | ✅ | ✅ | |

## Keys

| Feature | Wootility | Us | Work |
|---|---|---|---|
| Actuation 0.1-4.0 mm, rapid trigger, split sensitivity, continuous RT | ✅ | ✅ (to 3.4 mm, the switch's limit) | |
| Tachyon mode | ✅ | ✅ performance mode | |
| Remap presets (Dvorak, Colemak, Workman, 1337, ABC, Function) | ✅ | ✅ one undoable step | |
| Searchable key palette, drag and drop | ✅ | ✅ | |
| Fn layers with Add layer | ✅ (3) | ✅ (4) | |
| Rappy Snappy, Snappy Tappy (SOCD), DKS, Mod-tap, Toggle | ✅ | ✅ | |
| Active advanced keys list with count | ✅ | ✅ | |
| Switch selector (switch type per key, accurate travel), spacers | ✅ | ❌ (one travel, calibration) | fw: per-key travel table; ui |

## RGB

| Feature | Wootility | Us | Work |
|---|---|---|---|
| Effects, brightness, per-key colour | ✅ | ✅ (more effects) | |
| Colour picker with recently used colours | ✅ | ✅ (effects and paint) | |
| Effect presets | ✅ | ✅ | |
| RGB effect layers (effects stacked on keys) | ✅ | ❌ | fw |
| Dim after N min, then off | ✅ | ✅ (fw `546bbbc`, flashed 2026-10-27 with `4f1637a`) | |

## Settings

| Feature | Wootility | Us | Work |
|---|---|---|---|
| Polling rate 8000 / 1000 | ✅ | ✅ | |
| Compatibility mode (6KRO for BIOS / consoles) | ✅ | ✅ (fw `546bbbc`, flashed 2026-10-27 with `4f1637a`) | |
| Num Lock indicator behaviour | ✅ | n/a: no Num Lock key or LED on this board | |
| Debounce filter | ✅ | ✅ release debounce 0-10 ms (fw `546bbbc`, flashed 2026-10-27 with `4f1637a`) | |
| Reset all keyboard settings | ✅ | ✅ button with confirm, calibration kept (fw `546bbbc`, flashed 2026-10-27 with `4f1637a`) | |
| Firmware updates | ✅ | ✅ | |
| Light theme | coming soon | ✅ | |
| Languages | ✅ | ❌ | ui: strings table |
| Analog SDK for games | ✅ | ❌ | drv: Wooting Analog SDK plugin |

## Web version (like wootility.io: open a page, no install)

Possible with WebHID (Chrome / Edge / Opera; not Firefox or Safari): the page talks to the keyboard
itself. The settings interface is on a vendor usage page (0xFFFF), which WebHID allows, and the driver
already speaks 64-byte feature reports, which WebHID has (`sendFeatureReport` / `receiveFeatureReport`).

- Move: `protocol.js`, `keyboard.js`, `custom.js`, `analog.js` run in the browser behind a WebHID
  transport (same interface as `hid.js`); the server's routes become direct calls; `config/*.json`
  (UI prefs, analog mapping, profile names) go to the browser's storage, with export / import.
- Host: GitHub Pages (static files, HTTPS, which WebHID needs). One page serves every user.
- Stays local: the MCP server (AI control), and app-linked profile switching (a browser page can't see
  other apps; a small optional helper can).
- Flashing: ry-flash's updater protocol is ported to JavaScript (`src/ryflash.js`, same packets and waits,
  tested against ry-flash's own vectors and a recorded run), so the page flashes open-firmware images over
  WebHID (branch `web-flash`, not yet tried on hardware). Stock restore stays in the desktop app: the
  vendor's download server sends no CORS headers.
- Size: a few days; the transport and the server-to-browser move are the bulk.

## Order

1. Gamepad, safe part: curve points, anti-deadzone, angle, square, snappy (fw); tabs, curve editor,
   button palette, tester (ui).
2. Gamepad XInput (fw, risky: tested with a recovery plan before flashing).
3. Profiles: names, saved profiles, app-linked switching, undo / redo.
4. ✅ Remap presets and drag and drop, active advanced keys list, colour history, effect presets (2026-10-27).
5. ✅ Firmware options: compatibility mode, debounce, dim-then-off, reset button (Num Lock n/a); flashed 2026-10-27.
6. Switch selector, RGB effect layers, Analog SDK, languages.
