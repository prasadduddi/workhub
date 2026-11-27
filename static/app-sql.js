'use strict';
// WorkHub page, part 5 of 7: SQL (Oracle / PostgreSQL), its object tree, snippets.
// The page's script is split into parts loaded in order (index.html); they share one global scope.

// ---------- SQL (Oracle / PostgreSQL) ----------
// Splits a script into statements, skipping ';' inside quotes, comments and
// PostgreSQL $$ bodies. Oracle PL/SQL blocks end with "/" on its own line.
function splitSQL(text, kind) {
  const out = [];
  let start = 0, i = 0;
  const n = text.length;
  const plsql = s => kind === 'oracle' && /^\s*(declare|begin|create\s+(or\s+replace\s+)?((non)?editionable\s+)?(procedure|function|package|trigger|type))\b/i.test(s);
  const push = (a, b) => {
    const raw = text.slice(a, b), lead = raw.length - raw.trimStart().length, sql = raw.trim();
    if (sql && !/^(--[^\n]*\s*)+$/.test(sql)) out.push({ sql, from: a + lead, to: a + lead + sql.length });
  };
  while (i < n) {
    const c = text[i];
    if (c === "'" || c === '"') { const j = text.indexOf(c, i + 1); i = j < 0 ? n : j + 1; continue; }
    if (c === '-' && text[i + 1] === '-') { const j = text.indexOf('\n', i); i = j < 0 ? n : j; continue; }
    if (c === '/' && text[i + 1] === '*') { const j = text.indexOf('*/', i + 2); i = j < 0 ? n : j + 2; continue; }
    if (c === '$' && kind === 'postgres') {
      const m = /^\$[A-Za-z_]*\$/.exec(text.slice(i, i + 40));
      if (m) { const j = text.indexOf(m[0], i + m[0].length); i = j < 0 ? n : j + m[0].length; continue; }
    }
    if (c === '/' && kind === 'oracle') {
      const ls = text.lastIndexOf('\n', i - 1) + 1, le = text.indexOf('\n', i);
      if (text.slice(ls, le < 0 ? n : le).trim() === '/') { push(start, ls); start = i + 1; i++; continue; }
    }
    if (c === ';' && !plsql(text.slice(start, i))) { push(start, i + 1); start = i + 1; }
    i++;
  }
  push(start, n);
  return out;
}

function textTable(r, limit = 50) {
  const cols = r.columns, rows = r.rows.slice(0, limit).map(row => row.map(v => v === null ? '(null)' : String(v).replace(/\s+/g, ' ')));
  const w = cols.map((c, i) => Math.min(40, Math.max(c.length, ...rows.map(row => row[i].length))));
  const fmt = row => row.map((v, i) => (v.length > w[i] ? v.slice(0, w[i] - 1) + '…' : v).padEnd(w[i])).join('  ');
  return [fmt(cols), w.map(x => '-'.repeat(x)).join('  '), ...rows.map(fmt)].join('\n') + (r.rows.length > limit ? `\n… ${r.rows.length - limit} more row(s) in Results` : '');
}

