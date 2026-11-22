'use strict';
// Groups: a name plus search patterns (server names, hosts, projects, words).
// A group gathers every server, link, open window, note, repository and
// captured clip that matches, and labels matching tabs. Stored per workspace.

const GROUP_COLORS = ['#2f6fde', '#d9822b', '#2a9d8f', '#8e6bd8', '#d64545', '#3f8f3f', '#b5651d', '#c2185b', '#00838f', '#6d4c41'];

const Groups = {
  selected: (() => { try { return localStorage.getItem('groupSel') || ''; } catch { return ''; } })(),

  all() { return S.settings.groups || []; },
  async save(list) { await saveSettings({ groups: list }); this.render(); renderAllTabs(); },
  get(name) { const n = (name || '').toLowerCase(); return this.all().find(g => g.name.toLowerCase() === n); },
  color(g) { return g.color || GROUP_COLORS[this.all().indexOf(g) % GROUP_COLORS.length]; },

  // Pattern: plain text (contains), * wildcards, or /regex/.
  test(pattern, text) {
    if (!pattern || !text) return false;
    const t = text.toLowerCase(), p = pattern.trim().toLowerCase();
    if (/^\/.+\/$/.test(p)) { try { return new RegExp(p.slice(1, -1), 'i').test(text); } catch { return false; } }
    if (p.includes('*')) return new RegExp(p.split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*'), 'i').test(text);
    return t.includes(p);
  },
  matches(g, text) { return (g.patterns || []).some(p => this.test(p, text)); },
  entryText(e) { return [e.name, e.host, e.url, e.project, e.username, e.notes, ...(e.tags || []), ...Object.values(e.extra || {})].filter(Boolean).join(' '); },
  of(text) { return this.all().find(g => this.matches(g, text)); },

  chip(text) {
    const g = text && this.of(text);
    return g ? `<span class="gchip" style="background:${this.color(g)}" title="Group: ${esc(g.name)}">${esc(g.name)}</span>` : '';
  },

  async create(name, patterns) {
    const list = this.all().filter(g => g.name.toLowerCase() !== name.toLowerCase());
    list.push({ name, patterns: [...new Set(patterns.map(p => p.trim()).filter(Boolean))] });
    await this.save(list);
    this.selected = name;
    try { localStorage.setItem('groupSel', name); } catch { /* ignore */ }
  },

  // Everything in the app that belongs to group g.
  collect(g) {
    const entries = S.entries.filter(e => this.matches(g, this.entryText(e)));
    const servers = entries.filter(e => !/^https?:/i.test(e.url || '') || canSSH(e) || canDB(e) || canFiles(e)).sort(byUsage);
    const links = entries.filter(e => /^https?:/i.test(e.url || '') && !servers.includes(e)).sort(byUsage);
    const windows = [
      ...Term.tabs.map(t => ({ kind: 'SSH', label: t.local ? t.local.label : `${t.creds.username || t.entry.username || ''}@${t.entry.host}`, text: t.local ? t.local.label + ' ' + t.local.dir : this.entryText(t.entry), go: () => { show('terminal'); Term.activate(t); } })),
      ...SQL.tabs.map(t => ({ kind: 'SQL', label: t.entry.name, text: this.entryText(t.entry), go: () => { show('sql'); SQL.activate(t); } })),
      ...Notes.docs.map(d => ({ kind: 'Notes', label: d.title, text: (d.path || '') + ' ' + d.title + ' ' + (d.content || '').slice(0, 20000), go: () => { show('notes'); Notes.activate(d); } })),
      ...(Remote.sid && Remote.entry ? [{ kind: 'FTP', label: Remote.entry.name, text: this.entryText(Remote.entry) + ' ' + Remote.path, go: () => show('files') }] : []),
    ].filter(w => this.matches(g, w.text));
    const notes = (Notes.notes || []).filter(n => this.matches(g, n.title + ' ' + n.body));
    const files = (Notes.recent || []).filter(r => this.matches(g, r.path));
    const repos = (S.settings.repos || []).filter(p => this.matches(g, p));
    const clips = S.clips.filter(c => this.matches(g, c.text)).slice(0, 30);
    return { servers, links, windows, notes, files, repos, clips };
  },

  render() {
    const list = this.all();
    $('#groupCount').textContent = list.length || '';
    $('#groupList').innerHTML = list.map(g => {
      const c = this.collect(g), n = c.servers.length + c.links.length;
      return `<div class="li ${g.name === this.selected ? 'active' : ''}" data-grp="${esc(g.name)}"><span class="gdot" style="background:${this.color(g)}"></span>${esc(g.name)}
        <small>${esc(g.patterns.join(', '))} · ${n} item${n === 1 ? '' : 's'}${c.windows.length ? ` · ${c.windows.length} open` : ''}</small></div>`;
    }).join('') || '<div class="muted tiny" style="padding:8px">No groups yet.<br><br>Ask the chat, e.g.<br><b>group all windows related to app-prod-01</b><br>or press + New group.</div>';
    const g = this.get(this.selected) || list[0];
    if (!g) { $('#groupMain').innerHTML = '<div class="empty">Create a group to gather everything about a server, application or search pattern in one place.</div>'; return; }
    this.selected = g.name;
    const c = this.collect(g);
    const empty = []; // empty sections are listed on one line at the end
    const sec = (title, n, body) => n ? `<div class="gsec"><h4>${title} <span class="n">${n}</span></h4>${body}</div>` : (empty.push(title), '');
    const row = (e, extra) => `<div class="grow">${dot(e)} <b>${esc(e.name)}</b> <span class="muted">${esc(e.username ? e.username + '@' : '')}${esc(e.host || e.url || '')}${e.port ? ':' + e.port : ''}</span>${e.env ? ` <span class="badge ${esc(e.env)}">${esc(e.env)}</span>` : ''}<span class="spacer"></span>${extra}</div>`;
    $('#groupMain').innerHTML = `
      <div class="ghead"><span class="gdot big" style="background:${this.color(g)}"></span><h3>${esc(g.name)}</h3>
        <span class="muted tiny">matches: ${g.patterns.map(p => `<code>${esc(p)}</code>`).join(' ')}</span><span class="spacer"></span>
        ${c.servers.some(canSSH) ? '<button data-ga="putty-all">Open all servers (SSH)</button>' : ''}
        ${c.links.length ? '<button data-ga="links-all">Open all links</button>' : ''}
        <button data-ga="edit">Edit patterns</button><button data-ga="more" class="icon more" title="More: delete this group">⋯</button></div>
      ${sec('Open windows', c.windows.length, c.windows.map((w, i) => `<div class="grow link" data-gw="${i}"><span class="proto">${w.kind}</span> ${esc(w.label)}</div>`).join(''))}
      ${sec('Servers & databases', c.servers.length, c.servers.map(e => row(e,
        `${canSSH(e) ? `<button class="icon" data-gs="ssh" data-id="${e.id}">SSH</button>` : ''}${canFiles(e) ? `<button class="icon" data-gs="files" data-id="${e.id}">FTP</button>` : ''}${canDB(e) ? `<button class="icon" data-gs="sql" data-id="${e.id}">SQL</button>` : ''}<button class="icon" data-gs="edit" data-id="${e.id}">Edit</button>`)).join(''))}
      ${sec('Links', c.links.length, c.links.map(e => row(e, `${linkLabel(e.url) ? `<span class="ulabel"${ruleStyle(e.url)}>${esc(linkLabel(e.url))}</span>` : ''}<button class="icon" data-gs="open" data-id="${e.id}">Open</button>`)).join(''))}
      ${sec('Notes & files', c.notes.length + c.files.length, c.notes.map(n => `<div class="grow link" data-gn="note:${n.id}">📝 ${esc(n.title || 'Untitled')}</div>`).join('') + c.files.map(f => `<div class="grow link" data-gn="file:${esc(f.path)}">📄 ${esc(f.path)}</div>`).join(''))}
      ${sec('Git repositories', c.repos.length, c.repos.map(p => `<div class="grow link" data-gr="${esc(p)}">⎇ ${esc(p)}</div>`).join(''))}
      ${sec('Captured', c.clips.length, c.clips.map(cl => `<div class="grow clipline"><span class="muted tiny">${new Date(cl.created).toLocaleString()} · ${esc(cl.source)}</span> <span class="clipone">${maskedText(cl.text.replace(/\s+/g, ' '))}</span></div>`).join(''))}`;
    $('#groupMain').insertAdjacentHTML('beforeend', (empty.length ? `<div class="muted tiny gempty">Nothing yet in: ${empty.join(' · ')}</div>` : '')
      + (c.servers.length || c.links.length ? `<div class="muted tiny dotkey"><span class="dot ok"></span> worked last time · <span class="dot fail"></span> failed · <span class="dot none"></span> not tried yet</div>` : ''));
    this.lastCollect = c;
  },

  async openAll(kind, g = this.get(this.selected)) {
    const c = this.collect(g);
    const list = kind === 'putty' ? c.servers.filter(canSSH) : c.links;
    if (list.length > 6 && !confirm(`Open ${list.length} ${kind === 'putty' ? 'PuTTY sessions' : 'links'}?`)) return 0;
    for (const e of list) { if (kind === 'putty') await Term.open(e); else openURL(e); }
    return list.length;
  },
};

// Re-draw every tab bar (group labels may have changed).
function renderAllTabs() { Term.renderTabs(); SQL.renderTabs(); Notes.renderTabs(); }

// Put tabs of the same group next to each other.
function arrangeTabsByGroup() {
  const key = text => { const g = Groups.of(text); return g ? Groups.all().indexOf(g) : 999; };
  const stable = (arr, f) => arr.map((x, i) => [x, i]).sort((a, b) => f(a[0]) - f(b[0]) || a[1] - b[1]).map(x => x[0]);
  Term.tabs = stable(Term.tabs, t => key(t.local ? t.local.label + ' ' + t.local.dir : Groups.entryText(t.entry)));
  SQL.tabs = stable(SQL.tabs, t => key(Groups.entryText(t.entry)));
  Notes.docs = stable(Notes.docs, d => key((d.path || '') + ' ' + d.title + ' ' + (d.content || '').slice(0, 20000)));
  renderAllTabs();
}

$('#groupList').addEventListener('click', e => {
  const li = e.target.closest('[data-grp]'); if (!li) return;
  Groups.selected = li.dataset.grp;
  try { localStorage.setItem('groupSel', Groups.selected); } catch { /* ignore */ }
  Groups.render();
});
$('#groupNew').onclick = async () => {
  const pats = prompt('What should this group gather? Server names, hosts, projects or words — separated by commas.\n(e.g. app-prod-01, ora-uat, payments)');
  if (!pats) return;
  const name = prompt('Group name', pats.split(',')[0].trim());
  if (name) Groups.create(name.trim(), pats.split(','));
};
$('#groupMain').addEventListener('click', async e => {
  const g = Groups.get(Groups.selected), c = Groups.lastCollect;
  const a = e.target.closest('[data-ga]')?.dataset.ga;
  if (a === 'putty-all') return Groups.openAll('putty');
  if (a === 'links-all') return Groups.openAll('links');
  if (a === 'more') {
    const r = e.target.closest('[data-ga]').getBoundingClientRect(), before = Groups.all();
    return setTimeout(() => Tree.showMenu({ clientX: r.left - 150, clientY: r.bottom }, [['Delete group (nothing inside is deleted)', async () => {
      await Groups.save(before.filter(x => x !== g));
      toast(`Group “${g.name}” deleted`, false, () => Groups.save(before));
    }]]));
  }
  if (a === 'edit') {
    const v = prompt('Patterns (comma separated; * wildcard, /regex/ allowed)', g.patterns.join(', '));
    if (v !== null) { g.patterns = v.split(',').map(x => x.trim()).filter(Boolean); return Groups.save(Groups.all()); }
    return;
  }
  const s = e.target.closest('[data-gs]');
  if (s) {
    const en = byId(s.dataset.id);
    return { ssh: () => Term.open(en), files: () => Remote.connect(en), sql: () => SQL.open(en), edit: () => openEntryDialog(en), open: () => openURL(en) }[s.dataset.gs]();
  }
  const w = e.target.closest('[data-gw]'); if (w) return c.windows[+w.dataset.gw].go();
  const n = e.target.closest('[data-gn]'); if (n) { show('notes'); return Notes.open(n.dataset.gn); }
  const r = e.target.closest('[data-gr]'); if (r) { show('git'); return Git.open(r.dataset.gr); }
});
