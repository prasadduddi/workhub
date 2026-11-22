'use strict';
// "What's new & tips": shown at start-up once per release (until the user
// ticks "Don't show again"), and from the menu any time. Add a release at the
// top of RELEASES for every new version.

const RELEASES = [
  { v: '1.7', title: 'Folders, naming rules, grouping and more', items: [
    ['📁', 'Folders (replaces Properties)', 'Your own folder tree of JSON, YAML, properties… files. + adds folders; drop files or whole folders in. Files are plain files that every version keeps; older copies and deleted items are kept too.', 'ref'],
    ['🔗', 'Link to a path', 'In Folders, “Link to a path…” shows a folder or file from anywhere (even a network share) without copying it.', 'ref'],
    ['🏷', 'Naming rules', 'Bookmarks → Naming rules…: e.g. “-BAT- = Batch” names every server and link whose host contains -BAT-. Per workspace.', 'bookmarks'],
    ['🗂', 'Group servers', 'PuTTY, FileZilla and SQL trees: the Group by box (Env, App, Domain, Type, My groups, User). Or tell the chat “group putty by app”.', 'terminal'],
    ['🔀', 'Tunnels without PuTTY', 'Copy an “ssh -N -L1522:dbhost:1521 user@jump” command and WorkHub sets up the tunnel on the jump server. Set it up or switch it off in PuTTY → right-click the jump server → Edit (Tunnels, Use tunnels, Start when WorkHub starts). Running tunnels show ⇄ in green; SQL Developer, DBeaver etc. can use localhost:PORT too.', 'terminal'],
    ['🎨', 'Colours per name', 'Each naming-rule label (Batch, Touchpoint, App/Picasso, Configuration Manager…) has its own colour in the trees, cards and bookmarks.', 'terminal'],
    ['🛢', 'Databases from the port', 'Type a port and WorkHub knows the database: 1521–1529 is Oracle, 5432–5439 PostgreSQL. Database results show a SQL button and a ready-to-copy JDBC string.', 'dashboard'],
    ['🔎', 'Details pop-up', 'Click any search result (a tile or a table row) to see every detail with its own Copy button, plus Copy all. ▦ Cards / ☰ Table at the top switch between tiles and a grid.', 'dashboard'],
    ['🕑', 'When and where from', 'Every item shows when it was captured and where from — copied, pasted, Outlook, Chrome or Edge bookmark, screenshot or typed in. Captured again? The password that already connected is kept; the new one is listed under Other passwords.', 'dashboard'],
    ['↗', 'Open in PuTTY, FileZilla, SQL Developer, DBeaver', 'Open a saved server in the real PuTTY (with password and tunnels) or FileZilla, a PostgreSQL or Oracle database in DBeaver (connects straight away) or SQL Developer (password copied, ready to paste). On tiles (Open in ↗), in Details and on right-click. Set where the programs are with ↗ Programs….', 'dashboard'],
    ['✅', 'Completed Jira issues', 'The Jira page has 📂 In progress and ✅ Completed folders. Issues assigned to you that are done are added to Completed automatically (or with “Add my completed”), with their pull requests and CM- items.', 'jira'],
    ['🔎', 'Search finds Jira too', 'The main search also shows matching Jira issues — by key, summary, status, pull request or CM- item. Click one to open it on the Jira page.', 'dashboard'],
    ['📋', 'Copy all details', 'Right-click a server → Copy all details, or Copy all in the details pop-up, puts every field on the clipboard.', 'terminal'],
    ['🔒', 'PIN lock', '🔒 Lock in the left menu (or Ctrl+L) locks WorkHub; set a PIN by right-clicking it or clicking it the first time. WorkHub starts locked and locks itself after the minutes you choose. Change PIN anytime; Forgot PIN emails a code to your profile email, or use the recovery code shown when you set it.', ''],
    ['📅', 'Calendar', 'A Calendar page with your own events (reminders, repeats like every weekday), your Outlook meetings (classic Outlook on Windows) and CM implementation windows from Jira. You get a reminder before each CM window starts — choose how early with “CM reminder”.', 'cal'],
    ['⟳', 'Updates', 'WorkHub checks for a newer version when it starts and asks before updating — your data stays as it is. ⟳ Check for updates in the left menu, or tell the chat “check for updates”.', ''],
    ['👤', 'Your profile', '👤 in the left menu: your name, email, phone, work ID, team and role — kept only on this PC. “Forgot PIN” can email a code to that address (through your Outlook), and “Copy my details” copies them for forms.', ''],
    ['👁', 'Passwords hidden', 'Passwords show as •••••••• — click 👁 next to one to see it, or 👁 Show passwords on the dashboard for all. Copying still copies the real password.', 'dashboard'],
    ['🧩', 'Jenkins job names', 'Jenkins links show their job (Folder › job #build), so identical “Dashboard [Jenkins]” bookmarks are easy to tell apart.', 'bookmarks'],
    ['🛟', 'Automatic backups', 'A dated zip of your data when WorkHub starts and every morning — only if something changed. Kept next to your data folder; the newest 30 are kept. See 🛟 Backups… in the left menu.', ''],
    ['★', 'Most used first', 'Things you open, connect to or find by searching most often — and most recently — come first everywhere, with a “★ Most used” section in the server trees. A sort or grouping you choose still wins.', 'dashboard'],
    ['🖱', 'Ctrl+Click → new Chrome window', 'Desktop version: a click opens a new tab in your Chrome; Ctrl+Click opens a new Chrome window.', ''],
  ] },
  { v: '1.6', title: 'Jira and SSH tunnels', items: [
    ['◆', 'Jira page', 'Add an issue (PAY-123 or a link): its pull requests and CM- items appear under it.', 'jira'],
    ['⟳', 'SQL Reconnect / Disconnect', 'In the SQL toolbar and on right-click of a connection.', 'sql'],
    ['➜', 'FileZilla arrows', 'Upload/Download are now arrow buttons between the panes.', 'files'],
  ] },
  { v: '1.5', title: 'Desktop icon', items: [
    ['W', 'Taskbar icon', 'WorkHub has its own icon, so it is easy to find on the taskbar.', ''],
  ] },
];

