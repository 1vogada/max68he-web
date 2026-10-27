# MAX68HE web configurator

Configure the **Attack Shark MAX68HE / X68MAX** magnetic keyboard (Hall effect switches) from your
browser: actuation point, rapid trigger, remapping, Fn layers, advanced keys (snap tap, mod-tap,
toggle, dynamic keystroke), lighting, per-key colour, an analog gamepad from key depth, profiles and more.

**Open it:** https://1vogada.github.io/max68he-web/

## Use

1. Plug the keyboard in by **cable** and close the vendor app.
2. Open the page in **Chrome, Edge or Opera** on a computer (the page talks to the keyboard over USB with
   WebHID, which Firefox and Safari don't have).
3. Click **Connect keyboard** and pick the MAX68HE (it may be listed twice: either works). The browser
   remembers it next time.

Everything runs in your browser: nothing is installed, and nothing about your keyboard or settings is
sent anywhere (the page only loads its font from Google Fonts). Settings that live on this computer
(profile names, saved profiles, the gamepad mapping) stay in this browser's storage.

Most features work with the keyboard's stock firmware. Some (marked "open firmware" on the page) need an
open-source firmware for this board, which isn't published yet. It is the open firmware by 1vogada, a fork
of krodity/fun60-custom-firmware (MIT, © Pratyush Shukla).

Updates: the Updates page flashes an open-firmware image you choose (it checks the file first). The
keyboard restarts into its updater, a separate USB device, so the browser asks you to pick that once too.

Not in the web version: going back to the stock firmware, switching profiles with the app in front, and AI
control. Those come with the desktop version (Node.js: `npm install`, then `npm run web`).

## Build it yourself

```bash
npm ci --ignore-scripts
npm run build:web    # -> site/
npm run serve:web    # http://localhost:6880
npm test
```

This repository is a published snapshot; development happens elsewhere, so each commit here is a sync.

Attack Shark, RongYuan and Wooting are named only for compatibility and comparison; this project is not
affiliated with or endorsed by them. Third-party licences: [THIRD_PARTY_NOTICES.md](web-build/THIRD_PARTY_NOTICES.md)
(also on the site as `THIRD_PARTY_NOTICES.md`).

## Licence

Copyright (c) 2026 Ivo Petkov (1vogada). All rights reserved.
The source is published for viewing; no permission is granted to use, copy, modify or distribute it
without written permission. A free-software licence (probably GPL) may follow later. See [LICENSE](LICENSE).
