'use strict';
// WorkHub page, part 7 of 7: start-up, and later features (presentation mode, notifications, support report, recycle bin…).
// The page's script is split into parts loaded in order (index.html); they share one global scope.

// ---------- start ----------
(async () => {
  await poll();
  for (const k of S.settings.open_tabs || []) await Notes.open(k);
  if (!Notes.docs.length) Notes.activate(null);
  const v = location.hash.slice(1);
  if (document.getElementById('view-' + v)) show(v);
  if (v.startsWith('ask=')) { Chat.toggle(true); Chat.send(decodeURIComponent(v.slice(4))); }
})();

// Connecting from PuTTY/FileZilla/SQL right after a search counts as "searched for"
// (the connection itself is counted by the server).
for (const [obj, fn] of [[Term, 'open'], [Remote, 'connect'], [SQL, 'open']]) {
  const orig = obj[fn].bind(obj);
  obj[fn] = (e, ...rest) => { markSearched(e); return orig(e, ...rest); };
}

// Backups window
async function showBackups() {
  const r = await api('GET', '/api/backups').catch(err => (toast(err.message, true), null));
  if (!r) return;
  $('#backupFolder').textContent = r.folder;
  $('#backupList').innerHTML = r.backups.map((b, i) => `<div class="grow"><span>${i === 0 ? '<b>' : ''}${esc(fmtDateTime(b.when))}${i === 0 ? '</b> (latest)' : ''}</span><span class="spacer"></span><span class="muted tiny">${fmtSize(b.size)} · ${esc(b.name)}</span></div>`).join('')
    || '<div class="muted tiny" style="padding:8px">No backups yet — one is made at start-up when there is data.</div>';
  $('#backupCopyTo').textContent = r.copy_to || 'Not copied anywhere else';
  $('#backupCopyState').innerHTML = !r.copy_to ? '' : r.copy_error ? `<span style="color:var(--danger)">⚠ Last copy failed: ${esc(r.copy_error)}</span>`
    : r.copy_at ? `<span style="color:var(--ok)">✓ Last copied ${esc(fmtDateTime(r.copy_at))}</span>` : '<span class="muted">Each new backup is copied there.</span>';
  $('#backupOneDrive').hidden = !r.onedrive || r.copy_to === r.onedrive;
  $('#backupOneDrive').title = r.onedrive ? 'Copy backups to ' + r.onedrive : '';
  $('#backupCopyOff').hidden = !r.copy_to;
  Backups.onedrive = r.onedrive;
  if (!$('#backupDlg').open) $('#backupDlg').showModal();
}
const Backups = {
  onedrive: '',
  async copyTo(folder) {
    try { await api('POST', '/api/backups/copy', { folder }); toast(folder ? 'Backups are now also copied to ' + folder : 'Backups are no longer copied'); }
    catch (err) { toast(err.message, true); }
    showBackups();
  },
};
$('#backupOneDrive').onclick = () => Backups.copyTo(Backups.onedrive);
$('#backupCopyOff').onclick = () => Backups.copyTo('');
$('#backupCopyPick').onclick = async () => {
  toast('Choose a folder in the window that opened (it may be behind WorkHub)');
  const r = await api('POST', '/api/local/pick', { key: 'backup-copy' }).catch(err => (toast(err.message, true), null));
  if (r?.ok) Backups.copyTo(r.path);
};
$('#backupBtn').onclick = showBackups;
$('#backupClose').onclick = () => $('#backupDlg').close();
$('#backupReveal').onclick = () => api('POST', '/api/backups/reveal').catch(err => toast(err.message, true));
$('#backupNow').onclick = async () => {
  $('#backupNow').disabled = true;
  try { const r = await api('POST', '/api/backups'); toast('Backup made: ' + r.name); await showBackups(); } catch (err) { toast(err.message, true); }
  $('#backupNow').disabled = false;
};

