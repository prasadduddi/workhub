'use strict';
// Tasks: one thread per ticket / change / incident (these replaced the Notes
// work items). Posts are time-stamped notes with pasted screenshots and files,
// text captured from the clipboard while the thread is "capturing", and
// servers added from any right-click menu. A Word copy is kept up to date.

const STATUSES = [['todo', 'To do'], ['doing', 'In progress'], ['blocked', 'Blocked'], ['done', 'Done']];

// ---- keep pasted/saved HTML safe: only simple formatting survives ----
const SAFE_TAGS = new Set(['P', 'DIV', 'BR', 'SPAN', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'H1', 'H2', 'H3', 'H4', 'UL', 'OL', 'LI',
  'A', 'IMG', 'PRE', 'CODE', 'BLOCKQUOTE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'HR', 'INPUT', 'SUB', 'SUP', 'MARK']);
function sanitizeHTML(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const clean = node => {
    for (const el of [...node.children]) {
      if (!SAFE_TAGS.has(el.tagName)) {
        if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'META', 'LINK', 'TITLE', 'HEAD', 'SVG', 'MATH', 'FORM', 'BUTTON', 'SELECT', 'TEXTAREA'].includes(el.tagName)) { el.remove(); continue; }
        clean(el); el.replaceWith(...el.childNodes); continue; // unknown wrapper: keep its content
      }
      for (const at of [...el.attributes]) {
        const n = at.name.toLowerCase();
        const keep = (el.tagName === 'A' && n === 'href') || (el.tagName === 'IMG' && (n === 'src' || n === 'alt' || n === 'data-file')) ||
          (['TD', 'TH'].includes(el.tagName) && (n === 'colspan' || n === 'rowspan')) || (el.tagName === 'INPUT' && (n === 'type' || n === 'checked'));
        if (!keep) el.removeAttribute(at.name);
      }
      if (el.tagName === 'A') {
        const h = el.getAttribute('href') || '';
        if (!/^(https?:|mailto:)/i.test(h)) el.removeAttribute('href'); else { el.target = '_blank'; el.rel = 'noopener'; }
      }
      if (el.tagName === 'IMG' && !/^\/api\/props\/files\/[0-9a-f]+$/.test(el.getAttribute('src') || '') && !/^data:image\//.test(el.getAttribute('src') || '')) {
        // Remote pictures (from web pages) can't be kept offline: leave a link instead.
        const src = el.getAttribute('src') || '';
        if (/^https?:/i.test(src)) { const a = doc.createElement('a'); a.href = src; a.textContent = '[image: ' + src.split('/').pop().slice(0, 60) + ']'; a.target = '_blank'; el.replaceWith(a); } else el.remove();
        continue;
      }
      if (el.tagName === 'INPUT' && el.getAttribute('type') !== 'checkbox') { el.remove(); continue; }
      clean(el);
    }
  };
  clean(doc.body);
  return doc.body.innerHTML;
}

// Formatting for the thread box, replies and edited posts: works on whichever
// of them was used last (Ctrl+B / Ctrl+I / Ctrl+U also work while typing).
const FMT = [['bold', '<b>B</b>', 'Bold (Ctrl+B)'], ['italic', '<i>I</i>', 'Italic (Ctrl+I)'], ['underline', '<u>U</u>', 'Underline (Ctrl+U)'],
  ['strikeThrough', '<s>S</s>', 'Strikethrough'], ['insertUnorderedList', '• List', 'Bulleted list'], ['insertOrderedList', '1. List', 'Numbered list'], ['removeFormat', 'T̸', 'Clear formatting']];
const FMT_BAR = `<div class="tfmt">${FMT.map(([c, l, t]) => `<button type="button" class="icon" data-fmt="${c}" title="${t}">${l}</button>`).join('')}</div>`;
let lastEditable = null;

