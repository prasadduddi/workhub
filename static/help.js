'use strict';
// Help: how-to topics with steps, searchable in the Help window (☰ → Help,
// F1) and answered in the chat ("how do I link a thread to Jira?"). Works
// offline: the answers are written here, matched by words in the question.

const HELP_TOPICS = [
  // ---- Finding things ----
  { t: 'Search for anything', k: 'search find look ctrl k top right box results', v: 'dashboard', s: [
    'Click the search box at the top right (or press Ctrl+K on any page).',
    'Type part of a host, IP, name, user, URL, note or Jira key — typos are fine (“uta” finds UAT).',
    'Results show on the Dashboard, best match first; task threads and Jira issues appear too.',
    'Press ↑/↓ to choose, Enter to connect or open, Shift+Enter for details; Alt+P / Alt+U / Alt+H / Alt+J copy password / user / host / JDBC.'] },
  { t: 'Filter the search (env:prod, type:db…)', k: 'filter filters env type user app port has no is needs stale unsorted narrow prod uat database only', v: 'dashboard', s: [
    'Type filters in the search box, with or without words: env:prod, type:db, type:ssh, user:ops, app:batch, port:1521.',
    'has:password / no:env / has:tunnels / has:commands look for what an entry has or lacks.',
    'is:fail, is:stale (unused 90 days), is:unsorted (new captures), needs:attention (missing details).',
    'Put a minus in front to leave out: -prod, -env:uat.',
    'Click into the search box to see this list and your recent searches.'] },
  { t: 'Save a search in the sidebar', k: 'saved searches save search sidebar star favourite query keep', v: 'dashboard', s: [
    'Type a search, e.g. env:prod app:batch.',
    'Press ☆ next to the search box and give it a name.',
    'It appears under Saved searches in the sidebar with a live count — one click runs it.',
    'Right-click it to rename, change or delete.'] },
  { t: 'See applications × environments', k: 'grid map matrix applications environments overview gaps view layout', v: 'dashboard', s: [
    'On the Dashboard open View ▾ and choose ▤ Grid.',
    'Each row is an application (from naming rules or the host name), each column an environment.',
    'Shaded cells are gaps: no server known for that app in that environment.',
    'Click a server for its details.'] },
  { t: 'Change many entries at once', k: 'bulk many several select tick multiple change env move tag delete retest', v: 'dashboard', s: [
    'On the Dashboard open View ▾ → Layout → ☰ Table.',
    'Tick the rows (or a group’s header box).',
    'Use the bar that appears: Set environment, Move to folder, Add tag, ↻ Re-test, 🔑 Key login or Delete.',
    'Deleting shows Undo for a few seconds.'] },
  { t: 'Fix entries that need attention (⚠)', k: 'attention warning missing password username environment service fix incomplete', v: 'dashboard', s: [
    'Click the ⚠ Need attention tile on the Dashboard (or search needs:attention).',
    'Each entry shows what is missing; click the ⚠ to open Edit and fill it in.',
    'Servers that log in with an SSH key or SSO: tick “Logs in with a key / SSO” in Edit (or ⋯ menu) so they stop being flagged.'] },
  { t: 'Re-test connections', k: 'retest test check status working failed connection all refresh', v: 'dashboard', s: [
    'On the Dashboard press the ↻ Re-test tile — it tries every connection shown (4 at a time) with its saved login.',
    'To test only some, tick them in the Table view and press ↻ Re-test.',
    'Failed ones get a grey ✕; search is:fail to list them.'] },

  // ---- Capturing ----
  { t: 'Capture details from the clipboard', k: 'capture clipboard watch copy paste automatically collect gather hosts passwords', v: 'inbox', s: [
    'Turn on Watch clipboard in the sidebar.',
    'Copy any text with hosts, users, passwords or links (an email, Teams message, wiki page) — WorkHub files what it recognises.',
    'Click “Saving to …” under the switch to choose the project new captures go to.',
    'Everything captured is listed on the Captured page; copying the same text twice is ignored.'] },
  { t: 'Protect WorkHub with a master password', k: 'master password protect encrypt data start startup secure copy stolen laptop access recovery code forgot', v: '', s: [
    '☰ → 🔐 Master password… → type a password (8+ characters) twice and your email → Turn on.',
    'The recovery code is emailed to you (through Outlook) — keep that email; it is the only way in if you forget the password.',
    'From then on WorkHub asks for the password the first time each new version starts (after an update); your data can\'t be opened without it, even from a copy of the data folder.',
    'Forgot it? On the start screen type the recovery code from the email instead, then choose a new password (a new code is emailed).',
    'Change it or turn it off in the same place (needs the current password). The PIN (🔒 Lock) still locks the open app when you are away.'] },
  { t: 'Team access password', k: 'access password team download first start copy who gave', v: '', s: [
    'A copy of WorkHub may ask for a team access password the first time it starts on a PC.',
    'Ask the person who gave you WorkHub for it. It is asked only once per PC.'] },
  { t: 'Change a password on every server', k: 'change update new password rotate expired everywhere all servers user same', v: 'terminal', s: [
    'Right-click a connection of that user (in a tree, or ⋯ on its card) → 🔑 Change … password everywhere. Or ☰ → Change a password everywhere and pick the user.',
    'Type the new password. Every connection that logs in as that user is listed and ticked — untick any that keep the old one.',
    'Change password saves it (the old one stays in history) and, with the box ticked, tests them all.'] },
  { t: 'Which thread gets my captures', k: 'thread capture default general where clipboard copied goes capture here', v: 'tasks', s: [
    'Copied text that Watch clipboard captures goes to the General thread (marked default on the Tasks page).',
    'To send captures to another thread, open it and press 📥 Capture here; press it again to go back to General.',
    'The sidebar under Watch clipboard shows the current thread; ✕ there stops adding captures to any thread.',
    'Text with no server, URL or login in it is only captured when “Capture everything” is on.'] },
  { t: 'Disconnect from a server', k: 'disconnect close end logout session stop ssh ftp sftp sql all', v: 'terminal', s: [
    'Right-click the connected server (green ● in the tree) → ⏏ Disconnect SSH, ⏏ Disconnect FTP or ⏏ Disconnect (databases).',
    'Or: ✕ on an SSH tab / ⏏ Disconnect all on the SSH tab bar; ⏏ Disconnect next to the server name on the FTP page; ⏏ Disconnect in the SQL window.',
    '☰ → Disconnect all closes every SSH, FTP and database session at once.'] },
  { t: 'Use the server tree with the keyboard', k: 'keyboard keys arrow tree navigate move enter connect fold open', v: 'terminal', s: [
    'Click in the SSH, FTP or SQL tree (or Tab to it).',
    '↑ ↓ move, Home / End jump to the top / bottom.',
    '→ opens a folder or server (again steps into it); ← folds it, or steps out to its folder.',
    'Enter connects to the selected login (or opens / folds a folder).'] },
  { t: 'Reconnect to a recent server', k: 'reconnect recent last used servers terminal empty chips', v: 'terminal', s: [
    'With no session open, the SSH page lists your last used servers under Reconnect — click one to connect.'] },
  { t: 'Several users on one server', k: 'several multiple users logins accounts same server host paste list table each user password', v: 'terminal', s: [
    'Copy or paste the server with its logins in any of these shapes:',
    'one per line: ssh deploy@srv-07 pass Dep#1 (pass with or without “:”);',
    'a server line, then lines like user: deploy password: Dep#1, or deploy / Dep#1;',
    'or a table with Host / User / Password columns (the Host column can be left out under a server line).',
    'Each user becomes its own connection named host-user (e.g. srv-07-deploy). In the SSH and FTP trees they sit under one server row (👤 and the number of users): double-click a user to connect as them, right-click the server to add another login.'] },
  { t: 'Sort new captures (📥)', k: 'unsorted inbox new captures sort suggested folder move', v: 'dashboard', s: [
    'New captures show 📥 with a suggested folder (where similar servers live).',
    'Press ✓ Move there, or Keep where it is, or Edit…',
    'The 📥 New to sort tile lists them all, with “Move all to their suggested folders”.'] },
  { t: 'Hide or show passwords', k: 'password passwords show hide mask eye reveal copy', v: 'dashboard', s: [
    'Passwords are shown as dots everywhere, including inside captured text.',
    'Click 👁 next to one to reveal it, or View ▾ → Passwords → Show passwords for all.',
    'Clicking a password (or Alt+P in the search) copies the real one.'] },

  // ---- Connecting ----
  { t: 'Connect with SSH', k: 'ssh putty terminal connect login server shell open', v: 'terminal', s: [
    'Open SSH in the sidebar and double-click a server in the tree (or search for it and press Enter).',
    'Or type user@host[:port] in Quick connect at the top.',
    'Right-click a server for more: tunnels, copy, Open in PuTTY ↗ (the real one), add to a task thread.'] },
  { t: 'Run commands automatically after login (macros)', k: 'macro macros commands automatically after login run sudo cd startup', v: 'terminal', s: [
    'Edit the server (right-click → Edit…).',
    'Type the commands in “Commands to run after connecting”, one per line (lines starting with # are skipped).',
    'Tick Run macros and Save. They are typed in one by one each time the session connects.'] },
  { t: 'Set up SSH tunnels (for databases)', k: 'tunnel tunnels port forward localhost jump database 1521 pageant', v: 'terminal', s: [
    'Edit the jump server and fill Tunnels like PuTTY: 1522:dbhost:1521 (several separated by commas).',
    'Tick Use tunnels; tick “Start when WorkHub starts” to keep them open all the time.',
    'Databases saved as localhost:1522 start the tunnel by themselves when you connect.',
    'Right-click the jump server to start, stop or switch tunnels off.'] },
  { t: 'Transfer files (FTP / SFTP)', k: 'ftp sftp files transfer upload download filezilla copy', v: 'files', s: [
    'Open FTP in the sidebar and double-click a server in the tree.',
    'Your PC is on the left, the server on the right: double-click a file to copy it across, or drag it.',
    'New folder is at the top; Rename and Delete are under ⋯ (once connected).'] },
  { t: 'Query a database (Oracle / PostgreSQL)', k: 'sql query database oracle postgres postgresql jdbc tables select run', v: 'sql', s: [
    'Open SQL in the sidebar and double-click the database (or ▸ to connect and see its tables).',
    'Type SQL and press Ctrl+Enter (or ▶ Run); F5 runs everything as a script.',
    'Auto-commit is off: Commit or Rollback when you change data.',
    'A database needs Type oracle/postgres and the service name / database in Edit; the port alone usually fills the type.'] },
  { t: 'Open in the real PuTTY, FileZilla, SQL Developer or DBeaver', k: 'open in putty filezilla dbeaver sql developer external program real', v: 'dashboard', s: [
    'Right-click a server (tree or search result) → Open in PuTTY / FileZilla / SQL Developer / DBeaver ↗, or use the buttons in Edit.',
    'If a program isn’t found, ☰ → Programs for “Open in” lets you point to it.'] },

  // ---- Tasks ----
  { t: 'Start a task thread', k: 'task tasks thread threads new start create work item ticket change notes', v: 'tasks', s: [
    'Open Tasks in the sidebar and press + New thread (a Jira key in the name links it).',
    'Write a note and press Enter; Shift+Enter for a new line.',
    'Paste screenshots (Win+Shift+S then Ctrl+V) or drop files into the box.',
    'Set the status (To do, In progress, Blocked, Done) at the top.'] },
  { t: 'Capture into a task thread', k: 'capture here thread task active clipboard collect into', v: 'tasks', s: [
    'Open the thread and press 📥 Capture here.',
    'Everything Watch clipboard catches is now also posted to the thread (passwords hidden).',
    'The sidebar shows which thread; ✕ there stops it.',
    'From anywhere: right-click a server or a capture → 🧵 Add to task thread…'] },
  { t: 'Reply to a post or pin it', k: 'reply replies pin pinned thread post top', v: 'tasks', s: [
    'Hover a post and press 💬 to reply; replies sit under the post.',
    '⋯ → 📌 Pin to the top keeps it in the Pinned bar at the top of the thread; click a pin to jump to it.'] },
  { t: 'Link a thread to Jira', k: 'link jira key thread task cm issue', v: 'tasks', s: [
    'In the thread press ◆ Link Jira… and type the key (e.g. PAY-123) or paste the issue link.',
    'The issue’s status shows beside it, and it is tracked on the Jira page.',
    'On the Jira page, 🧵 Thread / Start thread opens or creates the linked thread; CM reminders offer it too.'] },
  { t: 'Import Word documents as tasks', k: 'import word docx document documents tasks thread convert', v: 'tasks', s: [
    'Open Tasks and press ⤓ Import Word… (or drop .docx files on the thread list).',
    'Each document becomes a thread, one post per heading, keeping lists, links, tables and pictures.',
    'Old .doc files: open in Word and Save As .docx first.'] },
  { t: 'Export a thread (Word / Markdown)', k: 'export word markdown md docx handover share copy confluence', v: 'tasks', s: [
    'Open in Word (at the top of a thread) opens the Word copy, always kept up to date.',
    '⋯ → Export as Markdown saves a .md file with screenshots beside it; ⋯ → Copy as Markdown is ready to paste into Jira, Confluence or Teams.'] },

  // ---- Jira ----
  { t: 'Set up Jira', k: 'jira setup token api personal access configure settings connect', v: 'jira', s: [
    'Jira → Jira settings…: enter your Jira address.',
    'Jira Cloud (…atlassian.net): sign-in type “email + API token” — create the token at id.atlassian.com → Security → API tokens.',
    'Jira Server / Data Center: “personal access token” — your Jira profile → Personal Access Tokens.',
    'Or, in the Desktop version, “Sign in with browser” (no token, SSO works).'] },
  { t: 'Does WorkHub change anything in Jira?', k: 'jira change edit write update modify safe read only comment transition delete', v: 'jira', s: [
    'No. WorkHub only reads from Jira — issues, statuses, sub-tasks, child items, CM windows and pull requests.',
    'It never creates, edits, comments on, moves or deletes anything in Jira; anything else is refused before it leaves your PC.',
    '“Stop tracking” on the Jira page only removes the issue from WorkHub.'] },
  { t: 'Sign in to Jira with the browser (Desktop)', k: 'jira browser sign in login sso session desktop', v: 'jira', s: [
    'Use WorkHub-Desktop.exe. Jira → Jira settings… → Sign-in type “Sign in with browser”.',
    'Press 🔑 Sign in with browser…, log in as usual in the window that opens (tick “Remember me”).',
    'WorkHub notices, hides the window and loads your issues; it keeps the session alive while it runs.'] },
  { t: 'My Jira issues don’t show', k: 'jira issues stories missing not showing empty fetch tickets assigned mine', v: 'jira', s: [
    'Press 👤 Add my issues on the Jira page: it adds everything assigned to you — open ones under 📂 In progress, done ones under ✅ Completed.',
    'If it shows an error, check Jira settings (address, sign-in) — with browser sign-in, press 🔑 Sign in again.',
    'Other issues: type their keys or paste links in the box at the top of the Jira page.',
    'Each issue lists its 🧩 Child work items (sub-tasks and child issues, any key) and its CM- items; click a key to open the ticket in the browser.',
    'It is checked again every 15 minutes.'] },

  // ---- Calendar ----
  { t: 'Calendar and reminders', k: 'calendar event reminder meeting outlook remind', v: 'cal', s: [
    'Open Calendar: your events, Outlook meetings and CM change windows from Jira.',
    'Click a day (or + New event) to add one, with a reminder and repeat.',
    'Reminders pop up even when WorkHub is locked.'] },
  { t: 'CM implementation reminders', k: 'cm change window implementation reminder planned start', v: 'cal', s: [
    'CM items under your Jira issues with a planned start/end show on the Calendar.',
    'A reminder pops up before the window starts; it offers the task thread linked to that CM (or its issue).'] },

  // ---- Organising ----
  { t: 'Name servers with rules (Batch, Touchpoint…)', k: 'naming rules label rule name app colour bat tpp', v: 'bookmarks', s: [
    'Bookmarks → Naming rules… (or 🏷 in a server tree).',
    'One rule per line: -BAT- = Batch. Any host containing -BAT- is labelled Batch.',
    'Labels can be searched (app:batch) and drive the Grid rows.'] },
  { t: 'Folders of reference files', k: 'folders files reference json yaml properties link path open default program', v: 'ref', s: [
    'Open Folders: + on a folder adds a sub-folder, a new file or a link to a folder/file anywhere.',
    'Drop files or whole folders in to keep a copy (older copies are kept).',
    'Right-click a file → ↗ Open to open it in its own program (Word, Excel, Notepad…).'] },
  { t: 'Groups', k: 'group groups patterns gather application', v: 'groups', s: [
    'Groups gather everything matching some words: servers, links, open windows, notes, captures.',
    'Press + New group and give it patterns (server names, hosts, words).'] },

  // ---- WorkHub itself ----
  { t: 'Lock WorkHub with a PIN', k: 'lock pin security forgot reset idle', v: '', s: [
    'Right-click 🔒 at the bottom of the sidebar (or ☰ → Lock) to set a PIN and the idle time.',
    'Ctrl+L locks now. Forgot the PIN: use the recovery code, or have a code emailed to the address in your profile.'] },
  { t: 'Update WorkHub', k: 'update upgrade new version install check restart later next start', v: '', s: [
    '☰ → Check for updates & install (a green ⬆ button appears at the top when there is one).',
    'Update now tells you WorkHub will restart; choose ↻ Restart now, or Update at next start to keep working — the new version starts the next time you open WorkHub.',
    'Your data stays as it is. Until you restart, ☰ (and the ⬆ button) offer ↻ Restart to finish.'] },
  { t: 'Backups and data location', k: 'backup backups restore data location folder move', v: '', s: [
    'WorkHub backs up at start-up and every morning (when something changed); ☰ → Backups… shows them.',
    'To restore: quit, unzip a backup into an empty folder, start WorkHub and pick it with ☰ → Data location…'] },
  { t: 'Menu on the left or at the top', k: 'menu sidebar top left layout move collapse icons room wide', v: '', s: [
    'The ▭ button at the top of the menu (or ☰ → Menu at the top) moves it into a bar across the top; again to move it back.',
    'On SSH, FTP, SQL, Tasks and other tree pages the sidebar shrinks to icons; click that page’s icon again (or ») to bring it back to full size.'] },
  { t: 'Light or dark theme', k: 'theme dark light mode colours', v: '', s: ['☰ → Theme: follow Windows, light or dark.'] },
  { t: 'Keyboard shortcuts', k: 'keyboard shortcuts keys hotkey ctrl', v: '', s: [
    'Ctrl+K search · Ctrl+J assistant · Ctrl+L lock · Ctrl+B sidebar · F1 help.',
    'Desktop version: Ctrl+Alt+W in any program brings WorkHub up with the search ready.',
    'In the search: ↑/↓, Enter, Shift+Enter, Alt+P / U / H / J.'] },
];