// ---- Files page: drag a column heading's right edge to resize (per pane, remembered) ----
{
  const key = pane => 'fcols.' + pane.id;
  const apply = (pane, w) => { if (w) pane.style.setProperty('--fcols', `${w[0]}px ${w[1]}px ${w[2]}px minmax(${Math.max(90, w[3] || 0)}px, 1fr)`); else pane.style.removeProperty('--fcols'); };
  for (const id of ['localPane', 'remotePane']) { const p = $('#' + id); if (p) apply(p, store.get(key(p), null)); }
  let dragging = false;
  document.addEventListener('mousedown', e => {
    const g = e.target.closest?.('.fgrip'); if (!g || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const pane = g.closest('.pane'), head = g.closest('.fhead'), i = +g.dataset.fcol;
    const w = [...head.children].map(c => Math.round(c.getBoundingClientRect().width)); // the widths as shown now
    const x0 = e.clientX, w0 = w[i];
    dragging = true;
    const move = ev => { w[i] = Math.max(i === 0 ? 120 : 50, Math.min(900, w0 + ev.clientX - x0)); apply(pane, w); };
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); store.set(key(pane), w); setTimeout(() => { dragging = false; }, 0); };
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
  }, true);
  document.addEventListener('click', e => { if (dragging || e.target.closest?.('.fgrip')) { e.stopPropagation(); e.preventDefault(); } }, true); // a resize is not a sort
  document.addEventListener('dblclick', e => { const g = e.target.closest?.('.fgrip'); if (!g) return; const pane = g.closest('.pane'); store.set(key(pane), null); apply(pane, null); }, true);
}

// ---- the Assistant: drag its left edge to resize (remembered); it follows the top bar ----
{
  const c = $('#chat'), grip = Object.assign(document.createElement('div'), { className: 'chat-grip', title: 'Drag to resize' });
  c.prepend(grip);
  grip.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    e.preventDefault(); grip.classList.add('on');
    const move = ev => { const w = Math.max(280, Math.min(innerWidth - 120, innerWidth - ev.clientX)); document.documentElement.style.setProperty('--chat-w', w + 'px'); };
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); grip.classList.remove('on'); store.set('chatW', Math.round(c.getBoundingClientRect().width)); };
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
  });
  grip.addEventListener('dblclick', () => { store.set('chatW', 0); document.documentElement.style.removeProperty('--chat-w'); });
  window.addEventListener('resize', () => { if (!c.hidden) Chat.place(); });
}

// ⧉ Open in a new window, for every page: next to the page name at the top (SSH, FTP, SQL and Tasks have it
// beside their tree / thread list instead), and on right-click of a page in the left menu.
const OWN_POP = ['terminal', 'files', 'sql', 'tasks', 'api', 'git', 'ref', 'notes']; // these have it beside their own list
function pagePopBtn(view) {
  let b = $('#pagePop');
  if (!b) {
    b = Object.assign(document.createElement('button'), { id: 'pagePop', className: 'icon winbtn ghost' });
    b.setAttribute('aria-label', 'Open in a new window');
    b.innerHTML = ICON_NEWWIN;
    b.onclick = () => Popout.popPage(b.dataset.view);
    $('#pageTitle').after(b);
  }
  b.dataset.view = view;
  b.title = `Open ${Menubar?.label?.(view) || 'this page'} in a new window (Dock back puts it back)`;
  b.hidden = typeof Popout === 'undefined' || !!Popout.me || OWN_POP.includes(view) || !$(`#nav [data-view="${view}"]`);
}
$('#nav').addEventListener('contextmenu', e => {
  const b = e.target.closest('button[data-view]'); if (!b || typeof Popout === 'undefined' || Popout.me) return;
  e.preventDefault();
  const v = b.dataset.view, name = Menubar?.label?.(v) || v;
  setTimeout(() => Tree.showMenu({ clientX: e.clientX, clientY: e.clientY }, [[`Open ${name}`, () => show(v)], ['⧉ Open in a new window', () => Popout.popPage(v)]]));
});

document.addEventListener('click', e => { const b = e.target.closest('[data-pagepop]'); if (b && typeof Popout !== 'undefined') Popout.popPage(b.dataset.pagepop); });

