# Third-party notices

## In the web page (site/)

`driver.js` is built with esbuild from this project's own code only: no third-party package's code
is bundled into it (checked by the build test). esbuild adds a few lines of module glue of its own:

- **esbuild** 0.28 (build tool): MIT License, Copyright (c) 2020 Evan Wallace.

`vendor/blockly/` is **Blockly** 12.5 (the Key wizard's Blocks view; loaded only when that view
opens), copied unchanged from npm by `scripts/vendor-blockly.js`: Apache License 2.0,
Copyright 2011 Google LLC. The licence text is in `vendor/blockly/LICENSE.txt`; source:
https://github.com/RaspberryPiFoundation/blockly.

`vendor/codemirror/` is **CodeMirror** 5.65 (the Key wizard's Code tab editor; loaded only when that
tab opens), copied unchanged from npm by `scripts/vendor-codemirror.js`: MIT License, Copyright (C) 2017
by Marijn Haverbeke and others. The licence text is in `vendor/codemirror/LICENSE.txt`; source:
https://github.com/codemirror/codemirror5.

The page loads its font from Google Fonts; the font is not part of this repository or the site:

- **Inter**: SIL Open Font License 1.1, Copyright (c) 2016 The Inter Project Authors.

## Installed by npm (not included in this repository)

`package.json` lists these; `npm install` fetches them from their authors under their own licences:

- **node-hid** 3.4 (desktop version, USB access): MIT OR X11, Copyright Hans Huebner and contributors.
- **@modelcontextprotocol/sdk** 1.32 (desktop version, AI control): MIT License, Copyright (c) 2024 Anthropic, PBC.
- **zod** 4.6 (desktop version, input checks): MIT License, Copyright (c) 2025 Colin McDonnell.
- **blockly** 12.5 (Key wizard Blocks view, copied into web/vendor/blockly/): Apache License 2.0, Copyright 2011 Google LLC.
- **codemirror** 5.65 (Key wizard Code tab, copied into web/vendor/codemirror/): MIT License, Copyright (C) 2017 by Marijn Haverbeke and others.
- **esbuild** 0.28 (builds the web page): MIT License, Copyright (c) 2020 Evan Wallace.

## Firmware

The open firmware the page can talk to is a fork of krodity/fun60-custom-firmware:
MIT License, Copyright (c) 2026 Pratyush Shukla.

## Names

Attack Shark, RongYuan and Wooting are named only to say what this works with or compares to; this
project is not affiliated with or endorsed by them.
