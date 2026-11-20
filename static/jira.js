'use strict';
// Jira page: tracked issues as a tree — each issue with its pull requests and
// its "CM-" items (sub-tasks / linked issues). Refreshed every 15 minutes.

const Jira = {
  issues: [], cfg: null, hasToken: false, open: new Set(JSON.parse((() => { try { return localStorage.getItem('jiraOpen') || '[]'; } catch { return '[]'; } })())),
  sel: null,

  async load() {
    const [list, c] = await Promise.all([api('GET', '/api/jira').catch(() => []), api('GET', '/api/jira/config').catch(() => ({}))]);
    this.issues = list || []; this.cfg = c.config || {}; this.hasToken = !!c.has_token;
    this.render();
  },
  persist() { try { localStorage.setItem('jiraOpen', JSON.stringify([...this.open])); } catch { /* ignore */ } },

  prBadge(s) { return s ? `<span class="prs ${s.toLowerCase()}">${esc(s.toLowerCase())}</span>` : ''; },

  render() {
    const ready = this.cfg?.base_url && this.hasToken;
    $('#jiraSetupHint').hidden = !!ready;
    const q = $('#jiraFilter').value.trim().toLowerCase();
    const list = this.issues.filter(j => !q || [j.key, j.summary, j.status, j.assignee, ...j.prs.map(p => p.name + ' ' + p.repo), ...j.children.map(c => c.key + ' ' + c.summary)].join(' ').toLowerCase().includes(q));
    const prefix = this.cfg?.child_prefix || 'CM-';
    const node = (cls, key, depth, html, title = '') => `<div class="tnode jn ${cls} ${this.sel === key ? 'sel' : ''}" data-jk="${esc(key)}" style="padding-left:${8 + depth * 16}px" title="${esc(title)}">${html}</div>`;
    $('#jiraTree').innerHTML = list.map(j => {
      const k = j.key, open = this.open.has(k) || !!q;
      let h = node('issue', 'i:' + k, 0, `<span class="tw" data-jtog="${esc(k)}">${open ? '▾' : '▸'}</span><b>${esc(k)}</b> <span class="nm">${esc(j.summary || '')}</span>${j.status ? `<span class="jstat">${esc(j.status)}</span>` : ''}${j.error ? '<span class="dot fail" title="' + esc(j.error) + '"></span>' : ''}`, j.error || j.summary);
      if (open) {
        const pOpen = this.open.has('p:' + k), cOpen = this.open.has('c:' + k);
        h += node('folder', 'p:' + k, 1, `<span class="tw" data-jtog="p:${esc(k)}">${j.prs.length ? (pOpen ? '▾' : '▸') : ''}</span>⇄ Pull requests <span class="n">${j.prs.length}</span>`);
        if (pOpen) h += j.prs.map((p, i) => node('pr', `pr:${k}:${i}`, 2, `${this.prBadge(p.status)} <span class="nm">${esc(p.name)}</span><small>${esc(p.repo || '')}</small>`, p.url)).join('');
        h += node('folder', 'c:' + k, 1, `<span class="tw" data-jtog="c:${esc(k)}">${j.children.length ? (cOpen ? '▾' : '▸') : ''}</span>☑ ${esc(prefix)} items <span class="n">${j.children.length}</span>`);
        if (cOpen) h += j.children.map((c, i) => node('child', `ch:${k}:${i}`, 2, `<b>${esc(c.key)}</b> <span class="nm">${esc(c.summary)}</span><span class="jstat">${esc(c.status)}</span>`, `${c.relation}: ${c.summary}`)).join('');
      }
      return h;
    }).join('') || `<div class="empty">${this.issues.length ? 'No matches.' : 'No Jira issues yet.<br>Type a key (PAY-123) or paste an issue link above.'}</div>`;
    this.renderDetail();
  },

  find(key) {
    if (!key) return null;
    const [kind, k, i] = key.split(':');
    const j = this.issues.find(x => x.key === (kind === 'i' || kind === 'p' || kind === 'c' ? k : k));
    if (!j) return null;
    if (kind === 'pr') return { kind, j, item: j.prs[+i] };
    if (kind === 'ch') return { kind, j, item: j.children[+i] };
    return { kind, j };
  },

  renderDetail() {
    const f = this.find(this.sel), el = $('#jiraDetail');
    if (!f) { el.innerHTML = '<div class="empty">Select an issue, pull request or item on the left.<br>Double-click opens it in the browser.</div>'; return; }
    const j = f.j;
    const head = `<div class="ghead"><h3>${esc(j.key)}</h3><span class="jstat">${esc(j.status || '')}</span><span class="spacer"></span>
      <button data-ja="open" data-url="${esc(j.url)}">Open in browser</button><button data-ja="refresh">↻ Refresh</button><button data-ja="remove" class="danger">Remove</button></div>`;
    const info = `<div class="gsec"><b>${esc(j.summary || '')}</b><div class="muted tiny">${esc(j.type || '')}${j.assignee ? ' · ' + esc(j.assignee) : ''}${j.fetched ? ' · checked ' + esc(new Date(j.fetched).toLocaleString()) : ''}</div>
      ${j.error ? `<div class="dberr" style="margin-top:6px">⚠ ${esc(j.error)}</div>` : ''}</div>`;
    let body = '';
    if (f.kind === 'pr') body = `<div class="gsec"><h4>Pull request</h4><div class="grow">${this.prBadge(f.item.status)} <a href="${esc(f.item.url)}" target="_blank" rel="noopener">${esc(f.item.name)}</a></div><div class="muted tiny">${esc(f.item.repo || '')}${f.item.author ? ' · ' + esc(f.item.author) : ''}</div></div>`;
    else if (f.kind === 'ch') body = `<div class="gsec"><h4>${esc(f.item.relation)}</h4><div class="grow"><b>${esc(f.item.key)}</b> <a href="${esc(f.item.url)}" target="_blank" rel="noopener">${esc(f.item.summary)}</a> <span class="jstat">${esc(f.item.status)}</span></div><div class="muted tiny">${esc(f.item.type || '')}</div></div>`;
    else body = `<div class="gsec"><h4>Pull requests <span class="n">${j.prs.length}</span></h4>${j.prs.map(p => `<div class="grow">${this.prBadge(p.status)} <a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name)}</a> <span class="muted tiny">${esc(p.repo || '')}</span></div>`).join('') || '<div class="muted tiny">None found in Jira\'s development panel or links.</div>'}</div>
      <div class="gsec"><h4>${esc(this.cfg?.child_prefix || 'CM-')} items <span class="n">${j.children.length}</span></h4>${j.children.map(c => `<div class="grow"><b>${esc(c.key)}</b> <a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.summary)}</a> <span class="jstat">${esc(c.status)}</span> <span class="muted tiny">${esc(c.relation)}</span></div>`).join('') || '<div class="muted tiny">No sub-tasks or linked issues starting with that prefix.</div>'}</div>`;
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

  settings() {
    const c = this.cfg || {}, d = $('#jiraDlg');
    $('#jiraUrl').value = c.base_url || ''; $('#jiraMode').value = c.mode || 'cloud'; $('#jiraUser').value = c.user || '';
    $('#jiraToken').value = ''; $('#jiraToken').placeholder = this.hasToken ? '(saved — leave blank to keep)' : 'API token / personal access token';
    $('#jiraPrefix').value = c.child_prefix || 'CM-';
    $('#jiraUserRow').hidden = $('#jiraMode').value === 'server';
    d.showModal();
  },
};

