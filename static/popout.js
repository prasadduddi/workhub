'use strict';
// ⧉ Pop out: an SSH terminal, a SQL tab, a thread or a whole page in its own
// window, without the sidebar and menus. ⇲ Dock back (or closing that window)
// puts it back into WorkHub. SQL tabs move without reconnecting (their
// session lives in WorkHub itself); SSH terminals reconnect with the same login.
// The windows talk over a BroadcastChannel (same origin, also in the Desktop version).

const Popout = {
  chan: 'BroadcastChannel' in window ? new BroadcastChannel('WorkHub-popout') : null,
  me: (() => { const m = new URLSearchParams(location.search).get('popout')?.match(/^(\w+):(.+)$/); return m ? { kind: m[1], id: m[2] } : null; })(),
  out: new Map(), // in WorkHub: what is popped out, key → { kind, id, label }
  docked: false,

  // ---------- in WorkHub: send something out ----------
  open(kind, id, label, payload) {
    if (!this.chan) return toast('This browser can’t open WorkHub windows side by side', true);
    if (payload) try { localStorage.setItem(`wh-pop:${kind}:${id}`, JSON.stringify(payload)); } catch { /* full */ }
    const p = this.place(kind, id);
    const w = window.open(`/?popout=${kind}:${encodeURIComponent(id)}`, `wh-${kind}-${id}`, `popup,width=${p.w},height=${p.h},left=${p.x},top=${p.y}`);
    if (!w && !window.WH_DESKTOP) { toast('The new window was blocked — allow pop-ups for WorkHub', true); return false; }
    this.out.set(`${kind}:${id}`, { kind, id, label });
    this.chips();
    return true;
  },
  // Where a window opens: where that kind of window was when it was last docked back or closed
  // (each page — SSH, FTP, SQL, Tasks… — and each kind of single window keeps its own), else centred on the screen.
  posKey(kind, id) { return 'wh-popwin:' + (kind === 'page' ? 'page:' + id : kind); },
  place(kind, id) {
    const s = window.screen, aw = s.availWidth || 1280, ah = s.availHeight || 800, ax = s.availLeft ?? 0, ay = s.availTop ?? 0;
    let saved = null; try { saved = JSON.parse(localStorage.getItem(this.posKey(kind, id)) || 'null'); } catch { /* none */ }
    if (saved && saved.w >= 300 && saved.h >= 200) return { x: Math.round(saved.x), y: Math.round(saved.y), w: Math.round(saved.w), h: Math.round(saved.h) };
    const w = Math.min(1150, aw - 40), h = Math.min(780, ah - 40);
    return { x: Math.round(ax + (aw - w) / 2), y: Math.round(ay + (ah - h) / 2), w, h }; // centred
  },
  savePlace() {
    const { kind, id } = this.me || {}; if (!kind) return;
    try { localStorage.setItem(this.posKey(kind, id), JSON.stringify({ x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight })); } catch { /* full */ }
  },
  popSSH(t) {
    const e = t.entry;
    if (!this.open('ssh', e.id, `SSH ${e.username ? e.username + '@' : ''}${e.host}`)) return;
    Term.close(t); // its session ends here; the window connects again with the same login
  },
  popSQL(t) {
    if (t === SQL.active) t.sql = SQL.cm.getValue();
    const payload = { sid: t.sid, kind: t.kind, info: t.info, sql: t.sql, inTx: t.inTx, entryId: t.entry.id };
    if (!this.open('sql', t.sid, `SQL ${t.entry.name || t.entry.host}`, payload)) return;
    SQL.tabs = SQL.tabs.filter(x => x !== t); // not closed: the window carries on with the same session
    if (SQL.active === t) { SQL.active = null; SQL.activate(SQL.tabs.at(-1) || null); } else SQL.renderTabs();
    Tree.render();
  },
  popThread(w) { this.open('thread', w.id, `🧵 ${w.title}`); },
  popThreadOnly(w) { this.open('thread1', w.id, `🧵 ${w.title}`); }, // just the thread: no thread list
  // one connection in its own window: how = ssh | sql | sftp (the PROD question is asked in that window)
  connHow(e, mode) { return mode === 'sql' || (!canSSH(e) && canDB(e)) ? 'sql' : mode === 'files' || (!canSSH(e) && canFiles(e)) ? 'sftp' : 'ssh'; },
  popConn(e, how) { this.open('conn', `${how}~${e.id}`, `${{ ssh: 'SSH', sql: 'SQL', sftp: 'FTP' }[how]} ${e.name || e.host}`); },
  async openConn(how, e) {
    if (how === 'sql') { show('sql'); await SQL.open(e); }
    else if (how === 'sftp') { show('files'); await Remote.connect(e); }
    else { show('terminal'); await Term.open(e); }
  },
  popPage(view) { this.open('page', view, Menubar?.label?.(view) || view); },

  // the chips in WorkHub's top bar: one per popped-out window; click docks it back
  chips() {
    let box = $('#popChips');
    if (!box) { box = Object.assign(document.createElement('div'), { id: 'popChips', className: 'popchips' }); $('header.appbar')?.insertBefore(box, $('#gsearch')); }
    box.innerHTML = [...this.out.entries()].map(([k, o]) => `<button class="popchip" data-popk="${esc(k)}" title="In its own window — click to dock it back into WorkHub">⧉ ${esc(o.label)} <span>⇲</span></button>`).join('');
  },

  // ---------- back into WorkHub ----------
  async dockIn(kind, id, p) {
    this.out.delete(`${kind}:${id}`); this.chips();
    if (kind === 'ssh') { const e = byId(id); if (e) await Term.open(e, { confirmed: true }); }
    else if (kind === 'sql' && p) this.adoptSQL(p);
    else if (kind === 'thread' || kind === 'thread1') { show('tasks'); await Work.open(id); }
    else if (kind === 'conn') { const [how, eid] = id.split('~'); const e = byId(eid); if (e) await this.openConn(how, e); }
    else if (kind === 'page') show(id);
    toast('Docked back into WorkHub');
  },
  adoptSQL(p) {
    const e = byId(p.entryId); if (!e) return;
    const t = { sid: p.sid, entry: e, kind: p.kind, info: p.info || {}, sql: p.sql || '', result: null, out: '', inTx: !!p.inTx, objects: null, creds: {}, database: '' };
    SQL.tabs.push(t); SQL.expanded.add(e.id);
    show('sql'); SQL.activate(t); SQL.loadObjects(t, ''); Tree.render();
  },

  // ---------- in the popped-out window ----------
  async startOut() {
    const { kind, id } = this.me;
    document.body.classList.add('popout');
    const bar = Object.assign(document.createElement('div'), { id: 'popBar', className: 'popbar' });
    bar.innerHTML = `<span class="popicon">${ICON_NEWWIN}</span><b class="poptitle">WorkHub</b><span class="muted tiny">— its own window</span><span class="spacer"></span><button class="primary icon winbtn" id="popDock" aria-label="Dock back to WorkHub" title="Dock back to WorkHub — closes this window and puts it back into WorkHub">${ICON_DOCK}</button>`;
    $('main')?.prepend(bar);
    $('#popDock').onclick = () => this.dockOut();
    window.addEventListener('beforeunload', () => this.dockOut(true)); // closing the window docks it back too
    this.chan?.addEventListener('message', ev => { if (ev.data?.type === 'dock-request' && ev.data.key === `${kind}:${id}`) this.dockOut(); });
    for (let i = 0; i < 120 && (Lock.shown || !S.entries.length); i++) await new Promise(r => setTimeout(r, 250)); // data loaded
    let title = 'WorkHub';
    if (kind === 'ssh') { const e = byId(id); if (e) { title = `SSH ${e.username ? e.username + '@' : ''}${e.host}`; await Term.open(e, { confirmed: true }); } }
    else if (kind === 'sql') {
      let p = null; try { p = JSON.parse(localStorage.getItem(`wh-pop:sql:${id}`)); localStorage.removeItem(`wh-pop:sql:${id}`); } catch { /* none */ }
      if (p) { this.adoptSQL(p); title = `SQL ${byId(p.entryId)?.name || ''}`; }
    } else if (kind === 'thread' || kind === 'thread1') {
      if (kind === 'thread1') document.body.classList.add('pop-single');
      show('tasks'); await Work.loadList?.(); await Work.open(id); title = `🧵 ${Work.current?.title || 'Thread'}`;
    } else if (kind === 'conn') {
      document.body.classList.add('pop-single');
      const [how, eid] = id.split('~'), e = byId(eid);
      if (e) { title = `${{ ssh: 'SSH', sql: 'SQL', sftp: 'FTP' }[how] || ''} ${e.name || e.host}`; await this.openConn(how, e); }
    }
    else if (kind === 'page') { document.body.classList.add('pop-page'); show(id); Tree.render?.(); title = Menubar?.label?.(id) || id; }
    $('#popBar .poptitle').textContent = title;
    document.title = `${title} — WorkHub`;
    window.whSetTitle?.(document.title);
  },
  dockOut(closing) {
    if (this.docked) return;
    this.docked = true;
    this.savePlace(); // the next window of this kind opens here
    const { kind, id } = this.me;
    let payload = null;
    if (kind === 'sql') {
      const t = SQL.tabs[0]; // the one this window carries
      if (t) { if (t === SQL.active) t.sql = SQL.cm.getValue(); payload = { sid: t.sid, kind: t.kind, info: t.info, sql: t.sql, inTx: t.inTx, entryId: t.entry.id }; }
    }
    this.chan?.postMessage({ type: 'dock', kind, id, payload });
    if (!closing) window.close();
  },
};

