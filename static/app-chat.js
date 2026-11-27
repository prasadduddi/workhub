'use strict';
// WorkHub page, part 4 of 7: the assistant chat, bookmarks.
// The page's script is split into parts loaded in order (index.html); they share one global scope.

// ---------- assistant chat ----------
// Rule-based and fully local: nothing typed here leaves this PC.
const Chat = {
  cards: [],

  // below the search bar at the top (it is never covered), as wide as you last made it
  place() {
    const g = $('#gsearch')?.getBoundingClientRect();
    document.documentElement.style.setProperty('--chat-top', (g && g.bottom > 0 ? Math.round(g.bottom + 6) : 0) + 'px');
    const w = store.get('chatW', 0); if (w) document.documentElement.style.setProperty('--chat-w', w + 'px');
  },
  toggle(force) {
    const c = $('#chat');
    c.hidden = force === undefined ? !c.hidden : !force;
    if (!c.hidden) this.place();
    $('#chatFab').classList.toggle('on', !c.hidden); // highlighted while the assistant is open
    if (!c.hidden) { $('#chatText').focus(); if (!$('#chatLog').children.length) this.help(true); }
    if (typeof AsstCapture !== 'undefined') AsstCapture.sync(); // while open: copies are offered here first
  },

  say(html, who = 'bot') {
    const d = document.createElement('div');
    d.className = 'msg ' + who;
    d.innerHTML = html;
    $('#chatLog').append(d);
    d.scrollIntoView({ block: 'end' });
    return d;
  },

  help(short) {
    this.say(short
      ? '📋 While I\'m open, anything you copy (server details, a JDBC URL, a screenshot) shows up here first — I ask before adding it. You can paste it here too.<br><br>Tell me what you want in plain English — e.g. <code>show prod servers in payments as a table</code>, <code>bookmarks by folder</code>, <code>password for app01</code>, <code>save this view as Prod</code>. Or paste connection details and say <code>putty</code>, <code>filezilla</code> or <code>sql</code>. Type <code>help</code> for more.'
      : `Things you can say:
• <code>putty</code> / <code>ssh</code> / <code>terminal</code> + details → PuTTY (SSH session)
• <code>filezilla</code>, <code>ftp</code>, <code>ftps</code>, <code>sftp</code> + details → FileZilla (file transfer)
• just a saved name: <code>ssh app-prod-01</code>, <code>ftp files.corp.local</code>
• <code>save</code> + details → store without connecting
• <code>find prod</code>, <code>find oracle</code> → search saved connections
• <code>yes</code> to confirm the suggestion, <code>no</code> to dismiss
• <code>clear</code> → empty this conversation
• paste server details, a JDBC URL or a screenshot and press Send → I offer to add each connection

Details can be in any form: <code>host: x user: y pass: z</code>, <code>user@host:port</code>, URLs, a pasted email…`);
  },

  intent(t) {
    const l = t.toLowerCase();
    if (/^\s*(help|\?)\s*$/.test(l)) return 'cmdhelp';
    if (/^\s*(y|yes|ok|okay|go|confirm|do it)\s*!?\s*$/.test(l)) return 'yes';
    if (/^\s*(n|no|cancel|stop|nevermind)\s*$/.test(l)) return 'no';
    if (/^\s*(find|search( for)?|look ?up|where is|where are)\b/.test(l)) return 'find';
    if (/\b(sql|query|oracle|postgres|postgresql|psql|sqlplus|sqldeveloper|database|db)\b/.test(l)) return 'db';
    if (/\b(ftps?|sftp|filezilla|winscp|files?|upload|download|scp|transfer)\b/.test(l)) return 'files';
    if (/\b(ssh|terminal|putty|shell|console|connect|login|log ?in)\b/.test(l)) return 'terminal';
    if (/\b(save|store|remember|add|keep)\b/.test(l)) return 'save';
    return '';
  },

  fileProto(t) {
    const l = t.toLowerCase();
    if (/\bftps\b/.test(l)) return 'ftps';
    if (/\bsftp\b/.test(l)) return 'sftp';
    if (/\bftp\b/.test(l)) return 'ftp';
    return '';
  },

  async send(text) {
    text = text.trim();
    if (/^(clear|cls|clear chat)$/i.test(text)) { $('#chatLog').innerHTML = ''; this.cards = []; return; } // empty the conversation
    if (typeof AsstCapture !== 'undefined' && AsstCapture.img) { await AsstCapture.sendImage(); if (!text) return; } // a pasted screenshot, read on Send
    if (!text) return;
    this.say(esc(text), 'me');
    const intent = this.intent(text);
    this.lastText = text;
    if (intent === 'cmdhelp') return this.say(HELP.replace(/\n/g, '<br>'));
    if (intent === 'yes' && pendingBulk) {
      try { return this.say(await confirmBulk()); } catch (err) { return this.say('Could not change them: ' + esc(err.message)); }
    }
    if (intent === 'no' && pendingBulk) { pendingBulk = null; return this.say('OK, nothing changed.'); }
    if (intent === 'yes') {
      const open = this.cards.filter(c => !c.done);
      if (open.length === 1) return this.confirm(open[0], open[0].action || 'terminal');
      return this.say(open.length ? 'There are several suggestions — press the button on the one you want.' : 'Nothing to confirm right now.');
    }
    if (intent === 'no') {
      this.cards.forEach(c => { if (!c.done) { c.done = true; c.el.classList.add('done'); } });
      return this.say('OK, dismissed.');
    }
    if (intent === 'find') return this.find(text.replace(/^\s*\S+\s*(up\s*)?/i, ''));
    // Questions ("how do I…?", "why don't my Jira issues show?") get the help steps.
    if (/^\s*(how|why|explain|help( me)?( with)?|what (is|are|does))\b|\?\s*$/i.test(text) && typeof Help !== 'undefined') {
      const a = Help.answer(text);
      if (a) return this.say(a);
    }

    // Plain-English view commands ("show prod servers as a table"), unless the
    // message carries connection details (key: value, user@host, URLs, IPs).
    const looksLikeDetails = (/\n|[:=]\s*\S|@\S+\.|:\/\/|\b\d{1,3}(\.\d{1,3}){3}\b/.test(text) || /^[\w.-]+\.[a-z]{2,}(:\d+)?$/i.test(text)) && !/\b(password|user|url|host)\s+(for|of)\b/i.test(text);
    // Details on their own (no "ssh", "ftp", "sql"…): offer to add each connection found
    // a command only when the message starts with one ("ssh …", "ftp …", "sql …"): words inside pasted
    // details (jdbc:oracle:…, sftp://…) are not commands
    const asked = /^(ssh|putty|terminal|shell|console|connect|login|ftps?|sftp|filezilla|winscp|scp|sql|query|oracle|postgres(ql)?|psql|sqlplus|sqldeveloper|db|database|open)\b/i.test(text);
    if (!asked && looksLikeDetails && typeof AsstCapture !== 'undefined') {
      const found = await api('POST', '/api/parse', { text }).catch(() => []);
      if (found.length) return AsstCapture.offer({ id: 'local-' + (++AsstCapture.n), source: 'paste', text, findings: found }, true);
    }
    if (!looksLikeDetails || !['terminal', 'files', 'db', 'save'].includes(intent)) {
      try {
        const reply = await runCommand(text);
        if (reply) return this.say(reply.replace(/\n/g, '<br>'));
      } catch (err) { console.error(err); return this.say('Sorry, that went wrong: ' + esc(err.message)); }
    }

    let found = [];
    try { found = await api('POST', '/api/parse', { text }); } catch (err) { return this.say(esc(err.message)); }
    // Also accept a saved server mentioned by name or host ("ssh app-prod-01").
    const words = text.toLowerCase();
    const known = new Set(found.map(f => f.existing_id).filter(Boolean));
    for (const e of S.entries) {
      if (known.has(e.id) || !e.host) continue;
      const names = [e.host, e.name].filter(n => n && n.length >= 3).map(n => n.toLowerCase());
      if (names.some(n => new RegExp(`(^|[\\s@'"/])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[\\s:'"/,])`).test(words))) {
        found.push({ host: e.host, port: e.port, protocol: e.protocol, username: e.username, password: e.password, existing_id: e.id });
        known.add(e.id);
      }
    }
    found = found.filter(f => f.host);
    if (!found.length) {
      return this.say(intent
        ? 'I couldn\'t find a host in that. Paste the details (host, user, password) or name a saved server.'
        : (typeof Help !== 'undefined' && Help.answer(text)) || 'I didn\'t understand that. Ask “how do I …?” for steps, or try e.g. <code>show prod servers</code>, <code>group by env</code>, <code>password for app01</code>, or paste connection details with <code>putty</code>. Type <code>help</code> for everything I can do.');
    }
    const proto = this.fileProto(text);
    this.say(found.length === 1 ? (intent ? 'Here\'s what I understood — check it and confirm (or type <code>yes</code>):' : 'Found this. What should I do with it?') : `Found ${found.length} servers:`);
    found.slice(0, 6).forEach(f => this.card(f, intent, proto));
  },

  card(f, intent, proto) {
    const existing = f.existing_id && byId(f.existing_id);
    let protocol = f.protocol || '', port = f.port || '';
    if (intent === 'files') {
      protocol = proto || (isFTP({ protocol, port: +port }) ? protocol || 'ftp' : 'sftp');
      if (['ftp', 'ftps'].includes(protocol) && (!port || port === 22)) port = 21;
      if (protocol === 'sftp' && (!port || port === 21)) port = 22;
    } else if (intent === 'terminal') {
      if (!['', 'ssh', 'sftp', 'scp'].includes(protocol) || port === 21) { protocol = 'ssh'; if (!port || [21, 80, 443].includes(+port)) port = 22; }
      protocol = protocol || 'ssh';
    }
    if (intent === 'db') {
      const l = (this.lastText || '').toLowerCase();
      protocol = /postgres|psql/.test(l) ? 'postgres' : /oracle|sqlplus/.test(l) ? 'oracle' : dbKindOf({ protocol, port: +port }) || 'oracle';
      if (!port || [22, 21, 80, 443].includes(+port)) port = protocol === 'oracle' ? 1521 : 5432;
    }
    const c = { f, existing, action: intent === 'files' ? 'files' : intent === 'terminal' ? 'terminal' : intent === 'db' ? 'db' : intent === 'save' ? 'save' : '' };
    const el = document.createElement('div');
    el.className = 'prop';
    const opt = (v, cur) => `<option ${v === cur ? 'selected' : ''}>${v}</option>`;
    el.innerHTML = `<div class="ptitle">${esc(f.host)}${existing ? '<span class="tag">saved</span>' : '<span class="tag">new</span>'}${existing?.env ? `<span class="badge ${esc(existing.env)}">${esc(existing.env)}</span>` : ''}</div>
      <div class="pgrid">
        <span>Host</span><input data-f="host" value="${esc(f.host)}">
        <span>Type</span><select data-f="protocol">${['ssh', 'sftp', 'ftp', 'ftps', 'oracle', 'postgres'].map(p => opt(p, protocol || 'ssh')).join('')}</select>
        <span>Port</span><input data-f="port" type="number" value="${esc(port)}" placeholder="default">
        <span>User</span><input data-f="username" value="${esc(f.username || '')}" autocomplete="off">
        <span>Password</span><input data-f="password" value="${esc(f.password || '')}" autocomplete="off">
        <span>Folder</span><input data-f="project" list="projectList" value="${esc(existing?.project || S.settings.project || 'General')}">
      </div>
      <div class="pbtns">
        <button data-a="terminal" class="${c.action === 'terminal' ? 'primary' : ''}">Open in PuTTY</button>
        <button data-a="files" class="${c.action === 'files' ? 'primary' : ''}">Open in FileZilla</button>
        <button data-a="db" class="${c.action === 'db' ? 'primary' : ''}">Open in SQL</button>
        <button data-a="save" class="${c.action === 'save' ? 'primary' : ''}">Save only</button>
      </div>`;
    el.addEventListener('click', ev => { const b = ev.target.closest('[data-a]'); if (b && !c.done) this.confirm(c, b.dataset.a); });
    // Changing the type to/from FTP adjusts the port the way FileZilla does.
    $('[data-f=protocol]', el).addEventListener('change', ev => {
      const p = $('[data-f=port]', el), v = ev.target.value;
      if (['ftp', 'ftps'].includes(v) && (!p.value || p.value === '22')) p.value = 21;
      if (['ssh', 'sftp'].includes(v) && (!p.value || p.value === '21')) p.value = 22;
    });
    // …and a database port picks oracle/postgres.
    $('[data-f=port]', el).addEventListener('input', ev => {
      const kind = dbKindByPort(+ev.target.value);
      if (kind) $('[data-f=protocol]', el).value = kind;
    });
    c.el = el;
    this.cards.push(c);
    $('#chatLog').append(el);
    el.scrollIntoView({ block: 'end' });
  },

  async confirm(c, action) {
    const v = k => $(`[data-f=${k}]`, c.el).value.trim();
    let protocol = v('protocol');
    if (action === 'terminal' && protocol !== 'ssh') protocol = 'ssh';
    if (action === 'files' && protocol === 'ssh') protocol = 'sftp';
    if (action === 'db' && !['oracle', 'postgres'].includes(protocol)) protocol = 'oracle';
    const port = +v('port') || ({ ftp: 21, ftps: 21, oracle: 1521, postgres: 5432 }[protocol] || 22);
    const want = { host: v('host'), port, protocol, username: v('username'), password: $('[data-f=password]', c.el).value, project: v('project') || 'General' };
    // Reuse the saved entry only if it is the same kind of connection.
    let e = c.existing;
    if (e && (isFTP(e) !== ['ftp', 'ftps'].includes(protocol) || !!canDB(e) !== ['oracle', 'postgres'].includes(protocol) || (e.host || '').toLowerCase() !== want.host.toLowerCase())) e = null;
    const body = e
      ? { ...entryInput(e), ...want, protocol: e.protocol || protocol, port: e.port || port, password: want.password || e.password }
      : want;
    try {
      const saved = await api('POST', '/api/entries', body);
      c.done = true;
      c.el.classList.add('done');
      await poll();
      const entry = byId(saved.id) || saved;
      if (action === 'save') return this.say(`Saved <b>${esc(entry.name)}</b> in ${esc(entry.project)}.`);
      this.say(`${action === 'files' ? 'Opening FileZilla on' : action === 'db' ? 'Opening SQL on' : 'Opening PuTTY to'} <b>${esc(entry.username ? entry.username + '@' : '')}${esc(entry.host)}</b>…`);
      if (action === 'files') Remote.connect(entry); else if (action === 'db') SQL.open(entry); else Term.open(entry);
    } catch (err) { this.say('Could not save: ' + esc(err.message)); }
  },

  find(q) {
    q = q.trim().toLowerCase();
    const res = S.entries.filter(e => matches(e, q)).slice(0, 12);
    if (!res.length) return this.say(`Nothing saved matches <code>${esc(q)}</code>.`);
    const d = this.say(`${res.length} match${res.length > 1 ? 'es' : ''}:\n` + res.map(e =>
      `• <b>${esc(e.name)}</b>${linkLabel(e.url) ? ` <span class="ulabel"${ruleStyle(e.url)}>${esc(linkLabel(e.url))}</span>` : ''} ${e.env ? `<span class="badge ${esc(e.env)}">${esc(e.env)}</span>` : ''} <span class="muted">${esc(e.username || '')}${e.username ? '@' : ''}${esc(e.host || e.url || '')}</span>
   ${canSSH(e) ? `<button class="icon" data-t="${e.id}">PuTTY</button> ` : ''}${canFiles(e) ? `<button class="icon" data-fl="${e.id}">FileZilla</button> ` : ''}${e.password ? `<button class="icon" data-pw="${e.id}">copy password</button>` : ''}${e.url ? ` <button class="icon" data-url="${e.id}">open URL</button>` : ''}`).join('\n'));
    d.addEventListener('click', ev => {
      const b = ev.target.closest('button'); if (!b) return;
      const e = byId(b.dataset.t || b.dataset.fl || b.dataset.pw || b.dataset.url);
      if (b.dataset.t) Term.open(e);
      if (b.dataset.fl) Remote.connect(e);
      if (b.dataset.pw) copyText(e.password, 'Password copied');
      if (b.dataset.url) openURL(e);
    });
  },
};
$('#chatFab').onclick = () => Chat.toggle();
$('#chatClose').onclick = () => Chat.toggle(false);
$('#chatSend').onclick = () => { const t = $('#chatText').value; $('#chatText').value = ''; Chat.send(t); };
$('#chatText').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#chatSend').click(); } });
$$('.chat-hints button').forEach(b => b.onclick = () => {
  const h = b.dataset.hint;
  if (h.endsWith(' ')) { $('#chatText').value = h + $('#chatText').value; $('#chatText').focus(); }
  else { $('#chatText').value = h; $('#chatSend').click(); }
});
document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j') { e.preventDefault(); Chat.toggle(); } });

