'use strict';
// WorkHub page, part 6 of 7: Outlook monitoring, local prompts, Git, notes / editor, resizable layout.
// The page's script is split into parts loaded in order (index.html); they share one global scope.

// ---------- Outlook monitoring ----------
const Mail = {
  cfg() {
    const c = { enabled: false, folder: '', minutes: 2, keep_all: false, lookback: 7, ...(S.settings.mail || {}) };
    c.rules = c.rules || []; // a new workspace sends null
    return c;
  },
  async save(patch) { await saveSettings({ mail: { ...this.cfg(), ...patch } }); this.render(); },
  render() {
    const c = this.cfg();
    $('#mailOn').checked = c.enabled;
    $('#mailRules').innerHTML = c.rules.map((r, i) => `<div class="rule">${esc(r.match)} <span class="p">→ ${esc(r.project || 'capture project')}</span><span class="x" data-rule="${i}" title="Remove">✕</span></div>`).join('')
      || '<div class="muted tiny">No senders yet — add one below.</div>';
    if (document.activeElement !== $('#mailFolder')) $('#mailFolder').value = c.folder;
    $('#mailEvery').value = String(c.minutes || 2);
    $('#mailBack').value = String(c.lookback || 7);
    $('#mailKeepAll').checked = c.keep_all;
    $('#mailBadge').textContent = c.enabled && c.rules.length ? `· on, ${c.rules.length} sender(s)` : '· off';
  },
  async status() {
    try {
      const s = await api('GET', '/api/mail/status');
      const c = this.cfg();
      $('#mailStatus').textContent = !s.supported ? 'Outlook monitoring runs on Windows with classic Outlook.'
        : s.running ? 'Checking…'
        : s.last_error ? '⚠ ' + s.last_error
        : s.last_check && new Date(s.last_check).getFullYear() > 1971 ? `Last check ${new Date(s.last_check).toLocaleTimeString()} · ${s.matched} new matching mail · ${s.captured} captured since start`
        : c.enabled ? 'Waiting for first check…' : '';
      $('#mailStatus').style.color = s.last_error ? 'var(--danger)' : '';
      // Proof the check really read Outlook: the newest mail in the folder, and the last matching one.
      const line = (label, m, extra = '') => m ? `<div><span class="muted">${label}</span> <b>${esc(new Date(m.received).toLocaleString())}</b> · ${esc(m.from || '')}${m.address && m.address !== m.from ? ` &lt;${esc(m.address)}&gt;` : ''} · “${esc(m.subject || '(no subject)')}”${extra}</div>` : '';
      $('#mailProof').innerHTML = s.supported && !s.last_error && s.last_check && new Date(s.last_check).getFullYear() > 1971
        ? line(`Newest email in ${esc(s.folder)}:`, s.newest) + (s.newest ? '' : `<div class="muted">The ${esc(s.folder)} folder is empty.</div>`) +
          (s.last_match ? line('Last email from a watched sender:', s.last_match, s.last_match.captured ? ' <span class="ok">✓ captured</span>' : ' <span class="muted">(no hosts/logins found in it)</span>') : '<div class="muted">No email from your watched senders yet.</div>')
        : '';
    } catch { /* ignore */ }
  },
};
$('#mailOn').onchange = e => Mail.save({ enabled: e.target.checked }).then(() => e.target.checked && api('POST', '/api/mail/check'));
$('#mailAdd').onclick = () => {
  const m = $('#mailMatch').value.trim();
  if (!m) return toast('Enter a sender address, *@domain or name', true);
  Mail.save({ rules: [...Mail.cfg().rules, { match: m, project: $('#mailProject').value.trim() }] });
  $('#mailMatch').value = ''; $('#mailProject').value = '';
};
$('#mailMatch').addEventListener('keydown', e => { if (e.key === 'Enter') $('#mailAdd').click(); });
$('#mailRules').addEventListener('click', e => { const x = e.target.closest('[data-rule]'); if (x) Mail.save({ rules: Mail.cfg().rules.filter((_, i) => i !== +x.dataset.rule) }); });
$('#mailFolder').onchange = e => Mail.save({ folder: e.target.value.trim() });
$('#mailEvery').onchange = e => Mail.save({ minutes: +e.target.value });
$('#mailBack').onchange = e => Mail.save({ lookback: +e.target.value });
$('#mailKeepAll').onchange = e => Mail.save({ keep_all: e.target.checked });
$('#mailCheck').onclick = async () => { await api('POST', '/api/mail/check'); $('#mailStatus').textContent = 'Checking…'; setTimeout(() => { Mail.status(); poll(); }, 3000); };
setInterval(() => { if ($('#view-inbox').classList.contains('active')) Mail.status(); }, 10000);

