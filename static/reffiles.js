'use strict';
// Folders page: a tree of plain folders and files kept for reference (JSON,
// YAML, properties, schemas…). They live as ordinary files in
// <data>/reference, so every WorkHub version (and Explorer) sees them.
// Saving over a file keeps the old copy; deleting moves it to
// reference-deleted. Nothing is ever erased.

const Ref = {
  items: [], root: '', sel: (() => { try { return localStorage.getItem('refSel') || ''; } catch { return ''; } })(),
  open: new Set((() => { try { return JSON.parse(localStorage.getItem('refOpen') || '[]'); } catch { return []; } })()),
  hits: null, cm: null, loaded: '', dirty: false,

  persist() { try { localStorage.setItem('refSel', this.sel); localStorage.setItem('refOpen', JSON.stringify([...this.open])); } catch { /* ignore */ } },
  item(p) { return this.items.find(i => i.path === p); },
  isDir(p) { return p === '' || !!this.item(p)?.dir; },
  parent(p) { return p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''; },
  base(p) { return p.split('/').pop(); },
  kids(p) {
    return this.items.filter(i => this.parent(i.path) === p)
      .sort((a, b) => (b.dir - a.dir) || a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }));
  },
  icon(i) {
    if (i.missing) return '⚠';
    if (i.link) return i.dir ? '🔗📁' : '🔗📄';
    if (i.dir) return this.open.has(i.path) ? '📂' : '📁';
    const x = i.path.split('.').pop().toLowerCase();
    return /^(json|jsonc|avsc)$/.test(x) ? '🧾' : /^(ya?ml)$/.test(x) ? '📘' : /^(properties|ini|conf|cfg|env|toml)$/.test(x) ? '⚙' : /^(png|jpe?g|gif|bmp|webp|svg)$/.test(x) ? '🖼' : /^(sql|sh|ps1|bat|cmd|py|groovy)$/.test(x) ? '📜' : '📄';
  },
  isImage: p => /\.(png|jpe?g|gif|bmp|webp|svg)$/i.test(p),
  isText: p => !/\.(png|jpe?g|gif|bmp|webp|zip|gz|tgz|jar|war|ear|exe|dll|so|class|pdf|docx?|xlsx?|pptx?|msi|7z|rar|jks|p12|pfx|keystore|ico)$/i.test(p),
  url: (p, dl) => '/api/ref/file?path=' + encodeURIComponent(p) + (dl ? '&download=1' : ''),

  async load() {
    try { const r = await api('GET', '/api/ref'); this.items = r.items || []; this.root = r.root || ''; }
    catch (err) { toast(err.message, true); }
    if (this.sel && !this.item(this.sel)) this.sel = '';
    this.render();
  },

  render() {
    let show = null;
    if (this.hits) { show = new Set(); for (const h of this.hits) for (let p = h; p; p = this.parent(p)) show.add(p); }
    const walk = (p, d) => this.kids(p).filter(i => !show || show.has(i.path)).map(i => {
      const open = i.dir && (show ? true : this.open.has(i.path)), n = i.dir ? this.items.filter(x => !x.dir && x.path.startsWith(i.path + '/')).length : 0;
      return `<div class="tnode rnode ${i.dir ? 'folder' : 'item'} ${i.path === this.sel ? 'sel' : ''} ${this.hits?.includes(i.path) ? 'hit' : ''}" draggable="true" data-rp="${esc(i.path)}" style="padding-left:${8 + d * 14}px" title="${esc(i.missing ? 'Not found: ' + i.link : i.link ? 'Linked to ' + i.link : i.path)}">
        <span class="tw">${i.dir ? (open ? '▾' : '▸') : ''}</span>${this.icon(i)} <span class="nm ${i.linked ? 'linked' : ''} ${i.missing ? 'missing' : ''}">${esc(this.base(i.path))}</span>${i.dir ? `<span class="n">${n || ''}</span>` : ''}${i.dir && !i.link && !i.linked ? '<button class="radd" data-radd title="Add a sub-folder, file or link to a path here">+</button>' : ''}</div>` + (open ? walk(i.path, d + 1) : '');
    }).join('');
    $('#refTree').innerHTML = walk('', 0) || `<div class="empty">${this.hits ? 'Nothing matches.' : 'No folders yet. Press <b>+</b>.'}</div>`;
    $('#refWhere').innerHTML = `Copies are kept as plain files in <a href="#" data-rreveal="">${esc(this.root)}</a> · <a href="#" data-rreveal="history">older copies</a> · <a href="#" data-rreveal="deleted">deleted items</a>`;
    this.renderDetail();
  },

  renderDetail() {
    if (this.sel && !this.item(this.sel)) this.sel = ''; // removed outside WorkHub
    const el = $('#refDetail'), p = this.sel;
    if (this.isDir(p)) {
      if (this.cm) { this.cm = null; this.loaded = ''; }
      const kids = this.kids(p), it = this.item(p) || {}, inside = it.linked;
      el.innerHTML = `<div class="ghead"><h3>${p ? this.icon({ ...it, dir: true }) + ' ' + esc(this.base(p)) : 'All folders'}</h3><span class="muted tiny">${esc(p)}</span><span class="spacer"></span>
          ${inside || it.link ? '' : `<button data-ra="folder">+ Folder</button><button data-ra="newfile">+ New file</button>
          <label class="btnlike">Upload files…<input type="file" multiple hidden data-rup></label>
          <button data-ra="link" title="Show a folder or file from anywhere on this PC here, without copying it">🔗 Link to a path…</button>`}
          <button data-ra="reveal" title="Open this folder in Explorer">Open in Explorer</button>
          ${!p || inside ? '' : it.link ? '<button data-ra="rename">Rename link</button><button data-ra="delete" class="danger" title="Removes only the link — your files stay where they are">Remove link</button>' : '<button data-ra="rename">Rename</button><button data-ra="delete" class="danger">Delete</button>'}</div>
        ${this.linkNote(it)}
        <div class="gsec rdrop">${kids.map(i => `<div class="grow rrow" data-rp="${esc(i.path)}">${this.icon(i)} <span class="link">${esc(this.base(i.path))}</span><span class="spacer"></span>
            <span class="muted tiny">${i.dir ? '' : fmtSize(i.size) + ' · '}${esc(fmtDateTime(i.mod))}</span></div>`).join('')
          || '<div class="muted tiny">Empty folder.</div>'}
          ${inside || it.link ? '' : '<div class="muted tiny" style="margin-top:10px">Drop files or whole folders here (or onto a folder on the left) to keep a copy. Files with the same name are kept side by side, never overwritten. To use files where they already are, use <b>🔗 Link to a path…</b> instead.</div>'}</div>`;
      return;
    }
    const it = this.item(p);
    if (it.missing) { el.innerHTML = `<div class="ghead"><h3>⚠ ${esc(this.base(p))}</h3><span class="spacer"></span><button data-ra="delete" class="danger">Remove link</button></div><div class="dberr">Can't find <b>${esc(it.link)}</b> from this PC (drive not connected, or moved?). The link is kept.</div>`; return; }
    const json = /\.(json|jsonc|avsc)$/i.test(p);
    el.innerHTML = `<div class="ghead"><h3>${this.icon(it)} ${esc(this.base(p))}</h3><span class="muted tiny">${esc(p)} · ${fmtSize(it.size)} · ${esc(fmtDateTime(it.mod))}</span><span class="spacer"></span>
        ${this.isText(p) ? '<button class="primary" data-ra="save" title="Ctrl+S">Save</button>' : ''}
        <button data-ra="openfile" title="Open it in its default program (Word, Excel, Notepad…)">↗ Open</button><a class="btnlike" href="${this.url(p, 1)}">Download</a><button data-ra="history">Older copies</button>
        <button data-ra="reveal">Open in Explorer</button>${it.linked ? '' : it.link ? '<button data-ra="rename">Rename link</button><button data-ra="delete" class="danger" title="Removes only the link — the file stays where it is">Remove link</button>' : '<button data-ra="rename">Rename</button><button data-ra="delete" class="danger">Delete</button>'}</div>
      ${this.linkNote(it)}
      ${json ? `<div class="row" style="margin-bottom:6px"><button data-rjson="format">Format</button><button data-rjson="check">Check JSON</button>
        <select id="refSchema" title="Schema to validate against">${this.schemas(p).map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('') || '<option value="">(no schema found)</option>'}</select>
        <button data-rjson="validate">Validate against schema</button></div><div id="refJsonOut" class="jsonout"></div>` : ''}
      <div id="refHist"></div>
      ${this.isImage(p) ? `<img class="refimg" src="${this.url(p)}&t=${Date.parse(it.mod) || 0}" alt="">`
        : this.isText(p) ? '<div id="refEditor" class="refeditor"></div><div class="muted tiny" id="refStatus">Ctrl+S saves · the previous version is kept under Older copies</div>'
          : '<div class="muted">This kind of file can\'t be shown here — use Download or Open in Explorer.</div>'}`;
    if (this.isText(p)) this.mountEditor(p);
  },

  // Where a linked item really lives.
  linkNote(it) {
    if (!it) return '';
    let link = it.link, p = it.path;
    if (!link && it.linked) for (let x = this.parent(p); x; x = this.parent(x)) { const l = this.item(x); if (l?.link) { link = l.link + p.slice(x.length).replace(/\//g, link?.includes('\\') || l.link.includes('\\') ? '\\' : '/'); break; } }
    return link ? `<div class="reflink">🔗 ${it.link ? 'Linked to' : 'Real file'}: <code>${esc(link)}</code> — not copied; ${it.dir ? 'shown live from there' : 'edits are saved there (older copies kept in WorkHub)'}</div>` : '';
  },

  async linkPath() {
    const d = $('#refLinkDlg'), at = this.folderOf(this.sel);
    if (this.item(at)?.linked || this.item(at)?.link) return toast('Links go in your own folders — pick a folder that is not linked first', true);
    $('#refLinkWhere').textContent = at || 'the top level';
    $('#refLinkPath').value = ''; $('#refLinkName').value = ''; d.returnValue = ''; d.showModal();
    d.onclose = async () => {
      if (d.returnValue !== 'ok' || !$('#refLinkPath').value.trim()) return;
      try {
        const r = await api('POST', '/api/ref/link', { dir: at, name: $('#refLinkName').value.trim(), target: $('#refLinkPath').value.trim() });
        if (at) this.open.add(at);
        this.sel = r.path; this.persist(); await this.load(); toast('Linked ' + r.target);
      } catch (err) { toast(err.message, true); }
    };
  },

  async mountEditor(p) {
    const host = $('#refEditor');
    this.cm = makeEditor(host, { mode: modeOf(langForPath(p)), value: '' });
    this.cm.setSize(null, '100%');
    const text = await fetch(this.url(p)).then(r => r.ok ? r.text() : Promise.reject(new Error('could not read file'))).catch(err => (toast(err.message, true), ''));
    if (this.sel !== p) return;
    this.cm.setValue(text); this.cm.clearHistory(); this.loaded = p; this.dirty = false;
    this.cm.on('change', () => { this.dirty = true; $('#refStatus') && ($('#refStatus').textContent = '● Unsaved changes — Ctrl+S saves'); });
    this.cm.setOption('extraKeys', { ...this.cm.getOption('extraKeys'), 'Ctrl-S': () => this.save(), 'Cmd-S': () => this.save() });
  },

  async save() {
    if (!this.cm || !this.loaded) return;
    const p = this.loaded;
    const r = await fetch('/api/ref/file?path=' + encodeURIComponent(p), { method: 'PUT', body: this.cm.getValue() });
    if (!r.ok) return toast((await r.json().catch(() => ({}))).error || 'Save failed', true);
    this.dirty = false; toast('Saved ' + this.base(p));
    const st = $('#refStatus'); if (st) st.textContent = '✓ Saved ' + new Date().toLocaleTimeString() + ' · the previous version is kept under Older copies';
    const it = this.item(p); if (it) { it.size = new Blob([this.cm.getValue()]).size; it.mod = new Date().toISOString(); }
  },

  async okToLeave() { return !this.dirty || await askYes(`${this.base(this.loaded)} has unsaved changes. Discard them?`); },

  async select(p) {
    if (p === this.sel) return;
    if (!await this.okToLeave()) return;
    this.dirty = false; this.sel = p; this.persist(); this.render();
  },

  // JSON schemas offered for a file: files named *schema*.json anywhere,
  // nearest folders first.
  schemas(p) {
    const dir = this.parent(p);
    return this.items.filter(i => !i.dir && i.path !== p && /\.(json|avsc)$/i.test(i.path) && (/schema/i.test(this.base(i.path)) || this.parent(i.path) === dir))
      .sort((a, b) => (!/schema/i.test(a.path) - !/schema/i.test(b.path)) || (this.parent(b.path) === dir) - (this.parent(a.path) === dir) || a.path.localeCompare(b.path))
      .map(i => i.path);
  },

  async jsonTool(kind) {
    const cm = this.cm, out = $('#refJsonOut');
    let data;
    try { data = JSON.parse(cm.getValue()); } catch (err) {
      out.className = 'jsonout bad'; out.textContent = '✗ Not valid JSON: ' + err.message;
      const m = /position (\d+)/.exec(err.message); if (m) { cm.setCursor(cm.posFromIndex(+m[1])); cm.focus(); }
      return;
    }
    if (kind === 'format') { cm.setValue(JSON.stringify(data, null, 2) + '\n'); out.className = 'jsonout ok'; out.textContent = '✓ Formatted — press Save to keep it'; return; }
    if (kind === 'check') { out.className = 'jsonout ok'; out.textContent = '✓ Valid JSON'; return; }
    const sp = $('#refSchema').value;
    if (!sp) { out.className = 'jsonout bad'; out.textContent = 'Add a schema file (e.g. order.schema.json) to this folder first.'; return; }
    try {
      const schema = JSON.parse(await fetch(this.url(sp)).then(r => r.text()));
      const ver = String(schema.$schema || '');
      const lib = /2020-12/.test(ver) ? window.ajv2020 : /2019-09/.test(ver) ? window.ajv2019 : window.ajv7;
      const ajv = new (lib.default || lib)({ allErrors: true, strict: false });
      for (const other of this.schemas(this.loaded)) { // schemas next to it can be referenced by $id
        if (other === sp) continue;
        try { const o = JSON.parse(await fetch(this.url(other)).then(r => r.text())); if (o.$id && o.$id !== schema.$id) ajv.addSchema(o); } catch { /* not a schema */ }
      }
      const validate = ajv.compile(schema);
      if (validate(data)) { out.className = 'jsonout ok'; out.textContent = '✓ Valid against ' + sp; return; }
      out.className = 'jsonout bad';
      out.innerHTML = `✗ ${validate.errors.length} problem(s) against ${esc(sp)}:<br>` + validate.errors.slice(0, 50).map(e => `<code>${esc(e.instancePath || '(root)')}</code> ${esc(e.message)}`).join('<br>');
    } catch (err) { out.className = 'jsonout bad'; out.textContent = '✗ Could not validate: ' + err.message; }
  },

  folderOf(p) { return this.isDir(p) ? p : this.parent(p); },
  join: (dir, name) => (dir ? dir + '/' : '') + name,

  async newFolder() {
    const at = this.folderOf(this.sel);
    const name = await askText(`New folder ${at ? 'inside ' + at : 'at the top level'}:`, ''); if (!name?.trim()) return;
    try {
      const r = await api('POST', '/api/ref/folder', { path: this.join(at, name.trim()) });
      if (at) this.open.add(at);
      this.sel = r.path; this.persist(); await this.load();
    } catch (err) { toast(err.message, true); }
  },

  async newFile() {
    const at = this.folderOf(this.sel);
    const name = await askText(`New file in ${at || 'the top level'} (e.g. app.properties, config.yaml, sample.json):`, ''); if (!name?.trim()) return;
    const r = await fetch('/api/ref/file?new=1&path=' + encodeURIComponent(this.join(at, name.trim())), { method: 'PUT', body: '' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return toast(j.error || 'Could not create the file', true);
    if (at) this.open.add(at);
    this.sel = j.path; this.persist(); await this.load();
  },

  async uploadFiles(files, dir) {
    let n = 0;
    for (const { file, rel } of files) {
      const r = await fetch('/api/ref/file?new=1&path=' + encodeURIComponent(this.join(dir, rel)), { method: 'PUT', body: file });
      if (r.ok) n++; else toast(`${rel}: ${(await r.json().catch(() => ({}))).error || 'failed'}`, true);
    }
    if (dir) this.open.add(dir);
    this.persist(); await this.load();
    toast(`Added ${n} file(s) to ${dir || 'the top level'}`);
  },

  // Dropped files and folders (with their sub-folders) from Explorer.
  async dropped(dt, dir) {
    const entries = [...dt.items].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
    if (!entries.length) return this.uploadFiles([...dt.files].map(f => ({ file: f, rel: f.name })), dir);
    const readAll = d => new Promise(res => { const r = d.createReader(), all = []; const next = () => r.readEntries(b => { if (!b.length) return res(all); all.push(...b); next(); }, () => res(all)); next(); });
    const fileOf = fe => new Promise(res => fe.file(res, () => res(null)));
    const out = [];
    const walk = async (list, prefix) => {
      for (const e of list) {
        if (/^\./.test(e.name)) continue;
        if (e.isFile) { const f = await fileOf(e); if (f) out.push({ file: f, rel: prefix + e.name }); }
        else if (e.isDirectory) {
          const sub = await readAll(e);
          if (!sub.length) await api('POST', '/api/ref/folder', { path: this.join(dir, prefix + e.name) }).catch(() => {});
          await walk(sub, prefix + e.name + '/');
        }
      }
    };
    await walk(entries, '');
    await this.uploadFiles(out, dir);
  },

  async rename() {
    const p = this.sel; if (!p) return;
    const name = await askText('New name:', this.base(p)); if (!name?.trim() || name.trim() === this.base(p)) return;
    await this.moveTo(p, this.join(this.parent(p), name.trim()));
  },

  async moveTo(from, to) {
    if (from === this.loaded && !await this.okToLeave()) return;
    try {
      const r = await api('POST', '/api/ref/move', { from, to });
      const wasOpen = [...this.open].filter(o => o === from || o.startsWith(from + '/'));
      wasOpen.forEach(o => { this.open.delete(o); this.open.add(r.path + o.slice(from.length)); });
      this.dirty = false; this.loaded = ''; this.sel = r.path; this.open.add(this.parent(r.path)); this.persist(); await this.load();
    } catch (err) { toast(err.message, true); }
  },

  async remove() {
    const p = this.sel; if (!p) return;
    const isDir = this.isDir(p), it = this.item(p);
    if (it?.link) {
      if (!await askYes(`Remove the link "${this.base(p)}"?\n\nOnly the link is removed — ${it.link} and its files are not touched.`)) return;
      try { await api('DELETE', '/api/ref/file?path=' + encodeURIComponent(p)); this.dirty = false; this.loaded = ''; this.sel = this.parent(p); this.persist(); await this.load(); toast('Link removed'); }
      catch (err) { toast(err.message, true); }
      return;
    }
    if (!await askYes(`Delete ${isDir ? 'the folder' : ''} "${p}"${isDir ? ' and everything in it' : ''}?\n\nIt is moved to "reference-deleted" in your data folder, so it can still be recovered.`)) return;
    try { await api('DELETE', '/api/ref/file?path=' + encodeURIComponent(p)); this.dirty = false; this.loaded = ''; this.sel = this.parent(p); this.persist(); await this.load(); toast('Deleted (kept in reference-deleted)'); }
    catch (err) { toast(err.message, true); }
  },

  async history() {
    const p = this.sel, box = $('#refHist');
    if (box.innerHTML) { box.innerHTML = ''; return; }
    const vers = await api('GET', '/api/ref/history?path=' + encodeURIComponent(p)).catch(() => []);
    box.innerHTML = `<div class="gsec"><h4>Older copies <span class="n">${vers.length}</span></h4>${vers.map(v => `<div class="grow"><span>${esc(fmtDateTime(v.mod))}</span><span class="muted tiny">${fmtSize(v.size)}</span><span class="spacer"></span>
        <a class="icon btnlike" href="/api/ref/history?path=${encodeURIComponent(p)}&v=${encodeURIComponent(v.name)}" target="_blank">View</a>
        ${this.isText(p) ? `<button class="icon" data-rrestore="${esc(v.name)}" title="Put this version in the editor (then Save)">Use this version</button>` : ''}</div>`).join('')
      || '<div class="muted tiny">No older copies yet — one is kept every time you save over this file.</div>'}</div>`;
  },

  async restore(v) {
    const text = await fetch(`/api/ref/history?path=${encodeURIComponent(this.sel)}&v=${encodeURIComponent(v)}`).then(r => r.text());
    this.cm.setValue(text); toast('Older version loaded — press Save to keep it');
  },

  async search(q) {
    this.hits = q ? await api('GET', '/api/ref/search?q=' + encodeURIComponent(q)).catch(() => []) : null;
    this.render();
  },
};

$('#refNewFolder').onclick = () => Ref.newFolder();
$('#refLinkFolderBtn').onclick = async () => { const r = await api('POST', '/api/local/pick', { key: 'ref-link-folder', start: $('#refLinkPath').value.trim() }).catch(err => (toast(err.message, true), {})); if (r.ok) $('#refLinkPath').value = r.path; };
$('#refLinkFileBtn').onclick = async () => { const r = await api('POST', '/api/local/pickfile', { key: 'ref-link-file' }).catch(err => (toast(err.message, true), {})); if (r.ok) $('#refLinkPath').value = r.path; };
let refSearchTimer;
$('#refSearch').addEventListener('input', e => { clearTimeout(refSearchTimer); refSearchTimer = setTimeout(() => Ref.search(e.target.value.trim()), 250); });
$('#refTree').addEventListener('click', async e => {
  const n = e.target.closest('[data-rp]'); if (!n) return;
  const p = n.dataset.rp;
  if (e.target.closest('[data-radd]')) { // the + on a folder: add inside it
    e.stopPropagation();
    const r = e.target.getBoundingClientRect();
    if (p !== Ref.sel) { if (!await Ref.okToLeave()) return; Ref.dirty = false; Ref.sel = p; }
    Ref.open.add(p); Ref.persist(); Ref.render();
    return setTimeout(() => Tree.showMenu({ clientX: r.left, clientY: r.bottom }, [
      ['📁 New sub-folder…', () => Ref.newFolder()], ['📄 New file…', () => Ref.newFile()],
      ['🔗 Link to a folder or file path…', () => Ref.linkPath()]]));
  }
  if (Ref.isDir(p) && (e.target.closest('.tw') || p === Ref.sel)) { Ref.open.has(p) ? Ref.open.delete(p) : Ref.open.add(p); Ref.persist(); return Ref.render(); }
  if (Ref.isDir(p)) Ref.open.add(p);
  Ref.select(p);
});
// Ctrl+click a second file or folder: compare it with the selected one.
$('#refTree').addEventListener('click', e => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const n = e.target.closest('[data-rp]'); if (!n) return;
  const first = Compare.pick || Ref.sel, second = n.dataset.rp;
  if (!first || first === second) return;
  e.stopImmediatePropagation(); e.preventDefault();
  Compare.pick = null;
  Compare.open(Compare.ref(first), Compare.ref(second));
}, true);
$('#refCompare').onclick = () => Compare.chooser(Compare.pick || Ref.sel || '');
$('#refTree').addEventListener('contextmenu', e => {
  const n = e.target.closest('[data-rp]'); e.preventDefault();
  if (n) Ref.select(n.dataset.rp);
  const it = n && Ref.item(n.dataset.rp);
  const openIt = it && !it.dir && !it.missing ? [['↗ Open (in its default program)', () => api('POST', '/api/ref/open', { path: it.path }).then(r => toast('Opening ' + r.path.split(/[\\/]/).pop())).catch(err => toast(err.message, true))], '-'] : [];
  const items = it?.linked ? [...openIt, ['Open in Explorer', () => api('POST', '/api/ref/reveal', { path: Ref.sel })]]
    : [...openIt, ['+ New folder here', () => Ref.newFolder()], ['+ New file here', () => Ref.newFile()], ['🔗 Link to a path here…', () => Ref.linkPath()], ['Open in Explorer', () => api('POST', '/api/ref/reveal', { path: Ref.sel })]];
  if (it && !it.missing) {
    const pk = Compare.pick, label = p => p.split('/').pop();
    items.push('-');
    if (pk && pk !== it.path) items.push([`⇆ Compare with “${label(pk)}”`, () => { Compare.pick = null; Compare.open(Compare.ref(pk), Compare.ref(it.path)); }]);
    items.push(['⇆ Select for compare', () => { Compare.pick = it.path; toast(`“${label(it.path)}” selected — right-click another ${it.dir ? 'folder' : 'file'} → Compare with…, or Ctrl+click it`); }],
      [`⇆ Compare with a ${it.dir ? 'folder' : 'file'} on this PC…`, async () => {
        const r = await api('POST', it.dir ? '/api/local/pick' : '/api/local/pickfile', { key: it.dir ? 'ref-compare-folder' : 'ref-compare-file' }).catch(err => (toast(err.message, true), {}));
        if (r.ok) Compare.open(Compare.ref(it.path), Compare.local(r.path));
      }]);
  }
  if (it?.link) items.push('-', ['Rename link', () => Ref.rename()], ['Remove link (files stay)', () => Ref.remove()]);
  else if (n && !it?.linked) items.push('-', ['Rename', () => Ref.rename()], ['Delete', () => Ref.remove()]);
  Tree.showMenu(e, items);
});
$('#refDetail').addEventListener('click', e => {
  const row = e.target.closest('.rrow'); if (row) { const p = row.dataset.rp; Ref.open.add(Ref.parent(p)); if (Ref.isDir(p)) Ref.open.add(p); return Ref.select(p); }
  const j = e.target.closest('[data-rjson]'); if (j) return Ref.jsonTool(j.dataset.rjson);
  const rs = e.target.closest('[data-rrestore]'); if (rs) return Ref.restore(rs.dataset.rrestore);
  const a = e.target.closest('[data-ra]')?.dataset.ra; if (!a) return;
  ({ openfile: () => api('POST', '/api/ref/open', { path: Ref.sel }).then(r => toast('Opening ' + r.path.split(/[\\/]/).pop())).catch(err => toast(err.message, true)), link: () => Ref.linkPath(), folder: () => Ref.newFolder(), newfile: () => Ref.newFile(), save: () => Ref.save(), rename: () => Ref.rename(), delete: () => Ref.remove(),
    history: () => Ref.history(), reveal: () => api('POST', '/api/ref/reveal', { path: Ref.sel }) })[a]?.();
});
$('#refDetail').addEventListener('change', e => {
  if (!e.target.matches('[data-rup]')) return;
  Ref.uploadFiles([...e.target.files].map(f => ({ file: f, rel: f.name })), Ref.folderOf(Ref.sel)); e.target.value = '';
});
$('#refWhere').addEventListener('click', e => { const a = e.target.closest('[data-rreveal]'); if (a) { e.preventDefault(); api('POST', '/api/ref/reveal', { where: a.dataset.rreveal }); } });

// Drag and drop: files from Explorer upload into the folder they're dropped
// on; tree items dragged onto a folder move there.
for (const zone of [$('#refTree'), $('#refDetail')]) {
  zone.addEventListener('dragover', e => {
    e.preventDefault();
    $$('.rnode.drop').forEach(x => x.classList.remove('drop'));
    e.target.closest('.rnode.folder')?.classList.add('drop');
  });
  zone.addEventListener('dragleave', e => e.target.closest?.('.rnode.folder')?.classList.remove('drop'));
  zone.addEventListener('drop', async e => {
    e.preventDefault();
    $$('.rnode.drop').forEach(x => x.classList.remove('drop'));
    const target = e.target.closest('.rnode.folder')?.dataset.rp ?? (zone.id === 'refDetail' ? Ref.folderOf(Ref.sel) : '');
    const moving = e.dataTransfer.getData('text/x-ref');
    if (moving) { if (Ref.parent(moving) !== target) await Ref.moveTo(moving, Ref.join(target, Ref.base(moving))); return; }
    if (Ref.item(target)?.linked || Ref.item(target)?.link) return toast('That is a linked folder — add files to it in Explorer', true);
    if (e.dataTransfer.files.length) Ref.dropped(e.dataTransfer, target);
  });
}
$('#refTree').addEventListener('dragstart', e => { const n = e.target.closest('[data-rp]'); if (n) e.dataTransfer.setData('text/x-ref', n.dataset.rp); });
window.addEventListener('beforeunload', e => { if (Ref.dirty) { e.preventDefault(); e.returnValue = ''; } });