if (Popout.me) {
  Popout.startOut();
} else {
  // WorkHub: windows docking back, and the chips
  Popout.chan?.addEventListener('message', ev => { if (ev.data?.type === 'dock') Popout.dockIn(ev.data.kind, ev.data.id, ev.data.payload); });
  document.addEventListener('click', e => {
    const c = e.target.closest('[data-popk]'); if (!c) return;
    Popout.chan?.postMessage({ type: 'dock-request', key: c.dataset.popk });
  });
  // ⧉ on SSH and SQL tabs
  $('#termTabs').addEventListener('click', e => {
    const p = e.target.closest('[data-pop]'); if (!p) return;
    e.stopPropagation(); Popout.popSSH(Term.tabs.find(t => t.id === p.dataset.pop));
  }, true);
  $('#sqlTabs').addEventListener('click', e => {
    const p = e.target.closest('[data-spop]'); if (!p) return;
    e.stopPropagation(); Popout.popSQL(SQL.tabs.find(t => t.sid === p.dataset.spop));
  }, true);
}
// ⧉ buttons drawn into the tabs
{
  const tr = Term.renderTabs.bind(Term);
  Term.renderTabs = () => { tr(); if (!Popout.me) $$('#termTabs .tab').forEach(el => { const t = Term.tabs.find(x => x.id === el.dataset.t); if (t && !t.local && !el.querySelector('[data-pop]')) el.querySelector('.x')?.insertAdjacentHTML('beforebegin', `<span class="pop" data-pop="${t.id}" title="Open in a new window (it reconnects there)">${ICON_NEWWIN}</span>`); }); };
  const sr = SQL.renderTabs.bind(SQL);
  SQL.renderTabs = () => { sr(); if (!Popout.me) $$('#sqlTabs .tab').forEach(el => { if (!el.querySelector('[data-spop]')) el.querySelector('.x')?.insertAdjacentHTML('beforebegin', `<span class="pop" data-spop="${esc(el.dataset.st)}" title="Open in a new window (same session — nothing is lost)">${ICON_NEWWIN}</span>`); }); };
}