const TIPS = [
  ['Ctrl+L', 'Lock WorkHub (after you set a PIN).'],
  ['Ctrl+K', 'Search everything — servers, links, notes, files.'],
  ['Ctrl+J', 'Open the chat and ask in plain English: “show prod servers”, “group putty by env”, “add jira PAY-123”.'],
  ['Ctrl+B', 'Hide or show the left menu to get more room.'],
  ['Copy anything', 'With “Watch clipboard” on, copied hosts, logins, JDBC strings and ssh commands are captured and organised automatically.'],
  ['Double-click', 'A server in the PuTTY/FileZilla/SQL tree connects straight away; right-click shows everything else.'],
  ['Drag', 'Drag servers onto folders in the trees, and files onto folders in Folders.'],
  ['Workspaces', 'Each customer can have its own workspace — data, groups, naming rules and hidden links never mix.'],
  ['Older copies', 'Every save in Folders keeps the previous version — “Older copies” brings it back.'],
];

const WhatsNew = {
  latest: RELEASES[0].v,

  html() {
    const rel = (r, open) => `<details class="wn-rel" ${open ? 'open' : ''}><summary><b>Version ${esc(r.v)}</b> — ${esc(r.title)}</summary>
      ${r.items.map(([icon, t, d, view]) => `<div class="wn-item"><span class="wn-ic">${icon}</span><div><b>${esc(t)}</b><div class="muted">${esc(d)}</div></div>
        ${view ? `<button class="icon" data-wngo="${view}">Show me</button>` : ''}</div>`).join('')}</details>`;
    return `<div class="wn-tabs"><button data-wntab="new" class="active">✨ What's new</button><button data-wntab="tips">💡 Tips</button></div>
      <div data-wnpane="new">${RELEASES.map((r, i) => rel(r, i === 0)).join('')}</div>
      <div data-wnpane="tips" hidden>${TIPS.map(([k, t]) => `<div class="wn-item"><kbd>${esc(k)}</kbd><div>${esc(t)}</div></div>`).join('')}</div>`;
  },

  open(tab = 'new') {
    const d = $('#whatsNewDlg');
    $('#whatsNewBody').innerHTML = this.html();
    this.tab(tab);
    $('#whatsNewHide').checked = false;
    if (!d.open) d.showModal();
  },

  tab(t) {
    $$('#whatsNewBody [data-wntab]').forEach(b => b.classList.toggle('active', b.dataset.wntab === t));
    $$('#whatsNewBody [data-wnpane]').forEach(p => (p.hidden = p.dataset.wnpane !== t));
  },

  async close() {
    if ($('#whatsNewHide').checked) await api('POST', '/api/tips', { hidden: this.latest }).catch(() => {});
    $('#whatsNewDlg').close();
  },

  // At start-up: once per session, unless hidden for this release.
  async startup() {
    try { if (sessionStorage.getItem('wnShown') === this.latest) return; } catch { /* ignore */ }
    const r = await api('GET', '/api/tips').catch(() => null);
    if (!r || r.hidden === this.latest) return;
    try { sessionStorage.setItem('wnShown', this.latest); } catch { /* ignore */ }
    this.open();
  },
};

$('#whatsNewBtn').onclick = () => WhatsNew.open();
$('#whatsNewClose').onclick = () => WhatsNew.close();
$('#whatsNewDlg').addEventListener('cancel', e => { e.preventDefault(); WhatsNew.close(); }); // Esc
$('#whatsNewBody').addEventListener('click', e => {
  const t = e.target.closest('[data-wntab]'); if (t) return WhatsNew.tab(t.dataset.wntab);
  const go = e.target.closest('[data-wngo]'); if (go) { WhatsNew.close(); show(go.dataset.wngo); }
});
setTimeout(() => WhatsNew.startup(), 900);
