'use strict';
// 🔎 Ask Confluence & Jira: a question in plain words → matching Confluence
// pages and Jira issues together, with the matching sentences in yellow.
// ✨ AI answer: only when switched on in ⚙ Settings → Ask (off by default) —
// then the top matches go to Claude with your own API key and it answers with
// links to its sources.

const Ask = {
  cfg: null, conf: null, last: null,
  async status(fresh) {
    if (!this.cfg || fresh) [this.cfg, this.conf] = await Promise.all([api('GET', '/api/ask/config').catch(() => ({})), api('GET', '/api/confluence/config').catch(() => ({}))]);
    return this.cfg;
  },
  // where to search: the two checkboxes (Confluence by default), remembered
  sources() { const s = []; if ($('#askInConf').checked) s.push('confluence'); if ($('#askInJira').checked) s.push('jira'); return s.length ? s : ['confluence']; },
  ready() { const c = this.conf?.config || {}; return !!(c.base_url || c.mode === 'jira') || !!(typeof Jira !== 'undefined' && Jira.cfg?.base_url); },

  async show() {
    await this.status(true);
    const c = this.conf?.config || {};
    $('#askSetup').hidden = !!(c.base_url || c.mode === 'jira' || (!c.mode && Jira?.cfg?.base_url)); // never set up: Jira's login is tried
    $('#askAIWrap').hidden = !(this.cfg.ai && this.cfg.has_key);
    $('#askQ').focus();
  },

  async run(q) {
    q = (q ?? $('#askQ').value).trim(); if (!q) return;
    const ai = !$('#askAIWrap').hidden && $('#askAI').checked;
    $('#askOut').innerHTML = `<div class="muted ask-wait">🔎 Searching Confluence and Jira${ai ? ' — then ✨ writing an answer' : ''}…</div>`;
    $('#askGo').disabled = true;
    let r;
    try { r = await api('POST', '/api/ask', { q, ai, sources: this.sources() }); } catch (err) { $('#askGo').disabled = false; $('#askOut').innerHTML = `<div class="ask-err">${esc(err.message)}</div>`; return; }
    $('#askGo').disabled = false;
    this.last = { q, r };
    try { const h = JSON.parse(localStorage.getItem('askHist') || '[]').filter(x => x !== q); h.unshift(q); localStorage.setItem('askHist', JSON.stringify(h.slice(0, 12))); } catch { /* ignore */ }
    this.render(q, r);
  },

  render(q, r) {
    const ico = s => s.source === 'confluence' ? '<span class="ask-src conf" title="Confluence">📄 Confluence</span>' : '<span class="ask-src jira" title="Jira">◆ Jira</span>';
    const out = [];
    out.push(`<div class="muted tiny ask-srcs">Searched: ${r.sources?.length ? r.sources.map(esc).join(' · ') : 'nothing yet'}</div>`);
    if (r.errors?.length) out.push(`<div class="ask-err">${r.errors.map(esc).join('<br>')}${r.errors.some(e => e.startsWith('Confluence')) ? ' — <a href="#" data-askset>set up Confluence in ⚙ Settings → Ask</a>' : ''}</div>`);
    if (r.answer?.length) {
      out.push(`<div class="ask-answer"><div class="ask-ahead">✨ Answer <span class="muted tiny">written by AI from the ${r.ai_used} best matches — check the sources</span></div>${r.answer.map(p =>
        `<span>${esc(p.text)}</span>${(p.cites || []).map(i => `<a href="${esc(r.results[i]?.url || '#')}" class="ask-cite" data-askopen="${i}" title="${esc(r.results[i]?.title || '')}">${i + 1}</a>`).join('')}`).join('')}</div>`);
    } else if (r.ai_error) out.push(`<div class="ask-err">✨ ${esc(r.ai_error)}</div>`);
    if (!r.results.length) out.push(`<div class="muted ask-none">Nothing found for <b>${esc(r.words.join(' '))}</b>${r.errors?.length ? '' : ' — try other words, a page title or an issue key'}.</div>`);
    else out.push(`<div class="muted tiny ask-count">${r.results.length} match${r.results.length > 1 ? 'es' : ''} for <b>${esc(r.words.join(' '))}</b>${r.index ? ` · 📚 ${esc(r.index)}` : ''}</div>` + r.results.map((x, i) => `
      <div class="ask-row" data-askopen="${i}">
        <div class="ask-top"><span class="ask-n">${i + 1}</span>${ico(x)}<a href="${esc(x.url)}" class="ask-title" data-askopen="${i}">${esc(x.title)}</a>
          ${x.source === 'jira' ? `<span class="ask-key">${esc(x.id)}</span>` : ''}${x.status ? `<span class="tag">${esc(x.status)}</span>` : ''}
          <span class="spacer"></span><span class="muted tiny">${esc([x.where, x.kind].filter(Boolean).join(' · '))}${x.updated ? ' · ' + esc(fmtTime(x.updated)) : ''}</span></div>
        <div class="ask-snip">${esc(x.snip || '')}</div>
        <div class="ask-acts"><button type="button" class="icon" data-askcopy="${i}" title="Copy the link">🔗 Copy link</button>${typeof Work !== 'undefined' ? `<button type="button" class="icon" data-askthread="${i}" title="Post the link in a thread">🧵 To a thread…</button>` : ''}</div>
      </div>`).join(''));
    $('#askOut').innerHTML = out.join('');
    if (typeof markIn === 'function') $$('#askOut .ask-snip, #askOut .ask-title').forEach(el => markIn(el, r.words));
  },

  // ⚙ Settings → Ask
  async settingsHTML(row, btn, sw, sel) {
    await this.status(true);
    const c = this.conf?.config || {}, mode = c.mode || (typeof Jira !== 'undefined' && Jira.cfg?.base_url ? 'jira' : 'cloud');
    const inp = (k, v, ph, type = 'text') => `<input data-set="${k}" type="${type}" value="${esc(v || '')}" placeholder="${esc(ph)}" style="width:300px" autocomplete="off">`;
    const signed = this.conf?.signed_in ? '✓ connected' : '';
    return [
      row('🔎 Ask Confluence & Jira', 'Search Confluence pages and Jira issues together from the 🔎 Ask page in the left menu. Jira uses your Jira settings.', btn('ask-open', 'Open Ask')),
      row('Confluence sign-in', 'Same as Jira works for Atlassian Cloud (Confluence at <site>/wiki). Server / Data Center: its own address and a personal access token, or sign in with the browser.',
        sel('conf-mode', mode, [['jira', 'Same as my Jira login (Atlassian Cloud)'], ['browser', 'Sign in with browser (Desktop) — SSO / MFA'], ['cloud', 'Confluence Cloud — email + API token'], ['server', 'Server / Data Center — personal access token'], ['basic', 'Username + password']])),
      row('Confluence address', mode === 'jira' ? 'Leave empty to use your Jira site + /wiki' : 'e.g. https://acme.atlassian.net/wiki or https://confluence.acme.com', inp('conf-url', c.base_url, mode === 'jira' ? '(your Jira site)/wiki' : 'https://…')),
      ...(mode === 'cloud' || mode === 'basic' ? [row(mode === 'cloud' ? 'Email' : 'Username', '', inp('conf-user', c.user, mode === 'cloud' ? 'you@example.com' : 'username'))] : []),
      ...(['cloud', 'server', 'basic'].includes(mode) ? [row(mode === 'basic' ? 'Password' : 'Token', 'Stored encrypted; never shown again. Cloud: id.atlassian.com → Security → API tokens. Server/DC: your profile → Personal Access Tokens.', inp('conf-token', '', this.conf?.has_token ? '(saved — leave blank to keep)' : 'token', 'password'))] : []),
      ...(mode === 'browser' ? [row('Sign in', this.conf?.browser ? 'A Confluence window opens: log in as usual (SSO / MFA). WorkHub notices when you are in and hides the window.' : 'Works in WorkHub-Desktop.exe — in the web version pick a token sign-in.',
        `<span id="confSignState" class="muted tiny">${signed}</span> ${btn('conf-signin', '🔑 Sign in with browser…', 'primary')}`)] : []),
      row('Check the connection', '', `<span id="confTestState" class="muted tiny">${signed}</span> ${btn('conf-test', 'Test')}`),
      ...await this.indexRows(row, btn, sw, sel),
      row('✨ AI answers', 'Off by default. When on, the Ask page can write a short answer from the best matches: those pages and issues are sent to Anthropic (Claude) with your own API key — check that your company allows this.', sw('ask-ai', this.cfg.ai)),
      row('Anthropic API key', 'From console.anthropic.com → API keys. Kept in WorkHub (encrypted), never shown again.', `${inp('ask-key', '', this.cfg.has_key ? '(saved — leave blank to keep)' : 'sk-ant-…', 'password')}${this.cfg.has_key ? ' ' + btn('ask-key-del', 'Remove') : ''}`),
      row('AI model', 'Default: claude-opus-5-5', inp('ask-model', this.cfg.model, 'claude-opus-5-5')),
    ];
  },
  // 📚 the local copy of chosen spaces
  async indexRows(row, btn, sw, sel) {
    const ix = this.ix = await api('GET', '/api/confindex').catch(() => ({}));
    const state = ix.running ? `⏳ ${esc(ix.progress || 'syncing…')}` : ix.pages ? `${ix.pages} pages from ${Object.keys(ix.per_space || {}).length} space(s) · synced ${esc(fmtTime(ix.last_sync))}${ix.size ? ' · ' + fmtSize(ix.size) : ''}` : 'Not downloaded yet';
    return [
      `<div class="set-h">📚 Local copy of Confluence</div>`,
      row('Keep a local copy', 'The pages of the spaces you pick are downloaded once and kept in WorkHub (encrypted, not in backups); 🔎 Ask then searches them instantly, offline too, with word endings matched (restart ≈ restarting). Check your company allows keeping Confluence pages on your laptop.', sw('ci-on', ix.on)),
      row('Spaces', ix.spaces?.length ? (ix.spaces || []).map(k => `${esc(k)} (${ix.per_space?.[k] || 0} page${ix.per_space?.[k] === 1 ? '' : 's'})`).join(', ') : 'None chosen yet', `<span id="ciSpaces"></span>${btn('ci-pick', 'Choose spaces…')}`),
      row('Fetch changed pages', 'New and edited pages are fetched this often; once a day every page is checked again, so deleted and moved pages drop out.', sel('ci-every', String(ix.every || 60), [['15', 'Every 15 minutes'], ['30', 'Every 30 minutes'], ['60', 'Every hour'], ['120', 'Every 2 hours'], ['240', 'Every 4 hours'], ['480', 'Every 8 hours'], ['1440', 'Once a day']])),
      row('Status', `<span id="ciState">${state}</span>${ix.error ? `<div class="ask-err tiny">${esc(ix.error)}</div>` : ''}`, `${btn('ci-sync', '↻ Sync now')} ${btn('ci-rebuild', 'Rebuild')} ${ix.pages ? btn('ci-del', 'Delete the copy') : ''}`),
    ];
  },
  async ciPut(patch) {
    const ix = this.ix || {};
    await api('PUT', '/api/confindex', { on: ix.on, spaces: ix.spaces || [], every: ix.every || 60, ...patch });
  },
  ciWatch() { // while a sync runs: the status line moves
    clearTimeout(this.ciT);
    const tick = async () => {
      const ix = await api('GET', '/api/confindex').catch(() => null); if (!ix) return;
      const el = $('#ciState');
      if (ix.running) { if (el) el.textContent = '⏳ ' + (ix.progress || 'syncing…'); this.ciT = setTimeout(tick, 1500); return; }
      if ($('#settingsDlg').open && Settings.tab === 'ask') Settings.render();
      toast(ix.error ? 'Sync: ' + ix.error : `Local copy up to date — ${ix.pages} pages`, !!ix.error);
    };
    this.ciT = setTimeout(tick, 1200);
  },
  async pickSpaces() {
    const box = $('#ciSpaces'); if (!box) return;
    box.innerHTML = '<span class="muted tiny">Loading spaces…</span>';
    let list = [];
    try { list = await api('GET', '/api/confluence/spaces'); } catch (err) { box.innerHTML = `<span class="ask-err tiny">${esc(err.message)}</span>`; return; }
    const have = new Set(this.ix?.spaces || []);
    const d = Object.assign(document.createElement('dialog'), { className: 'ci-pick' });
    d.innerHTML = `<h3>📚 Spaces to keep a local copy of</h3><input type="search" class="ci-filter" placeholder="Filter spaces…">
      <div class="ci-list">${list.map(s => `<label><input type="checkbox" value="${esc(s.key)}" ${have.has(s.key) ? 'checked' : ''}> <b>${esc(s.name)}</b> <span class="muted tiny">${esc(s.key)}</span></label>`).join('') || '<div class="muted">No spaces found.</div>'}</div>
      <div class="row end"><button type="button" data-ci="no">Cancel</button><button type="button" class="primary" data-ci="ok">Save and download</button></div>`;
    document.body.append(d); d.showModal(); box.innerHTML = '';
    d.querySelector('.ci-filter').addEventListener('input', e => { const q = e.target.value.toLowerCase(); d.querySelectorAll('.ci-list label').forEach(l => { l.hidden = !l.textContent.toLowerCase().includes(q); }); });
    d.addEventListener('close', () => d.remove());
    d.addEventListener('click', async e => {
      const b = e.target.closest('[data-ci]'); if (!b) return;
      if (b.dataset.ci === 'ok') {
        const spaces = [...d.querySelectorAll('.ci-list input:checked')].map(i => i.value);
        await this.ciPut({ spaces, on: spaces.length > 0 });
        toast(spaces.length ? `Downloading ${spaces.length} space${spaces.length > 1 ? 's' : ''}…` : 'No spaces chosen');
        if (spaces.length) this.ciWatch();
      }
      d.close(); Settings.tab = 'ask'; Settings.render();
    });
  },
  async saveConf() {
    const v = k => $(`#settingsBody [data-set="${k}"]`)?.value ?? undefined;
    const c = this.conf?.config || {};
    await api('PUT', '/api/confluence/config', { base_url: (v('conf-url') ?? c.base_url ?? '').trim(), mode: v('conf-mode') || c.mode || 'jira', user: (v('conf-user') ?? c.user ?? '').trim(), token: v('conf-token') || '' });
  },
  async signIn() {
    await this.saveConf();
    try { await api('POST', '/api/confluence/browser', {}); } catch (err) { return toast(err.message, true); }
    const st = () => $('#confSignState');
    if (st()) st().textContent = '⏳ Waiting for you to log in in the Confluence window…';
    clearTimeout(this.signTimer);
    const until = Date.now() + 10 * 60e3;
    const poll = async () => {
      const ok = await api('POST', '/api/confluence/test').then(() => true, () => false);
      if (ok) {
        await api('POST', '/api/confluence/browser', { hide: true }).catch(() => {});
        if (st()) st().textContent = '✓ signed in';
        return toast('Signed in to Confluence ✓ — try 🔎 Ask');
      }
      if (Date.now() < until) this.signTimer = setTimeout(poll, 4000);
      else if (st()) st().textContent = 'Not signed in yet — press the button again when ready';
    };
    this.signTimer = setTimeout(poll, 5000);
  },
};

