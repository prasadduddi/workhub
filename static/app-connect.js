'use strict';
// WorkHub page, part 3 of 7: SSH terminal, files (local + SFTP), the connection tree.
// The page's script is split into parts loaded in order (index.html); they share one global scope.

// ---------- terminal ----------
// Looks like PuTTY's defaults: Courier New, light grey on black, PuTTY's
// 16 colours, a steady green block cursor.
const PUTTY_FONT = '"Courier New", Courier, "Liberation Mono", monospace';
const PUTTY_THEME = {
  background: '#000000', foreground: '#bbbbbb', cursor: '#00ff00', cursorAccent: '#000000', selectionBackground: '#bbbbbb', selectionForeground: '#000000',
  black: '#000000', red: '#bb0000', green: '#00bb00', yellow: '#bbbb00', blue: '#0000bb', magenta: '#bb00bb', cyan: '#00bbbb', white: '#bbbbbb',
  brightBlack: '#555555', brightRed: '#ff5555', brightGreen: '#55ff55', brightYellow: '#ffff55', brightBlue: '#5555ff', brightMagenta: '#ff55ff', brightCyan: '#55ffff', brightWhite: '#ffffff',
};

const Term = {
  tabs: [], active: null,

  async open(e, opts = {}) {
    if (sshBlocked(e)) return; // SSH switched off (local prompts don't come here)
    if (isProd(e) && !opts.confirmed && !await askYes(`⚠ PROD — open a terminal on a production server?\n\n${prodName(e)}\n\nCommands you type there run on PROD.`)) return;
    let creds = {};
    if (needsCreds(e)) { creds = await askCreds(e); if (!creds) return; }
    this.create(e, creds, null);
  },

  // Pasting several lines runs several commands: on PROD, ask first.
  async pasteOK(t, txt) {
    if (t.local || !isProd(t.entry)) return true;
    const lines = txt.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
    if (lines.length < 2 && !/\n$/.test(txt.replace(/\r\n?/g, '\n'))) return true;
    return await askYes(`⚠ PROD — paste and run ${lines.length} line${lines.length > 1 ? 's' : ''} on ${t.entry.host}?\n\n${lines.slice(0, 8).join('\n')}${lines.length > 8 ? '\n…' : ''}`);
  },

  // A command prompt on this PC (cmd, PowerShell, Git Bash, or the Mac shell).
  openLocal(sh, dir = '') {
    const label = sh.name + (dir ? ' · ' + dir.split(/[\\/]/).filter(Boolean).pop() : '');
    this.create({ id: 'local:' + sh.id, host: 'This PC', name: label, username: '' }, {}, { shell: sh.id, dir, label });
  },

  create(e, creds, local) {
    show('terminal'); roomForWork();
    const el = document.createElement('div');
    el.className = 'termhost' + (!local && isProd(e) ? ' prod' : '');
    if (!local && isProd(e)) el.dataset.prod = `PROD · ${e.host}`;
    $('#termWrap').append(el);
    const term = new Terminal({ cursorBlink: false, cursorStyle: 'block', fontSize: Fonts.size('term'), scrollback: 20000, fontFamily: PUTTY_FONT, theme: PUTTY_THEME, drawBoldTextInBrightColors: true, minimumContrastRatio: 1 });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(el);
    const t = { id: Math.random().toString(36).slice(2), entry: e, creds, term, fit, el, ws: null, closed: true, local };
    this.tabs.push(t);
    // PuTTY-style: selecting copies, right-click pastes, Enter on a dead session reconnects.
    term.onSelectionChange(() => { const s = term.getSelection(); if (s) navigator.clipboard.writeText(s).catch(() => {}); });
    el.addEventListener('contextmenu', async ev => {
      ev.preventDefault();
      try { const txt = await clipText(); if (txt && !t.closed && await this.pasteOK(t, txt)) t.ws.send(JSON.stringify({ t: 'd', d: txt })); } catch { toast('Allow clipboard access to paste with right-click (or use Ctrl+V)', true); }
    });
    term.onData(async d => { // keys go straight through; only a paste of several lines waits for the PROD question
      if (t.closed) { if (d === '\r') this.connect(t); return; }
      if (d.length > 1 && !await this.pasteOK(t, d)) return; // Ctrl+V of several lines on PROD
      t.ws.send(JSON.stringify({ t: 'd', d }));
    });
    term.onResize(({ cols, rows }) => { if (!t.closed) t.ws.send(JSON.stringify({ t: 'r', cols, rows })); });
    this.activate(t);
    this.connect(t);
    Tree.render();
  },

  connect(t) {
    t.fit.fit();
    const ws = new WebSocket(t.local
      ? `ws://${location.host}/ws/local?shell=${encodeURIComponent(t.local.shell)}&dir=${encodeURIComponent(t.local.dir)}`
      : `ws://${location.host}/ws/term?id=${encodeURIComponent(t.entry.id)}`);
    ws.binaryType = 'arraybuffer';
    t.ws = ws;
    ws.onopen = () => {
      t.closed = false;
      ws.send(JSON.stringify({ t: 'start', cols: t.term.cols, rows: t.term.rows, ...t.creds }));
      t.creds = { ...t.creds, save: false };
      this.renderTabs();
      this.startMacros(t);
      if (!t.local) { Tree.render(); setTimeout(poll, 2000); } // ✓ once the login went through
    };
    ws.onmessage = m => { t.term.write(new Uint8Array(m.data)); t.macroKick?.(); };
    ws.onclose = () => {
      t.closed = true;
      t.term.write('\r\n\x1b[90m[disconnected - press Enter to reconnect]\x1b[0m\r\n');
      this.renderTabs();
      if (!t.local) { Tree.render(); poll(); } // the tree shows it dropped; a failed login shows ✕
    };
  },

  // "Run macros": the saved commands are typed in one at a time, each when
  // the output has been quiet for a moment (so the prompt is back).
  async startMacros(t) {
    t.macroKick = null;
    const ex = t.entry.extra || {};
    if (t.local || ex.run_macros !== '1' || !ex.commands) return;
    const queue = ex.commands.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
    if (t.entry.env === 'PROD' && !await askYes(`${t.entry.name} is a PRODUCTION server.\n\nRun these commands on it now?\n\n${queue.join('\n')}`)) return toast('Commands not run (PROD)');
    let timer = null, seen = false;
    const next = () => {
      if (t.closed || t.ws?.readyState !== 1) { t.macroKick = null; return; }
      const cmd = queue.shift();
      if (cmd === undefined) { t.macroKick = null; return; }
      t.ws.send(JSON.stringify({ t: 'd', d: cmd + '\r' }));
      if (!queue.length) t.macroKick = null;
    };
    t.macroKick = () => { seen = true; clearTimeout(timer); timer = setTimeout(next, 700); };
    setTimeout(() => { if (!seen && t.macroKick) next(); }, 5000); // a server that prints nothing at login
  },

  activate(t) {
    this.active = t;
    this.tabs.forEach(x => x.el.classList.toggle('active', x === t));
    $('#termWrap').classList.toggle('prod', !!t && !t.local && t.entry.env === 'PROD');
    $('#termEmpty').style.display = t ? 'none' : '';
    if (!t) this.emptyHTML();
    this.renderTabs();
    if (t) requestAnimationFrame(() => { t.fit.fit(); t.term.focus(); });
  },

  // With no session open: the servers you used last, one click to reconnect.
  emptyHTML() {
    const recent = S.entries.filter(e => canSSH(e) && e.last_used).sort((a, b) => Date.parse(b.last_used) - Date.parse(a.last_used)).slice(0, 8);
    $('#termEmpty').innerHTML = (recent.length ? `<div class="recent-h">Reconnect</div><div class="recent-chips">${recent.map(e => `<button data-recent="${e.id}" title="${esc(e.name)}\nlast used ${esc(new Date(e.last_used).toLocaleString())}">${e.env ? `<span class="badge ${esc(e.env)}">${esc(e.env)}</span> ` : ''}${esc(e.username ? e.username + '@' : '')}${esc(e.host)}${sshPort(e) !== 22 ? ':' + sshPort(e) : ''}</button>`).join('')}</div>` : '')
      + '<div class="muted">Double-click a server in the tree, use Quick connect,<br>or open a command prompt on this PC with the buttons above.</div>';
  },

  close(t) {
    t.closed = true;
    t.ws?.close();
    t.term.dispose();
    t.el.remove();
    this.tabs = this.tabs.filter(x => x !== t);
    this.activate(this.tabs.at(-1) || null);
    Tree.render();
  },

  renderTabs() {
    $('#termTabs').innerHTML = this.tabs.map(t => `<div class="tab ${t === this.active ? 'active' : ''} ${!t.local && t.entry.env === 'PROD' ? 'prod' : ''}" data-t="${t.id}" ${!t.local && t.entry.env === 'PROD' ? 'title="PRODUCTION server"' : ''}>
      <span style="color:${t.closed ? 'var(--muted)' : 'var(--ok)'}">●</span>${!t.local && t.entry.env === 'PROD' ? '<span class="badge PROD">PROD</span>' : ''}${typeof Groups !== 'undefined' ? Groups.chip(t.local ? t.local.label + ' ' + t.local.dir : Groups.entryText(t.entry)) : ''}${t.local ? '⌨ ' + esc(t.local.label) : esc((t.creds.username || t.entry.username || '') + '@' + t.entry.host)}
      <span class="x" data-x="${t.id}">✕</span></div>`).join('')
      + (this.tabs.filter(t => !t.local && !t.closed).length > 1 ? '<button class="icon tabs-end" data-xall title="Close every SSH terminal (command prompts on this PC stay)">⏏ Disconnect all</button>' : '');
    $('#termCount').textContent = this.tabs.filter(t => !t.closed).length || '';
  },
};
function fitActiveTerm() { if (Term.active) requestAnimationFrame(() => Term.active.fit.fit()); }
window.addEventListener('resize', fitActiveTerm);
$('#termTabs').addEventListener('click', e => {
  if (e.target.closest('[data-xall]')) return Term.tabs.filter(t => !t.local && !t.closed).forEach(t => Term.close(t));
  const x = e.target.closest('[data-x]');
  if (x) return Term.close(Term.tabs.find(t => t.id === x.dataset.x));
  const tab = e.target.closest('[data-t]');
  if (tab) Term.activate(Term.tabs.find(t => t.id === tab.dataset.t));
});