// ---------- bookmarks ----------
// Every open is counted; the Smart view puts what you use most and most
// recently on top, then groups by application (from the URL pattern) or site.
// Desktop version: links open in the normal browser, not inside WorkHub.
function openExternal(u) {
  if (window.WH_DESKTOP && window.whOpenExternal) window.whOpenExternal(u, !!window.WH_NEW_WINDOW?.()); // Ctrl+Click → new Chrome window
  else window.open(u, '_blank', 'noopener');
}
// A file attached in WorkHub (task threads, Properties) downloads here, in the
// WorkHub window — never in a new tab or the outside browser, which isn't
// signed in. Also fixes links in posts saved by earlier versions.
document.addEventListener('click', ev => {
  const a = ev.target.closest('a[href*="/api/props/files/"]');
  // a.download: the link made below (clicking it must not come back here)
  if (!a || a.hasAttribute('download') || ev.button !== 0 || a.closest('[contenteditable="true"]')) return;
  const u = new URL(a.href, location.href);
  if (u.origin !== location.origin) return;
  ev.preventDefault(); ev.stopPropagation();
  u.searchParams.set('download', '1');
  const dl = document.createElement('a');
  dl.href = u.pathname + u.search; dl.download = a.textContent.trim() || '';
  document.body.appendChild(dl); dl.click(); dl.remove();
  toast(`⬇ Downloading ${a.textContent.trim()}`);
}, true);
document.addEventListener('click', ev => {
  const a = ev.target.closest('a[target="_blank"]'); // external links: handled by the desktop window itself
  if (a && window.WH_DESKTOP && !ev.defaultPrevented) { ev.preventDefault(); openExternal(a.href); }
}, true);
function openURL(e) {
  openExternal(e.url);
  api('POST', `/api/entries/${e.id}/opened${fromSearch() ? '?searched=1' : ''}`).then(poll).catch(() => {});
}
document.addEventListener('click', ev => {
  const a = ev.target.closest('a[data-open]');
  if (a) api('POST', `/api/entries/${a.dataset.open}/opened${fromSearch() ? '?searched=1' : ''}`).then(poll).catch(() => {});
});