// ---- the page ----
$('#askGo').onclick = () => Ask.run();
$('#askQ').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); Ask.run(); } });
$('#askQ').addEventListener('focus', () => {
  let h = []; try { h = JSON.parse(localStorage.getItem('askHist') || '[]'); } catch { /* ignore */ }
  $('#askHist').innerHTML = h.map(q => `<option value="${esc(q)}">`).join('');
});
$('#askOut').addEventListener('click', async e => {
  if (e.target.closest('[data-askset]')) { e.preventDefault(); return openSettingsAt('ask'); }
  const r = Ask.last?.r; if (!r) return;
  const cp = e.target.closest('[data-askcopy]'); if (cp) { const x = r.results[+cp.dataset.askcopy]; return copyText(`${x.source === 'jira' ? x.id + ' ' : ''}${x.title}\n${x.url}`, 'Link copied'); }
  const th = e.target.closest('[data-askthread]');
  if (th) {
    const x = r.results[+th.dataset.askthread];
    if (!Work.list.length) await Work.loadList();
    return Work.pick(e, async id => { await api('POST', `/api/work/${id}/posts`, { kind: 'note', html: `<p>${x.source === 'jira' ? '◆' : '📄'} <a href="${esc(x.url)}">${esc((x.source === 'jira' ? x.id + ' ' : '') + x.title)}</a></p>${x.snip ? `<blockquote>${esc(x.snip)}</blockquote>` : ''}` }); toast('Posted in the thread'); });
  }
  const o = e.target.closest('[data-askopen]');
  if (o && !e.target.closest('button')) { e.preventDefault(); const x = r.results[+o.dataset.askopen]; if (x) (typeof openExternal === 'function' ? openExternal : u => window.open(u, '_blank'))(x.url); }
});
$('#askSetupBtn').onclick = () => openSettingsAt('ask');
function openSettingsAt(tab) { Settings.tab = tab; Settings.open ? Settings.open() : $('#settingsTop')?.click(); }

