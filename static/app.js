'use strict';

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
    document.body.innerHTML = '<div class="empty">Session expired. Start <b>WorkHub</b> again to open a fresh window.</div>';
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
  toast(list.length === 1 ? `Deleted ${list[0].name}` : `Deleted ${list.length} entries`, false, async () => {
    for (const e of list) await api('POST', '/api/entries', { ...entryInput(e), id: '', password: e.password }).catch(err => toast(err.message, true));
    poll(); toast('Restored');
  });
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
const WORK_VIEWS = ['terminal', 'files', 'sql', 'tasks', 'ref', 'jira', 'groups', 'notes', 'git', 'cal'];
function roomForWork() {
  if (document.body.classList.contains('side-top')) return; // a bar across the top takes no room from the tree
  if (S.userSide || document.body.classList.contains('side-collapsed')) return;
  document.body.classList.add('side-collapsed'); S.autoSide = true;
  $('#sideToggle').textContent = '»';
  setTimeout(() => { fitActiveTerm(); window.dispatchEvent(new Event('resize')); }, 50);
}
function show(view) {
  if (WORK_VIEWS.includes(view)) roomForWork();
  else if (S.userSide) S.userSide = false;
  else if (S.autoSide) { // put the sidebar back as it was
    S.autoSide = false;
    applySide();
  }
  $$('#nav button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $('#pageTitle').textContent = $(`#nav [data-view="${view}"] .nl`)?.textContent || '';
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
  history.replaceState(null, '', '#' + view);
  if (view === 'terminal') { fitActiveTerm(); if (!Term.tabs.length) Term.emptyHTML(); }
  if (view === 'files') Jobs.tick();
  if (view === 'files' && !Local.loaded) Local.load(lsGet('ftp.local'), true).then(() => { if (!Local.loaded) Local.load(''); });
  if (view === 'notes') { Notes.cm.refresh(); Notes.cm.focus(); }
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
  if (view === 'jira') Jira.load();
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
  if (b.classList.contains('active') && !document.body.classList.contains('side-top')) {
    const collapsed = document.body.classList.contains('side-collapsed');
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

// ---------- sync ----------
async function refreshAll() {
  const [entries, clips, settings] = await Promise.all([api('GET', '/api/entries'), api('GET', '/api/clips'), api('GET', '/api/settings')]);
  S.allEntries = entries || [];
  S.entries = S.allEntries.filter(e => !e.hidden); // hidden = removed by the user, kept so it isn't re-imported
  S.clips = clips || []; S.settings = settings;
  // Each part draws on its own so one failure can't blank the rest of the app.
  for (const [name, fn] of [['settings', renderSettings], ['filters', renderFilters], ['dashboard', renderBoard], ['captured', renderClips],
    ['outlook', () => Mail.render()], ['tree', () => Tree.render()], ['groups', () => Groups.render()], ['tabs', () => renderAllTabs()], ['bookmarks', () => Bookmarks.render()], ['notes', () => Notes.renderLists()]]) {
    try { await fn(); } catch (err) { console.error(`WorkHub: drawing ${name} failed:`, err); }
  }
}

async function poll() {
  try {
    const { v, data_dir, app_version } = await api('GET', '/api/version');
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
$('#wsName').onclick = () => {
  const n = prompt('Workspace name (e.g. the client this laptop is for)', S.settings.workspace || '');
  if (n && n.trim()) saveSettings({ workspace: n.trim() });
};
$('#watchToggle').onchange = e => saveSettings({ watch: e.target.checked }).then(() => toast(e.target.checked ? 'Watching clipboard' : 'Clipboard watch paused'));
$('#captureAll').onchange = e => saveSettings({ capture_all: e.target.checked });
$('#captureProject').onchange = e => saveSettings({ project: e.target.value.trim() || 'General' });
$('#importBtn').onclick = async () => {
  toast('Pick the old workhub-data folder in the window that opened (it may be behind the browser)');
  try {
    const r = await api('POST', '/api/import');
    if (r.cancelled) return;
    toast(`Imported ${r.entries} connection(s) and ${r.notes} note(s)`);
    poll();
  } catch (err) { toast(err.message, true); }
};
$('#dataLocBtn').onclick = async () => {
  if (S.dataDir && !confirm(`Your WorkHub data is in:\n${S.dataDir}\n\nChoose a different folder?`)) return;
  toast('Choose a folder in the window that opened (it may be behind the browser)');
  try {
    const r = await api('POST', '/api/datadir/pick');
    if (r.cancelled) return;
    if (r.current) return toast('That folder is already in use');
    let mode;
    if (r.has_data) {
      if (!confirm(`Switch to the WorkHub data in:\n${r.path}\n\nWorkHub restarts and opens that data. Your current data stays where it is.`)) return;
      mode = 'use';
    } else {
      if (!confirm(`Move this workspace's data to:\n${r.path}\n\nYour data is copied there (the old copy stays as a backup) and WorkHub restarts using it.`)) return;
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
$('#quitBtn').onclick = async () => {
  if (!confirm('Quit WorkHub? Open terminals and transfers will stop.')) return;
  await api('POST', '/api/quit').catch(() => {});
  document.body.innerHTML = '<div class="empty">WorkHub has stopped. You can close this tab.</div>';
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

// ---------- search ----------
// Every word must appear somewhere (name, host, URL, user, notes, naming-rule
// label, type…); "-word" leaves out. key:value narrows further, e.g.
// env:prod type:db user:ops app:batch port:1521 has:password no:env is:fail
// needs:attention. Typing acmebat01 also finds acme-bat-01.
const SEARCH_KEYS = /^(env|type|user|app|port|host|project|in|tag|has|no|is|needs):(.+)$/;
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
    serverType(e), dbKindOf(e), ...(e.tags || []), ...Object.entries(e.extra || {}).flat()].filter(Boolean).join(' ').toLowerCase();
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

function filtered() {
  let q = $('#search').value.trim().toLowerCase();
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
// JDBC string for a database connection, built from host, port and service/SID/database.
function jdbcURL(e) {
  if (!canDB(e)) return '';
  const kind = dbKindOf(e), svc = dbService(e), port = e.port || (kind === 'oracle' ? 1521 : 5432);
  if (kind === 'postgres') return `jdbc:postgresql://${e.host}:${port}/${svc?.name || ''}`;
  return svc?.sid ? `jdbc:oracle:thin:@${e.host}:${port}:${svc.name}` : `jdbc:oracle:thin:@//${e.host}:${port}${svc ? '/' + svc.name : ''}`;
}
// Status dot: green = last connection/link check worked, red = failed, grey = not tried.
function dot(e) {
  const when = e.status_at ? new Date(e.status_at).toLocaleString() : '';
  const title = e.status === 'ok' ? `Worked last time · ${when}` : e.status === 'fail' ? `Failed · ${when}\n${e.status_msg || ''}` : 'Not tried yet';
  return `<span class="dot ${e.status || 'none'}" title="${esc(title)}"></span>`;
}

function renderStats(list) {
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
  $('#stats').innerHTML = (fix ? `<button class="stat warn" data-find="needs:attention" title="Connections with something missing (user, password, environment, service name) or a failed login — click to list them"><b>⚠ ${fix}</b><span>Need attention</span></button>` : '')
    + ((n => n ? `<button class="stat inbox" data-find="is:unsorted" title="New captures you haven't looked at yet — each with a suggested folder"><b>📥 ${n}</b><span>New to sort</span></button>` : '')(S.entries.filter(e => e.unsorted).length))
    + (capturedToday ? `<button class="stat" data-view-go="inbox" title="Open Captured"><b>${capturedToday}</b><span>Captured today</span></button>` : '')
    + `<button class="stat act" id="retestBtn" title="Try every connection shown (SSH, SFTP/FTP, databases) with its saved login and update ✓ / ✗"><b>↻</b><span>Re-test ${list.filter(isConn).length} connections</span></button>`
    + `<div class="stat-line">${counts.map(([k, v, f]) => f ? `<a href="#" data-find="${f}">${v} ${k}</a>` : `<span>${v} ${k}</span>`).join(' · ')}</div>`;
  $('#inboxCount').textContent = capturedToday || '';
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
  return `<span class="inboxrow">📥 New capture${sg ? ` — belongs in <b>${esc(sg.project)}</b>${sg.env ? ' · ' + esc(sg.env) : ''}?` : ''}
    <button class="icon primary" data-act="accept" data-id="${e.id}">${sg ? '✓ Move there' : '✓ Looks right'}</button>${sg ? `<button class="icon" data-act="keep" data-id="${e.id}">Keep in ${esc(e.project)}</button>` : ''}<button class="icon" data-act="edit" data-id="${e.id}">Edit…</button></span>`;
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
      `<button data-saved="${i}" class="${x.query.toLowerCase() === q ? 'active' : ''}" title="${esc(x.query)}"><span class="ni sv">★</span><span class="nl">${esc(x.name)}</span><span class="count">${S.entries.filter(e => matches(e, x.query.toLowerCase())).length || ''}</span></button>`).join('') : '';
  },
  async save() {
    const q = $('#search').value.trim(); if (!q) return;
    const name = prompt('Name for this search (shown in the sidebar):', q.replace(/\b\w+:/g, '').trim() || q); if (!name?.trim()) return;
    await this.put([...this.all().filter(x => x.name !== name.trim()), { name: name.trim(), query: q }]);
    toast(`Saved “${name.trim()}” — it's in the sidebar`);
  },
  run(i) { const x = this.all()[i]; if (!x) return; show('dashboard'); $('#search').value = x.query; S.kbSel = 0; renderBoard(); },
};

function renderBoard() {
  renderViewChips();
  viewSummary();
  const list = filtered();
  renderStats(list);
  const board = $('#board');
  if (!S.entries.length) {
    board.innerHTML = `<div class="empty">Nothing collected yet.<br><br>Turn on <b>Watch clipboard</b> and copy text that contains hosts, URLs or logins,<br>or paste it on the <b>Captured</b> page.</div>`;
    return;
  }
  const jira = jiraMatches($('#search').value), threads = threadMatches($('#search').value);
  if (!list.length && !jira.length && !threads.length) { board.innerHTML = '<div class="empty">No matches.</div>'; S.kbList = []; Bulk.bar(); Saved.render(); return; }
  const keyOf = {
    env: e => e.env || 'No environment', protocol: e => e.protocol || 'other', status: e => ({ ok: 'Working', fail: 'Failed' }[e.status] || 'Not tried'),
    host: e => e.host || e.url || e.name, none: () => 'All', project: e => e.project || 'General',
  }[S.groupBy] || (e => e.project || 'General');
  const groups = {};
  list.forEach(e => (groups[keyOf(e)] ||= []).push(e));
  S.kbList = list; S.kbSel = Math.min(S.kbSel || 0, list.length - 1);
  Saved.render();
  const fixNote = S.fixes ? `<div class="fuzzy-note">No exact match — showing ${Object.entries(S.fixes).map(([a, b]) => `<b>${esc(b)}</b> for “${esc(a)}”`).join(', ')}. <a href="#" data-usefix>Use this spelling</a></div>` : '';
  const inbox = list.filter(e => e.unsorted), sortable = inbox.filter(suggestPlace).length;
  const inboxNote = /\bis:(unsorted|new)\b/.test($('#search').value) && inbox.length ? `<div class="fuzzy-note">📥 ${inbox.length} new capture(s) to sort. ${sortable ? `<button class="primary" data-acceptall>✓ Move all ${sortable} to their suggested folders</button>` : ''} <button data-keepall>Keep all where they are</button></div>` : '';
  if (S.layout === 'grid') { board.innerHTML = fixNote + inboxNote + gridHTML(list) + threadResultsHTML(threads) + jiraResultsHTML(jira); markKbSel(); Bulk.bar(); return; }
  // Searching: the group holding the best match comes first (Object keys keep list order).
  board.innerHTML = fixNote + inboxNote + (S.ranked ? Object.keys(groups) : Object.keys(groups).sort()).map(g => {
    const items = groups[g];
    const body = S.layout === 'table' ? tableHTML(items) : cardsHTML(items);
    return `<div class="group"><div class="group-head"><h3>${esc(g)}</h3><span class="n">${items.length}</span>
      ${S.groupBy === 'project' ? `<button class="icon ghost" data-act="rename-project" data-project="${esc(g)}" title="Rename project">✎</button>` : ''}</div>${body}</div>`;
  }).join('') + threadResultsHTML(threads) + jiraResultsHTML(jira);
  markKbSel();
  Bulk.bar();
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
function threadResultsHTML(list) {
  if (!list.length) return '';
  const words = parseQuery($('#search').value.trim().toLowerCase()).words.filter(w => !w.neg).map(w => w.v);
  // A few words around the first match, passwords dotted out.
  const snippet = w => {
    const t = w.search.replace(/\s+/g, ' '), i = Math.max(0, ...words.map(x => t.indexOf(x)).filter(i => i >= 0).slice(0, 1));
    if (w.title.toLowerCase().includes(words[0]) && !t.includes(words[0])) return '';
    return (i > 50 ? '…' : '') + t.slice(Math.max(0, i - 50), i + 110) + '…';
  };
  const st = w => `<span class="wstatus ${w.status}">${esc((STATUSES.find(s => s[0] === w.status) || STATUSES[0])[1])}</span>`;
  return `<div class="group"><div class="group-head"><h3>🧵 Tasks</h3><span class="n">${list.length}</span></div><div class="cards">${list.map(w =>
    `<div class="card tcard" data-thread="${w.id}" title="Open the thread"><div class="card-head">${st(w)} <b>${esc(w.title)}</b><span class="spacer"></span><span class="muted tiny">${fmtTime(w.updated)} · ${w.posts || 0} posts</span></div>
      ${snippet(w) ? `<div class="muted tiny tsnip">${maskedText(snippet(w))}</div>` : ''}</div>`).join('')}</div></div>`;
}

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
      ${es.map(svcHTML).join('')}
    </div>`;
  }).join('') + '</div>';
}

function warnChip(e) {
  const p = problems(e);
  // a missing password alone is common (keys, SSO): shown quietly
  return p.length ? `<button class="warnchip${p.length === 1 && p[0][0] === 'password' ? ' soft' : ''}" data-act="edit" data-id="${e.id}" title="${esc(p.map(x => '• ' + x[1]).join('\n'))}\nClick to fill in${p.some(x => x[0] === 'password') ? ' (or tick “Logs in with a key / SSO”)' : ''}">⚠ ${p.length === 1 ? esc(p[0][1]) : p.length + ' to fix'}</button>` : '';
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
  const label = [dot(e), (e.protocol || dbKindOf(e)) && `<span class="proto">${esc(e.protocol || dbKindOf(e))}</span>`, e.port && `<span class="proto">:${e.port}</span>`, cardName(e), warnChip(e),
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
  Object.entries(e.extra || {}).filter(([k]) => k !== 'run_macros').forEach(([k, v]) => rows.push([esc(EXTRA_LABELS[k] || k) + (k === 'commands' ? (e.extra.run_macros === '1' ? ' ▶' : ' (off)') : ''), `<span class="copy" data-copy="${esc(v)}" style="white-space:pre-wrap">${esc(v)}</span>`]));
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

$('#board').addEventListener('contextmenu', ev => {
  const d = ev.target.closest('[data-detail]'); if (!d || ev.target.closest('a, input')) return;
  ev.preventDefault();
  Tree.menu(ev, { dataset: { id: d.dataset.detail } }, 'board');
});
$('#board').addEventListener('click', async ev => {
  const jo = ev.target.closest('[data-jopen]'); if (jo) return openExternal(jo.dataset.jopen);
  const th = !ev.target.closest('[data-eye]') && ev.target.closest('[data-thread]'); if (th) return Work.open(th.dataset.thread);
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
      case 'del': return deleteEntries([e]);
      case 'more': { const r = b.getBoundingClientRect(); return setTimeout(() => Tree.menu({ clientX: r.left, clientY: r.bottom }, { dataset: { id: e.id } }, 'board')); }
      case 'fav': await api('POST', '/api/entries', { ...entryInput(e), favorite: !e.favorite }); return poll();
      case 'rename-project': {
        const to = prompt('Rename project', b.dataset.project);
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
    ...Object.entries(e.extra || {}).filter(([k]) => !DB_KEYS.includes(k)).map(([k, v]) => EXTRA_LABELS[k] ? [EXTRA_LABELS[k], k === 'run_macros' ? 'yes' : k === 'auth' ? 'key / SSO (no password needed)' : v] : [k, v]),
    ['Tags', (e.tags || []).join(', ')], ['Notes', e.notes],
    ['Last used', when(e.last_used)],
    ...(e.captures?.length ? e.captures.slice().reverse().map((c, i) => [i ? 'Also captured' : 'Captured', `${when(c.at)} · ${sourceName(c)}`]) : [['Captured', captureText(e)]]),
    ['Status', e.status ? `${e.status === 'ok' ? 'Worked' : 'Failed'} · ${when(e.status_at)}${e.status_msg ? '\n' + e.status_msg : ''}` : ''],
  ].filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '');
  return rows;
}
const detailsText = e => detailRows(e).map(([k, v]) => `${k}: ${v}`).join('\n');

function showDetails(e) {
  if (!e) return;
  const rows = detailRows(e);
  showDetails.text = detailsText(e);
  $('#detailTitle').innerHTML = `${ruleName(e)} ${e.env ? `<span class="badge ${esc(e.env)}">${esc(e.env)}</span>` : ''}`;
  const secret = k => /password/i.test(k);
  $('#detailBody').innerHTML = rows.map(([k, v]) => `<span class="k">${esc(k)}</span>${secret(k) ? `<span class="v pwbox"><span class="pwv" data-pw="${esc(v)}">${S.showPw ? esc(v) : PW_MASK}</span><button class="icon eye" data-eye title="Show / hide">👁</button></span>` : `<span class="v">${esc(v)}</span>`}<button class="icon copyic" data-copy="${esc(v)}" title="Copy ${esc(k)}" aria-label="Copy ${esc(k)}">${COPY_ICON}</button>`).join('');
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
    if (canSSH(e)) return Term.open(e);
    if (canDB(e)) return SQL.open(e);
    if (canFiles(e)) return Remote.connect(e);
    if (e.url) return openURL(e);
    showDetails(e);
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
    ['Rename…', () => { const n = prompt('Name:', x.name); if (n?.trim()) Saved.put(list.map((y, j) => j === i ? { ...y, name: n.trim() } : y)); }],
    ['Change the search…', () => { const q = prompt('Search (words and filters like env:prod app:batch):', x.query); if (q?.trim()) Saved.put(list.map((y, j) => j === i ? { ...y, query: q.trim() } : y)); }],
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
    case 'move': { const p = prompt('Move to folder (use / for subfolders):', Bulk.entries()[0]?.project || ''); if (p?.trim()) await Bulk.each('Moved', e => Bulk.save(e, { project: p.trim() })); break; }
    case 'tag': { const t = prompt('Add tag(s), comma separated:'); const add = (t || '').split(',').map(x => x.trim()).filter(Boolean); if (add.length) await Bulk.each('Tagged', e => Bulk.save(e, { tags: [...new Set([...(e.tags || []), ...add])] })); break; }
    case 'test': return retest(Bulk.entries());
    case 'key': return Bulk.each('Marked as key login', e => Bulk.save(e, { extra: { ...(e.extra || {}), auth: 'key' } }));
    case 'delete': { const list = Bulk.entries(); if (list.length < 10 || confirm(`Delete ${list.length} entries?`)) { Bulk.picked.clear(); await deleteEntries(list); } break; }
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
  list = list.filter(isConn);
  if (!list.length) return toast('No connections to test here', true);
  if (list.length > 10 && !confirm(`Test ${list.length} connections now? Each one logs in once with its saved details.`)) return;
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
    return `<div class="clip"><div class="clip-head"><span>${new Date(c.created).toLocaleString()}</span><span class="proto">${esc(c.source)}</span><span>${esc(c.project)}</span>
      <span class="spacer"></span><button class="icon more" data-clipmore="${c.id}" title="Copy or delete this capture">⋯</button></div>
      <pre>${maskedText(c.text)}</pre><div class="chips">${chips || '<span class="muted tiny">no hosts or credentials recognised</span>'}</div></div>`;
  }).join('');
}
$('#clips').addEventListener('click', async e => {
  const chip = e.target.closest('[data-find]');
  if (chip) { $('#search').value = chip.dataset.find; $('#fProject').value = ''; $('#fEnv').value = ''; show('dashboard'); return renderBoard(); }
  const more = e.target.closest('[data-clipmore]');
  if (more) {
    const c = S.clips.find(x => x.id === more.dataset.clipmore); if (!c) return;
    const r = more.getBoundingClientRect();
    setTimeout(() => Tree.showMenu({ clientX: r.left - 150, clientY: r.bottom }, [
      ['Copy the text', () => copyText(c.text)],
      ['🧵 Add to task thread…', () => Work.addClip(c, { clientX: r.left - 150, clientY: r.bottom })],
      ['Delete this capture', async () => {
        await api('DELETE', `/api/clips/${c.id}`); poll();
        toast('Capture deleted', false, async () => { await api('POST', '/api/ingest', { text: c.text, source: c.source, project: c.project }); poll(); toast('Restored'); });
      }]]));
  }
});
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

// ---------- terminal ----------
// Looks like PuTTY's defaults: Courier New, light grey on black, PuTTY's
// 16 colours, a steady green block cursor.
const PUTTY_FONT = '"Courier New", Courier, "Liberation Mono", monospace';
const PUTTY_THEME = {
  background: '#000000', foreground: '#bbbbbb', cursor: '#00ff00', cursorAccent: '#000000', selectionBackground: '#bbbbbb', selectionForeground: '#000000',
  black: '#000000', red: '#bb0000', green: '#00bb00', yellow: '#bbbb00', blue: '#0000bb', magenta: '#bb00bb', cyan: '#00bbbb', white: '#bbbbbb',
  brightBlack: '#555555', brightRed: '#ff5555', brightGreen: '#55ff55', brightYellow: '#ffff55', brightBlue: '#5555ff', brightMagenta: '#ff55ff', brightCyan: '#55ffff', brightWhite: '#ffffff',
};

const Term = {
  tabs: [], active: null,

  async open(e) {
    let creds = {};
    if (needsCreds(e)) { creds = await askCreds(e); if (!creds) return; }
    this.create(e, creds, null);
  },

  // A command prompt on this PC (cmd, PowerShell, Git Bash, or the Mac shell).
  openLocal(sh, dir = '') {
    const label = sh.name + (dir ? ' · ' + dir.split(/[\\/]/).filter(Boolean).pop() : '');
    this.create({ id: 'local:' + sh.id, host: 'This PC', name: label, username: '' }, {}, { shell: sh.id, dir, label });
  },

  create(e, creds, local) {
    show('terminal'); roomForWork();
    const el = document.createElement('div');
    el.className = 'termhost';
    $('#termWrap').append(el);
    const term = new Terminal({ cursorBlink: false, cursorStyle: 'block', fontSize: Fonts.size('term'), scrollback: 20000, fontFamily: PUTTY_FONT, theme: PUTTY_THEME, drawBoldTextInBrightColors: true, minimumContrastRatio: 1 });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(el);
    const t = { id: Math.random().toString(36).slice(2), entry: e, creds, term, fit, el, ws: null, closed: true, local };
    this.tabs.push(t);
    // PuTTY-style: selecting copies, right-click pastes, Enter on a dead session reconnects.
    term.onSelectionChange(() => { const s = term.getSelection(); if (s) navigator.clipboard.writeText(s).catch(() => {}); });
    el.addEventListener('contextmenu', async ev => {
      ev.preventDefault();
      try { const txt = await navigator.clipboard.readText(); if (txt && !t.closed) t.ws.send(JSON.stringify({ t: 'd', d: txt })); } catch { toast('Allow clipboard access to paste with right-click (or use Ctrl+V)', true); }
    });
    term.onData(d => {
      if (t.closed) { if (d === '\r') this.connect(t); return; }
      t.ws.send(JSON.stringify({ t: 'd', d }));
    });
    term.onResize(({ cols, rows }) => { if (!t.closed) t.ws.send(JSON.stringify({ t: 'r', cols, rows })); });
    this.activate(t);
    this.connect(t);
    Tree.render();
  },

  connect(t) {
    t.fit.fit();
    const ws = new WebSocket(t.local
      ? `ws://${location.host}/ws/local?shell=${encodeURIComponent(t.local.shell)}&dir=${encodeURIComponent(t.local.dir)}`
      : `ws://${location.host}/ws/term?id=${encodeURIComponent(t.entry.id)}`);
    ws.binaryType = 'arraybuffer';
    t.ws = ws;
    ws.onopen = () => {
      t.closed = false;
      ws.send(JSON.stringify({ t: 'start', cols: t.term.cols, rows: t.term.rows, ...t.creds }));
      t.creds = { ...t.creds, save: false };
      this.renderTabs();
      this.startMacros(t);
    };
    ws.onmessage = m => { t.term.write(new Uint8Array(m.data)); t.macroKick?.(); };
    ws.onclose = () => {
      t.closed = true;
      t.term.write('\r\n\x1b[90m[disconnected - press Enter to reconnect]\x1b[0m\r\n');
      this.renderTabs();
    };
  },

  // "Run macros": the saved commands are typed in one at a time, each when
  // the output has been quiet for a moment (so the prompt is back).
  startMacros(t) {
    t.macroKick = null;
    const ex = t.entry.extra || {};
    if (t.local || ex.run_macros !== '1' || !ex.commands) return;
    const queue = ex.commands.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
    if (t.entry.env === 'PROD' && !confirm(`${t.entry.name} is a PRODUCTION server.\n\nRun these commands on it now?\n\n${queue.join('\n')}`)) return toast('Commands not run (PROD)');
    let timer = null, seen = false;
    const next = () => {
      if (t.closed || t.ws?.readyState !== 1) { t.macroKick = null; return; }
      const cmd = queue.shift();
      if (cmd === undefined) { t.macroKick = null; return; }
      t.ws.send(JSON.stringify({ t: 'd', d: cmd + '\r' }));
      if (!queue.length) t.macroKick = null;
    };
    t.macroKick = () => { seen = true; clearTimeout(timer); timer = setTimeout(next, 700); };
    setTimeout(() => { if (!seen && t.macroKick) next(); }, 5000); // a server that prints nothing at login
  },

  activate(t) {
    this.active = t;
    this.tabs.forEach(x => x.el.classList.toggle('active', x === t));
    $('#termWrap').classList.toggle('prod', !!t && !t.local && t.entry.env === 'PROD');
    $('#termEmpty').style.display = t ? 'none' : '';
    if (!t) this.emptyHTML();
    this.renderTabs();
    if (t) requestAnimationFrame(() => { t.fit.fit(); t.term.focus(); });
  },

  // With no session open: the servers you used last, one click to reconnect.
  emptyHTML() {
    const recent = S.entries.filter(e => canSSH(e) && e.last_used).sort((a, b) => Date.parse(b.last_used) - Date.parse(a.last_used)).slice(0, 8);
    $('#termEmpty').innerHTML = (recent.length ? `<div class="recent-h">Reconnect</div><div class="recent-chips">${recent.map(e => `<button data-recent="${e.id}" title="${esc(e.name)}\nlast used ${esc(new Date(e.last_used).toLocaleString())}">${e.env ? `<span class="badge ${esc(e.env)}">${esc(e.env)}</span> ` : ''}${esc(e.username ? e.username + '@' : '')}${esc(e.host)}${sshPort(e) !== 22 ? ':' + sshPort(e) : ''}</button>`).join('')}</div>` : '')
      + '<div class="muted">Double-click a server in the tree, use Quick connect,<br>or open a command prompt on this PC with the buttons above.</div>';
  },

  close(t) {
    t.closed = true;
    t.ws?.close();
    t.term.dispose();
    t.el.remove();
    this.tabs = this.tabs.filter(x => x !== t);
    this.activate(this.tabs.at(-1) || null);
    Tree.render();
  },

  renderTabs() {
    $('#termTabs').innerHTML = this.tabs.map(t => `<div class="tab ${t === this.active ? 'active' : ''} ${!t.local && t.entry.env === 'PROD' ? 'prod' : ''}" data-t="${t.id}" ${!t.local && t.entry.env === 'PROD' ? 'title="PRODUCTION server"' : ''}>
      <span style="color:${t.closed ? 'var(--muted)' : 'var(--ok)'}">●</span>${!t.local && t.entry.env === 'PROD' ? '<span class="badge PROD">PROD</span>' : ''}${typeof Groups !== 'undefined' ? Groups.chip(t.local ? t.local.label + ' ' + t.local.dir : Groups.entryText(t.entry)) : ''}${t.local ? '⌨ ' + esc(t.local.label) : esc((t.creds.username || t.entry.username || '') + '@' + t.entry.host)}
      <span class="x" data-x="${t.id}">✕</span></div>`).join('')
      + (this.tabs.filter(t => !t.local && !t.closed).length > 1 ? '<button class="icon tabs-end" data-xall title="Close every SSH terminal (command prompts on this PC stay)">⏏ Disconnect all</button>' : '');
    $('#termCount').textContent = this.tabs.filter(t => !t.closed).length || '';
  },
};
function fitActiveTerm() { if (Term.active) requestAnimationFrame(() => Term.active.fit.fit()); }
window.addEventListener('resize', fitActiveTerm);
$('#termTabs').addEventListener('click', e => {
  if (e.target.closest('[data-xall]')) return Term.tabs.filter(t => !t.local && !t.closed).forEach(t => Term.close(t));
  const x = e.target.closest('[data-x]');
  if (x) return Term.close(Term.tabs.find(t => t.id === x.dataset.x));
  const tab = e.target.closest('[data-t]');
  if (tab) Term.activate(Term.tabs.find(t => t.id === tab.dataset.t));
});

async function quickConnect() {
  const m = $('#qcHost').value.trim().match(/^(?:([^@\s]+)@)?([^:\s]+)(?::(\d+))?$/);
  if (!m) return toast('Use user@host or user@host:port', true);
  const [, user = '', host, port = '22'] = m;
  let e = S.entries.find(x => x.host.toLowerCase() === host.toLowerCase() && (x.username || '') === user && (x.port || 22) === +port && canSSH(x));
  if (!e) {
    e = await api('POST', '/api/entries', { project: S.settings.project || 'General', host, port: +port, username: user, protocol: 'ssh' });
    await poll();
  }
  Term.open(e);
}
$('#qcGo').onclick = () => quickConnect().catch(err => toast(err.message, true));
$('#qcHost').addEventListener('keydown', e => { if (e.key === 'Enter') $('#qcGo').click(); });

// ---------- files (local + SFTP) ----------
function makePane(root, loader) {
  const pane = {
    root, path: '', parent: '', sep: '/', items: [], sel: new Set(), loaded: false,
    async load(p, quiet) {
      try {
        const r = await loader(p);
        Object.assign(pane, { path: r.path, parent: r.parent, items: r.entries || [], sep: r.sep || '/', loaded: true, roots: !!r.roots });
        pane.sel.clear();
        $('.path', root).value = r.path;
        pane.render();
      } catch (err) { if (!quiet) toast(err.message, true); }
    },
    join(name) { return pane.roots ? name : pane.path.endsWith(pane.sep) ? pane.path + name : pane.path + pane.sep + name; },
    sortBy: (() => { try { return JSON.parse(localStorage.getItem('sort.' + root.id)); } catch { return null; } })() || { key: 'mtime', dir: -1 },
    sorted() {
      const { key, dir } = pane.sortBy;
      const val = f => key === 'name' ? f.name.toLowerCase() : key === 'type' ? fileType(f) : key === 'size' ? f.size : new Date(f.mtime).getTime() || 0;
      // Folders stay above files (like FileZilla); both follow the chosen order.
      return [...pane.items].sort((a, b) => (b.dir - a.dir) || (val(a) < val(b) ? -dir : val(a) > val(b) ? dir : a.name.localeCompare(b.name)));
    },
    render() {
      const { key, dir } = pane.sortBy;
      const col = (k, label) => `<span class="${k === key ? 'on' : ''}" data-sort="${k}">${label}${k === key ? (dir < 0 ? ' ▼' : ' ▲') : ''}</span>`;
      const head = `<div class="fhead">${col('name', 'Name')}${col('type', 'Type')}${col('size', 'Size')}${col('mtime', 'Modified')}</div>`;
      $('.listing', root).innerHTML = head + (pane.sorted().map(f => `<div class="frow ${f.dir ? 'dir' : 'file'} ${pane.sel.has(f.name) ? 'sel' : ''}" data-n="${esc(f.name)}">
        <span class="nm" title="${esc(f.name)}">${esc(f.name)}</span><span class="ty">${esc(fileType(f))}</span><span class="sz">${f.dir ? '' : fmtSize(f.size)}</span><span class="mt">${fmtDateTime(f.mtime)}</span></div>`).join('') || '<div class="empty">Empty folder</div>');
      xferHint();
    },
    selected() { return pane.items.filter(f => pane.sel.has(f.name)); },
  };
  const listing = $('.listing', root);
  listing.addEventListener('click', e => {
    const h = e.target.closest('[data-sort]');
    if (h) {
      const k = h.dataset.sort;
      // First click on Modified/Size sorts biggest/newest first; Name/Type A→Z.
      pane.sortBy = pane.sortBy.key === k ? { key: k, dir: -pane.sortBy.dir } : { key: k, dir: k === 'mtime' || k === 'size' ? -1 : 1 };
      try { localStorage.setItem('sort.' + root.id, JSON.stringify(pane.sortBy)); } catch { /* private mode */ }
      return pane.render();
    }
    const row = e.target.closest('.frow'); if (!row) return;
    const n = row.dataset.n;
    if (e.ctrlKey || e.metaKey) pane.sel.has(n) ? pane.sel.delete(n) : pane.sel.add(n);
    else { pane.sel.clear(); pane.sel.add(n); }
    pane.render();
  });
  listing.addEventListener('dblclick', e => {
    const row = e.target.closest('.frow'); if (!row) return;
    const f = pane.items.find(x => x.name === row.dataset.n);
    if (f.dir) pane.load(pane.join(f.name)); else pane.onOpenFile?.(f);
  });
  $('.path', root).addEventListener('keydown', e => { if (e.key === 'Enter') pane.load(e.target.value.trim()); });
  return pane;
}

$('#termEmpty').addEventListener('click', ev => { const b = ev.target.closest('[data-recent]'); if (b) Term.open(byId(b.dataset.recent)); });

const Local = makePane($('#localPane'), p => api('GET', '/api/local/ls?path=' + encodeURIComponent(p)));
const Remote = makePane($('#remotePane'), p => {
  if (!Remote.sid) throw new Error('Not connected');
  return api('GET', `/api/sftp/ls?sid=${Remote.sid}&path=${encodeURIComponent(p)}`);
});
Remote.join = name => (Remote.path === '/' ? '' : Remote.path) + '/' + name;
Local.onOpenFile = () => transfer('put');
// This PC opens where you were last time
// Under the ➜ / ← buttons: what they will copy, or how to start.
function xferHint() {
  const el = $('#xferHint'); if (!el) return;
  let up = 0, down = 0, conn = false;
  try { up = Local.sel.size; down = Remote.sel.size; conn = !!Remote.sid; } catch { return; } // panes not made yet
  $('#putBtn').classList.toggle('idle', !(up && conn));
  $('#getBtn').classList.toggle('idle', !down);
  el.textContent = !conn ? 'Connect to a server, then select files' : up ? `➜ uploads ${up}` : down ? `downloads ${down}` : 'Select files, or drag them across';
}
function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } }
{ const load = Local.load; Local.load = async (p, quiet) => { await load(p, quiet); if (Local.loaded && !Local.roots) try { localStorage.setItem('ftp.local', Local.path); } catch { /* private mode */ } }; }
Remote.onOpenFile = () => transfer('get');

api('GET', '/api/local/places').then(list => {
  $('#places').innerHTML = '<option value="">Jump to…</option>' + list.map(p => `<option value="${esc(p.path)}">${esc(p.name)}</option>`).join('');
}).catch(() => {});
$('#places').onchange = e => { if (e.target.value) Local.load(e.target.value); e.target.value = ''; };
$('#localPane').addEventListener('click', async e => {
  const a = e.target.closest('[data-act]')?.dataset.act;
  if (a === 'up') Local.load(Local.parent);
  if (a === 'refresh') Local.load(Local.path);
  if (a === 'shell' && SHELLS.length) Term.openLocal(SHELLS[0], Local.roots ? '' : Local.path);
  if (a === 'browse') {
    toast('Choose a folder in the window that opened (it may be behind the browser)');
    try {
      const r = await api('POST', '/api/local/pick', { start: Local.roots ? '' : Local.path });
      if (r.ok) Local.load(r.path);
    } catch (err) { toast(err.message, true); }
  }
  if (a === 'mkdir' && !Local.roots) {
    const n = prompt('New folder name'); if (!n) return;
    try { await api('POST', '/api/local/mkdir', { path: Local.join(n) }); Local.load(Local.path); } catch (err) { toast(err.message, true); }
  }
});

Remote.connect = async e => {
  show('files'); roomForWork();
  let creds = {};
  if (needsCreds(e) && !(isFTP(e) && !e.username)) { creds = await askCreds(e); if (!creds) return; }
  if (Remote.sid) api('POST', '/api/sftp/close', { sid: Remote.sid }).catch(() => {});
  $('.listing', Remote.root).innerHTML = `<div class="empty">Connecting to ${esc(e.host)}…</div>`;
  try {
    const r = await api('POST', '/api/sftp/open', { id: e.id, ...creds });
    Remote.sid = r.sid;
    Remote.entry = e;
    $$('#remotePane [data-needs-conn]').forEach(b => { b.disabled = false; b.title = ''; });
    $('#sftpLabel').textContent = `${r.protocol.toUpperCase()}  ${creds.username || e.username || 'anonymous'}@${e.host}`;
    $('#sftpDisconnect').hidden = false;
    Tree.render();
    toast('Connected to ' + e.host);
    Remote.load(r.home);
  } catch (err) {
    $('.listing', Remote.root).innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    toast(err.message, true);
  }
};

// ⏏ Disconnect: close the FTP/SFTP session; the pane goes back to "Not connected".
Remote.disconnect = () => {
  if (!Remote.sid) return;
  const host = Remote.entry?.host || '';
  api('POST', '/api/sftp/close', { sid: Remote.sid }).catch(() => {});
  Object.assign(Remote, { sid: null, entry: null, items: [], path: '', parent: '' });
  Remote.sel.clear();
  $('#sftpLabel').textContent = 'Not connected';
  $('#sftpDisconnect').hidden = true;
  $$('#remotePane [data-needs-conn]').forEach(b => { b.disabled = true; b.title = 'Connect to a server first'; });
  $('.path', Remote.root).value = '';
  $('.listing', Remote.root).innerHTML = '<div class="empty">Double-click a server in the tree to connect.<br>Drop files here to upload.</div>';
  xferHint(); Tree.render();
  toast('Disconnected' + (host ? ' from ' + host : ''));
};
$('#sftpDisconnect').onclick = () => Remote.disconnect();

// ☰ → Disconnect all: every SSH terminal, FTP session and database (command
// prompts on this PC stay open).
function openSessions() {
  return { ssh: Term.tabs.filter(t => !t.local && !t.closed), ftp: Remote.sid ? 1 : 0, sql: SQL.tabs.length };
}
function disconnectAll() {
  const o = openSessions();
  o.ssh.forEach(t => Term.close(t));
  if (o.ftp) Remote.disconnect();
  [...SQL.tabs].forEach(t => SQL.close(t));
  toast(`Disconnected ${[o.ssh.length && `${o.ssh.length} SSH`, o.ftp && 'FTP', o.sql && `${o.sql} database${o.sql > 1 ? 's' : ''}`].filter(Boolean).join(', ')}`);
}

$('#remotePane').addEventListener('click', e => {
  const m = e.target.closest('[data-ftpmore]'); if (!m) return;
  const r = m.getBoundingClientRect(), hidden = a => () => $(`#remotePane [data-act=${a}]`).click();
  setTimeout(() => Tree.showMenu({ clientX: r.left - 120, clientY: r.bottom }, [['Rename…', hidden('rename')], ['Delete…', hidden('delete')]]));
});
$('#remotePane').addEventListener('click', async e => {
  const a = e.target.closest('[data-act]')?.dataset.act;
  if (!a || !Remote.sid) return;
  const op = body => api('POST', '/api/sftp/op', { sid: Remote.sid, ...body }).then(() => Remote.load(Remote.path)).catch(err => toast(err.message, true));
  const sel = Remote.selected();
  if (a === 'up') Remote.load(Remote.parent);
  if (a === 'refresh') Remote.load(Remote.path);
  if (a === 'mkdir') { const n = prompt('New folder name'); if (n) op({ op: 'mkdir', path: Remote.join(n) }); }
  if (a === 'rename' && sel.length === 1) { const n = prompt('Rename to', sel[0].name); if (n && n !== sel[0].name) op({ op: 'rename', path: Remote.join(sel[0].name), to: Remote.join(n) }); }
  if (a === 'delete' && sel.length && confirm(`Delete on server:\n${sel.map(f => f.name + (f.dir ? '/ (and everything in it)' : '')).join('\n')}`)) {
    for (const f of sel) await op({ op: 'delete', path: Remote.join(f.name) });
  }
});

async function transfer(dir) {
  if (!Remote.sid) return toast('Connect to a server first', true);
  const src = dir === 'put' ? Local : Remote;
  if (dir === 'put' && Local.roots) return;
  const files = src.selected();
  if (!files.length) return toast('Select files first', true);
  for (const f of files) {
    await api('POST', '/api/sftp/transfer', { sid: Remote.sid, dir, local: Local.join(f.name), remote: Remote.join(f.name) }).catch(err => toast(err.message, true));
  }
  Jobs.watch();
}
$('#putBtn').onclick = () => transfer('put');
$('#getBtn').onclick = () => transfer('get');

const drop = $('.listing', Remote.root);
drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragover'); });
drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
drop.addEventListener('drop', async e => {
  e.preventDefault(); drop.classList.remove('dragover');
  if (!Remote.sid) return toast('Connect to a server first', true);
  const fd = new FormData();
  [...e.dataTransfer.files].forEach(f => fd.append('file', f, f.name));
  toast('Uploading…');
  const r = await fetch(`/api/sftp/upload?sid=${Remote.sid}&dir=${encodeURIComponent(Remote.path)}`, { method: 'POST', body: fd });
  const d = await r.json().catch(() => ({}));
  r.ok ? toast(`Uploaded ${d.uploaded} file(s)`) : toast(d.error || 'Upload failed', true);
  Remote.load(Remote.path);
});

// Transfers panel (FTP page): every copy between This PC and a server, with
// progress, speed, Cancel, Retry and — for downloads — Show (This PC opens at
// the file).
const Jobs = {
  timer: null, running: 0, last: {}, list: [],
  watch() { if (!this.timer) this.timer = setInterval(() => this.tick(), 800); this.tick(); },
  async tick() {
    const jobs = await api('GET', '/api/jobs').catch(() => []);
    this.list = jobs;
    const now = Date.now();
    $('#xferPanel').hidden = !jobs.length;
    $('#jobs').innerHTML = jobs.slice(0, 30).map(j => {
      const pct = j.total ? Math.round(j.done * 100 / j.total) : (j.status === 'done' ? 100 : 0);
      const prev = this.last[j.id], speed = prev && j.status === 'running' ? (j.done - prev.done) / ((now - prev.t) / 1000) : 0;
      this.last[j.id] = { done: j.done, t: now };
      const took = j.ended ? Math.max(1, (Date.parse(j.ended) - Date.parse(j.started)) / 1000) : 0;
      const size = j.total ? `${fmtSize(j.done)}${j.status === 'running' ? ' of ' + fmtSize(j.total) : ''}` : '';
      const info = j.status === 'running' ? [size, speed > 0 && fmtSize(speed) + '/s'].filter(Boolean).join(' · ')
        : j.status === 'done' ? [size, took && fmtSize(j.total / took) + '/s', fmtTime(j.ended)].filter(Boolean).join(' · ')
        : j.status === 'failed' ? j.error : 'cancelled';
      const acts = j.status === 'running' ? `<button class="icon" data-jcancel="${j.id}" title="Stop this transfer">Cancel</button>`
        : (j.status === 'failed' || j.status === 'cancelled' ? `<button class="icon" data-jretry="${j.id}" title="Start it again">↻ Retry</button>` : '')
          + (j.dir === 'download' && j.status === 'done' ? `<button class="icon" data-jshow="${j.id}" title="Show it in This PC">Show</button>` : '');
      return `<div class="job ${j.status}" title="${esc(j.dir === 'upload' ? j.local + '  →  ' + j.host + ':' + j.remote : j.host + ':' + j.remote + '  →  ' + j.local)}">
        <span class="jdir">${j.dir === 'upload' ? '↑' : '↓'}</span><span class="jname">${esc(j.name)} <span class="muted tiny">${esc(j.host || '')}</span></span>
        <div class="bar"><i style="width:${pct}%"></i></div><span class="jinfo">${j.status === 'running' ? pct + '% · ' : j.status === 'done' ? '✓ ' : j.status === 'failed' ? '✗ ' : ''}${esc(info || '')}</span><span class="jacts">${acts}</span></div>`;
    }).join('');
    const n = k => jobs.filter(j => j.status === k).length;
    $('#xferSum').textContent = [n('running') && `${n('running')} running`, n('done') && `${n('done')} done`, n('failed') && `${n('failed')} failed`, n('cancelled') && `${n('cancelled')} cancelled`].filter(Boolean).join(' · ');
    const running = n('running');
    if (running < this.running) { Local.load(Local.path); if (Remote.sid) Remote.load(Remote.path); }
    this.running = running;
    if (!running) { clearInterval(this.timer); this.timer = null; }
  },
};
$('#jobs').addEventListener('click', async ev => {
  const b = ev.target.closest('button'); if (!b) return;
  try {
    if (b.dataset.jcancel) await api('POST', `/api/jobs/${b.dataset.jcancel}/cancel`);
    if (b.dataset.jretry) await api('POST', `/api/jobs/${b.dataset.jretry}/retry`, { sid: Remote.sid || '' });
    if (b.dataset.jshow) {
      const j = Jobs.list.find(x => x.id === b.dataset.jshow);
      const dir = j.local.replace(/[\\/][^\\/]*$/, ''), name = j.local.split(/[\\/]/).pop(); // the name it was saved under here
      await Local.load(dir); Local.sel.clear(); Local.sel.add(name); Local.render();
      $(`#localPane .frow[data-n="${CSS.escape(name)}"]`)?.scrollIntoView({ block: 'center' });
    }
  } catch (err) { toast(err.message, true); }
  Jobs.watch();
});
$('#xferClear').addEventListener('click', async ev => { ev.preventDefault(); await api('POST', '/api/jobs/clear').catch(() => {}); Jobs.last = {}; Jobs.tick(); });

// ---------- connection tree (Terminal + Files) ----------
// Folders come from the project name ("Payments/Batch" nests), then the
// environment. Drag a server onto a folder to move it.
// Running tunnels, shown on their SSH server in the trees.
const Tunnels = {
  running: {},
  async load() {
    const list = await api('GET', '/api/tunnels').catch(() => []);
    const next = Object.fromEntries(list.map(t => [t.entry_id, t.forwards]));
    if (JSON.stringify(next) !== JSON.stringify(this.running)) { this.running = next; Tree.render(); }
  },
  chip(e) {
    if (!e.extra?.tunnels) return '';
    const run = this.running[e.id];
    if (run) return `<span class="tchip on" title="Tunnels running:\n${esc(run.join('\n'))}">⇄ ${esc(run.map(f => f.split(' ')[0].replace('localhost:', '')).join(', '))}</span>`;
    return `<span class="tchip" title="${e.extra.tunnels_off === '1' ? 'Tunnels switched off' : 'Tunnels set up (not running): ' + esc(e.extra.tunnels)}">⇄${e.extra.tunnels_off === '1' ? ' off' : ''}</span>`;
  },
};
setInterval(() => Tunnels.load(), 10000);
setTimeout(() => Tunnels.load(), 1500);

// Connection trees (PuTTY, FileZilla, SQL) can be grouped like bookmarks:
// by your folders, environment, application (from the server name),
// domain / IP subnet, type, your Groups, or login user. One choice per tree.
const TREE_GROUPS = { folder: 'Folders', env: 'Env', app: 'App', domain: 'Domain / subnet', type: 'Type', group: 'My groups', user: 'User' };
const ENV_WORD = /^(dev|devl?|uat|sit|qa|test|tst|stg|stage|staging|preprod|pre|pprd|prod|prd|live|dr|nonprod|np|int|perf|train|trn)\d*[a-z]?$/;
const ROLE_WORD = /^(app|apps|web|db|dbs|srv|svr|server|node|host|vm|ap|ws|lx|lnx|linux|unix|ora|pg|sql|ftp|sftp|jump|bastion)\d*$/;
function serverApp(e) {
  const rl = ruleLabel(e.host) || ruleLabel(e.url);
  if (rl) return rl;
  const h = /^[\d.:]+$/.test(e.host || '') && e.name && e.name !== e.host ? e.name : (e.host || e.name || '');
  if (/^[\d.:]+$/.test(h)) return 'IP addresses';
  const parts = h.toLowerCase().split('.')[0].split(/[-_\s/]+/).filter(Boolean);
  const keep = parts.filter(p => !ENV_WORD.test(p) && !/^\d+$/.test(p)).map(p => p.replace(/\d+$/, '')).filter(Boolean);
  const named = keep.filter(p => !ROLE_WORD.test(p));
  return (named.length ? named : keep.length ? keep : parts).slice(0, 2).join('-') || 'Other';
}
function serverDomain(e) {
  const h = (e.host || '').toLowerCase();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return h.split('.').slice(0, 3).join('.') + '.x';
  return h.includes('.') ? h.split('.').slice(1).join('.') : 'Short names';
}
function serverType(e) {
  const k = dbKindOf(e);
  if (k) return k === 'oracle' ? 'Oracle' : 'PostgreSQL';
  if (isFTP(e)) return (e.protocol || 'ftp').toUpperCase();
  return /rdp|windows/i.test(e.protocol || '') ? 'Windows' : 'Unix / Linux';
}
const LAST_GROUPS = new Set(['Other', 'No environment', 'Not in a group', 'No user', 'Short names', 'IP addresses']);

const Tree = {
  collapsed: new Set(JSON.parse(localStorage.getItem('treeCollapsed') || '[]')),
  selected: null,
  groupMode(mode) { try { return localStorage.getItem('treeGroup_' + mode) || 'folder'; } catch { return 'folder'; } },
  setGroupMode(mode, g) { try { localStorage.setItem('treeGroup_' + mode, g); } catch { /* ignore */ } this.render(); },

  keysOf(e, g) {
    switch (g) {
      case 'env': return [e.env || 'No environment'];
      case 'app': return [serverApp(e)];
      case 'domain': return [serverDomain(e)];
      case 'type': return [serverType(e)];
      case 'user': return [e.username || 'No user'];
      case 'group': { const t = Groups.entryText(e), gs = Groups.all().filter(x => Groups.matches(x, t)).map(x => x.name); return gs.length ? gs : ['Not in a group']; }
    }
    return [];
  },

  build(q, mode) {
    const root = { kids: {}, items: [] };
    const want = { ssh: canSSH, sftp: canFiles, db: canDB }[mode];
    const g = this.groupMode(mode);
    root.mode = mode;
    if (!q) root.top = S.entries.filter(want).filter(e => usageScore(e) > 0).sort(byUsage).slice(0, 6);
    if (g !== 'folder') {
      for (const e of S.entries.filter(want).filter(e => matches(e, q)))
        for (const k of this.keysOf(e, g))
          (root.kids[k] ||= { name: k, key: `${mode}:${g}:${k}`, gmode: g, env: g === 'env' && k !== 'No environment' ? k : '', project: '', kids: {}, items: [] }).items.push(e);
      return root;
    }
    for (const e of S.entries.filter(want).filter(e => matches(e, q))) {
      let node = root, path = '';
      const parts = (e.project || 'General').split('/').map(s => s.trim()).filter(Boolean);
      for (const p of parts) {
        path = path ? path + '/' + p : p;
        node = node.kids[p] ||= { name: p, project: path, kids: {}, items: [] };
      }
      if (e.env) node = node.kids['#' + e.env] ||= { name: e.env, env: e.env, project: path, kids: {}, items: [] };
      node.items.push(e);
    }
    return root;
  },

  count(n) { return n.items.length + Object.values(n.kids).reduce((a, k) => a + this.count(k), 0); },

  html(node, depth, q) {
    let out = '';
    if (depth === 0 && node.top?.length) {
      const key = 'top:' + node.mode, open = !this.collapsed.has(key);
      out += `<div class="tnode folder topused" style="padding-left:8px" data-key="${esc(key)}" data-gmode="top"><span class="tw">${open ? '▾' : '▸'}</span>★ <span class="nm">Most used</span><span class="n">${node.top.length}</span></div>`;
      if (open) out += this.html({ kids: {}, items: node.top, flat: true }, 1, q);
    }
    const kids = Object.entries(node.kids).sort(([a, x], [b, y]) => (a[0] === '#') - (b[0] === '#') || LAST_GROUPS.has(a) - LAST_GROUPS.has(b)
      || (x.gmode === 'env' ? (ENV_ORDER[a] ?? 9) - (ENV_ORDER[b] ?? 9) : 0) || a.localeCompare(b));
    const icon = { app: '▦', domain: '🌐', type: '⚙', group: '◆', user: '👤' };
    for (const [, k] of kids) {
      const key = k.key || k.project + (k.env ? '#' + k.env : '');
      const open = q || !this.collapsed.has(key);
      const gc = k.gmode === 'group' && Groups.get(k.name);
      // A folder whose servers are all in one environment shows the badge on
      // its own line instead of an extra level ("📁 Lab  UAT").
      const only = !k.env && !k.items.length && Object.values(k.kids).length === 1 && Object.values(k.kids)[0].env ? Object.values(k.kids)[0] : null;
      out += `<div class="tnode folder" style="padding-left:${8 + depth * 14}px" data-key="${esc(key)}" data-project="${esc(k.project)}" data-env="${esc(k.env || only?.env || '')}" data-gmode="${esc(k.gmode || 'folder')}">
        <span class="tw">${open ? '▾' : '▸'}</span>${k.env ? `<span class="badge ${esc(k.env)}">${esc(k.env)}</span>` : (gc ? `<span class="gdot" style="background:${Groups.color(gc)}"></span>` : (icon[k.gmode] || '📁')) + ' <span class="nm">' + esc(k.name) + '</span>' + (only && !k.name.toUpperCase().includes(only.env) ? ` <span class="badge ${esc(only.env)}">${esc(only.env)}</span>` : '')}<span class="n">${this.count(k)}</span></div>`;
      if (open) out += this.html(only || k, depth + 1, q);
    }
    // Several logins on one server: one server row with the users under it.
    const items = node.items.sort(byUsage), byHost = {};
    if (!node.flat) for (const e of items) if (e.host && !canDB(e)) (byHost[`${e.host.toLowerCase()}:${e.port || ''}`] ||= []).push(e);
    const done = new Set();
    for (const e of items) {
      if (done.has(e.id)) continue;
      const grp = e.host && !canDB(e) && !node.flat ? byHost[`${e.host.toLowerCase()}:${e.port || ''}`] : null;
      if (!grp || grp.length < 2) { out += this.itemHTML(e, depth, node); continue; }
      grp.forEach(x => done.add(x.id));
      const key = `srv:${node.key || node.project || ''}:${e.host.toLowerCase()}:${e.port || ''}`, open = q || !this.collapsed.has(key);
      const live = grp.some(x => Term.tabs.some(t => t.entry.id === x.id && !t.closed) || Remote.entry?.id === x.id && Remote.sid);
      const st = grp.some(x => x.status === 'ok') ? { status: 'ok' } : grp.every(x => x.status === 'fail') ? { status: 'fail' } : {};
      out += `<div class="tnode folder srvnode" style="padding-left:${8 + depth * 14}px" data-key="${esc(key)}" data-gmode="server" data-srvhost="${esc(e.host)}" data-srvport="${e.port || ''}" title="${esc(e.host)} — ${grp.length} logins: ${esc(grp.map(x => x.username || '?').join(', '))}">
        <span class="tw">${open ? '▾' : '▸'}</span>${dot(st)} 🖥 <span class="nm">${ruleName({ ...e, name: (ruleLabel(e.host) ? ruleLabel(e.host) + ' – ' : '') + e.host })}</span><span class="n" title="logins">👤 ${grp.length}</span>${live ? '<span class="live">●</span>' : ''}</div>`;
      if (open) for (const x of grp) out += this.itemHTML(x, depth + 1, node, `👤 ${esc(x.username || '(no user)')}`);
    }
    return out;
  },

  // One connection row (and, for a database, its objects when expanded).
  itemHTML(e, depth, node, label) {
    let out = '';
    const live = Term.tabs.some(t => t.entry.id === e.id && !t.closed) || Remote.entry?.id === e.id && Remote.sid || SQL.tabs.some(t => t.entry.id === e.id);
    const port = isFTP(e) ? (e.port || 21) : sshPort(e), def = isFTP(e) ? 21 : 22;
    let target = `${isFTP(e) ? e.protocol || 'ftp' : ''}${isFTP(e) ? '://' : ''}${e.username ? e.username + '@' : ''}${e.host}${port !== def ? ':' + port : ''}`;
    if (canDB(e)) target = `${e.username ? e.username + '@' : ''}${e.host}:${e.port || (dbKindOf(e) === 'oracle' ? 1521 : 5432)}${dbService(e) ? (dbService(e).sid ? ':' : '/') + dbService(e).name : ''}`;
    // Database connections expand like SQL Developer: ▸ connects, ▾ shows the objects.
    const isDb = canDB(e) && !node.flat, dbt = isDb && SQL.tabs.find(t => t.entry.id === e.id);
    const dbOpen = isDb && SQL.expanded.has(e.id);
    out += `<div class="tnode item ${this.selected === e.id ? 'sel' : ''}" draggable="true" style="padding-left:${8 + depth * 14}px" data-id="${e.id}" title="${esc((e.name && e.name !== e.host ? e.name + '\n' : '') + target)}">
      <span class="tw" ${isDb ? `data-dbexp="${e.id}" title="${dbOpen ? 'Collapse' : 'Connect and show tables'}"` : ''}>${isDb ? (dbOpen ? '▾' : '▸') : ''}</span>${dot(e)} ${canDB(e) ? '🛢 ' : ''}<span class="nm">${label || (canDB(e) ? ruleName(e) : cardName(e) || esc(e.host || e.name))}</span>${Tunnels.chip(e)}${(rl => rl && !e.name.includes(rl) ? `<span class="rlabel"${ruleStyle(e.host)}>${esc(rl)}</span>` : '')(ruleLabel(e.host))}${label ? '' : canDB(e) || cardName(e) ? `<small>${esc(target)}</small>` : e.username || port !== def ? `<small>${esc(e.username || '')}${port !== def ? ':' + port : ''}</small>` : ''}${live ? '<span class="live">●</span>' : ''}</div>`;
    if (dbOpen) {
      const pad = `style="padding-left:${8 + (depth + 1) * 14}px"`;
      if (dbt) out += SQL.treeHTML(dbt, depth + 1);
      else if (SQL.connecting.has(e.id)) out += `<div class="tnode muted" ${pad}>connecting…</div>`;
      else if (SQL.connErr[e.id]) out += `<div class="tnode dberr" ${pad} title="${esc(SQL.connErr[e.id])}">⚠ ${esc(SQL.connErr[e.id])}</div><div class="tnode link" ${pad} data-dbexp="${e.id}" data-retry="1">↻ Try again</div>`;
    }
    return out;
  },

  render() {
    for (const host of $$('.tree-host')) {
      if (!host.firstChild) {
        host.innerHTML = `<div class="tree-tools"><input type="search" placeholder="Filter servers…"><select data-tool="groupby" title="Group servers by">${Object.entries(TREE_GROUPS).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select><button data-tool="rules" title="Naming rules: name servers by what their host name contains (e.g. -BAT- → Batch)">🏷 Names</button><button data-tool="new" title="New connection">+ New</button><button data-tool="collapse" title="Collapse all folders">⊟ Fold</button></div><div class="tree" tabindex="0" title="↑ ↓ move · Enter connects · → ← open / fold"></div>`;
        this.wire(host);
      }
      $('select[data-tool=groupby]', host).value = this.groupMode(host.dataset.mode);
      const q = $('input', host).value.trim().toLowerCase();
      $('.tree', host).innerHTML = this.html(this.build(q, host.dataset.mode), 0, q) || '<div class="empty">No servers yet.<br>Copy or paste some details, or press + New.</div>';
      if (this.kbKey) $$('.tree > .tnode.folder', host).find(n => n.dataset.key === this.kbKey)?.classList.add('kbfocus');
    }
  },

  // Keyboard in a tree: ↑/↓ move over servers and folders, → opens a folder
  // (or steps in), ← folds it (or steps out to its folder), Enter connects.
  key(host, k) {
    const rows = $$('.tree > .tnode', host).filter(n => n.dataset.id || n.dataset.key);
    if (!rows.length) return;
    let i = rows.findIndex(n => n.classList.contains('kbfocus'));
    if (i < 0) i = rows.findIndex(n => n.dataset.id && n.dataset.id === this.selected);
    const cur = rows[i], open = n => n.dataset.key && !this.collapsed.has(n.dataset.key);
    const indent = n => parseInt(n.style.paddingLeft) || 0;
    let to = i;
    if (k === 'ArrowDown') to = Math.min(i + 1, rows.length - 1);
    else if (k === 'ArrowUp') to = Math.max(i - 1, 0);
    else if (k === 'Home') to = 0;
    else if (k === 'End') to = rows.length - 1;
    else if (k === 'ArrowRight' && cur?.dataset.key) {
      if (!open(cur)) { this.collapsed.delete(cur.dataset.key); this.kbKey = cur.dataset.key; return this.saveCollapsed(); }
      to = Math.min(i + 1, rows.length - 1);
    } else if (k === 'ArrowLeft' && cur) {
      if (open(cur)) { this.collapsed.add(cur.dataset.key); this.kbKey = cur.dataset.key; return this.saveCollapsed(); }
      for (let j = i - 1; j >= 0; j--) if (rows[j].dataset.key && indent(rows[j]) < indent(cur)) { to = j; break; }
    }
    if (to < 0) to = 0;
    this.focusRow(host, rows[to]);
  },

  focusRow(host, n) {
    if (!n) return;
    $$('.tnode.kbfocus', host).forEach(x => x.classList.remove('kbfocus'));
    n.classList.add('kbfocus');
    this.kbKey = n.dataset.key || '';
    if (n.dataset.id) { this.selected = n.dataset.id; $$('.tnode.item').forEach(x => x.classList.toggle('sel', x.dataset.id === this.selected)); }
    n.scrollIntoView({ block: 'nearest' });
  },

  activate(e, mode) { mode === 'sftp' ? Remote.connect(e) : mode === 'db' ? SQL.open(e) : Term.open(e); },

  wire(host) {
    const mode = host.dataset.mode;
    $('input', host).addEventListener('input', () => this.render());
    $('select[data-tool=groupby]', host).addEventListener('change', ev => this.setGroupMode(mode, ev.target.value));
    host.addEventListener('click', ev => {
      const tool = ev.target.closest('button[data-tool]')?.dataset.tool;
      if (tool === 'new') return openEntryDialog(null);
      if (tool === 'rules') return openNameRules();
      if (tool === 'collapse') {
        $$('.tnode.folder', host).forEach(f => this.collapsed.add(f.dataset.key));
        return this.saveCollapsed();
      }
      const exp = ev.target.closest('[data-dbexp]');
      if (exp) return SQL.toggleConn(byId(exp.dataset.dbexp), !!exp.dataset.retry);
      const n = ev.target.closest('.tnode');
      if (!n) return;
      if (n.dataset.dbk) return SQL.treeClick(n);
      if (n.dataset.key) {
        this.collapsed.has(n.dataset.key) ? this.collapsed.delete(n.dataset.key) : this.collapsed.add(n.dataset.key);
        return this.saveCollapsed();
      }
      this.selected = n.dataset.id;
      $$('.tnode.item').forEach(x => x.classList.toggle('sel', x.dataset.id === this.selected));
    });
    host.addEventListener('dblclick', ev => {
      const dn = ev.target.closest('.tnode.dbn');
      if (dn) return SQL.treeOpen(dn);
      const n = ev.target.closest('.tnode.item');
      if (n) this.activate(byId(n.dataset.id), mode);
    });
    host.addEventListener('keydown', ev => {
      if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'SELECT') return;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) { ev.preventDefault(); return this.key(host, ev.key); }
      const f = $('.tnode.kbfocus', host);
      if (ev.key === 'Enter' && f?.dataset.key) return f.click();
      if (ev.key === 'Enter' && this.selected) this.activate(byId(this.selected), mode);
    });
    host.addEventListener('contextmenu', ev => {
      ev.preventDefault();
      const dn = ev.target.closest('.tnode.dbn');
      if (dn) return SQL.treeMenu(ev, dn);
      const n = ev.target.closest('.tnode');
      if (n?.dataset.id) { this.selected = n.dataset.id; this.render(); }
      this.menu(ev, n, mode);
    });
    host.addEventListener('dragstart', ev => {
      const n = ev.target.closest('.tnode.item');
      if (n) ev.dataTransfer.setData('text/x-entry', n.dataset.id);
    });
    host.addEventListener('dragover', ev => {
      const f = ev.target.closest('.tnode.folder');
      if (!f || !ev.dataTransfer.types.includes('text/x-entry') || !['folder', 'env'].includes(f.dataset.gmode)) return;
      ev.preventDefault();
      $$('.tnode.drop', host).forEach(x => x.classList.remove('drop'));
      f.classList.add('drop');
    });
    host.addEventListener('dragleave', ev => ev.target.closest?.('.tnode.folder')?.classList.remove('drop'));
    host.addEventListener('drop', async ev => {
      const f = ev.target.closest('.tnode.folder');
      const e = byId(ev.dataTransfer.getData('text/x-entry'));
      if (!f || !e || !['folder', 'env'].includes(f.dataset.gmode)) return;
      ev.preventDefault();
      if (f.dataset.gmode === 'env') return this.move(e, e.project, f.dataset.env);
      await this.move(e, f.dataset.project, f.dataset.env || e.env);
    });
  },

  async move(e, project, env) {
    try { await api('POST', '/api/entries', { ...entryInput(e), project, env, password: e.password }); poll(); }
    catch (err) { toast(err.message, true); }
  },

  saveCollapsed() {
    localStorage.setItem('treeCollapsed', JSON.stringify([...this.collapsed]));
    this.render();
  },

  showMenu(ev, items) {
    const m = $('#ctxMenu');
    m.innerHTML = items.map((it, i) => it === '-' ? '<hr>' : `<button data-i="${i}">${esc(it[0])}</button>`).join('');
    m.hidden = false;
    m.style.left = Math.min(ev.clientX, innerWidth - 210) + 'px';
    m.style.top = Math.min(ev.clientY, innerHeight - m.offsetHeight - 8) + 'px';
    m.onclick = c => { const b = c.target.closest('[data-i]'); if (b) { m.hidden = true; items[b.dataset.i][1](); } };
  },

  menu(ev, node, mode) {
    const e = node?.dataset.id && byId(node.dataset.id);
    const items = [];
    if (e) {
      if (canDB(e)) {
        const t = SQL.tabs.find(x => x.entry.id === e.id);
        items.push(['Open in SQL', () => SQL.open(e)]);
        if (t) items.push(['Reconnect', () => SQL.reconnect(t)], ['⏏ Disconnect', () => SQL.close(t)]);
        else items.push(['Connect and show tables', () => SQL.toggleConn(e)]);
      }
      if (canSSH(e)) items.push(['Open SSH terminal', () => Term.open(e)]);
      const tabs = Term.tabs.filter(t => t.entry?.id === e.id && !t.local && !t.closed);
      if (tabs.length) items.push([`⏏ Disconnect SSH${tabs.length > 1 ? ` (${tabs.length} terminals)` : ''}`, () => tabs.forEach(t => Term.close(t))]);
      if (canFiles(e)) items.push([`Open in FTP (${isFTP(e) ? (e.protocol || 'ftp').toUpperCase() : 'SFTP'})`, () => Remote.connect(e)]);
      if (Remote.sid && Remote.entry?.id === e.id) items.push(['⏏ Disconnect FTP', () => Remote.disconnect()]);
      if (External.items(e).length) items.push('-', ...External.items(e));
      if (canSSH(e) && e.extra?.tunnels) {
        const off = e.extra.tunnels_off === '1', auto = e.extra.tunnels_auto === '1';
        items.push('-', [off ? '☐ Tunnels switched off — switch on' : '☑ Tunnels on — switch off', async () => {
          await api('POST', `/api/tunnels/${e.id}/enabled`, { on: off });
          toast(off ? 'Tunnels switched on (' + e.extra.tunnels + ')' : 'Tunnels switched off — settings kept'); poll();
        }]);
        if (!off) items.push([auto ? '☑ Start when WorkHub starts — turn off' : '☐ Start when WorkHub starts', async () => {
          await api('POST', `/api/tunnels/${e.id}/enabled`, { on: true, auto: !auto });
          toast(auto ? 'Tunnels start only when needed now' : 'Tunnels will start with WorkHub (and reconnect if dropped) — starting now…'); poll();
        }]);
        if (!off) items.push(['Start tunnels (' + e.extra.tunnels + ')', async () => {
          try { const r = await api('POST', `/api/tunnels/${e.id}/start`); toast('Tunnels running: ' + r.forwards.join(', ') + (r.warning ? ' — ' + r.warning : '')); }
          catch (err) { toast(err.message, true); }
        }], ['Stop tunnels', async () => { await api('POST', `/api/tunnels/${e.id}/stop`); toast('Tunnels stopped' + (e.extra.tunnels_auto === '1' ? ' (they restart within a minute while "Start when WorkHub starts" is on)' : '')); Tunnels.load(); }], '-');
      }
      if (problems(e).some(p => p[0] === 'password')) items.push(['🔑 Logs in with a key / SSO (no password)', async () => { await api('POST', '/api/entries', { ...entryInput(e), password: e.password, extra: { ...(e.extra || {}), auth: 'key' } }); poll(); toast(`${e.name}: marked as key login`); }]);
      items.push(['🧵 Add to task thread…', () => Work.addEntry(e, ev)]);
      items.push('-',
        ['Copy host', () => copyText(e.host)]);
      if (e.username) items.push(['Copy username', () => copyText(e.username)]);
      if (e.password) items.push(['Copy password', () => copyText(e.password, 'Password copied')]);
      if (e.username && isConn(e)) items.push([`🔑 Change ${e.username}'s password everywhere…`, () => PwAll.open(e.username)]);
      items.push(['Copy all details', () => copyText(detailsText(e), 'All details copied')]);
      if (canSSH(e)) items.push(['Copy ssh command', () => copyText(`ssh ${e.username ? e.username + '@' : ''}${e.host}${sshPort(e) !== 22 ? ' -p ' + sshPort(e) : ''}`)]);
      if (canDB(e) && jdbcURL(e)) items.push(['Copy JDBC URL', () => copyText(jdbcURL(e))]);
      items.push('-',
        ['Edit…', () => openEntryDialog(e)],
        ['Duplicate', async () => { await api('POST', '/api/entries', { ...entryInput(e), id: '', name: e.name + ' (copy)', password: e.password }); poll(); }],
        ['Move to folder…', () => { const p = prompt('Folder (use / for subfolders)', e.project); if (p) this.move(e, p.trim(), e.env); }],
        ['Delete', () => deleteEntries([e])]);
    } else if (node?.dataset.srvhost) { // a server with several logins
      const h = node.dataset.srvhost, port = +node.dataset.srvport || 0, sib = S.entries.find(x => x.host === h && (x.port || 0) === port);
      items.push(['+ Add another login on this server…', () => openEntryDialog({ host: h, port, protocol: sib?.protocol || 'ssh', project: sib?.project, env: sib?.env })],
        ['Copy host', () => copyText(h)]);
    } else if (node?.dataset.project) {
      const proj = node.dataset.project;
      items.push(['New connection here…', () => openEntryDialog({ project: proj, env: node.dataset.env })],
        ['New subfolder…', () => { const n = prompt('Subfolder name'); if (n) openEntryDialog({ project: proj + '/' + n.trim(), env: node.dataset.env }); }]);
      if (!node.dataset.env) items.push(['Rename folder…', async () => {
        const to = prompt('Rename folder', proj);
        if (to && to !== proj) { await api('POST', '/api/projects/rename', { from: proj, to: to.trim() }); poll(); }
      }]);
    } else {
      items.push(['New connection…', () => openEntryDialog(null)],
        ['New folder…', () => { const n = prompt('Folder name (use / for subfolders)'); if (n) openEntryDialog({ project: n.trim() }); }]);
    }
    const m = $('#ctxMenu');
    m.innerHTML = items.map((it, i) => it === '-' ? '<hr>' : `<button data-i="${i}">${esc(it[0])}</button>`).join('');
    m.hidden = false;
    m.style.left = Math.min(ev.clientX, innerWidth - 210) + 'px';
    m.style.top = Math.min(ev.clientY, innerHeight - m.offsetHeight - 8) + 'px';
    m.onclick = c => { const b = c.target.closest('[data-i]'); if (b) { m.hidden = true; items[b.dataset.i][1](); } };
  },
};
const sshPort = e => (['', 'ssh', 'sftp', 'scp'].includes(e.protocol || '') && e.port) || 22;
document.addEventListener('click', e => { if (!e.target.closest('#ctxMenu')) $('#ctxMenu').hidden = true; });
document.addEventListener('keydown', e => { if (e.key === 'Escape') $('#ctxMenu').hidden = true; });

// ---------- assistant chat ----------
// Rule-based and fully local: nothing typed here leaves this PC.
const Chat = {
  cards: [],

  toggle(force) {
    const c = $('#chat');
    c.hidden = force === undefined ? !c.hidden : !force;
    $('#chatFab').classList.toggle('on', !c.hidden); // highlighted while the assistant is open
    if (!c.hidden) { $('#chatText').focus(); if (!$('#chatLog').children.length) this.help(true); }
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
      ? 'Tell me what you want in plain English — e.g. <code>show prod servers in payments as a table</code>, <code>bookmarks by folder</code>, <code>password for app01</code>, <code>save this view as Prod</code>. Or paste connection details and say <code>putty</code>, <code>filezilla</code> or <code>sql</code>. Type <code>help</code> for more.'
      : `Things you can say:
• <code>putty</code> / <code>ssh</code> / <code>terminal</code> + details → PuTTY (SSH session)
• <code>filezilla</code>, <code>ftp</code>, <code>ftps</code>, <code>sftp</code> + details → FileZilla (file transfer)
• just a saved name: <code>ssh app-prod-01</code>, <code>ftp files.corp.local</code>
• <code>save</code> + details → store without connecting
• <code>find prod</code>, <code>find oracle</code> → search saved connections
• <code>yes</code> to confirm the suggestion, <code>no</code> to dismiss

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
    const looksLikeDetails = /\n|[:=]\s*\S|@\S+\.|:\/\/|\b\d{1,3}(\.\d{1,3}){3}\b/.test(text) && !/\b(password|user|url|host)\s+(for|of)\b/i.test(text);
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
  if (!a || ev.button !== 0 || a.closest('[contenteditable="true"]')) return;
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

// Bookmarks table: [heading, sort key, default width]
const BM_COLS = [['Name', 'name', 240], ['App', 'app', 130], ['URL', 'url', 340], ['User', 'user', 110], ['Env', 'env', 70], ['Folder', 'folder', 170], ['Opened', 'opened', 80], ['Last opened', 'last', 120], ['', '', 120]];

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
    return `<div class="tblwrap"><table class="tbl bm-tbl"><colgroup>${BM_COLS.map(([, , w], i) => `<col style="width:var(--b${i}, ${w}px)">`).join('')}</colgroup><thead><tr>${head}</tr></thead><tbody>`
      + items.map(e => `<tr class="env-${esc(e.env || '')}" data-bm="${e.id}" title="Click to open">
        <td class="bm-tname">${dot(e)} ${esc(e.name || e.host)}</td>
        <td>${urlLabel(e.url) ? `<span class="ulabel"${ruleStyle(e.url)}>${esc(urlLabel(e.url))}</span>` : ''}</td>
        <td class="mono">${esc(e.url)}</td>
        <td>${esc(e.username || '')}</td>
        <td>${e.env ? `<span class="badge ${esc(e.env)}">${esc(e.env)}</span>` : ''}</td>
        <td>${esc(e.folder ? e.folder.split(' › ').slice(1).join(' › ') || e.folder : '')}</td>
        <td>${e.open_count ? e.open_count + '×' : ''}</td>
        <td>${e.last_used ? esc(fmtTime(e.last_used)) : ''}</td>
        <td class="bm-ttools">${this.tools(e)}</td></tr>`).join('') + '</tbody></table></div>';
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
  const v = prompt('Sites never imported or captured in this workspace (comma separated, e.g. facebook.com, example.org).\nWell-known adult sites are always blocked.', cur);
  if (v === null) return;
  await saveSettings({ blocked_sites: v.split(',').map(x => x.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean) });
  await poll();
  toast('Blocked sites saved — matching links are hidden');
};
$('#bmHidden').onchange = e => { Bookmarks.showHidden = e.target.checked; Bookmarks.render(); };
$('#bmInternal').checked = Bookmarks.internalOnly;
$('#bmInternal').onchange = e => { Bookmarks.internalOnly = e.target.checked; try { localStorage.setItem('bmInternalOnly', e.target.checked ? '1' : '0'); } catch { /* ignore */ } Bookmarks.render(); };
$('#bmSync').onchange = e => saveSettings({ no_browser_sync: !e.target.checked }).then(() => e.target.checked && Bookmarks.sync(true));

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
      database = prompt(kind === 'oracle' ? `Oracle service name for ${e.host} (e.g. ORCLPDB1):` : `PostgreSQL database on ${e.host}:`, kind === 'oracle' ? '' : 'postgres');
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
    if (t.inTx && !confirm(`${t.entry.name} has uncommitted changes. Reconnecting rolls them back. Continue?`)) return;
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
    if (t.inTx && !confirm(`${t.entry.name} has uncommitted changes. Close and roll them back?`)) return;
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
    $('#sqlRes').hidden = which !== 'res'; $('#sqlOut').hidden = which !== 'out'; $('#sqlHist').hidden = which !== 'hist';
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
    $('#sqlHist').innerHTML = h.map((x, i) => `<div class="hist-item" data-h="${i}" title="Click to put back in the editor"><small>${new Date(x.at).toLocaleString()}</small>${esc(x.sql)}</div>`).join('') || '<div class="empty">No history yet.</div>';
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
        <span class="tw">${n.leaf ? '' : open ? '▾' : '▸'}</span>${icon(n)} <span class="nm">${esc(n.label)}</span>${n.detail ? `<small>${esc(n.detail)}</small>` : ''}</div>`;
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
$('#sqlCommit').onclick = () => SQL.tx('commit');
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

// ---------- Outlook monitoring ----------
const Mail = {
  cfg() {
    const c = { enabled: false, folder: '', minutes: 2, keep_all: false, lookback: 7, ...(S.settings.mail || {}) };
    c.rules = c.rules || []; // a new workspace sends null
    return c;
  },
  async save(patch) { await saveSettings({ mail: { ...this.cfg(), ...patch } }); this.render(); },
  render() {
    const c = this.cfg();
    $('#mailOn').checked = c.enabled;
    $('#mailRules').innerHTML = c.rules.map((r, i) => `<div class="rule">${esc(r.match)} <span class="p">→ ${esc(r.project || 'capture project')}</span><span class="x" data-rule="${i}" title="Remove">✕</span></div>`).join('')
      || '<div class="muted tiny">No senders yet — add one below.</div>';
    if (document.activeElement !== $('#mailFolder')) $('#mailFolder').value = c.folder;
    $('#mailEvery').value = String(c.minutes || 2);
    $('#mailBack').value = String(c.lookback || 7);
    $('#mailKeepAll').checked = c.keep_all;
    $('#mailBadge').textContent = c.enabled && c.rules.length ? `· on, ${c.rules.length} sender(s)` : '· off';
  },
  async status() {
    try {
      const s = await api('GET', '/api/mail/status');
      const c = this.cfg();
      $('#mailStatus').textContent = !s.supported ? 'Outlook monitoring runs on Windows with classic Outlook.'
        : s.running ? 'Checking…'
        : s.last_error ? '⚠ ' + s.last_error
        : s.last_check && new Date(s.last_check).getFullYear() > 1971 ? `Last check ${new Date(s.last_check).toLocaleTimeString()} · ${s.matched} new matching mail · ${s.captured} captured since start`
        : c.enabled ? 'Waiting for first check…' : '';
      $('#mailStatus').style.color = s.last_error ? 'var(--danger)' : '';
      // Proof the check really read Outlook: the newest mail in the folder, and the last matching one.
      const line = (label, m, extra = '') => m ? `<div><span class="muted">${label}</span> <b>${esc(new Date(m.received).toLocaleString())}</b> · ${esc(m.from || '')}${m.address && m.address !== m.from ? ` &lt;${esc(m.address)}&gt;` : ''} · “${esc(m.subject || '(no subject)')}”${extra}</div>` : '';
      $('#mailProof').innerHTML = s.supported && !s.last_error && s.last_check && new Date(s.last_check).getFullYear() > 1971
        ? line(`Newest email in ${esc(s.folder)}:`, s.newest) + (s.newest ? '' : `<div class="muted">The ${esc(s.folder)} folder is empty.</div>`) +
          (s.last_match ? line('Last email from a watched sender:', s.last_match, s.last_match.captured ? ' <span class="ok">✓ captured</span>' : ' <span class="muted">(no hosts/logins found in it)</span>') : '<div class="muted">No email from your watched senders yet.</div>')
        : '';
    } catch { /* ignore */ }
  },
};
$('#mailOn').onchange = e => Mail.save({ enabled: e.target.checked }).then(() => e.target.checked && api('POST', '/api/mail/check'));
$('#mailAdd').onclick = () => {
  const m = $('#mailMatch').value.trim();
  if (!m) return toast('Enter a sender address, *@domain or name', true);
  Mail.save({ rules: [...Mail.cfg().rules, { match: m, project: $('#mailProject').value.trim() }] });
  $('#mailMatch').value = ''; $('#mailProject').value = '';
};
$('#mailMatch').addEventListener('keydown', e => { if (e.key === 'Enter') $('#mailAdd').click(); });
$('#mailRules').addEventListener('click', e => { const x = e.target.closest('[data-rule]'); if (x) Mail.save({ rules: Mail.cfg().rules.filter((_, i) => i !== +x.dataset.rule) }); });
$('#mailFolder').onchange = e => Mail.save({ folder: e.target.value.trim() });
$('#mailEvery').onchange = e => Mail.save({ minutes: +e.target.value });
$('#mailBack').onchange = e => Mail.save({ lookback: +e.target.value });
$('#mailKeepAll').onchange = e => Mail.save({ keep_all: e.target.checked });
$('#mailCheck').onclick = async () => { await api('POST', '/api/mail/check'); $('#mailStatus').textContent = 'Checking…'; setTimeout(() => { Mail.status(); poll(); }, 3000); };
setInterval(() => { if ($('#view-inbox').classList.contains('active')) Mail.status(); }, 10000);

// ---------- local command prompts ----------
let SHELLS = [];
api('GET', '/api/local/shells').then(list => {
  SHELLS = list || [];
  $('#localShells').innerHTML = SHELLS.map((s, i) => `<button data-sh="${i}">⌨ ${esc(s.name)}</button>`).join('');
}).catch(() => {});
$('#localShells').addEventListener('click', e => { const b = e.target.closest('[data-sh]'); if (b) Term.openLocal(SHELLS[b.dataset.sh]); });

// ---------- git ----------
const Git = {
  repo: '', ref: '', info: null, commits: [], selected: '',

  repos() { return S.settings.repos || []; },
  async saveRepos(list) { await saveSettings({ repos: [...new Set(list)] }); this.renderRepos(); },

  renderRepos() {
    const list = this.repos();
    $('#gitRepoList').innerHTML = list.map(p => {
      const parts = p.split(/[\\/]/).filter(Boolean);
      return `<div class="repo ${p === this.repo ? 'active' : ''}" data-repo="${esc(p)}" title="${esc(p)}"><span class="nm">${esc(parts.pop())}<small>${esc(parts.slice(-2).join('/'))}</small></span><span class="x" data-rm="${esc(p)}" title="Remove from list">✕</span></div>`;
    }).join('') || '<div class="empty" style="padding:16px">No repositories yet.</div>';
    $('#gitEmpty').hidden = !!this.repo;
    $('#gitSplit').hidden = !this.repo;
  },

  async open(p, ref) {
    if (ref === undefined) { try { ref = localStorage.getItem('gitRef.' + p) || ''; } catch { ref = ''; } }
    this.repo = p; this.ref = ref; this.selected = '';
    try { localStorage.setItem('gitRepo', p); } catch { /* ignore */ }
    this.renderRepos();
    $('#gitTitle').textContent = p.split(/[\\/]/).filter(Boolean).pop();
    try {
      this.info = await api('GET', '/api/git/info?path=' + encodeURIComponent(p));
      $('#gitFetch').disabled = !this.info.has_git;
      $('#gitFetch').title = this.info.has_git ? 'git fetch --all --prune (uses your installed Git and its logins)' : 'Git is not installed on this PC; browsing still works';
      this.renderBranches();
      await this.loadLog();
    } catch (err) {
      $('#gitLog').innerHTML = `<div class="empty">${esc(err.message)}</div>`;
      $('#gitBranches').innerHTML = '';
    }
  },

  renderBranches() {
    const q = $('#gitBranchFilter').value.trim().toLowerCase();
    const list = (this.info?.branches || []).filter(b => !q || b.name.toLowerCase().includes(q));
    const row = b => `<div class="br ${b.current ? 'current' : ''} ${(this.ref || this.info.current) === b.name ? 'active' : ''}" data-ref="${esc(b.name)}" title="${esc(b.subject)}">
      <div class="bn">${esc(b.name)}</div><small>${fmtTime(b.date)} · ${esc(b.author || '')} · ${esc(b.subject || '')}</small></div>`;
    const local = list.filter(b => !b.remote), remote = list.filter(b => b.remote);
    $('#gitBranches').innerHTML = (local.length ? '<div class="br-sep">Local</div>' + local.map(row).join('') : '') +
      (remote.length ? '<div class="br-sep">Remote</div>' + remote.map(row).join('') : '') || '<div class="empty">No branches</div>';
    $('#gitViewing').textContent = this.ref || this.info.current || '';
  },

  async loadLog() {
    const q = $('#gitSearch').value.trim();
    $('#gitLog').innerHTML = '<div class="empty">Loading history…</div>';
    try {
      this.commits = await api('GET', `/api/git/log?path=${encodeURIComponent(this.repo)}&ref=${encodeURIComponent(this.ref)}&q=${encodeURIComponent(q)}&limit=500`);
    } catch (err) { $('#gitLog').innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }
    const refBadge = r => `<span class="ref ${r.includes('/') && !this.info.branches.some(b => !b.remote && b.name === r) ? 'remote' : ''} ${this.info.branches.some(b => b.name === r) ? '' : 'tag'}">${esc(r)}</span>`;
    $('#gitLog').innerHTML = this.commits.map(c => `<div class="cm ${c.hash === this.selected ? 'active' : ''}" data-c="${c.hash}">
      <span class="d" title="${esc(new Date(c.date).toLocaleString())}">${fmtDateTime(c.date)}</span><span class="h">${c.short}</span>
      <span class="s">${(c.refs || []).map(refBadge).join('')}${esc(c.subject)}</span><span class="a" title="${esc(c.email)}">${esc(c.author)}</span></div>`).join('')
      || '<div class="empty">No commits.</div>';
  },

  async show(hash) {
    this.selected = hash;
    $$('#gitLog .cm').forEach(x => x.classList.toggle('active', x.dataset.c === hash));
    $('#gitDetail').innerHTML = '<div class="empty">Loading…</div>';
    try {
      const r = await api('GET', `/api/git/commit?path=${encodeURIComponent(this.repo)}&hash=${hash}`);
      const c = r.commit;
      $('#gitDetail').innerHTML = `<div class="cd-head"><h4>${esc(c.subject)}</h4>
        <span class="muted tiny"><span class="h copy" data-copy="${c.hash}" title="Copy full hash">${c.short}</span> · ${esc(c.author)} &lt;${esc(c.email)}&gt; · ${new Date(c.date).toLocaleString()}${c.parents.length > 1 ? ' · merge' : ''}</span>
        ${c.body ? `<pre>${esc(c.body)}</pre>` : ''}</div>
        <div class="cd-files">${r.files.map((f, i) => `<div data-f="${i}"><span class="fs ${f.status}">${f.status}</span>${esc(f.path)} <span class="n">+${f.adds} −${f.dels}</span></div>`).join('')}</div>
        <pre class="diff">${diffHTML(r.patch)}</pre>`;
    } catch (err) { $('#gitDetail').innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
  },

  async changes() {
    $('#gitDetail').innerHTML = '<div class="empty">Checking the working folder…</div>';
    try {
      const list = await api('GET', '/api/git/status?path=' + encodeURIComponent(this.repo));
      const label = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', '?': 'untracked', C: 'copied', U: 'conflict' };
      $('#gitDetail').innerHTML = `<div class="cd-head"><h4>Uncommitted changes (${list.length})</h4></div><div class="cd-files">` +
        (list.map(f => { const s = f.worktree !== ' ' ? f.worktree : f.staged; return `<div><span class="fs ${s === '?' ? 'A' : s}">${esc(s)}</span>${esc(f.path)} <span class="n">${label[s] || ''}${f.staged !== ' ' && f.staged !== '?' ? ' · staged' : ''}</span></div>`; }).join('') || 'Nothing to commit — working folder is clean.') + '</div>';
    } catch (err) { $('#gitDetail').innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
  },
};

function diffHTML(text) {
  return text.split('\n').map(l => {
    const cls = l.startsWith('diff --git') ? 'file' : l.startsWith('@@') ? 'hunk' : l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : '';
    return `<span class="${cls}">${esc(l) || ' '}</span>`;
  }).join('');
}

$('#gitRepoList').addEventListener('click', e => {
  const rm = e.target.closest('[data-rm]');
  if (rm) { if (Git.repo === rm.dataset.rm) Git.repo = ''; return Git.saveRepos(Git.repos().filter(p => p !== rm.dataset.rm)); }
  const r = e.target.closest('[data-repo]');
  if (r) Git.open(r.dataset.repo);
});
$('#gitBranches').addEventListener('click', e => {
  const b = e.target.closest('[data-ref]'); if (!b) return;
  Git.ref = b.dataset.ref;
  try { localStorage.setItem('gitRef.' + Git.repo, Git.ref); } catch { /* ignore */ }
  Git.renderBranches(); Git.loadLog();
});
$('#gitBranchFilter').addEventListener('input', () => Git.info && Git.renderBranches());
$('#gitLog').addEventListener('click', e => { const c = e.target.closest('[data-c]'); if (c) Git.show(c.dataset.c); });
$('#gitDetail').addEventListener('click', e => {
  const cp = e.target.closest('[data-copy]'); if (cp) return copyText(cp.dataset.copy, 'Hash copied');
  const f = e.target.closest('[data-f]');
  if (f) { const heads = $$('#gitDetail .diff .file'); heads[+f.dataset.f]?.scrollIntoView({ block: 'start' }); }
});
let gitSearchTimer;
$('#gitSearch').addEventListener('input', () => { clearTimeout(gitSearchTimer); gitSearchTimer = setTimeout(() => Git.repo && Git.loadLog(), 400); });
$('#gitChanges').onclick = () => Git.repo && Git.changes();
$('#gitTerm').onclick = () => { if (Git.repo && SHELLS.length) Term.openLocal(SHELLS[0], Git.info?.root || Git.repo); };
$('#gitFetch').onclick = async () => {
  if (!Git.repo) return;
  toast('Fetching…');
  try { const r = await api('POST', '/api/git/fetch', { path: Git.info?.root || Git.repo }); toast(r.output ? 'Fetched: ' + r.output.split('\n').length + ' update line(s)' : 'Fetched — already up to date'); Git.open(Git.repo, Git.ref); }
  catch (err) { toast(err.message, true); }
};
$('#gitAdd').onclick = async () => {
  toast('Choose the repository folder in the window that opened (it may be behind the browser)');
  try {
    const r = await api('POST', '/api/local/pick', { start: '' });
    if (!r.ok) return;
    const info = await api('GET', '/api/git/info?path=' + encodeURIComponent(r.path));
    const root = info.root || r.path;
    await Git.saveRepos([...Git.repos(), root]);
    Git.open(root);
  } catch (err) { toast('Not a Git repository: ' + err.message, true); }
};
$('#gitFind').onclick = async () => {
  toast('Looking for repositories…');
  try {
    const found = (await api('GET', '/api/git/find')).filter(p => !Git.repos().includes(p));
    if (!found.length) return toast('No new repositories found');
    if (!confirm(`Found ${found.length} repositories:\n\n${found.slice(0, 25).join('\n')}${found.length > 25 ? '\n…' : ''}\n\nAdd them all?`)) return;
    await Git.saveRepos([...Git.repos(), ...found]);
    if (!Git.repo) Git.open(found[0]);
  } catch (err) { toast(err.message, true); }
};

// ---------- notes / editor ----------
const Notes = {
  docs: [], active: null, notes: [], recent: [], timer: null,

  async renderLists() {
    [this.notes, this.recent] = (await Promise.all([api('GET', '/api/notes'), api('GET', '/api/recent')])).map(x => x || []);
    $('#noteList').innerHTML = this.notes.map(n => `<div class="li ${this.active?.key === 'note:' + n.id ? 'active' : ''}" data-open="note:${n.id}">${esc(n.title || 'Untitled')}<small>${fmtTime(n.updated)}</small></div>`).join('') || '<div class="muted tiny">No notes yet</div>';
    $('#recentList').innerHTML = this.recent.map(r => {
      const parts = r.path.split(/[\\/]/);
      return `<div class="li" data-open="file:${esc(r.path)}" title="${esc(r.path)}">${esc(parts.pop())}<small>${esc(parts.join('/'))}</small></div>`;
    }).join('') || '<div class="muted tiny">No recent files</div>';
  },

  async open(key) {
    let d = this.docs.find(x => x.key === key);
    if (!d) {
      try {
        if (key.startsWith('note:')) {
          const n = this.notes.find(x => 'note:' + x.id === key) || (await api('GET', '/api/notes')).find(x => 'note:' + x.id === key);
          if (!n) return;
          let lang = 'text'; try { lang = localStorage.getItem('notelang.' + n.id) || 'text'; } catch { /* ignore */ }
          d = { key, id: n.id, title: n.title || 'Untitled', content: n.body, lang };
        } else {
          const f = await api('GET', '/api/file?path=' + encodeURIComponent(key.slice(5)));
          // Same file typed differently (quotes, ~, other slashes): reuse its tab.
          const same = this.docs.find(x => x.path && x.path.toLowerCase() === f.path.toLowerCase());
          if (same) { this.activate(same); return same; }
          d = { key: 'file:' + f.path, path: f.path, title: f.path.split(/[\\/]/).pop(), content: f.content, lang: langForPath(f.path) };
        }
      } catch (err) { toast(err.message, true); return null; }
      d.dirty = false;
      d.cmDoc = CodeMirror.Doc(d.content, modeOf(d.lang)); // own undo history per tab
      this.docs.push(d);
      this.persistTabs();
    }
    this.activate(d);
    return d;
  },

  activate(d) {
    this.active = d;
    this.cm.swapDoc(d ? d.cmDoc : this.emptyDoc);
    this.cm.setOption('readOnly', d ? false : 'nocursor');
    $('#langPick').value = d ? d.lang : 'text';
    $('#langPick').disabled = !d;
    this.renderTabs(); this.status(d ? (d.path || 'Note — saved automatically') : ''); updateCursor();
    if (d) setTimeout(() => { this.cm.refresh(); this.cm.focus(); });
    $$('#noteList .li').forEach(li => li.classList.toggle('active', li.dataset.open === d?.key));
  },

  renderTabs() {
    $('#docTabs').innerHTML = this.docs.map(d => `<div class="tab ${d === this.active ? 'active' : ''}" data-k="${esc(d.key)}" title="${esc(d.path || d.title)}">
      ${d.dirty ? '●' : ''}${typeof Groups !== 'undefined' ? Groups.chip((d.path || '') + ' ' + d.title + ' ' + (d.content || '').slice(0, 20000)) : ''}${esc(d.title)}<span class="x" data-x="${esc(d.key)}">✕</span></div>`).join('');
  },

  status(msg) { $('#docStatus').textContent = msg; },

  edited() {
    const d = this.active; if (!d) return;
    d.content = d.cmDoc.getValue();
    if (!d.dirty) { d.dirty = true; this.renderTabs(); }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.save(d), 800);
  },

  async save(d) {
    if (!d || !d.dirty) return;
    const content = d.content;
    this.status('Saving…');
    try {
      if (d.id) {
        const title = (content.split('\n').find(l => l.trim()) || 'Untitled').trim().slice(0, 60);
        await api('POST', '/api/notes', { id: d.id, title, body: content });
        d.title = title;
      } else {
        await api('PUT', '/api/file', { path: d.path, content });
      }
      if (d.content === content) d.dirty = false;
      this.renderTabs();
      if (d === this.active) this.status(`Saved ${new Date().toLocaleTimeString()}`);
    } catch (err) {
      this.status('Save failed: ' + err.message);
      toast('Save failed: ' + err.message, true);
    }
  },

  async close(key) {
    const d = this.docs.find(x => x.key === key);
    await this.save(d);
    this.docs = this.docs.filter(x => x !== d);
    this.persistTabs();
    if (this.active === d) { this.active = null; this.activate(this.docs.at(-1) || null); } else this.renderTabs();
  },

  persistTabs() { saveSettings({ open_tabs: this.docs.map(d => d.key) }).catch(() => {}); },
};

Notes.emptyDoc = CodeMirror.Doc('', 'text/plain');
Notes.cm = makeEditor($('#editorHost'), { value: '', readOnly: 'nocursor' });
Notes.cm.addKeyMap({ 'Ctrl-S': () => { clearTimeout(Notes.timer); Notes.save(Notes.active); }, 'Cmd-S': () => { clearTimeout(Notes.timer); Notes.save(Notes.active); } });
Notes.cm.on('changes', () => { if (Notes.active && Notes.cm.getDoc() === Notes.active.cmDoc) Notes.edited(); });
Notes.cm.on('cursorActivity', updateCursor);
function updateCursor() {
  const cm = Notes.cm, c = cm.getCursor(), sel = cm.getSelection();
  $('#cursorPos').textContent = Notes.active ? `Ln ${c.line + 1}, Col ${c.ch + 1}${sel ? ` · ${sel.length} selected` : ''} · ${cm.lineCount()} lines` : '';
}
$('#langPick').innerHTML = LANGS.map(([id, name]) => `<option value="${id}">${esc(name)}</option>`).join('');
$('#langPick').onchange = e => {
  const d = Notes.active; if (!d) return;
  d.lang = e.target.value;
  Notes.cm.setOption('mode', modeOf(d.lang));
  if (d.id) { try { localStorage.setItem('notelang.' + d.id, d.lang); } catch { /* ignore */ } }
};
$('#wrapToggle').checked = (() => { try { return localStorage.getItem('wrap') === '1'; } catch { return false; } })();
Notes.cm.setOption('lineWrapping', $('#wrapToggle').checked);
$('#wrapToggle').onchange = e => { Notes.cm.setOption('lineWrapping', e.target.checked); try { localStorage.setItem('wrap', e.target.checked ? '1' : '0'); } catch { /* ignore */ } };
$('#docTabs').addEventListener('click', e => {
  const x = e.target.closest('[data-x]');
  if (x) return Notes.close(x.dataset.x);
  const t = e.target.closest('[data-k]');
  if (t) Notes.activate(Notes.docs.find(d => d.key === t.dataset.k));
});
$('#view-notes').addEventListener('click', e => { const o = e.target.closest('[data-open]'); if (o) Notes.open(o.dataset.open); });
$('#newNote').onclick = async () => {
  const n = await api('POST', '/api/notes', { title: 'Untitled', body: '' });
  await Notes.renderLists();
  await Notes.open('note:' + n.id);
  Notes.cm.focus();
};
async function browseFile() {
  toast('Choose a file in the window that opened (it may be behind the browser)');
  try {
    const r = await api('POST', '/api/local/pickfile');
    if (r.ok) await Notes.open('file:' + r.path);
  } catch (err) { toast(err.message, true); }
}
// Open: the typed path, or (like Notepad++) the system Open window when empty.
$('#openBtn').onclick = async () => {
  const p = $('#openPath').value.trim().replace(/^["']|["']$/g, '');
  if (!p) return browseFile();
  if (await Notes.open('file:' + p)) $('#openPath').value = ''; // keep a mistyped path for fixing
};
$('#browseFile').onclick = browseFile;
$('#openPath').addEventListener('keydown', e => { if (e.key === 'Enter') $('#openBtn').click(); });
$('#extractBtn').onclick = async () => {
  const d = Notes.active; if (!d || !d.content.trim()) return;
  try {
    const r = await api('POST', '/api/ingest', { text: d.content, source: 'note', project: S.settings.project });
    toast(r.entries?.length ? `Filed ${r.entries.length} item(s) on the Dashboard` : 'No hosts/URLs/credentials recognised');
    poll();
  } catch (err) { toast(err.message, true); }
};
// Flush unsaved edits if the tab is closed (notes only; sendBeacon can only POST).
window.addEventListener('beforeunload', () => {
  for (const d of Notes.docs.filter(d => d.dirty)) {
    if (d.id) navigator.sendBeacon('/api/notes', new Blob([JSON.stringify({ id: d.id, title: d.title, body: d.content })], { type: 'application/json' }));
    else navigator.sendBeacon('/api/file', new Blob([JSON.stringify({ path: d.path, content: d.content })], { type: 'application/json' }));
  }
});

// ---------- resizable layout ----------
// Drag bars resize the sidebar, the server trees and FileZilla's two panes;
// sizes and hidden panels are remembered per browser.
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('ui.' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ui.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

function dragBar(bar, { start, apply, done }) {
  bar.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    const x0 = e.clientX, w0 = start();
    bar.setPointerCapture(e.pointerId);
    bar.classList.add('drag'); document.body.classList.add('dragging');
    let raf = 0;
    const move = ev => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { apply(w0 + ev.clientX - x0); fitActiveTerm(); });
    };
    const up = () => {
      bar.removeEventListener('pointermove', move);
      bar.classList.remove('drag'); document.body.classList.remove('dragging');
      done?.();
      fitActiveTerm();
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up, { once: true });
    bar.addEventListener('pointercancel', up, { once: true });
  });
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const root = document.documentElement;

// Text size per pane: A−/A+ buttons or Ctrl + mouse wheel. (Ctrl +/− in the
// browser still zooms the whole app.)
const Fonts = {
  sizes: store.get('fonts', { term: 13, editor: 13, sql: 13 }), // terminal 13px ≈ PuTTY's Courier New 10pt
  size(k) { return this.sizes[k] || 13; },
  set(k, v) {
    this.sizes[k] = clamp(Math.round(v), 8, 32);
    store.set('fonts', this.sizes);
    this.apply();
  },
  apply() {
    root.style.setProperty('--fs-editor', this.size('editor') + 'px');
    root.style.setProperty('--fs-sql', this.size('sql') + 'px');
    Term.tabs.forEach(t => { t.term.options.fontSize = this.size('term'); });
    fitActiveTerm();
    $$('.fontctl').forEach(c => ($('span', c).textContent = this.size(c.dataset.font) + 'px'));
    Notes.cm?.refresh(); SQL.cm?.refresh();
  },
};
$$('.fontctl').forEach(c => c.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  Fonts.set(c.dataset.font, Fonts.size(c.dataset.font) + (b.textContent.includes('+') ? 1 : -1));
}));
for (const [sel, k] of [['#termWrap', 'term'], ['.editor', 'editor'], ['.sql-left', 'sql']]) {
  $(sel).addEventListener('wheel', e => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault(); // otherwise the browser zooms the whole page
    Fonts.set(k, Fonts.size(k) + (e.deltaY < 0 ? 1 : -1));
  }, { passive: false });
}

// Sidebar
const setSide = w => root.style.setProperty('--side-w', clamp(w, 170, 420) + 'px');
setSide(store.get('sideW', 236));
Fonts.apply();
// The menu can sit on the left (default) or across the top (remembered).
function applySideTop(top) {
  document.body.classList.toggle('side-top', top);
  (top ? $('.side') : $('.appbar')).append($('#gsearch')); // search stays at the top right
  const b = $('#sideFlip');
  b.title = top ? 'Move this menu back to the left' : 'Move this menu to the top of the window';
  b.innerHTML = top ? '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>' : '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/></svg>';
  setTimeout(() => { fitActiveTerm(); window.dispatchEvent(new Event('resize')); }, 50);
}
applySideTop((() => { try { return localStorage.getItem('sideTop') === '1'; } catch { return false; } })());
$('#sideFlip').onclick = () => {
  const top = !document.body.classList.contains('side-top');
  try { localStorage.setItem('sideTop', top ? '1' : '0'); } catch { /* ignore */ }
  S.autoSide = false; S.userSide = false;
  applySideTop(top);
  applySide();
};

// Narrow windows (under 1000px) show the sidebar as icons only.
const narrowWin = matchMedia('(max-width: 1000px)');
const applySide = () => {
  const top = document.body.classList.contains('side-top'); // at the top: icons only on narrow windows
  document.body.classList.toggle('side-collapsed', narrowWin.matches || (!top && store.get('sideCollapsed', false)));
  if ($('#sideToggle')) $('#sideToggle').textContent = document.body.classList.contains('side-collapsed') ? '»' : '«';
};
applySide();
narrowWin.addEventListener('change', () => { applySide(); fitActiveTerm(); });
dragBar($('#sideSplit'), {
  start: () => $('.side').getBoundingClientRect().width,
  apply: setSide,
  done: () => store.set('sideW', parseInt(getComputedStyle(root).getPropertyValue('--side-w'))),
});
function toggleSide() {
  const c = document.body.classList.toggle('side-collapsed');
  S.autoSide = false; S.userSide = !c; // expanded by hand: leave it open until the user collapses it or goes back to the dashboard
  if (!narrowWin.matches) store.set('sideCollapsed', c); // on a narrow window: just for now
  $('#sideToggle').textContent = c ? '»' : '«';
  fitActiveTerm();
}
$('#sideToggle').textContent = document.body.classList.contains('side-collapsed') ? '»' : '«';
$('#sideToggle').onclick = toggleSide;
document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b' && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); toggleSide(); } });
$$('#nav button[data-view]').forEach(b => (b.title = $('.nl', b)?.textContent || ''));

// Server trees (PuTTY and FileZilla, sized separately)
$$('.with-tree').forEach(wt => {
  const key = 'tree.' + $('.tree-host', wt).dataset.mode, bar = $('.tree-split', wt), knob = $('.knob', bar);
  const setW = w => wt.style.setProperty('--tree-w', clamp(w, 160, 600) + 'px');
  const toggle = () => {
    const hidden = wt.classList.toggle('tree-hidden');
    knob.textContent = hidden ? '›' : '‹';
    store.set(key + '.hidden', hidden);
    fitActiveTerm();
  };
  if (store.get(key + '.w', 0)) setW(store.get(key + '.w', 0)); // else the CSS default, which grows with the screen
  if (store.get(key + '.hidden', false)) { wt.classList.add('tree-hidden'); knob.textContent = '›'; }
  dragBar(bar, {
    start: () => wt.classList.contains('tree-hidden') ? 0 : $('.tree-host', wt).getBoundingClientRect().width,
    apply: w => {
      if (wt.classList.contains('tree-hidden')) { if (w < 60) return; toggle(); }
      setW(w);
    },
    done: () => store.set(key + '.w', parseInt(wt.style.getPropertyValue('--tree-w'))),
  });
  knob.onclick = toggle;
  bar.addEventListener('dblclick', toggle);
});

// SQL: editor vs results
{
  const bar = $('#sqlSplit'), ed = $('#sqlEditorHost');
  const saved = store.get('sqlEdH', null);
  if (saved) ed.style.height = saved + 'px';
  bar.addEventListener('pointerdown', e => {
    e.preventDefault();
    const y0 = e.clientY, h0 = ed.getBoundingClientRect().height;
    bar.setPointerCapture(e.pointerId);
    bar.classList.add('drag'); document.body.classList.add('rdragging');
    const move = ev => { ed.style.height = clamp(h0 + ev.clientY - y0, 60, window.innerHeight - 220) + 'px'; };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', () => {
      bar.removeEventListener('pointermove', move);
      bar.classList.remove('drag'); document.body.classList.remove('rdragging');
      store.set('sqlEdH', parseInt(ed.style.height));
      SQL.cm.refresh();
    }, { once: true });
  });
}

