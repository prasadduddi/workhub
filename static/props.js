'use strict';
// Properties page: a tree of applications/environments; each node has
// instructions (auto-saved), files (text files editable in place) and
// screenshots (paste with Ctrl+V or upload).

const Props = {
  nodes: [], selected: (() => { try { return localStorage.getItem('propSel') || ''; } catch { return ''; } })(),
  open: new Set((() => { try { return JSON.parse(localStorage.getItem('propOpen') || '[]'); } catch { return []; } })()),
  hits: null, editing: null, saveTimer: null,

  async load() {
    this.nodes = (await api('GET', '/api/props').catch(() => [])) || [];
    const flag = 'propJsonMade:' + (S.settings.workspace || '');
    let made = false; try { made = localStorage.getItem(flag) === '1'; } catch { /* ignore */ }
    if (!made && !this.nodes.some(n => !n.parent_id && /^json schemas?$/i.test(n.name))) {
      try {
        const n = await api('POST', '/api/props', { name: 'JSON Schemas', text: 'Schemas and sample JSON. Drop files or whole folders here; open a .json file to Format, Check or Validate it against a schema in the same folder.', order: 999 });
        this.nodes.push({ ...n, files: [] });
      } catch { /* ignore */ }
    }
    try { localStorage.setItem(flag, '1'); } catch { /* ignore */ }
    this.render();
  },
  node(id) { return this.nodes.find(n => n.id === id); },
  kids(id) { return this.nodes.filter(n => (n.parent_id || '') === (id || '')).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)); },
  path(n) { const p = []; for (let x = n; x; x = this.node(x.parent_id)) p.unshift(x.name); return p.join(' › '); },
  persistOpen() { try { localStorage.setItem('propOpen', JSON.stringify([...this.open])); } catch { /* ignore */ } },

  render() {
    if (!this.node(this.selected) && this.kids('').length) this.selected = this.kids('')[0].id;
    // Tree (search keeps matching nodes and their parents visible).
    let show = null;
    if (this.hits) {
      show = new Set();
      for (const id of this.hits) for (let x = this.node(id); x; x = this.node(x.parent_id)) show.add(x.id);
    }
    const walk = (pid, d) => this.kids(pid).filter(n => !show || show.has(n.id)).map(n => {
      const kids = this.kids(n.id), open = show ? true : this.open.has(n.id);
      const files = n.files || [], shots = files.filter(f => f.image).length;
      return `<div class="tnode pnode ${n.id === this.selected ? 'sel' : ''} ${this.hits?.includes(n.id) ? 'hit' : ''}" draggable="true" data-pn="${n.id}" style="padding-left:${8 + d * 14}px">
          <span class="tw" data-ptog="${n.id}">${kids.length ? (open ? '▾' : '▸') : ''}</span>${d === 0 ? '📦' : '📁'} <span class="nm">${esc(n.name)}</span>
          <span class="n">${files.length - shots ? '📄' + (files.length - shots) : ''}${shots ? ' 🖼' + shots : ''}</span></div>` + (open ? walk(n.id, d + 1) : '');
    }).join('');
    $('#propTree').innerHTML = walk('', 0) || `<div class="empty">${this.hits ? 'Nothing matches.' : 'No applications yet.<br>Press <b>+ Application</b>.'}</div>`;
    this.renderDetail();
  },

  renderDetail() {
    const n = this.node(this.selected);
    const el = $('#propDetail');
    if (!n) { el.innerHTML = '<div class="empty">Select an application or environment on the left, or create one with <b>+ Application</b>.<br><br>Each one can hold instructions, files (properties, configs, scripts…) and screenshots.</div>'; return; }
    const files = (n.files || []).filter(f => !f.image), shots = (n.files || []).filter(f => f.image);
    el.innerHTML = `
      <div class="ghead"><h3>${esc(n.name)}</h3><span class="muted tiny">${esc(this.path(n))}</span><span class="spacer"></span>
        <button data-pa="child">+ Sub-node</button><button data-pa="rename">Rename</button><button data-pa="delete" class="danger">Delete</button></div>
      <div class="gsec"><h4>Instructions <span class="n" id="propSaved"></span></h4>
        <textarea id="propText" placeholder="Notes for this application or environment: how to deploy, restart order, contacts, gotchas…">${esc(n.text || '')}</textarea></div>
      <div class="gsec pdrop" data-drop="files"><h4>Files <span class="n">${files.length}</span><span class="spacer"></span>
        <label class="btnlike">Upload files…<input type="file" multiple hidden data-up="files"></label><button data-pa="newfile">New text file</button></h4>
        ${files.map(f => `<div class="grow pfile ${this.editing === f.id ? 'active' : ''}"><span class="link" data-pf="${f.id}">📄 ${esc(f.name)}</span>
          <span class="muted tiny">${fmtSize(f.size)} · ${fmtDateTime(f.added)}</span><span class="spacer"></span>
          ${f.text ? `<button class="icon" data-pf="${f.id}">${this.editing === f.id ? 'Close' : 'View / edit'}</button>` : ''}
          <a class="icon btnlike" href="/api/props/files/${f.id}?download=1">Download</a><button class="icon danger" data-pdel="${f.id}">Delete</button></div>
          ${this.editing === f.id ? `<div class="pedit"><div id="propEditor"></div><div class="row"><button class="primary" data-psave="${f.id}">Save</button>
            ${isJSONName(f.name) ? `<button data-pjson="format">Format</button><button data-pjson="check">Check</button>
              <select id="propSchema" title="Schema to validate against">${this.schemaChoices(f).map(s => `<option value="${s.id}">${esc(s.label)}</option>`).join('') || '<option value="">(no schema found)</option>'}</select>
              <button data-pjson="validate">Validate against schema</button>` : ''}
            <span class="muted tiny" id="propEditStatus">Ctrl+S saves</span></div><div id="propJsonOut" class="jsonout"></div></div>` : ''}`).join('')
          || '<div class="muted tiny">Drop files here, or Upload. Properties, YAML, XML, SQL, scripts… open in the editor.</div>'}
      </div>
      <div class="gsec pdrop" data-drop="shots"><h4>Screenshots <span class="n">${shots.length}</span><span class="spacer"></span>
        <label class="btnlike">Add images…<input type="file" accept="image/*" multiple hidden data-up="shots"></label></h4>
        <div class="shots">${shots.map(f => `<figure><img src="/api/props/files/${f.id}" data-pimg="${f.id}" alt="${esc(f.name)}" loading="lazy">
          <figcaption>${esc(f.name)} <span class="x" data-pdel="${f.id}" title="Delete">✕</span></figcaption></figure>`).join('')}</div>
        ${shots.length ? '' : '<div class="muted tiny">Press <b>Ctrl+V</b> here to paste a screenshot from the clipboard (e.g. after Win+Shift+S), or drop images.</div>'}
      </div>`;
    if (this.editing) this.mountEditor();
  },

  // Schemas offered for validating a JSON file: JSON files in this folder and
  // its parents whose name says "schema" (or any other JSON in the folder).
  schemaChoices(file) {
    const out = [];
    for (let n = this.node(this.selected), depth = 0; n; n = this.node(n.parent_id), depth++) {
      for (const f of n.files || []) {
        if (f.id === file.id || !isJSONName(f.name)) continue;
        const looksSchema = /schema/i.test(f.name);
        if (looksSchema || depth === 0) out.push({ id: f.id, label: (depth ? n.name + ' › ' : '') + f.name, score: looksSchema ? 0 : 1 });
      }
    }
    return out.sort((a, b) => a.score - b.score);
  },

  async jsonTool(kind) {
    const cm = this.cm, out = $('#propJsonOut');
    const parse = text => {
      try { return [JSON.parse(text), null]; } catch (err) {
        const m = /position (\d+)/.exec(err.message) || /column (\d+)/.exec(err.message);
        return [null, err.message, m ? +m[1] : null];
      }
    };
    const [data, err, pos] = parse(cm.getValue());
    if (err) {
      out.className = 'jsonout bad';
      out.textContent = '✗ Not valid JSON: ' + err;
      if (pos != null && /position/.test(err)) { const p = cm.posFromIndex(pos); cm.setCursor(p); cm.focus(); }
      return;
    }
    if (kind === 'format') { cm.setValue(JSON.stringify(data, null, 2) + '\n'); out.className = 'jsonout ok'; out.textContent = '✓ Formatted (press Save to keep it)'; return; }
    if (kind === 'check') { out.className = 'jsonout ok'; out.textContent = '✓ Valid JSON'; return; }
    const sid = $('#propSchema').value;
    if (!sid) { out.className = 'jsonout bad'; out.textContent = 'Add a schema file (e.g. order.schema.json) to this folder or a parent folder first.'; return; }
    try {
      const schemaText = await fetch('/api/props/files/' + sid).then(r => r.text());
      const [schema, serr] = parse(schemaText);
      if (serr) throw new Error('the schema itself is not valid JSON: ' + serr);
      const ver = String(schema.$schema || '');
      const lib = /2020-12/.test(ver) ? window.ajv2020 : /2019-09/.test(ver) ? window.ajv2019 : window.ajv7;
      const Ajv = lib.default || lib;
      const ajv = new Ajv({ allErrors: true, strict: false });
      // Other schemas in the same folder can be referenced by $id.
      for (const f of (this.node(this.selected).files || [])) {
        if (f.id === sid || f.id === this.editing || !isJSONName(f.name)) continue;
        try { const other = JSON.parse(await fetch('/api/props/files/' + f.id).then(r => r.text())); if (other.$id && other.$id !== schema.$id) ajv.addSchema(other); } catch { /* not a schema */ }
      }
      const validate = ajv.compile(schema);
      if (validate(data)) { out.className = 'jsonout ok'; out.textContent = '✓ Valid against ' + $('#propSchema').selectedOptions[0].text; return; }
      out.className = 'jsonout bad';
      out.innerHTML = `✗ ${validate.errors.length} problem(s) against ${esc($('#propSchema').selectedOptions[0].text)}:<br>` +
        validate.errors.slice(0, 50).map(e => `<code>${esc(e.instancePath || '(root)')}</code> ${esc(e.message)}${e.params && Object.keys(e.params).length ? ' <span class="muted">' + esc(JSON.stringify(e.params)) + '</span>' : ''}`).join('<br>');
    } catch (e2) { out.className = 'jsonout bad'; out.textContent = '✗ Could not validate: ' + e2.message; }
  },

  async mountEditor() {
    const n = this.node(this.selected), f = (n?.files || []).find(x => x.id === this.editing);
    if (!f) return;
    const text = await fetch('/api/props/files/' + f.id).then(r => r.text());
    const cm = makeEditor($('#propEditor'), { value: text, mode: modeOf(langForPath(f.name)) });
    cm.setSize(null, Math.min(520, Math.max(160, cm.lineCount() * 20 + 20)));
    cm.addKeyMap({ 'Ctrl-S': () => this.saveFile(f.id, cm), 'Cmd-S': () => this.saveFile(f.id, cm) });
    cm.on('change', () => ($('#propEditStatus').textContent = 'Unsaved changes — Ctrl+S or Save'));
    this.cm = cm;
  },

  async saveFile(id, cm = this.cm) {
    try {
      const r = await fetch('/api/props/files/' + id, { method: 'PUT', body: cm.getValue() });
      if (!r.ok) throw new Error((await r.json()).error);
      $('#propEditStatus').textContent = 'Saved ' + new Date().toLocaleTimeString();
      const at = await r.json(); const n = this.node(this.selected); const i = n.files.findIndex(x => x.id === id); if (i >= 0) n.files[i] = at;
    } catch (err) { toast('Save failed: ' + err.message, true); }
  },

  async upload(files, onlyImages) {
    const n = this.node(this.selected);
    if (!n) return toast('Select a node first', true);
    const fd = new FormData();
    let count = 0;
    for (const f of files) { if (onlyImages && !f.type.startsWith('image/')) continue; fd.append('file', f, f.name); count++; }
    if (!count) return;
    toast(`Adding ${count} file(s)…`);
    const r = await fetch(`/api/props/${n.id}/files`, { method: 'POST', body: fd });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return toast(d.error || 'Upload failed', true);
    toast(`Added ${d.length} file(s) to ${n.name}`);
    this.load();
  },

  // Upload dropped folders, keeping their structure as sub-nodes.
  async dropTree(entries, parentId) {
    const readAll = dir => new Promise(res => { const r = dir.createReader(), all = []; const next = () => r.readEntries(batch => { if (!batch.length) return res(all); all.push(...batch); next(); }, () => res(all)); next(); });
    const fileOf = fe => new Promise(res => fe.file(res, () => res(null)));
    let nodes = 0, files = 0;
    const put = async (list, pid) => {
      const fd = new FormData(); let n = 0;
      for (const fe of list.filter(x => x.isFile)) { const f = await fileOf(fe); if (f && !/^\./.test(f.name)) { fd.append('file', f, f.name); n++; } }
      if (n) { const r = await fetch(`/api/props/${pid}/files`, { method: 'POST', body: fd }); if (r.ok) files += n; else toast((await r.json()).error, true); }
      for (const de of list.filter(x => x.isDirectory && !/^\./.test(x.name))) {
        const existing = this.kids(pid).find(k => k.name.toLowerCase() === de.name.toLowerCase());
        const node = existing || await api('POST', '/api/props', { name: de.name, parent_id: pid, order: this.kids(pid).length });
        if (!existing) { this.nodes.push({ ...node, files: [] }); nodes++; }
        this.open.add(node.id);
        await put(await readAll(de), node.id);
      }
    };
    toast('Adding folder…');
    await put(entries, parentId);
    this.open.add(parentId); this.persistOpen();
    toast(`Added ${files} file(s)${nodes ? ` in ${nodes} new folder(s)` : ''}`);
    this.load();
  },

  async add(parentId) {
    const name = prompt(parentId ? 'Name of the sub-node (e.g. UAT, PROD, Batch)' : 'Application name');
    if (!name || !name.trim()) return;
    const n = await api('POST', '/api/props', { name: name.trim(), parent_id: parentId || '', order: this.kids(parentId).length });
    if (parentId) this.open.add(parentId), this.persistOpen();
    this.selected = n.id; this.store();
    await this.load();
  },
  store() { try { localStorage.setItem('propSel', this.selected); } catch { /* ignore */ } },

  saveText() {
    const n = this.node(this.selected); if (!n) return;
    n.text = $('#propText').value;
    clearTimeout(this.saveTimer);
    $('#propSaved').textContent = 'saving…';
    this.saveTimer = setTimeout(async () => {
      await api('POST', '/api/props', n).catch(err => toast(err.message, true));
      const el = $('#propSaved'); if (el) el.textContent = 'saved ' + new Date().toLocaleTimeString();
    }, 700);
  },
};

