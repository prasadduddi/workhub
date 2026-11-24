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

// ---- Slack-style pieces ----
const SENDERS = { note: ['You', '🧑'], capture: ['Clipboard', '📋'], entry: ['Server', '🖥'] };
const QUICK_REACTS = ['✅', '👀', '👍'];
const EMOJI = { tada: '🎉', '+1': '👍', thumbsup: '👍', '-1': '👎', check: '✅', white_check_mark: '✅', x: '❌', eyes: '👀', fire: '🔥', warning: '⚠️', rocket: '🚀',
  bug: '🐛', heart: '❤️', smile: '😄', joy: '😂', thinking: '🤔', pray: '🙏', clap: '👏', ok: '🆗', wave: '👋', star: '⭐', bulb: '💡', lock: '🔒', key: '🔑',
  hourglass: '⏳', stop: '🛑', question: '❓', exclamation: '❗', calendar: '📅', memo: '📝', pin: '📌', link: '🔗', point_up: '☝️', 100: '💯', boom: '💥', sos: '🆘' };
const PICKER = ['✅', '👀', '👍', '👎', '🎉', '🔥', '❤️', '😄', '😂', '🤔', '🙏', '👏', '🚀', '🐛', '⚠️', '❌', '❗', '❓', '💡', '⏳', '📌', '💯', '🆗', '👋'];
function dayName(d) {
  const t = new Date(), y = new Date(Date.now() - 864e5);
  return d.toDateString() === t.toDateString() ? 'Today' : d.toDateString() === y.toDateString() ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
// Code blocks get a Copy button.
function withCopy(html) {
  return html.replace(/<pre>/g, '<div class="tcode"><button class="icon tcopy" data-pact="copycode" title="Copy">Copy</button><pre>').replace(/<\/pre>/g, '</pre></div>');
}
// ```fenced``` text becomes a code block when posting.
function slackBlocks(html) {
  return html.replace(/\u200B/g, '').replace(/```(?:<br>)?([\s\S]*?)```/g, (m, c) => '<pre><code>' + c.replace(/<br\s*\/?>/g, '\n').replace(/<\/?(p|div)>/g, '\n').replace(/^\n+|\n+$/g, '') + '</code></pre>');
}
// A half-written message is kept per thread.
const Drafts = {
  get(id) { try { return localStorage.getItem('draft.' + id) || ''; } catch { return ''; } },
  set(id, html) { try { html ? localStorage.setItem('draft.' + id, html) : localStorage.removeItem('draft.' + id); } catch { /* private mode */ } },
};
// Slack typing: *bold* _italic_ ~strike~ `code` and :emoji: turn into the real
// thing as the closing mark is typed.
const SLACK_MARKS = { '*': 'b', _: 'i', '~': 's', '`': 'code' };
function slackType(box, ch) {
  const sel = getSelection(); if (!sel.rangeCount || !sel.isCollapsed) return;
  const node = sel.anchorNode; if (node?.nodeType !== 3 || !box.contains(node)) return;
  const before = node.data.slice(0, sel.anchorOffset);
  let m, el;
  if (ch === ':' && (m = before.match(/(^|\s):([a-z0-9_+-]{1,20}):$/)) && EMOJI[m[2]]) {
    el = document.createTextNode(EMOJI[m[2]] + ' ');
  } else if (SLACK_MARKS[ch] && (m = before.match(new RegExp('(^|[\\s(])' + (ch === '*' ? '\\*' : ch) + '([^\\s' + ch + '](?:[^' + ch + ']*[^\\s' + ch + '])?)' + (ch === '*' ? '\\*' : ch) + '$')))) {
    el = document.createElement(SLACK_MARKS[ch]); el.textContent = m[2];
  } else return;
  const start = sel.anchorOffset - (m[0].length - m[1].length);
  const r = document.createRange(); r.setStart(node, start); r.setEnd(node, sel.anchorOffset); r.deleteContents(); r.insertNode(el);
  const after = document.createTextNode('\u200B'); el.after(after);
  const c = document.createRange(); c.setStartAfter(after); c.collapse(true); sel.removeAllRanges(); sel.addRange(c);
}

const Work = {
  list: [], current: null, panel: '', showArchived: false, readMark: '',

  async loadList() {
    this.list = (await api('GET', '/api/work').catch(() => [])) || [];
    this.renderList();
    this.renderCapture();
    if ($('#search').value.trim() && $('#view-dashboard').classList.contains('active')) renderBoard(); // threads in the main search
    else if ($('#view-dashboard').classList.contains('active') && typeof Today !== 'undefined') Today.render(); // 📅 Today's open threads
  },
  // The thread captures go to: the one with "Capture here", else General ("off" = none).
  active() {
    const a = S.settings?.active_thread || '';
    if (a === 'off') return '';
    return this.list.some(w => w.id === a) ? a : (this.list.find(w => w.general && !w.archived)?.id || '');
  },

  renderList() {
    const q = ($('#workSearch')?.value || '').trim().toLowerCase();
    const archived = this.list.filter(w => w.archived).length;
    const items = [...this.list].sort((a, b) => (b.general && !b.archived) - (a.general && !a.archived) || new Date(b.updated) - new Date(a.updated)).filter(w => (this.showArchived || !w.archived || w.id === this.current?.id) && (!q || q.split(/\s+/).every(t => w.search.includes(t) || w.title.toLowerCase().includes(t))));
    const item = w => `<div class="li tli ${this.current?.id === w.id ? 'active' : ''} ${w.unread ? 'unread' : ''}" data-work="${w.id}">
      <div class="tli-top"><span class="wstatus ${w.status}">${esc((STATUSES.find(s => s[0] === w.status) || STATUSES[0])[1])}</span>${w.archived ? '<span class="tarch">🗄 Archived</span>' : ''}${w.general ? '<span class="tgen" title="Copied text goes here when no other thread has 📥 Capture here on">default</span>' : ''}${w.id === this.active() ? '<span class="tcap" title="Captures are being added here"><span class="recdot"></span>capturing</span>' : ''}<span class="spacer"></span>${w.unread ? `<span class="tunread" title="New since you last looked">${w.unread}</span>` : ''}<button class="tli-star ${w.starred ? 'on' : ''}" data-star="${w.id}" title="${w.starred ? 'Unstar' : 'Star'}">${w.starred ? '★' : '☆'}</button></div>
      <b>${esc(w.title)}</b><small>${w.jira && !w.title.toUpperCase().includes(w.jira) ? `◆ ${esc(w.jira)} · ` : ''}${fmtTime(w.updated)}${w.posts ? ` · ${w.posts} message${w.posts > 1 ? 's' : ''}` : ''}${w.images ? ` · ${w.images} 🖼` : ''}</small></div>`;
    // Slack-like sections: ⭐ Starred, Threads, Done
    const sec = (title, list, key) => list.length ? `<div class="tsec" data-sec="${key}"><span>${title}</span><span class="muted tiny">${list.length}</span></div>${this.collapsed?.has(key) ? '' : list.map(item).join('')}` : '';
    const starred = items.filter(w => w.starred), rest = items.filter(w => !w.starred);
    $('#workList').innerHTML = (sec('⭐ Starred', starred, 'star') + sec('Threads', rest.filter(w => w.status !== 'done'), 'open') + sec('✓ Done', rest.filter(w => w.status === 'done'), 'done')
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
    if (w) el.innerHTML = `and thread <a href="#" data-gothread="${w.id}">${esc(w.title)}</a> <a href="#" data-stopthread title="Stop adding captures to threads (📥 Capture here in any thread starts again)">✕</a>`;
  },

  async show() {
    await this.loadList();
    if (!this.current) {
      let sel = ''; try { sel = localStorage.getItem('workSel') || ''; } catch { /* ignore */ }
      const id = this.list.some(w => w.id === sel) ? sel : this.list[0]?.id;
      if (id) await this.open(id, undefined, true); else this.render(); // stay: the page may have been left meanwhile
    }
  },

  async open(id, pid, stay) {
    try { this.current = await api('GET', '/api/work/' + id); } catch (err) { return toast(err.message, true); }
    try { localStorage.setItem('workSel', id); } catch { /* ignore */ }
    if (!stay && !$('#view-tasks').classList.contains('active')) show('tasks');
    const li = this.list.find(x => x.id === id);
    this.readMark = li?.unread ? this.current.read_at : ''; // the "New" line goes above what came since
    if (this.panel && !this.current.posts?.some(p => p.id === this.panel)) this.panel = '';
    this.render(!pid);
    if (pid) { const p = this.current.posts.find(x => x.id === pid); if (p?.parent) this.openPanel(p.parent); setTimeout(() => this.flash(pid), 50); }
    else if (this.readMark) setTimeout(() => $('#tposts .tnew')?.scrollIntoView({ block: 'center' }), 30);
    this.markRead(id);
  },
  markRead(id) {
    const li = this.list.find(x => x.id === id);
    if (li?.unread) { li.unread = 0; api('POST', `/api/work/${id}/read`).catch(() => {}); }
    this.renderList();
  },
  // A link to a message (#tasks/<thread>/<message>): open it there.
  openLink(id, pid) { return this.open(id, pid); },
  async star(w, on) {
    await api('POST', `/api/work/${w.id}/star`, { starred: on }).catch(err => toast(err.message, true));
    w.starred = on; const li = this.list.find(x => x.id === w.id); if (li) li.starred = on;
    this.renderList(); if (this.current?.id === w.id) { this.current.starred = on; this.render(); }
  },
  // While the thread is open, new captures and posts show up.
  async refresh() {
    const w = this.current; if (!w || !$('#view-tasks').classList.contains('active') || document.hidden) return;
    if ($('#taskMain .tbody[contenteditable=true]')) return; // editing
    const fresh = await api('GET', '/api/work/' + w.id).catch(() => null);
    if (!fresh || this.current?.id !== w.id) return;
    const sig = x => (x.posts || []).map(p => p.id + (p.edited || '') + (p.reactions || []).join('')).join();
    if (sig(fresh) === sig(w)) return;
    const atEnd = (el => !el || el.scrollHeight - el.scrollTop - el.clientHeight < 40)($('#tposts'));
    this.current = fresh; this.render(atEnd); api('POST', `/api/work/${w.id}/read`).catch(() => {});
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

  // Capture here on → this thread; off → back to General (off on General → no thread).
  async setCapture(on) {
    const w = this.current; if (!w) return;
    await saveSettings({ active_thread: on ? (w.general ? '' : w.id) : (w.general ? 'off' : '') });
    this.render(); this.renderList(); this.renderCapture();
    const g = this.list.find(x => x.general);
    toast(on ? `Captures now also go to “${w.title}”` : w.general || !g ? 'Captures no longer go to a thread' : `Captures go to “${g.title}” again`);
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
    const keep = $('#tposts')?.scrollTop, draft = $('#tbox') ? $('#tbox').innerHTML : null;
    $('#taskMain').innerHTML = `
      <div class="thead">
        <button class="icon tstar ${w.starred ? 'on' : ''}" data-tact="star" title="${w.starred ? 'Unstar' : 'Star'} — starred threads are listed first">${w.starred ? '★' : '☆'}</button>
        <input id="workTitle" class="wtitle" value="${esc(w.title)}" placeholder="Thread name">
        <select id="workStatus">${STATUSES.map(([v, l]) => `<option value="${v}" ${w.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
 ${this.jiraChip(w)}
        <button data-tact="capture" class="${capturing ? 'rec' : ''}" title="${capturing ? 'Recording: everything Watch clipboard captures is posted here — click to stop' : 'While on, everything Watch clipboard captures is also posted here'}">${capturing ? '<span class="recdot"></span>Capturing here' : '📥 Capture here'}</button>
        <span class="spacer"></span>
        ${typeof Popout !== 'undefined' && !Popout.me ? '<button data-tact="popout" title="Open this thread in its own window (⇲ Dock back puts it back)">⧉ New window</button>' : ''}
        <button data-tact="word" title="Open the Word copy (kept in the work-items folder)">Open in Word</button>
        <button data-tact="more" class="icon more" title="More">⋯</button>
      </div>
      ${w.archived ? `<div class="tarch-bar">🗄 This thread is archived (hidden from the list). <button class="icon" data-tact="unarchive">Unarchive</button></div>` : ''}
      ${this.pinsHTML(w)}
      <div class="twrap">
        <div class="tmainc">
          <div id="tposts" class="tposts">${this.postsHTML(w)}</div>
          <div class="tcompose">
            <div class="tcol">${FMT_BAR}
              <div id="tbox" class="tbox" contenteditable="true" spellcheck="true" data-placeholder="Message ${esc(w.title)} — *bold* _italic_ \`code\` :emoji: · paste screenshots, drop files, Outlook emails or Word documents · Enter posts · ↑ edits your last post"></div>
            </div>
            <button id="tsend" class="primary" title="Post (Enter)">Post</button>
          </div>
        </div>
        ${this.panel ? this.panelHTML(w) : ''}
      </div>`;
    const box = $('#tbox');
    box.innerHTML = draft !== null && this.lastRendered === w.id ? draft : Drafts.get(w.id);
    this.lastRendered = w.id;
    if (scroll) this.scrollEnd(); else if (keep != null) $('#tposts').scrollTop = keep;
    const pb = $('.tpanel .tpbody'); if (pb && this.panelScroll) { pb.scrollTop = pb.scrollHeight; this.panelScroll = false; }
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

  // Slack-style: messages from the same sender within a few minutes run
  // together; replies live in a side panel ("💬 3 replies").
  postsHTML(w) {
    if (!w.posts?.length) return '<div class="muted tiny" style="padding:16px">Nothing here yet. Write the first message below.</div>';
    const replies = {};
    for (const p of w.posts) if (p.parent) (replies[p.parent] ||= []).push(p);
    let day = '', prev = null, newShown = false;
    return w.posts.filter(p => !p.parent).map(p => {
      const d = dayName(new Date(p.at));
      let out = '';
      if (d !== day) { out += `<div class="tday"><span>${esc((day = d))}</span></div>`; prev = null; }
      if (!newShown && this.readMark && new Date(p.at) > new Date(this.readMark)) { newShown = true; out += '<div class="tnew"><span>New</span></div>'; prev = null; }
      out += this.msgHTML(p, prev, replies[p.id] || []);
      prev = (replies[p.id] || []).length ? null : p;
      return out;
    }).join('');
  },

  // One message. prev: the message just above (to run on from the same sender).
  msgHTML(p, prev, rs = [], inPanel = false) {
    const at = new Date(p.at), time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const [name, icon] = p.kind === 'note' && (p.from === 'Outlook' || p.from === 'Email') ? ['Email', '✉'] : p.kind === 'note' && p.from === 'Word' ? ['Document', '📄'] : SENDERS[p.kind] || SENDERS.note;
    const cont = prev && prev.kind === p.kind && !p.pinned && !p.via && at - new Date(prev.at) < 5 * 60e3 && (p.kind !== 'capture' || prev.from === p.from);
    const remind = p.remind_at ? `<span class="tflag" title="Reminder ${esc(new Date(p.remind_at).toLocaleString())}">⏰</span>` : '';
    const head = cont ? '' : `<div class="thdr"><b class="tname">${name}</b><span class="ttime" title="${esc(at.toLocaleString())}">${time}</span>${p.from ? `<span class="tfrom" title="Copied from">from ${esc(p.from)}</span>` : ''}${p.via ? `<span class="tfrom" title="${esc(p.via)}">↪ ${esc(p.via.split(' · ')[0])}</span>` : ''}${p.edited ? '<span class="muted tiny">(edited)</span>' : ''}${p.pinned ? '<span class="tflag" title="Pinned">📌</span>' : ''}${p.saved ? '<span class="tflag" title="Saved for later">🔖</span>' : ''}${remind}</div>`;
    // a long Word document shows its start until opened out
    const fold = p.kind === 'note' && p.from === 'Word' && (p.html || '').length > 6000 ? (this.expanded?.has(p.id) ? 'open' : 'fold') : '';
    const reacts = p.reactions?.length ? `<div class="treact">${p.reactions.map(e => `<button class="rchip" data-pact="react" data-emoji="${esc(e)}" title="Remove ${esc(e)}">${esc(e)}</button>`).join('')}<button class="rchip add" data-pact="emoji" title="Add a reaction">😀＋</button></div>` : '';
    const last = rs.length ? new Date(rs[rs.length - 1].at) : null;
    const thread = !inPanel && rs.length ? `<a href="#" class="tthread" data-pact="thread">💬 ${rs.length} repl${rs.length > 1 ? 'ies' : 'y'} <span class="muted">Last reply ${esc(last.toDateString() === new Date().toDateString() ? last.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : last.toLocaleDateString())}</span></a>` : '';
    const tools = `<div class="thover">${QUICK_REACTS.map(e => `<button class="icon" data-pact="react" data-emoji="${e}" title="React ${e}">${e}</button>`).join('')}<button class="icon" data-pact="emoji" title="More reactions">😀</button>${inPanel && p.parent ? '' : `<button class="icon" data-pact="thread" title="Reply in thread">💬</button>`}<button class="icon" data-pact="save" title="${p.saved ? 'Remove from Saved' : 'Save for later'}">${p.saved ? '🔖✓' : '🔖'}</button>${p.kind === 'note' ? '<button class="icon" data-pact="edit" title="Edit">✎</button>' : ''}<button class="icon more" data-pact="more" title="More: pin, remind me, copy link, delete">⋯</button></div>`;
    return `<div class="tmsg k-${p.kind} ${cont ? 'cont' : ''} ${p.pinned ? 'pinned' : ''} ${p.parent ? 'reply' : ''}" data-post="${p.id}">
      <div class="tav">${cont ? `<span class="tmini" title="${esc(at.toLocaleString())}">${time}</span>` : `<span class="avatar k-${p.kind}">${icon}</span>`}</div>
      <div class="tcontent">${head}<div class="tbody${fold === 'fold' ? ' long' : ''}">${this.postBody(p)}</div>${fold ? `<button class="tmore" data-pact="${fold === 'fold' ? 'expand' : 'fold'}">${fold === 'fold' ? 'Show the whole document ▾' : 'Show less ▴'}</button>` : ''}${this.previews(p)}${reacts}${thread}</div>${tools}</div>`;
  },

  // The reply panel on the right: the message and its replies, and a box.
  panelHTML(w) {
    const p = w.posts.find(x => x.id === this.panel);
    if (!p) { this.panel = ''; return ''; }
    const rs = w.posts.filter(x => x.parent === p.id);
    let prev = null;
    return `<aside class="tpanel"><div class="tphead"><b>Thread</b><span class="muted tiny">${esc(w.title)}</span><span class="spacer"></span><button class="icon" data-pact="closepanel" title="Close (Esc)">✕</button></div>
      <div class="tpbody">${this.msgHTML(p, null, rs, true)}<div class="tday"><span>${rs.length} repl${rs.length === 1 ? 'y' : 'ies'}</span></div>
      ${rs.map(r => { const h = this.msgHTML(r, prev, [], true); prev = r; return h; }).join('')}</div>
      <div class="tpcompose"><div class="tbox rbox" contenteditable="true" data-reply="${p.id}" data-placeholder="Reply… Enter sends · Esc closes"></div><button class="primary" data-pact="sendreply" data-parent="${p.id}">Reply</button></div></aside>`;
  },

  postBody(p) {
    if (p.kind === 'capture' && !p.html) {
      const clip = S.clips.find(c => c.id === p.ref);
      const chips = (clip?.entry_ids || []).map(byId).filter(Boolean).map(e => `<span class="chip" data-tentry="${e.id}" title="Details">${dot(e)} ${esc(e.name)}</span>`).join('');
      return `<div class="tcode"><button class="icon tcopy" data-pact="copycode" title="Copy">Copy</button><pre>${maskedText(p.text || '')}</pre></div>${chips ? `<div class="chips">${chips}</div>` : ''}`;
    }
    if (p.kind === 'entry') {
      const e = byId(p.ref);
      if (!e) return '<span class="muted">(this connection was deleted)</span>';
      return `<div class="tentry">${dot(e)} <b>${ruleName(e)}</b> <span class="muted">${esc([e.username, e.host || e.url].filter(Boolean).join(' @ '))}${e.port ? ':' + e.port : ''}</span>${e.env ? ` <span class="badge ${esc(e.env)}">${esc(e.env)}</span>` : ''}
        <span class="spacer"></span>${canSSH(e) ? `<button class="icon" data-tconn="ssh" data-id="${e.id}">SSH</button>` : ''}${canDB(e) ? `<button class="icon" data-tconn="sql" data-id="${e.id}">SQL</button>` : ''}${e.url ? `<button class="icon" data-tconn="open" data-id="${e.id}">Open</button>` : ''}<button class="icon" data-tentry="${e.id}">Details</button></div>${p.html ? withCopy(sanitizeHTML(p.html)) : ''}`;
    }
    return withCopy(sanitizeHTML(p.html || ''));
  },

  // Cards under a message for the Jira issues and links it mentions.
  previews(p) {
    const text = p.text || new DOMParser().parseFromString(p.html || '', 'text/html').body.textContent || '';
    const hrefs = [...(p.html || '').matchAll(/href="(https?:[^"]+)"/g)].map(m => m[1]);
    const urls = [...new Set([...hrefs, ...(text.match(/https?:\/\/[^\s<>"']+/g) || [])])].filter(u => !u.startsWith(location.origin)).slice(0, 2);
    const keys = [...new Set(text.match(/\b[A-Z][A-Z0-9_]+-\d+\b/g) || [])].slice(0, 3);
    const cards = [];
    for (const k of keys) {
      const j = (typeof Jira !== 'undefined' ? Jira.issues : []).find(x => x.key === k);
      if (!j && !Jira?.cfg?.base_url) continue;
      cards.push(`<a href="#" class="tcard" data-jkey="${esc(k)}"><span class="tcard-k">◆ ${esc(k)}</span>${j ? `<span class="tcard-t">${esc(j.summary || '')}</span><span class="jstat">${esc(j.status || '')}</span>` : '<span class="muted tiny">open in Jira</span>'}</a>`);
    }
    for (const u of urls) {
      const e = S.entries.find(x => x.url && normURL(x.url) === normURL(u));
      let host = ''; try { host = new URL(u).host; } catch { /* bad URL */ }
      cards.push(`<a href="${esc(u)}" class="tcard" data-ext="1" title="${esc(u)}">${e ? dot(e) : '🔗'} <span class="tcard-t">${esc(e?.name || linkLabel(u) || host)}</span><span class="muted tiny">${esc(host)}</span></a>`);
    }
    return cards.length ? `<div class="tcards">${cards.join('')}</div>` : '';
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
    const el = $(`#taskMain [data-post="${pid}"]`); if (!el) return;
    el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1600);
  },
  // "Reply in thread": the side panel with the message and its replies.
  openReply(pid) { this.openPanel(pid); },
  openPanel(pid) {
    this.panel = pid; this.panelScroll = true; this.render();
    $('.tpanel .rbox')?.focus();
  },
  closePanel() { this.panel = ''; this.render(); },
  async sendReply(pid) {
    const box = $(`#taskMain [data-reply="${pid}"]`); if (!box) return;
    if (!box.textContent.trim() && !box.querySelector('img')) return;
    const html = slackBlocks(sanitizeHTML(box.innerHTML));
    box.innerHTML = '';
    this.panelScroll = true;
    try { await this.post('note', { html, parent: pid }); } catch (err) { toast(err.message, true); }
    $('.tpanel .rbox')?.focus();
  },
  async patch(p, fields, msg) {
    try { await api('PUT', `/api/work/${this.current.id}/posts/${p.id}`, fields); } catch (err) { return toast(err.message, true); }
    Object.assign(p, fields);
    if ('remind_at' in fields && fields.remind_at?.startsWith('0001')) p.remind_at = '';
    this.render();
    if (msg) toast(msg);
  },
  react(p, emoji) {
    const r = p.reactions || [];
    this.patch(p, { reactions: r.includes(emoji) ? r.filter(x => x !== emoji) : [...r, emoji] });
  },
  save(p) { this.patch(p, { saved: !p.saved }, p.saved ? 'Removed from Saved' : '🔖 Saved — find it under 🔖 Saved above the thread list'); },
  remind(p, when) {
    try { if (when && Notification.permission === 'default') Notification.requestPermission(); } catch { /* not available */ }
    this.patch(p, { remind_at: when ? when.toISOString() : '0001-01-01T00:00:00Z' }, when ? `⏰ I'll remind you ${when.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : 'Reminder removed');
  },
  postLink(p) { return `${location.origin}/#tasks/${this.current.id}/${p.id}`; },
  editPost(pid) {
    const postEl = $(`#taskMain [data-post="${pid}"]`); if (!postEl) return;
    const body = postEl.querySelector('.tbody');
    body.contentEditable = 'true'; body.classList.add('editing'); body.focus();
    const r = document.createRange(); r.selectNodeContents(body); r.collapse(false); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    body.insertAdjacentHTML('afterend', '<div class="row tedit"><button class="primary" data-pact="save-edit">Save</button><button data-pact="cancel">Cancel</button><span class="muted tiny">Enter saves · Esc cancels</span></div>');
  },
  async pin(p, on) {
    await api('PUT', `/api/work/${this.current.id}/posts/${p.id}`, { pinned: on }).catch(err => toast(err.message, true));
    p.pinned = on; this.render(); toast(on ? 'Pinned to the top of the thread' : 'Unpinned');
  },

  async send() {
    const box = $('#tbox'); if (!box) return;
    const html = slackBlocks(sanitizeHTML(box.innerHTML)).replace(/^(<p><br><\/p>|<br>)+|(<p><br><\/p>|<br>)+$/g, '');
    if (!box.textContent.trim() && !box.querySelector('img')) return;
    box.innerHTML = ''; Drafts.set(this.current.id, '');
    try { await this.post('note', { html }); } catch (err) { toast(err.message, true); box.innerHTML = html; }
    $('#tbox')?.focus();
  },

  // Pick a thread (recent first) for "Add to task thread…".
  // A menu of threads to choose from (most recent first); "Other thread…"
  // finds any by name. except: a thread to leave out (the one you are in).
  pick(ev, then, except) {
    const r = ev.target?.getBoundingClientRect?.() || { left: ev.clientX, bottom: ev.clientY };
    const all = this.list.filter(w => w.id !== except && !w.archived);
    const open = all.filter(w => w.status !== 'done').slice(0, 12);
    const other = async () => {
      const q = prompt('Which thread? Type part of its name:'); if (!q?.trim()) return;
      const hits = this.list.filter(w => w.id !== except && w.title.toLowerCase().includes(q.trim().toLowerCase()));
      if (!hits.length) return toast(`No thread called “${q.trim()}”`, true);
      if (hits.length === 1) return then(hits[0].id, hits[0].title);
      setTimeout(() => Tree.showMenu({ clientX: r.left, clientY: r.bottom }, hits.slice(0, 20).map(w => [`${w.archived ? '🗄 ' : ''}${w.title}`, () => then(w.id, w.title)])));
    };
    setTimeout(() => Tree.showMenu({ clientX: r.left, clientY: r.bottom }, [
      ...open.map(w => [`${w.id === this.active() ? '● ' : ''}${w.title}`, () => then(w.id, w.title)]),
      ...(open.length ? ['-'] : []),
      ...(all.length > open.length ? [['🔎 Other thread…', other]] : []),
      ['+ New thread…', async () => { const w = await this.create(); if (w) then(w.id, w.title); }]]));
  },
  // ➡ Move / ⧉ Copy a message (with its replies) to another thread.
  async movePost(p, copy, at) {
    const w = this.current; if (!w) return;
    if (!this.list.length) await this.loadList();
    this.pick(at, async (to, title) => {
      try {
        const moved = await api('POST', `/api/work/${w.id}/posts/${p.id}/move`, { to, copy });
        if (!copy) {
          w.posts = w.posts.filter(x => x.id !== p.id && x.parent !== p.id);
          if (this.panel === p.id) this.panel = '';
          this.render();
        }
        this.loadList();
        toast(`${copy ? 'Copied' : 'Moved'} to “${title}”`, false, copy ? async () => { await api('DELETE', `/api/work/${to}/posts/${moved.id}`); this.loadList(); toast('Copy removed'); }
          : async () => { await api('POST', `/api/work/${to}/posts/${moved.id}/move`, { to: w.id }); if (this.current?.id === w.id) this.open(w.id); toast('Moved back'); });
      } catch (err) { toast(err.message, true); }
    }, w.id);
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

// Word documents → messages in the open thread (one each), formatting kept.
Work.importInto = async files => {
  const w = Work.current; if (!w) return;
  files = [...files].filter(f => /\.docx?$/i.test(f.name));
  if (!files.length) return toast('Pick Word documents (.docx)', true);
  const fd = new FormData(); files.forEach(f => fd.append('file', f, f.name));
  toast(`Adding ${files.length} document(s) to the thread…`);
  const r = await fetch(`/api/work/${w.id}/import`, { method: 'POST', body: fd }).then(x => x.json()).catch(err => ({ problems: [err.message] }));
  const n = r.posts?.length || 0;
  if (n && Work.current?.id === w.id) { Work.current = await api('GET', '/api/work/' + w.id); Work.render(true); }
  if (n) Work.loadList();
  if (r.problems?.length) toast(`${n ? `Added ${n}. ` : ''}${r.problems.join(' · ')}`, true);
  else toast(`📄 Added ${n} document${n > 1 ? 's' : ''} to the thread`);
};
Work.pickInto = () => {
  const inp = Object.assign(document.createElement('input'), { type: 'file', multiple: true, accept: '.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  inp.onchange = () => Work.importInto(inp.files);
  inp.click();
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
  const st = e.target.closest('[data-star]'); if (st) { const x = Work.list.find(w => w.id === st.dataset.star); return x && Work.star(x, !x.starred); }
  const sec = e.target.closest('[data-sec]');
  if (sec) { (Work.collapsed ||= new Set()); Work.collapsed.has(sec.dataset.sec) ? Work.collapsed.delete(sec.dataset.sec) : Work.collapsed.add(sec.dataset.sec); return Work.renderList(); }
  const li = e.target.closest('[data-work]'); if (li) Work.open(li.dataset.work);
});
$('#captureThread')?.addEventListener('click', e => {
  const go = e.target.closest('[data-gothread]'); if (go) { e.preventDefault(); return Work.open(go.dataset.gothread); }
  if (e.target.closest('[data-stopthread]')) { e.preventDefault(); saveSettings({ active_thread: 'off' }).then(() => { Work.renderCapture(); Work.renderList(); if (Work.current) Work.render(); }); }
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
  if (e.target.id === 'tbox' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); return Work.send(); }
  // ↑ in an empty box edits your last message (as in Slack)
  if (e.target.id === 'tbox' && e.key === 'ArrowUp' && !e.target.textContent.trim() && !e.target.querySelector('img')) {
    const mine = (Work.current?.posts || []).filter(p => p.kind === 'note' && !p.parent).pop();
    if (mine) { e.preventDefault(); Work.flash(mine.id); return Work.editPost(mine.id); }
  }
  const rb = e.target.closest?.('.rbox');
  if (rb && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); return Work.sendReply(rb.dataset.reply); }
  const ed = e.target.closest?.('.tbody[contenteditable=true]');
  if (ed && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); return ed.parentElement.querySelector('[data-pact=save-edit]')?.click(); }
  if (ed && e.key === 'Escape') return Work.render();
  if (e.key === 'Escape' && Work.panel) { e.preventDefault(); return Work.closePanel(); }
});
// Ctrl+B / Ctrl+I / Ctrl+U: bold, italic, underline in message boxes (and
// Ctrl+Shift+X strikethrough), on the selection or for what you type next.
page.addEventListener('keydown', e => {
  const box = e.target.closest?.('.tbox, .tbody[contenteditable=true]'); if (!box || !(e.ctrlKey || e.metaKey) || e.altKey) return;
  const k = e.key.toLowerCase();
  const cmd = !e.shiftKey && { b: 'bold', i: 'italic', u: 'underline' }[k] || (e.shiftKey && k === 'x' ? 'strikeThrough' : '');
  if (!cmd) return;
  e.preventDefault(); e.stopPropagation();
  document.execCommand(cmd);
});
// Slack typing in every message box; the draft is kept.
page.addEventListener('input', e => {
  const box = e.target.closest?.('.tbox, .tbody[contenteditable=true]'); if (!box) return;
  if (e.inputType === 'insertText' && e.data && /[*_~`:]/.test(e.data.slice(-1))) slackType(box, e.data.slice(-1));
  if (box.id === 'tbox' && Work.current) { clearTimeout(Work.draftT); Work.draftT = setTimeout(() => Drafts.set(Work.current.id, box.textContent.trim() || box.querySelector('img') ? box.innerHTML : ''), 400); }
});
page.addEventListener('click', async e => {
  const w = Work.current;
  const act = e.target.closest('[data-tact]')?.dataset.tact;
  if (act === 'new') return Work.create();
  if (!w) return;
  if (e.target.closest('#tsend')) return Work.send();
  if (act === 'capture') return Work.setCapture(w.id !== Work.active());
  if (act === 'popout') return Popout.popThread(w);
  if (act === 'star') return Work.star(w, !w.starred);
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
      ['📄 Add a Word document to this thread…', () => Work.pickInto()],
      '-',
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
        if (w.id === S.settings.active_thread) await saveSettings({ active_thread: '' });
        await api('DELETE', '/api/work/' + w.id); Work.current = null; await Work.loadList(); Work.show();
      }]]));
  }
  const go = e.target.closest('[data-gopost]'); if (go) return Work.flash(go.dataset.gopost);
  const sr = e.target.closest('[data-pact=sendreply]'); if (sr) return Work.sendReply(sr.dataset.parent);
  if (e.target.closest('[data-pact=closepanel]')) return Work.closePanel();
  const conn = e.target.closest('[data-tconn]');
  if (conn) { const x = byId(conn.dataset.id); return x && ({ ssh: () => Term.open(x), sql: () => SQL.open(x), open: () => openURL(x) })[conn.dataset.tconn](); }
  const ent = e.target.closest('[data-tentry]'); if (ent) return showDetails(byId(ent.dataset.tentry));
  const jk = e.target.closest('[data-jkey]');
  if (jk) { e.preventDefault(); const j = Jira.issues.find(x => x.key === jk.dataset.jkey); if (j) { show('jira'); Jira.sel = 'i:' + j.key; return Jira.render(); } return Jira.cfg?.base_url && openExternal(Jira.cfg.base_url.replace(/\/$/, '') + '/browse/' + jk.dataset.jkey); }
  const postEl = e.target.closest('[data-post]'), pactEl = e.target.closest('[data-pact]'), pact = pactEl?.dataset.pact;
  if (pact === 'copycode') { e.preventDefault(); return copyText(pactEl.parentElement.querySelector('pre').innerText, 'Copied'); }
  if (postEl && pact) {
    e.preventDefault();
    const p = w.posts.find(x => x.id === postEl.dataset.post); if (!p) return;
    if (pact === 'react') return Work.react(p, pactEl.dataset.emoji);
    if (pact === 'emoji') return emojiPicker(pactEl, em => Work.react(p, em));
    if (pact === 'thread') return Work.openPanel(p.parent || p.id);
    if (pact === 'save') return Work.save(p);
    if (pact === 'edit') return Work.editPost(p.id);
    if (pact === 'expand' || pact === 'fold') { (Work.expanded ||= new Set())[pact === 'expand' ? 'add' : 'delete'](p.id); Work.render(); return pact === 'fold' && Work.flash(p.id); }
    if (pact === 'cancel') return Work.render();
    if (pact === 'save-edit') {
      const html = slackBlocks(sanitizeHTML(postEl.querySelector('.tbody').innerHTML));
      await api('PUT', `/api/work/${w.id}/posts/${p.id}`, { html }).catch(err => toast(err.message, true));
      p.html = html; p.edited = new Date().toISOString(); return Work.render();
    }
    if (pact === 'more') return postMenu(p, postEl, pactEl.getBoundingClientRect());
  }
  // Links in posts open in the browser; links to WorkHub posts open them here.
  const a = e.target.closest('.tbody a[href], a.tcard[data-ext]');
  if (a && !e.target.closest('[contenteditable=true]')) {
    e.preventDefault();
    const own = a.href.startsWith(location.origin) && a.href.match(/#tasks\/([0-9a-f]+)(?:\/([0-9a-f]+))?/);
    return own ? Work.openLink(own[1], own[2]) : openExternal(a.href);
  }
});
// The ⋯ menu of a message (also its right-click menu).
function postMenu(p, postEl, r) {
  const w = Work.current, kids = w.posts.filter(x => x.parent === p.id);
  const at = (h, m = 0, days = 0) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(h, m, 0, 0); return d; };
  const nextMon = () => { const d = at(9); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); return d; };
  setTimeout(() => Tree.showMenu({ clientX: r.left - 160, clientY: r.bottom }, [
    ['💬 Reply in thread', () => Work.openPanel(p.parent || p.id)],
    [p.pinned ? '📌 Unpin' : '📌 Pin to the top', () => Work.pin(p, !p.pinned)],
    [p.saved ? '🔖 Remove from Saved' : '🔖 Save for later', () => Work.save(p)],
    '-',
    ['⏰ Remind me in 20 minutes', () => Work.remind(p, new Date(Date.now() + 20 * 60e3))],
    ['⏰ Remind me in 1 hour', () => Work.remind(p, new Date(Date.now() + 60 * 60e3))],
    ['⏰ Remind me in 3 hours', () => Work.remind(p, new Date(Date.now() + 3 * 60 * 60e3))],
    ['⏰ Remind me tomorrow 9:00', () => Work.remind(p, at(9, 0, 1))],
    ['⏰ Remind me next Monday 9:00', () => Work.remind(p, nextMon())],
    ...(p.remind_at ? [['⏰ Remove the reminder', () => Work.remind(p, null)]] : []),
    '-',
    ['🔗 Copy link to this message', () => copyText(Work.postLink(p), 'Link copied — paste it in another thread or note to jump here')],
    ['Copy text', () => copyText(p.text || postEl.querySelector('.tbody').innerText)],
    ['➡ Move to another thread…', () => Work.movePost(p, false, { clientX: r.left - 160, clientY: r.bottom })],
    ['⧉ Copy to another thread…', () => Work.movePost(p, true, { clientX: r.left - 160, clientY: r.bottom })],
    ...(p.kind === 'note' ? [['✎ Edit', () => Work.editPost(p.id)]] : []),
    [kids.length ? `Delete message and its ${kids.length} repl${kids.length > 1 ? 'ies' : 'y'}` : 'Delete message', async () => {
      await api('DELETE', `/api/work/${w.id}/posts/${p.id}`);
      w.posts = w.posts.filter(x => x !== p && x.parent !== p.id);
      if (Work.panel === p.id) Work.panel = '';
      Work.render(); Work.loadList();
      toast(kids.length ? `Message and ${kids.length} repl${kids.length > 1 ? 'ies' : 'y'} deleted` : 'Message deleted', false, async () => {
        const back = await Work.post(p.kind, { html: p.html, text: p.text, ref: p.ref, at: p.at, parent: p.parent, pinned: p.pinned, reactions: p.reactions, saved: p.saved }, w.id);
        for (const k of kids) await Work.post(k.kind, { html: k.html, text: k.text, ref: k.ref, at: k.at, parent: back.id, pinned: k.pinned, reactions: k.reactions }, w.id);
        toast('Restored');
      });
    }]]));
}
// A small emoji picker under a button.
function emojiPicker(anchor, pick) {
  $('#emojiPick')?.remove();
  const r = anchor.getBoundingClientRect(), el = document.createElement('div');
  el.id = 'emojiPick'; el.className = 'emoji-pick';
  el.innerHTML = PICKER.map(e => `<button type="button" data-em="${e}">${e}</button>`).join('');
  el.style.left = Math.max(8, Math.min(r.left - 120, innerWidth - 260)) + 'px';
  el.style.top = Math.min(r.bottom + 4, innerHeight - 150) + 'px';
  document.body.append(el);
  el.addEventListener('click', ev => { const b = ev.target.closest('[data-em]'); if (b) { el.remove(); pick(b.dataset.em); } });
  setTimeout(() => document.addEventListener('mousedown', function off(ev) { if (!el.contains(ev.target)) { el.remove(); document.removeEventListener('mousedown', off); } }), 0);
}
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
  const all = [...e.dataTransfer.files], mails = all.filter(f => /\.(msg|eml)$/i.test(f.name)), docs = all.filter(f => /\.docx$/i.test(f.name)), rest = all.filter(f => !mails.includes(f) && !docs.includes(f));
  if (docs.length) await Work.importInto(docs); // Word documents: their contents, formatting kept
  if (mails.length) { // emails dragged from Outlook: one message each (subject, sender, text, attachments)
    const fd = new FormData(); mails.forEach(f => fd.append('file', f, f.name));
    toast(`Adding ${mails.length} email(s)…`);
    const r = await fetch(`/api/work/${Work.current.id}/email`, { method: 'POST', body: fd });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) toast(d.error || 'Couldn\'t read the email', true);
    else { Work.current = await api('GET', '/api/work/' + Work.current.id); Work.render(true); Work.loadList(); toast(`✉ Added ${d.length} email${d.length > 1 ? 's' : ''}`); }
  }
  if (rest.length) { toast(`Adding ${rest.length} file(s)…`); insertAtCaret(await Work.storeFiles(rest)); }
});

// ---- Ctrl+K on the Tasks page: jump to a thread (Slack's quick switcher) ----
window.addEventListener('keydown', e => {
  if (!((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') || !$('#view-tasks').classList.contains('active')) return;
  e.preventDefault(); e.stopImmediatePropagation();
  Switcher.open();
}, true);
const Switcher = {
  open() {
    $('#switchDlg')?.remove();
    const d = document.createElement('dialog'); d.id = 'switchDlg'; d.className = 'switcher';
    d.innerHTML = '<input type="search" placeholder="Jump to a thread…  (Ctrl+K again: search everything)"><div class="sw-list"></div>';
    document.body.append(d); d.showModal();
    const inp = $('input', d), list = $('.sw-list', d);
    let sel = 0, items = [];
    const draw = () => {
      const q = inp.value.trim().toLowerCase();
      items = [...Work.list].filter(w => !w.archived || q).sort((a, b) => (b.unread > 0) - (a.unread > 0) || b.starred - a.starred || new Date(b.updated) - new Date(a.updated))
        .filter(w => !q || q.split(/\s+/).every(t => w.title.toLowerCase().includes(t) || (w.jira || '').toLowerCase().includes(t))).slice(0, 12);
      sel = Math.min(sel, Math.max(0, items.length - 1));
      list.innerHTML = items.map((w, i) => `<div class="sw-item ${i === sel ? 'sel' : ''}" data-i="${i}">${w.starred ? '★ ' : ''}<b>${esc(w.title)}</b>${w.unread ? ` <span class="tunread">${w.unread}</span>` : ''}<span class="spacer"></span><span class="muted tiny">${esc(fmtTime(w.updated))}</span></div>`).join('') || '<div class="muted tiny" style="padding:8px">No thread matches</div>';
    };
    const go = i => { const w = items[i]; d.close(); if (w) Work.open(w.id); };
    inp.addEventListener('input', () => { sel = 0; draw(); });
    inp.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, items.length - 1); draw(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); draw(); }
      if (e.key === 'Enter') { e.preventDefault(); go(sel); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); e.stopPropagation(); d.close(); show('dashboard'); $('#search').focus(); }
    });
    list.addEventListener('click', e => { const it = e.target.closest('[data-i]'); if (it) go(+it.dataset.i); });
    d.addEventListener('close', () => d.remove());
    draw(); inp.focus();
  },
};

// ---- 🔖 Saved and ⏰ reminders ----
const SavedMsgs = {
  async open(anchor) {
    const [saved, rem] = await Promise.all([api('GET', '/api/work/saved').catch(() => []), api('GET', '/api/work/reminders').catch(() => [])]);
    $('#savedPop')?.remove();
    const el = document.createElement('div'); el.id = 'savedPop'; el.className = 'saved-pop';
    const snip = x => esc((x.post.text || new DOMParser().parseFromString(x.post.html || '', 'text/html').body.textContent || (/<img/.test(x.post.html || '') ? '🖼 Screenshot' : '')).trim().slice(0, 120));
    const row = (x, extra) => `<div class="saved-row" data-open="${x.thread}" data-pid="${x.post.id}"><div><b>${esc(x.title)}</b> <span class="muted tiny">${esc(new Date(x.post.at).toLocaleString())}</span>${extra}</div><div class="saved-snip">${snip(x)}</div></div>`;
    el.innerHTML = `<div class="saved-h">⏰ Reminders</div>${rem.sort((a, b) => new Date(a.post.remind_at) - new Date(b.post.remind_at)).map(x => row(x, ` <span class="tflag">⏰ ${esc(new Date(x.post.remind_at).toLocaleString([], { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}</span>`)).join('') || '<div class="muted tiny">None — ⋯ on a message → Remind me</div>'}
      <div class="saved-h">🔖 Saved for later</div>${saved.reverse().map(x => row(x, '')).join('') || '<div class="muted tiny">Nothing saved — 🔖 on a message saves it here</div>'}`;
    const r = anchor.getBoundingClientRect();
    el.style.left = r.left + 'px'; el.style.top = r.bottom + 4 + 'px';
    document.body.append(el);
    el.addEventListener('click', e => { const x = e.target.closest('[data-open]'); if (x) { el.remove(); Work.open(x.dataset.open, x.dataset.pid); } });
    setTimeout(() => document.addEventListener('mousedown', function off(ev) { if (!el.contains(ev.target)) { el.remove(); document.removeEventListener('mousedown', off); } }), 0);
  },
  // Due reminders pop up (and as a Windows notification when allowed).
  async check() {
    const rem = await api('GET', '/api/work/reminders').catch(() => []);
    for (const x of rem.filter(x => new Date(x.post.remind_at) <= new Date())) {
      const text = (x.post.text || new DOMParser().parseFromString(x.post.html || '', 'text/html').body.textContent || '').trim().slice(0, 80);
      await api('PUT', `/api/work/${x.thread}/posts/${x.post.id}`, { remind_at: '0001-01-01T00:00:00Z' }).catch(() => {});
      toast(`⏰ ${x.title}: ${text || 'reminder'}`, false, () => Work.open(x.thread, x.post.id), 'Open');
      try { if (Notification.permission === 'granted') new Notification('⏰ ' + x.title, { body: text }).onclick = () => { window.focus(); Work.open(x.thread, x.post.id); }; } catch { /* not available */ }
    }
  },
};
$('#workSaved').addEventListener('click', e => SavedMsgs.open(e.currentTarget));
setInterval(() => SavedMsgs.check(), 60 * 1000);
setTimeout(() => SavedMsgs.check(), 5000);
setInterval(() => Work.refresh(), 15 * 1000);
// Links to a message (#tasks/<thread>/<message>) — on start and when followed.
function followTaskLink() { const m = location.hash.match(/^#tasks\/([0-9a-f]+)(?:\/([0-9a-f]+))?/); if (m) Work.loadList().then(() => Work.openLink(m[1], m[2])); }
window.addEventListener('hashchange', followTaskLink);
setTimeout(followTaskLink, 900);

// ---- Ctrl+Alt+N: quick note to a thread, from anywhere (Desktop) ----
const QuickNote = {
  async open() {
    if (!Work.list.length) await Work.loadList();
    $('#quickNoteDlg')?.remove();
    const d = document.createElement('dialog'); d.id = 'quickNoteDlg'; d.className = 'quicknote';
    const def = Work.active() || Work.current?.id || Work.list[0]?.id;
    const opts = [...Work.list].filter(w => !w.archived).sort((a, b) => (b.id === def) - (a.id === def) || b.starred - a.starred || new Date(b.updated) - new Date(a.updated));
    d.innerHTML = `<div class="row"><b>📝 Quick note to</b><select>${opts.map(w => `<option value="${w.id}">${w.starred ? '★ ' : ''}${esc(w.title)}</option>`).join('')}</select></div>
      <div class="tbox qbox" contenteditable="true" data-placeholder="Type the note… *bold* _italic_ \`code\` · Enter posts · Shift+Enter new line · Esc closes"></div>
      <div class="row end"><button value="cancel">Cancel</button><button class="primary" value="post">Post</button></div>`;
    document.body.append(d); d.showModal();
    const box = $('.qbox', d), sel = $('select', d);
    const post = async () => {
      if (!box.textContent.trim() && !box.querySelector('img')) return;
      const id = sel.value, html = slackBlocks(sanitizeHTML(box.innerHTML));
      d.close();
      try { await Work.post('note', { html }, id); toast(`📝 Posted to “${Work.list.find(w => w.id === id)?.title}”`); } catch (err) { toast(err.message, true); }
    };
    box.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); post(); } });
    box.addEventListener('input', e => { if (e.inputType === 'insertText' && e.data && /[*_~`:]/.test(e.data.slice(-1))) slackType(box, e.data.slice(-1)); });
    d.addEventListener('click', e => { const b = e.target.closest('button[value]'); if (b) b.value === 'post' ? post() : d.close(); });
    d.addEventListener('close', () => d.remove());
    box.focus();
  },
};
window.whQuickNote = () => QuickNote.open();
window.addEventListener('keydown', e => { if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'n') { e.preventDefault(); QuickNote.open(); } });

// ---- right-click: the same menus as ⋯ ----
$('#workList').addEventListener('contextmenu', e => {
  const li = e.target.closest('[data-work]'); if (!li) return;
  e.preventDefault();
  const w = Work.list.find(x => x.id === li.dataset.work); if (!w) return;
  setTimeout(() => Tree.showMenu({ clientX: e.clientX, clientY: e.clientY }, [
    ['Open', () => Work.open(w.id)],
    [w.starred ? '☆ Unstar' : '★ Star', () => Work.star(w, !w.starred)],
    [w.id === Work.active() ? '● Stop capturing here' : '📥 Capture here', async () => { await Work.open(w.id); Work.setCapture(w.id !== Work.active()); }],
    ...(w.unread ? [['✓ Mark as read', () => Work.markRead(w.id)]] : []),
    ['🔗 Copy link to thread', () => copyText(`${location.origin}/#tasks/${w.id}`, 'Link copied')],
    '-',
    [w.archived ? '↩ Unarchive' : '🗄 Archive', () => Work.archive(w, !w.archived)],
    ...(w.general ? [] : [['Delete…', async () => {
      if (!confirm(`Delete the thread "${w.title}" and everything in it?`)) return;
      if (w.id === S.settings.active_thread) await saveSettings({ active_thread: '' });
      await api('DELETE', '/api/work/' + w.id); if (Work.current?.id === w.id) Work.current = null; await Work.loadList(); Work.show();
    }]])]));
});
$('#taskMain').addEventListener('contextmenu', e => {
  const el = e.target.closest('[data-post]');
  if (!el || e.target.closest('[contenteditable=true], a, input, textarea')) return;
  const p = Work.current?.posts.find(x => x.id === el.dataset.post); if (!p) return;
  if (getSelection().toString()) return; // let the browser copy selected text
  e.preventDefault();
  postMenu(p, el, { left: e.clientX + 160, bottom: e.clientY });
});
