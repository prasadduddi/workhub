'use strict';
// Jira page: tracked issues as a tree — each issue with its pull requests and
// its "CM-" items (sub-tasks / linked issues). Refreshed every 15 minutes.

const Jira = {
  issues: [], cfg: null, hasToken: false, open: new Set(JSON.parse((() => { try { return localStorage.getItem('jiraOpen') || '[]'; } catch { return '[]'; } })())),
  sel: null,

  async load() {
    const [list, c] = await Promise.all([api('GET', '/api/jira').catch(() => []), api('GET', '/api/jira/config').catch(() => ({}))]);
    this.issues = list || []; this.cfg = c.config || {}; this.hasToken = !!c.has_token;
    if (this.cfg.mode === 'browser') this.session = await api('GET', '/api/jira/browser').catch(() => ({}));
    this.render();
    if ($('#search').value.trim()) renderBoard(); // main search shows Jira issues too
    if (typeof Cal !== 'undefined') Cal.render(); // CM windows
  },
  persist() { try { localStorage.setItem('jiraOpen', JSON.stringify([...this.open])); } catch { /* ignore */ } },

  prBadge(s) { return s ? `<span class="prs ${s.toLowerCase()}">${esc(s.toLowerCase())}</span>` : ''; },

  render() {
    const browser = this.cfg?.mode === 'browser', ready = this.cfg?.base_url && (this.hasToken || browser);
    $('#jiraSetupHint').hidden = !!ready;
    $('#jiraSignBtn').hidden = !(browser && this.session?.available && this.session.checked && !this.session.signed_in);
    const q = $('#jiraFilter').value.trim().toLowerCase();
    const list = this.issues.filter(j => !q || [j.key, j.summary, j.status, j.assignee, ...j.prs.map(p => p.name + ' ' + p.repo), ...j.children.map(c => c.key + ' ' + c.summary), ...(j.kids || []).map(c => c.key + ' ' + c.summary)].join(' ').toLowerCase().includes(q));
    const prefix = this.cfg?.child_prefix || 'CM-';
    const node = (cls, key, depth, html, title = '') => `<div class="tnode jn ${cls} ${this.sel === key ? 'sel' : ''}" data-jk="${esc(key)}" style="padding-left:${8 + depth * 16}px" title="${esc(title)}">${html}</div>`;
    const issueHTML = j => {
      const k = j.key, open = this.open.has(k) || !!q;
      let h = node('issue', 'i:' + k, 1, `<span class="tw" data-jtog="${esc(k)}">${open ? '▾' : '▸'}</span><a class="jkey" href="${esc(j.url)}" data-jlink="${esc(j.url)}" title="Open ${esc(k)} in Jira">${esc(k)}</a> <span class="nm">${esc(j.summary || '')}</span>${j.status ? `<span class="jstat${j.done ? ' done' : ''}">${esc(j.status)}</span>` : ''}${j.error ? '<span class="dot fail" title="' + esc(j.error) + '"></span>' : ''}`, j.error || j.summary);
      if (open) {
        const pOpen = this.open.has('p:' + k), cOpen = this.open.has('c:' + k);
        h += node('folder', 'p:' + k, 2, `<span class="tw" data-jtog="p:${esc(k)}">${j.prs.length ? (pOpen ? '▾' : '▸') : ''}</span>⇄ Pull requests <span class="n">${j.prs.length}</span>`);
        if (pOpen) h += j.prs.map((p, i) => node('pr', `pr:${k}:${i}`, 3, `${this.prBadge(p.status)} <span class="nm">${esc(p.name)}</span><small>${esc(p.repo || '')}</small>`, p.url)).join('');
        h += node('folder', 'c:' + k, 2, `<span class="tw" data-jtog="c:${esc(k)}">${j.children.length ? (cOpen ? '▾' : '▸') : ''}</span>☑ ${esc(prefix)} items <span class="n">${j.children.length}</span>`);
        if (cOpen) h += j.children.map((c, i) => node('child', `ch:${k}:${i}`, 3, `<a class="jkey" href="${esc(c.url)}" data-jlink="${esc(c.url)}" title="Open ${esc(c.key)} in Jira">${esc(c.key)}</a> <span class="nm">${esc(c.summary)}</span><span class="jstat">${esc(c.status)}</span>`, `${c.relation}: ${c.summary}`)).join('');
        // Child work items (all sub-tasks and children, any key): open unless closed by the user.
        const kids = j.kids || [], kOpen = !this.open.has('-k:' + k);
        if (kids.length) {
          h += node('folder', 'k:' + k, 2, `<span class="tw" data-jtog="-k:${esc(k)}">${kOpen ? '▾' : '▸'}</span>🧩 Child work items <span class="n">${kids.length}</span>`);
          if (kOpen) h += kids.map((c, i) => node('child', `kid:${k}:${i}`, 3, `<a class="jkey" href="${esc(c.url)}" data-jlink="${esc(c.url)}" title="Open ${esc(c.key)} in Jira">${esc(c.key)}</a> <span class="nm">${esc(c.summary)}</span>${c.type ? `<small>${esc(c.type)}</small>` : ''}<span class="jstat">${esc(c.status)}</span>`, `${c.relation}: ${c.summary}`)).join('');
        }
      }
      return h;
    };
    // Two folders: what's in progress, and Completed (newest first) with the same hierarchy inside.
    const active = list.filter(j => !j.done), done = list.filter(j => j.done).sort((a, b) => (b.resolved || '').localeCompare(a.resolved || ''));
    const folder = (key, label, items, defOpen) => {
      const open = !!q || (defOpen ? !this.open.has('-' + key) : this.open.has(key));
      return node('folder top', key, 0, `<span class="tw" data-jtog="${defOpen ? '-' : ''}${key}">${open ? '▾' : '▸'}</span>${label} <span class="n">${items.length}</span>`) + (open ? items.map(issueHTML).join('') : '');
    };
    $('#jiraTree').innerHTML = list.length
      ? folder('f:open', '📂 In progress', active, true) + folder('f:done', '✅ Completed', done, false)
      : `<div class="empty">${this.issues.length ? 'No matches.' : 'No Jira issues yet.<br>Type a key (PAY-123) or paste an issue link above.'}</div>`;
    this.renderDetail();
  },

  find(key) {
    if (!key) return null;
    const [kind, k, i] = key.split(':');
    const j = this.issues.find(x => x.key === (kind === 'i' || kind === 'p' || kind === 'c' ? k : k));
    if (!j) return null;
    if (kind === 'pr') return { kind, j, item: j.prs[+i] };
    if (kind === 'ch') return { kind, j, item: j.children[+i] };
    if (kind === 'kid') return { kind: 'ch', j, item: (j.kids || [])[+i] };
    return { kind, j };
  },

  renderDetail() {
    const f = this.find(this.sel), el = $('#jiraDetail');
    if (!f) { el.innerHTML = '<div class="empty">Select an issue, pull request or item on the left.<br>Double-click opens it in the browser.</div>'; return; }
    const j = f.j;
    const head = `<div class="ghead"><h3><a class="jkey" href="${esc(j.url)}" data-jlink="${esc(j.url)}" title="Open in Jira">${esc(j.key)}</a></h3><span class="jstat">${esc(j.status || '')}</span><span class="spacer"></span>
      <button data-ja="thread" title="${typeof Work !== 'undefined' && Work.byJira(j.key) ? 'Open the task thread linked to this issue' : 'Start a task thread linked to this issue'}">🧵 ${typeof Work !== 'undefined' && Work.byJira(j.key) ? 'Thread' : 'Start thread'}</button><button data-ja="open" data-url="${esc(j.url)}">Open in browser</button><button data-ja="refresh">↻ Refresh</button><button data-ja="remove" title="Stop tracking it in WorkHub — nothing changes in Jira (WorkHub only reads from Jira)">Stop tracking</button></div>`;
    const info = `<div class="gsec"><a href="${esc(j.url)}" data-jlink="${esc(j.url)}" class="jsumlink"><b>${esc(j.summary || '')}</b></a><div class="muted tiny">${esc(j.type || '')}${j.assignee ? ' · ' + esc(j.assignee) : ''}${j.fetched ? ' · checked ' + esc(new Date(j.fetched).toLocaleString()) : ''}</div>
      ${j.error ? `<div class="dberr" style="margin-top:6px">⚠ ${esc(j.error)}</div>` : ''}</div>`;
    let body = '';
    if (f.kind === 'pr') body = `<div class="gsec"><h4>Pull request</h4><div class="grow">${this.prBadge(f.item.status)} <a href="${esc(f.item.url)}" target="_blank" rel="noopener">${esc(f.item.name)}</a></div><div class="muted tiny">${esc(f.item.repo || '')}${f.item.author ? ' · ' + esc(f.item.author) : ''}</div></div>`;
    else if (f.kind === 'ch') body = `<div class="gsec"><h4>${esc(f.item.relation)}</h4><div class="grow"><a class="jkey" href="${esc(f.item.url)}" data-jlink="${esc(f.item.url)}">${esc(f.item.key)}</a> <a href="${esc(f.item.url)}" target="_blank" rel="noopener">${esc(f.item.summary)}</a> <span class="jstat">${esc(f.item.status)}</span></div><div class="muted tiny">${esc(f.item.type || '')}</div></div>`;
    else body = `<div class="gsec"><h4>Pull requests <span class="n">${j.prs.length}</span></h4>${j.prs.map(p => `<div class="grow">${this.prBadge(p.status)} <a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name)}</a> <span class="muted tiny">${esc(p.repo || '')}</span></div>`).join('') || '<div class="muted tiny">None found in Jira\'s development panel or links.</div>'}</div>
      <div class="gsec"><h4>🧩 Child work items <span class="n">${(j.kids || []).length}</span></h4>${(j.kids || []).map(c => `<div class="grow"><a class="jkey" href="${esc(c.url)}" data-jlink="${esc(c.url)}">${esc(c.key)}</a> <a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.summary)}</a> ${c.type ? `<span class="muted tiny">${esc(c.type)}</span>` : ''} <span class="jstat">${esc(c.status)}</span></div>`).join('') || '<div class="muted tiny">No sub-tasks or child issues.</div>'}</div>
      <div class="gsec"><h4>${esc(this.cfg?.child_prefix || 'CM-')} items <span class="n">${j.children.length}</span></h4>${j.children.map(c => `<div class="grow"><a class="jkey" href="${esc(c.url)}" data-jlink="${esc(c.url)}">${esc(c.key)}</a> <a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.summary)}</a> <span class="jstat">${esc(c.status)}</span> <span class="muted tiny">${esc(c.relation)}</span></div>`).join('') || '<div class="muted tiny">No sub-tasks or linked issues starting with that prefix.</div>'}</div>`;
    el.innerHTML = head + info + body;
  },

  async add(ref) {
    if (!ref.trim()) return;
    $('#jiraAddBtn').disabled = true; toast('Fetching from Jira…');
    try {
      this.issues = await api('POST', '/api/jira', { ref });
      const key = (ref.toUpperCase().match(/[A-Z][A-Z0-9_]+-\d+/) || [])[0];
      if (key) { this.open.add(key); this.open.add('p:' + key); this.open.add('c:' + key); this.persist(); this.sel = 'i:' + key; }
      $('#jiraAdd').value = '';
      await this.load();
      const j = this.issues.find(x => x.key === key);
      toast(j?.error ? '⚠ ' + j.error : `${key}: ${j?.prs.length || 0} pull request(s), ${j?.children.length || 0} item(s)`, !!j?.error);
    } catch (err) { toast(err.message, true); }
    $('#jiraAddBtn').disabled = false;
  },

  modeRows() {
    const m = $('#jiraMode').value;
    $('#jiraUserRow').hidden = m === 'server' || m === 'browser';
    $('#jiraTokenRow').hidden = m === 'browser';
    $('#jiraBrowserRow').hidden = m !== 'browser';
    if (m === 'browser') this.showSession();
  },
  showSession() {
    const s = this.session || {}, el = $('#jiraSignState');
    if (!window.WH_DESKTOP && !s.available) { el.textContent = 'Only in WorkHub-Desktop.exe — the web version needs a token.'; $('#jiraSignIn').disabled = true; return; }
    $('#jiraSignIn').disabled = false;
    el.textContent = s.signed_in ? `✅ Signed in${s.name ? ' as ' + s.name : ''}${s.since ? ' since ' + new Date(s.since).toLocaleString() : ''}` : s.checked ? 'Not signed in' : '';
  },

  // Opens the Jira window and waits (up to 10 minutes) for the login.
  async signIn() {
    const base = (this.cfg?.mode === 'browser' && this.cfg.base_url) || $('#jiraUrl').value.trim();
    if (!base) return toast('Enter the Jira address first', true);
    if ($('#jiraDlg').open && ($('#jiraMode').value !== this.cfg?.mode || $('#jiraUrl').value.trim() !== this.cfg?.base_url))
      await api('PUT', '/api/jira/config', { base_url: $('#jiraUrl').value.trim(), mode: 'browser', user: '', token: '', child_prefix: $('#jiraPrefix').value.trim() || 'CM-' });
    try { await api('POST', '/api/jira/browser', {}); } catch (err) { return toast(err.message, true); }
    $('#jiraSignState').textContent = '⏳ Waiting for you to log in in the Jira window…';
    clearTimeout(this.signTimer);
    const until = Date.now() + 10 * 60e3;
    const poll = async () => {
      const s = await api('GET', '/api/jira/browser?check=1').catch(() => ({}));
      if (s.signed_in) {
        this.session = s; this.showSession();
        await api('POST', '/api/jira/browser', { hide: true }).catch(() => {});
        toast(`Signed in to Jira${s.name ? ' as ' + s.name : ''} — loading your issues…`);
        await api('POST', '/api/jira/refresh', {}).catch(() => {});
        try { const r = await api('POST', '/api/jira/mine'); toast(`Signed in${s.name ? ' as ' + s.name : ''} — ${r.added ? `added ${r.added} of your issues` : 'your issues are up to date'}`); }
        catch (err) { toast('Signed in, but ' + err.message, true); }
        return this.load();
      }
      if (Date.now() < until) this.signTimer = setTimeout(poll, 4000);
      else { $('#jiraSignState').textContent = 'Not signed in yet — press the button again when ready'; }
    };
    this.signTimer = setTimeout(poll, 5000);
  },

  settings() {
    const c = this.cfg || {}, d = $('#jiraDlg');
    $('#jiraUrl').value = c.base_url || ''; $('#jiraMode').value = c.mode || 'cloud'; $('#jiraUser').value = c.user || '';
    $('#jiraToken').value = ''; $('#jiraToken').placeholder = this.hasToken ? '(saved — leave blank to keep)' : 'API token / personal access token';
    $('#jiraPrefix').value = c.child_prefix || 'CM-';
    this.modeRows();
    d.returnValue = '';
    d.showModal();
  },
};