const Work = {
  list: [], current: null, replyTo: '', openReplies: new Set(), showArchived: false,

  async loadList() {
    this.list = (await api('GET', '/api/work').catch(() => [])) || [];
    this.renderList();
    this.renderCapture();
    if ($('#search').value.trim() && $('#view-dashboard').classList.contains('active')) renderBoard(); // threads in the main search
  },
  active() { return S.settings?.active_thread || ''; },

  renderList() {
    const q = ($('#workSearch')?.value || '').trim().toLowerCase();
    const archived = this.list.filter(w => w.archived).length;
    const items = this.list.filter(w => (this.showArchived || !w.archived || w.id === this.current?.id) && (!q || q.split(/\s+/).every(t => w.search.includes(t) || w.title.toLowerCase().includes(t))));
    $('#workList').innerHTML = (items.map(w => `<div class="li tli ${this.current?.id === w.id ? 'active' : ''}" data-work="${w.id}">
      <div class="tli-top"><span class="wstatus ${w.status}">${esc((STATUSES.find(s => s[0] === w.status) || STATUSES[0])[1])}</span>${w.archived ? '<span class="tarch">🗄 Archived</span>' : ''}${w.id === this.active() ? '<span class="tcap" title="Captures are being added here">● capturing</span>' : ''}</div>
      <b>${esc(w.title)}</b><small>${w.jira && !w.title.toUpperCase().includes(w.jira) ? `◆ ${esc(w.jira)} · ` : ''}${fmtTime(w.updated)}${w.posts ? ` · ${w.posts} post${w.posts > 1 ? 's' : ''}` : ''}${w.images ? ` · ${w.images} 🖼` : ''}</small></div>`).join('')
      || `<div class="muted tiny" style="padding:8px">${q ? 'No matches' : 'No task threads yet — press + New thread.'}</div>`)
      + (archived ? `<a href="#" class="tmore tarch-toggle" data-toggle-archived>${this.showArchived ? 'Hide archived' : `Show archived (${archived})`}</a>` : '');
  },

  async archive(w, on) {
    try { await api('POST', `/api/work/${w.id}/archive`, { archived: on }); } catch (err) { return toast(err.message, true); }
    w.archived = on;
    if (on && S.settings.active_thread === w.id) S.settings.active_thread = '';
    await this.loadList(); this.render();
    toast(on ? `Archived “${w.title}” — it is hidden from the list` : `“${w.title}” is back in the list`, false, on ? () => this.archive(w, false) : undefined);
  },

  // Sidebar line under Watch clipboard: where captures go.
  renderCapture() {
    const w = this.list.find(x => x.id === this.active());
    const el = $('#captureThread'); if (!el) return;
    el.hidden = !w;
    if (w) el.innerHTML = `and thread <a href="#" data-gothread="${w.id}">${esc(w.title)}</a> <a href="#" data-stopthread title="Stop adding captures to this thread">✕</a>`;
  },

  async show() {
    await this.loadList();
    if (!this.current) {
      let sel = ''; try { sel = localStorage.getItem('workSel') || ''; } catch { /* ignore */ }
      const id = this.list.some(w => w.id === sel) ? sel : this.list[0]?.id;
      if (id) await this.open(id); else this.render();
    }
  },

  async open(id) {
    try { this.current = await api('GET', '/api/work/' + id); } catch (err) { return toast(err.message, true); }
    try { localStorage.setItem('workSel', id); } catch { /* ignore */ }
    if (!$('#view-tasks').classList.contains('active')) show('tasks');
    this.render(true);
    this.renderList();
  },

  async create(title) {
    title = title || prompt('Thread name (e.g. PAY-123 refund limits, CM-456 UAT release):', '');
    if (!title?.trim()) return null;
    const w = await api('POST', '/api/work', { title: title.trim(), jira: title }); // a key in the name links it
    await this.loadList();
    await this.open(w.id);
    setTimeout(() => $('#tbox')?.focus());
    return w;
  },

  async setCapture(on) {
    const w = this.current; if (!w) return;
    await saveSettings({ active_thread: on ? w.id : '' });
    this.render(); this.renderList(); this.renderCapture();
    toast(on ? `Captures now also go to “${w.title}”` : 'Captures no longer go to a thread');
  },

  // The linked Jira issue: key, status and summary when it's tracked on the Jira page.
  jiraChip(w) {
    if (!w.jira) return '<button data-tact="jiralink" title="Link this thread to a Jira issue (its status shows here; the CM reminder and the Jira page open this thread)">◆ Link Jira…</button>';
    const j = (typeof Jira !== 'undefined' ? Jira.issues : []).find(x => x.key === w.jira);
    return `<span class="tjira" title="${esc(j ? j.summary || '' : 'Linked Jira issue')}"><button class="linklike" data-tact="jiraopen">◆ <b>${esc(w.jira)}</b></button>${j?.status ? `<span class="jstat${j.done ? ' done' : ''}">${esc(j.status)}</span>` : ''}<button class="icon" data-tact="jiralink" title="Change or remove the link">✎</button></span>`;
  },
  async linkJira() {
    const w = this.current;
    const guess = w.jira || (w.title.toUpperCase().match(/\b[A-Z][A-Z0-9_]+-\d+\b/) || [''])[0];
    const v = prompt('Jira issue key or link for this thread (empty to remove the link):', guess);
    if (v === null) return;
    const key = (v.toUpperCase().match(/\b[A-Z][A-Z0-9_]+-\d+\b/) || [''])[0];
    if (v.trim() && !key) return toast('That doesn\'t look like a Jira key (e.g. PAY-123)', true);
    const r = await api('POST', '/api/work', { id: w.id, title: w.title, status: w.status, tags: w.tags || [], jira: key });
    w.jira = r.jira || ''; this.render(); this.loadList();
    if (key && typeof Jira !== 'undefined' && Jira.cfg?.base_url && !Jira.issues.some(x => x.key === key)) {
      api('POST', '/api/jira', { ref: key }).then(() => Jira.load()).then(() => this.render()).catch(() => {}); // track it: status + CM items
    }
    toast(key ? `Linked to ${key}` : 'Jira link removed');
  },
  openJira() {
    const w = this.current, j = Jira.issues.find(x => x.key === w.jira);
    if (j) { show('jira'); Jira.sel = 'i:' + j.key; Jira.open.add(j.done ? 'f:done' : 'f:open'); return Jira.render(); }
    if (Jira.cfg?.base_url) return openExternal(Jira.cfg.base_url.replace(/\/$/, '') + '/browse/' + w.jira);
    toast('Set up Jira (Jira → Jira settings…) to open it', true);
  },
  // The thread for a Jira key (or a CM item's parent): open it, or start one.
  byJira(...keys) { return this.list.find(w => w.jira && keys.includes(w.jira)); },
  async forJira(key, summary) {
    if (!this.list.length) await this.loadList();
    const t = this.byJira(key);
    if (t) return this.open(t.id);
    const w = await api('POST', '/api/work', { title: `${key} ${summary || ''}`.trim(), jira: key, status: 'doing' });
    await this.loadList(); await this.open(w.id); toast(`Started a thread for ${key}`);
    setTimeout(() => $('#tbox')?.focus());
  },

  render(scroll) {
    const w = this.current;
    if (!w) { $('#taskMain').innerHTML = '<div class="empty">Start a thread for a task, ticket or change — then post notes, paste screenshots, and let captures land in it.<br><br><button class="primary" data-tact="new">+ New thread</button></div>'; return; }
    const capturing = w.id === this.active();
    $('#taskMain').innerHTML = `
      <div class="thead">
        <input id="workTitle" class="wtitle" value="${esc(w.title)}" placeholder="Thread name">
        <select id="workStatus">${STATUSES.map(([v, l]) => `<option value="${v}" ${w.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
 ${this.jiraChip(w)}
        <button data-tact="capture" class="${capturing ? 'primary' : ''}" title="While on, everything Watch clipboard captures is also posted here">${capturing ? '● Capturing here' : '📥 Capture here'}</button>
        <span class="spacer"></span>
        <button data-tact="word" title="Open the Word copy (kept in the work-items folder)">Open in Word</button>
        <button data-tact="more" class="icon more" title="More">⋯</button>
      </div>
      ${w.archived ? `<div class="tarch-bar">🗄 This thread is archived (hidden from the list). <button class="icon" data-tact="unarchive">Unarchive</button></div>` : ''}
      ${this.pinsHTML(w)}
      <div id="tposts" class="tposts">${this.postsHTML(w)}</div>
      <div class="tcompose">
        <div class="tcol">${FMT_BAR}
          <div id="tbox" class="tbox" contenteditable="true" spellcheck="true" data-placeholder="Write a note… paste a screenshot (Win+Shift+S, then Ctrl+V) or drop files. Enter posts · Shift+Enter new line"></div>
        </div>
        <button id="tsend" class="primary" title="Post (Enter)">Post</button>
      </div>`;
    if (scroll) this.scrollEnd();
  },
  scrollEnd() { const el = $('#tposts'); if (el) el.scrollTop = el.scrollHeight; },

  // Pinned posts as chips under the header; clicking one jumps to it.
  pinsHTML(w) {
    const pins = (w.posts || []).filter(p => p.pinned);
    if (!pins.length) return '';
    const label = p => {
      if (p.kind === 'entry') { const e = byId(p.ref); return e ? '🖥 ' + e.name : '🖥 (deleted)'; }
      if (p.kind === 'capture') return '📋 ' + (p.text || '').split('\n')[0].slice(0, 50);
      const t = new DOMParser().parseFromString(p.html || '', 'text/html').body.textContent.trim();
      return t ? '📝 ' + t.slice(0, 50) + (t.length > 50 ? '…' : '') : (/<img/.test(p.html || '') ? '🖼 Screenshot' : '📝 Note');
    };
    return `<div class="tpins"><span class="muted tiny">📌 Pinned</span>${pins.map(p => `<button class="tpin" data-gopost="${p.id}" title="Show it">${esc(label(p))}</button>`).join('')}</div>`;
  },

  postsHTML(w) {
    if (!w.posts?.length) return '<div class="muted tiny" style="padding:16px">Nothing here yet. Write the first note below.</div>';
    const replies = {};
    for (const p of w.posts) if (p.parent) (replies[p.parent] ||= []).push(p);
    let day = '';
    const dayName = d => { const t = new Date(); const y = new Date(Date.now() - 864e5);
      return d.toDateString() === t.toDateString() ? 'Today' : d.toDateString() === y.toDateString() ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); };
    const one = (p, isReply) => {
      const at = new Date(p.at), time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return `<div class="tpost k-${p.kind} ${isReply ? 'reply' : ''} ${p.pinned ? 'pinned' : ''}" data-post="${p.id}"><div class="tmeta"><span class="tkind">${{ note: '📝', capture: '📋', entry: '🖥' }[p.kind] || '📝'}</span>
        <span class="ttime" title="${esc(at.toLocaleString())}">${isReply && at.toDateString() !== new Date().toDateString() ? esc(at.toLocaleDateString()) + ' ' : ''}${time}</span>${p.kind === 'capture' ? '<span class="muted tiny">captured</span>' : ''}${p.edited ? '<span class="muted tiny">(edited)</span>' : ''}${p.pinned ? '<span class="tpinned" title="Pinned to the top">📌</span>' : ''}
        <span class="tacts"><button class="icon" data-pact="reply" title="Reply">💬</button>${p.kind === 'note' ? '<button class="icon" data-pact="edit" title="Edit">✎</button>' : ''}<button class="icon more" data-pact="more" title="More: pin, copy, delete">⋯</button></span></div>
        <div class="tbody">${this.postBody(p)}</div></div>`;
    };
    return w.posts.filter(p => !p.parent).map(p => {
      const d = dayName(new Date(p.at));
      const sep = d !== day ? `<div class="tday"><span>${esc((day = d))}</span></div>` : '';
      const rs = replies[p.id] || [], all = this.openReplies.has(p.id) || rs.length <= 3, shown = all ? rs : rs.slice(-2);
      const box = this.replyTo === p.id ? `<div class="treplybox"><div class="tbox rbox" contenteditable="true" data-reply="${p.id}" data-placeholder="Reply… Enter sends · Shift+Enter new line · Esc cancels"></div><button class="primary" data-pact="sendreply" data-parent="${p.id}">Reply</button></div>` : '';
      const more = !all ? `<a href="#" class="tmore" data-allreplies="${p.id}">Show all ${rs.length} replies</a>` : '';
      return sep + one(p) + (rs.length || box ? `<div class="treplies">${more}${shown.map(r => one(r, true)).join('')}${box}${rs.length && !box ? `<a href="#" class="tmore" data-replyto="${p.id}">💬 Reply</a>` : ''}</div>` : '');
    }).join('');
  },

  postBody(p) {
    if (p.kind === 'capture') {
      const clip = S.clips.find(c => c.id === p.ref);
      const chips = (clip?.entry_ids || []).map(byId).filter(Boolean).map(e => `<span class="chip" data-tentry="${e.id}" title="Details">${dot(e)} ${esc(e.name)}</span>`).join('');
      return `<pre>${maskedText(p.text || '')}</pre>${chips ? `<div class="chips">${chips}</div>` : ''}`;
    }
    if (p.kind === 'entry') {
      const e = byId(p.ref);
      if (!e) return '<span class="muted">(this connection was deleted)</span>';
      return `<div class="tentry">${dot(e)} <b>${ruleName(e)}</b> <span class="muted">${esc([e.username, e.host || e.url].filter(Boolean).join(' @ '))}${e.port ? ':' + e.port : ''}</span>${e.env ? ` <span class="badge ${esc(e.env)}">${esc(e.env)}</span>` : ''}
        <span class="spacer"></span>${canSSH(e) ? `<button class="icon" data-tconn="ssh" data-id="${e.id}">SSH</button>` : ''}${canDB(e) ? `<button class="icon" data-tconn="sql" data-id="${e.id}">SQL</button>` : ''}${e.url ? `<button class="icon" data-tconn="open" data-id="${e.id}">Open</button>` : ''}<button class="icon" data-tentry="${e.id}">Details</button></div>${p.html ? sanitizeHTML(p.html) : ''}`;
    }
    return sanitizeHTML(p.html || '');
  },

  async post(kind, fields, threadId) {
    const id = threadId || this.current?.id; if (!id) return;
    const p = await api('POST', `/api/work/${id}/posts`, { kind, ...fields });
    if (this.current?.id === id) {
      this.current.posts = [...(this.current.posts || []), p].sort((a, b) => new Date(a.at) - new Date(b.at));
      this.render();
      if (p.parent) this.flash(p.id); else this.scrollEnd();
    }
    this.loadList();
    return p;
  },

  flash(pid) {
    const el = $(`#tposts [data-post="${pid}"]`); if (!el) return;
    el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1600);
  },
  openReply(pid) {
    this.replyTo = pid; this.render();
    const b = $(`#tposts [data-reply="${pid}"]`); if (b) { b.scrollIntoView({ block: 'nearest' }); b.focus(); }
  },
  async sendReply(pid) {
    const box = $(`#tposts [data-reply="${pid}"]`); if (!box) return;
    if (!box.textContent.trim() && !box.querySelector('img')) return;
    const html = sanitizeHTML(box.innerHTML);
    this.replyTo = '';
    try { await this.post('note', { html, parent: pid }); } catch (err) { toast(err.message, true); }
  },
  async pin(p, on) {
    await api('PUT', `/api/work/${this.current.id}/posts/${p.id}`, { pinned: on }).catch(err => toast(err.message, true));
    p.pinned = on; this.render(); toast(on ? 'Pinned to the top of the thread' : 'Unpinned');
  },

  async send() {
    const box = $('#tbox'); if (!box) return;
    const html = sanitizeHTML(box.innerHTML).replace(/^(<p><br><\/p>|<br>)+|(<p><br><\/p>|<br>)+$/g, '');
    if (!box.textContent.trim() && !box.querySelector('img')) return;
    box.innerHTML = '';
    try { await this.post('note', { html }); } catch (err) { toast(err.message, true); box.innerHTML = html; }
    $('#tbox')?.focus();
  },

  // Pick a thread (recent first) for "Add to task thread…".
  pick(ev, then) {
    const r = ev.target?.getBoundingClientRect?.() || { left: ev.clientX, bottom: ev.clientY };
    const open = [...this.list].filter(w => w.status !== 'done').slice(0, 12);
    setTimeout(() => Tree.showMenu({ clientX: r.left, clientY: r.bottom }, [
      ...open.map(w => [`${w.id === this.active() ? '● ' : ''}${w.title}`, () => then(w.id, w.title)]),
      ...(open.length ? ['-'] : []), ['+ New thread…', async () => { const w = await this.create(); if (w) then(w.id, w.title); }]]));
  },
  async addEntry(e, ev) {
    if (!this.list.length) await this.loadList();
    this.pick(ev, async (id, title) => { await this.post('entry', { ref: e.id }, id); toast(`Added ${e.name} to “${title}”`); });
  },
  async addClip(c, ev) {
    if (!this.list.length) await this.loadList();
    this.pick(ev, async (id, title) => { await this.post('capture', { text: c.text, ref: c.id }, id); toast(`Added the capture to “${title}”`); });
  },

  // Store files and return HTML for them (images inline, others as links).
  async storeFiles(files) {
    const w = this.current, fd = new FormData();
    for (const f of files) fd.append('file', f, f.name);
    const r = await fetch(`/api/work/${w.id}/files`, { method: 'POST', body: fd });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { toast(d.error || 'Upload failed', true); return ''; }
    return d.map(a => a.image
      ? `<p><img src="/api/props/files/${a.id}" alt="${esc(a.name)}"></p>`
      : `<p>📎 <a href="${location.origin}/api/props/files/${a.id}?download=1" title="Download">${esc(a.name)}</a> <span class="muted">(${fmtSize(a.size)})</span></p>`).join('');
  },

  saveHeader() {
    const w = this.current;
    w.title = $('#workTitle').value; w.status = $('#workStatus').value;
    clearTimeout(this.headTimer);
    this.headTimer = setTimeout(async () => { await api('POST', '/api/work', { id: w.id, title: w.title, status: w.status, tags: w.tags || [], jira: w.jira || '' }); this.loadList(); }, 600);
  },
};