async function quickConnect() {
  const m = $('#qcHost').value.trim().match(/^(?:([^@\s]+)@)?([^:\s]+)(?::(\d+))?$/);
  if (!m) return toast('Use user@host or user@host:port', true);
  const [, user = '', host, port = '22'] = m;
  let e = S.entries.find(x => x.host.toLowerCase() === host.toLowerCase() && (x.username || '') === user && (x.port || 22) === +port && canSSH(x));
  if (!e) {
    e = await api('POST', '/api/entries', { project: S.settings.project || 'General', host, port: +port, username: user, protocol: 'ssh' });
    await poll();
  }
  Term.open(e);
}
$('#qcGo').onclick = () => quickConnect().catch(err => toast(err.message, true));
$('#qcHost').addEventListener('keydown', e => { if (e.key === 'Enter') $('#qcGo').click(); });

// ---------- files (local + SFTP) ----------
function makePane(root, loader) {
  const pane = {
    root, path: '', parent: '', sep: '/', items: [], sel: new Set(), loaded: false,
    async load(p, quiet) {
      try {
        const r = await loader(p);
        Object.assign(pane, { path: r.path, parent: r.parent, items: r.entries || [], sep: r.sep || '/', loaded: true, roots: !!r.roots });
        pane.sel.clear();
        $('.path', root).value = r.path;
        pane.render();
      } catch (err) { if (!quiet) toast(err.message, true); }
    },
    join(name) { return pane.roots ? name : pane.path.endsWith(pane.sep) ? pane.path + name : pane.path + pane.sep + name; },
    sortBy: (() => { try { return JSON.parse(localStorage.getItem('sort.' + root.id)); } catch { return null; } })() || { key: 'mtime', dir: -1 },
    sorted() {
      const { key, dir } = pane.sortBy;
      const val = f => key === 'name' ? f.name.toLowerCase() : key === 'type' ? fileType(f) : key === 'size' ? f.size : new Date(f.mtime).getTime() || 0;
      // Folders stay above files (like FileZilla); both follow the chosen order.
      return [...pane.items].sort((a, b) => (b.dir - a.dir) || (val(a) < val(b) ? -dir : val(a) > val(b) ? dir : a.name.localeCompare(b.name)));
    },
    render() {
      const { key, dir } = pane.sortBy;
      const col = (k, label, i) => `<span class="${k === key ? 'on' : ''}" data-sort="${k}">${label}${k === key ? (dir < 0 ? ' ▼' : ' ▲') : ''}${i < 3 ? `<i class="fgrip" data-fcol="${i}" title="Drag to resize · double-click: default widths"></i>` : ''}</span>`;
      const head = `<div class="fhead">${col('name', 'Name', 0)}${col('type', 'Type', 1)}${col('size', 'Size', 2)}${col('mtime', 'Modified', 3)}</div>`;
      $('.listing', root).innerHTML = head + (pane.sorted().map(f => `<div class="frow ${f.dir ? 'dir' : 'file'} ${pane.sel.has(f.name) ? 'sel' : ''}" data-n="${esc(f.name)}">
        <span class="nm" title="${esc(f.name)}">${esc(f.name)}</span><span class="ty">${esc(fileType(f))}</span><span class="sz">${f.dir ? '' : fmtSize(f.size)}</span><span class="mt">${fmtDateTime(f.mtime)}</span></div>`).join('') || '<div class="empty">Empty folder</div>');
      xferHint();
    },
    selected() { return pane.items.filter(f => pane.sel.has(f.name)); },
  };
  const listing = $('.listing', root);
  listing.addEventListener('click', e => {
    const h = e.target.closest('[data-sort]');
    if (h) {
      const k = h.dataset.sort;
      // First click on Modified/Size sorts biggest/newest first; Name/Type A→Z.
      pane.sortBy = pane.sortBy.key === k ? { key: k, dir: -pane.sortBy.dir } : { key: k, dir: k === 'mtime' || k === 'size' ? -1 : 1 };
      try { localStorage.setItem('sort.' + root.id, JSON.stringify(pane.sortBy)); } catch { /* private mode */ }
      return pane.render();
    }
    const row = e.target.closest('.frow'); if (!row) return;
    const n = row.dataset.n;
    if (e.ctrlKey || e.metaKey) pane.sel.has(n) ? pane.sel.delete(n) : pane.sel.add(n);
    else { pane.sel.clear(); pane.sel.add(n); }
    pane.render();
  });
  listing.addEventListener('dblclick', e => {
    const row = e.target.closest('.frow'); if (!row) return;
    const f = pane.items.find(x => x.name === row.dataset.n);
    if (f.dir) pane.load(pane.join(f.name)); else pane.onOpenFile?.(f);
  });
  $('.path', root).addEventListener('keydown', e => { if (e.key === 'Enter') pane.load(e.target.value.trim()); });
  return pane;
}

$('#termEmpty').addEventListener('click', ev => { const b = ev.target.closest('[data-recent]'); if (b) Term.open(byId(b.dataset.recent)); });

const Local = makePane($('#localPane'), p => api('GET', '/api/local/ls?path=' + encodeURIComponent(p)));
const Remote = makePane($('#remotePane'), p => {
  if (!Remote.sid) throw new Error('Not connected');
  return api('GET', `/api/sftp/ls?sid=${Remote.sid}&path=${encodeURIComponent(p)}`);
});
Remote.join = name => (Remote.path === '/' ? '' : Remote.path) + '/' + name;
Local.onOpenFile = () => transfer('put');
// This PC opens where you were last time
// Under the ➜ / ← buttons: what they will copy, or how to start.
// The ➜ arrows light up when there is something to upload / download.
function xferHint() {
  let up = 0, down = 0, conn = false;
  try { up = Local.sel.size; down = Remote.sel.size; conn = !!Remote.sid; } catch { return; } // panes not made yet
  $('#putBtn')?.classList.toggle('idle', !(up && conn));
  $('#getBtn')?.classList.toggle('idle', !down);
  const n = (k, c) => c ? ` (${c} selected)` : '';
  if ($('#putBtn')) $('#putBtn').title = 'Upload: copy the selected files from This PC to the server' + n('up', conn && up);
  if ($('#getBtn')) $('#getBtn').title = 'Download: copy the selected files from the server to This PC' + n('down', down);
}
function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } }
{ const load = Local.load; Local.load = async (p, quiet) => { await load(p, quiet); if (Local.loaded && !Local.roots) try { localStorage.setItem('ftp.local', Local.path); } catch { /* private mode */ } }; }
Remote.onOpenFile = () => transfer('get');

