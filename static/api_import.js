'use strict';
// 🌐 API page: import Postman and Bruno collections (and their environments),
// and export a folder as a Postman collection (which Bruno imports too).
// Everything is read in the page from the files you pick; scripts (pre-request,
// tests) are counted but not imported, as WorkHub doesn't run them.

const ApiImport = {
  // ---- the parsed form: { requests: [HTTPReq], envs: [{name, vars}], notes: [] } ----
  out() { return { requests: [], envs: [], skipped: { scripts: 0, files: 0, other: 0 } }; },

  // ================= Postman =================
  isPostmanCollection: j => !!(j && j.info && Array.isArray(j.item)),
  isPostmanEnv: j => !!(j && Array.isArray(j.values) && (j._postman_variable_scope || j.name)),

  postmanAuth(a) {
    if (!a || a.type === 'noauth') return { type: '' };
    const kv = list => Object.fromEntries((Array.isArray(list) ? list : Object.entries(list || {}).map(([key, value]) => ({ key, value }))).map(x => [x.key, x.value ?? '']));
    if (a.type === 'bearer') return { type: 'bearer', token: kv(a.bearer).token || '' };
    if (a.type === 'basic') { const b = kv(a.basic); return { type: 'basic', user: b.username || '', pass: b.password || '' }; }
    if (a.type === 'apikey') { const k = kv(a.apikey); return { type: 'apikey', key: k.key || 'X-API-Key', token: k.value || '', inQuery: k.in === 'query' }; }
    return { type: '', unsupported: a.type };
  },
  postmanURL(u) {
    if (typeof u === 'string') return u;
    if (!u) return '';
    if (u.raw) return u.raw;
    const host = Array.isArray(u.host) ? u.host.join('.') : u.host || '';
    const path = Array.isArray(u.path) ? u.path.join('/') : u.path || '';
    const q = (u.query || []).filter(x => !x.disabled).map(x => `${x.key}=${x.value ?? ''}`).join('&');
    return `${u.protocol ? u.protocol + '://' : ''}${host}${u.port ? ':' + u.port : ''}${path ? '/' + path : ''}${q ? '?' + q : ''}`;
  },
  postmanBody(b, res) {
    if (!b || !b.mode) return { body_type: 'none', body: '' };
    if (b.mode === 'raw') {
      const lang = b.options?.raw?.language || '', raw = b.raw || '';
      const t = lang === 'json' || (!lang && /^\s*[[{]/.test(raw)) ? 'json' : lang === 'xml' || lang === 'html' ? 'xml' : 'text';
      return { body_type: t, body: raw };
    }
    if (b.mode === 'urlencoded' || b.mode === 'formdata') {
      const fields = (b[b.mode] || []).filter(x => !x.disabled);
      if (fields.some(x => x.type === 'file')) res.skipped.files++;
      return { body_type: 'form', body: fields.filter(x => x.type !== 'file').map(x => `${encodeURIComponent(x.key)}=${encodeURIComponent(x.value ?? '')}`).join('&') };
    }
    if (b.mode === 'graphql') return { body_type: 'json', body: JSON.stringify({ query: b.graphql?.query || '', variables: (() => { try { return JSON.parse(b.graphql?.variables || '{}'); } catch { return {}; } })() }, null, 2) };
    if (b.mode === 'file') res.skipped.files++;
    return { body_type: 'none', body: '' };
  },
  fromPostman(j, res) {
    const coll = (j.info.name || 'Postman collection').trim();
    const walk = (items, folder, auth) => {
      for (const it of items || []) {
        if ((it.event || []).some(ev => ev.script?.exec?.join?.('').trim())) res.skipped.scripts++;
        const myAuth = it.auth && it.auth.type !== 'inherit' ? it.auth : auth;
        if (Array.isArray(it.item)) { walk(it.item, `${folder}/${it.name}`, myAuth); continue; }
        const r = it.request; if (!r) continue;
        const rq = typeof r === 'string' ? { method: 'GET', url: r } : r;
        let url = this.postmanURL(rq.url);
        const pa = this.postmanAuth(rq.auth && rq.auth.type !== 'inherit' ? rq.auth : myAuth);
        if (pa.unsupported) res.skipped.other++;
        if (pa.inQuery) { url += (url.includes('?') ? '&' : '?') + `${pa.key}=${pa.token}`; pa.type = ''; }
        res.requests.push({
          name: it.name || url, folder, method: (rq.method || 'GET').toUpperCase(), url,
          headers: (rq.header || []).map(h => ({ k: h.key, v: h.value ?? '', on: !h.disabled })),
          ...this.postmanBody(rq.body, res), auth: { type: pa.type, user: pa.user, pass: pa.pass, token: pa.token, key: pa.key },
        });
      }
    };
    if ((j.event || []).some(ev => ev.script?.exec?.join?.('').trim())) res.skipped.scripts++;
    walk(j.item, coll, j.auth);
    if (j.variable?.length) res.envs.push({ name: `${coll} (collection variables)`, vars: j.variable.map(v => ({ k: v.key, v: String(v.value ?? ''), on: !v.disabled })) });
  },
  fromPostmanEnv(j, res) {
    res.envs.push({ name: j.name || 'Postman environment', vars: j.values.map(v => ({ k: v.key, v: String(v.value ?? ''), on: v.enabled !== false })) });
  },

  // ================= Bruno =================
  // A .bru file: top-level blocks "name {" … "}" (key: value lines, ~ = disabled)
  // or "name [" … "]" (a list); body:* blocks hold raw text indented by 2.
  parseBru(text) {
    const blocks = {}, lines = text.replace(/\r\n/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^([\w:.-]+)\s*([{[])\s*$/); if (!m) continue;
      const close = m[2] === '{' ? '}' : ']', body = [];
      for (i++; i < lines.length && lines[i] !== close; i++) body.push(lines[i]);
      blocks[m[1]] = body;
    }
    const dict = name => (blocks[name] || []).map(l => l.replace(/^ {2}/, '')).filter(l => l.trim()).map(l => {
      const off = l.startsWith('~'), x = off ? l.slice(1) : l, at = x.indexOf(':');
      return at < 0 ? null : { k: x.slice(0, at).trim(), v: x.slice(at + 1).trim(), on: !off };
    }).filter(Boolean);
    const raw = name => blocks[name] ? blocks[name].map(l => l.replace(/^ {2}/, '')).join('\n').trim() : null;
    const list = name => (blocks[name] || []).map(l => l.trim().replace(/,$/, '')).filter(Boolean);
    return { blocks, dict, raw, list };
  },
  bruAuth(p, mode, fallback) {
    const get = (blk, k) => p.dict(blk).find(x => x.k === k)?.v || '';
    if (mode === 'bearer') return { type: 'bearer', token: get('auth:bearer', 'token') };
    if (mode === 'basic') return { type: 'basic', user: get('auth:basic', 'username'), pass: get('auth:basic', 'password') };
    if (mode === 'apikey') return { type: 'apikey', key: get('auth:apikey', 'key') || 'X-API-Key', token: get('auth:apikey', 'value'), inQuery: /query/i.test(get('auth:apikey', 'placement')) };
    if (mode === 'inherit' && fallback) return { ...fallback };
    return { type: '' };
  },
  fromBruFile(text, folder, collAuth, collHeaders, res) {
    const p = this.parseBru(text), meta = Object.fromEntries(p.dict('meta').map(x => [x.k, x.v]));
    if (meta.type && meta.type !== 'http' && meta.type !== 'http-request') { if (meta.type === 'graphql') { /* handled below */ } else return; }
    const method = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'].find(m => p.blocks[m]);
    if (!method) return;
    const mb = Object.fromEntries(p.dict(method).map(x => [x.k, x.v]));
    let url = mb.url || '';
    const auth = this.bruAuth(p, mb.auth || 'none', collAuth);
    if (auth.inQuery) { url += (url.includes('?') ? '&' : '?') + `${auth.key}=${auth.token}`; auth.type = ''; }
    let body_type = 'none', body = '';
    const mode = mb.body || 'none';
    if (mode === 'json' && p.raw('body:json') != null) { body_type = 'json'; body = p.raw('body:json'); }
    else if (mode === 'xml' && p.raw('body:xml') != null) { body_type = 'xml'; body = p.raw('body:xml'); }
    else if (mode === 'text' && p.raw('body:text') != null) { body_type = 'text'; body = p.raw('body:text'); }
    else if (mode === 'formUrlEncoded' || mode === 'multipartForm') {
      const f = p.dict(mode === 'formUrlEncoded' ? 'body:form-urlencoded' : 'body:multipart-form').filter(x => x.on);
      if (f.some(x => x.v.startsWith('@file('))) res.skipped.files++;
      body_type = 'form'; body = f.filter(x => !x.v.startsWith('@file(')).map(x => `${encodeURIComponent(x.k)}=${encodeURIComponent(x.v)}`).join('&');
    } else if (mode === 'graphql' && p.raw('body:graphql') != null) {
      let vars = {}; try { vars = JSON.parse(p.raw('body:graphql:vars') || '{}'); } catch { /* keep {} */ }
      body_type = 'json'; body = JSON.stringify({ query: p.raw('body:graphql'), variables: vars }, null, 2);
    }
    if (['script:pre-request', 'script:post-response', 'tests'].some(b => (p.raw(b) || '').trim())) res.skipped.scripts++;
    res.requests.push({ name: meta.name || method.toUpperCase() + ' ' + url, folder, method: method.toUpperCase(), url,
      headers: [...collHeaders, ...p.dict('headers')], body_type, body, auth: { type: auth.type, user: auth.user, pass: auth.pass, token: auth.token, key: auth.key }, seq: +meta.seq || 0 });
  },
  fromBruEnv(text, name, res) {
    const p = this.parseBru(text);
    const vars = p.dict('vars');
    for (const s of p.list('vars:secret')) { const off = s.startsWith('~'); vars.push({ k: off ? s.slice(1) : s, v: '', on: !off }); } // secrets aren't in Bruno's files: fill them in
    res.envs.push({ name, vars, secretsEmpty: p.list('vars:secret').length });
  },
  // A Bruno collection folder picked with the folder picker: File objects with webkitRelativePath.
  async fromBrunoFolder(files, res) {
    const rel = f => f.webkitRelativePath || f.name;
    const root = rel(files[0]).split('/')[0];
    const brunoJson = files.find(f => rel(f) === `${root}/bruno.json`);
    let coll = root;
    if (brunoJson) { try { coll = JSON.parse(await brunoJson.text()).name || root; } catch { /* folder name */ } }
    const collBru = files.find(f => rel(f) === `${root}/collection.bru`);
    let collAuth = null, collHeaders = [];
    if (collBru) {
      const p = this.parseBru(await collBru.text());
      collHeaders = p.dict('headers');
      const mode = Object.fromEntries(p.dict('auth').map(x => [x.k, x.v])).mode;
      if (mode) collAuth = this.bruAuth(p, mode);
    }
    for (const f of files) {
      const r = rel(f);
      if (!r.endsWith('.bru') || r.endsWith('/collection.bru') || r.endsWith('/folder.bru')) continue;
      const parts = r.split('/').slice(1, -1);
      if (parts[0] === 'environments') { this.fromBruEnv(await f.text(), `${coll} · ${f.name.replace(/\.bru$/, '')}`, res); continue; }
      this.fromBruFile(await f.text(), [coll, ...parts].join('/'), collAuth, collHeaders, res);
    }
  },
  // Bruno's own JSON export.
  isBrunoJSON: j => !!(j && Array.isArray(j.items) && (j.version || j.items.some(i => /request|folder/.test(i.type || '')))),
  fromBrunoJSON(j, res) {
    const coll = j.name || 'Bruno collection';
    const authOf = a => !a ? { type: '' } : a.mode === 'bearer' ? { type: 'bearer', token: a.bearer?.token || '' } : a.mode === 'basic' ? { type: 'basic', user: a.basic?.username || '', pass: a.basic?.password || '' } : a.mode === 'apikey' ? { type: 'apikey', key: a.apikey?.key || 'X-API-Key', token: a.apikey?.value || '' } : { type: '' };
    const walk = (items, folder) => {
      for (const it of items || []) {
        if (it.type === 'folder') { walk(it.items, `${folder}/${it.name}`); continue; }
        const r = it.request; if (!r) continue;
        const b = r.body || {}, mode = b.mode || 'none';
        let body_type = 'none', body = '';
        if (mode === 'json') { body_type = 'json'; body = b.json || ''; } else if (mode === 'xml') { body_type = 'xml'; body = b.xml || ''; } else if (mode === 'text') { body_type = 'text'; body = b.text || ''; }
        else if (mode === 'formUrlEncoded' || mode === 'multipartForm') { body_type = 'form'; body = (b[mode] || []).filter(x => x.enabled !== false).map(x => `${encodeURIComponent(x.name)}=${encodeURIComponent(x.value ?? '')}`).join('&'); }
        if (r.script?.req || r.script?.res || r.tests) res.skipped.scripts++;
        res.requests.push({ name: it.name, folder, method: (r.method || 'GET').toUpperCase(), url: r.url || '', headers: (r.headers || []).map(h => ({ k: h.name, v: h.value ?? '', on: h.enabled !== false })), body_type, body, auth: authOf(r.auth), seq: it.seq || 0 });
      }
    };
    walk(j.items, coll);
    for (const e of j.environments || []) res.envs.push({ name: `${coll} · ${e.name}`, vars: (e.variables || []).map(v => ({ k: v.name, v: v.secret ? '' : String(v.value ?? ''), on: v.enabled !== false })) });
  },

  // ================= reading the picked files =================
  async readFiles(files) {
    const res = this.out(), bad = [];
    const bruFolder = files.filter(f => (f.webkitRelativePath || '').includes('/'));
    if (bruFolder.length && bruFolder.some(f => f.name.endsWith('.bru') || f.name === 'bruno.json')) await this.fromBrunoFolder(bruFolder, res);
    for (const f of files.filter(f => !bruFolder.includes(f))) {
      if (f.name.endsWith('.bru')) { this.fromBruFile(await f.text(), 'Bruno', null, [], res); continue; }
      let j; try { j = JSON.parse(await f.text()); } catch { bad.push(f.name); continue; }
      if (this.isPostmanCollection(j)) this.fromPostman(j, res);
      else if (this.isPostmanEnv(j)) this.fromPostmanEnv(j, res);
      else if (this.isBrunoJSON(j)) this.fromBrunoJSON(j, res);
      else bad.push(f.name);
    }
    res.bad = bad;
    return res;
  },

  // Save: a request with the same folder + name is updated (re-import), envs by name.
  async save(res) {
    const d = await api('GET', '/api/http');
    const byKey = new Map((d.requests || []).map(r => [`${r.folder}\u0001${r.name}`, r]));
    const envBy = new Map((d.envs || []).map(e => [e.name, e]));
    let added = 0, updated = 0;
    res.requests.sort((a, b) => a.folder.localeCompare(b.folder) || (a.seq || 0) - (b.seq || 0));
    for (const r of res.requests) {
      const old = byKey.get(`${r.folder}\u0001${r.name}`);
      await api('POST', '/api/http/req', { ...r, id: old?.id || '' });
      old ? updated++ : added++;
    }
    for (const e of res.envs) {
      const old = envBy.get(e.name);
      if (old) { // keep values you filled in (e.g. secrets) where the import has none
        const mine = Object.fromEntries(old.vars.map(v => [v.k, v.v]));
        e.vars = e.vars.map(v => ({ ...v, v: v.v || mine[v.k] || '' }));
      }
      await api('POST', '/api/http/env', { id: old?.id || '', name: e.name, vars: e.vars });
    }
    return { added, updated };
  },

  async run(files) {
    if (!files.length) return;
    try {
      const res = await this.readFiles([...files]);
      if (!res.requests.length && !res.envs.length) return toast(`Nothing to import${res.bad.length ? ` — not a Postman or Bruno file: ${res.bad.join(', ')}` : ''}`, true);
      const { added, updated } = await this.save(res);
      await Api.load();
      const folders = new Set(res.requests.map(r => r.folder)).size, sk = res.skipped;
      const secrets = res.envs.reduce((n, e) => n + (e.secretsEmpty || 0), 0);
      const msg = [`Imported ${added} new request${added === 1 ? '' : 's'}${updated ? `, updated ${updated}` : ''} in ${folders} folder${folders === 1 ? '' : 's'}`,
        res.envs.length && `${res.envs.length} environment${res.envs.length > 1 ? 's' : ''}`].filter(Boolean).join(' and ');
      const notes = [sk.scripts && `${sk.scripts} with scripts/tests (not run in WorkHub)`, sk.files && `${sk.files} file upload field(s) left out`, sk.other && `${sk.other} with an auth type WorkHub doesn't have`,
        secrets && `${secrets} secret variable(s) to fill in (⚙ Environments)`, res.bad.length && `not imported: ${res.bad.join(', ')}`].filter(Boolean);
      toast(msg + (notes.length ? ' · ' + notes.join(' · ') : ''), false);
    } catch (err) { toast('Import failed: ' + err.message, true); }
  },

  // ================= export a folder as a Postman v2.1 collection =================
  toPostman(folder) {
    const reqs = Api.reqs.filter(r => r.folder === folder || r.folder.startsWith(folder + '/'));
    const root = { info: { name: folder.split('/').pop() || 'WorkHub', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item: [] };
    const node = path => { let cur = root; for (const part of path) { let f = cur.item.find(x => x.name === part && x.item); if (!f) { f = { name: part, item: [] }; cur.item.push(f); } cur = f; } return cur; };
    for (const r of reqs) {
      const sub = r.folder === folder ? [] : r.folder.slice(folder.length + 1).split('/');
      const auth = r.auth?.type === 'bearer' ? { type: 'bearer', bearer: [{ key: 'token', value: r.auth.token || '', type: 'string' }] }
        : r.auth?.type === 'basic' ? { type: 'basic', basic: [{ key: 'username', value: r.auth.user || '', type: 'string' }, { key: 'password', value: r.auth.pass || '', type: 'string' }] }
        : r.auth?.type === 'apikey' ? { type: 'apikey', apikey: [{ key: 'key', value: r.auth.key || 'X-API-Key' }, { key: 'value', value: r.auth.token || '' }, { key: 'in', value: 'header' }] } : { type: 'noauth' };
      const body = !r.body_type || r.body_type === 'none' ? undefined
        : r.body_type === 'form' ? { mode: 'urlencoded', urlencoded: r.body.split('&').filter(Boolean).map(p => { const [k, v = ''] = p.split('='); return { key: decodeURIComponent(k), value: decodeURIComponent(v) }; }) }
        : { mode: 'raw', raw: r.body, options: { raw: { language: r.body_type === 'json' ? 'json' : r.body_type === 'xml' ? 'xml' : 'text' } } };
      node(sub).item.push({ name: r.name, request: { method: r.method, header: (r.headers || []).map(h => ({ key: h.k, value: h.v, ...(h.on === false ? { disabled: true } : {}) })), url: { raw: r.url }, auth, ...(body ? { body } : {}) } });
    }
    return root;
  },
  download(name, obj) {
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' })), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  },
  async exportFolder(folder) {
    const n = Api.reqs.filter(r => r.folder === folder || r.folder.startsWith(folder + '/')).length;
    if (!n) return toast('No requests in that folder', true);
    if (!await askYes(`Export ${n} request${n > 1 ? 's' : ''} in “${folder}” as a Postman collection?\n\nTokens and passwords typed straight into requests are included — {{variables}} stay as they are. Bruno can import this file too.`)) return;
    this.download(`${folder.replace(/[\\/:*?"<>|]+/g, '_')}.postman_collection.json`, this.toPostman(folder));
  },
  async exportEnv(e) {
    if (!await askYes(`Export the environment “${e.name}” as a Postman environment?\n\nIts values are included in the file (secrets too).`)) return;
    this.download(`${e.name.replace(/[\\/:*?"<>|]+/g, '_')}.postman_environment.json`, { name: e.name, values: e.vars.map(v => ({ key: v.k, value: v.v, enabled: v.on !== false, type: /pass|secret|token|key/i.test(v.k) ? 'secret' : 'default' })), _postman_variable_scope: 'environment' });
  },
};
