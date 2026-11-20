'use strict';
// Work items (Notepad++): one free-form rich-text document per ticket/change/
// incident. Type anywhere; paste screenshots, links or formatted text where
// the cursor is; drop files. Markdown-style shortcuts while typing:
// "# " heading, "## " sub-heading, "- " bullets, "1. " numbers, "[] " checkbox.

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

const Work = {
  list: [], current: null, saveTimer: null, headTimer: null,

  async loadList() {
    this.list = (await api('GET', '/api/work').catch(() => [])) || [];
    this.renderList();
  },

  renderList() {
    const q = ($('#workSearch')?.value || '').trim().toLowerCase();
    const items = this.list.filter(w => !q || q.split(/\s+/).every(t => w.search.includes(t)));
    $('#workList').innerHTML = items.map(w => `<div class="li ${this.current?.id === w.id ? 'active' : ''}" data-work="${w.id}">
      <span class="wstatus ${w.status}">${esc((STATUSES.find(s => s[0] === w.status) || STATUSES[0])[1])}</span> ${esc(w.title)}
      <small>${fmtTime(w.updated)}${w.links ? ` · ${w.links} link${w.links > 1 ? 's' : ''}` : ''}${w.images ? ` · ${w.images} 🖼` : ''}${w.tags?.length ? ' · ' + esc(w.tags.join(', ')) : ''}</small></div>`).join('')
      || `<div class="muted tiny">${q ? 'No matches' : 'No work items yet'}</div>`;
  },

  async open(id) {
    await this.flush();
    try { this.current = await api('GET', '/api/work/' + id); } catch (err) { return toast(err.message, true); }
    try { localStorage.setItem('workSel', id); } catch { /* ignore */ }
    $('.editor-wrap').hidden = true;
    $('#workPage').hidden = false;
    $$('#noteList .li, #recentList .li').forEach(li => li.classList.remove('active'));
    // Older pages made of blocks become one document.
    if (!this.current.doc && this.current.blocks?.length) { this.current.doc = blocksToHTML(this.current.blocks); this.saveDoc(true); }
    this.render();
    this.renderList();
  },

  async close() {
    await this.flush();
    this.current = null;
    try { localStorage.removeItem('workSel'); } catch { /* ignore */ }
    $('#workPage').hidden = true;
    $('.editor-wrap').hidden = false;
    this.renderList();
  },

  async create(title) {
    const w = await api('POST', '/api/work', { title: title || 'New work item' });
    await this.loadList();
    await this.open(w.id);
    setTimeout(() => $('#workDoc')?.focus());
    return w;
  },

  render() {
    const w = this.current; if (!w) return;
    $('#workPage').innerHTML = `
      <div class="whero">
        <input id="workTitle" class="wtitle" value="${esc(w.title)}" placeholder="Work item title (e.g. PAY-123 refund limits)">
        <select id="workStatus">${STATUSES.map(([v, l]) => `<option value="${v}" ${w.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <input id="workTags" value="${esc((w.tags || []).join(', '))}" placeholder="tags, comma separated">
        <span id="workSaved" class="muted tiny"></span>
        <span class="spacer"></span><button data-wact="word" title="Open the Word copy saved in workhub-data\\work-items">Open in Word</button><button data-wact="folder" title="Show the work-items folder">Open folder</button>
        <button data-wact="delete" class="danger">Delete</button><button data-wact="close" title="Back to notes">✕</button>
      </div>
      <div id="workDoc" class="wdoc" contenteditable="true" spellcheck="true" data-placeholder="Start typing. Paste screenshots (Win+Shift+S then Ctrl+V), links or text anywhere. Drop files here.
Shortcuts: # heading · ## sub-heading · - bullets · 1. numbers · [] checkbox · Ctrl+B/I/U · Ctrl+click opens a link">${sanitizeHTML(w.doc || '')}</div>`;
    document.execCommand('defaultParagraphSeparator', false, 'p'); // Enter makes <p>, not <div>
    const d = $('#workDoc');
    if (!d.innerHTML.trim()) d.innerHTML = '<p><br></p>'; // typing starts inside a paragraph
    this.updateEmpty();
  },

  updateEmpty() { const d = $('#workDoc'); if (d) d.classList.toggle('empty', !d.textContent.trim() && !d.querySelector('img')); },

  saveDoc(now) {
    const w = this.current; if (!w) return;
    clearTimeout(this.saveTimer);
    $('#workSaved') && ($('#workSaved').textContent = 'saving…');
    const go = async () => {
      const d = $('#workDoc');
      if (d && this.current === w) w.doc = sanitizeHTML(d.innerHTML);
      try {
        const res = await fetch(`/api/work/${w.id}/doc`, { method: 'PUT', body: w.doc }).then(r => r.json()).catch(() => ({}));
        if (this.current === w && $('#workSaved')) $('#workSaved').textContent = res.docx_error ? '⚠ ' + res.docx_error : 'saved ' + new Date().toLocaleTimeString() + ' (+ Word copy)';
        this.loadList();
      } catch (err) { toast('Save failed: ' + err.message, true); }
    };
    if (now) return go();
    this.saveTimer = setTimeout(go, 800);
  },
  async flush() { if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; await this.saveDoc(true); } },

  saveHeader() {
    const w = this.current;
    w.title = $('#workTitle').value; w.status = $('#workStatus').value;
    w.tags = $('#workTags').value.split(',').map(s => s.trim()).filter(Boolean);
    clearTimeout(this.headTimer);
    this.headTimer = setTimeout(async () => { await api('POST', '/api/work', { id: w.id, title: w.title, status: w.status, tags: w.tags }); this.loadList(); }, 600);
  },

  // Store files and return HTML to place in the document.
  async storeFiles(files) {
    const w = this.current, fd = new FormData();
    for (const f of files) fd.append('file', f, f.name);
    const r = await fetch(`/api/work/${w.id}/files`, { method: 'POST', body: fd });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { toast(d.error || 'Upload failed', true); return ''; }
    return d.map(a => a.image
      ? `<p><img src="/api/props/files/${a.id}" alt="${esc(a.name)}"></p>`
      : `<p>📎 <a href="${location.origin}/api/props/files/${a.id}?download=1" target="_blank" rel="noopener">${esc(a.name)}</a> <span class="muted">(${fmtSize(a.size)})</span></p>`).join('');
  },
};

