'use strict';
// WorkHub page, part 1 of 7: helpers, state, labels, editor, navigation, settings, dashboard.
// The page's script is split into parts loaded in order (index.html: app.js, app-search.js … app-start.js).

// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (r.status === 423) { if (typeof Lock !== 'undefined') Lock.show(); throw new Error('WorkHub is locked'); }
  if (r.status === 401) {
    // after a restart or quit the page already says so; otherwise cover it (its timers keep running)
    if (!document.querySelector('.stopped')) stoppedScreen('<h2>This window is signed out of WorkHub.</h2><p>Open WorkHub from its icon (Start menu, desktop or tray) — it opens a signed-in window. You can close this one.</p>');
    throw new Error('unauthorized');
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

// Passwords are masked until 👁 is clicked (one at a time, or all with
// "Show passwords" on the dashboard). Copying always copies the real one.
const PW_MASK = '••••••••';
function pwHTML(pw) {
  if (!pw) return '';
  return `<span class="pwbox"><span class="copy pwv" data-copy="${esc(pw)}" data-pw="${esc(pw)}" title="Click to copy">${S.showPw ? esc(pw) : PW_MASK}</span><button class="icon eye" data-eye title="Show / hide">👁</button></span>`;
}
// Raw captured text with passwords masked: every saved password, plus values
// after "password:", "pwd=", "-pw" and in user:password@host.
function secretsIn(text) {
  const out = new Set((S.allEntries || []).flatMap(e => [e.password, e.password?.toLowerCase()]).filter(p => p && p.length >= 3 && text.includes(p)));
  for (const re of [/\b(?:password|passwd|pwd|pass|pw)\s*[:=]\s*(\S+)/gi, /(?:^|\s)-pw\s+(\S+)/g, /:\/\/[^:\s/@]+:([^@\s]+)@/g,
    /(?:^|\s)[\w.@-]+ \/ ([^\s/]+)/g]) // "user / password"
    for (const m of text.matchAll(re)) if (m[1].length >= 2) out.add(m[1]);
  return [...out].sort((a, b) => b.length - a.length);
}
function maskedText(text) {
  const secrets = secretsIn(text || '');
  if (!secrets.length) return esc(text || '');
  const re = new RegExp(secrets.map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  let out = '', i = 0;
  for (const m of text.matchAll(re)) {
    out += esc(text.slice(i, m.index)) + `<span class="pwinline"><span class="pwv" data-pw="${esc(m[0])}">${S.showPw ? esc(m[0]) : PW_MASK}</span><button class="icon eye" data-eye title="Show / hide">👁</button></span>`;
    i = m.index + m[0].length;
  }
  return out + esc(text.slice(i));
}
document.addEventListener('click', ev => {
  const b = ev.target.closest('[data-eye]'); if (!b) return;
  ev.stopPropagation(); ev.preventDefault();
  if (typeof Presenting !== 'undefined' && Presenting.on()) return toast('🎬 Presenting — passwords stay hidden', true);
  const v = b.parentElement.querySelector('.pwv');
  const shown = v.textContent !== PW_MASK;
  v.textContent = shown ? PW_MASK : v.dataset.pw;
  b.classList.toggle('on', !shown);
}, true);

let toastTimer;
function toast(msg, err = false, undo = null, label = 'Undo') {
  const t = $('#toast');
  t.textContent = msg;
  if (undo) { // e.g. "Deleted x — Undo", or a reminder's "Open"
    const b = document.createElement('button');
    b.textContent = label; b.className = 'toast-undo';
    b.onclick = () => { t.className = ''; undo(); };
    t.append(' ', b);
  }
  t.className = 'show' + (err ? ' err' : '') + (undo ? ' act' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), undo ? 8000 : err ? 5000 : 2200);
}
// Delete entries with an Undo that saves them back (with their passwords).
async function deleteEntries(list) {
  for (const e of list) await api('DELETE', `/api/entries/${e.id}`).catch(err => toast(err.message, true));
  poll();
  toast(`${list.length === 1 ? `Deleted ${list[0].name}` : `Deleted ${list.length} entries`} — in the 🗑 Recycle bin for 30 days`, false, async () => {
    const bin = (await api('GET', '/api/bin').catch(() => ({ items: [] }))).items; // Undo: back from the bin (not a copy)
    for (const e of list) { const it = bin.find(x => x.kind === 'entry' && x.ref === e.id); if (it) await api('POST', `/api/bin/${it.id}/restore`).catch(err => toast(err.message, true)); }
    poll(); toast('Restored');
  });
}

// Icons: open in a new window (box, arrow out) / dock back into WorkHub (arrow in)
const ICON_NEWWIN = '<svg class="ico-win" viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4l-8.5 8.5"/><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/></svg>';
const ICON_DOCK = '<svg class="ico-win" viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 4l-8.5 8.5"/><path d="M11 7v6h6"/><path d="M4 9.5v9A1.5 1.5 0 0 0 5.5 20h9"/></svg>';

// WorkHub's own question box (instead of the browser's prompt(), which shows
// "127.0.0.1 says"): it opens just to the right of where you clicked (kept on
// screen; centred when opened from the keyboard). Enter = OK, Esc / click outside = cancel.
let lastClick = null;
document.addEventListener('mousedown', e => { lastClick = { x: e.clientX, y: e.clientY, t: Date.now() }; }, true);
function askText(label, value = '', ok = 'OK') {
  return new Promise(done => {
    document.querySelector('.askbox')?.dispatchEvent(new Event('cancel'));
    const box = Object.assign(document.createElement('dialog'), { className: 'askbox' });
    box.innerHTML = `<div class="ask-head"><span class="ask-logo">W</span>WorkHub</div><label>${esc(label)}</label><input type="text"><div class="row end"><button type="button" data-ask="no">Cancel</button><button type="button" class="primary" data-ask="ok">${esc(ok)}</button></div>`;
    const input = box.querySelector('input'); input.value = value ?? '';
    document.body.append(box);
    box.showModal(); // on top of any open window, which stays as it is
    const r = box.getBoundingClientRect(), near = lastClick && Date.now() - lastClick.t < 1500;
    const x = near ? lastClick.x + 14 : (innerWidth - r.width) / 2, y = near ? lastClick.y - 12 : innerHeight / 3;
    box.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
    box.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
    let over = false;
    const finish = v => { if (over) return; over = true; box.close(); box.remove(); done(v); };
    box.addEventListener('cancel', e => { e.preventDefault(); finish(null); });
    box.addEventListener('close', () => finish(null)); // closed from elsewhere = cancelled
    box.addEventListener('mousedown', e => { // a click outside the box (on the dimmed page) = cancel
      if (e.target !== box) return; const b = box.getBoundingClientRect();
      if (e.clientX < b.left || e.clientX > b.right || e.clientY < b.top || e.clientY > b.bottom) finish(null);
    });
    box.addEventListener('click', e => { const b = e.target.closest('[data-ask]'); if (b) finish(b.dataset.ask === 'ok' ? input.value : null); });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); finish(input.value); } if (e.key === 'Escape') { e.preventDefault(); finish(null); } });
    input.focus(); input.select();
  });
}

