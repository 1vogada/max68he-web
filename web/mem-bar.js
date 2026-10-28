// Memory bar under the keyboard name: how much of the keyboard's flash and RAM the running
// firmware uses (open firmware CAPS word 3 bit 1, protocol.parseCaps -> state.memory).
// view() is pure (Node tests); render() fills #mem-bar.
(function (root) {
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  // same levels as the firmware builder's bars: amber above 95 %, red when full
  const level = (pct) => (pct >= 100 ? 'over' : pct > 95 ? 'warn' : 'ok');

  // mem = { flashUsed, flashSize, ramStatic, ramReserved, ramSize, stackPeak } or null.
  // RAM counts static data + the reserved heap / stack floor (what the linker checks).
  // -> { known: false, tip } or { known: true, bars: [{ name, pct, level, text }], tip }
  function view(mem, custom = true) {
    if (!mem || !mem.flashSize || !mem.ramSize) {
      return { known: false, tip: custom ? 'This firmware does not report its memory use (needs a newer open firmware).'
        : 'The stock firmware does not report its memory use.' };
    }
    const ram = mem.ramStatic + mem.ramReserved;
    const bar = (name, used, size) => {
      const pct = (used / size) * 100;
      return { name, pct, level: level(pct), text: `${name} ${Math.round(pct)} %` };
    };
    const bars = [bar('Flash', mem.flashUsed, mem.flashSize), bar('RAM', ram, mem.ramSize)];
    const tip = [`Flash: ${kb(mem.flashUsed)} of ${kb(mem.flashSize)}`,
      `RAM: ${kb(ram)} of ${kb(mem.ramSize)} (static ${kb(mem.ramStatic)} + ${kb(mem.ramReserved)} heap / stack floor)`,
      ...(mem.stackPeak ? [`stack peak ${kb(mem.stackPeak)}`] : [])].join('\n');
    return { known: true, bars, tip };
  }

  function render(el, mem, custom) {
    if (!el) return;
    const v = view(mem, custom);
    el.hidden = false;
    el.title = v.tip;
    el.replaceChildren();
    if (!v.known) {
      const q = document.createElement('span');
      q.className = 'mem-unknown';
      q.textContent = '?';
      q.setAttribute('aria-label', v.tip);
      el.append(q);
      return;
    }
    for (const b of v.bars) {
      const row = document.createElement('div');
      row.className = 'mem-row';
      row.dataset.level = b.level;
      row.innerHTML = '<span class="mem-name"></span><span class="mem-track"><span></span></span>';
      row.querySelector('.mem-name').textContent = b.text;
      row.querySelector('.mem-track span').style.width = `${Math.min(100, b.pct).toFixed(1)}%`;
      el.append(row);
    }
  }

  const api = { view, render, level };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MemBar = api;
})(typeof window !== 'undefined' ? window : globalThis);
