// Key wizard page (view 'wizard'), tab Code (web/key-blocks.js switches the tabs): the keyboard described
// in a short JavaScript script that calls the global `kb` API (kbcode). Check: POST /api/kbcode/check shows
// what would change and the errors (gutter markers + a list); Apply: POST /api/kbcode/apply, then the page
// reloads its state. Docs, examples and the `kb` names for autocomplete come from GET /api/kbcode/docs
// (its .d.ts text). A server without those routes (404) says so and the editor still works.
// CodeMirror 5 (web/vendor/codemirror, copied by scripts/vendor-codemirror.js) loads when the tab first
// opens. The draft is kept on this PC (browser storage) with the save bar: Ctrl+S keeps it, Ctrl+Enter checks.
// While Code is open, a click on the board puts that key's name in the script.
(() => {
  const App = (window.App = window.App || {});
  App.views = App.views || {};
  const $ = (s, el) => App.$(s, el);
  const V = 'vendor/codemirror/';
  const FILES = ['lib/codemirror.js', 'mode/javascript/javascript.js', 'addon/edit/matchbrackets.js', 'addon/edit/closebrackets.js',
    'addon/hint/show-hint.js', 'addon/hint/javascript-hint.js', 'addon/lint/lint.js'];
  const STYLES = ['lib/codemirror.css', 'addon/hint/show-hint.css', 'addon/lint/lint.css'];
  const DRAFT_KEY = 'max68he.kbCode';
  const MISSING = 'The code engine is not available in this server yet.';
  const STARTER = '// Describe the keyboard with kb. Check (Ctrl+Enter) shows what would change; Apply writes it.\n'
    + '// Docs and Examples are above; a click on a key of the board puts its name here.\n\n';

  const S = {
    visible: false, ready: null, cm: null, docs: null, docsReq: null, dts: { globals: {}, types: {} },
    check: null, errors: [], applied: null, missing: false, used: new Set(), usedTimer: null,
  };
  let tracker;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  // ---- loading ---------------------------------------------------------------------------------

  const loadScript = (src) => new Promise((res, rej) => {
    const s = Object.assign(document.createElement('script'), { src });
    s.onload = res;
    s.onerror = () => rej(new Error(`could not load ${src}${src.startsWith('vendor/') ? ' (run npm install: it copies CodeMirror into web/vendor)' : ''}`));
    document.body.append(s);
  });
  const loadCss = (href) => { if (!document.querySelector(`link[href="${href}"]`)) document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href })); };

  function boot() {
    S.ready ??= (async () => {
      STYLES.forEach((f) => loadCss(V + f));
      for (const f of FILES) await loadScript(V + f);   // in order: CodeMirror, then its mode and addons
      const CM = window.CodeMirror;
      const draft = readDraft();
      S.cm = CM($('#kc-editor'), {
        value: draft ?? STARTER, mode: 'javascript', theme: 'kb', lineNumbers: true, indentUnit: 2, tabSize: 2, matchBrackets: true, autoCloseBrackets: true,
        gutters: ['CodeMirror-lint-markers', 'CodeMirror-linenumbers'],
        lint: { getAnnotations: annotations, lintOnChange: false },
        hintOptions: { hint: allHints, completeSingle: false },
        extraKeys: { 'Ctrl-Enter': check, 'Cmd-Enter': check, 'Ctrl-S': keep, 'Cmd-S': keep, 'Ctrl-Space': 'autocomplete' },
      });
      S.cm.on('change', (cm, ch) => {
        if (ch.origin !== 'setValue') tracker.mark();
        drawResult();
        clearTimeout(S.usedTimer);
        S.usedTimer = setTimeout(usedKeys, 300);
      });
      // after "kb." (or a chained call's dot) the kb names pop up by themselves
      S.cm.on('inputRead', (cm, ch) => {
        if (cm.state.completionActive || !/^[\w$.]$/.test(ch.text.join(''))) return;
        if (kbHints(cm)?.list.length) cm.showHint({ hint: kbHints, completeSingle: false });
      });
      $('#kc-status').textContent = draft !== null ? 'Your draft from this PC.' : 'A new script: Examples and "From Blocks" give you a start.';
      usedKeys();
      loadDocs();
    })().catch((e) => { S.ready = null; $('#kc-status').textContent = e.message; App.ui.showError($('#kc-panel'), e.message); throw e; });
    return S.ready;
  }

  // the kbcode routes: a 404 means this server has no code engine yet
  async function kbApi(method, url, body) {
    let res;
    try {
      res = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body && JSON.stringify(body) });
    } catch { throw new Error('Lost contact with the web UI server'); }
    const data = await res.json().catch(() => null);
    if (res.status === 404 && (!data || data.error === 'not found')) { setMissing(true); throw new Error(MISSING); }
    if (!res.ok && !data?.errors) throw new Error(data?.error || res.statusText);
    setMissing(false);
    return data ?? {};
  }
  function setMissing(on) {
    if (S.missing === on) return;
    S.missing = on;
    const st = $('#kc-status');
    st.textContent = on ? `${st.textContent.replace(` ${MISSING}`, '')} ${MISSING}` : st.textContent.replace(` ${MISSING}`, '');
    drawResult();
  }

  function loadDocs() {
    S.docsReq ??= kbApi('GET', '/api/kbcode/docs').then((d) => {
      S.docs = d;
      S.dts = parseDts(d.dts ?? '');
      const sel = $('#kc-examples');
      sel.replaceChildren(new Option('Examples…', ''), ...(d.examples ?? []).map((x, i) => new Option(x.name, String(i))));
      sel.disabled = !(d.examples ?? []).length;
      drawDocs();
    }).catch((e) => {
      S.docsReq = null;                       // asked again when Docs or Examples is used
      const sel = $('#kc-examples');
      sel.replaceChildren(new Option(S.missing ? 'No examples yet' : 'Examples…', ''));
      $('#kc-md').innerHTML = `<p class="muted small">${esc(e.message)}</p>`;
    });
    return S.docsReq;
  }

  // ---- the draft (this PC) -----------------------------------------------------------------------

  function readDraft() { try { return localStorage.getItem(DRAFT_KEY); } catch { return null; } }
  async function saveDraft() {
    if (!S.cm) return;
    try { localStorage.setItem(DRAFT_KEY, S.cm.getValue()); } catch { throw new Error('Could not keep the draft: this browser has its storage turned off'); }
  }
  function keep() { if (tracker.dirty) tracker.save(); else App.toast('The draft is already kept on this PC'); }
  function discard() {
    if (!S.cm) return;
    S.cm.setValue(readDraft() ?? STARTER);
    S.check = null; S.errors = []; S.applied = null;
    S.cm.performLint();
    drawResult();
  }
  // replaces the whole script (an example, From Blocks): asks first when there is something of the user's
  function replace(text, what) {
    const now = S.cm.getValue().trim();
    if (now && now !== STARTER.trim() && now !== text.trim() && !confirm(`Replace the script with ${what}? (Discard on the save bar brings back the kept draft.)`)) return false;
    S.cm.setValue(text);
    S.check = null; S.errors = []; S.applied = null;
    S.cm.performLint();
    tracker.mark();
    drawResult();
    S.cm.focus();
    return true;
  }

  // ---- Check and Apply ------------------------------------------------------------------------------

  // errors are 1-based { line, col, message }; the lint addon draws them in the gutter
  function annotations() {
    const CM = window.CodeMirror, n = S.cm?.lineCount() ?? 0;
    return S.errors.filter((e) => e.line >= 1 && e.line <= n).map((e) => {
      const line = e.line - 1, len = S.cm.getLine(line).length, ch = Math.min(Math.max((e.col ?? 1) - 1, 0), len);
      return { from: CM.Pos(line, ch), to: CM.Pos(line, ch < len ? ch + 1 : ch), message: e.message, severity: 'error' };
    });
  }

  async function check() {
    await boot();
    const code = S.cm.getValue();
    await App.busy($('#kc-panel'), null, async () => {
      S.applied = null;
      const r = await kbApi('POST', '/api/kbcode/check', { code });
      S.check = { ...r, code, errors: r.errors ?? [], summary: r.summary ?? [], changes: r.changes ?? (r.summary ?? []).length };
      S.errors = S.check.errors;
      S.cm.performLint();
      drawResult();
    });
  }

  const stale = () => !S.check || !S.cm || S.check.code !== S.cm.getValue();
  const canApply = () => !S.missing && !stale() && S.check.ok !== false && !S.check.errors.length && S.check.changes > 0;

  async function apply() {
    if (!canApply()) return;
    const { code, changes } = S.check;
    if (!confirm(`Apply ${plural(changes, 'change')} to the keyboard?`)) return;
    await App.busy($('#kc-panel'), 'Applying…', async () => {
      const r = await kbApi('POST', '/api/kbcode/apply', { code });
      if (r.ok === false || r.errors?.length) {
        S.errors = r.errors ?? [];
        S.check = { ...S.check, ok: false, errors: S.errors };
        S.cm.performLint();
        drawResult();
        throw new Error(r.error ?? 'The script was not applied: see the errors under the editor');
      }
      S.applied = r.applied ?? [];
      S.check = null;
      drawResult();
      App.toast(`Applied ${plural(S.applied.length || changes, 'change')} to the keyboard`);
      try { App.applyState(await App.api('GET', '/api/state')); } catch { /* the page shows not connected */ }
    });
  }

  function jump(line, col) {
    S.cm.focus();
    S.cm.setCursor({ line: line - 1, ch: Math.max((col ?? 1) - 1, 0) });
    S.cm.scrollIntoView(null, 80);
  }

  function drawResult() {
    const box = $('#kc-result'), chip = $('#kc-count'), r = S.check;
    $('#kc-apply').disabled = !canApply();
    $('#kc-apply').title = S.missing ? MISSING : !r ? 'Check first' : stale() ? 'The script changed: Check again' : r.errors.length ? 'Fix the errors first' : !r.changes ? 'Nothing to change' : '';
    let html = '';
    if (S.applied) {
      chip.textContent = 'applied';
      html = `<h3>Applied</h3>${S.applied.length ? `<ul class="kw-summary extra">${S.applied.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="muted small">Done.</p>'}`;
    } else if (!r) chip.textContent = 'not checked';
    else {
      chip.textContent = r.errors.length ? plural(r.errors.length, 'error') : plural(r.changes, 'change');
      if (stale()) html += '<p class="kb-note">The script changed since this check: Check again before Apply.</p>';
      if (r.errors.length) {
        html += `<div class="kw-errors kc-errors"><b>${plural(r.errors.length, 'error')}</b><ul>${r.errors.map((e) => `<li>${e.line
          ? `<button type="button" class="link" data-line="${Number(e.line)}" data-col="${Number(e.col) || 1}">Line ${Number(e.line)}${e.col ? `:${Number(e.col)}` : ''}</button> ` : ''}${esc(e.message)}</li>`).join('')}</ul></div>`;
      }
      if (r.summary.length) html += `<h3>What would change (${r.changes})</h3><ul class="kw-summary extra">${r.summary.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
      else if (!r.errors.length) html += '<p class="muted small">Nothing would change: the keyboard already matches this script.</p>';
    }
    box.innerHTML = html;
  }

  // ---- autocomplete: the kb names from the .d.ts text of /api/kbcode/docs ----------------------------

  // Cheap .d.ts reading, one declaration per line: interfaces / classes / object types / namespaces and
  // their members ({ name, sig, ret, doc }), and `declare const kb: Type` globals. ret 'this' = the same type.
  function parseDts(text) {
    const types = {}, globals = {};
    let cur = null, depth = 0, doc = '', inDoc = false;
    const count = (s, c) => s.split(c).length - 1;
    for (const raw of String(text).replace(/\r/g, '').split('\n')) {
      const t = raw.trim();
      if (inDoc || t.startsWith('/**')) {
        if (!inDoc) doc = '';
        inDoc = !t.includes('*/');
        doc += ` ${t.replace(/^\/\*\*|\*\/$|^\*/g, '').trim()}`;
        continue;
      }
      const line = t.replace(/\/\/.*$/, '');
      if (!cur) {
        const m = line.match(/^(?:export\s+)?(?:declare\s+)?(?:interface|class|namespace)\s+([\w$]+)[^{]*\{/) || line.match(/^(?:export\s+)?(?:declare\s+)?type\s+([\w$]+)\s*=\s*\{/);
        if (m) {
          cur = m[1]; types[cur] ??= [];
          if (/\bnamespace\b/.test(line)) globals[cur] = cur;
          depth = count(line, '{') - count(line, '}');
          if (depth <= 0) cur = null;
        } else {
          const g = line.match(/^(?:export\s+)?declare\s+(?:const|let|var)\s+([\w$]+)\s*:\s*([\w$.]+)/);
          if (g) globals[g[1]] = g[2];
        }
        doc = '';
        continue;
      }
      if (depth === 1) {
        const m = line.match(/^(?:(?:readonly|static|function|const|let|export)\s+)*([\w$]+)\??\s*/);
        if (m) {
          let rest = line.slice(m[0].length), sig = '';
          if (rest.startsWith('<') || rest.startsWith('(')) {
            let d = 0, i = 0;
            for (; i < rest.length; i++) { if ('(<'.includes(rest[i])) d++; else if (')>'.includes(rest[i])) { d--; if (!d && rest[i] === ')') break; } }
            sig = rest.slice(0, i + 1);
            rest = rest.slice(i + 1);
          }
          const arrow = !sig && rest.match(/^\s*:\s*(\(.*\))\s*=>\s*([\w$.]+)/);   // key: (name: string) => KeyRule
          if (arrow) sig = arrow[1];
          const ret = arrow ? arrow[2] : rest.match(/^\s*:\s*([\w$.]+)/)?.[1] ?? '';
          if ((sig || ret) && !types[cur].some((x) => x.name === m[1])) types[cur].push({ name: m[1], sig, ret: ret === 'this' ? cur : ret, doc: doc.trim() });
        }
      }
      doc = '';
      depth += count(line, '{') - count(line, '}');
      if (depth <= 0) cur = null;
    }
    return { types, globals };
  }

  // the names before the dot, outermost first: "kb.key('Up')\n  .when(" -> ['kb', 'key', 'when']
  function chainOf(text) {
    const names = [];
    let i = text.length;
    for (;;) {
      while (i && /\s/.test(text[i - 1])) i--;
      if (text[i - 1] === ')') {
        let d = 0;
        do { const c = text[--i]; if (c === ')') d++; else if (c === '(') d--; } while (i > 0 && d > 0);
        if (d) return null;
      }
      let j = i;
      while (j && /[\w$]/.test(text[j - 1])) j--;
      if (j === i) return null;
      names.unshift(text.slice(j, i));
      i = j;
      while (i && /\s/.test(text[i - 1])) i--;
      if (text[i - 1] !== '.') return names;
      i--;
    }
  }

  function kbHints(cm) {
    const CM = window.CodeMirror, cur = cm.getCursor(), line = cm.getLine(cur.line);
    let start = cur.ch;
    while (start && /[\w$]/.test(line[start - 1])) start--;
    const word = line.slice(start, cur.ch), from = CM.Pos(cur.line, start), to = CM.Pos(cur.line, cur.ch);
    const { types, globals } = S.dts;
    let members;
    if (line[start - 1] === '.') {
      const names = chainOf(cm.getRange(CM.Pos(Math.max(0, cur.line - 20), 0), CM.Pos(cur.line, start - 1)));
      let type = names && globals[names[0]];
      for (const n of names?.slice(1) ?? []) type = types[type]?.find((x) => x.name === n)?.ret;
      members = types[type];
      if (!members) return null;
    } else {
      if (!word) return null;
      members = Object.keys(globals).map((name) => ({ name, sig: '', ret: globals[name] }));
    }
    const list = members.filter((x) => x.name.startsWith(word)).map((x) => ({
      text: x.sig.includes('(') ? `${x.name}()` : x.name,
      displayText: `${x.name}${x.sig}${x.ret ? `: ${x.ret}` : ''}`,
      title: x.doc,
      hint: (c, data, item) => { c.replaceRange(item.text, data.from, data.to); if (item.text.endsWith('()')) c.execCommand('goCharLeft'); },
    }));
    return { list, from, to };
  }
  // Ctrl+Space: the kb names, else plain JavaScript (keywords, the script's own variables)
  function allHints(cm) {
    const kb = kbHints(cm);
    if (kb?.list.length) return kb;
    return window.CodeMirror.hint.javascript(cm, { globalScope: {} });
  }

  // ---- Docs (a small markdown renderer: headings, code blocks, lists, paragraphs) ------------------------

  function md(text) {
    const inline = (s) => esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    const out = [], codes = [];
    let para = [], list = null;
    const flush = () => {
      if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
      if (list) out.push(`<${list.tag}>${list.items.map((x) => `<li>${inline(x)}</li>`).join('')}</${list.tag}>`);
      para = []; list = null;
    };
    const lines = String(text).replace(/\r/g, '').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/^\s*```/.test(l)) {
        flush();
        const body = [];
        while (++i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i]);
        codes.push(body.join('\n'));
        out.push(`<div class="kc-snip"><button type="button" class="link" data-snip="${codes.length - 1}" title="Put this code at the cursor">Insert</button><pre><code>${esc(body.join('\n'))}</code></pre></div>`);
        continue;
      }
      const h = l.match(/^(#{1,6})\s+(.*)/);
      const li = l.match(/^\s*([-*]|\d+\.)\s+(.*)/);
      if (h) { flush(); const n = Math.min(h[1].length + 2, 6); out.push(`<h${n}>${inline(h[2])}</h${n}>`); } else if (li) {
        const tag = /\d/.test(li[1]) ? 'ol' : 'ul';
        if (para.length || (list && list.tag !== tag)) flush();
        (list ??= { tag, items: [] }).items.push(li[2]);
      } else if (!l.trim()) flush();
      else if (list && /^\s+/.test(l)) list.items[list.items.length - 1] += ` ${l.trim()}`;
      else { if (list) flush(); para.push(l.trim()); }
    }
    flush();
    return { html: out.join(''), codes };
  }

  function drawDocs() {
    if (!S.docs) return;
    const r = md(S.docs.markdown || 'No docs yet.');
    S.snips = r.codes;
    $('#kc-md').innerHTML = r.html;
  }
  function toggleDocs(on = $('#kc-docs').hidden) {
    $('#kc-docs').hidden = !on;
    $('#kc-docs-btn').setAttribute('aria-expanded', on);
    $('#kc-docs-btn').classList.toggle('on', on);
    $('#kc-panel .kc-body').classList.toggle('docs-open', on);
    if (on) loadDocs();
    S.cm?.refresh();
  }

  // ---- From Blocks: the key action maps as a starting script ------------------------------------------

  // A JS literal: single-quoted strings, bare keys where they can be.
  const lit = (v) => {
    if (typeof v === 'string') return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    if (Array.isArray(v)) return `[${v.map(lit).join(', ')}]`;
    if (v && typeof v === 'object') {
      const e = Object.entries(v).filter(([, x]) => x !== undefined);
      return e.length ? `{ ${e.map(([k, x]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : lit(k)}: ${lit(x)}`).join(', ')} }` : '{}';
    }
    return String(v);
  };

  // GET /api/key-actions ({ maps, modes }) -> script text. The kb names used here are a guess at the
  // kbcode API (docs/kb.d.ts): kb.mode(name); kb.key(name).actionMap({ press, gap, alsoType });
  // kb.key(name).when(trigger, mm | ms).if({ mode, notMode, held, notHeld }).mode(how).do(action). The triggers are the rule
  // JSON's own (press, release, down / up + mm, hold / tap + ms) and `do` takes the rule JSON's action as it is.
  // Mode ids become their names.
  function fromKeyActions({ maps = [], modes = [] } = {}) {
    const modeName = (id) => (typeof id === 'number' ? modes.find((m) => m.id === id)?.name || `Mode ${id}` : id);
    const names = (v) => (Array.isArray(v) ? v.map(modeName) : modeName(v));
    const ARG = { down: 'at', up: 'at', tap: 'ms', hold: 'ms' };
    const out = ['// Built from the key action maps on the keyboard (what the Wizard and Blocks tabs made).'];
    const named = modes.filter((m) => m.name);
    if (named.length) out.push('', ...named.map((m) => `kb.mode(${lit(m.name)});`));
    for (const m of maps) {
      const key = lit(m.key);
      out.push('', `// ${m.key}`);
      // only what differs from the driver's defaults (press 0.3 mm, gap 0.1 mm, alsoType false)
      const opts = { press: m.press !== 0.3 ? m.press : undefined, gap: m.gap !== 0.1 ? m.gap : undefined, alsoType: m.alsoType || undefined };
      if (Object.values(opts).some((x) => x !== undefined)) out.push(`kb.key(${key}).actionMap(${lit(opts)});`);
      for (const r of m.rules ?? []) {
        const arg = ARG[r.when];
        let s = `kb.key(${key}).when(${lit(r.when)}${arg && r[arg] !== undefined ? `, ${lit(r[arg])}` : ''})`;
        if (r.if && Object.keys(r.if).length) s += `.if(${lit({ ...r.if, mode: r.if.mode === undefined ? undefined : names(r.if.mode), notMode: r.if.notMode === undefined ? undefined : names(r.if.notMode) })})`;
        if (r.mode && r.mode !== App.keyActions?.defaultMode(r)) s += `.mode(${lit(r.mode)})`;   // the default "how" goes unsaid
        const act = r.do && typeof r.do === 'object' ? { ...r.do, ...(r.do.mode !== undefined && { mode: names(r.do.mode) }) } : r.do;
        s += `.do(${lit(act)});`;
        out.push(s);
      }
    }
    if (!maps.length) out.push('', '// No key has an action map yet.');
    return `${out.join('\n')}\n`;
  }

  async function fromBlocks() {
    await boot();
    await App.busy($('#kc-panel'), null, async () => {
      if (!(App.st.features ?? []).includes('keyActions')) throw new Error(App.ui.firmwareReason('Key action maps'));
      const r = await App.api('GET', '/api/key-actions');
      if (replace(fromKeyActions(r), 'one built from the key action maps on the keyboard')) App.toast(`${plural((r.maps ?? []).length, 'key')} with action maps put in the script`);
    });
  }

  // ---- board ------------------------------------------------------------------------------------------

  // the keys the script names in quotes light up on the board
  function usedKeys() {
    if (!S.cm) return;
    const text = S.cm.getValue(), next = new Set();
    for (const el of App.keyEls.values()) { const n = el.dataset.name; if (n && (text.includes(`'${n}'`) || text.includes(`"${n}"`))) next.add(n); }
    const changed = next.size !== S.used.size || [...next].some((n) => !S.used.has(n));
    S.used = next;
    if (changed && S.visible) App.paintKeys();
  }

  function shown(on) {
    S.visible = on;
    if (!on) { S.cm?.getInputField().blur(); return; }
    boot().then(() => { S.cm.refresh(); usedKeys(); drawResult(); }).catch(() => {});
  }

  App.kbCode = {
    paint(slot, el, mm) {
      const used = S.used.has(el.dataset.name);
      const val = App.$('.val', el);
      val.textContent = '';
      val.title = used ? 'Named in the script' : '';
      el.classList.remove('sel');
      el.style.background = used ? 'var(--cap-marked)' : 'var(--cap)';
      App.$('.fill', el).style.height = `${Math.min(mm / 3.6, 1) * 100}%`;
      return true;
    },
    keyDown(slot) {
      const name = App.keyEls.get(slot)?.dataset.name;
      if (!name || !S.cm) return true;
      S.cm.replaceSelection(lit(name));
      S.cm.focus();
      return true;
    },
    shown,
    canLeave: () => !tracker?.dirty || App.ui.confirmLeave(),
    fromKeyActions, parseDts, md,   // for the lead / tests: the converter and the readers
  };

  App.views.kbCode = {
    init() {
      tracker = App.ui.track($('#kc-panel'), { save: saveDraft, discard, saveLabel: 'Keep the draft on this PC', cleanText: 'Draft kept on this PC', savedText: 'Draft kept on this PC' });
      $('#kc-check').addEventListener('click', check);
      $('#kc-apply').addEventListener('click', apply);
      $('#kc-from-blocks').addEventListener('click', () => fromBlocks().catch(() => {}));
      $('#kc-docs-btn').addEventListener('click', () => toggleDocs());
      $('#kc-docs-close').addEventListener('click', () => toggleDocs(false));
      $('#kc-examples').addEventListener('focus', () => loadDocs());
      $('#kc-examples').addEventListener('change', (e) => {
        const x = S.docs?.examples?.[Number(e.target.value)];
        e.target.value = '';
        if (x && S.cm) replace(x.code.endsWith('\n') ? x.code : `${x.code}\n`, `the example "${x.name}"`);
      });
      $('#kc-result').addEventListener('click', (e) => { const b = e.target.closest('[data-line]'); if (b) jump(Number(b.dataset.line), Number(b.dataset.col)); });
      $('#kc-md').addEventListener('click', (e) => {
        const b = e.target.closest('[data-snip]');
        if (!b || !S.cm) return;
        S.cm.replaceSelection(`${S.snips[Number(b.dataset.snip)]}\n`);
        S.cm.focus();
      });
      // Ctrl+S / Ctrl+Enter work anywhere on the tab, not only inside the editor
      window.addEventListener('keydown', (e) => {
        if (!S.visible || App.st.view !== 'wizard' || !(e.ctrlKey || e.metaKey) || e.target.closest?.('.CodeMirror')) return;
        if (e.key === 's') { e.preventDefault(); keep(); } else if (e.key === 'Enter') { e.preventDefault(); check(); }
      });
      window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.visible && !$('#kc-docs').hidden && !S.cm?.state.completionActive) toggleDocs(false); });
    },
  };
})();