$('#jiraAddBtn').onclick = () => Jira.add($('#jiraAdd').value);
$('#jiraAdd').addEventListener('keydown', e => { if (e.key === 'Enter') Jira.add(e.target.value); });
$('#jiraFilter').addEventListener('input', () => Jira.render());
$('#jiraSettings').onclick = () => Jira.settings();
$('#jiraSetupLink').onclick = () => Jira.settings();
$('#jiraMine').onclick = async () => {
  toast('Looking for your issues in Jira…');
  try { const r = await api('POST', '/api/jira/mine'); Jira.issues = r.issues; Jira.open.add('f:open'); Jira.persist(); Jira.render(); toast(r.added ? `Added ${r.added} of your issues (open ones under 📂 In progress, done ones under ✅ Completed)` : 'No new issues assigned to you'); }
  catch (err) { toast(err.message, true); }
};
// Loaded at start too, so the main search finds Jira issues; kept fresh.
Jira.load(); setInterval(() => Jira.load(), 5 * 60 * 1000);
$('#jiraRefreshAll').onclick = async () => { toast('Refreshing from Jira…'); Jira.issues = await api('POST', '/api/jira/refresh', {}).catch(err => (toast(err.message, true), Jira.issues)); Jira.render(); };
$('#jiraMode').onchange = () => Jira.modeRows();
$('#jiraSignIn').onclick = () => Jira.signIn();
$('#jiraSignBtn').onclick = () => Jira.signIn();
$('#jiraDlg').addEventListener('close', async () => {
  if ($('#jiraDlg').returnValue !== 'save') return;
  await api('PUT', '/api/jira/config', { base_url: $('#jiraUrl').value.trim(), mode: $('#jiraMode').value, user: $('#jiraUser').value.trim(), token: $('#jiraToken').value, child_prefix: $('#jiraPrefix').value.trim() || 'CM-' });
  toast('Jira settings saved — refreshing…');
  setTimeout(() => Jira.load(), 2500);
  Jira.load();
});
// Jira keys are links: open the ticket in the browser (not inside WorkHub).
document.addEventListener('click', e => {
  const a = e.target.closest('[data-jlink]'); if (!a) return;
  e.preventDefault(); e.stopPropagation(); openExternal(a.dataset.jlink);
}, true);
$('#jiraTree').addEventListener('click', e => {
  const tog = e.target.closest('[data-jtog]');
  if (tog && tog.textContent) { const k = tog.dataset.jtog; Jira.open.has(k) ? Jira.open.delete(k) : Jira.open.add(k); Jira.persist(); return Jira.render(); }
  const n = e.target.closest('[data-jk]'); if (!n) return;
  Jira.sel = n.dataset.jk; Jira.render();
});
$('#jiraTree').addEventListener('dblclick', e => {
  const f = Jira.find(e.target.closest('[data-jk]')?.dataset.jk); if (!f) return;
  openExternal(f.item?.url || f.j.url);
});
$('#jiraDetail').addEventListener('click', async e => {
  const b = e.target.closest('[data-ja]'); if (!b) return;
  const j = Jira.find(Jira.sel)?.j; if (!j) return;
  if (b.dataset.ja === 'open') return openExternal(b.dataset.url);
  if (b.dataset.ja === 'thread') return Work.forJira(j.key, j.summary);
  if (b.dataset.ja === 'refresh') { Jira.issues = await api('POST', '/api/jira/refresh', { key: j.key }); return Jira.render(); }
  if (b.dataset.ja === 'remove' && confirm(`Stop tracking ${j.key} in WorkHub?\n\nNothing changes in Jira — WorkHub only reads from it.`)) { await api('DELETE', '/api/jira/' + encodeURIComponent(j.key)); Jira.sel = null; return Jira.load(); }
});
