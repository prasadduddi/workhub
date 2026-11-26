'use strict';
// ⇆ Compare — Beyond Compare-style, on the Folders page. Pick any two files or
// folders (in Folders or anywhere on this PC): files side by side with the
// changed lines and characters marked, folders as one tree marked same /
// different / only left / only right. Copy changes or files across and save.

const Compare = {
  pick: null,          // "Select for compare": the first side
  st: null,            // what is shown: { mode: 'file'|'dir', a, b, ... }

  // A side: { kind: 'ref'|'local', path, label }
  ref: p => ({ kind: 'ref', path: p, label: p }),
  local: p => ({ kind: 'local', path: p, label: p }),
  // a file on a server (read over SFTP, never written)
  remote: (e, p) => ({ kind: 'remote', id: e.id, path: p, label: `${e.name || e.host}: ${p}` }),
  creds: {}, // logins typed for servers without a saved password, per connection
  sep(s) { return s.kind === 'local' && s.path.includes('\\') ? '\\' : '/'; },
  child(s, rel) { return { kind: s.kind, path: s.path.replace(/[\\/]+$/, '') + this.sep(s) + rel.split('/').join(this.sep(s)), label: rel }; },

  async stat(s) { return s.kind === 'remote' ? { dir: false } : api('POST', '/api/compare/stat', s); },

  // Read a side as text: { text, eol, binary }.
  async read(s) {
    if (s.kind === 'remote') {
      const e = byId(s.id); if (!e) throw new Error('That server is no longer in WorkHub');
      if (needsCreds(e) && !this.creds[e.id]) { const c = await askCreds(e); if (!c) throw new Error('No login for ' + e.host); this.creds[e.id] = c; }
      const d = await api('POST', '/api/compare/remote', { id: e.id, path: s.path, ...(this.creds[e.id] || {}) });
      if (d.binary) return { binary: true, size: d.size };
      s.label = `${e.name || e.host}: ${d.path}`;
      return { text: d.text, eol: /\r\n/.test(d.text) ? '\r\n' : '\n' };
    }
    if (s.kind === 'ref') {
      const r = await fetch('/api/ref/file?path=' + encodeURIComponent(s.path));
      if (!r.ok) throw new Error(`Can't read ${s.label}`);
      const buf = new Uint8Array(await r.arrayBuffer());
      if (buf.includes(0)) return { binary: true, size: buf.length };
      const text = new TextDecoder().decode(buf);
      return { text, eol: /\r\n/.test(text) ? '\r\n' : '\n' };
    }
    try {
      const d = await api('GET', '/api/file?path=' + encodeURIComponent(s.path));
      return { text: d.content, eol: /\r\n/.test(d.content) ? '\r\n' : '\n' };
    } catch (err) { if (/binary/i.test(err.message)) return { binary: true }; throw err; }
  },
  async write(s, text) {
    if (s.kind === 'remote') throw new Error('Files on servers are only read here — nothing is changed on the server');
    if (s.kind === 'ref') {
      const r = await fetch('/api/ref/file?path=' + encodeURIComponent(s.path), { method: 'PUT', body: text });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Save failed');
    } else await api('PUT', '/api/file', { path: s.path, content: text });
  },

  // ---- entry points ----
  async open(a, b) {
    try {
      const [sa, sb] = await Promise.all([this.stat(a), this.stat(b)]);
      if (sa.dir !== sb.dir) return toast('Compare a file with a file, or a folder with a folder', true);
      this.dlg();
      if (sa.dir) { this.st = { mode: 'dir', a, b, filter: 'diff' }; await this.loadDirs(); }
      else await this.openFiles(a, b);
    } catch (err) { toast(err.message, true); }
  },
  // The ⇆ Compare button: choose both sides — Folders paths, anywhere on this
  // PC, or 🖥 a file on a server.
  chooser(left = '', modes) {
    const d = this.dlg();
    this.modes = modes || [{ kind: 'path', value: left }, { kind: 'path', value: '' }];
    const opts = (typeof Ref !== 'undefined' ? Ref.items : []).map(i => `<option value="${esc(i.path)}">`).join('');
    const servers = S.entries.filter(e => e.host && canSSH(e)).sort((x, y) => (x.name || x.host).localeCompare(y.name || y.host));
    const row = (m, i) => m.kind === 'server'
      ? `<div class="cmp-side"><b>${i ? 'Right' : 'Left'}</b><select class="cmp-srv" data-side="${i}"><option value="">— server —</option>${servers.map(e => `<option value="${e.id}" ${e.id === m.id ? 'selected' : ''}>${esc((e.env ? e.env + ' · ' : '') + (e.name || e.host))}</option>`).join('')}</select>
          <input class="cmp-rpath" data-side="${i}" value="${esc(m.path || '')}" placeholder="/opt/app/config/application.properties"><button data-cmode="path" data-side="${i}" title="Use a Folders path or a file on this PC instead">📁 Folders / PC…</button></div>`
      : `<div class="cmp-side"><b>${i ? 'Right' : 'Left'}</b><input class="cmp-in" data-side="${i}" list="cmpPaths" value="${esc(m.value || '')}" placeholder="${i ? 'e.g. UAT/app.properties' : 'e.g. DEV/app.properties'}">
          <button data-cpc="file" data-side="${i}" title="Pick a file on this PC">📄 PC file…</button><button data-cpc="folder" data-side="${i}" title="Pick a folder on this PC">📁 PC folder…</button><button data-cmode="server" data-side="${i}" title="A file on a server (read over SFTP, never changed)">🖥 Server file…</button></div>`;
    $('.cmp-body', d).innerHTML = `<div class="cmp-choose">
      <p class="muted tiny">A path from Folders (start typing to pick), a full path on this PC (C:\\…), or 🖥 a file on a server — e.g. the same config file on UAT and PROD. Servers are only read, never changed.</p>
      ${this.modes.map(row).join('')}
      <datalist id="cmpPaths">${opts}</datalist>
      <div class="cmp-row"><span class="spacer"></span><button class="primary" data-cgo>⇆ Compare</button></div></div>`;
    $('.cmp-title', d).textContent = '⇆ Compare';
    $('.cmp-tools', d).innerHTML = '';
    // typing a path on one server fills the same path on the other (still editable)
    $$('.cmp-rpath', d).forEach(inp => inp.addEventListener('input', () => {
      const other = $$('.cmp-rpath', d).find(x => x !== inp);
      if (other && (!other.value || other.dataset.synced === '1')) { other.value = inp.value; other.dataset.synced = '1'; }
    }));
    setTimeout(() => ($$('.cmp-in, .cmp-rpath', d)[left ? 1 : 0] || $('.cmp-srv', d))?.focus());
  },
  // right-click a server → compare one of its files with another server
  chooserRemote(e) { this.chooser('', [{ kind: 'server', id: e.id, path: '' }, { kind: 'server', id: '', path: '' }]); },
  readChooser() {
    const d = this.dlg();
    return this.modes.map((m, i) => {
      if (m.kind === 'server') {
        const e = byId($(`.cmp-srv[data-side="${i}"]`, d).value), p = $(`.cmp-rpath[data-side="${i}"]`, d).value.trim();
        return e && p ? this.remote(e, p) : null;
      }
      const v = $(`.cmp-in[data-side="${i}"]`, d).value.trim();
      return v ? this.sideFrom(v) : null;
    });
  },
  sideFrom(v) { v = v.trim(); return /^([a-zA-Z]:[\\/]|\\\\|\/|~)/.test(v) ? this.local(v) : this.ref(v.replace(/^\/+/, '')); },

  dlg() {
    let d = $('#cmpDlg');
    if (d) { if (!d.open) d.showModal(); return d; }
    d = Object.assign(document.createElement('dialog'), { id: 'cmpDlg', className: 'cmpdlg' });
    d.innerHTML = `<div class="cmp-head"><b class="cmp-title">⇆ Compare</b><div class="cmp-tools"></div><span class="spacer"></span><button class="icon" data-cclose title="Close (Esc)">✕</button></div><div class="cmp-body"></div>`;
    document.body.append(d);
    d.addEventListener('click', e => this.click(e));
    d.addEventListener('dblclick', e => this.dbl(e));
    d.addEventListener('change', e => this.change(e));
    d.addEventListener('keydown', e => {
      if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); this.jump(e.key === 'ArrowDown' ? 1 : -1); }
      if (e.key === 'Enter' && (e.target.classList.contains('cmp-in') || e.target.classList.contains('cmp-rpath'))) $('[data-cgo]', d)?.click();
    });
    d.addEventListener('cancel', async e => { e.preventDefault(); if (await this.okToClose()) d.close(); });
    d.showModal();
    return d;
  },
  async okToClose() { const f = this.st?.file; return !f || !(f.dirtyA || f.dirtyB) || await askYes('Close without saving your changes?'); },

  // ---- file compare ----
  async openFiles(a, b, back) {
    const d = this.dlg();
    $('.cmp-body', d).innerHTML = '<div class="empty">Reading…</div>';
    const [ra, rb] = await Promise.all([this.read(a), this.read(b)]);
    if (ra.binary || rb.binary) {
      const same = ra.binary && rb.binary && ra.size === rb.size;
      $('.cmp-body', d).innerHTML = `<div class="empty">${esc(a.label)} / ${esc(b.label)}: binary files — ${same ? 'same size' : 'they differ'}. Only text files are compared line by line.</div>`;
      return;
    }
    const prev = this.st?.mode === 'dir' ? this.st : back;
    this.st = { mode: 'file', a, b, back: prev, opts: this.st?.opts || this.opts(),
      file: { A: ra.text.replace(/\r\n/g, '\n').split('\n'), B: rb.text.replace(/\r\n/g, '\n').split('\n'), eolA: ra.eol, eolB: rb.eol, dirtyA: false, dirtyB: false, cur: -1 } };
    this.diffFiles();
  },
  opts() { const d = { ws: false, cs: false, only: false, mask: true }; try { return { ...d, ...JSON.parse(localStorage.getItem('cmpOpts')) }; } catch { return d; } },
  saveOpts() { try { localStorage.setItem('cmpOpts', JSON.stringify(this.st.opts)); } catch { /* ignore */ } },

  diffFiles() {
    const { file: f, opts: o } = this.st;
    const key = s => { let x = s; if (o.ws) x = x.replace(/\s+/g, ' ').trim(); if (o.cs) x = x.toLowerCase(); return x; };
    const ops = diffLines(f.A.map(key), f.B.map(key));
    // rows: pair deletions with insertions as "changed" lines
    const rows = [];
    for (let i = 0; i < ops.length;) {
      if (ops[i].t === '=') { rows.push({ t: 'same', a: ops[i].a, b: ops[i].b }); i++; continue; }
      const dels = [], ins = [];
      while (i < ops.length && ops[i].t !== '=') { (ops[i].t === '-' ? dels : ins).push(ops[i]); i++; }
      for (let k = 0; k < Math.max(dels.length, ins.length); k++) {
        const x = dels[k], y = ins[k];
        rows.push({ t: x && y ? 'chg' : x ? 'del' : 'ins', a: x ? x.a : null, b: y ? y.b : null });
      }
    }
    // blocks: runs of non-same rows
    const blocks = [];
    rows.forEach((r, i) => { if (r.t === 'same') return; const last = blocks.at(-1); if (last && last.end === i - 1) last.end = i; else blocks.push({ start: i, end: i }); r.blk = blocks.length - 1; });
    Object.assign(f, { rows, blocks });
    if (f.cur >= blocks.length) f.cur = blocks.length - 1;
    this.renderFiles();
  },

  renderFiles() {
    const d = this.dlg(), { a, b, file: f, opts: o, back } = this.st;
    $('.cmp-title', d).textContent = '⇆ Compare files';
    $('.cmp-tools', d).innerHTML = `${back ? '<button data-cact="back" title="Back to the folder compare">◀ Folders</button>' : ''}
      <button data-cact="prev" title="Previous difference (Alt+↑)">▲</button><button data-cact="next" title="Next difference (Alt+↓)">▼</button>
      <span class="cmp-count">${f.blocks.length ? `${f.cur >= 0 ? f.cur + 1 + ' / ' : ''}${f.blocks.length} difference${f.blocks.length > 1 ? 's' : ''}` : '✓ Same'}</span>
      <label title="Spaces and tabs don't count"><input type="checkbox" data-copt="ws" ${o.ws ? 'checked' : ''}> Ignore whitespace</label>
      <label><input type="checkbox" data-copt="cs" ${o.cs ? 'checked' : ''}> Ignore case</label>
      <label title="Hide the lines that are the same (3 lines of context kept)"><input type="checkbox" data-copt="only" ${o.only ? 'checked' : ''}> Only differences</label>
      <label title="Show password=, secret=, token=… values as dots (a changed value still shows as a difference)"><input type="checkbox" data-copt="mask" ${o.mask ? 'checked' : ''}> Hide passwords</label>
      <button data-cact="swap" title="Swap left and right">⇄ Swap</button>`;
    const side = (s, dirty, which) => `<div class="cmp-name ${dirty ? 'dirty' : ''}" title="${esc(s.label || s.path)}"><span>${s.kind === 'remote' ? '🖥 ' + esc(s.label) + ' <small class="muted">(read-only)</small>' : esc(s.path)}</span>${dirty ? `<button class="primary" data-cact="save${which}">💾 Save</button>` : ''}</div>`;
    const ctx = 3, show = f.rows.map((r, i) => !o.only || f.rows.slice(Math.max(0, i - ctx), i + ctx + 1).some(x => x.t !== 'same'));
    let html = '', hidden = 0;
    const flush = () => { if (hidden) { html += `<tr class="cmp-skip"><td colspan="5">⋯ ${hidden} same line${hidden > 1 ? 's' : ''}</td></tr>`; hidden = 0; } };
    f.rows.forEach((r, i) => {
      if (!show[i]) { hidden++; return; }
      flush();
      const hide = o.mask ? maskSecrets : x => x;
      const la = r.a != null ? hide(f.A[r.a]) : null, lb = r.b != null ? hide(f.B[r.b]) : null;
      const [ha, hb] = r.t === 'chg' ? charDiff(la, lb) : [la != null ? esc(la) : '', lb != null ? esc(lb) : ''];
      const first = r.t !== 'same' && f.blocks[r.blk].start === i;
      const cur = r.t !== 'same' && r.blk === f.cur ? ' cur' : '';
      html += `<tr class="cr ${r.t}${cur}" ${first ? `data-blk="${r.blk}"` : ''}><td class="ln">${r.a != null ? r.a + 1 : ''}</td><td class="tx">${ha || (la === '' ? ' ' : '')}</td>
        <td class="gut">${first ? `${b.kind !== 'remote' ? `<button class="icon" data-cto="b" data-b="${r.blk}" title="Copy this change to the right →">→</button>` : ''}${a.kind !== 'remote' ? `<button class="icon" data-cto="a" data-b="${r.blk}" title="← Copy this change to the left">←</button>` : ''}` : ''}</td>
        <td class="ln">${r.b != null ? r.b + 1 : ''}</td><td class="tx">${hb || (lb === '' ? ' ' : '')}</td></tr>`;
    });
    flush();
    const n = f.rows.length || 1;
    const marks = f.blocks.map((bk, i) => { const t = f.rows[bk.start].t; return `<i class="mk ${t}" data-jb="${i}" style="top:${bk.start / n * 100}%;height:max(3px, ${(bk.end - bk.start + 1) / n * 100}%)"></i>`; }).join('');
    $('.cmp-body', d).innerHTML = `<div class="cmp-names">${side(a, f.dirtyA, 'A')}<div class="cmp-gap"></div>${side(b, f.dirtyB, 'B')}</div>
      <div class="cmp-files"><div class="cmp-scroll"><table class="cmp-tbl"><colgroup><col class="c-ln"><col><col class="c-gut"><col class="c-ln"><col></colgroup><tbody>${html}</tbody></table></div><div class="cmp-map" title="Where the differences are — click to jump">${marks}</div></div>`;
  },

  jump(dir, to) {
    const f = this.st?.file; if (!f?.blocks.length) return;
    f.cur = to ?? ((f.cur + dir + f.blocks.length) % f.blocks.length);
    if (f.cur < 0) f.cur = 0;
    this.renderFiles();
    $(`#cmpDlg tr[data-blk="${f.cur}"]`)?.scrollIntoView({ block: 'center' });
  },

  // Copy a block's lines from one side over the other side's lines.
  copyBlock(bi, to) {
    const f = this.st.file, bk = f.blocks[bi], rows = f.rows.slice(bk.start, bk.end + 1);
    const from = to === 'b' ? 'a' : 'b', src = to === 'b' ? f.A : f.B, dst = to === 'b' ? f.B : f.A;
    const srcLines = rows.filter(r => r[from] != null).map(r => src[r[from]]);
    const dstIdx = rows.filter(r => r[to] != null).map(r => r[to]);
    let at;
    if (dstIdx.length) at = dstIdx[0];
    else { // nothing on that side: insert after the line before the block
      const before = f.rows.slice(0, bk.start).reverse().find(r => r[to] != null);
      at = before ? before[to] + 1 : 0;
    }
    dst.splice(at, dstIdx.length, ...srcLines);
    if (to === 'b') f.dirtyB = true; else f.dirtyA = true;
    this.diffFiles();
  },
  async saveSide(which) {
    const f = this.st.file, s = which === 'A' ? this.st.a : this.st.b;
    const text = (which === 'A' ? f.A : f.B).join(which === 'A' ? f.eolA : f.eolB);
    try { await this.write(s, text); if (which === 'A') f.dirtyA = false; else f.dirtyB = false; toast(`Saved ${s.path}${s.kind === 'ref' ? ' (the old copy is kept in its history)' : ''}`); this.renderFiles(); if (typeof Ref !== 'undefined' && s.kind === 'ref') Ref.load(); }
    catch (err) { toast(err.message, true); }
  },

  // ---- folder compare ----
  async loadDirs() {
    const d = this.dlg(), st = this.st;
    $('.cmp-body', d).innerHTML = '<div class="empty">Comparing…</div>';
    try { const r = await api('POST', '/api/compare/dirs', { a: st.a, b: st.b }); st.entries = r.entries; st.capped = r.capped; }
    catch (err) { $('.cmp-body', d).innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }
    if (!st.closed) st.closed = new Set();
    this.renderDirs();
  },
  renderDirs() {
    const d = this.dlg(), st = this.st, es = st.entries;
    const count = k => es.filter(e => !e.dir && e.status === k).length;
    $('.cmp-title', d).textContent = '⇆ Compare folders';
    $('.cmp-tools', d).innerHTML = `<div class="seg">${[['diff', 'Differences'], ['all', 'All'], ['same', 'Same']].map(([k, l]) => `<button data-cfilt="${k}" class="${st.filter === k ? 'active' : ''}">${l}</button>`).join('')}</div>
      <span class="cmp-count"><span class="st-diff">≠ ${count('diff')}</span> · <span class="st-left">◀ ${count('left')}</span> · <span class="st-right">▶ ${count('right')}</span> · <span class="muted">= ${count('same')}</span></span>
      <button data-cact="refresh" title="Compare again">↻</button><button data-cact="swap" title="Swap left and right">⇄ Swap</button>`;
    const hiddenByParent = e => { for (let p = cmpParent(e.rel); p; p = cmpParent(p)) if (st.closed.has(p)) return true; return false; };
    const keep = e => st.filter === 'all' || (st.filter === 'same' ? e.status === 'same' : e.status !== 'same');
    const icon = { same: '=', diff: '≠', left: '◀', right: '▶' };
    const info = f => f ? `<span class="sz">${f.size != null && f.size >= 0 ? fmtSize(f.size) : ''}</span><span class="dt">${fmtDateTime(f.mtime)}</span>` : '';
    const rows = es.filter(e => keep(e) && !hiddenByParent(e)).map(e => {
      const depth = e.rel.split('/').length - 1, name = e.rel.split('/').pop();
      const tw = e.dir ? pm(!st.closed.has(e.rel)) : '';
      const can = !e.dir && e.status !== 'same';
      return `<tr class="dr st-${e.status}" data-rel="${esc(e.rel)}" ${e.dir ? 'data-dir="1"' : ''} title="${e.dir ? 'Click to open / close' : e.status === 'left' || e.status === 'right' ? 'Only on one side' : 'Double-click to compare the files'}">
        <td class="nm" style="padding-left:${6 + depth * 16}px">${tw}${e.dir ? '📁' : '📄'} ${e.a ? esc(name) : '<span class="muted">—</span>'}</td><td class="inf">${info(e.a)}</td>
        <td class="st" title="${{ same: 'Same', diff: 'Different', left: 'Only on the left', right: 'Only on the right' }[e.status]}">${icon[e.status]}${can ? `<span class="cpy">${e.a ? `<button class="icon" data-dcopy="b" title="Copy left → right">→</button>` : ''}${e.b ? `<button class="icon" data-dcopy="a" title="← Copy right → left">←</button>` : ''}</span>` : ''}</td>
        <td class="nm">${e.b ? `${e.dir ? '📁' : '📄'} ${esc(name)}` : '<span class="muted">—</span>'}</td><td class="inf">${info(e.b)}</td></tr>`;
    }).join('');
    $('.cmp-body', d).innerHTML = `<div class="cmp-names"><div class="cmp-name" title="${esc(st.a.path)}"><span>📁 ${esc(st.a.path)}</span></div><div class="cmp-gap"></div><div class="cmp-name" title="${esc(st.b.path)}"><span>📁 ${esc(st.b.path)}</span></div></div>
      <div class="cmp-scroll"><table class="cmp-dirs"><colgroup><col><col class="c-inf"><col class="c-st"><col><col class="c-inf"></colgroup><tbody>${rows || `<tr><td colspan="5" class="empty">${st.filter === 'diff' ? '✓ No differences' : 'Nothing to show'}</td></tr>`}</tbody></table></div>
      ${st.capped ? '<div class="muted tiny">Only the first 20 000 items were compared.</div>' : ''}`;
  },
  async copyFile(rel, to) {
    const st = this.st, from = to === 'b' ? st.a : st.b, dest = to === 'b' ? st.b : st.a;
    const en = st.entries.find(x => x.rel === rel), replaces = to === 'b' ? en?.b : en?.a;
    if (!await askYes(`Copy ${rel} ${to === 'b' ? 'left → right' : 'right → left'}?\n\n${replaces ? `This replaces the file in ${dest.path}${dest.kind === 'ref' ? ' (the old copy is kept in its history)' : ' (a backup copy is kept)'}.` : `It is added to ${dest.path}.`}`)) return;
    const src = this.child(from, rel), dst = this.child(dest, rel);
    try {
      if (src.kind === 'ref' && dst.kind === 'ref') { // any file, byte for byte
        const r = await fetch('/api/ref/file?path=' + encodeURIComponent(src.path)); if (!r.ok) throw new Error('read failed');
        const put = await fetch('/api/ref/file?path=' + encodeURIComponent(dst.path), { method: 'PUT', body: await r.arrayBuffer() });
        if (!put.ok) throw new Error((await put.json().catch(() => ({}))).error || 'copy failed');
      } else {
        const x = await this.read(src);
        if (x.binary) throw new Error('binary files can only be copied between Folders paths');
        await this.write(dst, x.text);
      }
      toast(`Copied ${rel} ${to === 'b' ? '→' : '←'}`);
      if (typeof Ref !== 'undefined') Ref.load();
      await this.loadDirs();
    } catch (err) { toast(err.message, true); }
  },

  // ---- events ----
  async click(e) {
    const d = $('#cmpDlg'), st = this.st;
    if (e.target.closest('[data-cclose]')) { if (await this.okToClose()) d.close(); return; }
    const pc = e.target.closest('[data-cpc]');
    if (pc) {
      const r = await api('POST', pc.dataset.cpc === 'file' ? '/api/local/pickfile' : '/api/local/pick', { key: `compare-${pc.dataset.cpc === 'file' ? 'file' : 'folder'}-${pc.dataset.side}` }).catch(err => (toast(err.message, true), {}));
      if (r.ok) $$('.cmp-in', d)[+pc.dataset.side].value = r.path;
      return;
    }
    const cm = e.target.closest('[data-cmode]');
    if (cm) { // switch one side between Folders/PC and a server file, keeping what the other side has
      const i = +cm.dataset.side;
      this.modes = this.modes.map((m, j) => j === i ? (cm.dataset.cmode === 'server' ? { kind: 'server', id: '', path: '' } : { kind: 'path', value: '' })
        : m.kind === 'server' ? { kind: 'server', id: $(`.cmp-srv[data-side="${j}"]`, d)?.value || '', path: $(`.cmp-rpath[data-side="${j}"]`, d)?.value || '' }
        : { kind: 'path', value: $(`.cmp-in[data-side="${j}"]`, d)?.value || '' });
      return this.chooser('', this.modes);
    }
    if (e.target.closest('[data-cgo]')) {
      const [l, r] = this.readChooser();
      if (!l || !r) return toast('Choose both sides: a server and its file path, or a Folders / PC path', true);
      return this.open(l, r);
    }
    const filt = e.target.closest('[data-cfilt]'); if (filt) { st.filter = filt.dataset.cfilt; return this.renderDirs(); }
    const to = e.target.closest('[data-cto]'); if (to) return this.copyBlock(+to.dataset.b, to.dataset.cto);
    const jb = e.target.closest('[data-jb]'); if (jb) return this.jump(0, +jb.dataset.jb);
    const dc = e.target.closest('[data-dcopy]'); if (dc) { e.stopPropagation(); return this.copyFile(dc.closest('[data-rel]').dataset.rel, dc.dataset.dcopy); }
    const dir = e.target.closest('tr[data-dir]');
    if (dir) { const k = dir.dataset.rel; st.closed.has(k) ? st.closed.delete(k) : st.closed.add(k); return this.renderDirs(); }
    const blk = e.target.closest('tr[data-blk]'); if (blk && st?.mode === 'file') return this.jump(0, +blk.dataset.blk);
    const a = e.target.closest('[data-cact]')?.dataset.cact; if (!a) return;
    if (a === 'prev') return this.jump(-1);
    if (a === 'next') return this.jump(1);
    if (a === 'saveA' || a === 'saveB') return this.saveSide(a.slice(-1));
    if (a === 'refresh') return this.loadDirs();
    if (a === 'back') { if (!await this.okToClose()) return; this.st = st.back; return this.loadDirs(); }
    if (a === 'swap') {
      if (st.mode === 'dir') { [st.a, st.b] = [st.b, st.a]; return this.loadDirs(); }
      const f = st.file;[st.a, st.b, f.A, f.B, f.eolA, f.eolB, f.dirtyA, f.dirtyB] = [st.b, st.a, f.B, f.A, f.eolB, f.eolA, f.dirtyB, f.dirtyA];
      return this.diffFiles();
    }
  },
  dbl(e) {
    const tr = e.target.closest('tr[data-rel]');
    if (!tr || tr.dataset.dir || this.st?.mode !== 'dir') return;
    const en = this.st.entries.find(x => x.rel === tr.dataset.rel);
    if (!en?.a || !en?.b) return toast('That file is only on one side — use → or ← to copy it across');
    const base = this.st;
    this.openFiles({ ...this.child(base.a, en.rel), label: en.rel }, { ...this.child(base.b, en.rel), label: en.rel }, base).catch(err => toast(err.message, true));
  },
  change(e) {
    const o = e.target.closest('[data-copt]'); if (!o || !this.st?.opts) return;
    this.st.opts[o.dataset.copt] = o.checked; this.saveOpts();
    this.diffFiles();
  },
};

