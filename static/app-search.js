'use strict';
// WorkHub page, part 2 of 7 (after app.js): search, organising, 📅 Today, the entry dialog, captured.
// The page's script is split into parts loaded in order (index.html); they share one global scope.

// ---------- search ----------
// Every word must appear somewhere (name, host, URL, user, notes, naming-rule
// label, type…); "-word" leaves out. key:value narrows further, e.g.
// env:prod type:db user:ops app:batch port:1521 has:password no:env is:fail
// needs:attention db:ordsvc added:today used:7d used:never. Typing acmebat01 also finds acme-bat-01.
const SEARCH_KEYS = /^(env|type|user|app|port|host|project|in|tag|has|no|is|needs|db|added|used):(.+)$/;
// added:today / used:7d / added:2w / used:month … → the start of that window (ms), or null.
function sinceMs(v) {
  const day = 864e5, midnight = new Date().setHours(0, 0, 0, 0);
  const named = { today: midnight, yesterday: midnight - day, week: Date.now() - 7 * day, month: Date.now() - 30 * day, year: Date.now() - 365 * day }[v];
  if (named) return named;
  const m = v.match(/^(\d+)\s*([dwmy]?)$/);
  return m ? Date.now() - +m[1] * { d: 1, w: 7, m: 30, y: 365, '': 1 }[m[2]] * day : null;
}
let lastQuery = [null, null];
function parseQuery(q) {
  if (lastQuery[0] === q) return lastQuery[1];
  const out = { words: [], filters: [] };
  for (const t of q.toLowerCase().match(/-?[\w.]*:?"[^"]*"|\S+/g) || []) {
    const neg = t.length > 1 && t.startsWith('-'), b = neg ? t.slice(1) : t, m = b.match(SEARCH_KEYS);
    if (m) out.filters.push({ k: m[1], v: m[2].replace(/"/g, ''), neg });
    else if (b.replace(/"/g, '')) out.words.push({ v: b.replace(/"/g, ''), neg });
  }
  lastQuery = [q, out];
  return out;
}
const squash = s => s.replace(/[-_.:/\s]+/g, '');
function searchText(e) {
  return [e.name, e.host, e.url, linkLabel(e.url), e.username, e.project, e.env, e.protocol, e.port, e.notes, ruleLabel(e.host) || ruleLabel(e.url),
    serverType(e), dbKindOf(e), ...(e.tags || []), ...Object.entries(e.extra || {}).filter(([k]) => k !== 'color').flat()].filter(Boolean).join(' ').toLowerCase();
}
const isConn = e => canSSH(e) || canDB(e) || canFiles(e);
// What's missing or wrong with an entry: [key, text].
function problems(e) {
  const out = [];
  if (!isConn(e)) return out; // web links: an unreachable page isn't missing information
  if (e.status === 'fail') out.push(['failing', 'Last connection failed' + (e.status_msg ? ': ' + e.status_msg : '')]);
  if (!e.username) out.push(['user', 'No username']);
  else if (!e.has_password && !e.password && !e.key_file && e.extra?.auth !== 'key') out.push(['password', 'No password or key']);
  if (!e.env) out.push(['env', 'No environment']);
  if (canDB(e) && !dbService(e)?.name) out.push(['service', 'No service name / database']);
  return out;
}
const HAS = {
  password: e => !!(e.has_password || e.password), user: e => !!e.username, url: e => !!e.url, env: e => !!e.env, key: e => !!e.key_file,
  notes: e => !!e.notes, tunnels: e => !!e.extra?.tunnels, commands: e => !!e.extra?.commands, jdbc: e => !!jdbcURL(e), tags: e => !!e.tags?.length,
};
function filterOK(e, { k, v }) {
  const has = s => (s || '').toLowerCase().includes(v);
  switch (k) {
    case 'env': return v === 'none' ? !e.env : (e.env || '').toLowerCase().startsWith(v);
    case 'type': return TYPE_TEST[v] ? TYPE_TEST[v](e) : has(e.protocol) || has(serverType(e)) || has(dbKindOf(e));
    case 'user': return has(e.username);
    case 'app': return has(ruleLabel(e.host) || ruleLabel(e.url) || serverApp(e));
    case 'port': return String(e.port || '') === v;
    case 'host': return has(e.host) || has(e.url);
    case 'project': case 'in': return has(e.project);
    case 'tag': return (e.tags || []).some(has);
    case 'has': return HAS[v] ? HAS[v](e) : has(searchText(e));
    case 'no': return HAS[v] ? !HAS[v](e) : !has(searchText(e));
    case 'is': return { ok: e.status === 'ok', working: e.status === 'ok', fail: e.status === 'fail', failed: e.status === 'fail', untested: !e.status,
      pinned: !!e.favorite, fav: !!e.favorite, used: !!e.last_used, stale: !!staleDays(e), old: !!staleDays(e), unsorted: !!e.unsorted, new: !!e.unsorted }[v] ?? (e.env || '').toLowerCase() === v;
    case 'db': return has(dbService(e)?.name);
    case 'added': case 'used': {
      if (k === 'used' && v === 'never') return !e.last_used;
      const t = k === 'added' ? e.created : e.last_used, from = sinceMs(v);
      return from != null && !!t && new Date(t) >= from;
    }
    case 'needs': return v === 'attention' || v === 'fix' ? problems(e).length > 0 : problems(e).some(([p]) => p.startsWith(v));
  }
  return true;
}
// Close spellings: "uta" → uat, "pasword" → password (used when nothing matches exactly).
// Typing mistakes between two words: a letter missing, extra, wrong or two swapped.
function editDist(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 9;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
}
// The nearest word in the saved details for each word that matches nothing.
function closeWords(entries, words) {
  const vocab = new Set(entries.flatMap(e => searchText(e).split(/[^a-z0-9]+/).filter(t => t.length > 2)));
  const fixes = {};
  for (const w of words) {
    if (w.length < 3 || [...vocab].some(t => t.includes(w))) continue;
    let best = '', bd = (w.length > 5 ? 2 : 1) + 1; // up to 1 mistake in short words, 2 in long ones
    for (const t of vocab) { const d = editDist(w, t); if (d < bd || (d === bd && best && t.length < best.length)) { best = t; bd = d; } }
    if (best) fixes[w] = best;
  }
  return fixes;
}
// Not used, tested or captured for 90 days.
const STALE_DAYS = 90;
function staleDays(e) {
  const t = Math.max(...[e.last_used, e.status_at, e.created, ...(e.captures || []).map(c => c.at)].filter(Boolean).map(x => +new Date(x)), 0);
  const d = t ? Math.floor((Date.now() - t) / 864e5) : 0;
  return d >= STALE_DAYS ? d : 0;
}

function matches(e, q) {
  if (!q) return true;
  const { words, filters } = parseQuery(q);
  if (!filters.every(f => filterOK(e, f) !== f.neg)) return false;
  if (!words.length) return true;
  const hay = searchText(e), flat = squash(hay);
  return words.every(({ v, neg }) => (hay.includes(v) || (squash(v).length > 2 && flat.includes(squash(v)))) !== neg);
}
// How well an entry fits the words typed: exact host / IP / name first, then
// a host that starts with them, then name or host containing them, then
// anything else; ties go to the most used.
function searchScore(e, q) {
  const words = parseQuery(q).words.filter(w => !w.neg).map(w => w.v);
  if (!words.length) return 0;
  const host = (e.host || '').toLowerCase(), name = (e.name || '').toLowerCase(), all = words.join(' ');
  let s = 0;
  if (host === all || name === all || (e.url || '').toLowerCase() === all) s += 100;
  else if (host.startsWith(words[0]) || squash(host).startsWith(squash(words[0]))) s += 50;
  if (words.every(w => host.includes(w) || name.includes(w) || squash(host).includes(squash(w)))) s += 30;
  if (words.some(w => (ruleLabel(e.host) || '').toLowerCase().startsWith(w))) s += 10;
  return s + Math.min(usageScore(e), 20) + (e.favorite ? 5 : 0);
}

// View options the chat can set on top of the toolbar filters.
const emptyView = () => ({ projects: [], notProjects: [], envs: [], notEnvs: [], types: [], status: '', pinned: false,
  withPassword: null, withUrl: null, internal: null, text: '', recentDays: 0, sort: '', sortDir: 1, hideCols: [] });
S.view = (() => { try { return { ...emptyView(), ...JSON.parse(localStorage.getItem('dashView') || '{}') }; } catch { return emptyView(); } })();
function saveView() { try { localStorage.setItem('dashView', JSON.stringify(S.view)); } catch { /* ignore */ } }

const TYPE_TEST = {
  ssh: e => canSSH(e), files: e => canFiles(e), ftp: e => isFTP(e), sftp: e => canSSH(e), db: e => canDB(e),
  oracle: e => dbKindOf(e) === 'oracle', postgres: e => dbKindOf(e) === 'postgres', web: e => /^https?:/i.test(e.url || ''),
  rdp: e => e.protocol === 'rdp' || e.port === 3389, smb: e => e.protocol === 'smb' || /^\\\\/.test(e.url || ''),
  ldap: e => /^ldaps?$/.test(e.protocol || ''), credential: e => !e.host && !e.url,
};
const inProject = (e, p) => { const a = (e.project || '').toLowerCase(), b = p.toLowerCase(); return a === b || a.startsWith(b + '/'); };
function viewMatch(e, v = S.view) {
  return (!v.projects.length || v.projects.some(p => inProject(e, p))) && !v.notProjects.some(p => inProject(e, p))
    && (!v.envs.length || v.envs.includes(e.env || 'NONE')) && !v.notEnvs.includes(e.env || 'NONE')
    && (!v.types.length || v.types.some(t => TYPE_TEST[t]?.(e)))
    && (!v.status || (e.status || 'none') === v.status) && (!v.pinned || e.favorite)
    && (v.withPassword == null || !!e.has_password === v.withPassword) && (v.withUrl == null || !!e.url === v.withUrl)
    && (!v.text || matches(e, v.text.toLowerCase()))
    && (!v.recentDays || (e.last_used && Date.now() - new Date(e.last_used) < v.recentDays * 864e5))
    && (v.internal == null || isInternal(e) === v.internal);
}
const SORT_KEY = {
  name: e => (e.name || '').toLowerCase(), host: e => (e.host || e.url || '').toLowerCase(), project: e => (e.project || '').toLowerCase(),
  env: e => ENV_RANK[e.env] ?? 9, used: e => -(new Date(e.last_used || 0).getTime() || 0), added: e => -(new Date(e.created || 0).getTime() || 0),
  updated: e => -(new Date(e.updated || 0).getTime() || 0), status: e => ({ fail: 0, ok: 1 }[e.status] ?? 2), opens: e => -(e.open_count || 0),
};
const ENV_RANK = { PROD: 0, DR: 1, UAT: 2, STAGE: 3, TEST: 4, DEV: 5 };
// Usage score: how often (opens, connections; uses after a search count
// double) and how recently. Recent use matters most and fades over weeks.
function usageScore(e) {
  const uses = (e.open_count || 0) + 2 * (e.search_count || 0), last = Date.parse(e.last_used) || 0;
  if (!uses && !last) return 0;
  const days = (Date.now() - last) / 864e5;
  const recent = !last ? 0 : days < 1 ? 100 : days < 3 ? 70 : days < 7 ? 50 : days < 30 ? 30 : days < 90 ? 15 : 5;
  return Math.log2(1 + uses) * 20 + recent;
}
const byUsage = (a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0) || usageScore(b) - usageScore(a) || (a.name || '').localeCompare(b.name || '');
// A use right after searching counts as "searched for".
let lastSearchAt = 0;
document.addEventListener('input', ev => { if (ev.target.matches?.('input[type=search], #search') && ev.target.value.trim()) lastSearchAt = Date.now(); }, true);
function fromSearch() { return Date.now() - lastSearchAt < 120000 && $$('input[type=search], #search').some(i => i.value.trim()); }
function markSearched(e) { if (e?.id && fromSearch()) api('POST', `/api/entries/${e.id}/opened?only=searched`).catch(() => {}); }
SORT_KEY.usage = e => -usageScore(e);
function sortEntries(list) {
  const f = SORT_KEY[S.view.sort];
  if (!f) return [...list].sort(byUsage); // default: most used and most recent first
  const d = S.view.sortDir || 1;
  return [...list].sort((a, b) => { const x = f(a), y = f(b); return (x < y ? -1 : x > y ? 1 : 0) * d; });
}

// With Others picked at the top, UAT and PROD are left out (see EnvSwitch); a
// search still says how many of them match, with Show UAT / Show PROD.
const searchGuard = q => !!(q || '').trim() && !EnvSwitch.v;
function filtered() {
  let q = $('#search').value.trim().toLowerCase();
  const guard = searchGuard(q);
  S.guarded = {};
  const p = $('#fProject').value, env = $('#fEnv').value;
  const base = S.entries.filter(e => (!p || e.project === p) && (!env || e.env === env) && viewMatch(e));
  let list = base.filter(e => matches(e, q));
  S.fixes = null;
  if (!list.length && q) { // nothing: try close spellings
    const fixes = closeWords(base, parseQuery(q).words.filter(w => !w.neg).map(w => w.v));
    if (Object.keys(fixes).length) {
      const q2 = q.split(/\s+/).map(w => fixes[w] || w).join(' ');
      list = base.filter(e => matches(e, q2));
      if (list.length) { S.fixes = fixes; q = q2; }
    }
  }
  if (guard) for (const e of S.allEntries) { const g = !e.hidden && guardedEnv(e); if (g && matches(e, q)) S.guarded[g] = (S.guarded[g] || 0) + 1; } // left out by Others
  S.ranked = !S.view.sort && parseQuery(q).words.some(w => !w.neg); // searching: best match first
  if (!S.ranked) return sortEntries(list);
  const score = new Map(list.map(e => [e, searchScore(e, q)]));
  return list.sort((a, b) => score.get(b) - score.get(a) || byUsage(a, b));
}

// Chips showing what the chat changed, each removable.
function renderViewChips() {
  const v = S.view, chips = [];
  v.projects.forEach(p => chips.push([`project: ${p}`, () => (v.projects = v.projects.filter(x => x !== p))]));
  v.notProjects.forEach(p => chips.push([`not ${p}`, () => (v.notProjects = v.notProjects.filter(x => x !== p))]));
  v.envs.forEach(x => chips.push([x === 'NONE' ? 'no env' : x, () => (v.envs = v.envs.filter(y => y !== x))]));
  v.notEnvs.forEach(x => chips.push([`not ${x}`, () => (v.notEnvs = v.notEnvs.filter(y => y !== x))]));
  v.types.forEach(t => chips.push([t, () => (v.types = v.types.filter(y => y !== t))]));
  if (v.status) chips.push([{ ok: 'working', fail: 'failed', none: 'untested' }[v.status], () => (v.status = '')]);
  if (v.pinned) chips.push(['pinned', () => (v.pinned = false)]);
  if (v.withPassword != null) chips.push([v.withPassword ? 'with password' : 'no password', () => (v.withPassword = null)]);
  if (v.withUrl != null) chips.push([v.withUrl ? 'with URL' : 'no URL', () => (v.withUrl = null)]);
  if (v.internal != null) chips.push([v.internal ? 'internal' : 'external', () => (v.internal = null)]);
  if (v.text) chips.push([`"${v.text}"`, () => (v.text = '')]);
  if (v.recentDays) chips.push([`used in ${v.recentDays}d`, () => (v.recentDays = 0)]);
  if (v.sort) chips.push([`sort: ${v.sort}${v.sortDir < 0 ? ' ↓' : ''}`, () => (v.sort = '')]);
  if (v.hideCols.length) chips.push([`hidden: ${v.hideCols.join(', ')}`, () => (v.hideCols = [])]);
  for (const el of [$('#viewChips'), $('#bmChips')]) {
  el.innerHTML = chips.length ? chips.map((c, i) => `<span class="vchip" data-vc="${i}">${esc(c[0])} ✕</span>`).join('') + '<span class="vchip clear" data-vc="all">clear all</span>' : '';
  el.onclick = e => {
    const c = e.target.closest('[data-vc]'); if (!c) return;
    if (c.dataset.vc === 'all') Object.assign(S.view, emptyView()); else chips[+c.dataset.vc][1]();
    saveView(); renderBoard(); Bookmarks.render();
  };
  }
  return chips.length;
}

const isFTP = e => ['ftp', 'ftps'].includes(e.protocol) || (!e.protocol && e.port === 21);
const canSSH = e => !!e.host && !isFTP(e) && (['ssh', 'sftp', 'scp'].includes(e.protocol) || e.port === 22 || (!e.protocol && !dbKindByPort(+e.port)));
const canFiles = e => canSSH(e) || (!!e.host && isFTP(e));
// Usual port ranges (same as dbKindByPort in parse.go): Oracle 1521–1529 and
// 2483/2484 (TCPS), PostgreSQL 5432–5439 and 6432 (PgBouncer).
const dbKindByPort = p => (p >= 1521 && p <= 1529) || p === 2483 || p === 2484 ? 'oracle'
  : (p >= 5432 && p <= 5439) || p === 6432 ? 'postgres' : '';
const dbKindOf = e => e.protocol === 'oracle' ? 'oracle' : ['postgres', 'postgresql'].includes(e.protocol) ? 'postgres'
  : !e.protocol ? dbKindByPort(+e.port) : '';
const canDB = e => !!e.host && !!dbKindOf(e);
// Service name / SID / database of a DB connection: { name, sid }.
function dbService(e) {
  const x = e.extra || {}, svc = x.service || x.service_name || x.database || x.db_name || x.dbname;
  return svc ? { name: svc, sid: false } : x.sid ? { name: x.sid, sid: true } : null;
}
// " (copy)" / " (copy 2)" at the end of a duplicate's name, shown even where
// the name itself is replaced by the host or a short label.
const COPY_RE = / \(copy(?: \d+)?\)$/i;
const copyTag = e => (e.name || '').match(COPY_RE)?.[0] || '';
const withCopyTag = (html, e) => { const t = copyTag(e); return t && !html.includes(t.trim()) ? html + `<span class="copytag">${esc(t)}</span>` : html; };
// The name for a copy: "x (copy)", then "x (copy 2)", "x (copy 3)"…
function copyName(name, taken) {
  const base = (name || '').replace(COPY_RE, '');
  for (let i = 1; ; i++) { const n = base + (i === 1 ? ' (copy)' : ` (copy ${i})`); if (!taken.has(n)) return n; }
}
// DBeaver-style tree rows: a type icon and a short "UAT01 - app_user" name.
const dbIcon = e => dbKindOf(e) === 'oracle' ? '<span class="dbic ora" title="Oracle">O</span>' : '<span class="dbic pg" title="PostgreSQL">🐘</span>';
// The environment written in the host name (pps-uat01-euw1-… → UAT01), else the entry's env.
const ENV_TOKEN = /^(dev|sit|uat|qa|test|reltest|nft|pox|perf|stg|stage|staging|preprod|pre|prd|prod|dr|local)\d*[a-z]?$/i;
function hostEnv(e) {
  if (/^(localhost|127\.0\.0\.1|::1)$/i.test(e.host || '')) return 'LOCAL';
  const t = (e.host || '').split(/[.\-_]/).find(x => ENV_TOKEN.test(x));
  return t ? t.toUpperCase() : e.env || '';
}
// How a connection is named in the server trees: hostname-username-sid (the sid /
// service only for databases; missing parts left out).
const treeName = e => [e.host || e.name || e.url, e.username, canDB(e) ? dbService(e)?.name : ''].filter(Boolean).join('-');

function dbLabel(e) {
  const host = (e.host || '').toLowerCase(), name = e.name || '';
  if (name && !name.replace(COPY_RE, '').toLowerCase().includes(host)) return ruleName(e); // a name you gave it
  const who = e.username || dbService(e)?.name || e.host;
  return withCopyTag(esc([hostEnv(e) || 'DB', who].join(' - ')), e);
}
// JDBC string for a database connection, built from host, port and service/SID/database.
function jdbcURL(e) {
  if (!canDB(e)) return '';
  const kind = dbKindOf(e), svc = dbService(e), port = e.port || (kind === 'oracle' ? 1521 : 5432);
  if (kind === 'postgres') return `jdbc:postgresql://${e.host}:${port}/${svc?.name || ''}`;
  return svc?.sid ? `jdbc:oracle:thin:@${e.host}:${port}:${svc.name}` : `jdbc:oracle:thin:@//${e.host}:${port}${svc ? '/' + svc.name : ''}`;
}
// Tree status, two separate things:
//  • the dot is the state right now: ● connected, ◌ dashed = the session dropped
//    (its tab is still open), ○ = not connected;
//  • after the name, the last result: ✓ 3h = last connected fine 3 hours ago,
//    ✕ = the last try failed (hover for why and when it last worked).
function connState(e) {
  const ssh = Term.tabs.filter(t => t.entry?.id === e.id && !t.local);
  if (ssh.some(t => !t.closed) || Remote.tabs.some(t => t.entry.id === e.id) || SQL.tabs.some(t => t.entry.id === e.id)) return 'live';
  return ssh.length ? 'dropped' : '';
}
const STATE_DOT = {
  live: '<span class="dot live" title="Connected now"></span>',
  dropped: '<span class="dot dropped" title="Disconnected — the session dropped. Press Enter in its terminal tab (or double-click here) to reconnect."></span>',
  '': '<span class="dot none" title="Not connected"></span>',
};
const lastOKAt = e => e.last_ok || (e.status === 'ok' ? e.status_at : '');
function ago(t) {
  const m = Math.round((Date.now() - new Date(t)) / 6e4);
  return m < 1 ? 'now' : m < 60 ? m + 'm' : m < 1440 ? Math.round(m / 60) + 'h' : m < 60 * 24 * 60 ? Math.round(m / 1440) + 'd' : new Date(t).toLocaleDateString();
}
function lastSeen(e) {
  const ok = lastOKAt(e), when = t => new Date(t).toLocaleString();
  const okTag = ok ? `<span class="lastok" title="Last connected successfully: ${esc(when(ok))}">✓ ${ago(ok)}</span>` : '';
  if (e.status === 'fail') return `<span class="lastfail" title="${esc(`Last try failed${e.status_at ? ' ' + when(e.status_at) : ''}: ${e.status_msg || ''}${ok ? '\nLast worked: ' + when(ok) : '\nNever connected successfully yet'}`)}">✕</span>${okTag}`;
  return okTag;
}
// Status dot: green = last connection/link check worked, red = failed, grey = not tried.
function dot(e) {
  const when = e.status_at ? new Date(e.status_at).toLocaleString() : '';
  const title = e.status === 'ok' ? `Worked last time · ${when}` : e.status === 'fail' ? `Failed · ${when}\n${e.status_msg || ''}` : 'Not tried yet';
  return `<span class="dot ${e.status || 'none'}" title="${esc(title)}"></span>`;
}

function renderStats(list, home) {
  const today = new Date().toDateString();
  const capturedToday = S.clips.filter(c => new Date(c.created).toDateString() === today).length;
  // Tiles only for what you can act on; the counts go in one line underneath.
  const counts = [
    ['hosts', new Set(list.map(e => (e.host || '').toLowerCase()).filter(Boolean)).size],
    ['entries', list.length],
    ['logins', list.filter(e => e.username || e.has_password).length],
    ['URLs', list.filter(e => e.url).length],
    ['PROD', list.filter(e => e.env === 'PROD').length, 'env:PROD'],
  ];
  const fix = S.entries.filter(e => problems(e).length).length;
  $('#inboxCount').textContent = capturedToday || '';
  const line = `<div class="stat-line">${counts.filter(([, v], i) => v || i < 2).map(([k, v, f]) => f ? `<a href="#" data-find="${f}">${v} ${k}</a>` : `<span>${v} ${k}</span>`).join(' · ')}</div>`;
  if ($('#search').value.trim()) { $('#stats').innerHTML = list.length ? line : ''; return; } // searching: just what was found
  if (home) { // the overview: only what asks for something — on the Today line
    const n = S.entries.filter(e => e.unsorted).length;
    $('#stats').innerHTML = ''; const slot = $('#todayStats') || $('#stats');
    slot.innerHTML = (fix ? `<button class="stat warn" data-find="needs:attention" title="Connections with something missing or a failed login — click to list them"><b>⚠ ${fix}</b><span>need attention</span></button>` : '')
      + (n ? `<button class="stat inbox" data-find="is:unsorted" title="New captures you haven't looked at yet"><b>📥 ${n}</b><span>new to sort</span></button>` : '');
    return;
  }
  $('#stats').innerHTML = (fix ? `<button class="stat warn" data-find="needs:attention" title="Connections with something missing (user, password, environment, service name) or a failed login — click to list them"><b>⚠ ${fix}</b><span>Need attention</span></button>` : '')
    + ((n => n ? `<button class="stat inbox" data-find="is:unsorted" title="New captures you haven't looked at yet — each with a suggested folder"><b>📥 ${n}</b><span>New to sort</span></button>` : '')(S.entries.filter(e => e.unsorted).length))
    + (capturedToday ? `<button class="stat" data-view-go="inbox" title="Open Captured"><b>${capturedToday}</b><span>Captured today</span></button>` : '')
    + `<button class="stat act" id="retestBtn" title="Try every connection shown (SSH, SFTP/FTP, databases) with its saved login and update ✓ / ✗"><b>↻</b><span>Re-test ${list.filter(isConn).length} connections</span></button>`
    + line;
}

// ---------- organising ----------
// Where a new capture probably belongs: the folder (and environment) most
// used by servers in the same domain or with the same naming-rule label.
function suggestPlace(e) {
  const dom = serverDomain(e), rl = ruleLabel(e.host) || ruleLabel(e.url);
  const like = S.entries.filter(x => x !== e && !x.unsorted && isConn(x) === isConn(e) && !x.folder); // servers with servers; not browser bookmarks
  const near = like.filter(x => e.host && serverDomain(x) === dom && dom !== 'Short names');
  const peers = near.length ? near : rl ? like.filter(x => (ruleLabel(x.host) || ruleLabel(x.url)) === rl) : [];
  const top = vals => Object.entries(vals.filter(Boolean).reduce((m, v) => (m[v] = (m[v] || 0) + 1, m), {})).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  const project = top(peers.map(x => x.project)) || e.project, env = e.env || top(near.map(x => x.env));
  return project !== e.project || (env || '') !== (e.env || '') ? { project, env } : null;
}
function unsortedRow(e) {
  const sg = suggestPlace(e);
  return `<span class="inboxrow"><span class="newpill">NEW</span>${sg ? `<span>belongs in <b>${esc(sg.project)}</b>${sg.env ? ' · ' + esc(sg.env) : ''}?</span>` : ''}
    ${sg ? `<button class="icon primary" data-act="accept" data-id="${e.id}" title="Move it there">✓ Move</button><button class="icon" data-act="keep" data-id="${e.id}" title="Keep in ${esc(e.project)}">Keep</button>` : ''}${isConn(e) && !(S.sshOff && canSSH(e) && !canDB(e) && !isFTP(e)) // SSH switched off: nothing to test
      ? `<button class="icon ${sg ? '' : 'primary'}" data-act="trytest" data-id="${e.id}" title="Try connecting once with the saved login: a green dot if it works, ⚠ Needs attention if it doesn't">🔌 Test</button>`
      : sg ? '' : `<button class="icon primary" data-act="accept" data-id="${e.id}" title="It is right where it is: stop marking it new">✓ OK</button>`}</span>`;
}
async function sortEntry(e, accept) {
  const sg = accept && suggestPlace(e);
  await api('POST', '/api/entries', { ...entryInput(e), password: e.password, ...(sg ? { project: sg.project, env: sg.env } : {}) });
}

// App × environment: one row per application, one column per environment.
const GRID_ENVS = ['DEV', 'SIT', 'TEST', 'QA', 'UAT', 'STAGE', 'PREPROD', 'PROD', 'DR'];
function gridHTML(list) {
  list = list.filter(isConn); // servers and databases; web links stay in Cards / Table
  if (!list.length) return '<div class="empty">No servers or databases here — the grid shows connections; links are in Cards and Table.</div>';
  const appOf = e => ruleLabel(e.host) || ruleLabel(e.url) || serverApp(e);
  const rank = v => { const i = GRID_ENVS.indexOf(v); return v ? (i < 0 ? 50 : i) : 99; };
  const envs = [...new Set(list.map(e => e.env || ''))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const rows = {};
  list.forEach(e => ((rows[appOf(e)] ||= {})[e.env || ''] ||= []).push(e));
  const names = Object.keys(rows).sort((a, b) => LAST_GROUPS.has(a) - LAST_GROUPS.has(b) || a.localeCompare(b));
  const chip = e => `<span class="mchip" data-detail="${e.id}" title="${esc([e.name, e.host || e.url, e.username].filter(Boolean).join('\n'))}">${dot(e)} ${canDB(e) ? '🛢' : isConn(e) ? '🖥' : '🔗'} ${esc((e.host || linkLabel(e.url) || e.name || '').split('.')[0])}</span>`;
  const gaps = names.reduce((n, a) => n + envs.filter(v => v && !rows[a][v]).length, 0);
  return `<div class="group"><div class="group-head"><h3>Applications × environments</h3><span class="n">${names.length} apps</span>${gaps ? `<span class="muted tiny">· ${gaps} empty cells: an app with no server known in that environment</span>` : ''}</div>
    <div class="tblwrap"><table class="tbl appgrid"><thead><tr><th>Application</th>${envs.map(v => `<th>${v ? `<span class="badge ${esc(v)}">${esc(v)}</span>` : 'No environment'}</th>`).join('')}</tr></thead><tbody>
    ${names.map(a => `<tr><th${ruleStyle(a)}><span class="rlabel"${(c => c ? ` style="--lc:${c}"` : '')(ruleColor(a))}>${esc(a)}</span></th>${envs.map(v => `<td class="${rows[a][v] ? '' : 'gap'}">${(rows[a][v] || []).sort(byUsage).map(chip).join('') || (v ? '—' : '')}</td>`).join('')}</tr>`).join('')}
    </tbody></table></div></div>`;
}

// Saved searches: kept per workspace, listed in the sidebar with a count.
const Saved = {
  all() { return S.settings?.saved_searches || []; },
  async put(list) { await saveSettings({ saved_searches: list }); this.render(); },
  render() {
    const q = $('#search').value.trim().toLowerCase();
    $('#saveSearchBtn').hidden = !q || this.all().some(x => x.query.toLowerCase() === q);
    $('#savedSearches').innerHTML = this.all().length ? `<div class="saved-head nl">Saved searches</div>` + this.all().map((x, i) =>
      `<button data-saved="${i}" class="${x.query.toLowerCase() === q ? 'active' : ''}" title="${esc(x.query)}"><span class="ni sv">★</span><span class="nl">${esc(x.name)}</span><span class="count">${S.entries.filter(e => matches(e, x.query.toLowerCase()) && !(searchGuard(x.query) && guardedEnv(e))).length || ''}</span></button>`).join('') : '';
  },
  async save() {
    const q = $('#search').value.trim(); if (!q) return;
    const name = await askText('Name for this search (shown in the sidebar):', q.replace(/\b\w+:/g, '').trim() || q); if (!name?.trim()) return;
    await this.put([...this.all().filter(x => x.name !== name.trim()), { name: name.trim(), query: q }]);
    toast(`Saved “${name.trim()}” — it's in the sidebar`);
  },
  run(i) { const x = this.all()[i]; if (!x) return; show('dashboard'); $('#search').value = x.query; S.kbSel = 0; renderBoard(); },
};

// ---------- 📅 Today: recent connections, open threads, reminders due, my Jira ----------
const Today = {
  rem: [], remAt: 0,
  open: (() => { try { return localStorage.getItem('todayOpen') !== '0'; } catch { return true; } })(),
  async reminders() {
    if (Date.now() - this.remAt < 60000) return this.rem;
    this.remAt = Date.now();
    this.rem = await api('GET', '/api/work/reminders').catch(() => []) || [];
    return this.rem;
  },
  render(home) {
    const el = $('#today'); if (!el) return;
    if (!home) { el.innerHTML = ''; return; } // searching, filtering or the full list: results only
    const end = new Date(); end.setHours(23, 59, 59, 999);
    const byUse = (a, b) => new Date(b.last_used) - new Date(a.last_used);
    const recent = S.entries.filter(e => e.last_used && isConn(e)).sort(byUse).slice(0, 20);
    const links = S.entries.filter(e => e.url && !isConn(e) && e.last_used).sort(byUse).slice(0, 20);
    const threads = typeof Work === 'undefined' ? [] : Work.list.filter(w => w.status !== 'done' && !w.archived)
      .sort((a, b) => (b.unread > 0) - (a.unread > 0) || (b.starred - a.starred) || new Date(b.updated) - new Date(a.updated)).slice(0, 20);
    const due = this.rem.filter(r => r.post.remind_at && new Date(r.post.remind_at) <= end).sort((a, b) => new Date(a.post.remind_at) - new Date(b.post.remind_at)).slice(0, 20);
    const jira = typeof Jira === 'undefined' ? [] : Jira.issues.filter(j => !j.done).slice(0, 20);
    const pins = S.entries.filter(e => e.favorite).sort(byUsage).slice(0, 14);
    const snip = p => (p.text || (p.html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 70);
    const card = (icon, title, n, rows, empty, go) => `<div class="tcardx"><div class="tc-head">${icon} <b>${title}</b>${n ? `<span class="n">${n}</span>` : ''}<span class="spacer"></span>${go ? `<a href="#" data-tgo="${go}" class="tiny">All →</a>` : ''}</div><div class="tc-rows">${rows.join('') || `<div class="muted tiny tc-empty">${empty}</div>`}</div></div>`;
    const kind = e => canDB(e) ? '<span class="dbic-s">SQL</span>' : canSSH(e) ? '<span class="dbic-s">SSH</span>' : canFiles(e) ? '<span class="dbic-s">FTP</span>' : '';
    const host = u => { try { return new URL(u).host; } catch { return ''; } };
    const hints = [!threads.length && '<span>🧵 No open threads — <a href="#" data-tgo="tasks">start one</a></span>', !recent.length && '<span>🔌 Servers and databases you connect to show here</span>', !links.length && '<span>🔗 Links you open show here</span>'].filter(Boolean);
    el.innerHTML = `<div class="today-head">📅 <b>Today</b> <span class="muted tiny">${new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</span><span class="spacer"></span><span id="todayStats" class="today-stats"></span></div>${hints.length ? `<div class="today-hints">${hints.join('')}</div>` : ''}<div class="today-grid">
      ${!threads.length ? '' : card('🧵', 'Open threads', threads.filter(w => w.unread).length ? threads.filter(w => w.unread).length + ' new' : '', threads.map(w => `<div class="tc-row ${w.unread ? 'unread' : ''}" data-tthread="${w.id}"><span class="tc-t">${w.starred ? '★ ' : ''}${esc(w.title)}</span>${w.unread ? `<span class="tunread">${w.unread}</span>` : ''}<span class="muted tiny">${fmtTime(w.updated)}</span></div>`), 'No open threads.', 'tasks')}
      ${due.length ? card('⏰', 'Reminders due', due.length, due.map(r => { const late = new Date(r.post.remind_at) < new Date(); return `<div class="tc-row" data-trem="${r.thread}" data-tpost="${r.post.id}"><span class="tc-t">${esc(snip(r.post) || '(a message)')}</span><span class="muted tiny ${late ? 'late' : ''}">${late ? 'due ' : ''}${new Date(r.post.remind_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>`; }), '', '') : ''}
      ${jira.length ? card('◆', 'My Jira issues', jira.length, jira.map(j => `<div class="tc-row" data-tjira="${esc(j.key)}" title="${esc(j.summary || '')}"><b class="jkey">${esc(j.key)}</b><span class="tc-t">${esc(j.summary || '')}</span><span class="jstat">${esc(j.status || '')}</span></div>`), '', 'jira') : ''}
      ${!recent.length ? '' : card('🔌', 'Recent connections', '', recent.map(e => `<div class="tc-row" data-tconn="${e.id}" title="Connect · ${esc(e.host || e.url || '')}">${STATE_DOT[connState(e)]}${kind(e)}<span class="tc-t">${canDB(e) ? dbLabel(e) : esc(e.name || e.host)}</span>${e.env ? `<span class="badge ${esc(e.env)}">${esc(e.env)}</span>` : ''}<span class="muted tiny">${ago(e.last_used)}</span></div>`), 'Servers and databases you connect to show here.', 'terminal')}
      ${!links.length ? '' : card('🔗', 'Recent links', '', links.map(e => `<div class="tc-row" data-tlink="${e.id}" title="Open · ${esc(e.url)}">${dot(e)}<span class="tc-t">${esc(e.name || linkLabel(e.url) || host(e.url) || e.url)}</span><span class="muted tiny tc-host">${esc(host(e.url))}</span><span class="muted tiny">${ago(e.last_used)}</span></div>`), 'Links you open show here.', 'bookmarks')}
    </div>${pins.length ? `<div class="home-pins"><span class="muted tiny">★ Pinned</span>${pins.map(e => `<button class="pinchip" ${e.url && !isConn(e) ? `data-tlink="${e.id}"` : `data-tconn="${e.id}"`} title="${esc(e.url && !isConn(e) ? 'Open ' + e.url : 'Connect · ' + (e.host || ''))}">${dot(e)} ${esc(e.name || e.host || linkLabel(e.url) || e.url)}</button>`).join('')}</div>` : ''}`;
    this.reminders().then(r => { if (r !== this.lastRem) { this.lastRem = r; this.render(Home.on()); } });
  },
};
// The Dashboard's overview shows what you use; the full list of saved
// connections and links is one click away (and searching shows matches).
const Home = {
  all: (() => { try { return localStorage.getItem('boardAll') === '1'; } catch { return false; } })(),
  set(v) { this.all = v; try { localStorage.setItem('boardAll', v ? '1' : '0'); } catch { /* ignore */ } renderBoard(); $('#view-dashboard').scrollTop = 0; },
  filtering() { return !!($('#search').value.trim() || $('#fProject').value || $('#fEnv').value || $('#viewChips').children.length); },
  on() { return !this.all && !this.filtering(); },
};
$('#today').addEventListener('click', e => {
  const g = e.target.closest('[data-tgo]'); if (g) { e.preventDefault(); return show(g.dataset.tgo); }
  const c = e.target.closest('[data-tconn]'); if (c) return connectEntry(byId(c.dataset.tconn));
  const l = e.target.closest('[data-tlink]'); if (l) return openURL(byId(l.dataset.tlink));
  const t = e.target.closest('[data-tthread]'); if (t) return Work.open(t.dataset.tthread);
  const r = e.target.closest('[data-trem]'); if (r) return Work.open(r.dataset.trem, r.dataset.tpost);
  const j = e.target.closest('[data-tjira]');
  if (j) { show('jira'); Jira.sel = 'i:' + j.dataset.tjira; Jira.open.add('f:open'); Jira.open.delete('-f:open'); return Jira.render(); }
});

function renderBoard() {
  renderViewChips();
  const home = Home.on();
  $('#view-dashboard .viewwrap').hidden = home; // View (layout, grouping) is about the full list
  $('#view-dashboard').classList.toggle('home', home); // the overview stretches to fill the window
  Today.render(home);
  viewSummary();
  const list = filtered();
  renderStats(list, home);
  const board = $('#board');
  if (!S.entries.length) {
    board.innerHTML = `<div class="empty">Nothing collected yet.<br><br>Turn on <b>Watch clipboard</b> and copy text that contains hosts, URLs or logins,<br>or paste it on the <b>Captured</b> page.</div>`;
    return;
  }
  if (home) { // the overview: recent captures (folded) and the way to the full list
    board.innerHTML = RecentCaps.html() + `<div class="home-all"><button data-homeall="1">All connections and links (${list.length}) ▾</button><span class="muted tiny">or type in the search above to find one</span></div>`;
    S.kbList = []; Bulk.bar(); Saved.render(); return;
  }
  const back = Home.all && !Home.filtering() ? `<div class="home-all top"><button data-homeall="0">▴ Back to the overview</button><span class="muted tiny">All ${list.length} connections and links</span></div>` : '';
  const jira = jiraMatches($('#search').value), threads = threadMatches($('#search').value), more = Everything.count($('#search').value);
  const guarded = Object.entries(S.guarded || {});
  // the buttons first: the search tips under the box can cover the right-hand side
  const guardNote = guarded.length ? `<div class="fuzzy-note guard-note">🔒 ${guarded.map(([g, n]) => `<button data-guardenv="${g}">Show ${n} ${g}</button>`).join(' ')} <span>also match — UAT and PROD servers show in search only when picked at the top</span></div>` : '';
  if (!list.length && !jira.length && !threads.length && !more) { board.innerHTML = guardNote || '<div class="empty">No matches.</div>'; S.kbList = []; Bulk.bar(); Saved.render(); return; }
  const keyOf = {
    env: e => e.env || 'No environment', protocol: e => e.protocol || 'other', status: e => ({ ok: 'Working', fail: 'Failed' }[e.status] || 'Not tried'),
    host: e => e.host || e.url || e.name, none: () => 'All', project: e => e.project || 'General',
  }[S.groupBy] || (e => e.project || 'General');
  const groups = {};
  list.forEach(e => (groups[keyOf(e)] ||= []).push(e));
  S.kbList = list; S.kbSel = Math.min(S.kbSel || 0, list.length - 1);
  Saved.render();
  const fixNote = guardNote + (S.fixes ? `<div class="fuzzy-note">No exact match — showing ${Object.entries(S.fixes).map(([a, b]) => `<b>${esc(b)}</b> for “${esc(a)}”`).join(', ')}. <a href="#" data-usefix>Use this spelling</a></div>` : '');
  const inbox = list.filter(e => e.unsorted), sortable = inbox.filter(suggestPlace).length;
  const inboxNote = /\bis:(unsorted|new)\b/.test($('#search').value) && inbox.length ? `<div class="fuzzy-note">📥 ${inbox.length} new capture(s) to sort. ${sortable ? `<button class="primary" data-acceptall>✓ Move all ${sortable} to their suggested folders</button>` : ''} <button data-keepall>Keep all where they are</button></div>` : '';
  const rest = threadResultsHTML(threads) + Everything.html($('#search').value) + jiraResultsHTML(jira), recent = RecentCaps.html();
  if (S.layout === 'grid') { board.innerHTML = back + recent + fixNote + inboxNote + gridHTML(list) + rest; markKbSel(); Bulk.bar(); markSearchWords(board); return; }
  // Searching: the group holding the best match comes first (Object keys keep list order).
  board.innerHTML = back + recent + fixNote + inboxNote + (S.ranked ? Object.keys(groups) : Object.keys(groups).sort()).map(g => {
    const items = groups[g];
    const links = S.layout === 'table' ? [] : items.filter(isLinkOnly), conns = items.filter(e => !links.includes(e));
    const body = S.layout === 'table' ? tableHTML(items) : (conns.length ? cardsHTML(conns) : '') + (links.length ? linkRowsHTML(links) : '');
    return `<div class="group"><div class="group-head"><h3>${esc(g)}</h3><span class="n">${items.length}</span>
      ${S.groupBy === 'project' ? `<button class="icon ghost" data-act="rename-project" data-project="${esc(g)}" title="Rename project">✎</button>` : ''}</div>${body}</div>`;
  }).join('') + rest;
  markKbSel();
  Bulk.bar();
  markSearchWords(board);
}
// Searching: every matching word in the results in yellow (cards, notes, files,
// captures; thread cards mark their own). Not inside buttons, links' addresses or passwords.
function markSearchWords(board) {
  if (typeof markIn !== 'function') return;
  const words = parseQuery($('#search').value.trim().toLowerCase()).words.filter(w => !w.neg && w.v.length > 1).map(w => w.v);
  if (!words.length) return;
  for (const el of board.querySelectorAll('.card:not(.tresult), .tblwrap td, .rc-row')) markIn(el, words);
}
// The result Enter acts on (↑/↓ in the search box move it).
function markKbSel() {
  $$('#board .kbsel').forEach(x => x.classList.remove('kbsel'));
  const e = $('#search').value.trim() && S.kbList?.[S.kbSel];
  const el = e && $(`#board [data-detail="${e.id}"]`);
  if (el) { el.classList.add('kbsel'); return el; }
}

// Jira issues matching the main search (every word must appear somewhere:
// key, summary, status, assignee, pull requests or CM- items).
function jiraMatches(q) {
  const { words: ws, filters } = parseQuery(q.trim().toLowerCase()), words = ws.filter(w => !w.neg).map(w => w.v);
  if (!words.length || filters.length || typeof Jira === 'undefined') return []; // key:value filters are about connections
  return Jira.issues.filter(j => {
    const text = [j.key, j.summary, j.status, j.assignee, j.type, j.done ? 'completed done' : 'open',
      ...j.prs.map(p => `${p.name} ${p.repo} ${p.status}`), ...j.children.map(c => `${c.key} ${c.summary} ${c.status}`), ...(j.kids || []).map(c => `${c.key} ${c.summary} ${c.status}`)].join(' ').toLowerCase();
    return words.every(w => text.includes(w));
  });
}
// Task threads matching the main search: every word in the title or any post.
function threadMatches(q) {
  const { words: ws, filters } = parseQuery(q.trim().toLowerCase()), words = ws.filter(w => !w.neg).map(w => w.v);
  if (!words.length || filters.length || typeof Work === 'undefined') return [];
  return Work.list.filter(w => words.every(x => (w.title.toLowerCase() + ' ' + w.search).includes(x)));
}
// Search words highlighted in HTML that is already escaped (not inside tags).
function markWords(htmlText, words) {
  const ws = words.filter(w => w.length > 1).map(w => esc(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!ws.length) return htmlText;
  const re = new RegExp(`(${ws.join('|')})`, 'gi');
  return htmlText.split(/(<[^>]+>)/).map(part => part.startsWith('<') ? part : part.replace(re, '<mark>$1</mark>')).join('');
}
// 🧵 Tasks in the search: full width, with the messages that matched — who,
// when and a few lines around the match — each opening the thread right there.
function threadResultsHTML(list) {
  if (!list.length) return '';
  const words = parseQuery($('#search').value.trim().toLowerCase()).words.filter(w => !w.neg).map(w => w.v);
  const who = h => h.kind === 'capture' ? ['📋', 'Clipboard'] : h.kind === 'entry' ? ['🖥', 'Server'] : h.from === 'Outlook' || h.from === 'Email' ? ['✉', 'Email'] : h.from === 'Word' ? ['📄', 'Document'] : ['🧑', 'You'];
  const hitHTML = (w, h) => { const [ic, name] = who(h); return `<div class="thit" data-thread="${w.id}" data-tpost="${esc(h.post)}" title="Open the thread at this message">
      <div class="thit-who"><span>${ic}</span><b>${name}</b>${h.from && !['Outlook', 'Email', 'Word'].includes(h.from) ? `<span class="muted tiny">from ${esc(h.from)}</span>` : ''}${h.reply ? '<span class="muted tiny">reply</span>' : ''}<span class="muted tiny">${esc(fmtTime(h.at))}</span></div>
      <div class="thit-text">${markWords(maskedText(h.snip), words)}</div></div>`; };
  const fallback = w => { // before the server's answer: a few words from the thread
    const t = w.search.replace(/\s+/g, ' '), i = Math.max(0, ...words.map(x => t.indexOf(x)).filter(i => i >= 0).slice(0, 1));
    return (i > 80 ? '…' : '') + t.slice(Math.max(0, i - 80), i + 240) + '…';
  };
  return `<div class="group"><div class="group-head"><h3>🧵 Tasks</h3><span class="n">${list.length}</span></div><div class="tresults">${list.map(w => {
    const hits = Everything.thits?.[w.id];
    return `<div class="card tresult"><div class="card-head tres-head" data-thread="${w.id}" title="Open the thread">${threadStatusHTML(w)} <b>${markWords(esc(w.title), words)}</b><span class="spacer"></span><span class="muted tiny">${fmtTime(w.updated)} · ${w.posts || 0} messages</span></div>
      ${hits ? (hits.length ? hits.map(h => hitHTML(w, h)).join('') : '<div class="muted tiny">Found in the thread\'s name.</div>') : `<div class="thit-text muted">${markWords(maskedText(fallback(w)), words)}</div>`}</div>`;
  }).join('')}</div></div>`;
}

// The rest of "search everything": notes, Folders files, files in threads and captured text.
// Notes and files come from the server, so they arrive a moment later and the
// board is drawn again.
const Everything = {
  key: null, notes: [], files: [], tfiles: [], thits: null, timer: null,
  words(q) { const { words, filters } = parseQuery(q.trim().toLowerCase()); return filters.length ? [] : words.filter(w => !w.neg).map(w => w.v); },
  refresh(q) {
    const ws = this.words(q), key = ws.join(' ');
    if (key === this.key) return;
    this.key = key; clearTimeout(this.timer);
    this.notes = []; this.files = []; this.tfiles = []; this.thits = null;
    if (!ws.length) return;
    this.timer = setTimeout(async () => {
      const [notes, files, tfiles, thits] = await Promise.all([api('GET', '/api/notes').catch(() => []), api('GET', '/api/ref/search?full=1&q=' + encodeURIComponent(key)).catch(() => []),
        api('GET', '/api/work/files?q=' + encodeURIComponent(key)).catch(() => []), api('GET', '/api/work/search?q=' + encodeURIComponent(key)).catch(() => null)]);
      if (this.key !== key) return; // typed on meanwhile
      this.notes = (notes || []).filter(n => ws.every(w => `${n.title || ''} ${n.body || ''}`.toLowerCase().includes(w)));
      this.files = files || []; this.tfiles = tfiles || []; this.thits = thits;
      if ((this.notes.length || this.files.length || this.tfiles.length || Object.keys(thits || {}).length) && $('#view-dashboard').classList.contains('active')) renderBoard();
    }, 200);
  },
  clips(q) {
    const ws = this.words(q);
    return ws.length ? S.clips.filter(c => ws.every(w => (c.text || '').toLowerCase().includes(w))).slice(0, 12) : [];
  },
  count(q) { this.refresh(q); return this.notes.length + this.files.length + this.tfiles.length + this.clips(q).length; },
  // A few words around the first match, passwords dotted out.
  snip(text, ws) {
    const t = (text || '').replace(/\s+/g, ' '), low = t.toLowerCase(), i = Math.max(0, ...ws.map(w => low.indexOf(w)).filter(i => i >= 0).slice(0, 1));
    return (i > 50 ? '…' : '') + t.slice(Math.max(0, i - 50), i + 130) + (i + 130 < t.length ? '…' : '');
  },
  html(q) {
    const ws = this.words(q), clips = this.clips(q);
    const group = (icon, title, items) => items.length ? `<div class="group"><div class="group-head"><h3>${icon} ${title}</h3><span class="n">${items.length}</span></div><div class="cards">${items.join('')}</div></div>` : '';
    return group('📝', 'Notes', this.notes.map(n => `<div class="card tcard" data-gonote="${esc(n.id)}" title="Open the note"><div class="card-head"><b>${esc(n.title || 'Untitled')}</b><span class="spacer"></span><span class="muted tiny">${fmtTime(n.updated)}</span></div>
        <div class="muted tiny tsnip">${maskedText(this.snip(n.body, ws))}</div></div>`))
      + group('📁', 'Folders', this.files.map(f => `<div class="card tcard" data-goref="${esc(f.path)}" title="Show in Folders"><div class="card-head"><b>${esc(f.path.split('/').pop())}</b><span class="spacer"></span><span class="muted tiny">${esc(f.path.split('/').slice(0, -1).join(' / '))}</span></div>
        ${f.snip ? `<div class="muted tiny tsnip">${maskedText(f.snip)}</div>` : ''}</div>`))
      + group('📎', 'Files in threads', this.tfiles.map(f => `<div class="card tcard" data-thread="${esc(f.thread)}" data-tpost="${esc(f.post || '')}" title="Open the thread at this file"><div class="card-head"><b>${f.image ? '🖼' : '📄'} ${esc(f.name)}</b><span class="spacer"></span><a class="icon btnlike tiny" href="/api/props/files/${esc(f.id)}?download=1" data-fdl title="Download">⬇</a></div>
        <div class="muted tiny">🧵 ${esc(f.thread_title)}${f.archived ? ' (archived)' : ''} · ${fmtSize(f.size)} · ${esc(fmtTime(f.added))}</div>
        ${f.snip ? `<div class="muted tiny tsnip">${maskedText(f.snip)}</div>` : ''}</div>`))
      + group('📋', 'Captured text', clips.map(c => `<div class="card tcard" data-goclip="${esc(c.id)}" title="Show on the Captured page"><div class="card-head"><b>${esc(fmtTime(c.created))}</b>${c.from ? `<span class="muted tiny">from ${esc(c.from)}</span>` : ''}<span class="spacer"></span><span class="muted tiny">${(c.entry_ids || []).length} item(s)</span></div>
        <div class="muted tiny tsnip">${maskedText(this.snip(c.text, ws))}</div></div>`));
  },
};

// The last few captures on the dashboard, with what each one became — a
// paste that wasn't read as expected shows straight away and can be fixed.
const RecentCaps = {
  open: (() => { try { return localStorage.getItem('recentOpen') === '1'; } catch { return false; } })(), // folded unless you open it
  // Hosts saved without any type: offer the likely ones.
  untyped: e => !!e.host && !e.protocol && !dbKindOf(e) && !e.url,
  html() {
    if ($('#search').value.trim()) return '';
    const clips = S.clips.filter(c => Date.now() - new Date(c.created) < 7 * 864e5).slice(0, 5);
    if (!clips.length) return '';
    const kind = e => this.untyped(e) ? 'no type yet' : canDB(e) ? `SQL · ${dbKindOf(e)}` : canSSH(e) && e.protocol ? 'SSH' : canFiles(e) ? 'Files' : /^https?:/i.test(e.url || '') ? 'Link' : e.host ? 'Host (no type)' : 'Login';
    const rows = clips.map(c => {
      const es = (c.entry_ids || []).map(byId).filter(e => e && EnvSwitch.ok(e));
      if (EnvSwitch.v && !es.length) return ''; // nothing of this environment in it
      const first = (c.text || '').trim().split('\n')[0];
      const chips = es.slice(0, 3).map(e => `<span class="rc-item"><span class="chip" data-recent="${e.id}" title="${esc((e.host || e.url || e.username || '') + ' — ' + kind(e) + '. Show details')}">${dot(e)} ${esc(ruleName(e).replace(/<[^>]*>/g, '') || e.host || e.url || e.username)}</span>${this.untyped(e)
        ? `<select class="rc-type" data-settype-sel data-id="${e.id}" title="What kind of server is it?"><option value="">type?</option><option value="oracle">Oracle</option><option value="postgres">Postgres</option><option value="ssh">SSH</option></select>` : `<span class="muted tiny">${esc(kind(e))}</span>`}</span>`).join('')
        + (es.length > 3 ? `<span class="muted tiny rc-more" data-goclip="${esc(c.id)}" title="Show all on the Captured page">+${es.length - 3} more</span>` : '');
      return `<div class="rc-row"><span class="muted tiny rc-when">${esc(fmtTime(c.created))}</span><span class="rc-text" data-goclip="${esc(c.id)}" title="Show on the Captured page">${maskedText(first.length > 90 ? first.slice(0, 90) + '…' : first)}</span>
        <span class="rc-chips">${chips || '<span class="muted tiny">nothing recognised</span>'}</span></div>`;
    }).join('');
    return `<details class="recentcap" ${this.open ? 'open' : ''}><summary>🕘 Recently captured <span class="muted tiny">last 7 days</span><span class="spacer"></span><a href="#" data-allclips class="tiny">All captures →</a></summary>${rows}</details>`;
  },
};

function jiraResultsHTML(list) {
  if (!list.length) return '';
  const state = j => `<span class="jstat${j.done ? ' done' : ''}">${esc(j.status || '')}</span> <span class="muted tiny">${j.done ? '✅ Completed' : '📂 In progress'}</span>`;
  const body = S.layout === 'table'
    ? `<div class="tblwrap"><table class="tbl"><thead><tr><th>Key</th><th>Summary</th><th>Status</th><th>Pull requests</th><th>${esc(Jira.cfg?.child_prefix || 'CM-')} items</th></tr></thead><tbody>${list.map(j => `<tr data-jira="${esc(j.key)}" title="Show in Jira page">
        <td><a class="jkey" href="${esc(j.url)}" data-jlink="${esc(j.url)}" title="Open in Jira">${esc(j.key)}</a></td><td>${esc(j.summary || '')}</td><td>${state(j)}</td>
        <td>${j.prs.map(p => `${Jira.prBadge(p.status)} ${esc(p.name)}`).join('<br>')}</td><td>${j.children.map(c => `<b>${esc(c.key)}</b> ${esc(c.status)}`).join('<br>')}</td></tr>`).join('')}</tbody></table></div>`
    : `<div class="cards">${list.map(j => `<div class="card jcard" data-jira="${esc(j.key)}" title="Show in Jira page">
        <div class="card-head"><b class="host">◆ <a class="jkey" href="${esc(j.url)}" data-jlink="${esc(j.url)}" title="Open in Jira">${esc(j.key)}</a></b> ${state(j)}<span class="spacer"></span><button class="icon" data-jopen="${esc(j.url)}">Open in Jira ↗</button></div>
        <div class="jsum">${esc(j.summary || '')}</div>
        ${j.prs.length ? `<div class="muted tiny">⇄ ${j.prs.map(p => `${Jira.prBadge(p.status)} ${esc(p.name)}`).join(' · ')}</div>` : ''}
        ${j.children.length ? `<div class="muted tiny">☑ ${j.children.map(c => `<b>${esc(c.key)}</b> ${esc(c.status)}`).join(' · ')}</div>` : ''}</div>`).join('')}</div>`;
  return `<div class="group"><div class="group-head"><h3>◆ Jira</h3><span class="n">${list.length}</span></div>${body}</div>`;
}

// Bookmarks and other plain links: one tidy row each (name, address, env, Open, ⋯) instead of cards in columns.
const isLinkOnly = e => !!e.url && !/^jdbc:/i.test(e.url) && !isConn(e);
function linkRowsHTML(items) {
  const host = u => { try { const x = new URL(u); return x.host + (x.pathname !== '/' ? x.pathname : ''); } catch { return u; } };
  const sorted = S.view.sort || S.ranked ? items : [...items].sort((a, b) => (b.favorite - a.favorite) || usageScore(b) - usageScore(a) || (a.name || a.url).localeCompare(b.name || b.url));
  return '<div class="linkrows">' + sorted.map(e => `<div class="linkrow env-${esc(e.env || '')}" data-detail="${e.id}">
    <span class="star ${e.favorite ? 'on' : ''}" data-act="fav" data-id="${e.id}" title="Pin">${e.favorite ? '★' : '☆'}</span>
    <a class="lr-name" href="${esc(e.url)}" target="_blank" rel="noopener" data-open="${e.id}" title="Open ${esc(e.url)}">${esc(e.name || linkLabel(e.url) || host(e.url))}</a>
    ${linkLabel(e.url) ? `<span class="ulabel"${ruleStyle(e.url)}>${esc(linkLabel(e.url))}</span>` : ''}
    <span class="lr-url" title="${esc(e.url)}">${esc(host(e.url))}</span>
    ${e.env ? `<span class="badge ${esc(e.env)}">${esc(e.env)}</span>` : ''}${S.groupBy !== 'project' && e.project ? `<span class="tag">${esc(e.project)}</span>` : ''}
    <span class="lr-acts"><button class="icon" data-act="open" data-id="${e.id}">Open ↗</button><button class="icon more" data-act="more" data-id="${e.id}" title="More: copy, edit, move, delete…">⋯</button></span>
  </div>`).join('') + '</div>';
}

function cardsHTML(items) {
  const hosts = {};
  items.forEach(e => {
    const k = (e.host || e.url || e.name).toLowerCase();
    (hosts[k] ||= []).push(e);
  });
  const best = es => Math.max(...es.map(usageScore));
  const cards = S.view.sort || S.ranked ? Object.values(hosts) // already in the chosen (or best-match) order
    : Object.values(hosts).sort((a, b) => (b.some(e => e.favorite) - a.some(e => e.favorite)) || best(b) - best(a) || (a[0].host || a[0].name).localeCompare(b[0].host || b[0].name));
  return '<div class="cards">' + cards.map(es => {
    const h = es[0], env = es.find(e => e.env)?.env || '', fav = es.some(e => e.favorite);
    const title = h.host || h.name;
    return `<div class="card env-${esc(env)}">
      <div class="card-head">
        <span class="star ${fav ? 'on' : ''}" data-act="fav" data-id="${h.id}" title="Pin">${fav ? '★' : '☆'}</span>
        <span class="host copy" data-copy="${esc(title)}" title="Copy">${esc(title)}</span>
        ${env ? `<span class="badge ${esc(env)}">${esc(env)}</span>` : ''}
        <span class="spacer"></span>${S.groupBy !== 'project' ? `<span class="tag">${esc(h.project)}</span>` : ''}
      </div>
      ${whyMatched(es)}${es.map(svcHTML).join('')}
    </div>`;
  }).join('') + '</div>';
}

// Why a card matched when the words aren't in its host or name: "🔎 user: ops · database: ordsvc1".
function whyMatched(es) {
  const words = parseQuery($('#search').value.trim().toLowerCase()).words.filter(w => !w.neg && w.v.length > 1).map(w => w.v);
  if (!words.length) return '';
  const out = new Map();
  for (const w of words) {
    if (es.some(e => `${e.host || ''} ${e.name || ''} ${e.url || ''}`.toLowerCase().includes(w))) continue;
    for (const e of es) {
      const fields = [['user', e.username], ['project', e.project], ['env', e.env], ['app', ruleLabel(e.host) || ruleLabel(e.url)], ['tag', (e.tags || []).join(', ')],
        ...Object.entries(e.extra || {}).filter(([k]) => !/pass|secret|token/i.test(k) && k !== 'color'), ['notes', e.notes]];
      const f = fields.find(([, v]) => v && String(v).toLowerCase().includes(w));
      if (f) {
        let v = String(f[1]).replace(/\s+/g, ' ');
        if (v.length > 60) { const i = Math.max(0, v.toLowerCase().indexOf(w) - 20); v = (i ? '…' : '') + v.slice(i, i + 60) + '…'; }
        out.set(f[0] + ': ' + v, 1);
        break;
      }
    }
  }
  return out.size ? `<div class="muted tiny why" title="Why this matched your search">🔎 ${[...out.keys()].slice(0, 3).map(x => maskedText(x)).join(' · ')}</div>` : '';
}

function warnChip(e) {
  const p = problems(e);
  // a missing password alone is common (keys, SSO): shown quietly
  const failing = p.some(x => x[0] === 'failing'); // the last login failed: say so plainly
  return p.length ? `<button class="warnchip${failing ? ' fail' : p.length === 1 && p[0][0] === 'password' ? ' soft' : ''}" data-act="edit" data-id="${e.id}" title="${esc(p.map(x => '• ' + x[1]).join('\n'))}\nClick to fill in${p.some(x => x[0] === 'password') ? ' (or tick “Logs in with a key / SSO”)' : ''}">⚠ ${failing ? 'Needs attention' : p.length === 1 ? esc(p[0][1]) : p.length + ' to fix'}</button>` : '';
}

// The name on a card without the host (the card's title) or the user (its own
// row): "Batch – acme-bat-01…-ops" shows as "Batch", "host-ops" as nothing.
function cardName(e) {
  const n = e.name || '', h = (e.host || '').toLowerCase(), rl = ruleLabel(e.host || e.url);
  if (!h || !n.toLowerCase().includes(h)) return n === e.host ? '' : ruleName(e);
  return rl && n.startsWith(rl) ? ruleName({ ...e, name: rl }) : '';
}

function svcHTML(e) {
  const rows = [];
  const label = [dot(e), (e.protocol || dbKindOf(e)) && `<span class="proto">${esc(e.protocol || dbKindOf(e))}</span>`, e.port && `<span class="proto">:${e.port}</span>`, withCopyTag(cardName(e), e), warnChip(e),
    staleDays(e) && `<span class="stalechip" title="Not used, tested or captured for ${staleDays(e)} days — still right? Test it or delete it">💤 ${staleDays(e)} days</span>`].filter(Boolean).join(' ');
  if (label) rows.push(['', label]);
  if (e.unsorted) rows.push(['', unsortedRow(e)]);
  if (e.url) rows.push(['URL', `${linkLabel(e.url) ? `<span class="ulabel"${ruleStyle(e.url)}>${esc(linkLabel(e.url))}</span>` : ''}<a href="${esc(e.url)}" target="_blank" rel="noopener" data-open="${e.id}">${esc(e.url)}</a> <button class="icon" data-copy="${esc(e.url)}">copy</button>`]);
  const jdbc = !/^jdbc:/i.test(e.url || '') && jdbcURL(e);
  if (jdbc) rows.push(['JDBC', `<span class="copy" data-copy="${esc(jdbc)}" title="Copy">${esc(jdbc)}</span> <button class="icon" data-copy="${esc(jdbc)}">copy</button>`]);
  if (e.username) rows.push(['User', `<span class="copy" data-copy="${esc(e.username)}" title="Copy">${esc(e.username)}</span>`]);
  if (e.has_password) rows.push(['Password', pwHTML(e.password)]);
  if (e.key_file) rows.push(['Key', esc(e.key_file)]);
  if (e.last_dir) rows.push(['Last folder', `<span class="copy" data-copy="${esc(e.last_dir)}">${esc(e.last_dir)}</span>`]);
  Object.entries(e.extra || {}).filter(([k]) => k !== 'run_macros' && k !== 'color').forEach(([k, v]) => rows.push([esc(EXTRA_LABELS[k] || k) + (k === 'commands' ? (e.extra.run_macros === '1' ? ' ▶' : ' (off)') : ''), `<span class="copy" data-copy="${esc(v)}" style="white-space:pre-wrap">${esc(v)}</span>`]));
  if (e.tags?.length) rows.push(['Tags', `<span class="tag">${e.tags.map(esc).join(', ')}</span>`]);
  if (e.notes) rows.push(['Notes', `<span class="muted">${esc(e.notes)}</span>`]);
  // where it was captured from is in Details (click the card)
  const acts = [
    canSSH(e) && `<button class="icon" data-act="ssh" data-id="${e.id}">SSH</button>`,
    canFiles(e) && `<button class="icon" data-act="sftp" data-id="${e.id}">${isFTP(e) ? 'FTP' : 'SFTP'}</button>`,
    canDB(e) && `<button class="icon" data-act="sql" data-id="${e.id}">SQL</button>`,
    e.url && `<button class="icon" data-act="open" data-id="${e.id}">Open</button>`,
    External.items(e).length && `<button class="icon sec" data-act="ext" data-id="${e.id}" title="Open in the real PuTTY / SQL Developer / DBeaver">Open in ↗</button>`,
    `<button class="icon sec" data-act="details" data-id="${e.id}">Details</button>`,
    `<button class="icon sec" data-act="edit" data-id="${e.id}">Edit</button>`,
    `<button class="icon more" data-act="more" data-id="${e.id}" title="More: copy, duplicate, move, delete…">⋯</button>`,
  ].filter(Boolean).join('');
  return `<div class="svc" data-detail="${e.id}" title="Click for full details">${rows.map(([k, v]) => k ? `<span class="k">${k}</span><span class="v">${v}</span>` : `<div class="svc-line">${v}</div>`).join('')}<div class="svc-actions">${acts}</div></div>`;
}

// Recently captured: the "type?" menu on a host saved without a type.
$('#board').addEventListener('change', async ev => {
  const sel = ev.target.closest('[data-settype-sel]'); if (!sel?.value) return;
  const label = sel.selectedOptions[0].textContent;
  try { await api('POST', '/api/entries/bulk', { ids: [sel.dataset.id], op: 'type', value: sel.value }); toast(`Saved as ${label}` + (sel.value === 'ssh' ? '' : ' — it is now in SQL')); poll(); }
  catch (err) { toast(err.message, true); sel.value = ''; }
});

// Table columns: drag a header edge to resize (shared by every group's table).
const TABLE_COLS = [['Env', 95], ['Name', 170], ['Host', 190], ['Port', 64], ['Type', 80], ['URL', 280], ['User', 130], ['Password', 130], ['Captured', 170], ['', 110]];
function tableHTML(items) {
  const cell = [
    e => `${dot(e)} ${e.env ? `<span class="badge ${esc(e.env)}">${esc(e.env)}</span>` : ''} ${problems(e).length ? `<span class="warnchip" title="${esc(problems(e).map(x => x[1]).join('\n'))}">⚠</span>` : ''}`,
    e => ruleName(e),
    e => `<span class="copy" data-copy="${esc(e.host)}">${esc(e.host)}</span>`,
    e => e.port || '',
    e => esc(e.protocol),
    e => `${linkLabel(e.url) ? `<span class="ulabel"${ruleStyle(e.url)}>${esc(linkLabel(e.url))}</span> ` : ''}${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener" data-open="${e.id}">${esc(e.url)}</a>` : jdbcURL(e) ? `<span class="copy" data-copy="${esc(jdbcURL(e))}" title="Copy">${esc(jdbcURL(e))}</span>` : ''}`,
    e => `<span class="copy" data-copy="${esc(e.username)}">${esc(e.username)}</span>`,
    e => pwHTML(e.password),
    e => `<span class="muted tiny">${esc(captureText(e))}</span>`,
    e => `${canSSH(e) ? `<button class="icon" data-act="ssh" data-id="${e.id}">SSH</button> ` : ''}${canDB(e) ? `<button class="icon" data-act="sql" data-id="${e.id}">SQL</button> ` : ''}<button class="icon" data-act="edit" data-id="${e.id}">Edit</button>`,
  ];
  const hidden = S.view.hideCols.map(h => h.toLowerCase());
  const cols = TABLE_COLS.map((c, i) => i).filter(i => !hidden.includes((TABLE_COLS[i][0] || 'actions').toLowerCase()));
  const ids = items.map(e => e.id).join(','), all = items.every(e => Bulk.picked.has(e.id));
  return `<div class="tblwrap"><table class="tbl"><colgroup><col style="width:34px">${cols.map(i => `<col style="width:var(--c${i}, ${TABLE_COLS[i][1]}px)">`).join('')}</colgroup>
    <thead><tr><th><input type="checkbox" data-pickall="${ids}" ${all ? 'checked' : ''} title="Select all in this group"></th>${cols.map(i => `<th>${TABLE_COLS[i][0]}<span class="colgrip" data-col="${i}" title="Drag to resize · double-click to reset"></span></th>`).join('')}</tr></thead><tbody>` +
    items.map(e => `<tr data-detail="${e.id}" class="${Bulk.picked.has(e.id) ? 'picked' : ''}" title="Click for full details"><td><input type="checkbox" data-pick="${e.id}" ${Bulk.picked.has(e.id) ? 'checked' : ''}></td>${cols.map(i => `<td>${cell[i](e)}</td>`).join('')}</tr>`).join('') + '</tbody></table></div>';
}

$('#board').addEventListener('toggle', ev => {
  if (ev.target.classList?.contains('recentcap')) { RecentCaps.open = ev.target.open; try { localStorage.setItem('recentOpen', RecentCaps.open ? '1' : '0'); } catch { /* ignore */ } }
}, true);
$('#board').addEventListener('contextmenu', ev => {
  const d = ev.target.closest('[data-detail]'); if (!d || ev.target.closest('a, input')) return;
  ev.preventDefault();
  Tree.menu(ev, { dataset: { id: d.dataset.detail } }, 'board');
});
$('#board').addEventListener('click', async ev => {
  const jo = ev.target.closest('[data-jopen]'); if (jo) return openExternal(jo.dataset.jopen);
  if (ev.target.closest('[data-fdl]')) return; // download a thread file: the link does it
  const th = !ev.target.closest('[data-eye]') && ev.target.closest('[data-thread]'); if (th) return Work.open(th.dataset.thread, th.dataset.tpost || undefined);
  const gn = ev.target.closest('[data-gonote]'); if (gn) { show('notes'); return Notes.open('note:' + gn.dataset.gonote); }
  const gr = ev.target.closest('[data-goref]');
  if (gr) { const p = gr.dataset.goref; for (let x = Ref.parent(p); x; x = Ref.parent(x)) Ref.open.add(x); Ref.sel = p; Ref.persist(); return show('ref'); }
  const gc = ev.target.closest('[data-goclip]');
  if (gc) { show('inbox'); return setTimeout(() => { const el = $(`#clips [data-clip="${gc.dataset.goclip}"]`); if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1600); } }, 50); }
  if (ev.target.closest('[data-allclips]')) { ev.preventDefault(); return show('inbox'); }
  const ha = ev.target.closest('[data-homeall]'); if (ha) return Home.set(ha.dataset.homeall === '1');
  const ge = ev.target.closest('[data-guardenv]'); if (ge) return EnvSwitch.set(ge.dataset.guardenv);
  const st = ev.target.closest('[data-settype]');
  if (st) {
    try { await api('POST', '/api/entries/bulk', { ids: [st.dataset.id], op: 'type', value: st.dataset.settype }); toast(`Saved as ${st.textContent}` + (st.dataset.settype === 'ssh' ? '' : ' — it is now in SQL')); poll(); }
    catch (err) { toast(err.message, true); }
    return;
  }
  const rc = ev.target.closest('[data-recent]'); if (rc) return showDetails(byId(rc.dataset.recent));
  const jr = ev.target.closest('[data-jira]');
  if (jr) { show('jira'); Jira.sel = 'i:' + jr.dataset.jira; const j = Jira.issues.find(x => x.key === jr.dataset.jira); Jira.open.add(j?.done ? 'f:done' : 'f:open'); Jira.open.delete('-f:open'); return Jira.render(); }
  const c = ev.target.closest('[data-copy]');
  if (c) return copyText(c.dataset.copy);
  const b = ev.target.closest('[data-act]');
  if (!b) {
    const d = !ev.target.closest('a, button, input') && ev.target.closest('[data-detail]');
    return d && showDetails(byId(d.dataset.detail));
  }
  const e = byId(b.dataset.id);
  try {
    switch (b.dataset.act) {
      case 'details': return showDetails(e);
      case 'ext': { const r = b.getBoundingClientRect(); return setTimeout(() => Tree.showMenu({ clientX: r.left, clientY: r.bottom }, [...External.items(e), '-', ['Program locations…', () => External.settings()]])); }
      case 'ssh': return Term.open(e);
      case 'sftp': return Remote.connect(e);
      case 'sql': return SQL.open(e);
      case 'open': return openURL(e);
      case 'edit': return openEntryDialog(e);
      case 'accept': case 'keep': await sortEntry(e, b.dataset.act === 'accept'); return poll();
      case 'trytest': { // a new capture: no longer new, then one login with its saved details
        b.disabled = true; b.textContent = '🔌 Testing…';
        await sortEntry(e, false);
        const r = await api('POST', '/api/test', entryInput(e)).catch(err => ({ ok: false, message: err.message }));
        await poll();
        return toast(r.ok ? `✓ Connected: ${r.message}` : `Couldn't connect — ${r.message}. ⚠ Needs attention on the card opens it to fix.`, !r.ok);
      }
      case 'del': return deleteEntries([e]);
      case 'more': { const r = b.getBoundingClientRect(); return setTimeout(() => Tree.menu({ clientX: r.left, clientY: r.bottom }, { dataset: { id: e.id } }, 'board')); }
      case 'fav': await api('POST', '/api/entries', { ...entryInput(e), favorite: !e.favorite }); return poll();
      case 'rename-project': {
        const to = await askText('Rename project', b.dataset.project);
        if (to && to !== b.dataset.project) { await api('POST', '/api/projects/rename', { from: b.dataset.project, to }); poll(); }
      }
    }
  } catch (err) { toast(err.message, true); }
});

// "Open in…" the real PuTTY / DBeaver / SQL Developer (paths: ↗ Programs…).
const External = {
  // Menu items for an entry: [label, fn]; databases offer SQL Developer first for Oracle, DBeaver for PostgreSQL.
  items(e) {
    const out = [];
    if (canSSH(e)) out.push(['Open in PuTTY (the real one) ↗', () => this.open(e, 'putty')]);
    if (canFiles(e)) out.push(['Open in FileZilla (the real one) ↗', () => this.open(e, 'filezilla')]);
    if (canDB(e)) {
      const sd = ['Open in SQL Developer ↗', () => this.open(e, 'sqldev')], db = ['Open in DBeaver ↗', () => this.open(e, 'dbeaver')];
      out.push(...(dbKindOf(e) === 'oracle' ? [sd, db] : [db]));
    }
    return out;
  },
  async open(e, tool) {
    if (tool === 'sqldev' && e.password) await copyText(e.password, 'Password copied');
    try {
      const r = await api('POST', '/api/external/open', { id: e.id, tool });
      if (tool === 'sqldev') {
        const svc = dbService(e);
        toast(`SQL Developer opening. ${r.note} Host ${e.host} · port ${e.port || 1521} · ${svc?.sid ? 'SID' : 'service'} ${svc?.name || '?'} · user ${e.username || '?'}`);
      } else toast(`${r.program} opening… ${r.note || ''}`);
    } catch (err) {
      toast(err.message, true);
      if (/wasn't found/.test(err.message)) this.settings();
    }
  },
  async settings() {
    const list = await api('GET', '/api/external');
    $('#extRows').innerHTML = list.map(t => `<label>${esc(t.name)} (${esc(t.exe)})
      <input data-ext="${t.key}" value="${esc(t.set || '')}" placeholder="${esc(t.found ? 'Found: ' + t.found : 'Not found — paste the full path to ' + t.exe)}">
      <span class="found muted">${t.found ? '✓ Using ' + esc(t.found) : '✗ Not found on this PC'}</span></label>`).join('');
    $('#extDlg').showModal();
  },
};
$('#extBtn').onclick = () => External.settings();
$('#showPwBtn').onclick = () => { S.showPw = !S.showPw; $('#showPwBtn').textContent = S.showPw ? '🙈 Hide passwords' : '👁 Show passwords'; renderBoard(); renderClips(); Groups.render?.(); };
$('#entryPwEye').onclick = () => { const i = $('#entryForm').password; i.type = i.type === 'password' ? 'text' : 'password'; $('#entryPwEye').classList.toggle('on', i.type === 'text'); };
$('#extCancel').onclick = () => $('#extDlg').close();
$('#extSave').onclick = async () => {
  const body = {}; $$('#extRows [data-ext]').forEach(i => (body[i.dataset.ext] = i.value));
  try { await api('POST', '/api/external/paths', body); $('#extDlg').close(); toast('Program locations saved'); }
  catch (err) { toast(err.message, true); }
};

// Where details came from, in words.
const SOURCE_NAMES = { clipboard: 'Copied (clipboard)', paste: 'Pasted into WorkHub', outlook: 'Outlook email', chrome: 'Chrome bookmark', edge: 'Edge bookmark',
  bookmark: 'Browser bookmark', screenshot: 'Screenshot', manual: 'Added by hand', note: 'From a note', import: 'Imported' };
const sourceName = c => (SOURCE_NAMES[c.source] || c.source || 'Unknown') + (c.detail ? ` (${c.detail})` : '');
// The latest capture, or for older entries what we know: bookmark source or when it was added.
const lastCapture = e => e.captures?.at(-1) || (e.created ? { at: e.created, source: e.source || '' } : null);
const shortWhen = t => new Date(t).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const captureText = e => (c => c ? `${shortWhen(c.at)} · ${c.source ? sourceName(c) : 'source not recorded'}` : '')(lastCapture(e));

const COPY_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>';
// Full details of one connection in a pop-up: every field with its own Copy button.
// Every detail of an entry as [label, value] rows (details pop-up, Copy all).
const EXTRA_LABELS = { commands: 'Commands after connecting', run_macros: 'Run macros', auth: 'Login' };
function detailRows(e) {
  const svc = dbService(e), when = t => t ? new Date(t).toLocaleString() : '';
  const rows = [
    ['Name', e.name], ['Host', e.host], ['Port', e.port || ''], ['Type', e.protocol || dbKindOf(e)],
    ['Environment', e.env], ['Project', e.project], ['Naming rule', ruleLabel(e.host || e.url)],
    ['URL', e.url], ['JDBC', /^jdbc:/i.test(e.url || '') ? '' : jdbcURL(e)],
    [svc?.sid ? 'SID' : dbKindOf(e) === 'postgres' ? 'Database' : 'Service name', svc?.name],
    ['Username', e.username], ['Password', e.password], [e.status === 'ok' ? 'Other passwords' : 'Previous passwords', (e.prev_passwords || []).join('\n')],
    ['Key file', e.key_file], ['Last folder', e.last_dir],
    ...Object.entries(e.extra || {}).filter(([k]) => !DB_KEYS.includes(k) && k !== 'color').map(([k, v]) => EXTRA_LABELS[k] ? [EXTRA_LABELS[k], k === 'run_macros' ? 'yes' : k === 'auth' ? 'key / SSO (no password needed)' : v] : [k, v]),
    ['Tags', (e.tags || []).join(', ')], ['Notes', e.notes],
    ['Last used', when(e.last_used)],
    ...(e.captures?.length ? e.captures.slice().reverse().map((c, i) => [i ? 'Also captured' : 'Captured', `${when(c.at)} · ${sourceName(c)}`]) : [['Captured', captureText(e)]]),
    ['Status', e.status ? `${e.status === 'ok' ? 'Worked' : 'Failed'} · ${when(e.status_at)}${e.status_msg ? '\n' + e.status_msg : ''}` : ''],
  ].filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '');
  return rows;
}
// What gets pasted into other tools: [label, text shown, text copied].
function readyStrings(e) {
  const out = [], u = e.username || '', pw = e.password || '';
  if (canDB(e)) {
    const kind = dbKindOf(e), svc = dbService(e), port = e.port || (kind === 'oracle' ? 1521 : 5432), name = svc?.name || '';
    out.push(['JDBC', jdbcURL(e), jdbcURL(e)]);
    if (kind === 'oracle') {
      const ez = svc?.sid ? `${e.host}:${port}:${name}` : `${e.host}:${port}/${name}`;
      out.push(['Host:port/service', ez, ez]);
      if (u && !svc?.sid) { const at = `@//${e.host}:${port}/${name}`; out.push(['sqlplus', `sqlplus ${u}${pw ? '/' + PW_MASK : ''}${at}`, `sqlplus ${u}${pw ? '/' + pw : ''}${at}`]); }
    } else {
      const t = `psql "host=${e.host} port=${port} dbname=${name || 'postgres'}${u ? ' user=' + u : ''}"`;
      out.push(['psql', t, t]);
    }
  } else if (canSSH(e) && e.host) {
    const p = e.port && e.port !== 22 ? e.port : 0, at = (u ? u + '@' : '') + e.host;
    out.push(['ssh', `ssh ${p ? '-p ' + p + ' ' : ''}${at}`, `ssh ${p ? '-p ' + p + ' ' : ''}${at}`]);
    out.push(['sftp', `sftp ${p ? '-P ' + p + ' ' : ''}${at}`, `sftp ${p ? '-P ' + p + ' ' : ''}${at}`]);
  }
  return out.filter(([, , c]) => c);
}
const detailsText = e => detailRows(e).map(([k, v]) => `${k}: ${v}`).join('\n');

function showDetails(e) {
  if (!e) return;
  const rows = detailRows(e);
  showDetails.text = detailsText(e);
  $('#detailTitle').innerHTML = `${ruleName(e)} ${e.env ? `<span class="badge ${esc(e.env)}">${esc(e.env)}</span>` : ''}`;
  const secret = k => /password/i.test(k);
  $('#detailBody').innerHTML = rows.map(([k, v]) => `<span class="k">${esc(k)}</span>${secret(k) ? `<span class="v pwbox"><span class="pwv" data-pw="${esc(v)}">${S.showPw ? esc(v) : PW_MASK}</span><button class="icon eye" data-eye title="Show / hide">👁</button></span>` : `<span class="v">${esc(v)}</span>`}<button class="icon copyic" data-copy="${esc(v)}" title="Copy ${esc(k)}" aria-label="Copy ${esc(k)}">${COPY_ICON}</button>`).join('');
  const ready = readyStrings(e);
  if (ready.length) $('#detailBody').insertAdjacentHTML('afterbegin', `<div class="ready"><div class="ready-h">Copy-ready</div>${ready.map(([k, v, c]) =>
    `<span class="k">${esc(k)}</span><code class="v mono">${esc(S.showPw ? c : v)}</code><button class="icon copyic" data-copy="${esc(c)}" title="Copy ${esc(k)}" aria-label="Copy ${esc(k)}">${COPY_ICON}</button>`).join('')}</div>`);
  const clips = S.clips.filter(c => c.entry_ids?.includes(e.id)).slice(0, 3);
  if (clips.length) $('#detailBody').insertAdjacentHTML('beforeend', `<details class="clipsrc"><summary>Captured from — the text it was read from (${clips.length})</summary>${clips.map(c =>
    `<div class="muted tiny">${esc(new Date(c.created).toLocaleString())} · ${esc(sourceName({ source: c.source }))}</div><pre>${maskedText(c.text.length > 1500 ? c.text.slice(0, 1500) + '…' : c.text)}</pre>`).join('')}</details>`);
  $('#detailActs').innerHTML = [
    canSSH(e) && ['ssh', 'SSH'], canFiles(e) && ['sftp', isFTP(e) ? 'FTP' : 'SFTP'], canDB(e) && ['sql', 'SQL'], e.url && !/^jdbc:/i.test(e.url) && ['open', 'Open'], ['edit', 'Edit'],
  ].filter(Boolean).map(([a, t]) => `<button data-dact="${a}">${t}</button>`).join('') + External.items(e).map(([t], i) => `<button data-dext="${i}">${esc(t.replace('Open in ', '').replace(' (the real one)', ''))}</button>`).join('');
  showDetails.entry = e;
  $('#detailDlg').showModal();
}
$('#detailDlg').addEventListener('click', ev => {
  const c = ev.target.closest('[data-copy]'); if (c) return copyText(c.dataset.copy);
  const x = ev.target.closest('[data-dext]');
  if (x) { $('#detailDlg').close(); return External.items(showDetails.entry)[x.dataset.dext][1](); }
  const a = ev.target.closest('[data-dact]'); if (!a) return;
  const e = showDetails.entry;
  $('#detailDlg').close();
  ({ ssh: () => Term.open(e), sftp: () => Remote.connect(e), sql: () => SQL.open(e), open: () => openURL(e), edit: () => openEntryDialog(e) })[a.dataset.dact]();
});
$('#detailCopyAll').onclick = () => copyText(showDetails.text);
$('#detailClose').onclick = () => $('#detailDlg').close();

['#search', '#fProject', '#fEnv'].forEach(s => $(s).addEventListener('input', () => {
  if (s === '#search' && !$('#view-dashboard').classList.contains('active')) show('dashboard'); // results are on the dashboard
  S.kbSel = 0; renderBoard();
}));
$('#stats').addEventListener('click', ev => {
  const b = ev.target.closest('[data-find]');
  if (b) { ev.preventDefault(); $('#search').value = b.dataset.find; S.kbSel = 0; renderBoard(); }
  if (ev.target.closest('[data-view-go]')) show(ev.target.closest('[data-view-go]').dataset.viewGo);
});
// Connect or open: SSH terminal, SQL, FTP, the link — or the details.
function connectEntry(e) {
  if (canSSH(e)) return Term.open(e);
  if (canDB(e)) return SQL.open(e);
  if (canFiles(e)) return Remote.connect(e);
  if (e.url) return openURL(e);
  showDetails(e);
}

// Keyboard: ↑/↓ choose a result, Enter connects or opens it, Shift+Enter shows
// its details, Alt+P / U / H / J copy password, user, host, JDBC or URL.
$('#search').addEventListener('keydown', ev => {
  const list = S.kbList || [];
  if (!$('#search').value.trim() || !list.length) return;
  const e = list[S.kbSel] || list[0];
  const key = ev.key.toLowerCase();
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    S.kbSel = Math.max(0, Math.min(list.length - 1, (S.kbSel || 0) + (ev.key === 'ArrowDown' ? 1 : -1)));
    markKbSel()?.scrollIntoView({ block: 'nearest' });
  } else if (ev.key === 'Enter') {
    ev.preventDefault();
    if (ev.shiftKey) return showDetails(e);
    connectEntry(e);
  } else if (ev.altKey && !ev.ctrlKey && 'puhj'.includes(key) && key) {
    ev.preventDefault();
    const v = { p: e.password, u: e.username, h: e.host || e.url, j: jdbcURL(e) || e.url }[key];
    const what = { p: 'Password', u: 'Username', h: 'Host', j: jdbcURL(e) ? 'JDBC URL' : 'URL' }[key];
    if (!v) return toast(`${ruleName(e).replace(/<[^>]+>/g, '')}: no ${what.toLowerCase()} saved`, true);
    copyText(v, `${what} copied — ${e.name || e.host}`);
  }
});
// Recent searches: kept when a search found something and was used (Enter)
// or left for a couple of seconds; shown as chips when the box is empty.
const Recent = {
  list() { try { return JSON.parse(localStorage.getItem('recentSearches') || '[]'); } catch { return []; } },
  add(q) {
    q = q.trim(); if (!q || q.length < 2) return;
    const l = [q, ...this.list().filter(x => x.toLowerCase() !== q.toLowerCase())].slice(0, 8);
    try { localStorage.setItem('recentSearches', JSON.stringify(l)); } catch { /* ignore */ }
  },
  render() {
    const l = this.list(), el = $('#recentSearches');
    el.hidden = !l.length || !!$('#search').value.trim();
    el.innerHTML = 'Recent: ' + l.map(q => `<button class="rchip" data-recent="${esc(q)}">${esc(q)}</button>`).join('') + ' <a href="#" data-recentclear>clear</a>';
  },
};
let recentTimer;
$('#search').addEventListener('input', () => { clearTimeout(recentTimer); Recent.render(); recentTimer = setTimeout(() => S.kbList?.length && Recent.add($('#search').value), 2500); });
$('#search').addEventListener('keydown', ev => { if (ev.key === 'Enter' && S.kbList?.length) Recent.add($('#search').value); }, true);
$('#searchHint').addEventListener('mousedown', ev => { // mousedown: before the box loses focus
  const c = ev.target.closest('[data-recent]');
  if (c) { ev.preventDefault(); $('#search').value = c.dataset.recent; S.kbSel = 0; renderBoard(); Recent.render(); return; }
  if (ev.target.closest('[data-recentclear]')) { ev.preventDefault(); try { localStorage.removeItem('recentSearches'); } catch { /* ignore */ } Recent.render(); }
});
$('#board').addEventListener('click', ev => {
  if (!ev.target.closest('[data-usefix]')) return;
  ev.preventDefault();
  $('#search').value = $('#search').value.split(/\s+/).map(w => S.fixes?.[w.toLowerCase()] || w).join(' ');
  renderBoard();
}, true);
$('#board').addEventListener('click', async ev => {
  const all = ev.target.closest('[data-acceptall], [data-keepall]'); if (!all) return;
  const accept = 'acceptall' in all.dataset, list = S.kbList.filter(e => e.unsorted && (!accept || suggestPlace(e)));
  let n = 0; for (const e of list) { try { await sortEntry(e, accept); n++; } catch (err) { toast(err.message, true); } }
  toast(accept ? `Moved ${n} to their suggested folders` : `Kept ${n} where they are`); poll();
});
$('#saveSearchBtn').onclick = () => Saved.save();
$('#savedSearches').addEventListener('click', ev => { const b = ev.target.closest('[data-saved]'); if (b) Saved.run(+b.dataset.saved); });
$('#savedSearches').addEventListener('contextmenu', ev => {
  const b = ev.target.closest('[data-saved]'); if (!b) return;
  ev.preventDefault();
  const i = +b.dataset.saved, list = Saved.all(), x = list[i];
  Tree.showMenu(ev, [
    ['Rename…', async () => { const n = await askText('Name:', x.name); if (n?.trim()) Saved.put(list.map((y, j) => j === i ? { ...y, name: n.trim() } : y)); }],
    ['Change the search…', async () => { const q = await askText('Search (words and filters like env:prod app:batch):', x.query); if (q?.trim()) Saved.put(list.map((y, j) => j === i ? { ...y, query: q.trim() } : y)); }],
    ['Delete', () => Saved.put(list.filter((_, j) => j !== i))]]);
});
// Desktop version: Ctrl+Alt+W anywhere in Windows brings WorkHub up with the search box ready.
window.whHotkey = () => { show('dashboard'); $('#search').focus(); $('#search').select(); Recent.render(); };

// Table view: tick rows, then change them all at once.
const Bulk = {
  picked: new Set(),
  entries() { return [...this.picked].map(byId).filter(Boolean); },
  bar() {
    for (const id of this.picked) if (!byId(id)) this.picked.delete(id);
    const n = this.picked.size, el = $('#bulkBar');
    el.hidden = !n;
    if (n) $('#bulkCount').textContent = `${n} selected`;
  },
  async each(what, fn) {
    const list = this.entries(); let ok = 0;
    for (const e of list) { try { await fn(e); ok++; } catch (err) { toast(`${e.name}: ${err.message}`, true); } }
    toast(`${what}: ${ok} of ${list.length}`); poll();
  },
  save(e, change) { return api('POST', '/api/entries', { ...entryInput(e), password: e.password, ...change }); },
};
$('#bulkBar').addEventListener('click', async ev => {
  const b = ev.target.closest('[data-bulk]'); if (!b) return;
  switch (b.dataset.bulk) {
    case 'toworkspace': return Workspaces.copyEntries(Bulk.entries());
    case 'move': { const p = await askText('Move to folder (use / for subfolders):', Bulk.entries()[0]?.project || ''); if (p?.trim()) await Bulk.each('Moved', e => Bulk.save(e, { project: p.trim() })); break; }
    case 'tag': { const t = await askText('Add tag(s), comma separated:'); const add = (t || '').split(',').map(x => x.trim()).filter(Boolean); if (add.length) await Bulk.each('Tagged', e => Bulk.save(e, { tags: [...new Set([...(e.tags || []), ...add])] })); break; }
    case 'test': return retest(Bulk.entries());
    case 'key': return Bulk.each('Marked as key login', e => Bulk.save(e, { extra: { ...(e.extra || {}), auth: 'key' } }));
    case 'delete': { const list = Bulk.entries(); if (list.length < 10 || await askYes(`Delete ${list.length} entries?`)) { Bulk.picked.clear(); await deleteEntries(list); } break; }
    case 'clear': Bulk.picked.clear(); renderBoard(); break;
  }
});
$('#bulkEnv').addEventListener('change', async ev => {
  const v = ev.target.value; ev.target.value = '';
  if (v) await Bulk.each('Environment set', e => Bulk.save(e, { env: v === '-' ? '' : v }));
});
$('#board').addEventListener('change', ev => {
  const one = ev.target.closest('[data-pick]'), all = ev.target.closest('[data-pickall]');
  if (one) one.checked ? Bulk.picked.add(one.dataset.pick) : Bulk.picked.delete(one.dataset.pick);
  if (all) all.dataset.pickall.split(',').forEach(id => all.checked ? Bulk.picked.add(id) : Bulk.picked.delete(id));
  if (one || all) renderBoard();
});

// Re-test: tries each connection with its saved login (4 at a time) and updates ✓ / ✗.
// 🔑 Change a password everywhere: a user's new password on every connection
// that logs in as that user (ticked ones only), optionally re-tested.
const PwAll = {
  conns(user) { return S.entries.filter(e => isConn(e) && !e.hidden && (e.username || '').toLowerCase() === user.trim().toLowerCase()); },
  open(user = '') {
    const counts = {};
    for (const e of S.entries) if (isConn(e) && e.username) counts[e.username] = (counts[e.username] || 0) + 1;
    $('#pwAllUsers').innerHTML = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([u, n]) => `<option value="${esc(u)}">${n} connection${n > 1 ? 's' : ''}</option>`).join('');
    $('#pwAllUser').value = user; $('#pwAllPw').value = ''; $('#pwAllPw').type = 'password';
    this.list();
    $('#pwAllDlg').showModal();
    (user ? $('#pwAllPw') : $('#pwAllUser')).focus();
  },
  list() {
    const list = this.conns($('#pwAllUser').value).sort((a, b) => (ENV_RANK[a.env] ?? 9) - (ENV_RANK[b.env] ?? 9) || a.host.localeCompare(b.host));
    $('#pwAllList').innerHTML = list.map(e => `<label class="pwall-row"><input type="checkbox" value="${e.id}" checked>${dot(e)} ${e.env ? `<span class="badge ${esc(e.env)}">${esc(e.env)}</span>` : ''}<span class="mono">${esc(e.username)}@${esc(e.host)}${e.port && e.port !== 22 ? ':' + e.port : ''}</span><span class="muted tiny">${esc(e.protocol || dbKindOf(e) || '')} · ${esc(e.project)}</span></label>`).join('')
      || `<div class="muted tiny" style="padding:8px">${$('#pwAllUser').value.trim() ? 'No connections log in as this user.' : 'Type or pick a user.'}</div>`;
    this.count();
  },
  picked() { return $$('#pwAllList input:checked').map(c => c.value); },
  count() { const n = this.picked().length; $('#pwAllN').textContent = n ? `${n} connection${n > 1 ? 's' : ''} will get the new password` : ''; $('#pwAllSave').disabled = !n; },
  async save() {
    const ids = this.picked(), pw = $('#pwAllPw').value;
    if (!pw) { $('#pwAllPw').focus(); return toast('Type the new password', true); }
    try {
      const r = await api('POST', '/api/entries/bulk', { ids, op: 'password', value: pw });
      $('#pwAllDlg').close();
      await poll();
      toast(`🔑 New password set on ${r.changed} connection${r.changed === 1 ? '' : 's'}${r.changed < ids.length ? ` (${ids.length - r.changed} already had it)` : ''}`);
      if ($('#pwAllTest').checked) retest(ids.map(byId).filter(Boolean));
    } catch (err) { toast(err.message, true); }
  },
};
$('#pwAllUser').addEventListener('input', () => PwAll.list());
$('#pwAllList').addEventListener('change', () => PwAll.count());
$('#pwAllAll').onclick = () => { $$('#pwAllList input').forEach(c => { c.checked = true; }); PwAll.count(); };
$('#pwAllNone').onclick = () => { $$('#pwAllList input').forEach(c => { c.checked = false; }); PwAll.count(); };
$('#pwAllShow').onclick = () => { $('#pwAllPw').type = $('#pwAllPw').type === 'password' ? 'text' : 'password'; };
$('#pwAllCancel').onclick = () => $('#pwAllDlg').close();
$('#pwAllSave').onclick = () => PwAll.save();
$('#pwAllPw').addEventListener('keydown', ev => { if (ev.key === 'Enter') PwAll.save(); });

async function retest(list) {
  list = list.filter(isConn).filter(e => !S.sshOff || !canSSH(e) || canDB(e) || isFTP(e)); // SSH switched off: not tried
  if (!list.length) return toast('No connections to test here', true);
  if (list.length > 10 && !await askYes(`Test ${list.length} connections now? Each one logs in once with its saved details.`)) return;
  let done = 0, ok = 0; const queue = [...list];
  const work = async () => { for (let e; (e = queue.shift());) {
    try { const r = await api('POST', '/api/test', entryInput(e)); if (r.ok) ok++; } catch { /* counted as failed */ }
    toast(`Testing… ${++done} of ${list.length}`);
  } };
  await Promise.all([work(), work(), work(), work()]);
  await poll();
  toast(`Re-tested ${list.length}: ${ok} worked, ${list.length - ok} failed${list.length - ok ? ' — search is:fail to see them' : ''}`, list.length - ok > 0);
}
$('#stats').addEventListener('click', ev => { if (ev.target.closest('#retestBtn')) retest(filtered()); });

$('#search').addEventListener('focus', () => { $('#searchHint').hidden = false; Recent.render(); });
$('#search').addEventListener('blur', () => setTimeout(() => ($('#searchHint').hidden = !$('#search').value.trim()), 150));
// View ▾: filters, grouping, layout, card size and passwords in one panel.
function viewSummary() {
  const parts = [{ cards: 'Cards', table: 'Table', grid: 'Grid' }[S.layout] || 'Cards'];
  if (S.layout !== 'grid') parts.push('by ' + ({ project: 'project', env: 'env', protocol: 'type' }[S.groupBy] || S.groupBy));
  if ($('#fProject').value) parts.push($('#fProject').value);
  if ($('#fEnv').value) parts.push($('#fEnv').value);
  if (S.showPw) parts.push('passwords shown');
  $('#viewSummary').textContent = parts.join(' · ');
  $('#viewBtn').classList.toggle('on', !!($('#fProject').value || $('#fEnv').value));
}
$('#viewBtn').onclick = ev => { ev.stopPropagation(); $('#viewPanel').hidden = !$('#viewPanel').hidden; };
document.addEventListener('click', ev => { if (!$('#viewPanel').hidden && !ev.target.closest('.viewwrap')) $('#viewPanel').hidden = true; });
document.addEventListener('keydown', ev => { if (ev.key === 'Escape') $('#viewPanel').hidden = true; });
for (const [id, key] of [['#groupBy', 'groupBy'], ['#layout', 'layout']]) {
  const seg = $(id), attr = key === 'groupBy' ? 'g' : 'l';
  $$('button', seg).forEach(b => b.classList.toggle('active', b.dataset[attr] === S[key]));
  seg.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    S[key] = b.dataset[attr]; localStorage.setItem(key, S[key]);
    $$('button', seg).forEach(x => x.classList.toggle('active', x === b));
    renderBoard();
  });
}

// ---------- entry dialog ----------
// 🎨 A background colour for a connection in the server trees (right-click →
// Background colour…): the system colour picker opens where you clicked.
async function setEntryColor(e, color) {
  const extra = { ...(e.extra || {}) };
  if (color) extra.color = color; else delete extra.color;
  try { await api('POST', '/api/entries', { ...entryInput(e), extra, password: e.password }); await poll(); }
  catch (err) { toast(err.message, true); }
}
function pickEntryColor(e) {
  const inp = Object.assign(document.createElement('input'), { type: 'color', value: /^#[0-9a-f]{6}$/i.test(e.extra?.color || '') ? e.extra.color : '#ffd54f' });
  Object.assign(inp.style, { position: 'fixed', left: (lastClick?.x || 200) + 'px', top: (lastClick?.y || 200) + 'px', width: '1px', height: '1px', opacity: 0 });
  document.body.append(inp);
  inp.addEventListener('change', () => { setEntryColor(e, inp.value); inp.remove(); });
  inp.addEventListener('blur', () => setTimeout(() => inp.remove(), 300));
  inp.click();
}
const entryInput = e => ({
  id: e.id, project: e.project, name: e.name, host: e.host, port: e.port || 0, protocol: e.protocol, url: e.url,
  username: e.username, key_file: e.key_file, env: e.env, tags: e.tags || [], extra: e.extra || {}, notes: e.notes, favorite: !!e.favorite,
});

let editing = null;
async function openEntryDialog(e) {
  editing = e || null;
  const f = $('#entryForm');
  f.reset();
  $('#entryDlgTitle').textContent = e?.id ? 'Edit connection' : 'New connection';
  $('#prevPw').textContent = '';
  const v = e || { project: S.settings.project };
  for (const k of ['name', 'project', 'host', 'port', 'protocol', 'env', 'url', 'username', 'key_file', 'notes']) f[k].value = v[k] || '';
  delete f.protocol.dataset.auto;
  f.tags.value = (v.tags || []).join(', ');
  const ex = { ...(v.extra || {}) };
  f.dbname.value = ex.service || ex.service_name || ex.database || ex.db_name || ex.dbname || ex.sid || '';
  f.tunnels.value = ex.tunnels || '';
  f.tunnels_on.checked = !!ex.tunnels && ex.tunnels_off !== '1'; // off unless this server already has tunnels switched on
  f.tunnels_auto.checked = ex.tunnels_auto === '1';
  delete ex.tunnels; delete ex.tunnels_off; delete ex.tunnels_auto;
  f.commands.value = ex.commands || '';
  f.run_macros.checked = ex.run_macros === '1';
  f.key_auth.checked = ex.auth === 'key';
  delete ex.commands; delete ex.run_macros; delete ex.auth;
  f.is_sid.checked = !!ex.sid && !(ex.service || ex.service_name || ex.database);
  for (const k of DB_KEYS) delete ex[k];
  delete ex.color; // the tree colour: kept on save, not shown as a field
  f.extra.value = Object.entries(ex).map(([k, x]) => `${k}=${x}`).join('\n');
  $('#testResult').textContent = ''; $('#testResult').className = 'test-result';
  dbFieldsVisible();
  f.favorite.checked = !!v.favorite;
  f.password.value = f.password.dataset.orig = e?.password || '';
  if (e?.prev_passwords?.length) $('#prevPw').textContent = 'Previous passwords: ' + e.prev_passwords.join('   ·   ');
  $('#entryDlg').returnValue = ''; // Esc must not repeat the last Save
  f.password.type = 'password'; $('#entryPwEye').classList.remove('on');
  // Open the saved connection in the real PuTTY / FileZilla / SQL Developer / DBeaver.
  const ext = e?.id ? External.items(e) : [];
  $('#entryOpenIn').innerHTML = ext.map(([t], i) => `<button type="button" data-eext="${i}" title="Opens with the saved details — Save first if you changed them">↗ ${esc(t.replace('Open in ', '').replace(' (the real one)', '').replace(' ↗', ''))}</button>`).join('');
  $('#entryOpenIn').onclick = ev => { const b = ev.target.closest('[data-eext]'); if (b) ext[b.dataset.eext][1](); };
  $('#entryDlg').showModal();
}
$('#newEntry').onclick = () => openEntryDialog(null);
const DB_KEYS = ['service', 'service_name', 'database', 'db_name', 'dbname', 'sid'];
function dbFieldsVisible() {
  const f = $('#entryForm'), p = f.protocol.value.trim().toLowerCase(), port = +f.port.value;
  const kind = dbKindOf({ protocol: p, port });
  $('#dbNameRow').style.display = kind ? '' : 'none';
  $('#sidRow').style.display = kind === 'oracle' ? '' : 'none';
  $('#macroRow').style.display = $('#macroOnRow').style.display = kind ? 'none' : '';
}
// Typing a database port fills in Type (oracle/postgres) unless the user chose one.
$('#entryForm').protocol.addEventListener('input', e => { delete e.target.dataset.auto; dbFieldsVisible(); });
$('#entryForm').port.addEventListener('input', () => {
  const f = $('#entryForm'), kind = dbKindByPort(+f.port.value);
  if (!f.protocol.value.trim() || f.protocol.dataset.auto) {
    f.protocol.value = kind;
    if (kind) f.protocol.dataset.auto = '1'; else delete f.protocol.dataset.auto;
  }
  dbFieldsVisible();
});

function entryFormBody() {
  const f = $('#entryForm');
  const extra = {};
  f.extra.value.split('\n').forEach(l => { const i = l.indexOf('='); if (i > 0) extra[l.slice(0, i).trim()] = l.slice(i + 1).trim(); });
  if (editing?.extra?.color) extra.color = editing.extra.color; // the tree colour (set by right-click)
  if (f.tunnels.value.trim()) extra.tunnels = f.tunnels.value.trim();
  if (!f.tunnels_on.checked && f.tunnels.value.trim()) extra.tunnels_off = '1';
  if (f.tunnels_auto.checked && f.tunnels.value.trim()) extra.tunnels_auto = '1';
  const cmds = f.commands.value.replace(/\r/g, '').split('\n').map(l => l.trimEnd()).filter(l => l.trim()).join('\n');
  if (cmds) extra.commands = cmds;
  if (cmds && f.run_macros.checked) extra.run_macros = '1';
  if (f.key_auth.checked) extra.auth = 'key';
  const db = f.dbname.value.trim();
  if (db && $('#dbNameRow').style.display !== 'none') {
    const p = f.protocol.value.trim().toLowerCase();
    extra[f.is_sid.checked ? 'sid' : dbKindOf({ protocol: p, port: +f.port.value }) === 'oracle' ? 'service' : 'database'] = db;
  }
  const body = {
    id: editing?.id || '', name: f.name.value, project: f.project.value, host: f.host.value, port: +f.port.value || 0,
    protocol: f.protocol.value, env: f.env.value, url: f.url.value, username: f.username.value, key_file: f.key_file.value,
    tags: f.tags.value.split(',').map(s => s.trim()).filter(Boolean), extra, notes: f.notes.value, favorite: f.favorite.checked,
  };
  if (f.password.value !== f.password.dataset.orig) body.password = f.password.value;
  return body;
}
$('#entryDlg').addEventListener('close', async () => {
  if ($('#entryDlg').returnValue !== 'save') return;
  try {
    const body = entryFormBody(), r = await api('POST', '/api/entries', body);
    const id = r?.id || body.id;
    if (id && body.extra.tunnels && body.extra.tunnels_off) await api('POST', `/api/tunnels/${id}/enabled`, { on: false }); // stop any running
    toast('Saved'); poll();
  } catch (err) { toast(err.message, true); }
});
$('#testConn').onclick = async () => {
  const out = $('#testResult'), btn = $('#testConn');
  out.className = 'test-result'; out.textContent = 'Testing…'; btn.disabled = true;
  try {
    const r = await api('POST', '/api/test', entryFormBody());
    out.className = 'test-result ' + (r.ok ? 'ok' : 'fail');
    out.textContent = `${r.ok ? '✓' : '✗'} ${r.message} (${(r.ms / 1000).toFixed(1)}s)`;
    if (editing?.id) poll();
  } catch (err) { out.className = 'test-result fail'; out.textContent = '✗ ' + err.message; }
  btn.disabled = false;
};

function askCreds(e) {
  return new Promise(resolve => {
    $('#credTitle').textContent = `Log in to ${e.host}`;
    $('#credUser').value = e.username || '';
    $('#credPass').value = '';
    const dlg = $('#credDlg');
    dlg.onclose = () => resolve(dlg.returnValue === 'ok' ? { username: $('#credUser').value.trim(), password: $('#credPass').value, save: $('#credSave').checked } : null);
    dlg.returnValue = '';
    dlg.showModal();
    (e.username ? $('#credPass') : $('#credUser')).focus();
  });
}
const needsCreds = e => !e.username || (!e.has_password && !e.key_file);

// ---------- captured ----------
function renderClips() {
  const el = $('#clips');
  if (!S.clips.length) { el.innerHTML = '<div class="empty">Nothing captured yet.</div>'; return; }
  el.innerHTML = S.clips.map(c => {
    const chips = (c.entry_ids || []).map(byId).filter(Boolean).map(e =>
      `<span class="chip" data-find="${esc(e.host || e.url || e.username)}">${linkLabel(e.url) ? esc(linkLabel(e.url)) + ' · ' : ''}${esc(e.username ? e.username + ' @ ' : '')}${esc(e.host || e.url || '')}${e.port ? ':' + e.port : ''}</span>`).join('');
    return `<div class="clip" data-clip="${c.id}"><div class="clip-head"><span>${new Date(c.created).toLocaleString()}</span><span class="proto">${esc(c.source)}</span>${c.from ? `<span class="muted tiny" title="Copied from">from ${esc(c.from)}</span>` : ''}<span>${esc(c.project)}</span>
      <span class="spacer"></span><button class="icon more" data-clipmore="${c.id}" title="Copy or delete this capture">⋯</button></div>
      <pre>${maskedText(c.text)}</pre><div class="chips">${chips || '<span class="muted tiny">no hosts or credentials recognised</span>'}</div></div>`;
  }).join('');
}
$('#clips').addEventListener('click', async e => {
  const chip = e.target.closest('[data-find]');
  if (chip) { $('#search').value = chip.dataset.find; $('#fProject').value = ''; $('#fEnv').value = ''; show('dashboard'); return renderBoard(); }
  const more = e.target.closest('[data-clipmore]');
  if (more) { const r = more.getBoundingClientRect(); clipMenu(S.clips.find(x => x.id === more.dataset.clipmore), { clientX: r.left - 150, clientY: r.bottom }); }
});
// Right-click a capture: the same menu as its ⋯
$('#clips').addEventListener('contextmenu', e => {
  const el = e.target.closest('[data-clip]'); if (!el || e.target.closest('a')) return;
  e.preventDefault(); clipMenu(S.clips.find(x => x.id === el.dataset.clip), { clientX: e.clientX, clientY: e.clientY });
});
function clipMenu(c, at) {
  if (!c) return;
  setTimeout(() => Tree.showMenu(at, [
    ['Copy the text', () => copyText(c.text)],
    ['🧵 Add to task thread…', () => Work.addClip(c, at)],
    ['Delete this capture', async () => {
      await api('DELETE', `/api/clips/${c.id}`); poll();
      toast('Capture deleted', false, async () => { await api('POST', '/api/ingest', { text: c.text, source: c.source, project: c.project }); poll(); toast('Restored'); });
    }]]));
}
async function ingestPaste() {
  const text = $('#pasteText').value;
  if (!text.trim()) return;
  try {
    const r = await api('POST', '/api/ingest', { text, source: 'paste', project: $('#captureProject').value.trim() });
    const n = r.entries?.length || 0;
    $('#pasteResult').textContent = n ? `Filed ${n} item(s): ` + r.entries.map(e => e.name).join(', ') : 'Saved, but no hosts/URLs/credentials were recognised.';
    $('#pasteText').value = '';
    poll();
  } catch (err) { toast(err.message, true); }
}
$('#pasteBtn').onclick = ingestPaste;
$('#pasteText').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) ingestPaste(); });