// ---------- local command prompts ----------
let SHELLS = [];
api('GET', '/api/local/shells').then(list => {
  SHELLS = list || [];
  $('#localShells').innerHTML = SHELLS.map((s, i) => `<button data-sh="${i}">⌨ ${esc(s.name)}</button>`).join('');
}).catch(() => {});
$('#localShells').addEventListener('click', e => { const b = e.target.closest('[data-sh]'); if (b) Term.openLocal(SHELLS[b.dataset.sh]); });

// ---------- git ----------
const Git = {
  repo: '', ref: '', info: null, commits: [], selected: '',

  repos() { return S.settings.repos || []; },
  async saveRepos(list) { await saveSettings({ repos: [...new Set(list)] }); this.renderRepos(); },

  renderRepos() {
    const list = this.repos();
    $('#gitRepoList').innerHTML = list.map(p => {
      const parts = p.split(/[\\/]/).filter(Boolean);
      return `<div class="repo ${p === this.repo ? 'active' : ''}" data-repo="${esc(p)}" title="${esc(p)}"><span class="nm">${esc(parts.pop())}<small>${esc(parts.slice(-2).join('/'))}</small></span><span class="x" data-rm="${esc(p)}" title="Remove from list">✕</span></div>`;
    }).join('') || '<div class="empty" style="padding:16px">No repositories yet.</div>';
    $('#gitEmpty').hidden = !!this.repo;
    $('#gitSplit').hidden = !this.repo;
  },

  async open(p, ref) {
    if (ref === undefined) { try { ref = localStorage.getItem('gitRef.' + p) || ''; } catch { ref = ''; } }
    this.repo = p; this.ref = ref; this.selected = '';
    try { localStorage.setItem('gitRepo', p); } catch { /* ignore */ }
    this.renderRepos();
    $('#gitTitle').textContent = p.split(/[\\/]/).filter(Boolean).pop();
    try {
      this.info = await api('GET', '/api/git/info?path=' + encodeURIComponent(p));
      $('#gitFetch').disabled = !this.info.has_git;
      $('#gitFetch').title = this.info.has_git ? 'git fetch --all --prune (uses your installed Git and its logins)' : 'Git is not installed on this PC; browsing still works';
      this.renderBranches();
      await this.loadLog();
    } catch (err) {
      $('#gitLog').innerHTML = `<div class="empty">${esc(err.message)}</div>`;
      $('#gitBranches').innerHTML = '';
    }
  },

  renderBranches() {
    const q = $('#gitBranchFilter').value.trim().toLowerCase();
    const list = (this.info?.branches || []).filter(b => !q || b.name.toLowerCase().includes(q));
    const row = b => `<div class="br ${b.current ? 'current' : ''} ${(this.ref || this.info.current) === b.name ? 'active' : ''}" data-ref="${esc(b.name)}" title="${esc(b.subject)}">
      <div class="bn">${esc(b.name)}</div><small>${fmtTime(b.date)} · ${esc(b.author || '')} · ${esc(b.subject || '')}</small></div>`;
    const local = list.filter(b => !b.remote), remote = list.filter(b => b.remote);
    $('#gitBranches').innerHTML = (local.length ? '<div class="br-sep">Local</div>' + local.map(row).join('') : '') +
      (remote.length ? '<div class="br-sep">Remote</div>' + remote.map(row).join('') : '') || '<div class="empty">No branches</div>';
    $('#gitViewing').textContent = this.ref || this.info.current || '';
  },

  async loadLog() {
    const q = $('#gitSearch').value.trim();
    $('#gitLog').innerHTML = '<div class="empty">Loading history…</div>';
    try {
      this.commits = await api('GET', `/api/git/log?path=${encodeURIComponent(this.repo)}&ref=${encodeURIComponent(this.ref)}&q=${encodeURIComponent(q)}&limit=500`);
    } catch (err) { $('#gitLog').innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }
    const refBadge = r => `<span class="ref ${r.includes('/') && !this.info.branches.some(b => !b.remote && b.name === r) ? 'remote' : ''} ${this.info.branches.some(b => b.name === r) ? '' : 'tag'}">${esc(r)}</span>`;
    $('#gitLog').innerHTML = this.commits.map(c => `<div class="cm ${c.hash === this.selected ? 'active' : ''}" data-c="${c.hash}">
      <span class="d" title="${esc(new Date(c.date).toLocaleString())}">${fmtDateTime(c.date)}</span><span class="h">${c.short}</span>
      <span class="s">${(c.refs || []).map(refBadge).join('')}${esc(c.subject)}</span><span class="a" title="${esc(c.email)}">${esc(c.author)}</span></div>`).join('')
      || '<div class="empty">No commits.</div>';
  },

  async show(hash) {
    this.selected = hash;
    $$('#gitLog .cm').forEach(x => x.classList.toggle('active', x.dataset.c === hash));
    $('#gitDetail').innerHTML = '<div class="empty">Loading…</div>';
    try {
      const r = await api('GET', `/api/git/commit?path=${encodeURIComponent(this.repo)}&hash=${hash}`);
      const c = r.commit;
      $('#gitDetail').innerHTML = `<div class="cd-head"><h4>${esc(c.subject)}</h4>
        <span class="muted tiny"><span class="h copy" data-copy="${c.hash}" title="Copy full hash">${c.short}</span> · ${esc(c.author)} &lt;${esc(c.email)}&gt; · ${new Date(c.date).toLocaleString()}${c.parents.length > 1 ? ' · merge' : ''}</span>
        ${c.body ? `<pre>${esc(c.body)}</pre>` : ''}</div>
        <div class="cd-files">${r.files.map((f, i) => `<div data-f="${i}"><span class="fs ${f.status}">${f.status}</span>${esc(f.path)} <span class="n">+${f.adds} −${f.dels}</span></div>`).join('')}</div>
        <pre class="diff">${diffHTML(r.patch)}</pre>`;
    } catch (err) { $('#gitDetail').innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
  },

  async changes() {
    $('#gitDetail').innerHTML = '<div class="empty">Checking the working folder…</div>';
    try {
      const list = await api('GET', '/api/git/status?path=' + encodeURIComponent(this.repo));
      const label = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', '?': 'untracked', C: 'copied', U: 'conflict' };
      $('#gitDetail').innerHTML = `<div class="cd-head"><h4>Uncommitted changes (${list.length})</h4></div><div class="cd-files">` +
        (list.map(f => { const s = f.worktree !== ' ' ? f.worktree : f.staged; return `<div><span class="fs ${s === '?' ? 'A' : s}">${esc(s)}</span>${esc(f.path)} <span class="n">${label[s] || ''}${f.staged !== ' ' && f.staged !== '?' ? ' · staged' : ''}</span></div>`; }).join('') || 'Nothing to commit — working folder is clean.') + '</div>';
    } catch (err) { $('#gitDetail').innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
  },
};

function diffHTML(text) {
  return text.split('\n').map(l => {
    const cls = l.startsWith('diff --git') ? 'file' : l.startsWith('@@') ? 'hunk' : l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : '';
    return `<span class="${cls}">${esc(l) || ' '}</span>`;
  }).join('');
}

$('#gitRepoList').addEventListener('click', e => {
  const rm = e.target.closest('[data-rm]');
  if (rm) { if (Git.repo === rm.dataset.rm) Git.repo = ''; return Git.saveRepos(Git.repos().filter(p => p !== rm.dataset.rm)); }
  const r = e.target.closest('[data-repo]');
  if (r) Git.open(r.dataset.repo);
});
$('#gitBranches').addEventListener('click', e => {
  const b = e.target.closest('[data-ref]'); if (!b) return;
  Git.ref = b.dataset.ref;
  try { localStorage.setItem('gitRef.' + Git.repo, Git.ref); } catch { /* ignore */ }
  Git.renderBranches(); Git.loadLog();
});
$('#gitBranchFilter').addEventListener('input', () => Git.info && Git.renderBranches());
$('#gitLog').addEventListener('click', e => { const c = e.target.closest('[data-c]'); if (c) Git.show(c.dataset.c); });
$('#gitDetail').addEventListener('click', e => {
  const cp = e.target.closest('[data-copy]'); if (cp) return copyText(cp.dataset.copy, 'Hash copied');
  const f = e.target.closest('[data-f]');
  if (f) { const heads = $$('#gitDetail .diff .file'); heads[+f.dataset.f]?.scrollIntoView({ block: 'start' }); }
});
let gitSearchTimer;
$('#gitSearch').addEventListener('input', () => { clearTimeout(gitSearchTimer); gitSearchTimer = setTimeout(() => Git.repo && Git.loadLog(), 400); });
$('#gitChanges').onclick = () => Git.repo && Git.changes();
$('#gitTerm').onclick = () => { if (Git.repo && SHELLS.length) Term.openLocal(SHELLS[0], Git.info?.root || Git.repo); };
$('#gitFetch').onclick = async () => {
  if (!Git.repo) return;
  toast('Fetching…');
  try { const r = await api('POST', '/api/git/fetch', { path: Git.info?.root || Git.repo }); toast(r.output ? 'Fetched: ' + r.output.split('\n').length + ' update line(s)' : 'Fetched — already up to date'); Git.open(Git.repo, Git.ref); }
  catch (err) { toast(err.message, true); }
};
$('#gitAdd').onclick = async () => {
  toast('Choose the repository folder in the window that opened (it may be behind the browser)');
  try {
    const r = await api('POST', '/api/local/pick', { key: 'git-add' });
    if (!r.ok) return;
    const info = await api('GET', '/api/git/info?path=' + encodeURIComponent(r.path));
    const root = info.root || r.path;
    await Git.saveRepos([...Git.repos(), root]);
    Git.open(root);
  } catch (err) { toast('Not a Git repository: ' + err.message, true); }
};
$('#gitFind').onclick = async () => {
  toast('Looking for repositories…');
  try {
    const found = (await api('GET', '/api/git/find')).filter(p => !Git.repos().includes(p));
    if (!found.length) return toast('No new repositories found');
    if (!await askYes(`Found ${found.length} repositories:\n\n${found.slice(0, 25).join('\n')}${found.length > 25 ? '\n…' : ''}\n\nAdd them all?`)) return;
    await Git.saveRepos([...Git.repos(), ...found]);
    if (!Git.repo) Git.open(found[0]);
  } catch (err) { toast(err.message, true); }
};

// ---------- notes / editor ----------
const Notes = {
  docs: [], active: null, notes: [], recent: [], timer: null,

  async renderLists() {
    [this.notes, this.recent] = (await Promise.all([api('GET', '/api/notes'), api('GET', '/api/recent')])).map(x => x || []);
    $('#noteList').innerHTML = this.notes.map(n => `<div class="li ${this.active?.key === 'note:' + n.id ? 'active' : ''}" data-open="note:${n.id}">${esc(n.title || 'Untitled')}<small>${fmtTime(n.updated)}</small></div>`).join('') || '<div class="muted tiny">No notes yet</div>';
    $('#recentList').innerHTML = this.recent.map(r => {
      const parts = r.path.split(/[\\/]/);
      return `<div class="li" data-open="file:${esc(r.path)}" title="${esc(r.path)}">${esc(parts.pop())}<small>${esc(parts.join('/'))}</small></div>`;
    }).join('') || '<div class="muted tiny">No recent files</div>';
  },

  async open(key) {
    let d = this.docs.find(x => x.key === key);
    if (!d) {
      try {
        if (key.startsWith('note:')) {
          const n = this.notes.find(x => 'note:' + x.id === key) || (await api('GET', '/api/notes')).find(x => 'note:' + x.id === key);
          if (!n) return;
          let lang = 'text'; try { lang = localStorage.getItem('notelang.' + n.id) || 'text'; } catch { /* ignore */ }
          d = { key, id: n.id, title: n.title || 'Untitled', content: n.body, lang };
        } else {
          const f = await api('GET', '/api/file?path=' + encodeURIComponent(key.slice(5)));
          // Same file typed differently (quotes, ~, other slashes): reuse its tab.
          const same = this.docs.find(x => x.path && x.path.toLowerCase() === f.path.toLowerCase());
          if (same) { this.activate(same); return same; }
          d = { key: 'file:' + f.path, path: f.path, title: f.path.split(/[\\/]/).pop(), content: f.content, lang: langForPath(f.path) };
        }
      } catch (err) { toast(err.message, true); return null; }
      d.dirty = false;
      d.cmDoc = CodeMirror.Doc(d.content, modeOf(d.lang)); // own undo history per tab
      this.docs.push(d);
      this.persistTabs();
    }
    this.activate(d);
    return d;
  },

  activate(d) {
    this.active = d;
    this.cm.swapDoc(d ? d.cmDoc : this.emptyDoc);
    this.cm.setOption('readOnly', d ? false : 'nocursor');
    $('#langPick').value = d ? d.lang : 'text';
    $('#langPick').disabled = !d;
    this.renderTabs(); this.status(d ? (d.path || 'Note — saved automatically') : ''); updateCursor();
    if (d) setTimeout(() => { this.cm.refresh(); this.cm.focus(); });
    $$('#noteList .li').forEach(li => li.classList.toggle('active', li.dataset.open === d?.key));
  },

  renderTabs() {
    $('#docTabs').innerHTML = this.docs.map(d => `<div class="tab ${d === this.active ? 'active' : ''}" data-k="${esc(d.key)}" title="${esc(d.path || d.title)}">
      ${d.dirty ? '●' : ''}${typeof Groups !== 'undefined' ? Groups.chip((d.path || '') + ' ' + d.title + ' ' + (d.content || '').slice(0, 20000)) : ''}${esc(d.title)}<span class="x" data-x="${esc(d.key)}">✕</span></div>`).join('');
  },

  status(msg) { $('#docStatus').textContent = msg; },

  edited() {
    const d = this.active; if (!d) return;
    d.content = d.cmDoc.getValue();
    if (!d.dirty) { d.dirty = true; this.renderTabs(); }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.save(d), 800);
  },

  async save(d) {
    if (!d || !d.dirty) return;
    const content = d.content;
    this.status('Saving…');
    try {
      if (d.id) {
        const title = (content.split('\n').find(l => l.trim()) || 'Untitled').trim().slice(0, 60);
        await api('POST', '/api/notes', { id: d.id, title, body: content });
        d.title = title;
      } else {
        await api('PUT', '/api/file', { path: d.path, content });
      }
      if (d.content === content) d.dirty = false;
      this.renderTabs();
      if (d === this.active) this.status(`Saved ${new Date().toLocaleTimeString()}`);
    } catch (err) {
      this.status('Save failed: ' + err.message);
      toast('Save failed: ' + err.message, true);
    }
  },

  async close(key) {
    const d = this.docs.find(x => x.key === key);
    await this.save(d);
    this.docs = this.docs.filter(x => x !== d);
    this.persistTabs();
    if (this.active === d) { this.active = null; this.activate(this.docs.at(-1) || null); } else this.renderTabs();
  },

  persistTabs() { saveSettings({ open_tabs: this.docs.map(d => d.key) }).catch(() => {}); },
};

Notes.emptyDoc = CodeMirror.Doc('', 'text/plain');
Notes.cm = makeEditor($('#editorHost'), { value: '', readOnly: 'nocursor' });
Notes.cm.addKeyMap({ 'Ctrl-S': () => { clearTimeout(Notes.timer); Notes.save(Notes.active); }, 'Cmd-S': () => { clearTimeout(Notes.timer); Notes.save(Notes.active); } });
Notes.cm.on('changes', () => { if (Notes.active && Notes.cm.getDoc() === Notes.active.cmDoc) Notes.edited(); });
Notes.cm.on('cursorActivity', updateCursor);
function updateCursor() {
  const cm = Notes.cm, c = cm.getCursor(), sel = cm.getSelection();
  $('#cursorPos').textContent = Notes.active ? `Ln ${c.line + 1}, Col ${c.ch + 1}${sel ? ` · ${sel.length} selected` : ''} · ${cm.lineCount()} lines` : '';
}
$('#langPick').innerHTML = LANGS.map(([id, name]) => `<option value="${id}">${esc(name)}</option>`).join('');
$('#langPick').onchange = e => {
  const d = Notes.active; if (!d) return;
  d.lang = e.target.value;
  Notes.cm.setOption('mode', modeOf(d.lang));
  if (d.id) { try { localStorage.setItem('notelang.' + d.id, d.lang); } catch { /* ignore */ } }
};
$('#wrapToggle').checked = (() => { try { return localStorage.getItem('wrap') === '1'; } catch { return false; } })();
Notes.cm.setOption('lineWrapping', $('#wrapToggle').checked);
$('#wrapToggle').onchange = e => { Notes.cm.setOption('lineWrapping', e.target.checked); try { localStorage.setItem('wrap', e.target.checked ? '1' : '0'); } catch { /* ignore */ } };
$('#docTabs').addEventListener('click', e => {
  const x = e.target.closest('[data-x]');
  if (x) return Notes.close(x.dataset.x);
  const t = e.target.closest('[data-k]');
  if (t) Notes.activate(Notes.docs.find(d => d.key === t.dataset.k));
});
$('#view-notes').addEventListener('click', e => { const o = e.target.closest('[data-open]'); if (o) Notes.open(o.dataset.open); });
$('#newNote').onclick = async () => {
  const n = await api('POST', '/api/notes', { title: 'Untitled', body: '' });
  await Notes.renderLists();
  await Notes.open('note:' + n.id);
  Notes.cm.focus();
};
async function browseFile() {
  toast('Choose a file in the window that opened (it may be behind the browser)');
  try {
    const r = await api('POST', '/api/local/pickfile', { key: 'notes-file' });
    if (r.ok) await Notes.open('file:' + r.path);
  } catch (err) { toast(err.message, true); }
}
// Open: the typed path, or (like Notepad++) the system Open window when empty.
$('#openBtn').onclick = async () => {
  const p = $('#openPath').value.trim().replace(/^["']|["']$/g, '');
  if (!p) return browseFile();
  if (await Notes.open('file:' + p)) $('#openPath').value = ''; // keep a mistyped path for fixing
};
$('#browseFile').onclick = browseFile;
$('#openPath').addEventListener('keydown', e => { if (e.key === 'Enter') $('#openBtn').click(); });
$('#extractBtn').onclick = async () => {
  const d = Notes.active; if (!d || !d.content.trim()) return;
  try {
    const r = await api('POST', '/api/ingest', { text: d.content, source: 'note', project: S.settings.project });
    toast(r.entries?.length ? `Filed ${r.entries.length} item(s) on the Dashboard` : 'No hosts/URLs/credentials recognised');
    poll();
  } catch (err) { toast(err.message, true); }
};
// Flush unsaved edits if the tab is closed (notes only; sendBeacon can only POST).
window.addEventListener('beforeunload', () => {
  for (const d of Notes.docs.filter(d => d.dirty)) {
    if (d.id) navigator.sendBeacon('/api/notes', new Blob([JSON.stringify({ id: d.id, title: d.title, body: d.content })], { type: 'application/json' }));
    else navigator.sendBeacon('/api/file', new Blob([JSON.stringify({ path: d.path, content: d.content })], { type: 'application/json' }));
  }
});

// ---------- resizable layout ----------
// Drag bars resize the sidebar, the server trees and FileZilla's two panes;
// sizes and hidden panels are remembered per browser.
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('ui.' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ui.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

function dragBar(bar, { start, apply, done }) {
  bar.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    const x0 = e.clientX, w0 = start();
    bar.setPointerCapture(e.pointerId);
    bar.classList.add('drag'); document.body.classList.add('dragging');
    let raf = 0;
    const move = ev => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { apply(w0 + ev.clientX - x0); fitActiveTerm(); });
    };
    const up = () => {
      bar.removeEventListener('pointermove', move);
      bar.classList.remove('drag'); document.body.classList.remove('dragging');
      done?.();
      fitActiveTerm();
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up, { once: true });
    bar.addEventListener('pointercancel', up, { once: true });
  });
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const root = document.documentElement;

// Colour read-only text with an editor language (the API answer…): HTML with cm-* spans,
// shown inside an element with class cm-s-wh. Big texts are left plain (fast).
function highlightHTML(text, mode) {
  if (!text || text.length > 400000 || !mode || mode === 'text/plain') return esc(text || '');
  const m = CodeMirror.getMode(CodeMirror.defaults, mode); if (!m || m.name === 'null') return esc(text);
  const st = CodeMirror.startState(m); let out = '';
  for (const line of text.split('\n')) {
    const s = new CodeMirror.StringStream(line, 4);
    if (!line && m.blankLine) m.blankLine(st);
    while (!s.eol()) {
      let tok = null; try { tok = m.token(s, st); } catch { s.skipToEnd(); }
      const piece = esc(s.current());
      out += tok ? `<span class="${tok.split(' ').map(t => 'cm-' + t).join(' ')}">${piece}</span>` : piece;
      s.start = s.pos;
    }
    out += '\n';
  }
  return out.slice(0, -1);
}
// Turn a <textarea> into the code editor in place: code reading or setting ta.value keeps
// working (setting it doesn't count as typing); typing fires 'input' on the textarea.
function editorOverTextarea(ta, opts = {}) {
  if (ta.cm) return ta.cm;
  const host = Object.assign(document.createElement('div'), { className: 'cm-over ' + (ta.className || '') });
  ta.after(host); ta.hidden = true;
  const cm = makeEditor(host, { value: ta.value, lineWrapping: true, ...opts });
  let quiet = false;
  const proto = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
  Object.defineProperty(ta, 'value', { configurable: true, get: () => cm.getValue(), set: v => { quiet = true; cm.setValue(v ?? ''); cm.clearHistory(); quiet = false; proto.set.call(ta, v ?? ''); } });
  cm.on('change', () => { if (!quiet) ta.dispatchEvent(new Event('input', { bubbles: true })); });
  ta.focus = () => cm.focus();
  if (ta.placeholder) cm.setOption('placeholder', ta.placeholder);
  ta.cm = cm; setTimeout(() => cm.refresh());
  return cm;
}

// Text size per pane: A−/A+ buttons or Ctrl + mouse wheel. (Ctrl +/− in the
// browser still zooms the whole app.)
const Fonts = {
  sizes: store.get('fonts', { term: 14, editor: 14, sql: 14 }), // a size you chose (A-/A+) is kept
  size(k) { return this.sizes[k] || 14; },
  // Text size of the whole app (Settings → Appearance): every font scales with --ui-scale.
  // 1.16: every size one step bigger (Normal 1.08 → 1.14); a size chosen before moves up with it, once
  ui() {
    let v = store.get('uiScale', 1.14);
    if (!store.get('uiScaleV2', false)) { v = { 1: 1.06, 1.08: 1.14, 1.15: 1.22, 1.25: 1.32 }[v] ?? v; store.set('uiScale', v); store.set('uiScaleV2', true); }
    return v;
  },
  setUI(v) { store.set('uiScale', v); root.style.setProperty('--ui-scale', v); window.dispatchEvent(new Event('resize')); },
  set(k, v) {
    this.sizes[k] = clamp(Math.round(v), 8, 32);
    store.set('fonts', this.sizes);
    this.apply();
  },
  apply() {
    root.style.setProperty('--ui-scale', this.ui());
    root.style.setProperty('--fs-editor', this.size('editor') + 'px');
    root.style.setProperty('--fs-sql', this.size('sql') + 'px');
    Term.tabs.forEach(t => { t.term.options.fontSize = this.size('term'); });
    fitActiveTerm();
    $$('.fontctl').forEach(c => ($('span', c).textContent = this.size(c.dataset.font) + 'px'));
    Notes.cm?.refresh(); SQL.cm?.refresh();
  },
};
$$('.fontctl').forEach(c => c.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  Fonts.set(c.dataset.font, Fonts.size(c.dataset.font) + (b.textContent.includes('+') ? 1 : -1));
}));
for (const [sel, k] of [['#termWrap', 'term'], ['.editor', 'editor'], ['.sql-left', 'sql']]) {
  $(sel).addEventListener('wheel', e => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault(); // otherwise the browser zooms the whole page
    Fonts.set(k, Fonts.size(k) + (e.deltaY < 0 ? 1 : -1));
  }, { passive: false });
}