function siteOf(host) {
  if (!host || /^[\d.]+$/.test(host) || !host.includes('.')) return host || 'Other';
  const p = host.toLowerCase().split('.');
  const n = p.length >= 3 && p.at(-1).length === 2 && ['co', 'com', 'gov', 'org', 'net', 'ac'].includes(p.at(-2)) ? 3 : 2;
  return p.slice(-n).join('.');
}
const ENV_ORDER = { PROD: 0, DR: 1, UAT: 2, STAGE: 3, TEST: 4, DEV: 5 };

// Same page under different spellings → one key (mirrors normURL on the server).
function normURL(raw) {
  try {
    const u = new URL(raw);
    let host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (u.port && u.port !== '80' && u.port !== '443') host += ':' + u.port;
    for (const k of [...u.searchParams.keys()]) if (/^utm_|^(fbclid|gclid|mc_cid|mc_eid)$/i.test(k)) u.searchParams.delete(k);
    u.searchParams.sort();
    const q = u.searchParams.toString();
    return host + u.pathname.replace(/\/+$/, '') + (q ? '?' + q : '');
  } catch { return (raw || '').toLowerCase().replace(/\/+$/, ''); }
}

// Internal (work) links get priority over public sites.
const INTERNAL_SUFFIX = /\.(local|corp|internal|intra|intranet|lan|home|priv|private|ad|localdomain|int|svc|cluster\.local)$/i;
const PUBLIC_SITES = new Set(['google.com', 'google.co.uk', 'bing.com', 'yahoo.com', 'github.com', 'gitlab.com', 'stackoverflow.com', 'stackexchange.com',
  'superuser.com', 'serverfault.com', 'youtube.com', 'wikipedia.org', 'microsoft.com', 'live.com', 'office.com', 'apple.com', 'amazon.com', 'amazon.co.uk',
  'facebook.com', 'linkedin.com', 'twitter.com', 'x.com', 'reddit.com', 'medium.com', 'w3schools.com', 'mozilla.org', 'npmjs.com', 'pypi.org',
  'docker.com', 'oracle.com', 'postgresql.org', 'go.dev', 'golang.org', 'python.org', 'java.com', 'apache.org', 'chatgpt.com', 'openai.com',
  'anthropic.com', 'claude.ai', 'bbc.co.uk', 'bbc.com', 'cnn.com', 'netflix.com', 'spotify.com', 'whatsapp.com', 'instagram.com', 'gmail.com']);