// Insert HTML at the caret in the box being written (composer or an edited post).
function insertAtCaret(html, box = $('#tbox')) {
  if (!box) return;
  box.focus();
  const sel = window.getSelection();
  if (!sel.rangeCount || !box.contains(sel.anchorNode)) { const r = document.createRange(); r.selectNodeContents(box); r.collapse(false); sel.removeAllRanges(); sel.addRange(r); }
  document.execCommand('insertHTML', false, html);
}
const linkHTML = u => { const label = linkLabel(u); return `${label ? `<b>${esc(label)}:</b> ` : ''}<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a>&nbsp;`; };

// Loaded at start too, so the main search finds threads; kept fresh.
setTimeout(() => Work.loadList().then(() => { if ($('#search').value.trim()) renderBoard(); }), 600);
setInterval(() => Work.loadList(), 5 * 60 * 1000);

// Word documents → threads (one each); the first one opens.
Work.importWord = async files => {
  files = [...files].filter(f => /\.docx?$/i.test(f.name));
  if (!files.length) return toast('Pick Word documents (.docx)', true);
  const fd = new FormData(); files.forEach(f => fd.append('file', f, f.name));
  toast(`Importing ${files.length} document(s)…`);
  const r = await fetch('/api/work/import', { method: 'POST', body: fd }).then(x => x.json()).catch(err => ({ problems: [err.message] }));
  const made = r.threads || [];
  await Work.loadList();
  if (made.length) await Work.open(made[0].id);
  if (r.problems?.length) toast(`${made.length ? `Imported ${made.length}. ` : ''}${r.problems.join(' · ')}`, true);
  else toast(`Imported ${made.length} document(s) as task threads`);
};