// Sidebar
const setSide = w => root.style.setProperty('--side-w', clamp(w, 170, 420) + 'px');
setSide(store.get('sideW', 236));
Fonts.apply();
// The menu can sit on the left (default) or across the top (remembered).
function applySideTop(top) {
  document.body.classList.toggle('side-top', top);
  (top ? $('.side') : $('.appbar')).append($('#gsearch')); // search stays at the top right
  // left: 💬 and ✨ sit in the title row (☰ and the layout switch are in the menu bar); top: all in the tools row
  { const b = $('#whatsNewTop'); if (b) top ? $('.brand-tools').insertBefore(b, $('#mainMenuBtn')) : $('.ver-row').append(b); } // left: after the version, bottom left
  $('#gsearch').prepend($('#chatFab')); // 💬 Assistant: at the top, next to ● Capturing (it asks before saving what you copy)
  if (!$('#askTop')) { // 🔎 Ask (Confluence & Jira) right after it
    const b = Object.assign(document.createElement('button'), { id: 'askTop', className: 'ghost icon', title: 'Ask Confluence & Jira' });
    b.setAttribute('aria-label', 'Ask Confluence & Jira');
    b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/><path d="M8.2 9.2a2.4 2.4 0 1 1 3.3 2.2c-.6.3-1 .8-1 1.4"/><circle cx="10.5" cy="14.6" r=".4"/></svg>';
    b.onclick = () => { show('ask'); setTimeout(() => $('#askQ')?.focus(), 50); };
    $('#chatFab').before(b);
  }
  const b = $('#sideFlip');
  b.title = top ? 'Move this menu back to the left' : 'Move this menu to the top of the window';
  b.innerHTML = top ? '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>' : '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/></svg>';
  setTimeout(() => { fitActiveTerm(); window.dispatchEvent(new Event('resize')); }, 50);
}
applySideTop((() => { try { return localStorage.getItem('sideTop') === '1'; } catch { return false; } })());
$('#sideFlip').onclick = () => {
  const top = !document.body.classList.contains('side-top');
  try { localStorage.setItem('sideTop', top ? '1' : '0'); } catch { /* ignore */ }
  S.autoSide = false; S.userSide = false;
  applySideTop(top);
  applySide();
};