// Help → Copy a support report: shown first (so you see what's in it), then copied. No secrets or addresses in it.
const SupportReport = {
  async open() {
    let r; try { r = await api('GET', '/api/support'); } catch (err) { return toast(err.message, true); }
    const d = Object.assign(document.createElement('dialog'), { className: 'askyes support-dlg' });
    d.innerHTML = `<div class="ask-head"><span class="ask-logo">W</span>WorkHub</div><h3>📋 Support report</h3>
      <div class="muted tiny">What's in it, to paste when asking for help. Passwords, tokens, addresses, host names, IPs and emails are replaced by &lt;…&gt; — check before you send it.</div>
      <pre class="support-text"></pre><div class="row end"><button type="button" data-sr="close">Close</button><button type="button" class="primary" data-sr="copy">📋 Copy</button></div>`;
    d.querySelector('.support-text').textContent = r.report;
    document.body.append(d); d.showModal();
    d.addEventListener('close', () => d.remove());
    d.addEventListener('click', e => { const b = e.target.closest('[data-sr]'); if (!b) return; if (b.dataset.sr === 'copy') copyText(r.report, 'Support report copied'); d.close(); });
  },
};

// File → 🗑 Recycle bin: deleted threads, connections and notes, kept 30 days.
const RecycleBin = {
  async open() {
    let d = $('#binDlg');
    if (!d) {
      d = Object.assign(document.createElement('dialog'), { id: 'binDlg', className: 'askyes bin-dlg' });
      d.innerHTML = `<div class="ask-head"><span class="ask-logo">W</span>WorkHub</div><h3>🗑 Recycle bin</h3>
        <div class="muted tiny">Deleted threads, connections and notes stay here for 30 days, then go for good.</div>
        <div class="bin-list"></div><div class="row end"><button type="button" data-bin="empty">Empty the bin</button><button type="button" class="primary" data-bin="close">Close</button></div>`;
      document.body.append(d);
      d.addEventListener('click', e => this.click(e));
    }
    await this.draw(); if (!d.open) d.showModal();
  },
  async draw() {
    const r = await api('GET', '/api/bin').catch(() => ({ items: [] }));
    const icon = { thread: '🧵', entry: '🔌', note: '📝' }, what = { thread: 'thread', entry: 'connection', note: 'note' };
    const left = t => Math.max(0, 30 - Math.floor((Date.now() - new Date(t)) / 864e5));
    $('#binDlg .bin-list').innerHTML = r.items.length ? r.items.map(it => `<div class="bin-row"><span class="bin-ico">${icon[it.kind] || '•'}</span>
      <span class="bin-t"><b>${esc(it.title)}</b><span class="muted tiny"> ${what[it.kind] || ''} · deleted ${esc(fmtTime(it.deleted))} · ${left(it.deleted)} days left</span></span>
      <button type="button" data-bin="restore" data-id="${it.id}">↩ Restore</button><button type="button" data-bin="forever" data-id="${it.id}" title="Remove it now, for good">Delete forever</button></div>`).join('')
      : '<div class="muted bin-empty">The bin is empty.</div>';
    $('#binDlg [data-bin=empty]').disabled = !r.items.length;
  },
  async click(e) {
    const b = e.target.closest('[data-bin]'); if (!b) return;
    const d = $('#binDlg');
    switch (b.dataset.bin) {
      case 'close': return d.close();
      case 'restore': {
        let it; try { it = await api('POST', `/api/bin/${b.dataset.id}/restore`); } catch (err) { return toast(err.message, true); }
        toast(`↩ “${it.title}” is back`);
        poll(); if (typeof Work !== 'undefined') Work.loadList(); Notes.renderLists?.();
        return this.draw();
      }
      case 'forever':
        if (!await askYes('Delete it for good? It can\'t be put back.', { ok: 'Delete forever', danger: true })) return;
        await api('DELETE', `/api/bin/${b.dataset.id}`); return this.draw();
      case 'empty':
        if (!await askYes('Empty the recycle bin? Everything in it is deleted for good.', { ok: 'Empty the bin', danger: true })) return;
        await api('DELETE', '/api/bin'); toast('The recycle bin is empty'); return this.draw();
    }
  },
};