function blocksToHTML(blocks) {
  return blocks.map(b => {
    const when = `<p class="muted"><small>${esc(new Date(b.added).toLocaleString())}</small></p>`;
    if (b.kind === 'text') return `<p>${esc(b.text || '').replace(/\n/g, '<br>')}</p>`;
    if (b.kind === 'link') return `<p>🔗 ${b.title ? esc(b.title) + ': ' : ''}<a href="${esc(b.url)}">${esc(b.url)}</a></p>`;
    if (b.kind === 'image' && b.file) return `<p><img src="/api/props/files/${b.file.id}" alt="${esc(b.title || '')}"></p>`;
    if (b.file) return `<p>📎 <a href="${location.origin}/api/props/files/${b.file.id}?download=1">${esc(b.file.name)}</a></p>`;
    return when;
  }).join('');
}

// Insert HTML at the caret inside the document.
function insertAtCaret(html) {
  const d = $('#workDoc'); if (!d) return;
  d.focus();
  const sel = window.getSelection();
  if (!sel.rangeCount || !d.contains(sel.anchorNode)) { const r = document.createRange(); r.selectNodeContents(d); r.collapse(false); sel.removeAllRanges(); sel.addRange(r); }
  document.execCommand('insertHTML', false, html);
  Work.updateEmpty();
  Work.saveDoc();
}

const linkHTML = u => { const label = urlLabel(u); return `${label ? `<b>${esc(label)}:</b> ` : ''}<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a>&nbsp;`; };

// ---- events ----
$('#workNew').onclick = () => Work.create();
$('#workSearch').addEventListener('input', () => Work.renderList());
$('#workList').addEventListener('click', e => { const li = e.target.closest('[data-work]'); if (li) Work.open(li.dataset.work); });
$('#view-notes').addEventListener('click', e => { if (e.target.closest('[data-open]') || e.target.closest('#newNote')) Work.close(); }, true);

const page = $('#workPage');
page.addEventListener('input', e => {
  if (['workTitle', 'workTags'].includes(e.target.id)) return Work.saveHeader();
  if (e.target.id === 'workDoc') { Work.updateEmpty(); Work.saveDoc(); }
});
page.addEventListener('change', e => { if (e.target.id === 'workStatus') Work.saveHeader(); if (e.target.matches?.('#workDoc input[type=checkbox]')) { e.target.toggleAttribute('checked', e.target.checked); Work.saveDoc(); } });
page.addEventListener('click', async e => {
  const w = Work.current; if (!w) return;
  const act = e.target.closest('[data-wact]')?.dataset.wact;
  if (act === 'close') return Work.close();
  if (act === 'word' || act === 'folder') {
    await Work.flush();
    try {
      const r = await api('POST', `/api/work/${w.id}/word${act === 'folder' ? '?what=folder' : ''}`);
      toast(r.warning ? r.warning : act === 'word' ? 'Opening in Word: ' + r.path.split(/[\\/]/).pop() : 'Opened the work-items folder');
    } catch (err) { toast(err.message, true); }
    return;
  }
  if (act === 'delete') {
    if (!confirm(`Delete work item "${w.title}" and everything in it?`)) return;
    clearTimeout(Work.saveTimer); Work.saveTimer = null;
    await api('DELETE', '/api/work/' + w.id); Work.current = null; await Work.close(); return Work.loadList();
  }
  // Ctrl/Cmd+click opens a link (plain click just places the cursor, like Word).
  const a = e.target.closest('#workDoc a[href]');
  if (a && (e.ctrlKey || e.metaKey)) { e.preventDefault(); return openExternal(a.href); }
  if (a) e.preventDefault();
});
page.addEventListener('dblclick', e => { const img = e.target.closest('#workDoc img'); if (img) { $('#lightboxImg').src = img.src; $('#lightbox').hidden = false; } });