api('GET', '/api/local/places').then(list => {
  $('#places').innerHTML = '<option value="">Jump to…</option>' + list.map(p => `<option value="${esc(p.path)}">${esc(p.name)}</option>`).join('');
}).catch(() => {});
$('#places').onchange = e => { if (e.target.value) Local.load(e.target.value); e.target.value = ''; };
$('#localPane').addEventListener('click', async e => {
  const a = e.target.closest('[data-act]')?.dataset.act;
  if (a === 'up') Local.load(Local.parent);
  if (a === 'refresh') Local.load(Local.path);
  if (a === 'shell' && SHELLS.length) Term.openLocal(SHELLS[0], Local.roots ? '' : Local.path);
  if (a === 'browse') {
    toast('Choose a folder in the window that opened (it may be behind the browser)');
    try {
      const r = await api('POST', '/api/local/pick', { key: 'ftp-local' }); // where you last browsed to (first time C:\)
      if (r.ok) Local.load(r.path);
    } catch (err) { toast(err.message, true); }
  }
  if (a === 'mkdir' && !Local.roots) {
    const n = await askText('New folder name'); if (!n) return;
    try { await api('POST', '/api/local/mkdir', { path: Local.join(n) }); Local.load(Local.path); } catch (err) { toast(err.message, true); }
  }
});