// Dashboard: resizable table columns and card width
{
  const board = $('#board');
  const widths = store.get('colWidths', {});
  for (const [i, w] of Object.entries(widths)) board.style.setProperty('--c' + i, w + 'px');
  board.addEventListener('pointerdown', e => {
    const grip = e.target.closest('.colgrip'); if (!grip) return;
    e.preventDefault();
    const i = grip.dataset.col, th = grip.parentElement, x0 = e.clientX, w0 = th.getBoundingClientRect().width;
    grip.setPointerCapture(e.pointerId);
    document.body.classList.add('dragging');
    const move = ev => board.style.setProperty('--c' + i, clamp(w0 + ev.clientX - x0, 40, 900) + 'px');
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', () => {
      grip.removeEventListener('pointermove', move);
      document.body.classList.remove('dragging');
      widths[i] = parseInt(board.style.getPropertyValue('--c' + i));
      store.set('colWidths', widths);
    }, { once: true });
  });
  board.addEventListener('dblclick', e => {
    const grip = e.target.closest('.colgrip'); if (!grip) return;
    board.style.removeProperty('--c' + grip.dataset.col);
    delete widths[grip.dataset.col];
    store.set('colWidths', widths);
  });
  const slider = $('#cardWidth');
  const setCard = w => { board.style.setProperty('--card-w', w + 'px'); slider.value = w; };
  setCard(store.get('cardW', 340));
  slider.addEventListener('input', () => setCard(+slider.value));
  slider.addEventListener('change', () => store.set('cardW', +slider.value));
}