// ---- events ----
$('#propNewApp').onclick = () => Props.add('');
let propSearchTimer;
$('#propSearch').addEventListener('input', e => {
  clearTimeout(propSearchTimer);
  const q = e.target.value.trim();
  propSearchTimer = setTimeout(async () => {
    Props.hits = q ? await api('GET', '/api/props/search?q=' + encodeURIComponent(q)).catch(() => []) : null;
    Props.render();
  }, 300);
});
$('#propTree').addEventListener('click', e => {
  const tog = e.target.closest('[data-ptog]');
  if (tog && tog.textContent) { const id = tog.dataset.ptog; Props.open.has(id) ? Props.open.delete(id) : Props.open.add(id); Props.persistOpen(); return Props.render(); }
  const n = e.target.closest('[data-pn]'); if (!n) return;
  Props.selected = n.dataset.pn; Props.editing = null; Props.store();
  Props.open.add(n.dataset.pn); Props.persistOpen();
  Props.render();
});
// Drag a node onto another to move it there (or onto empty space for top level).
$('#propTree').addEventListener('dragstart', e => { const n = e.target.closest('[data-pn]'); if (n) e.dataTransfer.setData('text/x-prop', n.dataset.pn); });
$('#propTree').addEventListener('dragover', e => { if (e.dataTransfer.types.includes('text/x-prop')) e.preventDefault(); });
$('#propTree').addEventListener('drop', async e => {
  const id = e.dataTransfer.getData('text/x-prop'); if (!id) return;
  e.preventDefault();
  const target = e.target.closest('[data-pn]')?.dataset.pn || '';
  if (target === id) return;
  const n = Props.node(id);
  try { await api('POST', '/api/props', { ...n, parent_id: target, order: Props.kids(target).length }); if (target) Props.open.add(target); Props.load(); }
  catch (err) { toast(err.message, true); }
});
$('#propDetail').addEventListener('input', e => { if (e.target.id === 'propText') Props.saveText(); });
$('#propDetail').addEventListener('change', e => { const up = e.target.closest('[data-up]'); if (up) Props.upload(up.files, up.dataset.up === 'shots'); });
$('#propDetail').addEventListener('click', async e => {
  const n = Props.node(Props.selected);
  const a = e.target.closest('[data-pa]')?.dataset.pa;
  if (a === 'child') return Props.add(n.id);
  if (a === 'rename') { const v = prompt('Rename', n.name); if (v && v.trim()) { await api('POST', '/api/props', { ...n, name: v.trim() }); Props.load(); } return; }
  if (a === 'delete') {
    const sub = Props.nodes.filter(x => x.parent_id === n.id).length;
    if (!confirm(`Delete "${n.name}"${sub ? ' and everything under it' : ''}, including its files and screenshots?`)) return;
    await api('DELETE', '/api/props/' + n.id); Props.selected = n.parent_id || ''; Props.store(); return Props.load();
  }
  if (a === 'newfile') {
    const name = prompt('File name', 'application.properties'); if (!name) return;
    const fd = new FormData(); fd.append('file', new Blob(['# ' + name + '\n'], { type: 'text/plain' }), name);
    const r = await fetch(`/api/props/${n.id}/files`, { method: 'POST', body: fd }); const d = await r.json();
    await Props.load(); Props.editing = d[0]?.id; return Props.renderDetail();
  }
  const pf = e.target.closest('[data-pf]');
  if (pf) {
    const f = n.files.find(x => x.id === pf.dataset.pf);
    if (!f.text) return window.open('/api/props/files/' + f.id, '_blank');
    Props.editing = Props.editing === f.id ? null : f.id; return Props.renderDetail();
  }
  const ps = e.target.closest('[data-psave]'); if (ps) return Props.saveFile(ps.dataset.psave);
  const pj = e.target.closest('[data-pjson]'); if (pj) return Props.jsonTool(pj.dataset.pjson);
  const del = e.target.closest('[data-pdel]');
  if (del) {
    const f = n.files.find(x => x.id === del.dataset.pdel);
    if (!confirm(`Delete ${f.name}?`)) return;
    await api('DELETE', '/api/props/files/' + f.id); if (Props.editing === f.id) Props.editing = null; return Props.load();
  }
  const img = e.target.closest('[data-pimg]');
  if (img) { $('#lightboxImg').src = img.src; $('#lightbox').hidden = false; }
});
// Drop files / images onto the sections.
$('#propDetail').addEventListener('dragover', e => { const z = e.target.closest('.pdrop'); if (z && e.dataTransfer.types.includes('Files')) { e.preventDefault(); z.classList.add('dragover'); } });
$('#propDetail').addEventListener('dragleave', e => e.target.closest?.('.pdrop')?.classList.remove('dragover'));
$('#propDetail').addEventListener('drop', e => {
  const z = e.target.closest('.pdrop'); if (!z || !e.dataTransfer.files.length) return;
  e.preventDefault(); z.classList.remove('dragover');
  const entries = [...e.dataTransfer.items].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
  if (entries.some(x => x.isDirectory)) return Props.dropTree(entries, Props.selected);
  Props.upload(e.dataTransfer.files, z.dataset.drop === 'shots');
});
// Dropping a folder onto a tree node also works.
$('#propTree').addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
$('#propTree').addEventListener('drop', e => {
  if (!e.dataTransfer.files.length) return;
  e.preventDefault();
  const target = e.target.closest('[data-pn]')?.dataset.pn || Props.selected;
  if (!target) return toast('Create or select a node first', true);
  const entries = [...e.dataTransfer.items].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
  Props.selected = target; Props.store();
  if (entries.some(x => x.isDirectory)) return Props.dropTree(entries, target);
  Props.upload(e.dataTransfer.files, false);
}, true);
// Paste a screenshot (Win+Shift+S, PrtScn…) while on the Properties page.
document.addEventListener('paste', e => {
  if (!$('#view-props').classList.contains('active') || !Props.node(Props.selected)) return;
  if (e.target.closest?.('textarea, input, .CodeMirror')) return;
  const imgs = [...(e.clipboardData?.items || [])].filter(i => i.type.startsWith('image/')).map(i => i.getAsFile()).filter(Boolean);
  if (!imgs.length) return;
  e.preventDefault();
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  Props.upload(imgs.map((f, i) => new File([f], `screenshot-${stamp}${i ? '-' + i : ''}.png`, { type: f.type })), true);
});
$('#lightbox').onclick = () => ($('#lightbox').hidden = true);

function isJSONName(name) { return /\.(json|jsonc|schema|avsc|geojson)$/i.test(name); }