// Each server opened on the Files page gets its own tab (as in SQL); opening
// one that is already open switches to its tab. The pane shows the active tab;
// each tab keeps its folder. Transfers keep their own session.
Remote.tabs = [];
Remote.tab = null;
Remote.renderTabs = () => {
  let bar = $('#ftpTabs');
  if (!bar) { bar = Object.assign(document.createElement('div'), { id: 'ftpTabs', className: 'ftptabs' }); $('#remotePane').prepend(bar); }
  bar.hidden = !Remote.tabs.length;
  bar.innerHTML = Remote.tabs.map((t, i) => `<button type="button" class="ftab ${t === Remote.tab ? 'on' : ''}" data-ftab="${i}" title="${esc(t.label)}">${t.entry.env ? `<span class="badge ${esc(t.entry.env)}">${esc(t.entry.env)}</span>` : ''}<span class="ftab-t">${esc(t.entry.name || t.entry.host)}</span><span class="x" data-fx="${i}" title="Disconnect">✕</span></button>`).join('');
};
Remote.show = t => {
  if (Remote.tab && Remote.tab !== t) Remote.tab.path = Remote.path; // remember where the tab you leave was
  Remote.tab = t; Remote.sid = t.sid; Remote.entry = t.entry;
  Remote.sel.clear();
  $$('#remotePane [data-needs-conn]').forEach(b => { b.disabled = false; b.title = ''; });
  $('#sftpLabel').textContent = t.label;
  $('#sftpDisconnect').hidden = false;
  Remote.renderTabs(); Tree.render();
  Remote.load(t.path);
};
Remote.connect = async e => {
  if (sshBlocked(e)) return; // FTP still connects
  show('files'); roomForWork();
  const open = Remote.tabs.find(t => t.entry.id === e.id);
  if (open) return Remote.show(open); // already connected: its tab
  let creds = {};
  if (needsCreds(e) && !(isFTP(e) && !e.username)) { creds = await askCreds(e); if (!creds) return; }
  $('.listing', Remote.root).innerHTML = `<div class="empty">Connecting to ${esc(e.host)}…</div>`;
  try {
    const r = await api('POST', '/api/sftp/open', { id: e.id, ...creds });
    const t = { sid: r.sid, entry: e, path: r.home, label: `${r.protocol.toUpperCase()}  ${creds.username || e.username || 'anonymous'}@${e.host}` };
    Remote.tabs.push(t);
    Remote.show(t);
    toast('Connected to ' + e.host);
  } catch (err) {
    toast(err.message, true);
    if (Remote.tab) Remote.show(Remote.tab); // the other tabs are still open
    else $('.listing', Remote.root).innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
};

// ⏏ Disconnect / ✕ on a tab: close that session; the next tab shows, or "Not connected".
Remote.disconnect = (t = Remote.tab, quiet) => {
  if (!t) return;
  api('POST', '/api/sftp/close', { sid: t.sid }).catch(() => {});
  Remote.tabs = Remote.tabs.filter(x => x !== t);
  if (!quiet) toast('Disconnected from ' + t.entry.host);
  if (t !== Remote.tab) { Remote.renderTabs(); Tree.render(); return; }
  Remote.tab = null;
  const next = Remote.tabs[Remote.tabs.length - 1];
  if (next) return Remote.show(next);
  Object.assign(Remote, { sid: null, entry: null, items: [], path: '', parent: '' });
  Remote.sel.clear();
  $('#sftpLabel').textContent = 'Not connected';
  $('#sftpDisconnect').hidden = true;
  $$('#remotePane [data-needs-conn]').forEach(b => { b.disabled = true; b.title = 'Connect to a server first'; });
  $('.path', Remote.root).value = '';
  $('.listing', Remote.root).innerHTML = '<div class="empty">Double-click a server in the tree to connect.<br>Drop files here to upload.</div>';
  Remote.renderTabs(); xferHint(); Tree.render();
};
$('#sftpDisconnect').onclick = () => Remote.disconnect();
$('#remotePane').addEventListener('click', e => {
  const x = e.target.closest('[data-fx]'); if (x) { e.stopPropagation(); return Remote.disconnect(Remote.tabs[+x.dataset.fx]); }
  const t = e.target.closest('[data-ftab]'); if (t) { const tab = Remote.tabs[+t.dataset.ftab]; if (tab && tab !== Remote.tab) Remote.show(tab); }
});

// ☰ → Disconnect all: every SSH terminal, FTP session and database (command
// prompts on this PC stay open).
function openSessions() {
  return { ssh: Term.tabs.filter(t => !t.local && !t.closed), ftp: Remote.tabs.length, sql: SQL.tabs.length };
}
function disconnectAll() {
  const o = openSessions();
  o.ssh.forEach(t => Term.close(t));
  [...Remote.tabs].forEach(t => Remote.disconnect(t, true));
  [...SQL.tabs].forEach(t => SQL.close(t));
  toast(`Disconnected ${[o.ssh.length && `${o.ssh.length} SSH`, o.ftp && o.ftp + ' FTP', o.sql && `${o.sql} database${o.sql > 1 ? 's' : ''}`].filter(Boolean).join(', ')}`);
}

$('#remotePane').addEventListener('click', e => {
  const m = e.target.closest('[data-ftpmore]'); if (!m) return;
  const r = m.getBoundingClientRect(), hidden = a => () => $(`#remotePane [data-act=${a}]`).click();
  setTimeout(() => Tree.showMenu({ clientX: r.left - 120, clientY: r.bottom }, [['Rename…', hidden('rename')], ['Delete…', hidden('delete')]]));
});
$('#remotePane').addEventListener('click', async e => {
  const a = e.target.closest('[data-act]')?.dataset.act;
  if (!a || !Remote.sid) return;
  const op = body => api('POST', '/api/sftp/op', { sid: Remote.sid, ...body }).then(() => Remote.load(Remote.path)).catch(err => toast(err.message, true));
  const sel = Remote.selected();
  if (a === 'up') Remote.load(Remote.parent);
  if (a === 'refresh') Remote.load(Remote.path);
  if (a === 'mkdir') { const n = await askText('New folder name'); if (n) op({ op: 'mkdir', path: Remote.join(n) }); }
  if (a === 'rename' && sel.length === 1) { const n = await askText('Rename to', sel[0].name); if (n && n !== sel[0].name) op({ op: 'rename', path: Remote.join(sel[0].name), to: Remote.join(n) }); }
  if (a === 'delete' && sel.length && await askYes(`Delete on server:\n${sel.map(f => f.name + (f.dir ? '/ (and everything in it)' : '')).join('\n')}`)) {
    for (const f of sel) await op({ op: 'delete', path: Remote.join(f.name) });
  }
});

async function transfer(dir) {
  if (!Remote.sid) return toast('Connect to a server first', true);
  const src = dir === 'put' ? Local : Remote;
  if (dir === 'put' && Local.roots) return;
  const files = src.selected();
  if (!files.length) return toast('Select files first', true);
  for (const f of files) {
    await api('POST', '/api/sftp/transfer', { sid: Remote.sid, dir, local: Local.join(f.name), remote: Remote.join(f.name) }).catch(err => toast(err.message, true));
  }
  Jobs.watch();
}
$('#putBtn').onclick = () => transfer('put');
$('#getBtn').onclick = () => transfer('get');

const drop = $('.listing', Remote.root);
drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragover'); });
drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
drop.addEventListener('drop', async e => {
  e.preventDefault(); drop.classList.remove('dragover');
  if (!Remote.sid) return toast('Connect to a server first', true);
  const fd = new FormData();
  [...e.dataTransfer.files].forEach(f => fd.append('file', f, f.name));
  toast('Uploading…');
  const r = await fetch(`/api/sftp/upload?sid=${Remote.sid}&dir=${encodeURIComponent(Remote.path)}`, { method: 'POST', body: fd });
  const d = await r.json().catch(() => ({}));
  r.ok ? toast(`Uploaded ${d.uploaded} file(s)`) : toast(d.error || 'Upload failed', true);
  Remote.load(Remote.path);
});

// Transfers panel (FTP page): every copy between This PC and a server, with
// progress, speed, Cancel, Retry and — for downloads — Show (This PC opens at
// the file).
const Jobs = {
  timer: null, running: 0, last: {}, list: [],
  watch() { if (!this.timer) this.timer = setInterval(() => this.tick(), 800); this.tick(); },
  async tick() {
    const jobs = await api('GET', '/api/jobs').catch(() => []);
    this.list = jobs;
    const now = Date.now();
    $('#xferPanel').hidden = !jobs.length;
    $('#jobs').innerHTML = jobs.slice(0, 30).map(j => {
      const pct = j.total ? Math.round(j.done * 100 / j.total) : (j.status === 'done' ? 100 : 0);
      const prev = this.last[j.id], speed = prev && j.status === 'running' ? (j.done - prev.done) / ((now - prev.t) / 1000) : 0;
      this.last[j.id] = { done: j.done, t: now };
      const took = j.ended ? Math.max(1, (Date.parse(j.ended) - Date.parse(j.started)) / 1000) : 0;
      const size = j.total ? `${fmtSize(j.done)}${j.status === 'running' ? ' of ' + fmtSize(j.total) : ''}` : '';
      const info = j.status === 'running' ? [size, speed > 0 && fmtSize(speed) + '/s'].filter(Boolean).join(' · ')
        : j.status === 'done' ? [size, took && fmtSize(j.total / took) + '/s', fmtTime(j.ended)].filter(Boolean).join(' · ')
        : j.status === 'failed' ? j.error : 'cancelled';
      const acts = j.status === 'running' ? `<button class="icon" data-jcancel="${j.id}" title="Stop this transfer">Cancel</button>`
        : (j.status === 'failed' || j.status === 'cancelled' ? `<button class="icon" data-jretry="${j.id}" title="Start it again">↻ Retry</button>` : '')
          + (j.dir === 'download' && j.status === 'done' ? `<button class="icon" data-jshow="${j.id}" title="Show it in This PC">Show</button>` : '');
      return `<div class="job ${j.status}" title="${esc(j.dir === 'upload' ? j.local + '  →  ' + j.host + ':' + j.remote : j.host + ':' + j.remote + '  →  ' + j.local)}">
        <span class="jdir">${j.dir === 'upload' ? '↑' : '↓'}</span><span class="jname">${esc(j.name)} <span class="muted tiny">${esc(j.host || '')}</span></span>
        <div class="bar"><i style="width:${pct}%"></i></div><span class="jinfo">${j.status === 'running' ? pct + '% · ' : j.status === 'done' ? '✓ ' : j.status === 'failed' ? '✗ ' : ''}${esc(info || '')}</span><span class="jacts">${acts}</span></div>`;
    }).join('');
    const n = k => jobs.filter(j => j.status === k).length;
    $('#xferSum').textContent = [n('running') && `${n('running')} running`, n('done') && `${n('done')} done`, n('failed') && `${n('failed')} failed`, n('cancelled') && `${n('cancelled')} cancelled`].filter(Boolean).join(' · ');
    const running = n('running');
    if (running < this.running) { Local.load(Local.path); if (Remote.sid) Remote.load(Remote.path); }
    this.running = running;
    if (!running) { clearInterval(this.timer); this.timer = null; }
  },
};
$('#jobs').addEventListener('click', async ev => {
  const b = ev.target.closest('button'); if (!b) return;
  try {
    if (b.dataset.jcancel) await api('POST', `/api/jobs/${b.dataset.jcancel}/cancel`);
    if (b.dataset.jretry) await api('POST', `/api/jobs/${b.dataset.jretry}/retry`, { sid: Remote.sid || '' });
    if (b.dataset.jshow) {
      const j = Jobs.list.find(x => x.id === b.dataset.jshow);
      const dir = j.local.replace(/[\\/][^\\/]*$/, ''), name = j.local.split(/[\\/]/).pop(); // the name it was saved under here
      await Local.load(dir); Local.sel.clear(); Local.sel.add(name); Local.render();
      $(`#localPane .frow[data-n="${CSS.escape(name)}"]`)?.scrollIntoView({ block: 'center' });
    }
  } catch (err) { toast(err.message, true); }
  Jobs.watch();
});
$('#xferClear').addEventListener('click', async ev => { ev.preventDefault(); await api('POST', '/api/jobs/clear').catch(() => {}); Jobs.last = {}; Jobs.tick(); });

// ---------- connection tree (Terminal + Files) ----------
// Folders come from the project name ("Payments/Batch" nests), then the
// environment. Drag a server onto a folder to move it.
// Running tunnels, shown on their SSH server in the trees.
const Tunnels = {
  running: {},
  async load() {
    const list = await api('GET', '/api/tunnels').catch(() => []);
    const next = Object.fromEntries(list.map(t => [t.entry_id, t.forwards]));
    if (JSON.stringify(next) !== JSON.stringify(this.running)) { this.running = next; Tree.render(); }
  },
  chip(e) {
    if (!e.extra?.tunnels) return '';
    const run = this.running[e.id];
    if (run) return `<span class="tchip on" title="Tunnels running:\n${esc(run.join('\n'))}">⇄ ${esc(run.map(f => f.split(' ')[0].replace('localhost:', '')).join(', '))}</span>`;
    return `<span class="tchip" title="${e.extra.tunnels_off === '1' ? 'Tunnels switched off' : 'Tunnels set up (not running): ' + esc(e.extra.tunnels)}">⇄${e.extra.tunnels_off === '1' ? ' off' : ''}</span>`;
  },
};
setInterval(() => Tunnels.load(), 10000);
setTimeout(() => Tunnels.load(), 1500);

// Connection trees (PuTTY, FileZilla, SQL) can be grouped like bookmarks:
// by your folders, environment, application (from the server name),
// domain / IP subnet, type, your Groups, or login user. One choice per tree.
// PROD safety: production connections get a red frame and a confirm step.
const isProd = e => (e?.env || '').toUpperCase() === 'PROD';
const prodName = e => `${e.name || e.host}${e.username ? `\n${e.username}@${e.host}` : `\n${e.host}`}`;
// Read-only SQL: SELECT / WITH … SELECT / EXPLAIN / DESCRIBE / SHOW.
const readOnlySQL = sql => /^(select|with|explain|desc|describe|show|values|table)\b/i.test(sql.replace(/^(\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/))*\s*/, '').trim())
  && !/\b(insert|update|delete|merge|drop|alter|truncate|create|grant|revoke)\b/i.test(sql.replace(/'[^']*'/g, ''));
// Tree expanders: Windows-style [+] / [−] boxes.
const pm = open => `<i class="pm">${open ? '−' : '+'}</i>`;
const TREE_GROUPS = { folder: 'Folders', env: 'Env', app: 'App', domain: 'Domain / subnet', type: 'Type', group: 'My groups', user: 'User' };
const ENV_WORD = /^(dev|devl?|uat|sit|qa|test|tst|stg|stage|staging|preprod|pre|pprd|prod|prd|live|dr|nonprod|np|int|perf|train|trn)\d*[a-z]?$/;
const ROLE_WORD = /^(app|apps|web|db|dbs|srv|svr|server|node|host|vm|ap|ws|lx|lnx|linux|unix|ora|pg|sql|ftp|sftp|jump|bastion)\d*$/;
function serverApp(e) {
  const rl = ruleLabel(e.host) || ruleLabel(e.url);
  if (rl) return rl;
  const h = /^[\d.:]+$/.test(e.host || '') && e.name && e.name !== e.host ? e.name : (e.host || e.name || '');
  if (/^[\d.:]+$/.test(h)) return 'IP addresses';
  const parts = h.toLowerCase().split('.')[0].split(/[-_\s/]+/).filter(Boolean);
  const keep = parts.filter(p => !ENV_WORD.test(p) && !/^\d+$/.test(p)).map(p => p.replace(/\d+$/, '')).filter(Boolean);
  const named = keep.filter(p => !ROLE_WORD.test(p));
  return (named.length ? named : keep.length ? keep : parts).slice(0, 2).join('-') || 'Other';
}
function serverDomain(e) {
  const h = (e.host || '').toLowerCase();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return h.split('.').slice(0, 3).join('.') + '.x';
  return h.includes('.') ? h.split('.').slice(1).join('.') : 'Short names';
}
function serverType(e) {
  const k = dbKindOf(e);
  if (k) return k === 'oracle' ? 'Oracle' : 'PostgreSQL';
  if (isFTP(e)) return (e.protocol || 'ftp').toUpperCase();
  return /rdp|windows/i.test(e.protocol || '') ? 'Windows' : 'Unix / Linux';
}
const LAST_GROUPS = new Set(['Other', 'No environment', 'Not in a group', 'No user', 'Short names', 'IP addresses']);

const Tree = {
  collapsed: new Set(JSON.parse(localStorage.getItem('treeCollapsed') || '[]')),
  selected: null,
  groupMode(mode) { try { return localStorage.getItem('treeGroup_' + mode) || 'folder'; } catch { return 'folder'; } },
  setGroupMode(mode, g) { try { localStorage.setItem('treeGroup_' + mode, g); } catch { /* ignore */ } this.render(); },

  keysOf(e, g) {
    switch (g) {
      case 'env': return [e.env || 'No environment'];
      case 'app': return [serverApp(e)];
      case 'domain': return [serverDomain(e)];
      case 'type': return [serverType(e)];
      case 'user': return [e.username || 'No user'];
      case 'group': { const t = Groups.entryText(e), gs = Groups.all().filter(x => Groups.matches(x, t)).map(x => x.name); return gs.length ? gs : ['Not in a group']; }
    }
    return [];
  },

  build(q, mode) {
    const root = { kids: {}, items: [] };
    const want = { ssh: canSSH, sftp: canFiles, db: canDB }[mode];
    const g = this.groupMode(mode);
    root.mode = mode;
    if (!q) root.top = S.entries.filter(want).filter(e => usageScore(e) > 0).sort(byUsage).slice(0, 6);
    if (g !== 'folder') {
      for (const e of S.entries.filter(want).filter(e => matches(e, q)))
        for (const k of this.keysOf(e, g))
          (root.kids[k] ||= { name: k, key: `${mode}:${g}:${k}`, gmode: g, env: g === 'env' && k !== 'No environment' ? k : '', project: '', kids: {}, items: [] }).items.push(e);
      return root;
    }
    for (const e of S.entries.filter(want).filter(e => matches(e, q))) {
      let node = root, path = '';
      const parts = (e.project || 'General').split('/').map(s => s.trim()).filter(Boolean);
      for (const p of parts) {
        path = path ? path + '/' + p : p;
        node = node.kids[p] ||= { name: p, project: path, kids: {}, items: [] };
      }
      if (e.env) node = node.kids['#' + e.env] ||= { name: e.env, env: e.env, project: path, kids: {}, items: [] };
      node.items.push(e);
    }
    return root;
  },

  count(n) { return n.items.length + Object.values(n.kids).reduce((a, k) => a + this.count(k), 0); },

  html(node, depth, q) {
    let out = '';
    if (depth === 0 && node.top?.length) {
      const key = 'top:' + node.mode, open = !this.collapsed.has(key);
      out += `<div class="tnode folder topused" style="padding-left:8px" data-key="${esc(key)}" data-gmode="top"><span class="tw">${pm(open)}</span>★ <span class="nm">Most used</span><span class="n">${node.top.length}</span></div>`;
      if (open) out += this.html({ kids: {}, items: node.top, flat: true }, 1, q);
    }
    const kids = Object.entries(node.kids).sort(([a, x], [b, y]) => (a[0] === '#') - (b[0] === '#') || LAST_GROUPS.has(a) - LAST_GROUPS.has(b)
      || (x.gmode === 'env' ? (ENV_ORDER[a] ?? 9) - (ENV_ORDER[b] ?? 9) : 0) || a.localeCompare(b));
    const icon = { app: '▦', domain: '🌐', type: '⚙', group: '◆', user: '👤' };
    for (const [, k] of kids) {
      const key = k.key || k.project + (k.env ? '#' + k.env : '');
      const open = q || !this.collapsed.has(key);
      const gc = k.gmode === 'group' && Groups.get(k.name);
      // A folder whose servers are all in one environment shows the badge on
      // its own line instead of an extra level ("📁 Lab  UAT").
      const only = !k.env && !k.items.length && Object.values(k.kids).length === 1 && Object.values(k.kids)[0].env ? Object.values(k.kids)[0] : null;
      out += `<div class="tnode folder" style="padding-left:${8 + depth * 14}px" data-key="${esc(key)}" data-project="${esc(k.project)}" data-env="${esc(k.env || only?.env || '')}" data-gmode="${esc(k.gmode || 'folder')}">
        <span class="tw">${pm(open)}</span>${k.env ? `<span class="badge ${esc(k.env)}">${esc(k.env)}</span>` : (gc ? `<span class="gdot" style="background:${Groups.color(gc)}"></span>` : (icon[k.gmode] || '📁')) + ' <span class="nm">' + esc(k.name) + '</span>' + (only && !k.name.toUpperCase().includes(only.env) ? ` <span class="badge ${esc(only.env)}">${esc(only.env)}</span>` : '')}<span class="n">${this.count(k)}</span></div>`;
      if (open) out += this.html(only || k, depth + 1, q);
    }
    // Several logins on one server: one server row with the users under it.
    const items = node.items.sort(byUsage), byHost = {};
    if (!node.flat) for (const e of items) if (e.host && !canDB(e)) (byHost[`${e.host.toLowerCase()}:${e.port || ''}`] ||= []).push(e);
    const done = new Set();
    for (const e of items) {
      if (done.has(e.id)) continue;
      const grp = e.host && !canDB(e) && !node.flat ? byHost[`${e.host.toLowerCase()}:${e.port || ''}`] : null;
      if (!grp || grp.length < 2) { out += this.itemHTML(e, depth, node); continue; }
      grp.forEach(x => done.add(x.id));
      const key = `srv:${node.key || node.project || ''}:${e.host.toLowerCase()}:${e.port || ''}`, open = q || !this.collapsed.has(key);
      const states = grp.map(connState), now = states.includes('live') ? 'live' : states.includes('dropped') ? 'dropped' : '';
      const okAt = grp.map(lastOKAt).filter(Boolean).sort().at(-1);
      out += `<div class="tnode folder srvnode" style="padding-left:${8 + depth * 14}px" data-key="${esc(key)}" data-gmode="server" data-srvhost="${esc(e.host)}" data-srvport="${e.port || ''}" title="${esc(e.host)} — ${grp.length} logins: ${esc(grp.map(x => x.username || '?').join(', '))}">
        <span class="tw">${pm(open)}</span>${STATE_DOT[now]} 🖥 <span class="nm">${ruleName({ ...e, name: (ruleLabel(e.host) ? ruleLabel(e.host) + ' – ' : '') + e.host })}</span><span class="n" title="logins">👤 ${grp.length}</span>${now === 'dropped' ? '<span class="droptag">disconnected</span>' : ''}${okAt ? lastSeen({ last_ok: okAt }) : ''}</div>`;
      if (open) for (const x of grp) out += this.itemHTML(x, depth + 1, node, withCopyTag(`👤 ${esc(x.username || '(no user)')}`, x));
    }
    return out;
  },

  // One connection row (and, for a database, its objects when expanded).
  itemHTML(e, depth, node, label) {
    let out = '';
    const port = isFTP(e) ? (e.port || 21) : sshPort(e), def = isFTP(e) ? 21 : 22;
    let target = `${isFTP(e) ? e.protocol || 'ftp' : ''}${isFTP(e) ? '://' : ''}${e.username ? e.username + '@' : ''}${e.host}${port !== def ? ':' + port : ''}`;
    if (canDB(e)) target = `${e.username ? e.username + '@' : ''}${e.host}:${e.port || (dbKindOf(e) === 'oracle' ? 1521 : 5432)}${dbService(e) ? (dbService(e).sid ? ':' : '/') + dbService(e).name : ''}`;
    // Database connections expand like SQL Developer: ▸ connects, ▾ shows the objects.
    const isDb = canDB(e) && !node.flat, dbt = isDb && SQL.tabs.find(t => t.entry.id === e.id);
    const dbOpen = isDb && SQL.expanded.has(e.id);
    out += `<div class="tnode item ${this.selected === e.id ? 'sel' : ''} ${e.extra?.color ? 'tinted' : ''}" draggable="true" style="padding-left:${8 + depth * 14}px${/^#[0-9a-f]{6}$/i.test(e.extra?.color || '') ? `;--rowbg:${e.extra.color}` : ''}" data-id="${e.id}" title="${esc((e.name && e.name !== e.host ? e.name + '\n' : '') + target)}">
      <span class="tw" ${isDb ? `data-dbexp="${e.id}" title="${dbOpen ? 'Collapse' : 'Connect and show tables'}"` : ''}>${isDb ? pm(dbOpen) : ''}</span>${STATE_DOT[connState(e)]} ${canDB(e) ? dbIcon(e) : ''}<span class="nm">${label || withCopyTag(esc(treeName(e)), e)}</span>${Tunnels.chip(e)}${(rl => rl && !e.name.includes(rl) ? `<span class="rlabel"${ruleStyle(e.host)}>${esc(rl)}</span>` : '')(ruleLabel(e.host))}${label ? '' : canDB(e) ? `<small class="dbaddr">${esc(dbKindOf(e) === 'oracle' ? jdbcURL(e) : e.host)}</small>` : cardName(e) ? `<small>${esc(cardName(e).replace(/<[^>]*>/g, ''))}${port !== def ? ' :' + port : ''}</small>` : port !== def ? `<small>:${port}</small>` : ''}${connState(e) === 'dropped' ? '<span class="droptag">disconnected</span>' : ''}${lastSeen(e)}</div>`;
    if (dbOpen) {
      const pad = `style="padding-left:${8 + (depth + 1) * 14}px"`;
      if (dbt) out += SQL.treeHTML(dbt, depth + 1);
      else if (SQL.connecting.has(e.id)) out += `<div class="tnode muted" ${pad}>connecting…</div>`;
      else if (SQL.connErr[e.id]) out += `<div class="tnode dberr" ${pad} title="${esc(SQL.connErr[e.id])}">⚠ ${esc(SQL.connErr[e.id])}</div><div class="tnode link" ${pad} data-dbexp="${e.id}" data-retry="1">↻ Try again</div>`;
    }
    return out;
  },

  render() {
    for (const host of $$('.tree-host')) {
      if (!host.firstChild) {
        host.innerHTML = `<div class="tree-tools"><input type="search" placeholder="Filter servers…"><select data-tool="groupby" title="Group servers by">${Object.entries(TREE_GROUPS).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select><button data-tool="new" title="New connection">+ New</button>${typeof Popout !== 'undefined' && !Popout.me ? `<button data-tool="popout" class="icon winbtn" aria-label="Open in a new window" title="Open the whole ${esc(Menubar?.label?.(host.closest('.view')?.id.replace('view-', '')) || 'page')} page in a new window (Dock back puts it back)">${ICON_NEWWIN}</button>` : ''}${host.dataset.mode === 'ssh' ? ('<button data-tool="sshkeys" ' + (S.sshKeysOff ? 'hidden ' : '') + 'title="My SSH keys: copy your public key for GitHub (read-only — nothing in .ssh is changed)">🔑 Keys</button>') : ''}</div><div class="tree" tabindex="0" title="↑ ↓ move · Enter connects · → ← open / fold"></div>`;
        this.wire(host);
      }
      $('select[data-tool=groupby]', host).value = this.groupMode(host.dataset.mode);
      const q = $('input', host).value.trim().toLowerCase();
      $('.tree', host).innerHTML = this.html(this.build(q, host.dataset.mode), 0, q) || '<div class="empty">No servers yet.<br>Copy or paste some details, or press + New.</div>';
      if (this.kbKey) $$('.tree > .tnode.folder', host).find(n => n.dataset.key === this.kbKey)?.classList.add('kbfocus');
    }
  },

  // Keyboard in a tree: ↑/↓ move over servers and folders, → opens a folder
  // (or steps in), ← folds it (or steps out to its folder), Enter connects.
  key(host, k) {
    const rows = $$('.tree > .tnode', host).filter(n => n.dataset.id || n.dataset.key);
    if (!rows.length) return;
    let i = rows.findIndex(n => n.classList.contains('kbfocus'));
    if (i < 0) i = rows.findIndex(n => n.dataset.id && n.dataset.id === this.selected);
    const cur = rows[i], open = n => n.dataset.key && !this.collapsed.has(n.dataset.key);
    const indent = n => parseInt(n.style.paddingLeft) || 0;
    let to = i;
    if (k === 'ArrowDown') to = Math.min(i + 1, rows.length - 1);
    else if (k === 'ArrowUp') to = Math.max(i - 1, 0);
    else if (k === 'Home') to = 0;
    else if (k === 'End') to = rows.length - 1;
    else if (k === 'ArrowRight' && cur?.dataset.key) {
      if (!open(cur)) { this.collapsed.delete(cur.dataset.key); this.kbKey = cur.dataset.key; return this.saveCollapsed(); }
      to = Math.min(i + 1, rows.length - 1);
    } else if (k === 'ArrowLeft' && cur) {
      if (open(cur)) { this.collapsed.add(cur.dataset.key); this.kbKey = cur.dataset.key; return this.saveCollapsed(); }
      for (let j = i - 1; j >= 0; j--) if (rows[j].dataset.key && indent(rows[j]) < indent(cur)) { to = j; break; }
    }
    if (to < 0) to = 0;
    this.focusRow(host, rows[to]);
  },

  focusRow(host, n) {
    if (!n) return;
    $$('.tnode.kbfocus', host).forEach(x => x.classList.remove('kbfocus'));
    n.classList.add('kbfocus');
    this.kbKey = n.dataset.key || '';
    if (n.dataset.id) { this.selected = n.dataset.id; $$('.tnode.item').forEach(x => x.classList.toggle('sel', x.dataset.id === this.selected)); }
    n.scrollIntoView({ block: 'nearest' });
  },

  activate(e, mode) { mode === 'sftp' ? Remote.connect(e) : mode === 'db' ? SQL.open(e) : Term.open(e); },

  wire(host) {
    const mode = host.dataset.mode;
    $('input', host).addEventListener('input', () => this.render());
    $('select[data-tool=groupby]', host).addEventListener('change', ev => this.setGroupMode(mode, ev.target.value));
    host.addEventListener('click', ev => {
      const tool = ev.target.closest('button[data-tool]')?.dataset.tool;
      if (tool === 'new') return openEntryDialog(null);
      if (tool === 'popout') return Popout.popPage(host.closest('.view').id.replace('view-', ''));
      if (tool === 'rules') return openNameRules();
      if (tool === 'sshkeys') return SSHKeys.open();
      const exp = ev.target.closest('[data-dbexp]');
      if (exp) return SQL.toggleConn(byId(exp.dataset.dbexp), !!exp.dataset.retry);
      const n = ev.target.closest('.tnode');
      if (!n) return;
      if (n.dataset.dbk) return SQL.treeClick(n);
      if (n.dataset.key) {
        this.collapsed.has(n.dataset.key) ? this.collapsed.delete(n.dataset.key) : this.collapsed.add(n.dataset.key);
        return this.saveCollapsed();
      }
      this.selected = n.dataset.id;
      $$('.tnode.item').forEach(x => x.classList.toggle('sel', x.dataset.id === this.selected));
    });
    host.addEventListener('dblclick', ev => {
      const dn = ev.target.closest('.tnode.dbn');
      if (dn) return SQL.treeOpen(dn);
      const n = ev.target.closest('.tnode.item');
      if (n) this.activate(byId(n.dataset.id), mode);
    });
    host.addEventListener('keydown', ev => {
      if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'SELECT') return;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) { ev.preventDefault(); return this.key(host, ev.key); }
      const f = $('.tnode.kbfocus', host);
      if (ev.key === 'Enter' && f?.dataset.key) return f.click();
      if (ev.key === 'Enter' && this.selected) this.activate(byId(this.selected), mode);
    });
    host.addEventListener('contextmenu', ev => {
      ev.preventDefault();
      const dn = ev.target.closest('.tnode.dbn');
      if (dn) return SQL.treeMenu(ev, dn);
      const n = ev.target.closest('.tnode');
      if (n?.dataset.id) { this.selected = n.dataset.id; this.render(); }
      this.menu(ev, n, mode);
    });
    host.addEventListener('dragstart', ev => {
      const n = ev.target.closest('.tnode.item');
      if (n) ev.dataTransfer.setData('text/x-entry', n.dataset.id);
    });
    host.addEventListener('dragover', ev => {
      const f = ev.target.closest('.tnode.folder');
      if (!f || !ev.dataTransfer.types.includes('text/x-entry') || !['folder', 'env'].includes(f.dataset.gmode)) return;
      ev.preventDefault();
      $$('.tnode.drop', host).forEach(x => x.classList.remove('drop'));
      f.classList.add('drop');
    });
    host.addEventListener('dragleave', ev => ev.target.closest?.('.tnode.folder')?.classList.remove('drop'));
    host.addEventListener('drop', async ev => {
      const f = ev.target.closest('.tnode.folder');
      const e = byId(ev.dataTransfer.getData('text/x-entry'));
      if (!f || !e || !['folder', 'env'].includes(f.dataset.gmode)) return;
      ev.preventDefault();
      if (f.dataset.gmode === 'env') return this.move(e, e.project, f.dataset.env);
      await this.move(e, f.dataset.project, f.dataset.env || e.env);
    });
  },

  async move(e, project, env) {
    try { await api('POST', '/api/entries', { ...entryInput(e), project, env, password: e.password }); poll(); }
    catch (err) { toast(err.message, true); }
  },

  saveCollapsed() {
    localStorage.setItem('treeCollapsed', JSON.stringify([...this.collapsed]));
    this.render();
  },

  // Right-click menu. An item [label, fn|null, [sub items]] has a submenu that
  // opens on hover (Copy ▸); clicking it runs fn, or opens the submenu if none;
  // [label, null] is shown greyed out (e.g. Disconnect with nothing open).
  showMenu(ev, items) {
    const m = $('#ctxMenu');
    const row = (it, i) => it === '-' ? '<hr>' : it[2]
      ? `<div class="ctxsub"><button class="ctxsub-btn" ${it[1] ? `data-i="${i}"` : `data-sub="${i}"`}>${esc(it[0])}<span class="ctxarrow">▸</span></button><div class="ctxsub-menu">${it[2].map((x, j) => row(x, `${i}.${j}`)).join('')}</div></div>`
      : it[1] ? `<button data-i="${i}">${esc(it[0])}</button>` : `<button disabled title="Nothing connected right now">${esc(it[0])}</button>`;
    m.innerHTML = items.map((it, i) => row(it, i)).join('');
    m.hidden = false;
    m.style.left = Math.max(4, Math.min(ev.clientX, innerWidth - m.offsetWidth - 8)) + 'px'; // its real width: wide menus stay on screen
    m.style.top = Math.min(ev.clientY, innerHeight - m.offsetHeight - 8) + 'px';
    m.classList.toggle('subleft', ev.clientX + 420 > innerWidth); // no room on the right: open submenus to the left
    m.onclick = c => {
      const sb = c.target.closest('[data-sub]');
      if (sb) { sb.parentElement.classList.toggle('open'); return; } // click (or touch) opens it too
      const b = c.target.closest('[data-i]'); if (!b) return;
      const it = b.dataset.i.split('.').reduce((list, k, n, all) => n < all.length - 1 ? list[+k][2] : list[+k], items);
      m.hidden = true; it[1]();
    };
  },

  // Everything open to some connections (by entry) or to one host: SSH
  // terminals (also dropped ones), the FTP session, SQL connections and
  // running tunnels — for "Disconnect all".
  sessionsFor(match) {
    return {
      ssh: Term.tabs.filter(t => !t.local && t.entry && match(t.entry)),
      ftp: Remote.tabs.filter(t => match(t.entry)),
      sql: SQL.tabs.filter(t => match(t.entry)),
      tun: S.entries.filter(e => match(e) && Tunnels.running[e.id]),
    };
  },
  hostSessions(host) { const h = (host || '').toLowerCase(); return this.sessionsFor(x => (x?.host || '').toLowerCase() === h); },
  entrySessions(list) { const ids = new Set(list.map(e => e.id)); return this.sessionsFor(x => ids.has(x?.id)); },
  sessionCount(o) { return o.ssh.length + o.ftp.length + o.sql.length + o.tun.length; },
  hostSessionCount(host) { return this.sessionCount(this.hostSessions(host)); },
  disconnectHost(host) { return this.disconnectSessions(this.hostSessions(host), host); },
  async disconnectSessions(o, where) {
    const parts = [];
    o.ssh.forEach(t => Term.close(t));
    if (o.ssh.length) parts.push(`${o.ssh.length} SSH`);
    o.ftp.forEach(t => Remote.disconnect(t, true));
    if (o.ftp.length) parts.push(`${o.ftp.length} FTP`);
    o.sql.forEach(t => SQL.close(t));
    if (o.sql.length) parts.push(`${o.sql.length} SQL`);
    for (const e of o.tun) await api('POST', `/api/tunnels/${e.id}/stop`).catch(() => {});
    if (o.tun.length) { parts.push(`tunnels of ${o.tun.length} connection${o.tun.length > 1 ? 's' : ''}`); Tunnels.load(); }
    Tree.render();
    toast(parts.length ? `Disconnected ${parts.join(', ')} in ${where}` : `Nothing open in ${where}`);
  },
  // "📜 Tail a log on all N servers…" for a folder / group with SSH servers.
  tailItem(list) {
    const hosts = new Set(list.filter(canSSH).map(e => `${(e.host || '').toLowerCase()}:${sshPort(e)}`));
    return hosts.size ? [[hosts.size > 1 ? `📜 Tail a log on all ${hosts.size} servers…` : '📜 Tail a log…', () => LogView.openMany(list)]] : [];
  },
  // "⏏ Disconnect all" menu item for a folder / group, when something in it is open.
  disconnectItem(list, label) {
    const n = this.sessionCount(this.entrySessions(list));
    if (!list.length) return [];
    return [[`⏏ Disconnect all in ${label}${n ? ` (${n})` : ''}`, n ? () => this.disconnectSessions(this.entrySessions(list), label) : null]];
  },

  // Every connection under a tree node (folder, environment or group), as shown in this tree.
  nodeEntries(key, mode) {
    const id = k => k.key || k.project + (k.env ? '#' + k.env : '');
    const find = n => { for (const k of Object.values(n.kids)) { if (id(k) === key) return k; const f = find(k); if (f) return f; } return null; };
    const all = n => [...n.items, ...Object.values(n.kids).flatMap(all)];
    const n = key && find(this.build('', mode));
    return n ? [...new Set(all(n))] : [];
  },

  // Copy several connections (with their passwords) into another folder,
  // optionally changing the host names on the way (uat01 → sit02).
  async duplicate(list, fromFolder, label) {
    if (!list.length) return;
    const def = fromFolder ? fromFolder + ' (copy)' : list[0].project || 'General';
    const to = await askText(`Copy ${list.length} connection${list.length > 1 ? 's' : ''}${label ? ` (${label})` : ''} into folder (use / for subfolders):`, def);
    if (to == null || !to.trim()) return;
    const rep = await askText('Change host names in the copies? Type old→new, e.g. uat01→sit02 (or old=>new). Leave empty to keep them.', '');
    if (rep == null) return;
    const m = rep.trim().match(/^(.+?)\s*(?:→|=>|->)\s*(.*)$/);
    if (rep.trim() && !m) return toast('Use old→new, e.g. uat01→sit02', true);
    const swap = v => m && v ? v.replace(new RegExp(m[1].trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), m[2].trim()) : v;
    const dest = to.trim().replace(/\/+$/, '');
    const taken = new Set(S.entries.map(x => x.name));
    let n = 0;
    try {
      for (const e of list) {
        // Keep sub-folders under a copied folder: Lab/Web → Lab (copy)/Web.
        const project = fromFolder && (e.project === fromFolder || e.project.startsWith(fromFolder + '/')) ? dest + e.project.slice(fromFolder.length) : dest;
        const name = m ? swap(e.name) : copyName(e.name, taken); // new hosts tell them apart; otherwise "(copy)"
        taken.add(name);
        await api('POST', '/api/entries', { ...entryInput(e), id: '', project, name, host: swap(e.host), url: swap(e.url), password: e.password, favorite: false });
        n++;
      }
    } catch (err) { toast(err.message, true); }
    await poll();
    toast(`Duplicated ${n} connection${n === 1 ? '' : 's'} into ${dest}${m ? ` (${m[1].trim()} → ${m[2].trim()})` : ''}`);
  },

  menu(ev, node, mode) {
    const e = node?.dataset.id && byId(node.dataset.id);
    const items = [];
    if (e) {
      if (e.url && !canDB(e)) items.push(['↗ Open link', () => openURL(e)], ['Copy URL', () => copyText(e.url)]);
      if (canDB(e)) {
        const t = SQL.tabs.find(x => x.entry.id === e.id);
        items.push(['Open in SQL', () => SQL.open(e)]);
        if (t) items.push(['Reconnect', () => SQL.reconnect(t)], ['⏏ Disconnect', () => SQL.close(t)]);
        else items.push(['Connect and show tables', () => SQL.toggleConn(e)]);
      }
      if (canSSH(e)) items.push(['Open SSH terminal', () => Term.open(e)], ['📜 Tail a log…', () => LogView.open(e)], ['⇆ Compare a file with another server…', () => Compare.chooserRemote(e)]);
      const tabs = Term.tabs.filter(t => t.entry?.id === e.id && !t.local && !t.closed);
      if (canSSH(e) || tabs.length) items.push([`⏏ Disconnect SSH${tabs.length > 1 ? ` (${tabs.length} terminals)` : ''}`, tabs.length ? () => tabs.forEach(t => Term.close(t)) : null]);
      if (canFiles(e)) items.push([`Open in FTP (${isFTP(e) ? (e.protocol || 'ftp').toUpperCase() : 'SFTP'})`, () => Remote.connect(e)]);
      { const ft = Remote.tabs.find(t => t.entry.id === e.id); if (ft) items.push(['⏏ Disconnect FTP', () => Remote.disconnect(ft)]); }
      if (e.host && isConn(e)) { const n = this.hostSessionCount(e.host); items.push([`⏏ Disconnect all on ${e.host}${n ? ` (${n})` : ''}`, n ? () => this.disconnectHost(e.host) : null]); }
      if (External.items(e).length) items.push('-', ...External.items(e));
      if (canSSH(e) && e.extra?.tunnels) {
        const off = e.extra.tunnels_off === '1', auto = e.extra.tunnels_auto === '1';
        items.push('-', [off ? '☐ Tunnels switched off — switch on' : '☑ Tunnels on — switch off', async () => {
          await api('POST', `/api/tunnels/${e.id}/enabled`, { on: off });
          toast(off ? 'Tunnels switched on (' + e.extra.tunnels + ')' : 'Tunnels switched off — settings kept'); poll();
        }]);
        if (!off) items.push([auto ? '☑ Start when WorkHub starts — turn off' : '☐ Start when WorkHub starts', async () => {
          await api('POST', `/api/tunnels/${e.id}/enabled`, { on: true, auto: !auto });
          toast(auto ? 'Tunnels start only when needed now' : 'Tunnels will start with WorkHub (and reconnect if dropped) — starting now…'); poll();
        }]);
        if (!off) items.push(['Start tunnels (' + e.extra.tunnels + ')', async () => {
          try { const r = await api('POST', `/api/tunnels/${e.id}/start`); toast('Tunnels running: ' + r.forwards.join(', ') + (r.warning ? ' — ' + r.warning : '')); }
          catch (err) { toast(err.message, true); }
        }], ['Stop tunnels', async () => { await api('POST', `/api/tunnels/${e.id}/stop`); toast('Tunnels stopped' + (e.extra.tunnels_auto === '1' ? ' (they restart within a minute while "Start when WorkHub starts" is on)' : '')); Tunnels.load(); }], '-');
      }
      if (problems(e).some(p => p[0] === 'password')) items.push(['🔑 Logs in with a key / SSO (no password)', async () => { await api('POST', '/api/entries', { ...entryInput(e), password: e.password, extra: { ...(e.extra || {}), auth: 'key' } }); poll(); toast(`${e.name}: marked as key login`); }]);
      if (isConn(e) && typeof Popout !== 'undefined' && !Popout.me) items.push(['⧉ Open in its own window', () => Popout.popConn(e, Popout.connHow(e, mode))]);
      if (canSSH(e) && typeof Pcap !== 'undefined') items.push(['📡 Capture traffic… (tcpdump)', () => Pcap.open(e)]);
      if (typeof Workspaces !== 'undefined' && Workspaces.list.length > 1) items.push(['📤 Copy to another workspace…', () => Workspaces.copyEntries([e])]);
      items.push(['🧵 Add to task thread…', () => Work.addEntry(e, ev)]);
      const port = canDB(e) ? e.port || (dbKindOf(e) === 'oracle' ? 1521 : 5432) : canSSH(e) ? sshPort(e) : e.port;
      // Two copy options: Copy = the basics (host, port, user, password…), Copy all = everything.
      const svc = canDB(e) && dbService(e);
      const basics = [['Host', e.host], ['Port', port], svc && [svc.sid ? 'SID' : dbKindOf(e) === 'postgres' ? 'Database' : 'Service name', svc.name],
        ['Username', e.username], ['Password', e.password], !e.host && ['URL', e.url]].filter(x => x && x[1]).map(([k, v]) => `${k}: ${v}`).join('\n');
      items.push('-', ['Copy', () => copyText(basics, 'Host, port, user and password copied')],
        ['Copy all', () => copyText(detailsText(e), 'All details copied')]);
      if (e.username && isConn(e)) items.push([`🔑 Change ${e.username}'s password everywhere…`, () => PwAll.open(e.username)]);
      items.push('-',
        ['🎨 Background colour…', () => pickEntryColor(e)],
        ...(e.extra?.color ? [['Remove the colour', () => setEntryColor(e, '')]] : []),
        ['Edit…', () => openEntryDialog(e)],
        ['Duplicate', async () => {
          try { const c = await api('POST', '/api/entries', { ...entryInput(e), id: '', name: copyName(e.name, new Set(S.entries.map(x => x.name))), password: e.password }); await poll(); toast('Copy made — change what differs and Save'); openEntryDialog(byId(c.id) || c); }
          catch (err) { toast(err.message, true); }
        }],
        ['Move to folder…', async () => { const p = await askText('Folder (use / for subfolders)', e.project); if (p) this.move(e, p.trim(), e.env); }],
        ['Delete', () => deleteEntries([e])]);
    } else if (node?.dataset.srvhost) { // a server with several logins
      const h = node.dataset.srvhost, port = +node.dataset.srvport || 0, sib = S.entries.find(x => x.host === h && (x.port || 0) === port);
      const logins = S.entries.filter(x => x.host === h && (x.port || 0) === port && !canDB(x));
      items.push(['+ Add another login on this server…', () => openEntryDialog({ host: h, port, protocol: sib?.protocol || 'ssh', project: sib?.project, env: sib?.env })],
        [`Duplicate server (${logins.length} logins)…`, () => this.duplicate(logins, null, h)],
        (n => [`⏏ Disconnect all on this host${n ? ` (${n})` : ''}`, n ? () => this.disconnectHost(h) : null])(this.hostSessionCount(h)),
        ['Copy host', () => copyText(h)]);
    } else if (node?.dataset.project) {
      const proj = node.dataset.project;
      items.push(['New connection here…', () => openEntryDialog({ project: proj, env: node.dataset.env })],
        ['New subfolder…', async () => { const n = await askText('Subfolder name'); if (n) openEntryDialog({ project: proj + '/' + n.trim(), env: node.dataset.env }); }]);
      const inside = this.nodeEntries(node.dataset.key, mode);
      if (inside.length) items.push([`Duplicate ${inside.length} connection${inside.length > 1 ? 's' : ''}…`, () => this.duplicate(inside, proj, node.querySelector('.nm')?.textContent || node.dataset.env || proj)]);
      items.push(...this.disconnectItem(inside, node.dataset.env && !node.querySelector('.nm') ? `${proj} / ${node.dataset.env}` : proj));
      items.push(...this.tailItem(inside));
      if (!node.dataset.env) items.push(['Rename folder…', async () => {
        const to = await askText('Rename folder', proj);
        if (to && to !== proj) { await api('POST', '/api/projects/rename', { from: proj, to: to.trim() }); poll(); }
      }]);
    } else if (node?.dataset.key && node.dataset.gmode && node.dataset.gmode !== 'top') { // env / app / type / user… groups
      const inside = this.nodeEntries(node.dataset.key, mode);
      if (inside.length) items.push([`Duplicate ${inside.length} connection${inside.length > 1 ? 's' : ''}…`, () => this.duplicate(inside, null, node.querySelector('.nm')?.textContent || node.textContent.trim())]);
      items.push(...this.disconnectItem(inside, node.querySelector('.nm')?.textContent || node.dataset.env || 'this group'));
      items.push(...this.tailItem(inside));
    } else {
      items.push(['New connection…', () => openEntryDialog(null)],
        ['New folder…', async () => { const n = await askText('Folder name (use / for subfolders)'); if (n) openEntryDialog({ project: n.trim() }); }]);
    }
    this.showMenu(ev, items);
  },
};
const sshPort = e => (['', 'ssh', 'sftp', 'scp'].includes(e.protocol || '') && e.port) || 22;
document.addEventListener('click', e => { if (!e.target.closest('#ctxMenu')) $('#ctxMenu').hidden = true; });
document.addEventListener('keydown', e => { if (e.key === 'Escape') $('#ctxMenu').hidden = true; });