// FileZilla: This PC vs server
{
  const panes = $('.panes'), mid = $('.mid', panes);
  const setL = w => panes.style.setProperty('--lp', clamp(w, 160, panes.clientWidth - 260) + 'px');
  const saved = store.get('filesLeft', null);
  if (saved) panes.style.setProperty('--lp', saved + 'px');
  dragBar(mid, {
    start: () => $('#localPane').getBoundingClientRect().width,
    apply: setL,
    done: () => store.set('filesLeft', parseInt(panes.style.getPropertyValue('--lp'))),
  });
  mid.addEventListener('dblclick', e => { if (!e.target.closest('button')) { panes.style.removeProperty('--lp'); store.set('filesLeft', null); } });
}

// ---------- start ----------
(async () => {
  await poll();
  for (const k of S.settings.open_tabs || []) await Notes.open(k);
  if (!Notes.docs.length) Notes.activate(null);
  const v = location.hash.slice(1);
  if (document.getElementById('view-' + v)) show(v);
  if (v.startsWith('ask=')) { Chat.toggle(true); Chat.send(decodeURIComponent(v.slice(4))); }
})();

// Connecting from PuTTY/FileZilla/SQL right after a search counts as "searched for"
// (the connection itself is counted by the server).
for (const [obj, fn] of [[Term, 'open'], [Remote, 'connect'], [SQL, 'open']]) {
  const orig = obj[fn].bind(obj);
  obj[fn] = (e, ...rest) => { markSearched(e); return orig(e, ...rest); };
}