// password=…, secret: …, token=… → the value shown as dots (Compare's "Hide passwords")
const SECRET_KEY = /((?:pass(?:word)?|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|credentials?)[\w.-]*\s*[=:]\s*)(\S.*)$/i;
const maskSecrets = line => line == null ? line : line.replace(SECRET_KEY, (m, k) => k + '••••••');

const cmpParent = p => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';

// Line diff (Myers, O((N+M)·D)): returns ops { t: '='|'-'|'+', a, b }.
function diffLines(A, B) {
  const N = A.length, M = B.length, max = N + M;
  if (N * M > 4e8 && max > 40000) { // very large and very different: line by line
    const out = []; for (let i = 0; i < Math.max(N, M); i++) {
      if (i < N && i < M && A[i] === B[i]) out.push({ t: '=', a: i, b: i });
      else { if (i < N) out.push({ t: '-', a: i }); if (i < M) out.push({ t: '+', b: i }); }
    } return out;
  }
  // trim the common start and end (fast for typical small edits)
  let s = 0; while (s < N && s < M && A[s] === B[s]) s++;
  let e = 0; while (e < N - s && e < M - s && A[N - 1 - e] === B[M - 1 - e]) e++;
  const a = A.slice(s, N - e), b = B.slice(s, M - e), n = a.length, m = b.length;
  const ops = [];
  for (let i = 0; i < s; i++) ops.push({ t: '=', a: i, b: i });
  if (n === 0 || m === 0) {
    for (let i = 0; i < n; i++) ops.push({ t: '-', a: s + i });
    for (let j = 0; j < m; j++) ops.push({ t: '+', b: s + j });
  } else {
    const off = n + m, v = new Int32Array(2 * off + 2), trace = [];
    let done = false;
    for (let D = 0; D <= n + m && !done; D++) {
      trace.push(v.slice());
      for (let k = -D; k <= D; k += 2) {
        let x = k === -D || (k !== D && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
        let y = x - k;
        while (x < n && y < m && a[x] === b[y]) { x++; y++; }
        v[off + k] = x;
        if (x >= n && y >= m) { done = true; break; }
      }
    }
    // walk back
    let x = n, y = m; const rev = [];
    for (let D = trace.length - 1; D >= 0; D--) {
      const vv = trace[D], k = x - y;
      const prevK = k === -D || (k !== D && vv[off + k - 1] < vv[off + k + 1]) ? k + 1 : k - 1;
      const px = vv[off + prevK], py = px - prevK;
      while (x > px && y > py) { rev.push({ t: '=', a: s + x - 1, b: s + y - 1 }); x--; y--; }
      if (D > 0) { if (x === px) rev.push({ t: '+', b: s + y - 1 }); else rev.push({ t: '-', a: s + x - 1 }); }
      x = px; y = py;
    }
    // removals before insertions inside each changed run reads best side by side
    const mid = rev.reverse();
    for (let i = 0; i < mid.length;) {
      if (mid[i].t === '=') { ops.push(mid[i++]); continue; }
      const run = []; while (i < mid.length && mid[i].t !== '=') run.push(mid[i++]);
      ops.push(...run.filter(o => o.t === '-'), ...run.filter(o => o.t === '+'));
    }
  }
  for (let i = 0; i < e; i++) ops.push({ t: '=', a: N - e + i, b: M - e + i });
  return ops;
}

// The changed characters of a changed line pair, marked.
function charDiff(x, y) {
  let p = 0; while (p < x.length && p < y.length && x[p] === y[p]) p++;
  let s = 0; while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++;
  const mark = (t) => esc(t.slice(0, p)) + (t.length - s > p ? `<span class="cx">${esc(t.slice(p, t.length - s))}</span>` : '') + esc(t.slice(t.length - s));
  return [mark(x), mark(y)];
}
