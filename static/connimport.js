'use strict';
// File → Import → Connections from DBeaver / PuTTY / FileZilla / SQL Developer.
// Read-only on those programs: their settings are only read. Shows what was
// found on this PC (or a file you pick), you tick what to bring in.

const ConnImport = {
  items: [],
  dlg() {
    let d = $('#connImpDlg');
    if (d) return d;
    d = Object.assign(document.createElement('dialog'), { id: 'connImpDlg', className: 'connimpdlg' });
    d.innerHTML = `<div class="ci-head"><h3>⬇ Import connections</h3><span class="spacer"></span><button class="icon" data-ciclose>✕</button></div>
      <p class="muted tiny">From DBeaver, PuTTY, FileZilla and SQL Developer — their settings are only read, never changed. Connections you already have aren't added twice; they only get what they're missing (password, service name…).</p>
      <div class="ci-sources"></div>
      <div class="ci-row"><button data-cifile>📄 Choose a file…</button><span class="muted tiny">data-sources.json (DBeaver) · a .reg export of PuTTY sessions · sitemanager.xml (FileZilla) · connections.json / .xml (SQL Developer)</span>
        <input type="file" id="ciFile" accept=".json,.xml,.reg" hidden></div>
      <div class="ci-preview"></div>`;
    document.body.append(d);
    d.addEventListener('click', e => this.click(e));
    $('#ciFile', d).addEventListener('change', async e => { const f = e.target.files[0]; e.target.value = ''; if (f) this.readFile(f); });
    return d;
  },
  async open() {
    const d = this.dlg(); if (!d.open) d.showModal();
    $('.ci-preview', d).innerHTML = '';
    $('.ci-sources', d).innerHTML = '<div class="muted">Looking for DBeaver, PuTTY, FileZilla and SQL Developer on this PC…</div>';
    const list = await api('GET', '/api/import/conns/scan').catch(() => []);
    this.sources = list;
    $('.ci-sources', d).innerHTML = list.length ? list.map((s, i) => `<div class="ci-src"><b>${esc(s.label)}</b><span class="mono tiny ci-path" title="${esc(s.path || 'Windows registry')}">${esc(s.path || 'Windows registry (saved sessions)')}</span>
        <span class="ci-n">${s.error ? `<span class="muted">${esc(s.error)}</span>` : `${s.count} connection${s.count === 1 ? '' : 's'}`}</span>${s.count ? `<button class="primary" data-cisrc="${i}">Preview…</button>` : ''}</div>`).join('')
      : '<div class="muted">None of them found on this PC — use 📄 Choose a file (e.g. copied from another PC).</div>';
  },
  async readFile(f) {
    const b64 = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(',')[1] || ''); fr.readAsDataURL(f); });
    try { this.show(await api('POST', '/api/import/conns/read', { name: f.name, content: b64 }), f.name); } catch (err) { toast(err.message, true); }
  },
  show(r, from) {
    this.items = r.items || [];
    const label = { dbeaver: 'DBeaver', putty: 'PuTTY', filezilla: 'FileZilla', sqldeveloper: 'SQL Developer' }[r.source] || r.source;
    const fresh = this.items.filter(x => !x.exists).length;
    const kind = c => ({ oracle: 'Oracle', postgres: 'PostgreSQL', ssh: 'SSH', sftp: 'SFTP', ftp: 'FTP', ftps: 'FTPS' }[c.protocol] || c.protocol || '');
    const db = c => c.extra?.service || c.extra?.sid || c.extra?.database || '';
    $('.ci-preview', this.dlg()).innerHTML = `<h4>${esc(label)} <span class="muted tiny">${esc(from || '')}</span></h4>
      <div class="ci-row"><label><input type="checkbox" data-ciall checked> All</label><span class="muted tiny">${this.items.length} found · ${fresh} new · ${this.items.length - fresh} already in WorkHub</span><span class="spacer"></span><button class="primary" data-cigo>⬇ Import ticked</button></div>
      <div class="ci-tablewrap"><table class="ci-table"><tr><th></th><th>Name</th><th>Folder</th><th>Type</th><th>Host</th><th>User</th><th>🔑</th><th>Env</th><th></th></tr>
      ${this.items.map((c, i) => `<tr class="${c.exists ? 'have' : ''}"><td><input type="checkbox" data-ci="${i}" checked></td><td>${esc(c.name)}</td><td class="muted">${esc(c.folder || '')}</td><td>${esc(kind(c))}</td>
        <td class="mono">${esc(c.host)}${c.port ? ':' + c.port : ''}${db(c) ? ' / ' + esc(db(c)) : ''}</td><td>${esc(c.username || '')}</td>
        <td title="${c.password ? 'Password included' : 'No password — asked when you connect'}">${c.password ? '🔑' : ''}</td><td>${c.env ? `<span class="badge ${esc(c.env)}">${esc(c.env)}</span>` : ''}</td>
        <td class="muted tiny">${c.exists ? 'already here — fills in what’s missing' : 'new'}</td></tr>`).join('')}</table></div>`;
  },
  async click(e) {
    const d = this.dlg();
    if (e.target.closest('[data-ciclose]')) return d.close();
    if (e.target.closest('[data-cifile]')) return $('#ciFile', d).click();
    const s = e.target.closest('[data-cisrc]');
    if (s) {
      const src = this.sources[+s.dataset.cisrc];
      try { this.show(await api('POST', '/api/import/conns/read', { source: src.source, path: src.path }), src.path || 'Windows registry'); } catch (err) { toast(err.message, true); }
      return;
    }
    const all = e.target.closest('[data-ciall]');
    if (all) { $$('[data-ci]', d).forEach(c => { c.checked = all.checked; }); return; }
    if (e.target.closest('[data-cigo]')) {
      const picked = $$('[data-ci]', d).filter(c => c.checked).map(c => this.items[+c.dataset.ci]);
      if (!picked.length) return toast('Tick the connections to import', true);
      try {
        const r = await api('POST', '/api/import/conns/apply', { items: picked });
        await poll();
        toast(`Imported ${r.added} new connection${r.added === 1 ? '' : 's'}${r.updated ? ` · filled in ${r.updated} you already had` : ''}`);
        d.close();
      } catch (err) { toast(err.message, true); }
    }
  },
};
