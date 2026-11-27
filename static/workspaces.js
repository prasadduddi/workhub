'use strict';
// Workspaces (File → New / Open / Switch / Close workspace): each workspace is a
// separate WorkHub with its own data. Opening one asks: this window or a new one.

const Workspaces = {
  list: [], current: 'Default', desktop: false,
  async load() {
    try { const r = await api('GET', '/api/workspaces'); this.list = r.workspaces || []; this.current = r.current; this.desktop = r.desktop; } catch { /* keep */ }
    return this.list;
  },
  others() { return this.list.filter(w => !w.current); },

  // a small WorkHub box: message (and optional extra HTML) + buttons; resolves the chosen button's value (null = cancelled)
  box(title, bodyHTML, buttons) {
    return new Promise(done => {
      const d = Object.assign(document.createElement('dialog'), { className: 'askyes ws-box' });
      d.innerHTML = `<div class="ask-head"><span class="ask-logo">W</span>WorkHub</div><h3 class="ws-title"></h3><div class="ws-body">${bodyHTML}</div>
        <div class="row end">${buttons.map(([v, label, cls]) => `<button type="button" data-ws="${v}" class="${cls || ''}">${label}</button>`).join('')}</div>`;
      d.querySelector('.ws-title').textContent = title;
      document.body.append(d);
      let over = false;
      const finish = v => { if (over) return; over = true; const vals = { name: d.querySelector('[data-wsf=name]')?.value.trim(), sample: d.querySelector('[data-wsf=sample]')?.checked, pick: d.querySelector('[data-wsf=pick]:checked')?.value }; d.close(); d.remove(); done(v === null ? null : { v, ...vals }); };
      d.addEventListener('cancel', e => { e.preventDefault(); finish(null); });
      d.addEventListener('close', () => finish(null));
      d.addEventListener('click', e => { const b = e.target.closest('[data-ws]'); if (b) finish(b.dataset.ws === 'cancel' ? null : b.dataset.ws); });
      d.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('input[type=text]')) { e.preventDefault(); d.querySelector('[data-ws=same]')?.click(); } });
      d.showModal();
      (d.querySelector('input[type=text]') || d.querySelector('button.primary'))?.focus();
    });
  },
  whereButtons() { return [['cancel', 'Cancel'], ['new', '⧉ Open in a new window'], ['same', 'Open in this window', 'primary']]; },

  async go(body, how) {
    toast(`Opening ${body.name || 'the workspace'}…`);
    let r;
    try { r = await api('POST', '/api/workspaces/open', { ...body, how }); } catch (err) { return toast(err.message, true); }
    if (r.opened) return toast(`“${r.name}” opened in its own window`);
    if (how === 'new') { (window.open(r.url, '_blank') ? toast(`“${r.name}” opened in a new tab`) : toast('The new window was blocked — allow pop-ups for WorkHub', true)); return; }
    location.href = r.url; // this window moves to that workspace
  },

  async create() {
    const c = await this.box('New workspace', `<label>Name<input type="text" data-wsf="name" placeholder="e.g. Demo, Client B, Test" maxlength="40"></label>
      <label class="ws-chk"><input type="checkbox" data-wsf="sample"> Fill it with sample data (made-up servers, threads, notes — for demos)</label>
      <div class="muted tiny">Its data is completely separate from this workspace. Where should it open?</div>`, this.whereButtons());
    if (!c) return;
    if (!c.name) return toast('Give the workspace a name', true);
    this.go({ name: c.name, create: true, sample: !!c.sample }, c.v);
  },

  async open() {
    await this.load();
    const rows = this.others().map((w, i) => `<label class="ws-row"><input type="radio" name="wspick" data-wsf="pick" value="${esc(w.name)}" ${i === 0 ? 'checked' : ''}> <b>${esc(w.name)}</b> ${w.running ? '<span class="tag">open</span>' : ''} <span class="muted tiny">${esc(w.dir)}</span></label>`).join('');
    const c = await this.box('Open workspace', `${rows || '<div class="muted">No other workspaces yet — use File → New workspace….</div>'}
      <div class="row"><button type="button" data-ws="browse">📁 A workspace's data folder…</button></div>`, rows ? this.whereButtons() : [['cancel', 'Close']]);
    if (!c) return;
    if (c.v === 'browse') {
      let r; try { r = await api('POST', '/api/local/pick', { key: 'ws-open' }); } catch (err) { return toast(err.message, true); }
      if (!r.ok) return;
      const where = await this.box('Open workspace', `<div>${esc(r.path)}</div>`, this.whereButtons());
      if (where) this.go({ folder: r.path }, where.v);
      return;
    }
    if (c.pick) this.go({ name: c.pick }, c.v);
  },

  async switchTo(name) {
    const c = await this.box(`Switch to “${name}”`, '<div class="muted tiny">The other workspace has its own data. Where should it open?</div>', this.whereButtons());
    if (c) this.go({ name }, c.v);
  },

  async close() {
    await this.load();
    if (this.current === 'Default') return toast('This is the Default workspace — to stop WorkHub use File → Quit', true);
    if (!await askYes(`Close the workspace “${this.current}”?\n\nIt stops (its data is kept — open it again any time from File → Open workspace). The Default workspace takes over and opens next time.`, { ok: 'Close workspace' })) return;
    let r; try { r = await api('POST', '/api/workspaces/close'); } catch (err) { return toast(err.message, true); }
    if (this.desktop) return toast('Closing this workspace — Default opens in its own window');
    location.href = r.url;
  },

  // File → Switch workspace ▸ (filled when the menu opens)
  menuItems() {
    const items = this.list.map(w => [`${w.current ? '● ' : ''}${w.name}${w.running && !w.current ? '  (open)' : ''}`, w.current ? null : () => this.switchTo(w.name)]);
    return items.length ? items : [['(only this workspace)', null]];
  },
};
Workspaces.load(); setInterval(() => Workspaces.load(), 60000);

// the workspace whose window you use is the one that captures what you copy
{
  let t = 0;
  const active = () => { if (document.visibilityState === 'visible' && Date.now() - t > 5000) { t = Date.now(); api('POST', '/api/workspaces/active').catch(() => {}); } };
  window.addEventListener('focus', active); document.addEventListener('visibilitychange', active); setTimeout(active, 1500);
}