// ---- ⚙ Settings → Ask ----
$('#settingsBody').addEventListener('change', async e => {
  const t = e.target.closest('[data-set]'); if (!t) return;
  const k = t.dataset.set;
  if (k === 'ci-on') {
    if (t.checked && !(Ask.ix?.spaces || []).length) { await Ask.ciPut({ on: true }); return Ask.pickSpaces(); }
    await Ask.ciPut({ on: t.checked }); toast(t.checked ? 'Local copy on — syncing…' : 'Local copy off (kept until you delete it)'); if (t.checked) Ask.ciWatch();
    Settings.tab = 'ask'; return Settings.render();
  }
  if (k === 'ci-every') { await Ask.ciPut({ every: +t.value }); return toast(`Changed pages: ${t.selectedOptions[0].textContent.toLowerCase()}`); }
  if (k === 'conf-mode') { await Ask.saveConf(); Settings.tab = 'ask'; return Settings.render(); }
  if (k === 'conf-url' || k === 'conf-user' || k === 'conf-token') { await Ask.saveConf(); toast('Confluence settings saved'); if (k === 'conf-token') t.value = ''; return; }
  if (k === 'ask-ai' || k === 'ask-key' || k === 'ask-model') {
    await api('PUT', '/api/ask/config', { ai: $('#settingsBody [data-set="ask-ai"]').checked, key: $('#settingsBody [data-set="ask-key"]').value.trim(), model: $('#settingsBody [data-set="ask-model"]').value.trim() });
    if (k === 'ask-key') t.value = '';
    await Ask.status(true);
    toast(k === 'ask-ai' ? (t.checked ? (Ask.cfg.has_key ? '✨ AI answers on' : '✨ AI answers on — add your Anthropic API key below') : 'AI answers off') : 'Saved');
    Settings.tab = 'ask'; return Settings.render();
  }
});
$('#settingsBody').addEventListener('click', async e => {
  const b = e.target.closest('button[data-set]'); if (!b) return;
  switch (b.dataset.set) {
    case 'ask-open': $('#settingsDlg').close(); show('ask'); break;
    case 'ci-pick': Ask.pickSpaces(); break;
    case 'ci-sync': case 'ci-rebuild':
      try { await api('POST', '/api/confindex/sync', { full: b.dataset.set === 'ci-rebuild' }); toast(b.dataset.set === 'ci-rebuild' ? 'Checking every page again…' : 'Fetching changed pages…'); Ask.ciWatch(); }
      catch (err) { toast(err.message, true); }
      break;
    case 'ci-del':
      if (!await askYes('Delete the local copy of Confluence?\n\nThe downloaded pages are removed from this laptop; the local copy is switched off. Confluence itself is not touched.')) break;
      await api('DELETE', '/api/confindex'); toast('Local copy deleted'); Settings.tab = 'ask'; Settings.render(); break;
    case 'conf-signin': Ask.signIn(); break;
    case 'conf-test': {
      await Ask.saveConf();
      const s = $('#confTestState'); if (s) s.textContent = '⏳ …';
      try { await api('POST', '/api/confluence/test'); if (s) s.textContent = '✓ connected'; toast('Confluence works ✓'); }
      catch (err) { if (s) s.textContent = '✕ ' + err.message; toast(err.message, true); }
      break;
    }
    case 'ask-key-del': await api('PUT', '/api/ask/config', { ai: false, key: '-', model: Ask.cfg.model }); await Ask.status(true); toast('API key removed — AI answers off'); Settings.tab = 'ask'; Settings.render(); break;
  }
});

// 📄 Confluence / ◆ Jira: which to search (default Confluence); one stays ticked
{
  let saved = ['confluence']; try { saved = JSON.parse(localStorage.getItem('askSources') || '["confluence"]'); } catch { /* default */ }
  $('#askInConf').checked = saved.includes('confluence'); $('#askInJira').checked = saved.includes('jira');
  if (!$('#askInConf').checked && !$('#askInJira').checked) $('#askInConf').checked = true;
  for (const id of ['#askInConf', '#askInJira']) $(id).addEventListener('change', e => {
    if (!$('#askInConf').checked && !$('#askInJira').checked) { e.target.checked = true; return toast('Search at least one: Confluence or Jira', true); }
    try { localStorage.setItem('askSources', JSON.stringify(Ask.sources())); } catch { /* ignore */ }
    if ($('#askQ').value.trim() && Ask.last) Ask.run(); // search again with the new choice
  });
}
