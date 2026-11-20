'use strict';
// Work items (Notepad++ page): one page per ticket/change/incident made of
// blocks — notes, links, screenshots and files — in the order captured.
// Paste anything onto the page: images become screenshots, URLs become link
// cards, other text becomes a note.

const STATUSES = [['todo', 'To do'], ['doing', 'In progress'], ['blocked', 'Blocked'], ['done', 'Done']];

const Work = {
  list: [], current: null, saveTimers: {},

  async loadList() {
    this.list = (await api('GET', '/api/work').catch(() => [])) || [];
    this.renderList();
  },

  renderList() {
    const q = ($('#workSearch')?.value || '').trim().toLowerCase();
    const items = this.list.filter(w => !q || q.split(/\s+/).every(t => w.search.includes(t)));
    $('#workList').innerHTML = items.map(w => `<div class="li ${this.current?.id === w.id ? 'active' : ''}" data-work="${w.id}">
      <span class="wstatus ${w.status}">${esc((STATUSES.find(s => s[0] === w.status) || STATUSES[0])[1])}</span> ${esc(w.title)}
      <small>${fmtTime(w.updated)}${w.notes ? ` · ${w.notes} note${w.notes > 1 ? 's' : ''}` : ''}${w.links ? ` · ${w.links} link${w.links > 1 ? 's' : ''}` : ''}${w.images ? ` · ${w.images} 🖼` : ''}${w.files ? ` · ${w.files} 📎` : ''}${w.tags?.length ? ' · ' + esc(w.tags.join(', ')) : ''}</small></div>`).join('')
      || `<div class="muted tiny">${q ? 'No matches' : 'No work items yet'}</div>`;
  },

  async open(id) {
    try { this.current = await api('GET', '/api/work/' + id); } catch (err) { return toast(err.message, true); }
    try { localStorage.setItem('workSel', id); } catch { /* ignore */ }
    $('.editor-wrap').hidden = true;
    $('#workPage').hidden = false;
    $$('#noteList .li, #recentList .li').forEach(li => li.classList.remove('active'));
    this.render();
    this.renderList();
  },

  close() {
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
    setTimeout(() => { const t = $('#workTitle'); t?.focus(); t?.select(); });
    return w;
  },

  render() {
    const w = this.current; if (!w) return;
    const block = b => {
      const tools = `<span class="wtools"><button class="icon" data-wmove="up" data-b="${b.id}" title="Move up">↑</button><button class="icon" data-wmove="down" data-b="${b.id}" title="Move down">↓</button><button class="icon danger" data-wdel="${b.id}" title="Delete">✕</button></span>`;
      const when = `<span class="muted tiny">${new Date(b.added).toLocaleString()}</span>`;
      if (b.kind === 'text') return `<div class="wblock text" data-b="${b.id}"><div class="whead">📝 ${when}${tools}</div><textarea data-wtext="${b.id}" placeholder="Write a note…">${esc(b.text || '')}</textarea></div>`;
      if (b.kind === 'link') {
        const label = urlLabel(b.url);
        return `<div class="wblock link" data-b="${b.id}"><div class="whead">🔗 ${when}${tools}</div>
          <div class="wlink">${label ? `<span class="ulabel">${esc(label)}</span>` : ''}<input data-wtitle="${b.id}" value="${esc(b.title || '')}" placeholder="Description (optional)">
          <a href="${esc(b.url)}" target="_blank" rel="noopener" data-wopen="${esc(b.url)}">${esc(b.url)}</a><button class="icon" data-copy="${esc(b.url)}">copy</button></div></div>`;
      }
      if (b.kind === 'image') return `<div class="wblock image" data-b="${b.id}"><div class="whead">🖼 ${when}${tools}</div>
          <img src="/api/props/files/${b.file.id}" data-wimg="${b.file.id}" alt="${esc(b.title || '')}" loading="lazy">
          <input data-wtitle="${b.id}" value="${esc(b.title && b.title !== b.file.name ? b.title : '')}" placeholder="Caption (optional)"></div>`;
      return `<div class="wblock file" data-b="${b.id}"><div class="whead">📎 ${when}${tools}</div>
          <a class="btnlike" href="/api/props/files/${b.file.id}?download=1">${esc(b.file.name)}</a> <span class="muted tiny">${fmtSize(b.file.size)}</span></div>`;
    };
    $('#workPage').innerHTML = `
      <div class="whero">
        <input id="workTitle" class="wtitle" value="${esc(w.title)}" placeholder="Work item title (e.g. PAY-123 refund limits)">
        <select id="workStatus">${STATUSES.map(([v, l]) => `<option value="${v}" ${w.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <input id="workTags" value="${esc((w.tags || []).join(', '))}" placeholder="tags, comma separated">
        <span class="spacer"></span><button data-wact="delete" class="danger">Delete work item</button><button data-wact="close" title="Back to notes">✕</button>
      </div>
      <div class="wbar">
        <button data-wact="note">+ Note</button><button data-wact="link">+ Link</button>
        <label class="btnlike">+ Screenshot / image<input type="file" accept="image/*" multiple hidden data-wup="1"></label>
        <label class="btnlike">+ File<input type="file" multiple hidden data-wup="1"></label>
        <span class="muted tiny">or just <b>paste</b> (Ctrl+V) screenshots, links or text anywhere on this page · drop files here</span>
      </div>
      <div id="workBlocks" class="wblocks">${w.blocks.map(block).join('') || '<div class="empty">Empty page. Paste a screenshot (Win+Shift+S, then Ctrl+V), a link, or some text — or use the buttons above.</div>'}</div>`;
    $$('#workBlocks textarea').forEach(autoGrow);
  },

  async add(body) {
    const w = this.current;
    const added = await api('POST', `/api/work/${w.id}/blocks`, body);
    this.current.blocks.push(...added);
    this.render(); this.loadList();
    return added;
  },

  async upload(files) {
    const w = this.current; if (!w || !files.length) return;
    const fd = new FormData();
    for (const f of files) fd.append('file', f, f.name);
    toast(`Adding ${files.length} item(s)…`);
    const r = await fetch(`/api/work/${w.id}/blocks`, { method: 'POST', body: fd });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return toast(d.error || 'Upload failed', true);
    this.current.blocks.push(...d);
    this.render(); this.loadList();
    const last = $$('#workBlocks .wblock').pop(); last?.scrollIntoView({ block: 'nearest' });
  },

  saveLater(key, fn) {
    clearTimeout(this.saveTimers[key]);
    this.saveTimers[key] = setTimeout(fn, 600);
  },
  saveHeader() {
    const w = this.current;
    w.title = $('#workTitle').value; w.status = $('#workStatus').value;
    w.tags = $('#workTags').value.split(',').map(s => s.trim()).filter(Boolean);
    this.saveLater('head', async () => { await api('POST', '/api/work', { id: w.id, title: w.title, status: w.status, tags: w.tags }); this.loadList(); });
  },
};

function autoGrow(t) { t.style.height = 'auto'; t.style.height = Math.max(60, t.scrollHeight + 2) + 'px'; }

// ---- events ----
$('#workNew').onclick = () => Work.create();
$('#workSearch').addEventListener('input', () => Work.renderList());
$('#workList').addEventListener('click', e => { const li = e.target.closest('[data-work]'); if (li) Work.open(li.dataset.work); });
// Opening a note or file switches back to the editor.
$('#view-notes').addEventListener('click', e => { if (e.target.closest('[data-open]') || e.target.closest('#newNote')) Work.close(); }, true);

const page = $('#workPage');
page.addEventListener('input', e => {
  const w = Work.current; if (!w) return;
  if (['workTitle', 'workTags'].includes(e.target.id)) return Work.saveHeader();
  const t = e.target.dataset.wtext;
  if (t) { autoGrow(e.target); const v = e.target.value; Work.saveLater(t, () => api('PUT', `/api/work/${w.id}/blocks/${t}`, { text: v })); }
  const ti = e.target.dataset.wtitle;
  if (ti) { const v = e.target.value; Work.saveLater(ti, () => api('PUT', `/api/work/${w.id}/blocks/${ti}`, { title: v })); }
});
page.addEventListener('change', e => {
  if (e.target.id === 'workStatus') return Work.saveHeader();
  if (e.target.dataset.wup) Work.upload([...e.target.files]);
});
page.addEventListener('click', async e => {
  const w = Work.current; if (!w) return;
  const c = e.target.closest('[data-copy]'); if (c) return copyText(c.dataset.copy);
  const act = e.target.closest('[data-wact]')?.dataset.wact;
  if (act === 'close') return Work.close();
  if (act === 'delete') {
    if (!confirm(`Delete work item "${w.title}" with all its notes, links, screenshots and files?`)) return;
    await api('DELETE', '/api/work/' + w.id); Work.close(); return Work.loadList();
  }
  if (act === 'note') { await Work.add({ kind: 'text', text: '' }); const ts = $$('#workBlocks textarea'); ts.at(-1)?.focus(); return; }
  if (act === 'link') { const u = prompt('Paste the link (URL)'); if (u && u.trim()) await Work.add({ kind: 'link', url: u.trim() }); return; }
  const mv = e.target.closest('[data-wmove]');
  if (mv) {
    await api('PUT', `/api/work/${w.id}/blocks/${mv.dataset.b}`, { dir: mv.dataset.wmove });
    const i = w.blocks.findIndex(b => b.id === mv.dataset.b), j = mv.dataset.wmove === 'up' ? i - 1 : i + 1;
    if (j >= 0 && j < w.blocks.length) [w.blocks[i], w.blocks[j]] = [w.blocks[j], w.blocks[i]];
    return Work.render();
  }
  const del = e.target.closest('[data-wdel]');
  if (del) {
    if (!confirm('Delete this block?')) return;
    await api('DELETE', `/api/work/${w.id}/blocks/${del.dataset.wdel}`);
    w.blocks = w.blocks.filter(b => b.id !== del.dataset.wdel); Work.render(); return Work.loadList();
  }
  const img = e.target.closest('[data-wimg]');
  if (img) { $('#lightboxImg').src = img.src; $('#lightbox').hidden = false; }
});
page.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); page.classList.add('dragover'); } });
page.addEventListener('dragleave', e => { if (e.target === page) page.classList.remove('dragover'); });
page.addEventListener('drop', e => {
  if (!e.dataTransfer.files.length) return;
  e.preventDefault(); page.classList.remove('dragover');
  Work.upload([...e.dataTransfer.files]);
});

// Paste: screenshots → image blocks, URLs → link cards, other text → a note.
document.addEventListener('paste', async e => {
  if (!Work.current || page.hidden || !$('#view-notes').classList.contains('active')) return;
  const items = [...(e.clipboardData?.items || [])];
  const imgs = items.filter(i => i.type.startsWith('image/')).map(i => i.getAsFile()).filter(Boolean);
  if (imgs.length) {
    e.preventDefault();
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    return Work.upload(imgs.map((f, i) => new File([f], `screenshot-${stamp}${i ? '-' + i : ''}.png`, { type: f.type })));
  }
  if (e.target.closest?.('textarea, input')) return; // typing into a note keeps normal paste
  const text = e.clipboardData?.getData('text/plain') || '';
  if (!text.trim()) return;
  e.preventDefault();
  const urls = text.match(/https?:\/\/[^\s<>"']+/g) || [];
  const rest = urls.reduce((t, u) => t.replace(u, ''), text).replace(/\s+/g, ' ').trim();
  if (urls.length && rest.length < 80) {
    for (const u of urls) await Work.add({ kind: 'link', url: u.replace(/[).,;]+$/, ''), title: urls.length === 1 ? rest : '' });
  } else {
    await Work.add({ kind: 'text', text });
  }
  $$('#workBlocks .wblock').pop()?.scrollIntoView({ block: 'nearest' });
});
