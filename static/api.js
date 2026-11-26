'use strict';
// 🌐 API page — a small Postman. Saved requests in folders, environments of
// {{variables}} (DEV / UAT / PROD…), a history, and the answer pretty-printed.
// WorkHub sends the request (no browser CORS limits); everything is kept with
// your data, encrypted. Variables are filled in here, before sending.

const Api = {
  reqs: [], envs: [], hist: [], cur: null, dirty: false, side: 'saved', ctl: null, resp: null, respTab: 'body',

  blank: () => ({ id: '', name: '', folder: '', method: 'GET', url: '', headers: [], body_type: 'none', body: '', auth: { type: '' }, insecure: false }),

  async load() {
    const d = await api('GET', '/api/http').catch(err => (toast(err.message, true), {}));
    this.reqs = d.requests || []; this.envs = d.envs || []; this.hist = d.history || [];
    if (!this.env() && this.envs.length && !this.envChosen()) this.selectEnv((this.envs.find(e => e.name.toLowerCase() === 'localhost') || this.envs[0]).id); // a default to start with
    if (!this.cur) this.edit(this.blank(), true);
    this.renderEnvs(); this.renderList();
  },

  // ---- environments and {{variables}} ----
  envId() { try { return localStorage.getItem('apiEnv') || ''; } catch { return ''; } },
  envChosen() { try { return localStorage.getItem('apiEnv') !== null; } catch { return false; } }, // "No environment" picked on purpose counts too
  env() { return this.envs.find(e => e.id === this.envId()) || null; },
  vars() { const o = {}; for (const v of this.env()?.vars || []) if (v.on !== false && v.k) o[v.k.trim()] = v.v; return o; },
  fill(s) { const vars = this.vars(); return String(s || '').replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, k) => k in vars ? vars[k] : m); },
  missing(s) { const vars = this.vars(); return [...new Set([...String(s || '').matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)].map(m => m[1]).filter(k => !(k in vars)))]; },
  renderEnvs() {
    $('#apiEnv').innerHTML = '<option value="">No environment</option>' + this.envs.map(e => `<option value="${e.id}" ${e.id === this.envId() ? 'selected' : ''}>${esc(e.name)}</option>`).join('');
    this.showResolved();
  },

  // ---- the request being edited ----
  async edit(r, quiet) {
    if (!quiet && this.dirty && !await askYes('Leave this request without saving your changes?')) return false;
    this.cur = JSON.parse(JSON.stringify({ ...this.blank(), ...r, auth: { type: '', ...(r.auth || {}) } }));
    const c = this.cur;
    $('#apiName').value = c.name; $('#apiMethod').value = c.method || 'GET'; $('#apiURL').value = c.url;
    $('#apiBodyType').value = c.body_type || 'none'; $('#apiBody').value = c.body || '';
    $('#apiAuthType').value = c.auth.type || ''; $('#apiAuthUser').value = c.auth.user || ''; $('#apiAuthPass').value = c.auth.pass || '';
    $('#apiAuthToken').value = c.auth.token || ''; $('#apiAuthKey').value = c.auth.key || '';
    $('#apiInsecure').checked = !!c.insecure;
    this.renderHeaders(); this.showAuth(); this.dirty = false; this.renderList(); this.showResolved();
    return true;
  },
  read() { // the form → this.cur
    const c = this.cur;
    Object.assign(c, { name: $('#apiName').value.trim(), method: $('#apiMethod').value, url: $('#apiURL').value.trim(), body_type: $('#apiBodyType').value, body: $('#apiBody').value, insecure: $('#apiInsecure').checked,
      auth: { type: $('#apiAuthType').value, user: $('#apiAuthUser').value, pass: $('#apiAuthPass').value, token: $('#apiAuthToken').value, key: $('#apiAuthKey').value } });
    c.headers = $$('#apiHeaders .api-hrow').map(r => ({ k: $('.hk', r).value, v: $('.hv', r).value, on: $('.hon', r).checked })).filter(h => h.k || h.v);
    return c;
  },
  changed() { this.dirty = true; this.showResolved(); $('#apiSave').classList.toggle('dirty', true); },
  renderHeaders() {
    const rows = [...this.cur.headers, { k: '', v: '', on: true }];
    $('#apiHeaders').innerHTML = rows.map(h => `<div class="api-hrow"><input type="checkbox" class="hon" ${h.on !== false ? 'checked' : ''} title="Send this header"><input class="hk" placeholder="Header" value="${esc(h.k)}" list="apiHeaderNames"><input class="hv" placeholder="Value — {{variables}} work" value="${esc(h.v)}"><button class="icon hdel" title="Remove">✕</button></div>`).join('')
      + '<datalist id="apiHeaderNames">' + ['Accept', 'Content-Type', 'Authorization', 'X-Request-ID', 'X-Correlation-ID', 'Cache-Control', 'Cookie', 'Accept-Language'].map(h => `<option value="${h}">`).join('') + '</datalist>';
  },
  showAuth() { const t = $('#apiAuthType').value; $$('[data-auth]').forEach(r => { r.hidden = !r.dataset.auth.split(' ').includes(t); }); },
  showResolved() {
    const url = $('#apiURL').value, filled = this.fill(url), miss = this.missing(url + ' ' + $('#apiBody').value + ' ' + $('#apiAuthToken').value);
    $('#apiResolved').innerHTML = (filled !== url ? `→ <span class="mono">${esc(filled)}</span>` : '') + (miss.length ? ` <span class="warnflag">⚠ not set${this.env() ? ` in ${esc(this.env().name)}` : ' (choose an environment)'}: ${miss.map(esc).join(', ')}</span>` : '');
  },

  // ---- list: saved (by folder) or history ----
  renderList() {
    const q = $('#apiFilter').value.trim().toLowerCase(), hit = s => !q || s.toLowerCase().includes(q);
    const mcls = m => `m-${(m || 'GET').toLowerCase()}`;
    if (this.side === 'hist') {
      $('#apiList').innerHTML = this.hist.filter(h => hit(h.method + ' ' + h.url)).map((h, i) => `<div class="api-item" data-hist="${i}" title="${esc(h.url)}\n${esc(new Date(h.at).toLocaleString())}${h.error ? '\n' + esc(h.error) : ''}"><span class="api-m ${mcls(h.method)}">${esc(h.method)}</span><span class="api-iname">${esc(h.url.replace(/^https?:\/\//, ''))}</span><span class="api-code ${h.error ? 'bad' : h.status >= 400 ? 'warn' : 'ok'}">${h.error ? '✕' : h.status}</span></div>`).join('')
        || '<div class="empty">Nothing sent yet.</div>';
      return;
    }
    const groups = {};
    for (const r of this.reqs.filter(r => hit(`${r.folder} ${r.name} ${r.url}`))) (groups[r.folder || ''] ||= []).push(r);
    const open = this.openFolders();
    $('#apiList').innerHTML = Object.entries(groups).sort(([a], [b]) => (a === '') - (b === '') || a.localeCompare(b)).map(([f, list]) => {
      const isOpen = q || !open.closed.includes(f);
      return (f ? `<div class="api-folder" data-folder="${esc(f)}">${pm(isOpen)} 📁 ${esc(f)} <span class="n">${list.length}</span></div>` : '')
        + (isOpen ? list.map(r => `<div class="api-item ${this.cur?.id === r.id ? 'sel' : ''} ${f ? 'in' : ''}" data-req="${r.id}" title="${esc(r.url)}"><span class="api-m ${mcls(r.method)}">${esc(r.method)}</span><span class="api-iname">${esc(r.name)}</span></div>`).join('') : '');
    }).join('') || `<div class="empty">${this.reqs.length ? 'No match.' : 'No saved requests yet.<br>Type a URL, press Send, then 💾 Save.'}</div>`;
  },
  openFolders() { try { return { closed: JSON.parse(localStorage.getItem('apiClosed') || '[]') }; } catch { return { closed: [] }; } },

  // ---- send ----
  async send() {
    if (this.ctl) { this.ctl.abort(); return; }
    const c = this.read();
    if (!c.url) return toast('Type a URL', true);
    const miss = this.missing(c.url);
    if (miss.length) return toast(`Set ${miss.join(', ')} in an environment first (⚙ Environments…)`, true);
    const auth = { ...c.auth, user: this.fill(c.auth.user), pass: this.fill(c.auth.pass), token: this.fill(c.auth.token), key: this.fill(c.auth.key) };
    const body = { req_id: c.id, method: c.method, url: this.fill(c.url), headers: c.headers.map(h => ({ ...h, k: this.fill(h.k), v: this.fill(h.v) })), body_type: c.body_type, body: this.fill(c.body), auth, insecure: c.insecure, timeout: +$('#apiTimeout').value || 60 };
    this.ctl = new AbortController();
    $('#apiSend').textContent = 'Cancel'; $('#apiSend').classList.remove('primary');
    $('#apiStatus').innerHTML = '<span class="muted">Sending…</span>';
    try {
      const r = await fetch('/api/http/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: this.ctl.signal });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      this.resp = { ...d, sent: body };
      this.renderResp();
    } catch (err) {
      this.resp = null;
      $('#apiStatus').innerHTML = `<span class="err">${esc(err.name === 'AbortError' ? 'Cancelled' : err.message)}</span>`;
      $('#apiResp').textContent = '';
    } finally {
      this.ctl = null; $('#apiSend').textContent = 'Send'; $('#apiSend').classList.add('primary');
      api('GET', '/api/http').then(d => { this.hist = d.history || []; if (this.side === 'hist') this.renderList(); }).catch(() => {});
    }
  },

  pretty(body, ct) {
    const t = body.trim();
    if (/json/i.test(ct) || /^[[{]/.test(t)) { try { return JSON.stringify(JSON.parse(t), null, 2); } catch { /* not JSON */ } }
    if (/xml|html/i.test(ct) || t.startsWith('<')) return prettyXML(t);
    return body;
  },
  renderResp() {
    const r = this.resp; if (!r) return;
    const cls = r.status >= 500 ? 'bad' : r.status >= 400 ? 'warn' : 'ok';
    $('#apiStatus').innerHTML = `<span class="api-code ${cls}">${r.status} ${esc(r.status_text || '')}</span> <span class="muted tiny">${r.ms} ms · ${fmtSize(r.size)}${r.truncated ? ' (first 10 MB)' : ''}${r.url !== r.sent.url ? ` · redirected to ${esc(r.url)}` : ''}</span>`;
    const ct = Object.entries(r.headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1] || '';
    let text = this.respTab === 'headers' ? Object.entries(r.headers).sort().map(([k, v]) => `${k}: ${v}`).join('\n')
      : r.base64 ? `(binary answer, ${fmtSize(r.size)}${ct ? ', ' + ct : ''} — not shown)` : this.pretty(r.body, ct);
    const q = $('#apiRespFilter').value.trim();
    let html = esc(text.length > 2e6 ? text.slice(0, 2e6) + '\n… (shortened)' : text);
    if (q) html = html.replace(new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), m => `<mark>${m}</mark>`);
    $('#apiResp').innerHTML = html;
    $('#apiResp mark')?.scrollIntoView({ block: 'center' });
    this.respText = text;
  },

  // ---- save, delete, folders ----
  async save() {
    const c = this.read();
    if (!c.name) {
      const n = await askText('Name for this request:', `${c.method} ${c.url.replace(/^\{\{\w+\}\}/, '').replace(/^https?:\/\/[^/]+/, '') || c.url}`.slice(0, 80));
      if (!n?.trim()) return; c.name = n.trim(); $('#apiName').value = c.name;
    }
    if (!c.id) { const f = await askText('Folder (optional, use / for subfolders):', this.lastFolder || ''); if (f === null) return; c.folder = f.trim(); this.lastFolder = c.folder; }
    try {
      const saved = await api('POST', '/api/http/req', c);
      this.cur.id = saved.id; this.dirty = false; $('#apiSave').classList.remove('dirty');
      toast('Saved'); await this.load();
    } catch (err) { toast(err.message, true); }
  },
  menuFor(r, ev) {
    Tree.showMenu(ev, [
      ['Open', () => this.edit(r)],
      ['⧉ Duplicate', async () => { await api('POST', '/api/http/req', { ...r, id: '', name: r.name + ' (copy)' }); this.load(); }],
      ['Rename…', async () => { const n = await askText('Name', r.name); if (n?.trim()) { await api('POST', '/api/http/req', { ...r, name: n.trim() }); if (this.cur?.id === r.id) $('#apiName').value = n.trim(); this.load(); } }],
      ['Move to folder…', async () => { const f = await askText('Folder (empty = none)', r.folder || ''); if (f !== null) { await api('POST', '/api/http/req', { ...r, folder: f.trim() }); this.load(); } }],
      ['Copy as curl', () => copyText(this.curl(r), 'curl command copied (passwords and tokens shown as variables)')],
      '-', ['Delete', async () => { if (!await askYes(`Delete “${r.name}”?`)) return; await api('DELETE', `/api/http/req/${r.id}`); if (this.cur?.id === r.id) this.edit(this.blank(), true); this.load(); }],
    ]);
  },
  // curl with {{variables}} left as they are, so no secrets end up in the copy.
  curl(r) {
    const q = s => "'" + String(s).replace(/'/g, `'\\''`) + "'";
    const parts = [`curl -X ${r.method} ${q(r.url)}`];
    if (r.auth?.type === 'basic') parts.push(`-u ${q(r.auth.user + ':' + (r.auth.pass?.includes('{{') ? r.auth.pass : '{{password}}'))}`);
    if (r.auth?.type === 'bearer') parts.push(`-H ${q('Authorization: Bearer ' + (r.auth.token?.includes('{{') ? r.auth.token : '{{token}}'))}`);
    if (r.auth?.type === 'apikey') parts.push(`-H ${q((r.auth.key || 'X-API-Key') + ': ' + (r.auth.token?.includes('{{') ? r.auth.token : '{{token}}'))}`);
    for (const h of r.headers || []) if (h.on !== false && h.k) parts.push(`-H ${q(h.k + ': ' + h.v)}`);
    if (r.body_type && r.body_type !== 'none' && r.body) parts.push(`-H ${q('Content-Type: ' + ({ json: 'application/json', xml: 'application/xml', text: 'text/plain', form: 'application/x-www-form-urlencoded' })[r.body_type])}`, `--data-raw ${q(r.body)}`);
    if (r.insecure) parts.push('-k');
    return parts.join(' \\\n  ');
  },

  // 📌 request + answer to the capture thread; passwords and tokens hidden.
  async pin() {
    const r = this.resp; if (!r) return toast('Send a request first', true);
    let body = r.base64 ? '(binary)' : this.pretty(r.body, '');
    if (body.length > 4000) body = body.slice(0, 4000) + '\n… (shortened)';
    const text = `${r.sent.method} ${r.sent.url}\n→ ${r.status} ${r.status_text} · ${r.ms} ms${this.env() ? ` · ${this.env().name}` : ''}\n\n${body}`;
    try { await api('POST', '/api/capture/text', { text, from: `API ${this.cur?.name || ''}`.trim() }); toast('Request and answer added to the capture thread'); }
    catch (err) { toast(err.message, true); }
  },

  // ---- environments editor ----
  async editEnvs() {
    const env = this.env() || this.envs[0];
    const pickName = async () => await askText('Name for the environment (e.g. UAT):', '');
    if (!env) { const n = await pickName(); if (!n?.trim()) return; const e = await api('POST', '/api/http/env', { name: n.trim(), vars: [{ k: 'baseUrl', v: '', on: true }] }); await this.load(); this.selectEnv(e.id); return this.editEnvs(); }
    const d = $('#apiEnvDlg') || Object.assign(document.createElement('dialog'), { id: 'apiEnvDlg', className: 'apienv' });
    if (!d.isConnected) document.body.append(d);
    const draw = e => {
      d.innerHTML = `<h3>⚙ Environments</h3>
        <div class="api-row"><select class="ae-pick">${this.envs.map(x => `<option value="${x.id}" ${x.id === e.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
          <button data-ae="new">+ New</button><button data-ae="copy" title="A new environment with the same variables (e.g. UAT → PROD)">⧉ Copy</button><button data-ae="rename">Rename</button><button data-ae="del">Delete</button><button data-ae="export" title="Save as a Postman environment file (Bruno imports it too)">⬆ Export</button></div>
        <p class="muted tiny">Use them as <code>{{name}}</code> in the URL, headers, body or auth. Values are kept encrypted with your data.</p>
        <div class="ae-vars">${[...e.vars, { k: '', v: '', on: true }].map(v => `<div class="api-hrow"><input type="checkbox" class="hon" ${v.on !== false ? 'checked' : ''}><input class="hk" placeholder="name" value="${esc(v.k)}"><input class="hv" placeholder="value" value="${esc(v.v)}" ${/pass|secret|token|key/i.test(v.k) ? 'type="password"' : ''}><button class="icon hdel">✕</button></div>`).join('')}</div>
        <div class="api-row"><button data-ae="add">+ Variable</button><button data-ae="conn" title="baseUrl, host, user and password from one of your saved connections">+ From a connection…</button><span class="spacer"></span><button data-ae="close">Cancel</button><button class="primary" data-ae="save">Save</button></div>`;
      d.cur = e;
    };
    const readVars = () => $$('.ae-vars .api-hrow', d).map(r => ({ k: $('.hk', r).value.trim(), v: $('.hv', r).value, on: $('.hon', r).checked })).filter(v => v.k);
    draw(JSON.parse(JSON.stringify(env)));
    d.onchange = ev => { if (ev.target.classList.contains('ae-pick')) draw(JSON.parse(JSON.stringify(this.envs.find(x => x.id === ev.target.value)))); };
    d.onclick = async ev => {
      if (ev.target.classList.contains('hdel')) return ev.target.closest('.api-hrow').remove();
      const a = ev.target.closest('[data-ae]')?.dataset.ae; if (!a) return;
      const e = d.cur;
      if (a === 'add') { e.vars = readVars(); e.vars.push({ k: '', v: '', on: true }); return draw(e); }
      if (a === 'close') return d.close();
      if (a === 'export') { e.vars = readVars(); return ApiImport.exportEnv(e); }
      if (a === 'save') { e.vars = readVars(); await api('POST', '/api/http/env', e); await this.load(); this.selectEnv(e.id); d.close(); return toast(`${e.name} saved`); }
      if (a === 'new' || a === 'copy') { const n = await pickName(); if (!n?.trim()) return; const x = await api('POST', '/api/http/env', { name: n.trim(), vars: a === 'copy' ? readVars() : [{ k: 'baseUrl', v: '', on: true }] }); await this.load(); return draw(JSON.parse(JSON.stringify(this.envs.find(y => y.id === x.id)))); }
      if (a === 'rename') { const n = await askText('Name', e.name); if (n?.trim()) { e.name = n.trim(); e.vars = readVars(); await api('POST', '/api/http/env', e); await this.load(); draw(e); } return; }
      if (a === 'del') { if (!await askYes(`Delete the environment “${e.name}”?`)) return; await api('DELETE', `/api/http/env/${e.id}`); await this.load(); return this.envs.length ? draw(JSON.parse(JSON.stringify(this.envs[0]))) : d.close(); }
      if (a === 'conn') {
        const r = ev.target.getBoundingClientRect();
        const conns = S.entries.filter(x => x.host || x.url).sort((x, y) => usageScore(y) - usageScore(x)).slice(0, 25);
        setTimeout(() => Tree.showMenu({ clientX: r.left, clientY: r.bottom }, conns.map(c => [`${c.env ? c.env + ' · ' : ''}${c.name || c.host}`, () => {
          e.vars = readVars();
          let base = c.url && /^https?:/i.test(c.url) ? new URL(c.url).origin : `https://${c.host}${c.port && ![443, 22].includes(c.port) ? ':' + c.port : ''}`;
          const add = (k, v) => { if (!v) return; const x = e.vars.find(y => y.k === k); if (x) x.v = v; else e.vars.push({ k, v, on: true }); };
          add('baseUrl', base); add('host', c.host); add('user', c.username); add('password', c.password);
          draw(e); toast(`Filled from ${c.name || c.host}`);
        }])));
      }
    };
    if (!d.open) d.showModal();
  },
  selectEnv(id) { try { localStorage.setItem('apiEnv', id || ''); } catch { /* ignore */ } this.renderEnvs(); },
};

// A simple XML/HTML indenter for showing answers.
function prettyXML(x) {
  let depth = 0;
  return x.replace(/>\s*</g, '>\n<').split('\n').map(line => {
    if (/^<\//.test(line)) depth = Math.max(0, depth - 1);
    const out = '  '.repeat(depth) + line;
    if (/^<[^!?/][^>]*[^/]>$/.test(line) && !/<\/[^>]+>$/.test(line)) depth++;
    return out;
  }).join('\n');
}

// ---- wiring ----
$('#apiSend').onclick = () => Api.send();
$('#apiSave').onclick = () => Api.save();
$('#apiNew').onclick = () => Api.edit(Api.blank());
$('#apiEnv').onchange = e => Api.selectEnv(e.target.value);
$('#apiEnvEdit').onclick = () => Api.editEnvs();
$('#apiAuthType').onchange = () => { Api.showAuth(); Api.changed(); };
$('#apiAddHeader').onclick = () => { Api.read(); Api.cur.headers.push({ k: '', v: '', on: true }); Api.renderHeaders(); };
$('#apiHeaders').addEventListener('click', e => { if (e.target.classList.contains('hdel')) { e.target.closest('.api-hrow').remove(); Api.changed(); } });
$('#apiHeaders').addEventListener('input', e => { // typing in the last empty row adds a fresh one
  Api.changed();
  const rows = $$('#apiHeaders .api-hrow'), last = rows.at(-1);
  if (last && ($('.hk', last).value || $('.hv', last).value)) { Api.read(); Api.renderHeaders(); const r = $$('#apiHeaders .api-hrow').at(-2); const inp = $(e.target.classList.contains('hv') ? '.hv' : '.hk', r); inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
});
for (const id of ['#apiName', '#apiURL', '#apiBody', '#apiAuthUser', '#apiAuthPass', '#apiAuthToken', '#apiAuthKey']) $(id).addEventListener('input', () => Api.changed());
for (const id of ['#apiMethod', '#apiBodyType', '#apiInsecure']) $(id).addEventListener('change', () => Api.changed());
$('#apiBodyPretty').onclick = () => { const b = $('#apiBody'); b.value = Api.pretty(b.value, $('#apiBodyType').value); Api.changed(); };
$('#apiReqTabs').addEventListener('click', e => { const t = e.target.closest('[data-rt]'); if (!t) return; $$('#apiReqTabs .tab').forEach(x => x.classList.toggle('active', x === t)); $$('[data-rpane]').forEach(p => { p.hidden = p.dataset.rpane !== t.dataset.rt; }); });
$('#apiRespTabs').addEventListener('click', e => { const t = e.target.closest('[data-pt]'); if (!t) return; $$('#apiRespTabs .tab').forEach(x => x.classList.toggle('active', x === t)); Api.respTab = t.dataset.pt; Api.renderResp(); });
$('#apiRespFilter').addEventListener('input', () => Api.renderResp());
$('#apiRespCopy').onclick = () => Api.respText && copyText(Api.respText, 'Answer copied');
$('#apiRespPin').onclick = () => Api.pin();
$('#apiFilter').addEventListener('input', () => Api.renderList());
$('.api-side-seg').addEventListener('click', e => { const b = e.target.closest('[data-aside]'); if (!b) return; Api.side = b.dataset.aside; $$('.api-side-seg button').forEach(x => x.classList.toggle('active', x === b)); Api.renderList(); });
$('#apiMore').onclick = e => {
  const r = e.target.getBoundingClientRect(), c = Api.read();
  setTimeout(() => Tree.showMenu({ clientX: r.left - 150, clientY: r.bottom }, [
    ['Copy as curl', () => copyText(Api.curl(c), 'curl command copied (passwords and tokens shown as variables)')],
    ['⧉ Duplicate', () => Api.edit({ ...c, id: '', name: c.name ? c.name + ' (copy)' : '' })],
    ...(c.id ? [['Delete', async () => { if (!await askYes(`Delete “${c.name}”?`)) return; await api('DELETE', `/api/http/req/${c.id}`); Api.edit(Api.blank(), true); Api.load(); }]] : []),
  ]));
};
$('#apiList').addEventListener('click', e => {
  const f = e.target.closest('[data-folder]');
  if (f) { const o = Api.openFolders().closed, k = f.dataset.folder; try { localStorage.setItem('apiClosed', JSON.stringify(o.includes(k) ? o.filter(x => x !== k) : [...o, k])); } catch { /* ignore */ } return Api.renderList(); }
  const r = e.target.closest('[data-req]'); if (r) return Api.edit(Api.reqs.find(x => x.id === r.dataset.req));
  const h = e.target.closest('[data-hist]');
  if (h) { const x = Api.hist[+h.dataset.hist], saved = Api.reqs.find(y => y.id === x.req_id); Api.edit(saved || { ...Api.blank(), method: x.method, url: x.url }); }
});
$('#apiList').addEventListener('contextmenu', e => { const r = e.target.closest('[data-req]'); if (!r) return; e.preventDefault(); Api.menuFor(Api.reqs.find(x => x.id === r.dataset.req), e); });
$('#view-api').addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); Api.send(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); Api.save(); }
});

// ⬇ Import (Postman / Bruno) and ⬆ export (Postman) — see api_import.js.
$('#apiImport').onclick = e => {
  const r = e.target.getBoundingClientRect();
  setTimeout(() => Tree.showMenu({ clientX: r.left, clientY: r.bottom }, [
    ['📄 Postman collection / environment (.json)…', () => $('#apiImportFiles').click()],
    ['📁 Bruno collection folder…', () => $('#apiImportFolder').click()],
    ['📄 Bruno file(s) (.bru or Bruno JSON export)…', () => $('#apiImportFiles').click()],
  ]));
};
for (const id of ['#apiImportFiles', '#apiImportFolder']) $(id).addEventListener('change', async e => { const files = [...e.target.files]; e.target.value = ''; await ApiImport.run(files); });
$('#apiList').addEventListener('contextmenu', e => {
  const f = e.target.closest('[data-folder]'); if (!f) return;
  e.preventDefault();
  Tree.showMenu(e, [['⬆ Export as Postman collection (Bruno imports it too)…', () => ApiImport.exportFolder(f.dataset.folder)],
    ['Rename folder…', async () => {
      const from = f.dataset.folder, to = await askText('Folder name', from); if (!to?.trim() || to.trim() === from) return;
      for (const r of Api.reqs.filter(x => x.folder === from || x.folder.startsWith(from + '/'))) await api('POST', '/api/http/req', { ...r, folder: to.trim() + r.folder.slice(from.length) });
      Api.load();
    }]]);
});