const SQL = {
  tabs: [], active: null, running: false,
  expanded: new Set(), connecting: new Set(), connErr: {},

  // ▸ on a connection: connect if needed and show its objects; ▾ collapses.
  async toggleConn(e, retry) {
    if (!e) return;
    if (SQL.expanded.has(e.id) && !retry) { SQL.expanded.delete(e.id); return Tree.render(); }
    SQL.expanded.add(e.id); delete SQL.connErr[e.id];
    Tree.render();
    if (!SQL.tabs.some(t => t.entry.id === e.id)) await SQL.open(e, { stay: true });
  },

  async open(e, opts = {}) {
    show('sql'); roomForWork();
    this.expanded.add(e.id); // the object tree opens under the connection
    const open = this.tabs.find(t => t.entry.id === e.id);
    if (open) { Tree.render(); return this.activate(open); }
    let creds = {};
    if (!e.username || !e.password) { creds = await askCreds(e); if (!creds) { this.expanded.delete(e.id); Tree.render(); return; } }
    const kind = dbKindOf(e);
    const ex = e.extra || {};
    let database = '';
    if (!(ex.service || ex.service_name || ex.database || ex.db_name || ex.dbname || ex.sid || (kind === 'postgres' && /\/\w/.test((e.url || '').replace(/^.*?\/\/[^/]*/, ''))))) {
      database = await askText(kind === 'oracle' ? `Oracle service name for ${e.host} (e.g. ORCLPDB1):` : `PostgreSQL database on ${e.host}:`, kind === 'oracle' ? '' : 'postgres');
      if (database === null) { this.expanded.delete(e.id); Tree.render(); return; }
    }
    if (!this.active) { $('#sqlEmpty').innerHTML = `Connecting to ${esc(e.host)}…`; $('#sqlEmpty').hidden = false; }
    this.connecting.add(e.id); delete this.connErr[e.id]; Tree.render();
    try {
      const r = await api('POST', '/api/db/open', { id: e.id, ...creds, database: database.trim() });
      const t = { sid: r.sid, entry: e, kind: r.kind, info: r, sql: this.loadSQL(e), result: null, out: '', inTx: false, objects: null, creds: { ...creds, save: false }, database: database.trim() };
      this.tabs.push(t);
      this.activate(t);
      this.say(t, `<span class="ok">Connected: ${esc(r.user || '')}  ${esc(r.version || '')}</span>\n`);
      this.loadObjects(t, '');
    } catch (err) {
      this.connErr[e.id] = err.message;
      if (!this.active) $('#sqlEmpty').innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`;
      toast(err.message, true);
      poll();
    } finally {
      this.connecting.delete(e.id);
      Tree.render();
    }
  },

  loadSQL(e) {
    try { const s = localStorage.getItem('sql.' + e.id); if (s !== null) return s; } catch { /* private mode */ }
    return dbKindOf(e) === 'oracle' ? 'SELECT * FROM user_tables;\n' : 'SELECT * FROM information_schema.tables WHERE table_schema = current_schema();\n';
  },

  activate(t) {
    if (this.active) this.active.sql = this.cm.getValue();
    this.active = t;
    $('#sqlWork').hidden = !t;
    $('#sqlEmpty').hidden = !!t;
    if (!t) { $('#sqlEmpty').innerHTML = 'Double-click an Oracle or PostgreSQL server in the tree.'; this.renderTabs(); return; }
    this.cm.setOption('mode', t.kind === 'oracle' ? 'text/x-plsql' : 'text/x-pgsql');
    this.cm.setValue(t.sql);
    this.cm.clearHistory();
    $('#sqlInfo').textContent = `${t.kind === 'oracle' ? 'Oracle' : 'PostgreSQL'} · ${t.info.user || ''}`;
    $('#sqlWork').classList.toggle('prod', isProd(t.entry));
    $('#sqlWork').dataset.prod = isProd(t.entry) ? `PROD · ${t.entry.host}` : '';
    this.renderTabs(); this.renderResult(); this.renderOut(); this.renderHist(); this.renderObjects(); this.renderTx();
    setTimeout(() => { this.cm.refresh(); this.cm.focus(); });
  },

  renderTabs() {
    $('#sqlTabs').innerHTML = this.tabs.map(t => `<div class="tab ${t === this.active ? 'active' : ''}" data-st="${t.sid}">
      ${t.inTx ? '<span style="color:#e0a800" title="Uncommitted changes">●</span>' : dot(byId(t.entry.id) || t.entry)} ${typeof Groups !== 'undefined' ? Groups.chip(Groups.entryText(t.entry)) : ''}🛢 ${esc(t.entry.name)}${(s => s && !t.entry.name.includes(s.name) ? ` <small class="muted">${s.sid ? 'SID' : 'service'} ${esc(s.name)}</small>` : '')(dbService(t.entry))}${t.entry.env ? ` <span class="badge ${esc(t.entry.env)}">${esc(t.entry.env)}</span>` : ''}
      <span class="x" data-sx="${t.sid}">✕</span></div>`).join('');
    $('#sqlCount').textContent = this.tabs.length || '';
  },

  // Reconnect: new session, same tab (SQL text, output and history kept).
  async reconnect(t = this.active) {
    if (!t) return;
    if (t.inTx && !await askYes(`${t.entry.name} has uncommitted changes. Reconnecting rolls them back. Continue?`)) return;
    api('POST', '/api/db/close', { sid: t.sid }).catch(() => {});
    this.say(t, `<span class="cmd">Reconnecting to ${esc(t.entry.host)}…</span>\n`);
    this.connecting.add(t.entry.id); Tree.render();
    try {
      const e = byId(t.entry.id) || t.entry;
      const r = await api('POST', '/api/db/open', { id: e.id, ...(t.creds || {}), database: t.database || '' });
      Object.assign(t, { sid: r.sid, info: r, inTx: false, ot: null, objects: null, entry: e });
      this.say(t, `<span class="ok">Connected: ${esc(r.user || '')}  ${esc(r.version || '')}</span>\n`);
      this.loadObjects(t, '');
      toast('Reconnected to ' + e.name);
    } catch (err) {
      this.say(t, `<span class="err">${esc(err.message)}</span>\n`);
      this.connErr[t.entry.id] = err.message;
      toast(err.message, true);
    } finally {
      this.connecting.delete(t.entry.id);
      if (t === this.active) { this.renderTabs(); this.renderTx(); }
      Tree.render();
    }
  },

  async close(t) {
    if (t.inTx && !await askYes(`${t.entry.name} has uncommitted changes. Close and roll them back?`)) return;
    api('POST', '/api/db/close', { sid: t.sid }).catch(() => {});
    this.tabs = this.tabs.filter(x => x !== t);
    this.expanded.delete(t.entry.id);
    if (this.active === t) { this.active = null; this.activate(this.tabs.at(-1) || null); } else this.renderTabs();
    Tree.render();
  },

  // Statements to run: the selection, the whole script, or the one at the cursor.
  pick(all) {
    const cm = this.cm, t = this.active;
    const selected = cm.getSelection();
    if (!all && selected.trim()) return splitSQL(selected, t.kind);
    const text = cm.getValue();
    const parts = splitSQL(text, t.kind);
    if (all) return parts;
    const pos = cm.indexFromPos(cm.getCursor());
    const hit = parts.find(p => pos >= p.from && pos <= p.to + 1) || [...parts].reverse().find(p => p.to <= pos) || parts[0];
    if (hit) { cm.setSelection(cm.posFromIndex(hit.from), cm.posFromIndex(hit.to)); cm.focus(); }
    return hit ? [hit] : [];
  },

  async run(all) {
    const t = this.active;
    if (!t || this.running) return;
    const stmts = this.pick(all);
    if (!stmts.length) return toast('Nothing to run', true);
    if (isProd(t.entry)) { // ⚠ PROD: every change is confirmed; read-only queries once per tab
      const writes = stmts.filter(x => !readOnlySQL(x.sql)), name = `${t.entry.name || t.entry.host} (${t.info.user || t.entry.username || ''})`;
      if (writes.length) {
        const show = writes.slice(0, 3).map(x => x.sql.length > 300 ? x.sql.slice(0, 300) + '…' : x.sql).join('\n\n');
        if (!await askYes(`⚠ PROD — run ${writes.length === 1 ? 'this statement' : writes.length + ' statements that change data'} on ${name}?\n\n${show}${writes.length > 3 ? '\n\n…' : ''}${!$('#sqlAuto').checked ? '\n\n(Auto-commit is off: nothing is kept until you press Commit.)' : '\n\nAuto-commit is ON: the change is kept at once.'}`)) return;
      } else if (!t.prodReadOK) {
        if (!await askYes(`⚠ PROD — run read-only queries on ${name}?\n\nYou won't be asked again for SELECTs in this tab; anything that changes data is always asked.`)) return;
        t.prodReadOK = true;
      }
    }
    this.busy(true);
    if (all || stmts.length > 1) this.showOut('out');
    const max = +$('#sqlMax').value, auto = $('#sqlAuto').checked;
    for (const s of stmts) {
      const first = s.sql.split('\n')[0];
      this.say(t, `<span class="cmd">SQL&gt; ${esc(first.length > 120 ? first.slice(0, 120) + '…' : first)}${s.sql.includes('\n') ? ' …' : ''}</span>\n`);
      this.history(t, s.sql);
      $('#sqlStatus').textContent = 'Running…';
      try {
        const r = await api('POST', '/api/db/exec', { sid: t.sid, sql: s.sql, max_rows: max, auto_commit: auto });
        t.inTx = r.in_tx;
        const secs = (r.elapsed_ms / 1000).toFixed(r.elapsed_ms < 10000 ? 3 : 1);
        if (r.columns) {
          t.result = r;
          if (stmts.length > 1) this.say(t, esc(textTable(r)) + '\n');
          this.say(t, `<span class="ok">${r.row_count} row(s) selected${r.truncated ? ` (stopped at ${max}; raise Max rows for more)` : ''} · ${secs}s</span>\n`);
          if (stmts.length === 1) this.showOut('res');
        } else {
          this.say(t, `<span class="ok">${esc(r.message || 'Done')} · ${secs}s</span>\n`);
          if (stmts.length === 1 && !(r.output || []).length) this.showOut('out');
        }
        if (r.output?.length) { this.say(t, r.output.map(l => `<span class="dbms">${esc(l)}</span>`).join('\n') + '\n'); this.showOut('out'); }
        $('#sqlStatus').textContent = r.columns ? `${r.row_count} row(s) · ${secs}s` : `${r.message || 'Done'} · ${secs}s`;
      } catch (err) {
        this.say(t, `<span class="err">${esc(err.message)}</span>\n`);
        $('#sqlStatus').textContent = 'Error';
        this.showOut('out');
        if (all) { this.say(t, '<span class="err">Script stopped.</span>\n'); break; }
      }
      this.say(t, '\n');
      if (t === this.active) { this.renderResult(); this.renderTx(); }
    }
    this.busy(false);
    this.renderTabs();
  },

  busy(on) {
    this.running = on;
    $('#sqlRun').disabled = $('#sqlScript').disabled = on;
    $('#sqlStop').disabled = !on;
  },

  say(t, html) {
    t.out += html;
    if (t.out.length > 400000) t.out = t.out.slice(-300000);
    if (t === this.active) { const o = $('#sqlOut'); o.innerHTML = t.out; o.scrollTop = o.scrollHeight; }
  },
  renderOut() { const o = $('#sqlOut'); o.innerHTML = this.active.out; o.scrollTop = o.scrollHeight; },

  showOut(which) {
    $$('#sqlOutTabs .tab').forEach(x => x.classList.toggle('active', x.dataset.o === which));
    $('#sqlRes').hidden = which !== 'res'; $('#sqlOut').hidden = which !== 'out'; $('#sqlHistWrap').hidden = which !== 'hist'; $('#sqlSnipWrap').hidden = which !== 'snip';
    if (which === 'snip') Snippets.load();
  },

  renderResult() {
    const r = this.active?.result, el = $('#sqlRes');
    if (!r) { el.innerHTML = '<div class="empty">Run a query to see results.</div>'; return; }
    const isNum = (r.types || []).map(ty => /NUMBER|NUMERIC|INT|DECIMAL|FLOAT|DOUBLE|REAL|MONEY/i.test(ty || ''));
    el.innerHTML = `<table class="grid"><thead><tr><th class="rn">#</th>${r.columns.map((c, i) => `<th>${esc(c)}<small>${esc((r.types || [])[i] || '')}</small></th>`).join('')}</tr></thead><tbody>` +
      r.rows.map((row, ri) => `<tr><td class="rn">${ri + 1}</td>${row.map((v, ci) => v === null ? '<td class="null">(null)</td>' : `<td class="${isNum[ci] ? 'num' : ''}" title="${esc(String(v).slice(0, 500))}">${esc(String(v).slice(0, 2000))}</td>`).join('')}</tr>`).join('') +
      '</tbody></table>' + (r.rows.length ? '' : '<div class="empty">No rows.</div>');
  },

  renderTx() {
    const t = this.active;
    $('#sqlTx').hidden = !t?.inTx;
    $('#sqlCommit').disabled = $('#sqlRollback').disabled = !t?.inTx;
  },

  async tx(action) {
    const t = this.active;
    try {
      const r = await api('POST', '/api/db/tx', { sid: t.sid, action });
      t.inTx = r.in_tx;
      this.say(t, `<span class="ok">${esc(r.message)}</span>\n\n`);
      toast(r.message);
    } catch (err) { this.say(t, `<span class="err">${esc(err.message)}</span>\n`); toast(err.message, true); }
    this.renderTx(); this.renderTabs();
  },

  history(t, sql) {
    const key = 'sqlhist.' + t.entry.id;
    let h = [];
    try { h = JSON.parse(localStorage.getItem(key)) || []; } catch { /* ignore */ }
    h = [{ sql, at: Date.now() }, ...h.filter(x => x.sql !== sql)].slice(0, 100);
    try { localStorage.setItem(key, JSON.stringify(h)); } catch { /* full or private */ }
    if (t === this.active) this.renderHist();
  },
  renderHist() {
    let h = [];
    try { h = JSON.parse(localStorage.getItem('sqlhist.' + this.active.entry.id)) || []; } catch { /* ignore */ }
    const q = ($('#sqlHistFilter')?.value || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    $('#sqlHist').innerHTML = h.map((x, i) => [x, i]).filter(([x]) => q.every(w => x.sql.toLowerCase().includes(w))).map(([x, i]) => `<div class="hist-item" data-h="${i}" title="Click to put back in the editor"><small>${new Date(x.at).toLocaleString()}</small>${esc(x.sql)}</div>`).join('') || `<div class="empty">${h.length ? 'No match.' : 'No history yet.'}</div>`;
    this.histList = h;
  },

  async loadObjects(t, filter) {
    try {
      t.objects = await api('GET', `/api/db/objects?sid=${t.sid}&filter=${encodeURIComponent(filter)}`);
      t.cols = {};
    } catch (err) { t.objects = []; t.objErr = err.message; }
    if (t === this.active) this.renderObjects();
  },
  renderObjects() {
    const t = this.active;
    if (!t.objects) { $('#sqlObjList').innerHTML = '<div class="empty">Loading…</div>'; return; }
    const q = $('#sqlObjFilter').value.trim().toLowerCase();
    const list = t.objects.filter(o => !q || o.name.toLowerCase().includes(q));
    $('#sqlObjList').innerHTML = list.map(o => {
      const k = o.schema + '.' + o.name, cols = t.cols?.[k];
      return `<div class="obj" data-k="${esc(k)}" title="Click: columns · Double-click: preview rows">${/VIEW/i.test(o.type) ? '👁' : '▦'} ${esc(o.name)} <small>${esc(o.schema)}</small></div>` +
        (cols ? `<div class="obj-cols">${cols.map(c => `<div data-col="${esc(c.name)}" title="Click to insert">${esc(c.name)} <small>${esc(c.type)}${c.nullable === 'N' ? ' not null' : ''}</small></div>`).join('')}</div>` : '');
    }).join('') || `<div class="empty">${esc(t.objErr || 'No tables found. Type a name and press Enter to search all schemas.')}</div>`;
  },

  insert(text) {
    this.cm.replaceSelection(text);
    this.cm.focus();
  },

  fit() { /* layout is CSS-driven; kept for symmetry with the terminal */ },
};