// Narrow windows (under 1000px) show the sidebar as icons only.
const narrowWin = matchMedia('(max-width: 1000px)');
const applySide = () => {
  const top = document.body.classList.contains('side-top'); // at the top: icons only on narrow windows
  document.body.classList.toggle('side-collapsed', narrowWin.matches || (!top && store.get('sideCollapsed', false)));
  if ($('#sideToggle')) $('#sideToggle').textContent = document.body.classList.contains('side-collapsed') ? '»' : '«';
};
applySide();
narrowWin.addEventListener('change', () => { applySide(); fitActiveTerm(); });
dragBar($('#sideSplit'), {
  start: () => $('.side').getBoundingClientRect().width,
  apply: setSide,
  done: () => store.set('sideW', parseInt(getComputedStyle(root).getPropertyValue('--side-w'))),
});
function toggleSide() {
  if (sidePinned()) return toast('The menu is pinned 📌 — click the pin to unpin it first');
  animateSide();
  const c = document.body.classList.toggle('side-collapsed');
  S.autoSide = false; S.userSide = !c; // expanded by hand: leave it open until the user collapses it or goes back to the dashboard
  if (!narrowWin.matches) store.set('sideCollapsed', c); // on a narrow window: just for now
  $('#sideToggle').textContent = c ? '»' : '«';
  fitActiveTerm();
}
$('#sideToggle').textContent = document.body.classList.contains('side-collapsed') ? '»' : '«';
$('#sideToggle').onclick = toggleSide;
setSidePin(!!store.get('sidePinned', false));
$('#sidePin').onclick = () => { setSidePin(!sidePinned()); toast(sidePinned() ? '📌 Menu pinned — it stays as it is' : 'Menu unpinned'); };
// Double-click on empty space in the left menu: full menu ⇄ narrow icon rail (not on pages, buttons or boxes)
$('.side').addEventListener('dblclick', e => {
  if (document.body.classList.contains('side-top') || e.target.closest('button, a, input, select, textarea, label, summary, details, [contenteditable], .navrow')) return;
  getSelection()?.removeAllRanges(); // a double-click selects a word
  toggleSide();
});
// Ctrl+B hides / shows the sidebar — except where you are writing text, where
// it means bold (message boxes) or belongs to that box.
document.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'b' || e.shiftKey || e.altKey) return;
  if (e.target.isContentEditable || e.target.closest?.('input, textarea, select, .CodeMirror, .xterm')) return;
  e.preventDefault(); toggleSide();
});
$$('#nav button[data-view]').forEach(b => (b.title = $('.nl', b)?.textContent || ''));