// WorkHub's own yes/no box (instead of the browser's confirm(), which shows
// "127.0.0.1 says"). Resolves true (OK) or false (Cancel / Esc). Enter = OK.
// A warning (⚠, Delete, Remove, Stop) gets the delete-style OK button (slate: red is kept for PROD).
function askYes(message, opts = {}) {
  return new Promise(done => {
    const box = Object.assign(document.createElement('dialog'), { className: 'askyes' });
    const danger = opts.danger ?? /^(⚠|Delete|Remove|Quit|Turn off|Stop|Discard)/i.test(message.trim());
    box.innerHTML = `<div class="ask-head"><span class="ask-logo">W</span>WorkHub</div><div class="ask-msg"></div><div class="row end"><button type="button" data-ask="no">${esc(opts.no || 'Cancel')}</button><button type="button" class="${danger ? 'danger' : 'primary'}" data-ask="ok">${esc(opts.ok || 'OK')}</button></div>`;
    box.querySelector('.ask-msg').textContent = message;
    document.body.append(box);
    let over = false;
    const finish = v => { if (over) return; over = true; box.close(); box.remove(); done(v); };
    box.addEventListener('cancel', e => { e.preventDefault(); finish(false); });
    box.addEventListener('close', () => finish(false));
    box.addEventListener('click', e => { const b = e.target.closest('[data-ask]'); if (b) finish(b.dataset.ask === 'ok'); });
    box.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.target.closest('[data-ask="no"]')) { e.preventDefault(); finish(true); } });
    box.showModal();
    box.querySelector('[data-ask=ok]').focus();
  });
}

// The clipboard's text without the browser's "Allow / Block" question: WorkHub reads it itself
// (the page's own clipboard access only if that fails).
async function clipText() {
  try { const r = await api('GET', '/api/clipboard/text'); if (typeof r?.text === 'string') return r.text; } catch { /* fall back */ }
  return navigator.clipboard.readText();
}

async function copyText(text, what = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(what);
}