// ---- events ----
$('#workNew').onclick = () => Work.create();
$('#workImport').onclick = () => $('#workImportFile').click();
$('#workImportFile').onchange = e => { Work.importWord(e.target.files); e.target.value = ''; };
const side = $('.tasks-side');
side.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); side.classList.add('dragover'); } });
side.addEventListener('dragleave', e => { if (e.target === side) side.classList.remove('dragover'); });
side.addEventListener('drop', e => { if (!e.dataTransfer.files.length) return; e.preventDefault(); side.classList.remove('dragover'); Work.importWord(e.dataTransfer.files); });
$('#workSearch').addEventListener('input', () => Work.renderList());
$('#workList').addEventListener('click', e => {
  if (e.target.closest('[data-toggle-archived]')) { e.preventDefault(); Work.showArchived = !Work.showArchived; return Work.renderList(); }
  const li = e.target.closest('[data-work]'); if (li) Work.open(li.dataset.work);
});
$('#captureThread')?.addEventListener('click', e => {
  const go = e.target.closest('[data-gothread]'); if (go) { e.preventDefault(); return Work.open(go.dataset.gothread); }
  if (e.target.closest('[data-stopthread]')) { e.preventDefault(); saveSettings({ active_thread: '' }).then(() => { Work.renderCapture(); Work.renderList(); if (Work.current) Work.render(); }); }
});