// Server trees (PuTTY and FileZilla, sized separately)
$$('.with-tree').forEach(wt => {
  const key = 'tree.' + $('.tree-host', wt).dataset.mode, bar = $('.tree-split', wt), knob = $('.knob', bar);
  const setW = w => wt.style.setProperty('--tree-w', clamp(w, 160, 600) + 'px');
  const toggle = () => {
    const hidden = wt.classList.toggle('tree-hidden');
    knob.textContent = hidden ? '›' : '‹';
    store.set(key + '.hidden', hidden);
    fitActiveTerm();
  };
  if (store.get(key + '.w', 0)) setW(store.get(key + '.w', 0)); // else the CSS default, which grows with the screen
  if (store.get(key + '.hidden', false)) { wt.classList.add('tree-hidden'); knob.textContent = '›'; }
  dragBar(bar, {
    start: () => wt.classList.contains('tree-hidden') ? 0 : $('.tree-host', wt).getBoundingClientRect().width,
    apply: w => {
      if (wt.classList.contains('tree-hidden')) { if (w < 60) return; toggle(); }
      setW(w);
    },
    done: () => store.set(key + '.w', parseInt(wt.style.getPropertyValue('--tree-w'))),
  });
  knob.onclick = toggle;
  bar.addEventListener('dblclick', toggle);
});

