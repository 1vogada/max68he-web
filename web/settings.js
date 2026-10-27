// Settings page: device (polling rate, facts), appearance, keyboard options,
// open-firmware options and profile export/import.
(() => {
  const App = (window.App = window.App || {});
  App.views = App.views || {};

  let optTracker, fwTracker, devTracker;

  function fill(opts) {
    const f = App.$('#options-form');
    f.elements.wasdSwap.checked = opts.wasdSwap;
    f.elements.antiMistouch.checked = opts.antiMistouch;
    f.elements.rtStability.value = opts.rtStability;
    optTracker?.clear();
  }

  // open-firmware options (Settings > Firmware options)
  function fillFirmware(o) {
    const f = App.$('#fw-form');
    App.ui.gate(f, o ? null : App.ui.firmwareReason('These options'));
    fwTracker?.clear();
    App.textTyping?.fill(o);
    if (!o) return;
    f.elements.capsIndicator.checked = o.capsIndicator;
    f.elements.layerIndicator.checked = o.layerIndicator;
    f.elements.statusGuide.checked = o.statusGuide;
    f.elements.fnHold.checked = Boolean(o.fnHold);
    f.elements.fnHold.closest('.field').hidden = !(App.st.features ?? []).includes('fnLayers');
    f.elements.unicode.value = o.unicode ?? 'windows';
    f.elements.perf.checked = Boolean(o.perf);
    f.elements.perf.closest('.field').hidden = !(App.st.features ?? []).includes('perfMode');
    f.elements.unicode.closest('label').hidden = !(App.st.features ?? []).includes('textKeys');
    f.elements.snapMode.value = o.snapMode;
    f.elements.idleMinutes.value = o.idleMinutes;
    // round 5 options: shown only when the flashed firmware reports them (CAPS2 bits 9..11)
    const has = App.st.features ?? [];
    const missing = [];
    App.$$('[data-cap]', f).forEach((el) => {
      el.hidden = !has.includes(el.dataset.cap);
      if (el.hidden) missing.push(CAP_NAMES[el.dataset.cap]);
    });
    const note = App.$('[data-fw-missing]', f);
    note.hidden = !missing.length;
    note.textContent = missing.length ? `Not in the flashed firmware: ${missing.join(', ')}. Flash a newer open firmware for them.` : '';
    f.elements.compatMode.checked = Boolean(o.compatMode);
    f.elements.releaseDebounceMs.value = o.releaseDebounceMs ?? 0;
    f.elements.dimMinutes.value = o.dimMinutes ?? 0;
    f.elements.dimPercent.value = o.dimPercent ?? 30;
    idleText();
    f.elements.capsColor.value = `#${o.capsColor.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  }
  App.fillFirmware = (o) => { fillFirmware(o); fillReset(); };

  const CAP_NAMES = { compatMode: 'compatibility mode', releaseDebounce: 'release debounce', idleDim: 'dim after idle' };

  function idleText() {
    const f = App.$('#fw-form');
    const e = f.elements, out = (name, text) => { App.$(`output[data-for=${name}]`, f).textContent = text; };
    const v = Number(e.idleMinutes.value), dim = Number(e.dimMinutes.value), ms = Number(e.releaseDebounceMs.value);
    out('idleMinutes', v ? `after ${v} min` : 'never');
    out('dimMinutes', !dim ? 'never' : v && dim >= v ? `after ${dim} min (skipped: off comes first)` : `after ${dim} min`);
    out('dimPercent', `${e.dimPercent.value} %`);
    e.dimPercent.closest('label').hidden = !dim;
    out('releaseDebounceMs', ms ? `${ms} ms` : 'off');
  }

  // what the reset loses, named in the confirm
  const RESET_LOSES = 'all 4 profiles: key remaps, Fn layers and user layers, lighting and per-key colours, actuation and '
    + 'rapid trigger, advanced keys (DKS, Mod-Tap, Toggle, Snap Tap), macros, text keys, gamepad and mouse bindings, '
    + 'polling rate and these firmware options';

  function fillReset() {
    const btn = App.$('#fw-reset-btn'), note = App.$('#fw-reset-note');
    const custom = Boolean(App.st.info?.custom), ok = custom && (App.st.features ?? []).includes('resetFe');
    btn.disabled = !ok;
    note.hidden = ok;
    note.textContent = ok ? '' : custom ? 'Needs a newer open firmware.' : App.ui.firmwareReason('Resetting from here');
  }

  // Device panel: polling rate + facts, refreshed with every state
  function fillDevice() {
    const { st, $ } = App;
    const sel = $('#polling');
    if (!sel.options.length) [8000, 4000, 2000, 1000, 500, 250, 125].forEach((hz) => sel.add(new Option(`${hz} Hz`, hz)));
    sel.value = st.pollingRateHz;
    devTracker?.clear();
    const info = st.info;
    const facts = {
      Board: info ? `${info.boardId} (AttackShark X68MAX)` : '?',
      Firmware: info ? `${App.fwText()} (${info.custom ? 'open firmware' : 'stock'})` : '?',
      'Polling rate': `${st.pollingRateHz ?? '?'} Hz`,
      'Active profile': st.profile + 1,
      'Keys': st.keys.length,
    };
    const dl = $('#facts');
    dl.textContent = '';
    for (const [k, v] of Object.entries(facts)) {
      dl.append(Object.assign(document.createElement('dt'), { textContent: k }));
      dl.append(Object.assign(document.createElement('dd'), { textContent: v }));
    }
    $('#status-text').textContent = `USB · ${st.pollingRateHz ?? '?'} Hz`;
  }
  App.fillDevice = fillDevice;

  function showTheme() {
    const t = App.ui.theme();
    App.$$('[data-theme-pick]').forEach((b) => { b.classList.toggle('on', b.dataset.themePick === t); b.setAttribute('aria-pressed', b.dataset.themePick === t); });
  }

  function init() {
    const { $, $$, api, busy, toast } = App;

    devTracker = App.ui.track($('#settings-panel'), {
      async save() {
        App.st.pollingRateHz = (await api('POST', '/api/polling', { hz: Number($('#polling').value) })).pollingRateHz;
        fillDevice();
      },
      discard: fillDevice,
    });

    $$('[data-theme-pick]').forEach((b) => { b.onclick = () => { App.ui.setTheme(b.dataset.themePick); showTheme(); }; });
    showTheme();

    // saved at once (config/ui.json via prefs.js), like the theme above
    const box = $('#marquee-everywhere');
    const showBox = () => { box.checked = Boolean(App.prefs.get('marqueeEverywhere')); };
    box.onchange = () => App.prefs.set('marqueeEverywhere', box.checked).then(showBox);
    window.addEventListener('prefschange', showBox);
    showBox();

    const fw = $('#fw-form');
    const has = (feature) => (App.st.features ?? []).includes(feature);
    App.textTyping.mount($('#fw-text-typing'));
    fw.addEventListener('input', (e) => { if (['idleMinutes', 'dimMinutes', 'dimPercent', 'releaseDebounceMs'].includes(e.target.name)) idleText(); });
    fwTracker = App.ui.track(fw, {
      async save() {
        const e = fw.elements;
        const hex = e.capsColor.value.slice(1);
        const r = await api('POST', '/api/fw-options', {
          capsIndicator: e.capsIndicator.checked, layerIndicator: e.layerIndicator.checked, statusGuide: e.statusGuide.checked, fnHold: e.fnHold.checked, unicode: e.unicode.value, perf: e.perf.checked,
          snapMode: e.snapMode.value, idleMinutes: Number(e.idleMinutes.value), capsColor: hex,
          ...(App.textTyping.supported() ? { textTyping: e.textTyping.value } : {}),
          ...(has('compatMode') ? { compatMode: e.compatMode.checked } : {}),
          ...(has('releaseDebounce') ? { releaseDebounceMs: Number(e.releaseDebounceMs.value) } : {}),
          ...(has('idleDim') ? { dimMinutes: Number(e.dimMinutes.value), dimPercent: Number(e.dimPercent.value) } : {}),
        });
        App.st.fwOptions = r.fwOptions;
        fillFirmware(r.fwOptions);
      },
      discard: () => fillFirmware(App.st.fwOptions),
    });

    $('#fw-reset-btn').onclick = () => {
      if (!confirm(`Reset all keyboard settings?\n\nThis erases, on the keyboard: ${RESET_LOSES}.\n\n`
        + 'Key calibration is kept. This cannot be undone; export your profiles first if you may want them back.')) return;
      busy($('#fw-reset-panel'), 'Resetting the keyboard…', async () => {
        const res = await api('POST', '/api/fw-reset', { confirm: 'reset all' });
        fwTracker.clear(); optTracker.clear(); devTracker.clear();
        App.applyState(res.state);
        toast('Keyboard reset to factory settings');
      });
    };

    const f = $('#options-form');
    [0, 25, 50, 75, 100, 125].forEach((v) => f.elements.rtStability.add(new Option(v ? `${v} (${['', 'light', 'medium', 'strong', 'stronger', 'strongest'][v / 25]})` : 'Off', v)));
    optTracker = App.ui.track(f, {
      async save() {
        const r = await api('POST', '/api/options/set', {
          wasdSwap: f.elements.wasdSwap.checked, antiMistouch: f.elements.antiMistouch.checked, rtStability: Number(f.elements.rtStability.value),
        });
        App.st.options = r;
        fill(r);
      },
      discard: () => fill(App.st.options),
    });

    $('#export-btn').onclick = () => busy($('#backup'), 'Reading the whole profile…', async () => {
      const data = await api('POST', '/api/export');
      const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
      const a = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(blob),
        download: `max68he-profile${data.profile + 1}-${data.exportedAt.slice(0, 10)}.json`,
      });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      toast('Profile saved to a file');
    });

    $('#import-file').onchange = async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      let data;
      try { data = JSON.parse(await file.text()); } catch { return App.ui.showError($('#backup'), `${file.name} is not a profile file (not JSON).`); }
      if (!confirm(`Replace everything in profile ${App.st.profile + 1} with "${file.name}"? This cannot be undone (export first if unsure).`)) return;
      busy($('#backup'), 'Restoring the profile… (can take a minute)', async () => {
        const res = await api('POST', '/api/import', data);
        App.applyState(res.state);
        toast(`Profile restored (${res.keyWrites} keys changed)`);
      });
    };
  }

  App.views.settings = { init, selection: () => { if (App.st.options && !optTracker.dirty) fill(App.st.options); } };
})();