let internalDomainCache = null;
function internalDomains() {
  if (internalDomainCache) return internalDomainCache;
  const d = new Set();
  for (const e of S.entries) {
    const h = (e.host || '').toLowerCase();
    if (!h || !h.includes('.') || /^[\d.]+$/.test(h)) continue;
    const site = siteOf(h);
    if (PUBLIC_SITES.has(site)) continue;
    // Domains of your servers, databases and saved logins are work domains.
    if (!/^https?:/i.test(e.url || '') || e.username || e.has_password || (e.source === '' && e.clip_ids?.length)) d.add(site);
  }
  return (internalDomainCache = d);
}
function isInternal(e) {
  const h = (e.host || '').toLowerCase();
  if (!h) return false;
  if (e.username || e.has_password) return true;
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.)/.test(h) || !h.includes('.') || INTERNAL_SUFFIX.test(h)) return true;
  const site = siteOf(h);
  return !PUBLIC_SITES.has(site) && internalDomains().has(site);
}
function avatar(text) {
  let h = 0;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `<span class="av" style="background:hsl(${h} 55% 45%)">${esc((text.match(/[A-Za-z0-9]/) || ['?'])[0].toUpperCase())}</span>`;
}

// Bookmarks table: [heading, sort key, default share of the width] — the URL
// gets the most; a column you drag keeps your width.
const BM_COLS = [['Name', 'name', '15%'], ['App', 'app', '12%'], ['URL', 'url', '29%'], ['User', 'user', '7%'], ['Env', 'env', '6%'], ['Folder', 'folder', '10%'], ['Opened', 'opened', '5%'], ['Last opened', 'last', '8%'], ['', '', '8%']];