// Markdown-style shortcuts as you type, at the start of a line.
page.addEventListener('keydown', e => {
  if (e.target.id !== 'workDoc') return;
  if (e.key === 's' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); return Work.saveDoc(true); }
  if (e.key !== ' ') return;
  const sel = window.getSelection(); if (!sel.rangeCount) return;
  const node = sel.anchorNode; if (node.nodeType !== 3) return;
  const before = node.textContent.slice(0, sel.anchorOffset);
  const line = node.parentElement.closest('div, p, li, h1, h2, h3') || node.parentElement;
  if (line.closest('li') && before !== '[]') return;
  const cmds = { '#': 'h1', '##': 'h2', '###': 'h3', '-': 'ul', '*': 'ul', '1.': 'ol', '>': 'blockquote', '[]': 'check' };
  const c = cmds[before.trim()];
  if (!c || before !== before.trimStart()) return;
  e.preventDefault();
  // Remove the typed marker with the editor's own command so the cursor and undo stay right.
  const r = document.createRange(); r.setStart(node, sel.anchorOffset - before.length); r.setEnd(node, sel.anchorOffset);
  sel.removeAllRanges(); sel.addRange(r);
  document.execCommand('delete');
  if (c === 'ul') document.execCommand('insertUnorderedList');
  else if (c === 'ol') document.execCommand('insertOrderedList');
  else if (c === 'check') document.execCommand('insertHTML', false, '<input type="checkbox">&nbsp;');
  else document.execCommand('formatBlock', false, `<${c}>`);
  Work.saveDoc();
});

// Paste: screenshots → images at the cursor; links → clickable links;
// formatted text (Outlook, Confluence, web) → kept, cleaned.
page.addEventListener('paste', async e => {
  if (e.target.closest('#workTitle, #workTags')) return;
  if (!e.target.closest('#workDoc')) return;
  const cd = e.clipboardData;
  const imgs = [...(cd?.items || [])].filter(i => i.type.startsWith('image/')).map(i => i.getAsFile()).filter(Boolean);
  const html = cd?.getData('text/html') || '';
  const text = cd?.getData('text/plain') || '';
  if (imgs.length && !html.trim()) {
    e.preventDefault();
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    toast('Adding screenshot…');
    return insertAtCaret(await Work.storeFiles(imgs.map((f, i) => new File([f], `screenshot-${stamp}${i ? '-' + i : ''}.png`, { type: f.type }))));
  }
  e.preventDefault();
  if (html.trim()) {
    // Pictures inside pasted HTML as data: URLs are stored as files.
    let clean = sanitizeHTML(html.replace(/<!--[\s\S]*?-->/g, ''));
    const datas = [...clean.matchAll(/src="(data:image\/(\w+);base64,[^"]+)"/g)];
    for (const [, uri, ext] of datas) {
      const bin = Uint8Array.from(atob(uri.split(',')[1]), ch => ch.charCodeAt(0));
      const stored = await Work.storeFiles([new File([bin], `pasted.${ext}`, { type: 'image/' + ext })]);
      const id = (stored.match(/files\/([0-9a-f]+)/) || [])[1];
      clean = clean.replace(uri, id ? '/api/props/files/' + id : '');
    }
    return insertAtCaret(clean);
  }
  if (/^\s*https?:\/\/\S+\s*$/.test(text)) return insertAtCaret(linkHTML(text.trim()));
  // Plain text: keep line breaks, turn URLs into links.
  const out = esc(text).replace(/https?:\/\/[^\s<>"']+/g, u => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`).replace(/\r?\n/g, '<br>');
  insertAtCaret(out);
});

// Drop files where the mouse is.
page.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files') && e.target.closest('#workDoc')) { e.preventDefault(); page.classList.add('dragover'); } });
page.addEventListener('dragleave', e => { if (e.target === page) page.classList.remove('dragover'); });
page.addEventListener('drop', async e => {
  if (!e.dataTransfer.files.length || !e.target.closest('#workDoc')) return;
  e.preventDefault(); page.classList.remove('dragover');
  const pos = document.caretRangeFromPoint?.(e.clientX, e.clientY);
  if (pos) { const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(pos); }
  toast(`Adding ${e.dataTransfer.files.length} file(s)…`);
  insertAtCaret(await Work.storeFiles([...e.dataTransfer.files]));
});
window.addEventListener('beforeunload', () => {
  const w = Work.current, d = $('#workDoc');
  if (w && Work.saveTimer && d) navigator.sendBeacon?.(`/api/work/${w.id}/doc`, new Blob([sanitizeHTML(d.innerHTML)], { type: 'text/html' }));
});