// 🎬 Presentation mode (View menu): safe to show this workspace on a screen — passwords stay masked, PROD is
// hidden, clipboard capture pauses (nothing new pops up or is saved), text is a step bigger, and host names /
// addresses can be blurred. Turning it off puts everything back.
const Presenting = {
  on() { return document.body.classList.contains('presenting'); },
  blur() { try { return localStorage.getItem('presentBlur') !== '0'; } catch { return true; } },
  setBlur(v) { try { localStorage.setItem('presentBlur', v ? '1' : '0'); } catch { /* ignore */ } document.body.classList.toggle('pres-blur', v && this.on()); },
  async toggle(force) {
    const on = force ?? !this.on();
    if (on === this.on()) return;
    const b = document.body;
    if (on) {
      this.before = { showPw: S.showPw, watch: !!S.settings.watch, scale: Fonts.ui() };
      try { localStorage.setItem('presentBefore', JSON.stringify(this.before)); } catch { /* ignore */ }
      b.classList.add('presenting'); b.classList.toggle('pres-blur', this.blur());
      S.showPw = false;
      if (this.before.watch) await saveSettings({ watch: false }).catch(() => {});
      root.style.setProperty('--ui-scale', String(Math.round((this.before.scale + 0.08) * 100) / 100)); // not saved
    } else {
      let bf = this.before; try { bf ||= JSON.parse(localStorage.getItem('presentBefore') || 'null'); } catch { /* none */ }
      b.classList.remove('presenting', 'pres-blur');
      if (bf?.watch) await saveSettings({ watch: true }).catch(() => {});
      root.style.setProperty('--ui-scale', Fonts.ui());
    }
    try { localStorage.setItem('presenting', on ? '1' : '0'); } catch { /* ignore */ }
    this.pill(); if (S.allEntries) redrawAll(); window.dispatchEvent(new Event('resize'));
    toast(on ? '🎬 Presenting: passwords hidden, PROD hidden, capture paused' : 'Presentation mode off — everything is back');
  },
  pill() {
    let p = $('#presPill');
    if (!p) { p = Object.assign(document.createElement('button'), { id: 'presPill', className: 'pres-pill', title: 'Presentation mode is on — click to stop' }); p.textContent = '🎬 Presenting'; p.onclick = () => this.toggle(false); $('#gsearch')?.prepend(p); }
    p.hidden = !this.on();
  },
};
try { if (localStorage.getItem('presenting') === '1') setTimeout(() => Presenting.toggle(true), 300); } catch { /* ignore */ }

// 🔔 Notifications (monitor down / up, a tracked Jira issue changes, a reminder due): a notice here with Open;
// Desktop also shows a Windows notification; the browser version a browser notification when allowed.
const Notices = {
  last: -1, native: false,
  async poll() {
    if (typeof Presenting !== 'undefined' && Presenting.on()) return; // 🎬 nothing pops up while presenting
    let r; try { r = await api('GET', `/api/notifications?since=${Math.max(this.last, 0)}`); } catch { return; }
    this.native = r.native;
    if (this.last < 0) { // only what happens from now on pops up; earlier ones go in 🔔 Messages
      for (const n of [...r.notices].reverse()) if (typeof MsgLog !== 'undefined') MsgLog.items.push({ at: new Date(n.at || Date.now()), notice: n });
      if (typeof MsgLog !== 'undefined') MsgLog.items.sort((a, b) => b.at - a.at);
      this.last = r.last; return;
    }
    for (const n of r.notices) {
      this.last = Math.max(this.last, n.n);
      toast(`${n.title}${n.body ? ' — ' + n.body : ''}`, false, () => this.open(n), 'Open', { notice: n });
      if (!this.native && 'Notification' in window && Notification.permission === 'granted') {
        try { const w = new Notification(n.title, { body: n.body || '', tag: 'wh-' + n.n }); w.onclick = () => { window.focus(); this.open(n); }; } catch { /* not allowed */ }
      }
    }
  },
  open(n) {
    if (n.kind === 'reminder' && n.ref) { const [t, p] = n.ref.split('/'); return Work.open(t, p); }
    if (n.kind === 'jira' && n.ref) { show('jira'); Jira.sel = 'i:' + n.ref; return Jira.render(); }
    show(n.view || 'dashboard');
    if (n.view === 'monitor' && n.ref) setTimeout(() => { // the check it's about: in view, briefly marked
      const row = document.querySelector(`#monList [data-mon="${CSS.escape(n.ref)}"]`);
      if (row) { row.scrollIntoView({ block: 'center' }); row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 2500); }
    }, 300);
  },
};
setTimeout(() => Notices.poll(), 3000); setInterval(() => Notices.poll(), 15000);