// ---------- SQL object tree (under each connected database in the tree) ----------
Object.assign(SQL, {
  nodeKey(n) { return [n.level, n.schema || '', n.type || '', n.name || '', n.label].join('\u001f'); },

  async loadKids(t, node) {
    const k = node ? this.nodeKey(node) : 'root';
    const q = node ? `&level=${encodeURIComponent(node.level)}&schema=${encodeURIComponent(node.schema || '')}&type=${encodeURIComponent(node.type || '')}&name=${encodeURIComponent(node.name || '')}` : '&level=root';
    t.ot.loading.add(k); Tree.render();
    try {
      const kids = await api('GET', `/api/db/tree?sid=${t.sid}${q}`);
      t.ot.kids.set(k, kids);
      for (const c of kids) if (c.open) { t.ot.open.add(this.nodeKey(c)); this.loadKids(t, c); }
    } catch (err) {
      t.ot.kids.set(k, [{ level: 'leaf', label: '⚠ ' + err.message, leaf: true }]);
    }
    t.ot.loading.delete(k); Tree.render();
  },

  treeHTML(t, depth) {
    if (!t.ot) { t.ot = { open: new Set(), kids: new Map(), loading: new Set(), nodes: new Map() }; this.loadKids(t, null); }
    const icon = n => ({ schema: '🗄', schemas: '📁', type: '📂', cols: '▤', idx: '⚡', cons: '🔒', trg: '⚙' }[n.level]
      || ({ TABLE: '▦', VIEW: '👁', 'MATERIALIZED VIEW': '👁', INDEX: '⚡', SEQUENCE: '#', SYNONYM: '↪', PROCEDURE: 'ƒ', FUNCTION: 'ƒ', PACKAGE: '📦', TRIGGER: '⚙', TYPE: 'T', COLUMN: '·' }[n.type] || '·'));
    const walk = (kids, d) => kids.map(n => {
      const k = this.nodeKey(n), open = t.ot.open.has(k);
      t.ot.nodes.set(k, n);
      let h = `<div class="tnode dbn ${n.bad ? 'bad' : ''}" style="padding-left:${8 + d * 14}px" data-dbk="${esc(k)}" data-sid="${t.sid}" title="${esc(n.detail || n.label)}">
        <span class="tw">${n.leaf ? '' : pm(open)}</span>${icon(n)} <span class="nm">${esc(n.label)}</span>${n.detail ? `<small>${esc(n.detail)}</small>` : ''}</div>`;
      if (open) {
        const sub = t.ot.kids.get(k);
        h += sub ? walk(sub, d + 1) : `<div class="tnode dbn muted" style="padding-left:${8 + (d + 1) * 14}px">loading…</div>`;
      }
      return h;
    }).join('');
    const root = t.ot.kids.get('root');
    return root ? walk(root, depth) : `<div class="tnode muted" style="padding-left:${8 + depth * 14}px">loading…</div>`;
  },

  tabOf(el) { return this.tabs.find(t => t.sid === el.dataset.sid); },

  treeClick(el) {
    const t = this.tabOf(el); if (!t) return;
    if (this.active !== t) this.activate(t);
    const k = el.dataset.dbk, n = t.ot.nodes.get(k);
    if (!n || n.leaf) return;
    if (t.ot.open.has(k)) t.ot.open.delete(k);
    else { t.ot.open.add(k); if (!t.ot.kids.has(k)) return this.loadKids(t, n); }
    Tree.render();
  },

  qualified(t, n) {
    const q = s => /^[a-z_][a-z0-9_$]*$/.test(s) || (t.kind === 'oracle' && /^[A-Z_][A-Z0-9_$#]*$/.test(s)) ? s : `"${s}"`;
    return `${q(n.schema)}.${q(n.name)}`;
  },

  // Double-click: preview rows of tables/views, load source of code objects, insert column names.
  treeOpen(el) {
    const t = this.tabOf(el), n = t?.ot.nodes.get(el.dataset.dbk);
    if (!n) return;
    if (this.active !== t) this.activate(t);
    if (n.type === 'COLUMN') return this.insert(n.name);
    if (n.level !== 'obj') return;
    if (['TABLE', 'VIEW', 'MATERIALIZED VIEW', 'SYNONYM'].includes(n.type)) return this.preview(t, n);
    if (['PROCEDURE', 'FUNCTION', 'PACKAGE', 'TRIGGER', 'TYPE', 'SEQUENCE', 'INDEX'].includes(n.type)) return this.showDDL(t, n);
  },

  runText(stmt) {
    const cm = this.cm;
    cm.setValue(cm.getValue().replace(/\s*$/, '') + '\n\n' + stmt + '\n');
    const end = cm.getValue().length - 1;
    cm.setSelection(cm.posFromIndex(end - stmt.length), cm.posFromIndex(end));
    cm.scrollIntoView(null, 80);
    this.run(false);
  },

  preview(t, n) {
    const name = this.qualified(t, n);
    this.runText(t.kind === 'oracle' ? `SELECT * FROM ${name} WHERE ROWNUM <= 100;` : `SELECT * FROM ${name} LIMIT 100;`);
  },

  async showDDL(t, n) {
    toast('Loading source…');
    try {
      const r = await api('GET', `/api/db/ddl?sid=${t.sid}&schema=${encodeURIComponent(n.schema)}&type=${encodeURIComponent(n.type)}&name=${encodeURIComponent(n.name)}`);
      const cm = this.cm, at = cm.lastLine() + 2;
      cm.replaceRange((cm.getValue().trim() ? '\n\n' : '') + r.ddl + '\n', CodeMirror.Pos(cm.lastLine()));
      cm.scrollIntoView(CodeMirror.Pos(Math.min(at, cm.lastLine()), 0), 60);
      cm.setCursor(CodeMirror.Pos(Math.min(at, cm.lastLine()), 0));
      cm.focus();
    } catch (err) { toast(err.message, true); }
  },

  treeMenu(ev, el) {
    const t = this.tabOf(el), n = t?.ot.nodes.get(el.dataset.dbk);
    if (!n) return;
    if (this.active !== t) this.activate(t);
    const items = [];
    if (n.level === 'obj') {
      const name = this.qualified(t, n);
      if (['TABLE', 'VIEW', 'MATERIALIZED VIEW', 'SYNONYM'].includes(n.type)) {
        items.push(['Select first 100 rows', () => this.preview(t, n)],
          ['Count rows', () => this.runText(`SELECT COUNT(*) FROM ${name};`)]);
      }
      if (n.type !== 'SYNONYM') items.push(['Show DDL / source', () => this.showDDL(t, n)]);
      items.push('-', ['Insert name into editor', () => this.insert(name)], ['Copy name', () => copyText(name)]);
    } else if (n.type === 'COLUMN') {
      items.push(['Insert column name', () => this.insert(n.name)], ['Copy column name', () => copyText(n.name)]);
    }
    if (!n.leaf) {
      if (items.length) items.push('-');
      items.push(['Refresh', () => {
        const k = this.nodeKey(n);
        for (const key of [...t.ot.kids.keys()]) if (key === k || key.startsWith(k)) t.ot.kids.delete(key);
        t.ot.open.add(k); this.loadKids(t, n);
      }]);
    }
    if (items.length) Tree.showMenu(ev, items);
  },
});

// SQL page events
$('#sqlRun').onclick = () => SQL.run(false);
$('#sqlReconnect').onclick = () => SQL.reconnect();
$('#sqlDisconnect').onclick = () => SQL.active && SQL.close(SQL.active);
$('#sqlScript').onclick = () => SQL.run(true);
$('#sqlStop').onclick = () => SQL.active && api('POST', '/api/db/cancel', { sid: SQL.active.sid }).catch(() => {});
$('#sqlCommit').onclick = async () => { const t = SQL.active; if (t && isProd(t.entry) && !await askYes(`⚠ PROD — commit the changes on ${t.entry.name || t.entry.host}?`)) return; SQL.tx('commit'); };
$('#sqlRollback').onclick = () => SQL.tx('rollback');
$('#sqlAuto').checked = (() => { try { return localStorage.getItem('sqlAuto') === '1'; } catch { return false; } })();
$('#sqlAuto').onchange = e => { try { localStorage.setItem('sqlAuto', e.target.checked ? '1' : '0'); } catch { /* ignore */ } };
// The tree already lists each database's tables, so the right-hand list starts hidden (remembered).
$('.sql-grid').classList.toggle('no-objects', (() => { try { return localStorage.getItem('sqlObjects') !== '1'; } catch { return true; } })());
$('#sqlObjToggle').onclick = () => { const on = !$('.sql-grid').classList.toggle('no-objects'); try { localStorage.setItem('sqlObjects', on ? '1' : '0'); } catch { /* ignore */ } };
SQL.cm = makeEditor($('#sqlEditorHost'), { mode: 'text/x-plsql' });
SQL.cm.addKeyMap({ 'Ctrl-Enter': () => SQL.run(false), 'Cmd-Enter': () => SQL.run(false), 'F5': () => SQL.run(true) });
document.addEventListener('keydown', e => { if (e.key === 'F5' && $('#view-sql').classList.contains('active') && SQL.active) { e.preventDefault(); SQL.run(true); } });
let sqlSaveTimer;
SQL.cm.on('change', () => {
  const t = SQL.active; if (!t) return;
  t.sql = SQL.cm.getValue();
  clearTimeout(sqlSaveTimer);
  sqlSaveTimer = setTimeout(() => { try { localStorage.setItem('sql.' + t.entry.id, t.sql); } catch { /* full or private */ } }, 500);
});
$('#sqlTabs').addEventListener('click', e => {
  const x = e.target.closest('[data-sx]');
  if (x) return SQL.close(SQL.tabs.find(t => t.sid === x.dataset.sx));
  const tab = e.target.closest('[data-st]');
  if (tab) SQL.activate(SQL.tabs.find(t => t.sid === tab.dataset.st));
});
// ---------- 📌 SQL snippets: named queries, for this connection or all ----------
const Snippets = {
  list: [],
  async load() { this.list = await api('GET', '/api/snippets').catch(() => []); this.render(); },
  forActive() { const id = SQL.active?.entry.id; return this.list.filter(x => !x.conn || x.conn === id); },
  render() {
    const el = $('#sqlSnip'); if (!el) return;
    const id = SQL.active?.entry.id, q = $('#sqlSnipFilter').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const hit = x => q.every(w => `${x.name} ${x.sql}`.toLowerCase().includes(w));
    const mine = this.list.filter(x => x.conn && x.conn === id && hit(x)), all = this.list.filter(x => !x.conn && hit(x));
    const item = x => `<div class="snip-item" data-snip="${x.id}" title="Click: put it in the editor · Double-click: put it in and run it"><div class="snip-head"><b>${esc(x.name)}</b><span class="spacer"></span><button class="icon more" data-snipmore="${x.id}" title="Rename, share, update, delete">⋯</button></div><pre>${esc(x.sql.length > 400 ? x.sql.slice(0, 400) + '…' : x.sql)}</pre></div>`;
    const sec = (t, xs) => xs.length ? `<div class="snip-sec">${t} <span class="n">${xs.length}</span></div>${xs.map(item).join('')}` : '';
    el.innerHTML = sec(`This connection${SQL.active ? ' — ' + esc(dbLabel(SQL.active.entry).replace(/<[^>]*>/g, '')) : ''}`, mine) + sec('All connections', all)
      || `<div class="empty">${this.list.length ? 'No match.' : 'No snippets yet.<br>Write a query, then press <b>＋ Save current statement</b>.'}</div>`;
  },
  // The selection, or the statement at the cursor.
  current() {
    if (!SQL.active) return '';
    const sel = SQL.cm.getSelection().trim();
    if (sel) return sel;
    const p = SQL.pick(false)[0];
    return p ? (p.sql || SQL.cm.getValue().slice(p.from, p.to)).trim() : '';
  },
  async save() {
    const sql = this.current();
    if (!sql) return toast('Write or select a query first', true);
    const first = sql.split('\n')[0].replace(/\s+/g, ' ').slice(0, 60);
    const name = await askText('Name for this snippet:', first);
    if (!name?.trim()) return;
    const shared = await askYes('Use it on every connection?\n\nOK = all connections · Cancel = only this one');
    await api('POST', '/api/snippets', { name: name.trim(), sql, conn: shared ? '' : SQL.active.entry.id }).catch(err => toast(err.message, true));
    toast('Snippet saved'); this.load();
  },
  put(x, run) {
    if (!SQL.active) return toast('Connect to a database first', true);
    // Added at the end and selected, so Run runs just this snippet.
    const cm = SQL.cm, v = cm.getValue(), gap = !v ? '' : /\n\n$/.test(v) ? '' : /\n$/.test(v) ? '\n' : '\n\n';
    cm.replaceRange(gap + x.sql + '\n', cm.posFromIndex(v.length));
    const start = v.length + gap.length;
    cm.setSelection(cm.posFromIndex(start), cm.posFromIndex(start + x.sql.length)); cm.scrollIntoView(null, 60); cm.focus();
    api('POST', `/api/snippets/${x.id}/used`).catch(() => {});
    if (run) SQL.run(false); // runs the selection: just this snippet
  },
  menu(x, ev) {
    Tree.showMenu(ev, [
      ['Put in the editor', () => this.put(x)], ['Put in and run', () => this.put(x, true)], ['Copy SQL', () => copyText(x.sql, 'SQL copied')], '-',
      ['Rename…', async () => { const n = await askText('Snippet name', x.name); if (n?.trim()) { await api('POST', '/api/snippets', { ...x, name: n.trim() }); this.load(); } }],
      ['Replace with the current statement', async () => { const sql = this.current(); if (!sql) return toast('Select or write the new SQL first', true); await api('POST', '/api/snippets', { ...x, sql }); toast('Snippet updated'); this.load(); }],
      x.conn ? ['Use on all connections', async () => { await api('POST', '/api/snippets', { ...x, conn: '' }); this.load(); }]
        : SQL.active && ['Only for this connection', async () => { await api('POST', '/api/snippets', { ...x, conn: SQL.active.entry.id }); this.load(); }],
      '-', ['Delete', async () => { if (await askYes(`Delete the snippet “${x.name}”?`)) { await api('DELETE', `/api/snippets/${x.id}`); this.load(); } }],
    ].filter(Boolean));
  },
};
$('#sqlSnipFilter').addEventListener('input', () => Snippets.render());
$('#sqlSnipSave').onclick = () => Snippets.save();
$('#sqlHistFilter').addEventListener('input', () => SQL.active && SQL.renderHist());
$('#sqlSnip').addEventListener('click', e => {
  const m = e.target.closest('[data-snipmore]');
  if (m) { const r = m.getBoundingClientRect(); return setTimeout(() => Snippets.menu(Snippets.list.find(x => x.id === m.dataset.snipmore), { clientX: r.left - 150, clientY: r.bottom })); }
  const it = e.target.closest('[data-snip]'); if (it && e.detail === 1) Snippets.put(Snippets.list.find(x => x.id === it.dataset.snip));
});
$('#sqlSnip').addEventListener('dblclick', e => { const it = e.target.closest('[data-snip]'); if (it) { SQL.cm.undo(); Snippets.put(Snippets.list.find(x => x.id === it.dataset.snip), true); } });
$('#sqlSnip').addEventListener('contextmenu', e => { const it = e.target.closest('[data-snip]'); if (!it) return; e.preventDefault(); Snippets.menu(Snippets.list.find(x => x.id === it.dataset.snip), e); });

$('#sqlOutTabs').addEventListener('click', e => { const tab = e.target.closest('[data-o]'); if (tab) SQL.showOut(tab.dataset.o); });
$('#sqlHist').addEventListener('click', e => {
  const it = e.target.closest('[data-h]');
  if (it) {
    const cm = SQL.cm, v = cm.getValue();
    cm.replaceRange((/\n$/.test(v) || !v ? '' : '\n') + SQL.histList[it.dataset.h].sql + '\n', CodeMirror.Pos(cm.lastLine()));
    cm.focus();
  }
});
$('#sqlObjFilter').addEventListener('input', () => SQL.active && SQL.renderObjects());
$('#sqlObjFilter').addEventListener('keydown', e => { if (e.key === 'Enter' && SQL.active) SQL.loadObjects(SQL.active, e.target.value.trim()); });
$('#sqlObjList').addEventListener('click', async e => {
  const t = SQL.active;
  const col = e.target.closest('[data-col]');
  if (col) return SQL.insert(col.dataset.col);
  const o = e.target.closest('[data-k]');
  if (!o) return;
  const k = o.dataset.k;
  if (t.cols[k]) { delete t.cols[k]; return SQL.renderObjects(); }
  const [schema, ...rest] = k.split('.');
  try { t.cols[k] = await api('GET', `/api/db/columns?sid=${t.sid}&schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(rest.join('.'))}`); } catch (err) { toast(err.message, true); }
  SQL.renderObjects();
});
$('#sqlObjList').addEventListener('dblclick', e => {
  const o = e.target.closest('[data-k]'); if (!o) return;
  const t = SQL.active, [schema, ...rest] = o.dataset.k.split('.');
  const q = (s) => /^[a-z_][a-z0-9_$]*$/.test(s) || (t.kind === 'oracle' && /^[A-Z_][A-Z0-9_$#]*$/.test(s)) ? s : `"${s}"`;
  const stmt = t.kind === 'oracle' ? `SELECT * FROM ${q(schema)}.${q(rest.join('.'))} WHERE ROWNUM <= 100;` : `SELECT * FROM ${q(schema)}.${q(rest.join('.'))} LIMIT 100;`;
  const cm = SQL.cm;
  cm.setValue(cm.getValue().replace(/\s*$/, '') + '\n\n' + stmt + '\n');
  const end = cm.getValue().length - 1;
  cm.setSelection(cm.posFromIndex(end - stmt.length), cm.posFromIndex(end));
  cm.scrollIntoView(null, 80);
  SQL.run(false);
});
$('#sqlRes').addEventListener('dblclick', e => { const td = e.target.closest('td'); if (td && !td.classList.contains('rn')) copyText(td.classList.contains('null') ? '' : td.title || td.textContent, 'Cell copied'); });
function resultAs(sep) {
  const r = SQL.active?.result; if (!r) return '';
  const cell = v => v === null ? '' : sep === ',' && /[",\n\r]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v).replace(/[\t\n\r]/g, ' ');
  return [r.columns.map(cell).join(sep), ...r.rows.map(row => row.map(cell).join(sep))].join('\r\n');
}
$('#sqlCopy').onclick = () => SQL.active?.result ? copyText(resultAs('\t'), `Copied ${SQL.active.result.row_count} row(s) — paste into Excel`) : toast('No results', true);
$('#sqlCsv').onclick = () => {
  if (!SQL.active?.result) return toast('No results', true);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + resultAs(',')], { type: 'text/csv' }));
  a.download = `${SQL.active.entry.name}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.csv`.replace(/[^\w.-]+/g, '_');
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};