const page = $('#taskMain');
page.addEventListener('focusin', e => { if (e.target.isContentEditable) lastEditable = e.target.closest('[contenteditable="true"]'); });
page.addEventListener('mousedown', e => { if (e.target.closest('[data-fmt]')) e.preventDefault(); }); // keep the text selected
page.addEventListener('click', e => {
  const b = e.target.closest('[data-fmt]'); if (!b) return;
  const box = lastEditable?.isConnected ? lastEditable : $('#tbox');
  if (document.activeElement !== box) box.focus();
  document.execCommand(b.dataset.fmt);
  fmtState();
}, true);
// B / I / U / S light up when the cursor is in such text
function fmtState() {
  const bar = $('#taskMain .tfmt'); if (!bar) return;
  const inBox = document.activeElement?.isContentEditable && page.contains(document.activeElement);
  for (const b of $$('[data-fmt]', bar)) b.classList.toggle('on', !!inBox && ['bold', 'italic', 'underline', 'strikeThrough'].includes(b.dataset.fmt) && document.queryCommandState(b.dataset.fmt));
}
document.addEventListener('selectionchange', fmtState);
page.addEventListener('input', e => { if (e.target.id === 'workTitle') Work.saveHeader(); });
page.addEventListener('change', e => { if (e.target.id === 'workStatus') Work.saveHeader(); });
page.addEventListener('keydown', e => {
  if (e.target.id === 'tbox' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); Work.send(); }
  const rb = e.target.closest?.('.rbox');
  if (rb && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); Work.sendReply(rb.dataset.reply); }
  if (rb && e.key === 'Escape') { Work.replyTo = ''; Work.render(); }
  if (e.target.closest?.('.tbody[contenteditable]') && e.key === 'Escape') Work.render();
});
page.addEventListener('click', async e => {
  const w = Work.current;
  const act = e.target.closest('[data-tact]')?.dataset.tact;
  if (act === 'new') return Work.create();
  if (!w) return;
  if (e.target.closest('#tsend')) return Work.send();
  if (act === 'capture') return Work.setCapture(w.id !== Work.active());
  if (act === 'unarchive') return Work.archive(w, false);
  if (act === 'jiralink') return Work.linkJira();
  if (act === 'jiraopen') return Work.openJira();
  if (act === 'word' || act === 'folder') {
    try { const r = await api('POST', `/api/work/${w.id}/word${act === 'folder' ? '?what=folder' : ''}`); toast(r.warning ? r.warning : act === 'word' ? 'Opening in Word: ' + r.path.split(/[\\/]/).pop() : 'Opened the work-items folder'); }
    catch (err) { toast(err.message, true); }
    return;
  }
  if (act === 'more') {
    const r = e.target.closest('[data-tact]').getBoundingClientRect();
    return setTimeout(() => Tree.showMenu({ clientX: r.left - 160, clientY: r.bottom }, [
      ['⬇ Export as Markdown (.md, screenshots beside it)', async () => {
        try { const r = await api('POST', `/api/work/${w.id}/markdown`); toast(`Saved ${r.path.split(/[\\/]/).pop()}${r.files ? ` and ${r.files} file(s)` : ''} in the work-items folder`); }
        catch (err) { toast(err.message, true); }
      }],
      ['📋 Copy as Markdown', async () => {
        try { const r = await api('POST', `/api/work/${w.id}/markdown?what=copy`); await copyText(r.markdown, 'Thread copied as Markdown — paste it into Jira, Confluence or Teams'); }
        catch (err) { toast(err.message, true); }
      }],
      '-',
      [w.archived ? '↩ Unarchive thread' : '🗄 Archive thread (hide from the list)', () => Work.archive(w, !w.archived)],
      '-',
      ['Open the work-items folder', () => api('POST', `/api/work/${w.id}/word?what=folder`).catch(err => toast(err.message, true))],
      ['Delete this thread…', async () => {
        if (!confirm(`Delete the thread "${w.title}" and everything in it?`)) return;
        if (w.id === Work.active()) await saveSettings({ active_thread: '' });
        await api('DELETE', '/api/work/' + w.id); Work.current = null; await Work.loadList(); Work.show();
      }]]));
  }
  const go = e.target.closest('[data-gopost]'); if (go) return Work.flash(go.dataset.gopost);
  const allr = e.target.closest('[data-allreplies]'); if (allr) { e.preventDefault(); Work.openReplies.add(allr.dataset.allreplies); return Work.render(); }
  const rto = e.target.closest('[data-replyto]'); if (rto) { e.preventDefault(); return Work.openReply(rto.dataset.replyto); }
  const sr = e.target.closest('[data-pact=sendreply]'); if (sr) return Work.sendReply(sr.dataset.parent);
  const conn = e.target.closest('[data-tconn]');
  if (conn) { const x = byId(conn.dataset.id); return x && ({ ssh: () => Term.open(x), sql: () => SQL.open(x), open: () => openURL(x) })[conn.dataset.tconn](); }
  const ent = e.target.closest('[data-tentry]'); if (ent) return showDetails(byId(ent.dataset.tentry));
  const postEl = e.target.closest('[data-post]'), pact = e.target.closest('[data-pact]')?.dataset.pact;
  if (postEl && pact) {
    const p = w.posts.find(x => x.id === postEl.dataset.post); if (!p) return;
    if (pact === 'reply') return Work.openReply(p.parent || p.id);
    if (pact === 'edit') {
      const body = postEl.querySelector('.tbody');
      body.contentEditable = 'true'; body.classList.add('editing'); body.focus();
      body.insertAdjacentHTML('afterend', '<div class="row tedit"><button class="primary" data-pact="save">Save</button><button data-pact="cancel">Cancel</button><span class="muted tiny">Esc cancels</span></div>');
      return;
    }
    if (pact === 'cancel') return Work.render();
    if (pact === 'save') {
      const html = sanitizeHTML(postEl.querySelector('.tbody').innerHTML);
      await api('PUT', `/api/work/${w.id}/posts/${p.id}`, { html }).catch(err => toast(err.message, true));
      p.html = html; p.edited = new Date().toISOString(); return Work.render();
    }
    if (pact === 'more') {
      const r = e.target.closest('[data-pact]').getBoundingClientRect();
      const kids = w.posts.filter(x => x.parent === p.id);
      return setTimeout(() => Tree.showMenu({ clientX: r.left - 160, clientY: r.bottom }, [
        [p.pinned ? '📌 Unpin' : '📌 Pin to the top', () => Work.pin(p, !p.pinned)],
        ['💬 Reply', () => Work.openReply(p.parent || p.id)],
        ['Copy text', () => copyText(p.text || postEl.querySelector('.tbody').innerText)],
        [kids.length ? `Delete post and its ${kids.length} repl${kids.length > 1 ? 'ies' : 'y'}` : 'Delete post', async () => {
          await api('DELETE', `/api/work/${w.id}/posts/${p.id}`);
          w.posts = w.posts.filter(x => x !== p && x.parent !== p.id); Work.render(); Work.loadList();
          toast(kids.length ? `Post and ${kids.length} repl${kids.length > 1 ? 'ies' : 'y'} deleted` : 'Post deleted', false, async () => {
            const back = await Work.post(p.kind, { html: p.html, text: p.text, ref: p.ref, at: p.at, parent: p.parent, pinned: p.pinned }, w.id);
            for (const k of kids) await Work.post(k.kind, { html: k.html, text: k.text, ref: k.ref, at: k.at, parent: back.id, pinned: k.pinned }, w.id);
            toast('Restored');
          });
        }]]));
    }
  }
  // Links in posts open in the browser.
  const a = e.target.closest('.tbody a[href]');
  if (a && !e.target.closest('[contenteditable=true]')) { e.preventDefault(); openExternal(a.href); }
});
page.addEventListener('dblclick', e => { const img = e.target.closest('.tposts img, .tbox img'); if (img) { $('#lightboxImg').src = img.src; $('#lightbox').hidden = false; } });