const Bookmarks = {
  mode: localStorage.getItem('bmGroup') || 'smart',
  view: lsGet('bmView') || 'tiles',
  sort: (() => { try { return JSON.parse(localStorage.getItem('bmSort')) || null; } catch { return null; } })(), // {key, dir} in Table view

  internalOnly: (() => { try { return localStorage.getItem('bmInternalOnly') === '1'; } catch { return false; } })(),

  list() {
    const q = $('#bmSearch').value.trim().toLowerCase();
    internalDomainCache = null;
    // One tile per real link: prefer the copy with a login, notes or most opens.
    const best = new Map();
    const score = e => (e.has_password ? 4 : 0) + (e.username ? 2 : 0) + (e.notes ? 1 : 0) + (e.open_count || 0) / 1000;
    for (const e of (this.showHidden ? S.allEntries.filter(x => x.hidden) : S.entries)) {
      if (!e.url || !/^https?:/i.test(e.url)) continue;
      const k = normURL(e.url), cur = best.get(k);
      if (!cur || score(e) > score(cur)) best.set(k, e);
    }
    return [...best.values()].filter(e => matches(e, q) && viewMatch(e) && (!this.internalOnly || isInternal(e)));
  },

  sortItems(a, b) {
    return (isInternal(b) - isInternal(a)) || usageScore(b) - usageScore(a) || (ENV_ORDER[a.env] ?? 9) - (ENV_ORDER[b.env] ?? 9) || a.name.localeCompare(b.name);
  },

  tile(e) {
    const label = urlLabel(e.url), job = /jenkins/i.test(label) ? jenkinsJob(e.url) : '';
    const jobName = job.replace(/ #\d+$/, '').split(' › ').pop();
    const title = job && !e.name.toLowerCase().includes(jobName.toLowerCase()) ? job : e.name !== e.host ? e.name : label || e.host;
    const sub = job ? (title === job ? (e.name !== e.host ? e.name : label) : title.includes(job) ? label : label + ': ' + job) : label && e.name !== e.host ? label : '';
    const when = e.open_count ? `${e.open_count}× · ${fmtTime(e.last_used)}` : '';
    return `<div class="bm env-${esc(e.env || '')}" data-bm="${e.id}" title="${esc(e.url)}">
      ${dot(e)}${avatar(label || e.name || e.host)}
      <div class="bm-body"><div class="bm-name">${esc(title)}</div>
        <div class="bm-sub">${sub ? `<span class="ulabel"${ruleStyle(e.url || e.host)}>${esc(sub)}</span>` : ''}${esc(e.host)}${e.username ? ' · ' + esc(e.username) : ''}</div>
        ${e.folder && this.mode !== 'folder' ? `<div class="bm-sub" title="${esc(e.folder)}">📁 ${esc(e.folder.split(' › ').slice(1).join(' › ') || e.folder)}</div>` : ''}</div>
      <div class="bm-meta">${e.env ? `<span class="badge ${esc(e.env)}">${esc(e.env)}</span>` : ''}<span class="n">${when}</span>
        <span class="bm-tools">${this.tools(e)}</span></div>
    </div>`;
  },

  tools(e) {
    return `<button class="icon" data-bmcopy="${e.id}" title="Copy URL">URL</button>${e.password ? `<button class="icon" data-bmpw="${e.id}" title="Copy password">pw</button>` : ''}<button class="icon" data-bmedit="${e.id}" title="Edit">✎</button>${e.hidden ? `<button class="icon" data-bmrestore="${e.id}" title="Show this bookmark again">↺ Restore</button>` : `<button class="icon danger" data-bmdel="${e.id}" title="Remove from WorkHub (your browser is not changed)">🗑</button>`}`;
  },

  sortVal(e, k) {
    return { name: (e.name || '').toLowerCase(), app: urlLabel(e.url).toLowerCase(), url: (e.url || '').toLowerCase(), user: (e.username || '').toLowerCase(),
      env: ENV_ORDER[e.env] ?? 9, folder: (e.folder || '').toLowerCase(), opened: e.open_count || 0, last: Date.parse(e.last_used) || 0 }[k];
  },

  // Table view: every field in full (text wraps), columns resizable and sortable.
  table(items) {
    if (this.sort) {
      const { key, dir } = this.sort;
      items = [...items].sort((a, b) => { const x = this.sortVal(a, key), y = this.sortVal(b, key); return (x < y ? -1 : x > y ? 1 : 0) * dir; });
    }
    const head = BM_COLS.map(([h, k], i) => `<th ${k ? `data-bmsort="${k}" title="Sort by ${h.toLowerCase()}"` : ''}>${h}${this.sort?.key === k && k ? (this.sort.dir > 0 ? ' ▲' : ' ▼') : ''}<span class="colgrip" data-bmcol="${i}" title="Drag to resize · double-click to reset"></span></th>`).join('');
    return `<div class="tblwrap"><table class="tbl bm-tbl"><colgroup>${BM_COLS.map(([, , w], i) => `<col style="width:var(--b${i}, ${w})">`).join('')}</colgroup><thead><tr>${head}</tr></thead><tbody>`
      + items.map(e => `<tr class="env-${esc(e.env || '')}" data-bm="${e.id}" title="Click to open">
        <td class="bm-tname">${dot(e)} ${esc(e.name || e.host)}</td>
        <td>${urlLabel(e.url) ? `<span class="ulabel"${ruleStyle(e.url)}>${esc(urlLabel(e.url))}</span>` : ''}</td>
        <td class="mono">${esc(e.url)}</td>
        <td>${esc(e.username || '')}</td>
        <td>${e.env ? `<span class="badge ${esc(e.env)}">${esc(e.env)}</span>` : ''}</td>
        <td>${esc(e.folder ? e.folder.split(' › ').slice(1).join(' › ') || e.folder : '')}</td>
        <td>${e.open_count ? e.open_count + '×' : ''}</td>
        <td>${e.last_used ? esc(fmtTime(e.last_used)) : ''}</td>
        <td class="bm-ttools"><button class="icon" data-bmcopy="${e.id}" title="Copy URL">URL</button><button class="icon more" data-bmmenu="${e.id}" title="More: edit, copy password, remove… (or right-click the row)">⋯</button></td></tr>`).join('') + '</tbody></table></div>';
  },

  section(title, items) {
    return items.length ? `<div class="group"><div class="group-head"><h3>${esc(title)}</h3><span class="n">${items.length}</span></div>${this.view === 'table' ? this.table(items) : `<div class="bm-grid">${items.map(e => this.tile(e)).join('')}</div>`}</div>` : '';
  },

  render() {
    let all = this.list();
    if (!all.length) {
      $('#bmBoard').innerHTML = `<div class="empty">No web links yet.<br>Copy or paste URLs, press <b>+ Add</b>, or <b>Import from Edge/Chrome</b>.</div>`;
      return;
    }
    let html = '';
    const keyOf = {
      smart: e => LABEL_CATEGORY[urlLabel(e.url)] || siteOf(e.host),
      app: e => urlLabel(e.url) || 'Other',
      site: e => siteOf(e.host),
      env: e => e.env || 'No environment',
      folder: e => e.folder || 'Saved in WorkHub',
    }[this.mode];
    let external = [];
    if (this.mode === 'smart') {
      external = all.filter(e => !isInternal(e));
      all = all.filter(e => isInternal(e));
      const used = all.filter(e => e.open_count > 0);
      const top = [...used].sort((a, b) => b.open_count - a.open_count).slice(0, 8);
      const recent = [...used].filter(e => !top.includes(e)).sort((a, b) => new Date(b.last_used) - new Date(a.last_used)).slice(0, 8);
      html += this.section('★ Most used', top) + this.section('🕘 Recently opened', recent);
    }
    const groups = {};
    all.forEach(e => (groups[keyOf(e)] ||= []).push(e));
    // Groups you open more often float up; then bigger groups; then by name.
    const weight = g => groups[g].reduce((s, e) => s + (e.open_count || 0), 0);
    // Folders keep the browser's order (alphabetical path = tree order).
    const order = this.mode === 'folder' ? (a, b) => a.localeCompare(b)
      : (a, b) => internalShare(b) - internalShare(a) || weight(b) - weight(a) || groups[b].length - groups[a].length || a.localeCompare(b);
    const internalShare = g => groups[g].filter(isInternal).length / groups[g].length;
    Object.keys(groups).sort(order)
      .forEach(g => { html += this.section(g, groups[g].sort(this.sortItems)); });
    if (external.length) {
      const ext = external.sort(this.sortItems);
      html += `<details class="group ext-group" ${this.extOpen ? 'open' : ''}><summary class="group-head"><h3>External sites</h3><span class="n">${external.length}</span><span class="muted tiny">public websites — click to show</span></summary>${this.view === 'table' ? this.table(ext) : `<div class="bm-grid">${ext.map(e => this.tile(e)).join('')}</div>`}</details>`;
    }
    $('#bmBoard').innerHTML = html;
    $('#bmBoard').classList.toggle('bm-table-view', this.view === 'table');
    $('#bmWidthL').hidden = this.view === 'table';
  },
};
$('#bmSearch').addEventListener('input', () => Bookmarks.render());
$$('#bmGroup button').forEach(b => b.classList.toggle('active', b.dataset.g === Bookmarks.mode));
$('#bmGroup').addEventListener('click', ev => {
  const b = ev.target.closest('button'); if (!b) return;
  Bookmarks.mode = b.dataset.g; localStorage.setItem('bmGroup', b.dataset.g);
  $$('#bmGroup button').forEach(x => x.classList.toggle('active', x === b));
  Bookmarks.render();
});
// Tiles / Table, tile width, and the table's columns (width and sort remembered)
{
  const board = $('#bmBoard'), seg = $('#bmViewSeg');
  const mark = () => $$('button', seg).forEach(b => b.classList.toggle('active', b.dataset.v === Bookmarks.view));
  mark();
  seg.addEventListener('click', ev => {
    const b = ev.target.closest('button'); if (!b) return;
    Bookmarks.view = b.dataset.v; try { localStorage.setItem('bmView', b.dataset.v); } catch { /* private mode */ }
    mark(); Bookmarks.render();
  });
  const setW = w => { board.style.setProperty('--bm-w', w + 'px'); $('#bmWidth').value = w; };
  setW(+lsGet('bmTileW') || 300);
  $('#bmWidth').addEventListener('input', ev => { setW(+ev.target.value); try { localStorage.setItem('bmTileW', ev.target.value); } catch { /* private mode */ } });
  let widths = {}; try { widths = JSON.parse(localStorage.getItem('bmColW')) || {}; } catch { /* none */ }
  for (const [i, w] of Object.entries(widths)) board.style.setProperty('--b' + i, w + 'px');
  const saveW = () => { try { localStorage.setItem('bmColW', JSON.stringify(widths)); } catch { /* private mode */ } };
  board.addEventListener('pointerdown', e => {
    const grip = e.target.closest('[data-bmcol]'); if (!grip) return;
    e.preventDefault(); e.stopPropagation();
    const i = grip.dataset.bmcol, x0 = e.clientX, w0 = grip.parentElement.getBoundingClientRect().width;
    grip.setPointerCapture(e.pointerId);
    document.body.classList.add('dragging');
    const move = ev => board.style.setProperty('--b' + i, clamp(w0 + ev.clientX - x0, 50, 1200) + 'px');
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', () => {
      grip.removeEventListener('pointermove', move);
      document.body.classList.remove('dragging');
      widths[i] = parseInt(board.style.getPropertyValue('--b' + i)); saveW();
    }, { once: true });
  });
  board.addEventListener('dblclick', e => {
    const grip = e.target.closest('[data-bmcol]'); if (!grip) return;
    board.style.removeProperty('--b' + grip.dataset.bmcol); delete widths[grip.dataset.bmcol]; saveW();
  });
  board.addEventListener('click', ev => {
    const th = ev.target.closest('th[data-bmsort]');
    if (!th || ev.target.closest('[data-bmcol]')) return;
    ev.stopPropagation();
    const k = th.dataset.bmsort, cur = Bookmarks.sort;
    // first click: A→Z (most opened / most recent first for counts and dates); third click: back to the usual order
    Bookmarks.sort = cur?.key !== k ? { key: k, dir: ['opened', 'last'].includes(k) ? -1 : 1 } : cur.dir === (['opened', 'last'].includes(k) ? -1 : 1) ? { key: k, dir: -cur.dir } : null;
    try { localStorage.setItem('bmSort', JSON.stringify(Bookmarks.sort)); } catch { /* private mode */ }
    Bookmarks.render();
  }, true);
}
// Right-click a bookmark (tile or table row): the same menu as everywhere else
$('#bmBoard').addEventListener('contextmenu', ev => {
  const t = ev.target.closest('[data-bm]'); if (!t || ev.target.closest('input')) return;
  ev.preventDefault(); Tree.menu(ev, { dataset: { id: t.dataset.bm } }, 'board');
});
$('#bmBoard').addEventListener('toggle', ev => { if (ev.target.classList?.contains('ext-group')) Bookmarks.extOpen = ev.target.open; }, true);
$('#bmBoard').addEventListener('click', async ev => {
  const t = ev.target.closest('button');
  if (t?.dataset.bmdel) {
    // Hide rather than delete: WorkHub remembers it so the next sync doesn't import it again.
    const e = byId(t.dataset.bmdel);
    await api('POST', `/api/entries/${e.id}/hide`, { hidden: true }).catch(err => toast(err.message, true));
    toast(`Removed "${e.name}" — turn on "Show hidden" to restore it`);
    return poll();
  }
  if (t?.dataset.bmrestore) {
    await api('POST', `/api/entries/${t.dataset.bmrestore}/hide`, { hidden: false }).catch(err => toast(err.message, true));
    toast('Restored');
    return poll();
  }
  if (t?.dataset.bmcopy) return copyText(byId(t.dataset.bmcopy).url);
  if (t?.dataset.bmpw) return copyText(byId(t.dataset.bmpw).password, 'Password copied');
  if (t?.dataset.bmedit) return openEntryDialog(byId(t.dataset.bmedit));
  if (t?.dataset.bmmenu) { const r = t.getBoundingClientRect(); return setTimeout(() => Tree.menu({ clientX: r.left - 180, clientY: r.bottom }, { dataset: { id: t.dataset.bmmenu } }, 'board')); }
  const tile = ev.target.closest('[data-bm]');
  if (tile) openURL(byId(tile.dataset.bm));
});
$('#bmAdd').onclick = () => openEntryDialog({ project: S.settings.project, protocol: 'https' });
Bookmarks.sync = async (loud) => {
  if (S.settings.no_browser_sync && !loud) return;
  try {
    const r = await api('POST', '/api/bookmarks/sync');
    if (loud || r.added || r.removed) toast(`Browser bookmarks: ${r.found} found, ${r.added} new, ${r.removed} removed`);
    poll();
  } catch (err) { toast(err.message, true); }
};
$('#bmSyncNow').onclick = () => Bookmarks.sync(true);
Bookmarks.check = async (ids) => {
  try {
    const r = await api('POST', '/api/links/check', { ids: ids || [] });
    if (!ids) toast(`Checking ${r.checking} links…`);
    setTimeout(poll, 4000); setTimeout(poll, 13000);
  } catch (err) { toast(err.message, true); }
};
$('#bmCheck').onclick = () => Bookmarks.check();
// Naming rules editor. Accepts one rule per line ("-BAT- Batch",
// "-BAT- = Batch", "-BAT-: Batch") or a pasted list "-BAT- Batch, -BAR- Barn".
function parseNameRules(text) {
  return text.split(/\n|,(?=\s*\S+\s*(?:=|:|\s)\s*\S)/).map(l => l.trim()).filter(Boolean).map(l => {
    const m = /^(\S+?)\s*(?:=|:(?=\s)|\s)\s*(.+)$/.exec(l);
    return m ? { match: m[1].trim(), label: m[2].trim() } : null;
  }).filter(r => r && r.label);
}
function openNameRules() {
  const d = $('#nameRulesDlg');
  $('#nameRulesText').value = (S.settings.name_rules || []).map(r => `${r.match} = ${r.label}`).join('\n');
  $('#nameRulesWs').textContent = S.settings.workspace || 'this workspace';
  d.returnValue = ''; d.showModal();
}
$('#nameRulesDlg').addEventListener('close', async () => {
  if ($('#nameRulesDlg').returnValue !== 'save') return;
  const rules = parseNameRules($('#nameRulesText').value);
  await saveSettings({ name_rules: rules });
  await poll();
  toast(`${rules.length} naming rule(s) saved — matching servers and links are renamed`);
});
$('#bmNameRules').onclick = openNameRules;

$('#bmBlocked').onclick = async () => {
  const cur = (S.settings.blocked_sites || []).join(', ');
  const v = await askText('Sites never imported or captured in this workspace (comma separated, e.g. facebook.com, example.org).\nWell-known adult sites are always blocked.', cur);
  if (v === null) return;
  await saveSettings({ blocked_sites: v.split(',').map(x => x.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean) });
  await poll();
  toast('Blocked sites saved — matching links are hidden');
};
$('#bmHidden').onchange = e => { Bookmarks.showHidden = e.target.checked; Bookmarks.render(); };
$('#bmInternal').checked = Bookmarks.internalOnly;
$('#bmInternal').onchange = e => { Bookmarks.internalOnly = e.target.checked; try { localStorage.setItem('bmInternalOnly', e.target.checked ? '1' : '0'); } catch { /* ignore */ } Bookmarks.render(); };
$('#bmSync').onchange = e => saveSettings({ no_browser_sync: !e.target.checked }).then(() => e.target.checked && Bookmarks.sync(true));