$('#jiraAddBtn').onclick = () => Jira.add($('#jiraAdd').value);
$('#jiraAdd').addEventListener('keydown', e => { if (e.key === 'Enter') Jira.add(e.target.value); });
$('#jiraFilter').addEventListener('input', () => Jira.render());
$('#jiraSettings').onclick = () => Jira.settings();
$('#jiraSetupLink').onclick = () => Jira.settings();
$('#jiraRefreshAll').onclick = async () => { toast('Refreshing from Jira…'); Jira.issues = await api('POST', '/api/jira/refresh', {}).catch(err => (toast(err.message, true), Jira.issues)); Jira.render(); };
$('#jiraMode').onchange = e => ($('#jiraUserRow').hidden = e.target.value === 'server');
$('#jiraDlg').addEventListener('close', async () => {
  if ($('#jiraDlg').returnValue !== 'save') return;
  await api('PUT', '/api/jira/config', { base_url: $('#jiraUrl').value.trim(), mode: $('#jiraMode').value, user: $('#jiraUser').value.trim(), token: $('#jiraToken').value, child_prefix: $('#jiraPrefix').value.trim() || 'CM-' });
  toast('Jira settings saved — refreshing…');
  setTimeout(() => Jira.load(), 2500);
  Jira.load();
});
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
  if (b.dataset.ja === 'refresh') { Jira.issues = await api('POST', '/api/jira/refresh', { key: j.key }); return Jira.render(); }
  if (b.dataset.ja === 'remove' && confirm(`Stop tracking ${j.key}?`)) { await api('DELETE', '/api/jira/' + encodeURIComponent(j.key)); Jira.sel = null; return Jira.load(); }
});