// SQL: editor vs results
{
  const bar = $('#sqlSplit'), ed = $('#sqlEditorHost');
  const saved = store.get('sqlEdH', null);
  if (saved) ed.style.height = saved + 'px';
  bar.addEventListener('pointerdown', e => {
    e.preventDefault();
    const y0 = e.clientY, h0 = ed.getBoundingClientRect().height;
    bar.setPointerCapture(e.pointerId);
    bar.classList.add('drag'); document.body.classList.add('rdragging');
    const move = ev => { ed.style.height = clamp(h0 + ev.clientY - y0, 60, window.innerHeight - 220) + 'px'; };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', () => {
      bar.removeEventListener('pointermove', move);
      bar.classList.remove('drag'); document.body.classList.remove('rdragging');
      store.set('sqlEdH', parseInt(ed.style.height));
      SQL.cm.refresh();
    }, { once: true });
  });
}

// Dashboard: resizable table columns and card width
{
  const board = $('#board');
  const widths = store.get('colWidths', {});
  for (const [i, w] of Object.entries(widths)) board.style.setProperty('--c' + i, w + 'px');
  board.addEventListener('pointerdown', e => {
    const grip = e.target.closest('.colgrip'); if (!grip) return;
    e.preventDefault();
    const i = grip.dataset.col, th = grip.parentElement, x0 = e.clientX, w0 = th.getBoundingClientRect().width;
    grip.setPointerCapture(e.pointerId);
    document.body.classList.add('dragging');
    const move = ev => board.style.setProperty('--c' + i, clamp(w0 + ev.clientX - x0, 40, 900) + 'px');
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', () => {
      grip.removeEventListener('pointermove', move);
      document.body.classList.remove('dragging');
      widths[i] = parseInt(board.style.getPropertyValue('--c' + i));
      store.set('colWidths', widths);
    }, { once: true });
  });
  board.addEventListener('dblclick', e => {
    const grip = e.target.closest('.colgrip'); if (!grip) return;
    board.style.removeProperty('--c' + grip.dataset.col);
    delete widths[grip.dataset.col];
    store.set('colWidths', widths);
  });
  const slider = $('#cardWidth');
  const setCard = w => { board.style.setProperty('--card-w', w + 'px'); slider.value = w; };
  setCard(store.get('cardW', 340));
  slider.addEventListener('input', () => setCard(+slider.value));
  slider.addEventListener('change', () => store.set('cardW', +slider.value));
}

// FileZilla: This PC vs server
{
  const panes = $('.panes'), mid = $('.mid', panes);
  const setL = w => panes.style.setProperty('--lp', clamp(w, 160, panes.clientWidth - 260) + 'px');
  const saved = store.get('filesLeft', null);
  if (saved) panes.style.setProperty('--lp', saved + 'px');
  dragBar(mid, {
    start: () => $('#localPane').getBoundingClientRect().width,
    apply: setL,
    done: () => store.set('filesLeft', parseInt(panes.style.getPropertyValue('--lp'))),
  });
  mid.addEventListener('dblclick', e => { if (!e.target.closest('button')) { panes.style.removeProperty('--lp'); store.set('filesLeft', null); } });
}