const HELP_STOP = new Set('how do i can you to the a an of in on for and or my me is are it this that with what where why when does should be get set use using make from into at by please'.split(' '));
const helpWords = t => t.toLowerCase().replace(/[^a-z0-9:+.\- ]/g, ' ').split(/\s+/).filter(w => w && !HELP_STOP.has(w)).map(w => w.replace(/(ing|ed|es|s)$/, ''));

const Help = {
  // Topics ranked for a question; words in the title and keywords count.
  rank(q) {
    const ws = helpWords(q);
    if (!ws.length) return [];
    return HELP_TOPICS.map(h => {
      const title = helpWords(h.t), keys = helpWords(h.k);
      let score = 0;
      for (const w of ws) {
        if (title.includes(w)) score += 3;
        else if (keys.includes(w)) score += 2;
        else if (w.length > 3 && [...title, ...keys].some(x => x.startsWith(w) || w.startsWith(x))) score += 1;
      }
      return { h, score };
    }).filter(x => x.score >= 2).sort((a, b) => b.score - a.score).map(x => x.h);
  },
  stepsHTML(h) { return `<ol class="helpsteps">${h.s.map(x => `<li>${esc(x)}</li>`).join('')}</ol>`; },

  // The chat's answer to a question, or '' when nothing fits.
  answer(q) {
    const r = this.rank(q);
    if (!r.length) return '';
    const h = r[0];
    return `<b>${esc(h.t)}</b>${this.stepsHTML(h)}${h.v ? `<button class="icon" data-helpgo="${h.v}">Show me</button> ` : ''}<button class="icon" data-helpopen="${esc(h.t)}">More help…</button>`
      + (r.length > 1 ? `<div class="muted tiny" style="margin-top:6px">See also: ${r.slice(1, 4).map(x => `<a href="#" data-helpopen="${esc(x.t)}">${esc(x.t)}</a>`).join(' · ')}</div>` : '');
  },

  open(topic = '') {
    $('#helpQ').value = topic;
    this.render(topic);
    if (!$('#helpDlg').open) $('#helpDlg').showModal();
    $('#helpQ').focus();
  },
  render(q) {
    const list = q.trim() ? this.rank(q) : HELP_TOPICS;
    const exact = HELP_TOPICS.find(h => h.t === q);
    const show = exact ? [exact, ...list.filter(h => h !== exact)] : list;
    $('#helpList').innerHTML = show.length ? show.map((h, i) => `<details class="helptopic" ${i === 0 && q.trim() ? 'open' : ''}><summary>${esc(h.t)}</summary>${this.stepsHTML(h)}${h.v ? `<button class="icon" data-helpgo="${h.v}">Show me</button>` : ''}</details>`).join('')
      : '<div class="muted" style="padding:10px">No topic matches — try other words, or ask in the chat (Ctrl+J).</div>';
  },
};

$('#helpQ').addEventListener('input', e => Help.render(e.target.value));
$('#helpClose').onclick = () => $('#helpDlg').close();
document.addEventListener('click', e => {
  const go = e.target.closest('[data-helpgo]');
  if (go) { if ($('#helpDlg').open) $('#helpDlg').close(); show(go.dataset.helpgo); return; }
  const op = e.target.closest('[data-helpopen]');
  if (op) { e.preventDefault(); Help.open(op.dataset.helpopen); }
});
document.addEventListener('keydown', e => { if (e.key === 'F1') { e.preventDefault(); Help.open(); } });
