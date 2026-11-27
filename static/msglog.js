'use strict';
// 🔔 Messages: every message that pops up at the bottom (and every notification)
// is kept here — the bell at the top shows how many you haven't seen; click the
// message at the bottom or the bell to see them all; click one to open what it
// is about (the monitor, the Jira issue, the thread message, Undo…). The bottom
// message also stays while the mouse is on it.

const MsgLog = {
  items: [], unseen: 0, max: 100,
  load() {
    try { this.items = JSON.parse(localStorage.getItem('msgLog') || '[]').map(x => ({ ...x, at: new Date(x.at) })); } catch { this.items = []; }
  },
  save() {
    try { localStorage.setItem('msgLog', JSON.stringify(this.items.filter(x => !x.notice).slice(0, this.max).map(({ at, msg, err }) => ({ at, msg, err })))); } catch { /* full */ }
  },
  add(it, quiet) {
    if (it.notice && this.items.some(x => x.notice?.n === it.notice.n)) return;
    this.items.unshift({ at: new Date(), ...it });
    this.items.length = Math.min(this.items.length, this.max);
    if (!quiet && (it.notice || it.err)) this.unseen++;
    if (!it.notice) this.save();
    this.badge();
    if ($('#msgLogDlg')?.open) this.draw();
  },
  badge() {
    const b = $('#bellTop'); if (!b) return;
    const n = $('#bellTop .bell-n'); n.textContent = this.unseen > 9 ? '9+' : this.unseen || ''; n.hidden = !this.unseen;
    b.title = this.unseen ? `${this.unseen} new message${this.unseen > 1 ? 's' : ''} — click to see` : 'Messages and notifications';
  },
  open() {
    let d = $('#msgLogDlg');
    if (!d) {
      d = Object.assign(document.createElement('dialog'), { id: 'msgLogDlg', className: 'msglog-pop' });
      d.innerHTML = `<div class="msglog-head"><b>🔔 Messages</b><span class="spacer"></span>
        <button type="button" class="ghost" data-ml="clear" title="Remove them all from this list">Clear</button><button type="button" class="ghost icon" data-ml="close" title="Close">✕</button></div>
        <div class="msglog-list"></div>`;
      document.body.append(d);
      d.addEventListener('click', e => {
        const b = e.target.closest('[data-ml]'); if (!b) return;
        if (b.dataset.ml === 'close') return d.close();
        if (b.dataset.ml === 'clear') { this.items = []; this.save(); return this.draw(); }
        const it = this.items[+b.dataset.ml]; if (!it) return;
        if (it.notice) { d.close(); return Notices.open(it.notice); }
        if (it.act) { d.close(); return it.act(); }
      });
      document.addEventListener('mousedown', e => { if (d.open && !d.contains(e.target) && !e.target.closest('#bellTop, #toast')) d.close(); });
    }
    this.unseen = 0; this.badge();
    this.draw();
    if (!d.open) d.show();
  },
  draw() {
    const ago = t => { const s = (Date.now() - t) / 1000; return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : t.toLocaleDateString(); };
    $('#msgLogDlg .msglog-list').innerHTML = this.items.length ? this.items.map((it, i) => {
      const can = it.notice || it.act;
      return `<div class="msglog-row ${it.err ? 'err' : ''} ${it.notice ? 'notice' : ''} ${can ? 'can' : ''}" ${can ? `data-ml="${i}" title="${esc(it.notice ? 'Open it' : it.label || 'Open')}"` : ''}>
        <span class="msglog-ico">${it.notice ? '🔔' : it.err ? '⚠' : '•'}</span>
        <span class="msglog-t"><span>${esc(it.notice ? it.notice.title : it.msg)}</span>${it.notice?.body ? `<span class="muted tiny">${esc(it.notice.body)}</span>` : ''}
          <span class="muted tiny">${esc(ago(it.at))}${can ? ` · <u>${esc(it.notice ? 'Open' : it.label || 'Open')}</u>` : ''}</span></span></div>`;
    }).join('') : '<div class="muted msglog-empty">No messages yet.</div>';
  },
};
MsgLog.load();

// every bottom message goes in the list too (Notices passes its notice along)
{
  const show = toast;
  toast = function (msg, err = false, undo = null, label = 'Undo', meta = null) { // eslint-disable-line no-global-assign
    show(msg, err, undo, label);
    MsgLog.add({ msg: String(msg), err: !!err, act: undo, label: undo ? label : '', notice: meta?.notice || null }, meta?.quiet);
  };
  const t = $('#toast');
  t.title = 'Click to see all messages';
  t.addEventListener('click', e => { if (!e.target.closest('button')) { t.className = ''; MsgLog.open(); } });
  t.addEventListener('mouseenter', () => clearTimeout(toastTimer)); // stays while you read it
  t.addEventListener('mouseleave', () => { if (t.className) toastTimer = setTimeout(() => (t.className = ''), 2500); });
}

// 🔔 at the top, next to 🔎 Ask and 💬
{
  const b = Object.assign(document.createElement('button'), { id: 'bellTop', className: 'ghost icon' });
  b.setAttribute('aria-label', 'Messages and notifications');
  b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg><span class="bell-n" hidden></span>';
  b.onclick = () => ($('#msgLogDlg')?.open ? $('#msgLogDlg').close() : MsgLog.open());
  ($('#askTop') || $('#chatFab')).before(b);
  MsgLog.badge();
}