// Paste into the composer (or a post being edited): screenshots → stored and
// shown inline; formatted text kept (cleaned); links made clickable.
page.addEventListener('paste', async e => {
  const box = e.target.closest('#tbox, .rbox, .tbody[contenteditable=true]'); if (!box) return;
  const cd = e.clipboardData;
  const imgs = [...(cd?.items || [])].filter(i => i.type.startsWith('image/')).map(i => i.getAsFile()).filter(Boolean);
  const html = cd?.getData('text/html') || '';
  const text = cd?.getData('text/plain') || '';
  e.preventDefault();
  if (imgs.length && !html.trim()) {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    toast('Adding screenshot…');
    return insertAtCaret(await Work.storeFiles(imgs.map((f, i) => new File([f], `screenshot-${stamp}${i ? '-' + i : ''}.png`, { type: f.type }))), box);
  }
  if (html.trim()) {
    let clean = sanitizeHTML(html.replace(/<!--[\s\S]*?-->/g, ''));
    for (const [, uri, ext] of [...clean.matchAll(/src="(data:image\/(\w+);base64,[^"]+)"/g)]) {
      const bin = Uint8Array.from(atob(uri.split(',')[1]), ch => ch.charCodeAt(0));
      const stored = await Work.storeFiles([new File([bin], `pasted.${ext}`, { type: 'image/' + ext })]);
      const id = (stored.match(/files\/([0-9a-f]+)/) || [])[1];
      clean = clean.replace(uri, id ? '/api/props/files/' + id : '');
    }
    return insertAtCaret(clean, box);
  }
  if (/^\s*https?:\/\/\S+\s*$/.test(text)) return insertAtCaret(linkHTML(text.trim()), box);
  insertAtCaret(esc(text).replace(/https?:\/\/[^\s<>"']+/g, u => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`).replace(/\r?\n/g, '<br>'), box);
});
page.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files') && Work.current) { e.preventDefault(); page.classList.add('dragover'); } });
page.addEventListener('dragleave', e => { if (e.target === page) page.classList.remove('dragover'); });
page.addEventListener('drop', async e => {
  if (!e.dataTransfer.files.length || !Work.current) return;
  e.preventDefault(); page.classList.remove('dragover');
  toast(`Adding ${e.dataTransfer.files.length} file(s)…`);
  insertAtCaret(await Work.storeFiles([...e.dataTransfer.files]));
});
