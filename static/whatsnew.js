'use strict';
// "What's new & tips": opens by itself once when a new version is first
// started, and from ✨ (top of the sidebar) or the ☰ menu any time. Add a release at the
// top of RELEASES for every new version.

const RELEASES = [
  { v: '1.9.7', title: 'Settings in one place', items: [
    ['📌', 'Install for easy access', '⚙ Settings → This PC → Install copies WorkHub to your own programs folder (safe from Downloads clean-ups and accidental deletes), adds it to the Start menu — and, if you tick them, the Desktop and Start with Windows — then restarts it from there. Your data is not moved.', ''],
    ['↔', 'Calendar gets the room', 'Calendar now shrinks the sidebar like SSH and Tasks, and clicking the current page\'s icon again switches the sidebar on every page.', 'cal'],
    ['⚙', 'Settings', 'Theme, menu position, profile, PIN lock, master password, data folder, backups, session logs, “Open in” programs and the tray switch are now in ☰ → ⚙ Settings. The ☰ menu keeps only everyday actions.', ''],
  ] },
  { v: '1.9.6', title: 'General thread, thread formatting, PuTTY look, transfers, disconnect', items: [
    ['🧵', 'General thread', 'Tasks has a General thread (marked default): whatever Watch clipboard captures goes there when no other thread has 📥 Capture here on. Turning Capture here off in a thread sends captures back to General; ✕ in the sidebar stops thread captures.', 'tasks'],
    ['𝐁', 'Bold, italic and lists in threads', 'A small bar above the thread box: B, I, U, S, bulleted and numbered lists, clear formatting — also for replies and edited posts (Ctrl+B / Ctrl+I / Ctrl+U work too).', 'tasks'],
    ['🗄', 'Archive a thread', 'Thread ⋯ → Archive hides it from the list (Show archived brings it back). It still turns up in search.', 'tasks'],
    ['🖥', 'SSH looks like PuTTY', 'The terminal uses PuTTY\'s Courier New font, its colours on black and a steady block cursor.', 'terminal'],
    ['📝', 'Session logs', '⚙ Settings: switch on “Save SSH session text” and what each terminal shows is kept per server and day, plain text, searchable (“what did I run on that server last Tuesday?”). Off unless you turn it on; kept 180 days.', 'terminal'],
    ['☁', 'Backups to OneDrive', '⚙ Settings → 🛟 Backups → ☁ Use OneDrive (or Choose folder…) copies every automatic backup there too, newest 30 kept. With a master password on, a backup opens on any PC with that password — e.g. a new laptop.', ''],
    ['🔽', 'Keeps running in the tray (Desktop)', 'Closing the WorkHub window now hides it to the tray (next to the clock) — clipboard capture, tunnels and transfers carry on. Click the icon to open it again; right-click → Quit WorkHub to stop. Switch it off in ⚙ Settings.', ''],
    ['⇅', 'Transfers panel', 'Under the FTP panes: every upload and download with progress and speed, Cancel, Retry for failed ones, Show to find a downloaded file in This PC, and Clear finished.', 'files'],
    ['☰', 'Bookmarks as a table', 'Bookmarks → ☰ Table shows every link in full: name, app, URL, user, environment, folder, how often and when you last opened it. Drag a column edge to resize, click a heading to sort, click a row to open. ▦ Tiles switches back.', ''],
    ['▭', 'Wider bookmark tiles', 'In ▦ Tiles view, drag the ▭ slider to make the tiles wider and see more of each name.', ''],
    ['⏏', 'Disconnect SSH, FTP and SQL', 'Right-click a connected server (green ●) → ⏏ Disconnect SSH / FTP. FTP has a ⏏ Disconnect button next to the server name, SSH a ⏏ Disconnect all on the tab bar, and ☰ → Disconnect all closes every session (command prompts on this PC stay).', 'terminal'],
  ] },
  { v: '1.9.5', title: 'Attachments download, data folder shown, more login lists', items: [
    ['📁', 'Where your data is', '☰ shows your data folder — click to open it in Explorer, or copy its path. Data location… shows the current folder before you change it.', ''],
    ['⬇', 'Click an attachment to download it', 'In task threads, clicking a 📎 file saves it to your Downloads folder instead of opening a browser tab (older posts too).', 'work'],
    ['👥', 'More login lists understood', 'A server followed by user/password lines (no spaces around the slash), even with blank lines between them, now makes one connection per user.', 'terminal'],
    ['📎', 'Attachments kept as normal files', 'Files you drop into threads or Properties are saved as they are in the attachments folder of your data (no longer encrypted). Files added before stay readable.', 'work'],
  ] },
  { v: '1.9.4', title: 'Master password, change a password everywhere, tidier screens', items: [
    ['🗂', 'One server, its users underneath', 'In the SSH and FTP trees, a server with several logins shows once (with 👤 and the number of users); its users are listed under it. Double-click a user to connect as them; right-click the server to add another login.', 'terminal'],
    ['🧹', 'Tidier dashboard and trees', 'The dashboard shows only tiles you can act on (Need attention, New to sort, Captured today, Re-test) with the counts in one line. Cards are about half the height: the host isn’t repeated, Open in / Details / Edit appear when you point at a connection, and where it was captured from is in Details. The server tree is wider on big screens (drag its edge to resize) and users under a server take one line.', ''],
    ['🔐', 'Master password', '☰ → 🔐 Master password… : WorkHub then asks for it the first time each new version starts, and your saved connections and passwords can\'t be opened without it — not even from a copy of the data folder. The recovery code is emailed to you, in case you forget the password.', ''],
    ['🔑', 'Change a password everywhere', 'When a user’s password changes, right-click any of their connections → 🔑 Change … password everywhere (or ☰ menu). Every connection that logs in as that user is listed — untick any to leave alone — and can be re-tested straight after. Old passwords stay in each connection’s history.', 'terminal'],
    ['🟥', 'PROD terminals stand out', 'A terminal on a PROD server has a red tab with a PROD badge and a thin red frame. Commands set to run after connecting ask first on PROD.', 'terminal'],
    ['✂', 'Shorter names in the trees', 'Tree rows no longer repeat the host: “Batch” with ops@acme-bat-01… underneath. The dashboard hides “Captured today” when there is nothing new.', 'terminal'],
    ['⌨', 'Keyboard in the server trees', 'Click the SSH, FTP or SQL tree, then ↑ ↓ to move, → ← to open and fold, Enter to connect.', 'terminal'],
    ['⚡', 'Reconnect in one click', 'With no session open, the SSH page shows your last used servers — click one to connect.', 'terminal'],
    ['🌲', 'Cleaner trees', 'No 🖥 on every row; a folder whose servers are all in one environment shows its badge on the folder line instead of an extra level; the tree buttons say what they do (🏷 Names, + New, ⊟ Fold).', 'terminal'],
    ['📁', 'FTP remembers your folder', 'This PC opens where you were last time, and the ➜ / ← buttons say what they will copy.', 'files'],
    ['🎨', 'Calmer colours', 'PROD cards keep their red badge with a softer edge, “No password or key” on its own is plain text, and the folded sidebar has lines between Find, Connect and Tools.', ''],
    ['↻', 'Restart now or at next start', 'Update now tells you WorkHub will restart and asks: ↻ Restart now, or Update at next start — the new version is installed and starts the next time you open WorkHub, so you can finish what you are doing.', ''],
  ] },
  { v: '1.9.3', title: 'Several users on one server', items: [
    ['👥', 'Paste a server with several logins', 'Copy or paste a server with a list of users and passwords — one “ssh user@host pass …” per line, a server line then “user: … password: …” or “user / password” lines, or a Host / User / Password table. Each user becomes its own connection in SSH and FTP; double-click connects as that user.', 'terminal'],
    ['🏷', 'Connections named host-user', 'Logins are named like srv-07.uat.acme.local-deploy (databases host-user / service), so several users on one server stay apart. Names you typed yourself are kept.', 'terminal'],
  ] },
  { v: '1.9.1', title: 'Jira issues fix, Help', items: [
    ['👤', 'All your Jira issues', 'Jira → 👤 Add my issues (and the automatic check every 15 minutes) now adds everything assigned to you — open issues under 📂 In progress, done ones under ✅ Completed. Fixed: with “Sign in with browser” on Jira Cloud no issues were found.', 'jira'],
    ['↔', 'Click again to toggle the sidebar', 'On SSH, FTP, SQL, Tasks and the other tree pages, clicking the page’s icon again switches the sidebar between icons only and full size.', ''],
    ['🧩', 'Child work items under each Jira issue', 'Every sub-task and child issue (an epic’s stories) is listed under its issue on the Jira page — any key, not only CM- — with its type and status.', 'jira'],
    ['🔒', 'Jira is read-only for WorkHub', 'WorkHub only reads from Jira; any request that could change something is refused before it leaves your PC. “Remove” is now “Stop tracking” (it never touched Jira).', 'jira'],
    ['🔗', 'Jira keys are links', 'Click an issue’s key (in the Jira tree, on its page, in search results, CM and child items) to open the ticket in the browser.', 'jira'],
    ['⇡', 'Steadier menu at the top', 'With the menu at the top, switching pages no longer moves the icons.', ''],
    ['❓', 'Help', 'F1 or ☰ → Help: how-to topics with steps and a Show me button. Or ask the assistant (Ctrl+J) “how do I …?” — it answers with the steps.', ''],
  ] },
  { v: '1.9', title: 'Task threads, smarter search, tidier layout', items: [
    ['🧵', 'Tasks: a thread per task (replaces work items)', 'Tasks in the sidebar: one thread per ticket or change. Post notes, paste screenshots (Win+Shift+S, Ctrl+V), drop files. Press 📥 Capture here and everything the clipboard watcher catches lands in the thread too. Right-click any server or capture → Add to task thread. Your old work items are threads now, with their page as the first post; the Word copy is kept up to date.', 'tasks'],
    ['🔎', 'Search at the top right, everywhere', 'One search box sits at the top right of every page (Ctrl+K from anywhere). Typing shows the results on the dashboard; keys, filters and recent searches drop down under it.', 'dashboard'],
    ['⇡', 'Menu at the top or on the left', 'The ▭ button at the top of the menu (or ☰ → Menu at the top) moves the menu into a bar across the top of the window — and back. Remembered.', ''],
    ['↗', 'Open Folders files in their program', 'Folders: right-click a file → Open, or ↗ Open on the file — it opens in its default program (Word, Excel, Notepad…).', 'ref'],
    ['↔', 'More room when connecting', 'Pages with their own list on the left (SSH, FTP, SQL, Tasks, Folders, Jira, Groups, Notes, Git) shrink the sidebar to icons — whether you click them or open a connection — so the tree and the window get the space. Dashboard, Bookmarks, Captured and Calendar bring it back; » expands it any time.', 'terminal'],
    ['🛡', 'WorkHub’s own link is never captured', 'Copying WorkHub’s sign-in link (127.0.0.1…?t=…) is ignored, and old captures of it are cleaned up; repeated old captures of the same text are merged.', 'inbox'],
    ['◆', 'Threads linked to Jira', 'In a thread: ◆ Link Jira… (a key in the thread name links it automatically). The issue’s status shows beside it and it is tracked on the Jira page. On the Jira page, 🧵 Thread / Start thread opens or creates the linked thread; a CM reminder offers its thread too.', 'tasks'],
    ['⤓', 'Import Word documents as tasks', 'Tasks → ⤓ Import Word… (or drop .docx files on the thread list): each document becomes a thread — one post per heading (at the top heading level it uses) — keeping lists, links, tables and pictures. Word copies made by WorkHub come back as their separate posts, replies and pins.', 'tasks'],
    ['⬇', 'Markdown export', 'A thread’s ⋯ menu: Export as Markdown saves a .md file (screenshots in a folder beside it) next to the Word copy; Copy as Markdown is ready to paste into Jira, Confluence or Teams.', 'tasks'],
    ['💬', 'Replies and pins in threads', 'Hover a post: 💬 replies to it (replies sit indented under the post; long ones fold to the last two). ⋯ → 📌 Pin to the top keeps key posts, servers or screenshots in a bar at the top of the thread — click one to jump to it.', 'tasks'],
    ['🔎', 'Threads in the main search', 'Searching the dashboard also finds task threads — by title or anything posted in them — with a short preview (passwords hidden). Click one to open it.', 'dashboard'],
    ['🔑', 'Key / SSO logins', 'Edit a server and tick “Logs in with a key / SSO” (or use ⋯ / the Table bulk bar): it stops being flagged for a missing password.', 'dashboard'],
    ['📋', 'No duplicate captures', 'Copying the same text again no longer adds another capture.', 'inbox'],
    ['🌓', 'Light or dark', '☰ → Theme: follow Windows, light or dark.', ''],
    ['💬', 'Ask moved to the top', 'The assistant button now sits at the top of the sidebar instead of floating over the page.', ''],
    ['🔒', 'Passwords hidden in captured text too', 'The Captured page, Groups and Details now mask passwords inside the text you captured (password:, pwd=, -pw, user:pass@, “user / password”). 👁 shows one; Show passwords shows all.', 'inbox'],
    ['⋯', 'Delete is tucked away, with Undo', 'Cards have a ⋯ menu (copy, duplicate, move, delete) instead of a red Delete button. After deleting, Undo puts it back.', 'dashboard'],
    ['🎛', 'One View menu', 'Dashboard: the search box has the full width; filters, grouping, layout, card size and passwords are under View ▾.', 'dashboard'],
    ['📝', 'Notes and a clearer sidebar', 'Notepad++ is now Notes, Folders has its own icon, and the sidebar links sit under Find, Connect and Tools.', ''],
    ['🧹', 'Tidier sidebar', 'Updates, programs, backups, data location and Quit are in ☰ at the top; ✨ opens this window any time (it now opens by itself only once per new version). Capture options fold under “Saving to …”.', ''],
    ['▤', 'Applications × environments grid', 'Dashboard → ▤ Grid: one row per application, one column per environment (DEV, UAT, PROD…). Click a server for details; empty cells show where no server is known.', 'dashboard'],
    ['★', 'Saved searches', 'Type a search (e.g. env:prod app:batch), press ☆ Save search: it stays in the sidebar with a live count. Right-click to rename, change or delete.', 'dashboard'],
    ['📥', 'New captures to sort', 'Newly captured servers are marked 📥 with a suggested folder (where their neighbours live). One click moves them, or keep them where they are. The 📥 tile lists them all.', 'dashboard'],
    ['⌨', 'Ctrl+Alt+W from anywhere (Desktop version)', 'Press Ctrl+Alt+W in any program: WorkHub comes to the front with the search box ready — type, Enter, connected.', 'dashboard'],
    ['✍', 'Forgiving search and recent searches', 'Small typos still find things (“uta” → UAT, “jenkns” → Jenkins). Your last searches appear under the search box, one click to run again.', 'dashboard'],
    ['☑', 'Change many at once', 'Table view: tick rows (or a whole group), then set the environment, move to a folder, add a tag, re-test or delete them together.', 'dashboard'],
    ['↻', 'Re-test connections, spot old ones', 'The ↻ tile re-tests every connection shown and updates ✓/✗. Entries untouched for 90 days show 💤 (search is:stale).', 'dashboard'],
    ['📋', 'See what a capture came from', 'Details now shows the text each entry was read from, so you can check it.', 'dashboard'],
    ['🌲', 'Roomier server trees', 'The SSH, FTP and SQL trees start wider, the filter box has its own row, and hovering a server shows its full name.', 'terminal'],
    ['🔎', 'Smarter search', 'Best match first (exact host or IP on top). Naming-rule labels are searched too (“batch uat”), and acmebat01 finds acme-bat-01. Filters: env:prod type:db user:ops app:batch port:1521 has:password no:env is:fail -word.', 'dashboard'],
    ['⌨', 'Search from the keyboard', 'In the search box: ↑/↓ choose a result, Enter connects or opens it, Shift+Enter shows details, Alt+P / Alt+U / Alt+H / Alt+J copy password, user, host, JDBC or URL.', 'dashboard'],
    ['⚠', 'Needs attention', 'Connections missing a user, password, environment or service name, or whose last login failed, show a ⚠ — click it to fill in. The ⚠ tile on the dashboard lists them all (needs:attention).', 'dashboard'],
  ] },
  { v: '1.8', title: 'Jira browser sign-in, macros, Open in', items: [
    ['🔑', 'Jira: Sign in with browser (Desktop version)', 'Jira settings → Sign-in type “Sign in with browser”: log in to Jira in a small window with your normal login (SSO too) — no token needed. WorkHub keeps the session alive and signs in again by itself when it can.', 'jira'],
    ['▶', 'Run macros', 'Edit an SSH connection → “Commands to run after connecting” (one per line) and tick Run macros: they are typed in one by one each time the session connects.', 'terminal'],
    ['↗', 'Open in the real programs from more places', 'Right-click a search result or a connection in the tree: Open in PuTTY / FileZilla for servers, SQL Developer (Oracle) or DBeaver for databases. The Edit dialog has the same buttons.', 'dashboard'],
    ['☰', 'Menu at the top of the sidebar', '☰ next to WorkHub: Check for updates & install, profile, lock, programs, backups… — and a green “⬆ install” button appears there when a new version is out.', ''],
    ['➕', '+ on every folder', 'In Folders, each folder has its own + : add a sub-folder, a new file, or a link to a folder or file path right there.', 'ref'],
  ] },
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
    if (!d.open) d.showModal();
  },

  tab(t) {
    $$('#whatsNewBody [data-wntab]').forEach(b => b.classList.toggle('active', b.dataset.wntab === t));
    $$('#whatsNewBody [data-wnpane]').forEach(p => (p.hidden = p.dataset.wnpane !== t));
  },

  close() { $('#whatsNewDlg').close(); },

  // At start-up: only the first time this version runs (remembered on this PC).
  async startup() {
    const r = await api('GET', '/api/tips').catch(() => null);
    if (!r || r.hidden === this.latest) return;
    await api('POST', '/api/tips', { hidden: this.latest }).catch(() => {}); // seen
    this.open();
  },
};

$('#whatsNewBtn').onclick = () => WhatsNew.open();
$('#whatsNewTop').onclick = () => WhatsNew.open();
$('#whatsNewClose').onclick = () => WhatsNew.close();
$('#whatsNewDlg').addEventListener('cancel', e => { e.preventDefault(); WhatsNew.close(); }); // Esc
$('#whatsNewBody').addEventListener('click', e => {
  const t = e.target.closest('[data-wntab]'); if (t) return WhatsNew.tab(t.dataset.wntab);
  const go = e.target.closest('[data-wngo]'); if (go) { WhatsNew.close(); show(go.dataset.wngo); }
});
setTimeout(() => WhatsNew.startup(), 900);