const fmtSize = n => n < 1024 ? n + ' B' : n < 1 << 20 ? (n / 1024).toFixed(1) + ' KB' : n < 1 << 30 ? (n / (1 << 20)).toFixed(1) + ' MB' : (n / (1 << 30)).toFixed(2) + ' GB';
const fmtDateTime = t => {
  const d = new Date(t);
  if (isNaN(d) || d.getFullYear() < 1971) return '';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const FILE_TYPES = {
  txt: 'Text', log: 'Log', out: 'Log', err: 'Log', csv: 'CSV', tsv: 'TSV', json: 'JSON', xml: 'XML', yml: 'YAML', yaml: 'YAML',
  properties: 'Properties', conf: 'Config', cfg: 'Config', ini: 'Config', env: 'Env file', md: 'Markdown', html: 'HTML', htm: 'HTML',
  sh: 'Shell script', ksh: 'Shell script', bash: 'Shell script', py: 'Python', java: 'Java', class: 'Java class', js: 'JavaScript',
  sql: 'SQL', pls: 'PL/SQL', pks: 'PL/SQL', pkb: 'PL/SQL', ps1: 'PowerShell', bat: 'Batch', cmd: 'Batch', exe: 'Program', dll: 'Library',
  jar: 'Java archive', war: 'Web archive', ear: 'Java EE archive', zip: 'ZIP archive', gz: 'GZip archive', tgz: 'Tar archive',
  tar: 'Tar archive', bz2: 'BZip2 archive', xz: 'XZ archive', '7z': '7-Zip archive', rar: 'RAR archive', rpm: 'RPM package', deb: 'Debian package',
  pem: 'Certificate', crt: 'Certificate', cer: 'Certificate', key: 'Private key', p12: 'Keystore', pfx: 'Keystore', jks: 'Keystore',
  pdf: 'PDF', doc: 'Word', docx: 'Word', xls: 'Excel', xlsx: 'Excel', ppt: 'PowerPoint', pptx: 'PowerPoint',
  png: 'Image', jpg: 'Image', jpeg: 'Image', gif: 'Image', svg: 'Image', bak: 'Backup', old: 'Backup', tmp: 'Temp', lck: 'Lock', lock: 'Lock', pid: 'PID file',
};
function fileType(f) {
  if (f.dir) return 'Folder';
  const m = f.name.match(/\.([A-Za-z0-9]{1,10})$/);
  if (!m) return f.name.startsWith('.') ? 'Hidden file' : 'File';
  const ext = m[1].toLowerCase();
  if (/^\d+$/.test(ext) && /\.(log|out)\.\d+$/i.test(f.name)) return 'Log (rotated)';
  return FILE_TYPES[ext] || ext.toUpperCase() + ' file';
}
const fmtTime = t => {
  const d = new Date(t);
  if (isNaN(d) || d.getFullYear() < 1971) return '';
  return d.toLocaleDateString() === new Date().toLocaleDateString() ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString();
};

// ---------- state ----------
const S = {
  entries: [], clips: [], settings: {}, version: -1,
  groupBy: localStorage.getItem('groupBy') || 'project',
  layout: localStorage.getItem('layout') || 'cards',
};
// UAT and PROD (also UAT1, UAT2…, PRODDR…): hidden unless picked at the top (EnvSwitch)
const GUARDED_ENVS = ['UAT', 'PROD'];
const guardedEnv = e => GUARDED_ENVS.find(x => (e.env || '').toUpperCase().startsWith(x)) || '';
const byId = id => (S.allEntries || S.entries).find(e => e.id === id);

// ---------- URL labels ----------
// First match wins, so specific patterns come before generic ones. Each regex
// is tested against "host:port/path?query" (lower-case, port always present).
const URL_LABELS = [
  // app servers
  [/\/manager\/(html|status|text)|\/manager\/?($|\?)/, 'Tomcat Manager'],
  [/\/host-manager/, 'Tomcat Host Manager'],
  [/\/ibm\/console/, 'WebSphere Console'],
  [/:700[12]\/console|\/console\/login\/loginform/, 'WebLogic Console'],
  [/\/em(\/|$|\?)|:7803\//, 'Oracle Enterprise Manager'],
  [/\/jmx-console/, 'JBoss JMX Console'],
  [/\/admin-console/, 'JBoss Admin Console'],
  [/:9990\//, 'WildFly Admin Console'],
  [/:4848\//, 'GlassFish Admin'],
  [/\/hawtio/, 'Hawtio Console'],
  [/:8161\/|\/activemq/, 'ActiveMQ Console'],
  [/:15672\/|\/rabbitmq/, 'RabbitMQ Management'],
  // Oracle / SAP / Microsoft
  [/\/ords\/.*apex|\/apex(\/|$)/, 'Oracle APEX'],
  [/\/ords(\/|$)/, 'Oracle ORDS'],
  [/\/xmlpserver/, 'Oracle BI Publisher'],
  [/\/analytics(\/|$)/, 'Oracle Analytics'],
  [/\/oa_html/, 'Oracle EBS'],
  [/\/irj\/portal/, 'SAP Portal'],
  [/\/sap\/bc\/|\/sap(\/|$)/, 'SAP'],
  [/\/owa(\/|$)/, 'Outlook Web Access'],
  [/\/ecp(\/|$)/, 'Exchange Admin'],
  [/\/adfs\//, 'ADFS Sign-in'],
  [/sharepoint\.com|\/sites\/|\/_layouts\//, 'SharePoint'],
  [/service-now\.com|servicenow/, 'ServiceNow'],
  // dev tools
  [/(^|[.\-])jenkins[.\-:]|\/jenkins(\/|$)|^[^/]+\/(?:.*\/)?job\/[^/]+|\/blue\/organizations\/jenkins\//, 'Jenkins'],
  [/(^|[.\-])gitlab[.\-:]|\/gitlab(\/|$)/, 'GitLab'],
  [/github\.com|(^|[.\-])github[.\-:]/, 'GitHub'],
  [/bitbucket/, 'Bitbucket'],
  [/\/browse\/[a-z][a-z0-9]+-\d+/, 'Jira Issue'],
  [/(^|[.\-])jira[.\-:]|\/jira(\/|$)|atlassian\.net\/(jira|browse)/, 'Jira'],
  [/(^|[.\-])confluence[.\-:]|\/confluence(\/|$)|\/wiki\/|\/display\//, 'Confluence'],
  [/(^|[.\-])sonar(qube)?[.\-:]|\/sonar(\/|$)/, 'SonarQube'],
  [/(^|[.\-])nexus[.\-:]|\/nexus(\/|$)|:8081\/(#browse|service\/rest)/, 'Nexus'],
  [/artifactory/, 'Artifactory'],
  [/(^|[.\-])argocd?[.\-:]|\/argocd/, 'Argo CD'],
  [/\/awx|\/tower|(^|[.\-])awx[.\-:]/, 'Ansible AWX'],
  [/kubernetes-dashboard/, 'Kubernetes Dashboard'],
  [/:6443\//, 'Kubernetes API'],
  [/portainer/, 'Portainer'],
  [/(^|[.\-])vault[.\-:]|:8200\//, 'Vault'],
  [/:8500\/ui|(^|[.\-])consul[.\-:]/, 'Consul'],
  [/kafka-ui|akhq|\/ui\/clusters/, 'Kafka UI'],
  // monitoring
  [/(^|[.\-])grafana[.\-:]|\/grafana(\/|$)|:3000\/d\//, 'Grafana'],
  [/(^|[.\-])kibana[.\-:]|\/app\/kibana|\/kibana|:5601\//, 'Kibana'],
  [/alertmanager|:9093\//, 'Alertmanager'],
  [/(^|[.\-])prometheus[.\-:]|\/prometheus|:9090\//, 'Prometheus'],
  [/(^|[.\-])splunk[.\-:]|\/splunk/, 'Splunk'],
  [/:9200\/|elasticsearch|\/_cat\//, 'Elasticsearch'],
  [/\/solr(\/|$)|:8983\//, 'Solr'],
  [/nagios/, 'Nagios'], [/zabbix/, 'Zabbix'], [/icinga/, 'Icinga'],
  [/dynatrace/, 'Dynatrace'], [/appdynamics/, 'AppDynamics'], [/datadog/, 'Datadog'], [/newrelic/, 'New Relic'],
  // databases / admin tools
  [/phpmyadmin/, 'phpMyAdmin'], [/pgadmin/, 'pgAdmin'], [/minio/, 'MinIO Console'],
  [/\/auth\/admin|\/admin\/master\/console/, 'Keycloak Admin'],
  [/\/auth\/realms|\/realms\/[^/]+\/protocol/, 'Keycloak Login'],
  [/\/wp-admin|\/wp-login/, 'WordPress Admin'],
  // generic endpoints
  [/\/actuator\/health/, 'Health check (Spring)'],
  [/\/actuator/, 'Spring Actuator'],
  [/\/(swagger-ui|swagger)(\.html|\/|$)|\/v[23]\/api-docs|\/openapi/, 'API docs (Swagger)'],
  [/\/graphql/, 'GraphQL API'],
  [/\/(health|healthz|healthcheck|ping|status)(\/|$|\?)/, 'Health check'],
  [/\/metrics(\/|$)/, 'Metrics'],
  [/\/(login|signin|sign-in|logon|sso)(\.\w+)?(\/|$|\?)/, 'Login page'],
  [/\/(admin|administrator|console)(\/|$|\?)/, 'Admin console'],
  [/\/api(\/|$)|\/rest(\/|$)|\/v\d+\//, 'REST API'],
];

// Broader categories for the Smart bookmark view.
const LABEL_CATEGORY = {};
for (const [cat, labels] of Object.entries({
  'App servers': ['Tomcat Manager', 'Tomcat Host Manager', 'WebSphere Console', 'WebLogic Console', 'Oracle Enterprise Manager', 'JBoss JMX Console', 'JBoss Admin Console', 'WildFly Admin Console', 'GlassFish Admin', 'Hawtio Console', 'ActiveMQ Console', 'RabbitMQ Management', 'Kafka UI'],
  'Oracle & SAP': ['Oracle APEX', 'Oracle ORDS', 'Oracle BI Publisher', 'Oracle Analytics', 'Oracle EBS', 'SAP Portal', 'SAP'],
  'Docs & collaboration': ['Confluence', 'Jira', 'Jira Issue', 'SharePoint', 'ServiceNow', 'Outlook Web Access', 'Exchange Admin'],
  'Dev & CI/CD': ['Jenkins', 'GitLab', 'GitHub', 'Bitbucket', 'SonarQube', 'Nexus', 'Artifactory', 'Argo CD', 'Ansible AWX', 'Kubernetes Dashboard', 'Kubernetes API', 'Portainer', 'Vault', 'Consul'],
  'Monitoring & logs': ['Grafana', 'Kibana', 'Alertmanager', 'Prometheus', 'Splunk', 'Elasticsearch', 'Solr', 'Nagios', 'Zabbix', 'Icinga', 'Dynatrace', 'AppDynamics', 'Datadog', 'New Relic', 'Metrics'],
  'Databases': ['phpMyAdmin', 'pgAdmin', 'MinIO Console', 'Oracle DB', 'PostgreSQL DB', 'MySQL DB', 'SQL Server DB', 'DB2', 'Database (JDBC)', 'MongoDB'],
  'APIs & health checks': ['API docs (Swagger)', 'GraphQL API', 'REST API', 'Spring Actuator', 'Health check', 'Health check (Spring)'],
  'Admin & sign-in': ['Admin console', 'Login page', 'Keycloak Admin', 'Keycloak Login', 'ADFS Sign-in', 'WordPress Admin', 'LDAP', 'File share'],
})) labels.forEach(l => (LABEL_CATEGORY[l] = cat));

const labelCache = new Map();
// Jenkins job from its URL: /job/Folder/job/pay-api-deploy/123/console →
// "Folder › pay-api-deploy #123" (also Blue Ocean and /view/ links).
function jenkinsJob(url) {
  let u; try { u = new URL(url); } catch { return ''; }
  const segs = u.pathname.split('/').filter(Boolean).map(s => { try { return decodeURIComponent(s); } catch { return s; } });
  const jobs = []; let build = '';
  for (let i = 0; i < segs.length; i++) {
    if (segs[i] === 'job' && segs[i + 1]) { jobs.push(segs[++i]); if (/^\d+$/.test(segs[i + 1] || '')) build = segs[i + 1]; }
  }
  if (!jobs.length) {
    const bo = segs.indexOf('organizations'); // Blue Ocean: /blue/organizations/jenkins/Folder%2Fjob/detail/job/12/
    if (segs[0] === 'blue' && bo >= 0 && segs[bo + 2]) { jobs.push(...segs[bo + 2].split('/')); if (segs[bo + 3] === 'detail' && /^\d+$/.test(segs[bo + 5] || '')) build = segs[bo + 5]; }
  }
  if (!jobs.length) { const v = segs.lastIndexOf('view'); return v >= 0 && segs[v + 1] ? 'view ' + segs[v + 1] : ''; }
  return jobs.join(' › ') + (build ? ' #' + build : '');
}
// Label for showing a link: the app label plus, for Jenkins, the job.
function linkLabel(url) {
  const l = urlLabel(url), j = /jenkins/i.test(l) ? jenkinsJob(url) : '';
  return j ? `${l}: ${j}` : l;
}
// Naming rules (this workspace): host name contains "-BAT-" → "Batch".
function ruleLabel(hostOrURL) {
  let h = String(hostOrURL || '').toLowerCase();
  try { if (/^[a-z][a-z0-9+.-]*:\/\//.test(h)) h = new URL(h).hostname; } catch { /* keep as is */ }
  const r = h && (S.settings.name_rules || []).find(x => x.match?.trim() && x.label?.trim() && h.includes(x.match.trim().toLowerCase()));
  return r ? r.label.trim() : '';
}
// Each naming-rule label gets its own colour (in rule order), so Batch,
// Touchpoint, App… stand apart everywhere they appear.
const RULE_COLORS = ['#2563eb', '#c2410c', '#7c3aed', '#059669', '#db2777', '#0891b2', '#65a30d', '#b45309', '#4f46e5', '#0d9488'];
function ruleColor(label) {
  if (!label) return '';
  const labels = [...new Set((S.settings.name_rules || []).map(r => r.label?.trim()).filter(Boolean))];
  const i = labels.indexOf(label);
  return i < 0 ? '' : RULE_COLORS[i % RULE_COLORS.length];
}
const ruleStyle = hostOrURL => (c => c ? ` style="--lc:${c}"` : '')(ruleColor(ruleLabel(hostOrURL)));
// A name like "Batch – host": the rule label part in its colour.
function ruleName(e) {
  const rl = ruleLabel(e.host || e.url), c = ruleColor(rl), n = e.name || '';
  return c && n.startsWith(rl) ? `<span><b class="rname" style="--lc:${c}">${esc(rl)}</b>${esc(n.slice(rl.length))}</span>` : esc(n);
}
function urlLabel(url) {
  if (!url) return '';
  if (labelCache.has(url)) return labelCache.get(url);
  let label = '';
  const l = url.toLowerCase();
  if (l.startsWith('jdbc:')) label = { oracle: 'Oracle DB', postgresql: 'PostgreSQL DB', mysql: 'MySQL DB', sqlserver: 'SQL Server DB', db2: 'DB2' }[l.split(':')[1]] || 'Database (JDBC)';
  else if (/^\\\\/.test(url) || l.startsWith('smb:')) label = 'File share';
  else if (/^ldaps?:/.test(l)) label = 'LDAP';
  else if (/^mongodb/.test(l)) label = 'MongoDB';
  else {
    try {
      const u = new URL(url);
      const port = u.port || { 'http:': '80', 'https:': '443', 'ftp:': '21', 'sftp:': '22' }[u.protocol] || '';
      const s = `${u.hostname}:${port}${u.pathname}${u.search}`.toLowerCase();
      label = URL_LABELS.find(([re]) => re.test(s))?.[1] || '';
    } catch { /* not a URL */ }
  }
  const rl = ruleLabel(url);
  if (rl) label = label && label !== rl ? rl + ' · ' + label : rl;
  labelCache.set(url, label);
  return label;
}

// ---------- code editor (CodeMirror 5, bundled) ----------
const LANGS = [
  ['text', 'Plain text', 'text/plain'], ['log', 'Log file', 'log'], ['sql', 'SQL', 'text/x-sql'], ['plsql', 'Oracle PL/SQL', 'text/x-plsql'],
  ['pgsql', 'PostgreSQL', 'text/x-pgsql'], ['shell', 'Shell (bash/ksh)', 'text/x-sh'], ['powershell', 'PowerShell', 'powershell'],
  ['batch', 'Batch (.bat/.cmd)', 'batch'], ['python', 'Python', 'python'], ['java', 'Java', 'text/x-java'], ['csharp', 'C#', 'text/x-csharp'],
  ['groovy', 'Groovy / Gradle', 'groovy'], ['js', 'JavaScript', 'javascript'], ['json', 'JSON', 'application/json'], ['xml', 'XML', 'xml'],
  ['html', 'HTML', 'htmlmixed'], ['css', 'CSS', 'css'], ['yaml', 'YAML', 'yaml'], ['ini', 'Properties / INI / conf', 'properties'],
  ['md', 'Markdown', 'markdown'], ['docker', 'Dockerfile', 'dockerfile'], ['diff', 'Diff / patch', 'diff'], ['perl', 'Perl', 'perl'],
];
const EXT_LANG = {
  txt: 'text', log: 'log', out: 'log', err: 'log', trc: 'log', sql: 'sql', ddl: 'sql', pls: 'plsql', plb: 'plsql', pks: 'plsql', pkb: 'plsql', prc: 'plsql', fnc: 'plsql',
  trg: 'plsql', vw: 'plsql', sh: 'shell', bash: 'shell', ksh: 'shell', zsh: 'shell', profile: 'shell', bashrc: 'shell', ps1: 'powershell', psm1: 'powershell',
  psd1: 'powershell', bat: 'batch', cmd: 'batch', py: 'python', java: 'java', cs: 'csharp', groovy: 'groovy', gradle: 'groovy', js: 'js', mjs: 'js', ts: 'js',
  json: 'json', xml: 'xml', pom: 'xml', xsd: 'xml', xsl: 'xml', wsdl: 'xml', config: 'xml', csproj: 'xml', html: 'html', htm: 'html', jsp: 'html',
  css: 'css', yml: 'yaml', yaml: 'yaml', properties: 'ini', ini: 'ini', conf: 'ini', cfg: 'ini', env: 'ini', toml: 'ini', md: 'md', markdown: 'md',
  dockerfile: 'docker', diff: 'diff', patch: 'diff', pl: 'perl', pm: 'perl',
};
function langForPath(p) {
  const name = p.split(/[\\/]/).pop().toLowerCase();
  if (name === 'dockerfile') return 'docker';
  if (/\.(log|out|err)(\.\d+)?$/.test(name) || /\.log\./.test(name)) return 'log';
  return EXT_LANG[name.includes('.') ? name.split('.').pop() : name.replace(/^\./, '')] || 'text';
}
const modeOf = id => (LANGS.find(l => l[0] === id) || LANGS[0])[2];

// Log files: whole ERROR lines red, WARN amber, timestamps and levels muted.
CodeMirror.defineSimpleMode('log', { start: [
  { regex: /.*\b(ERROR|FATAL|SEVERE|CRITICAL|EXCEPTION|Exception|Caused by|ORA-\d{5}|Traceback)\b.*/, token: 'log-error', sol: true },
  { regex: /.*\b(WARN|WARNING)\b.*/, token: 'log-warn', sol: true },
  { regex: /\s+at\s+[\w.$<>]+\(.*?\)/, token: 'log-stack', sol: true },
  { regex: /\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/, token: 'log-time' },
  { regex: /\b(?:INFO|DEBUG|TRACE|NOTICE)\b/, token: 'log-level' },
  { regex: /[^\s]+/, token: null }, { regex: /\s+/, token: null },
] });
CodeMirror.defineSimpleMode('batch', { start: [
  { regex: /\s*(?:rem\b|::).*/i, token: 'comment', sol: true },
  { regex: /\s*:[\w.-]+/, token: 'def', sol: true },
  { regex: /"(?:[^"])*"?/, token: 'string' },
  { regex: /%~?[\w$]*%?|%%~?\w|![\w]+!/, token: 'variable-2' },
  { regex: /@?\b(?:if|else|for|in|do|goto|call|exit|set|setlocal|endlocal|echo|not|exist|defined|errorlevel|equ|neq|lss|leq|gtr|geq|pause|shift|start|cd|pushd|popd|copy|xcopy|robocopy|move|del|mkdir|md|rmdir|rd|type|title|cls|choice|timeout)\b/i, token: 'keyword' },
  { regex: /\d+/, token: 'number' }, { regex: /[\w.-]+/, token: null }, { regex: /./, token: null },
] });

function makeEditor(host, opts = {}) {
  return CodeMirror(host, Object.assign({
    theme: 'wh', lineNumbers: true, foldGutter: true, gutters: ['CodeMirror-linenumbers', 'CodeMirror-foldgutter'],
    matchBrackets: true, styleActiveLine: true, indentUnit: 4, tabSize: 4, indentWithTabs: false,
    highlightSelectionMatches: { minChars: 2, showToken: false, annotateScrollbar: true },
    extraKeys: {
      'Ctrl-F': 'findPersistent', 'Cmd-F': 'findPersistent', 'Ctrl-H': 'replace', 'Cmd-Alt-F': 'replace',
      'F3': 'findNext', 'Shift-F3': 'findPrev', 'Ctrl-G': 'jumpToLine', 'Cmd-L': 'jumpToLine',
      'Ctrl-/': 'toggleComment', 'Cmd-/': 'toggleComment', 'Ctrl-D': 'duplicateLine', 'Cmd-D': 'duplicateLine',
      'Tab': cm => cm.somethingSelected() ? cm.indentSelection('add') : cm.replaceSelection(' '.repeat(cm.getOption('indentUnit'))),
      'Shift-Tab': cm => cm.indentSelection('subtract'),
      'Ctrl-Q': cm => cm.foldCode(cm.getCursor()),
    },
  }, opts));
}
CodeMirror.commands.duplicateLine = cm => {
  const c = cm.getCursor(), line = cm.getLine(c.line);
  cm.replaceRange('\n' + line, { line: c.line, ch: line.length });
};

// ---------- navigation ----------
// Pages with their own list or tree on the left (SSH, FTP, SQL, Tasks…) shrink
// the sidebar to icons when opened — from the sidebar or by connecting — so
// the tree, the window (and the calendar) get the room; Dashboard, Bookmarks
// and Captured bring it back. Clicking the current page's icon again switches
// it either way on any page (» too).
const WORK_VIEWS = ['terminal', 'files', 'sql', 'tasks', 'ref', 'jira', 'groups', 'notes', 'git', 'cal', 'api'];
// The left menu slides between full size and the icon rail (not while you drag its edge).
let sideAnimT;
function animateSide() {
  document.body.classList.add('side-anim');
  clearTimeout(sideAnimT); sideAnimT = setTimeout(() => { document.body.classList.remove('side-anim'); fitActiveTerm?.(); }, 260);
}
// 📌 Pinned: the left menu stays as it is — pages don't shrink it, double-click, Ctrl+B, « and dragging its edge don't change it.
const sidePinned = () => document.body.classList.contains('side-pinned');
function setSidePin(on) {
  document.body.classList.toggle('side-pinned', on); store.set('sidePinned', on);
  const b = $('#sidePin'); if (b) { b.setAttribute('aria-pressed', on); b.title = on ? 'Pinned — click to unpin (then pages can shrink the menu again)' : "Pin the menu: it stays as it is now (pages don't shrink it, double-click and Ctrl+B don't change it)"; }
  if (on) S.autoSide = false;
}
function roomForWork() {
  if (sidePinned()) return;
  if (document.body.classList.contains('side-top')) return; // a bar across the top takes no room from the tree
  if (S.userSide || document.body.classList.contains('side-collapsed')) return;
  animateSide();
  document.body.classList.add('side-collapsed'); S.autoSide = true;
  $('#sideToggle').textContent = '»';
  setTimeout(() => { fitActiveTerm(); window.dispatchEvent(new Event('resize')); }, 50);
}
function show(view) {
  if (WORK_VIEWS.includes(view)) roomForWork();
  else if (S.userSide) S.userSide = false;
  else if (S.autoSide) { // put the sidebar back as it was
    animateSide();
    S.autoSide = false;
    applySide();
  }
  $$('#nav button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $('#pageTitle').textContent = $(`#nav [data-view="${view}"] .nl`)?.textContent || '';
  pagePopBtn(view);
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
  history.replaceState(null, '', '#' + view);
  if (view === 'terminal') { fitActiveTerm(); if (!Term.tabs.length) Term.emptyHTML(); }
  if (view === 'files') Jobs.tick();
  if (view === 'files' && !Local.loaded) Local.load(lsGet('ftp.local'), true).then(() => { if (!Local.loaded) Local.load(''); });
  if (view === 'notes') { Notes.cm.refresh(); Notes.cm.focus(); }
  if (view === 'api') setTimeout(() => $('#apiBody')?.cm?.refresh());
  if (view === 'tasks') Work.show();
  if (view === 'bookmarks') {
    Bookmarks.sync(false);
    // Re-check links not checked in the last hour.
    // Only internal links are re-checked automatically; "Check links" does everything.
    const stale = S.entries.filter(e => /^https?:/i.test(e.url || '') && isInternal(e) && (!e.status_at || Date.now() - new Date(e.status_at) > 3600e3)).map(e => e.id);
    if (stale.length) Bookmarks.check(stale);
  }
  if (view === 'sql') SQL.fit();
  if (view === 'inbox') Mail.status();
  if (view === 'groups') Groups.render();
  if (view === 'props') Props.load();
  if (view === 'ref') Ref.load();
  if (view === 'api') Api.load();
  if (view === 'ask' && typeof Ask !== 'undefined') Ask.show();
  if (view === 'jira') Jira.load();
  if (view === 'monitor') Monitor.load();
  if (view === 'cal') Cal.load();
  if (view === 'git') {
    Git.renderRepos();
    let last = ''; try { last = localStorage.getItem('gitRepo') || ''; } catch { /* ignore */ }
    if (!Git.repo && Git.repos().length) Git.open(Git.repos().includes(last) ? last : Git.repos()[0]);
  }
}
$('#nav').addEventListener('click', e => {
  const b = e.target.closest('button[data-view]'); if (!b) return;
  // Clicking the page you are on again (SSH, FTP, SQL, Tasks…) switches the
  // sidebar between icons only and full size.
  if (b.classList.contains('active') && !document.body.classList.contains('side-top') && !sidePinned()) {
    const collapsed = document.body.classList.contains('side-collapsed');
    animateSide();
    if (collapsed) { document.body.classList.remove('side-collapsed'); S.autoSide = false; S.userSide = WORK_VIEWS.includes(b.dataset.view); $('#sideToggle').textContent = '«'; } // "keep it open" only matters on the tree pages
    else {
      S.userSide = false; roomForWork();
      if (!WORK_VIEWS.includes(b.dataset.view)) S.autoSide = false; // your choice on a page that keeps the sidebar: it stays so
    }
    setTimeout(() => { fitActiveTerm(); window.dispatchEvent(new Event('resize')); }, 50);
    return;
  }
  show(b.dataset.view);
});
$('#navSearch').onclick = () => { show('dashboard'); $('#search').focus(); $('#search').select(); };

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    $('#search').focus(); $('#search').select(); // the search at the top right, from any page
  }
});

// ---------- environment switch (beside the search) ----------
// All · UAT · PROD: shows only that environment's connections, bookmarks and
// databases everywhere in WorkHub (UAT also covers UAT1, UAT2…). Remembered.
// Others (default) · UAT · PROD · All: UAT and PROD servers and databases are
// left out of every list, tree and search unless picked here (UAT also covers
// UAT1, UAT2…). The UAT / PROD buttons show how many are left out.
const EnvSwitch = {
  v: (() => { try { return localStorage.getItem('envSwitch') || ''; } catch { return ''; } })(),
  ok(e) {
    if (typeof Presenting !== 'undefined' && Presenting.on() && (e.env || '').toUpperCase().startsWith('PROD')) return false; // 🎬 no PROD on screen
    return this.v === 'ALL' || (this.v ? (e.env || '').toUpperCase().startsWith(this.v) : !guardedEnv(e));
  },
  paint() {
    $$('#envSwitch [data-envsw]').forEach(b => b.classList.toggle('active', b.dataset.envsw === this.v));
    $('#envSwitch').dataset.on = this.v;
    const n = g => (S.allEntries || []).filter(e => !e.hidden && guardedEnv(e) === g).length;
    for (const g of GUARDED_ENVS) { const c = $(`#envSwitch [data-envsw="${g}"] .envn`); if (c) c.textContent = !this.v && n(g) ? ' ' + n(g) : ''; }
  },
  set(v) {
    this.v = v; this.paint();
    try { localStorage.setItem('envSwitch', v); } catch { /* ignore */ }
    if (S.allEntries) redrawAll();
    toast(v === 'ALL' ? 'Showing every environment' : v ? `Showing only ${v} — everywhere in WorkHub` : 'UAT and PROD are hidden — pick them at the top to see them');
  },
};
EnvSwitch.paint();
$('#envSwitch').addEventListener('click', e => { const b = e.target.closest('[data-envsw]'); if (b && b.dataset.envsw !== EnvSwitch.v) EnvSwitch.set(b.dataset.envsw); });

// ---------- SSH switched off (sshswitch.go) ----------
// The SSH terminal, SFTP and log tailing stop here with a message; tunnels and
// remote compare are refused by WorkHub itself. FTP, databases and links work.
function sshBlocked(e) {
  if (!S.sshOff || (e && isFTP(e))) return false;
  toast('SSH is switched off in this version of WorkHub — SSH terminals, SFTP, tunnels and log tailing don\'t work. FTP, databases and links still do.', true);
  return true;
}
function sshOffNotes() {
  for (const v of ['terminal', 'files']) {
    const sec = $('#view-' + v); if (!sec) continue;
    let n = $('.sshoff-note', sec);
    if (!S.sshOff) { n?.remove(); continue; }
    if (!n) { n = document.createElement('div'); n.className = 'sshoff-note'; sec.prepend(n); }
    n.textContent = v === 'terminal' ? '⛔ SSH is switched off in this version of WorkHub: terminals to servers don\'t open (local command prompts still work).'
      : '⛔ SSH is switched off in this version of WorkHub: SFTP doesn\'t connect. FTP servers and This PC still work.';
  }
}

// ---------- sync ----------
async function refreshAll() {
  const [entries, clips, settings] = await Promise.all([api('GET', '/api/entries'), api('GET', '/api/clips'), api('GET', '/api/settings')]);
  S.allEntries = entries || [];
  S.clips = clips || []; S.settings = settings;
  await redrawAll();
}
// Draws every list again from S.allEntries, through the environment switch.
async function redrawAll() {
  // hidden = removed by the user, kept so it isn't re-imported
  S.entries = S.allEntries.filter(e => !e.hidden && EnvSwitch.ok(e));
  EnvSwitch.paint(); // the counts on UAT / PROD
  // Each part draws on its own so one failure can't blank the rest of the app.
  for (const [name, fn] of [['settings', renderSettings], ['filters', renderFilters], ['dashboard', renderBoard], ['captured', renderClips],
    ['outlook', () => Mail.render()], ['tree', () => Tree.render()], ['groups', () => Groups.render()], ['tabs', () => renderAllTabs()], ['bookmarks', () => Bookmarks.render()], ['notes', () => Notes.renderLists()]]) {
    try { await fn(); } catch (err) { console.error(`WorkHub: drawing ${name} failed:`, err); }
  }
}

async function poll() {
  try {
    const { v, data_dir, app_version, restarted, ssh_off, ssh_keys_off, os } = await api('GET', '/api/version');
    S.os = os; // 'darwin' on a Mac: Open in Terminal instead of PuTTY
    if (S.sshKeysOff !== !!ssh_keys_off) { S.sshKeysOff = !!ssh_keys_off; $$('[data-tool=sshkeys]').forEach(b => { b.hidden = S.sshKeysOff; }); }
    if (S.sshOff !== !!ssh_off) { S.sshOff = !!ssh_off; sshOffNotes(); }
    if (restarted) S.restarted = true; // WorkHub restarted itself (update / install): reopen the last session
    $('#dataDir').textContent = 'Data: ' + data_dir; S.dataDir = data_dir;
    $('#appVersion').textContent = 'Version ' + app_version;
    $('#appVersion').title = 'Data: ' + data_dir + ' — ☰ › ⚙ Settings › Data folder';
    if (v !== S.version) { S.version = v; await refreshAll(); }
  } catch (e) { if (e.message !== 'unauthorized') console.error('WorkHub refresh failed:', e); }
}
setInterval(poll, 2500);

// ---------- settings / capture ----------
function renderSettings() {
  $('#wsName').textContent = S.settings.workspace || 'Default';
  document.title = `WorkHub — ${S.settings.workspace || 'Default'}`;
  if (window.whSetTitle && document.title !== window.lastTitle) { window.lastTitle = document.title; window.whSetTitle(document.title); }
  $('#watchToggle').checked = !!S.settings.watch;
  const cap = $('#capBtn'), on = !!S.settings.watch;
  cap.classList.toggle('on', on);
  cap.innerHTML = on ? '<span class="capdot"></span>Capturing' : '⏸ Capture off';
  cap.title = on ? 'WorkHub is watching the clipboard. Click to pause it — e.g. if copy and paste in Windows misbehaves; WorkHub keeps running.' : 'Clipboard capture is paused: nothing you copy is read. Click to start it again.';
  $('#captureAll').checked = !!S.settings.capture_all;
  $('#bmSync').checked = !S.settings.no_browser_sync;
  if (document.activeElement !== $('#captureProject')) $('#captureProject').value = S.settings.project || 'General';
  $('#captureWhere').textContent = S.settings.project || 'General';
}
async function saveSettings(patch) {
  S.settings = await api('PUT', '/api/settings', { ...S.settings, ...patch });
  labelCache.clear();
  renderSettings();
}
$('#wsName').onclick = async () => {
  const n = await askText('Workspace name (e.g. the client this laptop is for)', S.settings.workspace || '');
  if (n && n.trim()) saveSettings({ workspace: n.trim() });
};
$('#capBtn').onclick = () => $('#watchToggle').click(); // the same switch, always in reach at the top
$('#settingsTop').onclick = () => Settings.open(); // ⚙ at the top right
document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === ',' && !e.altKey) { e.preventDefault(); Settings.open(); } }); // Ctrl+, as in most apps
$('#watchToggle').onchange = e => saveSettings({ watch: e.target.checked }).then(() => toast(e.target.checked ? 'Watching clipboard' : 'Clipboard watch paused'));
$('#captureAll').onchange = e => saveSettings({ capture_all: e.target.checked });
$('#captureProject').onchange = e => saveSettings({ project: e.target.value.trim() || 'General' });
$('#importBtn').onclick = async () => {
  toast('Pick the old WorkHub-data folder in the window that opened (it may be behind the browser)');
  try {
    const r = await api('POST', '/api/import');
    if (r.cancelled) return;
    toast(`Imported ${r.entries} connection(s) and ${r.notes} note(s)`);
    poll();
  } catch (err) { toast(err.message, true); }
};
$('#dataLocBtn').onclick = async () => {
  if (S.dataDir && !await askYes(`Your WorkHub data is in:\n${S.dataDir}\n\nChoose a different folder?`)) return;
  toast('Choose a folder in the window that opened (it may be behind the browser)');
  try {
    const r = await api('POST', '/api/datadir/pick');
    if (r.cancelled) return;
    if (r.current) return toast('That folder is already in use');
    let mode;
    if (r.has_data) {
      if (!await askYes(`Switch to the WorkHub data in:\n${r.path}\n\nWorkHub restarts and opens that data. Your current data stays where it is.`)) return;
      mode = 'use';
    } else {
      if (!await askYes(`Move this workspace's data to:\n${r.path}\n\nYour data is copied there (the old copy stays as a backup) and WorkHub restarts using it.`)) return;
      mode = 'copy';
    }
    await api('POST', '/api/datadir/set', { path: r.path, mode });
    document.body.innerHTML = '<div class="empty">Restarting WorkHub… a new tab opens in a few seconds. You can close this one.</div>';
  } catch (err) { toast(err.message, true); }
};
// ⚙ Settings → Session logs: switch saving on/off, search the text of past SSH
// sessions, open a day's log.
const SessionLogs = {
  async open() {
    $('#slogOn').checked = !!S.settings.session_log;
    $('#slogQ').value = '';
    $('#slogDlg').showModal();
    $('#slogQ').focus();
    this.load();
  },
  async load() {
    const q = $('#slogQ').value.trim();
    const r = await api('GET', '/api/sessionlogs' + (q ? '?q=' + encodeURIComponent(q) : '')).catch(err => ({ error: err.message }));
    const open = f => `data-slog="${esc(f)}" title="Open this log"`;
    if (r.error) { $('#slogList').innerHTML = `<div class="muted tiny">${esc(r.error)}</div>`; return; }
    if (!q) {
      $('#slogList').innerHTML = r.files.length ? r.files.slice(0, 200).map(f => `<div class="slog-row" ${open(f.file)}><b>${esc(f.host)}</b><span>${esc(f.day)}</span><span class="muted tiny">${fmtSize(f.size)}</span></div>`).join('')
        : `<div class="muted tiny" style="padding:8px">${S.settings.session_log ? 'No logs yet — they appear after your next SSH session.' : 'Nothing saved yet. Switch on “Save the text of SSH sessions” above.'}</div>`;
      return;
    }
    const mark = t => esc(t).replace(new RegExp(q.split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi'), m => `<mark>${m}</mark>`);
    $('#slogList').innerHTML = r.hits.length ? r.hits.map(h => `<div class="slog-row hit" ${open(h.file)}><b>${esc(h.host)}</b><span>${esc(h.day)} ${esc(h.time)}</span><code>${mark(h.text)}</code></div>`).join('')
      + (r.hits.length >= 300 ? '<div class="muted tiny">First 300 matches — add another word to narrow it down.</div>' : '')
      : '<div class="muted tiny" style="padding:8px">No matches.</div>';
  },
};
$('#slogOn').onchange = async e => { await saveSettings({ session_log: e.target.checked }); toast(e.target.checked ? 'SSH sessions you open from now on are saved' : 'SSH sessions are no longer saved'); SessionLogs.load(); };
{ let t; $('#slogQ').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => SessionLogs.load(), 250); }); }
$('#slogList').addEventListener('click', e => { const r = e.target.closest('[data-slog]'); if (r) api('POST', '/api/sessionlogs/open', { file: r.dataset.slog }).catch(err => toast(err.message, true)); });
$('#slogFolder').onclick = () => api('POST', '/api/sessionlogs/open', {}).catch(err => toast(err.message, true));
$('#slogClose').onclick = () => $('#slogDlg').close();

// ⚙ Settings → where the data is: open it in Explorer, or copy the path.
const DataDir = {
  short: p => { const parts = (p || '').split(/[\\/]/).filter(Boolean); return parts.length > 3 ? '…' + (p.includes('\\') ? '\\' : '/') + parts.slice(-3).join(p.includes('\\') ? '\\' : '/') : p; },
  open: () => api('POST', '/api/datadir/open').catch(err => toast(err.message, true)),
};
// File → Restart WorkHub: saves what is being typed, remembers the open
// connections (they reconnect after the restart) and starts WorkHub again.
async function restartApp() {
  const o = openSessions(), conns = o.ssh.length + o.ftp + o.sql;
  const warn = [
    ...SQL.tabs.filter(t => t.inTx).map(t => `${t.entry.name}: uncommitted SQL changes will be rolled back`),
    ...(typeof Ref !== 'undefined' && Ref.dirty ? ['the file open in Folders has unsaved changes'] : []),
  ];
  if ((conns || warn.length) && !await askYes(`Restart WorkHub?${conns ? `\n\nOpen connections (${[o.ssh.length && o.ssh.length + ' SSH', o.ftp && o.ftp + ' FTP', o.sql && o.sql + ' SQL'].filter(Boolean).join(', ')}) reconnect by themselves afterwards.` : ''}${warn.length ? '\n\n⚠ ' + warn.join('\n⚠ ') : ''}`)) return;
  for (const d of Notes.docs.filter(d => d.dirty)) await Notes.save(d).catch(() => {});
  Session.save();
  try { await api('POST', '/api/restart'); }
  catch (err) { return toast(`Couldn't restart: ${err.message} — close WorkHub and open it again`, true); }
  stoppedScreen(`<h2>↻ Restarting WorkHub…</h2><p>${window.WH_DESKTOP ? 'Its window opens again in a few seconds.' : 'A new tab opens in a few seconds — you can close this one.'}</p>`);
}
// Covers the page once WorkHub has stopped or is restarting (the page underneath
// stays, so its timers don't trip over missing parts).
function stoppedScreen(html) {
  document.querySelectorAll('dialog[open]').forEach(d => d.close());
  const d = document.createElement('div'); d.className = 'stopped'; d.innerHTML = `<div>${html}</div>`;
  document.body.append(d);
}
$('#quitBtn').onclick = async () => {
  if (!await askYes('Quit WorkHub? Open terminals and transfers will stop.')) return;
  await api('POST', '/api/quit').catch(() => {});
  stoppedScreen('<h2>WorkHub has stopped.</h2><p>You can close this tab.</p>');
};

// ---------- dashboard ----------
function renderFilters() {
  const projects = [...new Set([...S.entries.map(e => e.project), S.settings.project].filter(Boolean))].sort();
  $('#projectList').innerHTML = projects.map(p => `<option value="${esc(p)}">`).join('');
  const fill = (sel, values, label) => {
    const cur = sel.value;
    sel.innerHTML = `<option value="">${label}</option>` + values.map(v => `<option ${v === cur ? 'selected' : ''}>${esc(v)}</option>`).join('');
  };
  fill($('#fProject'), projects, 'All projects');
  fill($('#fEnv'), [...new Set(S.entries.map(e => e.env).filter(Boolean))].sort(), 'All envs');
}