// Backups window
async function showBackups() {
  const r = await api('GET', '/api/backups').catch(err => (toast(err.message, true), null));
  if (!r) return;
  $('#backupFolder').textContent = r.folder;
  $('#backupList').innerHTML = r.backups.map((b, i) => `<div class="grow"><span>${i === 0 ? '<b>' : ''}${esc(fmtDateTime(b.when))}${i === 0 ? '</b> (latest)' : ''}</span><span class="spacer"></span><span class="muted tiny">${fmtSize(b.size)} · ${esc(b.name)}</span></div>`).join('')
    || '<div class="muted tiny" style="padding:8px">No backups yet — one is made at start-up when there is data.</div>';
  $('#backupCopyTo').textContent = r.copy_to || 'Not copied anywhere else';
  $('#backupCopyState').innerHTML = !r.copy_to ? '' : r.copy_error ? `<span style="color:var(--danger)">⚠ Last copy failed: ${esc(r.copy_error)}</span>`
    : r.copy_at ? `<span style="color:var(--ok)">✓ Last copied ${esc(fmtDateTime(r.copy_at))}</span>` : '<span class="muted">Each new backup is copied there.</span>';
  $('#backupOneDrive').hidden = !r.onedrive || r.copy_to === r.onedrive;
  $('#backupOneDrive').title = r.onedrive ? 'Copy backups to ' + r.onedrive : '';
  $('#backupCopyOff').hidden = !r.copy_to;
  Backups.onedrive = r.onedrive;
  if (!$('#backupDlg').open) $('#backupDlg').showModal();
}
const Backups = {
  onedrive: '',
  async copyTo(folder) {
    try { await api('POST', '/api/backups/copy', { folder }); toast(folder ? 'Backups are now also copied to ' + folder : 'Backups are no longer copied'); }
    catch (err) { toast(err.message, true); }
    showBackups();
  },
};
$('#backupOneDrive').onclick = () => Backups.copyTo(Backups.onedrive);
$('#backupCopyOff').onclick = () => Backups.copyTo('');
$('#backupCopyPick').onclick = async () => {
  toast('Choose a folder in the window that opened (it may be behind WorkHub)');
  const r = await api('POST', '/api/local/pick', { start: '' }).catch(err => (toast(err.message, true), null));
  if (r?.ok) Backups.copyTo(r.path);
};
$('#backupBtn').onclick = showBackups;
$('#backupClose').onclick = () => $('#backupDlg').close();
$('#backupReveal').onclick = () => api('POST', '/api/backups/reveal').catch(err => toast(err.message, true));
$('#backupNow').onclick = async () => {
  $('#backupNow').disabled = true;
  try { const r = await api('POST', '/api/backups'); toast('Backup made: ' + r.name); await showBackups(); } catch (err) { toast(err.message, true); }
  $('#backupNow').disabled = false;
};
