'use strict';
// "What's new & tips": opens by itself once when a new version is first
// started, and from ✨ (top of the sidebar) or the ☰ menu any time. Add a release at the
// top of RELEASES for every new version (the window shows the latest 5).

const RELEASES = [
  { v: '1.13.0', title: 'Import connections, command palette, compare across servers', items: [
    ['⬇', 'Import from DBeaver, PuTTY, FileZilla, SQL Developer', 'File → Import → Connections…: finds them on this PC (or pick a file, e.g. a PuTTY .reg export). Folders, types, service names, environments, users and — where the program keeps them readably — passwords come along; PuTTY port forwards become tunnels. Tick what to bring in; connections you already have only get what they’re missing. Those programs are only read, never changed.', 'terminal'],
    ['⌘', 'Command palette (Ctrl+Shift+P or Ctrl+P)', 'Type to run any menu action, open any page, connect to any server or database, open a thread or an API request. Enter runs it; what you use most comes first.', ''],
    ['🖥', 'Compare files across servers', 'Right-click a server → ⇆ Compare a file with another server…, or 🖥 Server file… in ⇆ Compare: the same config file on UAT and PROD side by side. Read-only over SFTP; password=, secret=, token= values are hidden (a changed value still shows as a difference).', 'ref'],
  ] },
  { v: '1.12.3', title: 'Tabs in their own window', items: [
    ['⧉', 'Pop out a tab', '⧉ on an SSH or SQL tab, ⧉ New window on a thread, or View → Open this page in a new window: it opens in its own window without the sidebar and menus. SQL tabs keep their session (nothing is lost, even uncommitted changes); SSH terminals reconnect with the same login. ⇲ Dock back to WorkHub — or just closing that window — puts it back; the ⧉ chips at the top of WorkHub dock them back too.', 'terminal'],
    ['📌', 'Install from the Tools menu', 'Tools → Install for easy access… opens Settings at This PC with the Install button ready (Windows).', ''],
  ] },
  { v: '1.12.2', title: 'Menu bar, grouped pages, recording dot', items: [
    ['☰', 'Menu bar', 'File · Edit · View · Connect · Tools · Help across the top (Alt+F, Alt+E…): new items, import, backups, lock; search, passwords, settings; pages, sidebar, theme; quick connect, recent, reopen, disconnect all; compare, tail a log, SSH keys; help, shortcuts, updates.', ''],
    ['📋', 'Pages in groups', 'The sidebar holds only pages, in three coloured groups — 📋 My work, 🔌 Connect, 📚 Saved — that fold. Hide pages you don’t use: View → Pages in the sidebar (they stay in View → Go to).', ''],
    ['🔴', 'Recording dot', '“Capturing here” shows a pulsing red dot, like a recorder, on the thread’s button and in the thread list.', 'tasks'],
  ] },
  { v: '1.12.1', title: 'API requests, Compare, Today, PROD safety and more', items: [
    ['🌐', 'API page (like Postman)', 'Send HTTP requests from WorkHub: method, URL, headers, Basic / Bearer / API-key auth and a JSON / XML / text / form body. {{variables}} per environment (DEV, UAT, PROD — ⚙ Environments…, also filled from a saved connection). Answers pretty-printed with search; save requests in folders; History; Copy as curl (secrets stay as {{variables}}); 📌 send request + answer to a thread. Ctrl+Enter sends, Ctrl+S saves.', 'api'],
    ['⬇', 'Import Postman and Bruno collections', 'API page → ⬇ Import: Postman collection and environment files (v2.0 / v2.1), a Bruno collection folder (requests, sub-folders, environments, collection auth and headers) or Bruno’s JSON export. Folders, headers, auth (also inherited), bodies and {{variables}} come along; scripts and tests are listed, not run. Importing again updates the same requests. Right-click a folder → ⬆ Export as Postman collection (Bruno imports it too); ⚙ Environments → ⬆ Export.', 'api'],
    ['⇆', 'Compare files and folders (Folders page)', 'Ctrl+click a second file or folder, right-click → ⇆ Select for compare, or the ⇆ button (also for files and folders anywhere on this PC). Files side by side with the changed characters marked, a map of the differences, ▲▼ / Alt+↑↓ to move between them, ignore whitespace / case, only differences; copy a change → or ← and save. Folders as one tree: ≠ different, ◀ only left, ▶ only right; double-click to compare a file, → / ← copies it across (asks first; the old copy is kept).', 'ref'],
    ['📅', 'Today on the Dashboard', 'Recent connections (one click connects), open threads (unread first), reminders due today and your open Jira issues — above the tiles.', 'dashboard'],
    ['⚠', 'PROD safety', 'Connections in PROD get a red frame (SSH terminal and SQL editor) and a confirm step: before opening a PROD terminal, before pasting several lines into it, before every SQL statement that changes data (read-only queries once per tab) and before Commit.', 'sql'],
    ['↺', 'Reopen your last session', 'After an update WorkHub reopens your SSH terminals, SQL tabs, thread and page by itself; after a normal start it offers to (Reopen). Settings → Reopen last session.', 'terminal'],
    ['🔑', 'My SSH keys (copy for GitHub)', '☰ → My SSH keys (or 🔑 Keys on the SSH page): the public keys in your .ssh folder (and PuTTY .ppk) with their fingerprints and 📋 Copy for GitHub, plus the hosts in .ssh/config. WorkHub only reads that folder — it never changes it, and private keys are never read.', ''],
    ['⌨', '? for shortcuts', 'Press ? (when not typing) for every keyboard shortcut on one sheet.', ''],
    ['𝐁', 'Ctrl+B / I / U in messages', 'Bold, italic and underline (Ctrl+Shift+X strikethrough) in thread messages; Ctrl+B still hides the sidebar elsewhere.', 'tasks'],
  ] },
  { v: '1.11.1', title: 'Follow a log on several servers at once', items: [
    ['📜', 'Tail a log on all servers', 'Right-click a folder, environment or group → 📜 Tail a log on all N servers…: the same file followed on every server in one window, each line tagged with its server in its own colour. Click a server chip to hide / show its lines (double-click: only that one); its dot shows connected or ✕ failed. Servers without a saved login ask once for all of them.', 'terminal'],
  ] },
  { v: '1.11.0', title: 'SQL snippets, a live log viewer, move messages', items: [
    ['➡', 'Move or copy a message', 'A message’s ⋯ (or right-click) → ➡ Move to another thread… or ⧉ Copy to another thread…. Its replies and pictures go with it; it lands at the end of that thread marked “↪ Moved from …”. Undo is on the notice.', 'tasks'],
    ['📌', 'SQL snippets', 'SQL page → 📌 Snippets (next to History): ＋ Save current statement keeps the selection or the query at the cursor under a name, for this connection or all. Click one to put it in the editor (selected, so Run runs just it); double-click to put it in and run. ⋯ renames, updates, shares or deletes.', 'sql'],
    ['🔎', 'Search your SQL history', 'The History tab has a search box: every word must match.', 'sql'],
    ['📜', 'Tail a log', 'Right-click an SSH server → 📜 Tail a log…: type a path or Find logs changed in the last 3 days, then follow it live in a window you can move and resize while you work. Filter lines (-word leaves out), highlight words (ERROR, WARN, ORA-…), pause, copy, and 📌 send the selected lines (or the last 20) to the capture thread. Only tail and find run on the server.', 'terminal'],
  ] },
  { v: '1.10.3', title: 'Updates download quietly, install when you say', items: [
    ['⬇', 'Background download', 'WorkHub checks for a new version after it starts and every hour and downloads it quietly. Nothing is installed: the ⬆ pill in the sidebar says “downloaded — install”, and installing is then a quick restart (now or next start). No more pop-up on start.', 'dashboard'],
    ['⚙', 'Your choice', 'Settings → Download updates in the background switches it off.', 'dashboard'],
  ] },
  { v: '1.10.2', title: 'Tree with + / − boxes', items: [
    ['⊞', '[+] / [−] to open and close', 'Folders, environments, groups and servers open and close with Windows-style [+] / [−] boxes, like a tree view. The ⊟ Fold button is gone.', 'terminal'],
  ] },
  { v: '1.10.1', title: 'Live connection status, duplicate folders, FileZilla-style lists', items: [
    ['●', 'Status that is true right now', 'In the SSH / FTP / SQL trees the dot is the state now: ● connected, dashed ◌ “disconnected” when a session dropped (its tab is still open), ○ not connected. It changes the moment a session ends; a dead network is noticed within about a minute.', 'terminal'],
    ['⏏', 'Disconnect all on a host', 'Right-click a server (or any connection on it) → ⏏ Disconnect all on this host: closes its SSH terminals, FTP session, SQL connections and running tunnels in one go. Other hosts stay connected. Folders, environments and groups have ⏏ Disconnect all in … too (next to Duplicate), for just the connections inside.', 'terminal'],
    ['📋', 'Copy and Copy all', 'Right-click a connection → Copy puts host, port, username and password (and service / database) on the clipboard in one go; Copy all copies every detail.', 'terminal'],
    ['⏏', 'Disconnect always in the menu', '⏏ Disconnect and ⏏ Disconnect all are always in the right-click menu — greyed out when nothing is connected.', 'terminal'],
    ['⊞', 'Fold / Unfold', '⊟ Fold collapses the tree; it then reads ⊞ Unfold and puts the folders back exactly as they were.', 'terminal'],
    ['✓', 'When it last worked', 'After the name: ✓ 3h = last connected fine 3 hours ago; ✕ = the last try failed (hover for the reason and when it last worked).', 'terminal'],
    ['🗂', 'FTP lists like FileZilla', 'Segoe UI 9pt, compact rows, ruled column headers, Windows-blue selection. The hint text between the panes is gone — the ➜ arrows light up when there is something to copy.', 'files'],
    ['⧉', 'Duplicate folders and groups', 'Right-click a folder, environment or group in the SSH / FTP / SQL tree → Duplicate N connections… Pick the folder for the copies (sub-folders and environments are kept) and, if you like, change host names on the way: uat01→sit02.', 'terminal'],
    ['🖥', 'Duplicate a server', 'Right-click a server with several logins → Duplicate server… copies every login.', 'terminal'],
    ['✎', 'Duplicate one connection', 'Right-click → Duplicate names it “… (copy)” (then “(copy 2)”…), shows that in the trees, and opens the copy so you can change the host or user straight away.', 'terminal'],
  ] },
  { v: '1.10.0', title: 'Find by date and database, see why it matched', items: [
    ['📅', 'Search by date', 'added:today, added:yesterday, added:7d, added:2w, used:week, used:month, used:never — e.g. “added:today type:db” for what you pasted this morning.', 'dashboard'],
    ['🗄', 'db: filter', 'db:ordsvc finds connections by service name, SID or database.', 'dashboard'],
    ['✂', 'Snipping Tool screenshots reach your thread', 'Snips from Snipping Tool / Win+Shift+S are posted to the active thread even when the tool also puts text on the clipboard; snips saved to Pictures\\Screenshots are picked up too (once, not twice). WorkHub now waits for the copy to finish and holds the clipboard only for a moment, so copy and paste in other programs is never blocked.', 'tasks'],
    ['🐘', 'SQL tree like DBeaver', 'Database connections show an Oracle (O) or PostgreSQL (🐘) icon, a short name like “UAT01 - app_user” (environment from the host name, then the user) and the address in grey italics. Names you set yourself are kept.', 'sql'],
    ['🗄', 'Pasted databases default to PostgreSQL', '“database: x” is saved as PostgreSQL; Oracle when the text says oracle or gives a service name / SID. Change Type on the connection if needed.', 'sql'],
    ['🔎', 'Why it matched', 'When your words aren’t in a card’s host or name, a line under it shows where they were found (user, project, database, tag, notes…).', 'dashboard'],
  ] },
  { v: '1.9.9', title: 'Search everything, recent captures, copy-ready strings', items: [
    ['🔎', 'One search for everything', 'The search at the top right now also finds 📝 Notes, 📁 Folders files (names and text, with a snippet) and 📋 Captured text, under connections, threads and Jira. Click a result to open it.', 'dashboard'],
    ['🕘', 'Recently captured', 'The dashboard shows your last few captures (7 days) and what each became. A host saved without a type asks “Is it Oracle / Postgres / SSH?” — one click files it, e.g. into SQL.', 'dashboard'],
    ['🗄', 'Pasted databases land in SQL', '“app DB: host, database: x, username/password: y” is now saved as a database (Oracle unless it says postgres/pg) with user and password both filled.', 'sql'],
    ['📋', 'Copy-ready connection strings', 'A connection’s details start with Copy-ready lines: JDBC, host:port/service and sqlplus for Oracle, psql for PostgreSQL, ssh / sftp for servers.', 'dashboard'],
    ['✅', 'Jira Completed: stories and CMs only', 'The ✅ Completed folder lists only stories and CM issues (with their CM items and PRs); sub-tasks and other work items are left out. In progress is unchanged.', 'jira'],
  ] },
  { v: '1.9.8', title: 'Threads like Slack, smarter capture', items: [
    ['💬', 'Replies in a side panel', 'Hover a message → 💬 (or click “💬 3 replies”) to open the conversation on the right; the main thread stays tidy. Esc closes it.', 'tasks'],
    ['😀', 'Reactions, Save, Remind me', 'Hover a message for ✅ 👀 👍 and more reactions, 🔖 Save for later and ⋯ → ⏰ Remind me (20 min … next Monday). 🔖 Saved above the thread list shows both.', 'tasks'],
    ['✍', 'Type like Slack', '*bold* _italic_ ~strike~ `code`, ``` for a code block (with a Copy button) and :tada: style emoji. Your unsent text is kept per thread; ↑ in an empty box edits your last message.', 'tasks'],
    ['🔴', 'Unread, Starred, Ctrl+K', 'Threads with new messages are bold with a count and a red “New” line; ⭐ Starred / Threads / Done sections; Ctrl+K on the Tasks page jumps to any thread.', 'tasks'],
    ['🔗', 'Previews and links', 'Jira keys and links in a message show a small card; ⋯ → Copy link to this message opens WorkHub right there.', 'tasks'],
    ['📸', 'Screenshots captured', 'A screenshot you copy (Win+Shift+S) goes into the capture thread as a picture — switch it off in ⚙ Settings.', 'tasks'],
    ['🎯', 'Captures find their thread', 'Copied text that mentions a Jira key (PAY-123) goes to the thread linked to it, and every capture shows where it came from (“from Outlook — RE: …”).', 'tasks'],
    ['📝', 'Quick note: Ctrl+Alt+N', 'From anywhere (Desktop version), jot a note into a thread without switching to WorkHub.', 'tasks'],
    ['✉', 'Drop emails on a thread', 'Drag a message from Outlook (or an .eml) onto a thread: subject, sender, date, text and attachments become one message.', 'tasks'],
    ['🖱', 'Right-click everywhere', 'Cards, table rows, bookmarks, captures, threads and messages all have a right-click menu — the same as their ⋯.', ''],
  ] },
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
      <div data-wnpane="new">${RELEASES.slice(0, 5).map((r, i) => rel(r, i === 0)).join('')}</div>
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
