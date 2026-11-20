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
  if (r.status === 401) {
    document.body.innerHTML = '<div class="empty">Session expired. Start <b>WorkHub.exe</b> again to open a fresh window.</div>';
    throw new Error('unauthorized');
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), err ? 5000 : 2200);
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
const byId = id => S.entries.find(e => e.id === id);

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
  [/(^|[.\-])jenkins[.\-:]|\/jenkins(\/|$)/, 'Jenkins'],
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
function show(view) {
  $$('#nav button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
  history.replaceState(null, '', '#' + view);
  if (view === 'terminal') fitActiveTerm();
  if (view === 'files' && !Local.loaded) Local.load('');
  if (view === 'notes') { Notes.cm.refresh(); Notes.cm.focus(); }
  if (view === 'bookmarks') {
    Bookmarks.sync(false);
    // Re-check links not checked in the last hour.
    const stale = S.entries.filter(e => /^https?:/i.test(e.url || '') && (!e.status_at || Date.now() - new Date(e.status_at) > 3600e3)).map(e => e.id);
    if (stale.length) Bookmarks.check(stale);
  }
  if (view === 'sql') SQL.fit();
  if (view === 'git') {
    Git.renderRepos();
    let last = ''; try { last = localStorage.getItem('gitRepo') || ''; } catch { /* ignore */ }
    if (!Git.repo && Git.repos().length) Git.open(Git.repos().includes(last) ? last : Git.repos()[0]);
  }
}
$('#nav').addEventListener('click', e => { const b = e.target.closest('button[data-view]'); if (b) show(b.dataset.view); });
$('#navSearch').onclick = () => { show('dashboard'); $('#search').focus(); $('#search').select(); };

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    show('dashboard');
    $('#search').select();
  }
});

// ---------- sync ----------
async function refreshAll() {
  const [entries, clips, settings] = await Promise.all([api('GET', '/api/entries'), api('GET', '/api/clips'), api('GET', '/api/settings')]);
  S.entries = entries || []; S.clips = clips || []; S.settings = settings;
  renderSettings(); renderFilters(); renderBoard(); renderClips(); Tree.render(); Bookmarks.render(); Notes.renderLists();
}

async function poll() {
  try {
    const { v, data_dir, app_version } = await api('GET', '/api/version');
    $('#dataDir').textContent = 'Data: ' + data_dir;
    $('#appVersion').textContent = 'Version ' + app_version;
    if (v !== S.version) { S.version = v; await refreshAll(); }
  } catch (e) { /* server stopped or session expired */ }
}
setInterval(poll, 2500);

// ---------- settings / capture ----------
function renderSettings() {
  $('#wsName').textContent = S.settings.workspace || 'Default';
  document.title = `WorkHub — ${S.settings.workspace || 'Default'}`;
  $('#watchToggle').checked = !!S.settings.watch;
  $('#captureAll').checked = !!S.settings.capture_all;
  $('#bmSync').checked = !S.settings.no_browser_sync;
  if (document.activeElement !== $('#captureProject')) $('#captureProject').value = S.settings.project || 'General';
}
async function saveSettings(patch) {
  S.settings = await api('PUT', '/api/settings', { ...S.settings, ...patch });
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

function matches(e, q) {
  if (!q) return true;
  const hay = [e.name, e.host, e.url, urlLabel(e.url), e.username, e.project, e.env, e.protocol, e.port, e.notes, ...(e.tags || []), ...Object.entries(e.extra || {}).flat()].join(' ').toLowerCase();
  return q.split(/\s+/).every(w => hay.includes(w));
}

function filtered() {
  const q = $('#search').value.trim().toLowerCase(), p = $('#fProject').value, env = $('#fEnv').value;
  return S.entries.filter(e => (!p || e.project === p) && (!env || e.env === env) && matches(e, q));
}

const isFTP = e => ['ftp', 'ftps'].includes(e.protocol) || (!e.protocol && e.port === 21);
const canSSH = e => !!e.host && !isFTP(e) && (['', 'ssh', 'sftp', 'scp'].includes(e.protocol || '') || e.port === 22);
const canFiles = e => canSSH(e) || (!!e.host && isFTP(e));
const dbKindOf = e => ['oracle'].includes(e.protocol) || (!e.protocol && [1521, 1522].includes(e.port)) ? 'oracle'
  : ['postgres', 'postgresql'].includes(e.protocol) || (!e.protocol && e.port === 5432) ? 'postgres' : '';
const canDB = e => !!e.host && !!dbKindOf(e);
// Status dot: green = last connection/link check worked, red = failed, grey = not tried.
function dot(e) {
  const when = e.status_at ? new Date(e.status_at).toLocaleString() : '';
  const title = e.status === 'ok' ? `Worked last time · ${when}` : e.status === 'fail' ? `Failed · ${when}\n${e.status_msg || ''}` : 'Not tried yet';
  return `<span class="dot ${e.status || 'none'}" title="${esc(title)}"></span>`;
}

function renderStats(list) {
  const today = new Date().toDateString();
  const capturedToday = S.clips.filter(c => new Date(c.created).toDateString() === today).length;
  const stats = [
    ['Hosts', new Set(list.map(e => (e.host || '').toLowerCase()).filter(Boolean)).size],
    ['Entries', list.length],
    ['Credentials', list.filter(e => e.username || e.has_password).length],
    ['URLs', list.filter(e => e.url).length],
    ['PROD', list.filter(e => e.env === 'PROD').length],
    ['Captured today', capturedToday],
  ];
  $('#stats').innerHTML = stats.map(([k, v]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join('');
  $('#inboxCount').textContent = capturedToday || '';
}

function renderBoard() {
  const list = filtered();
  renderStats(list);
  const board = $('#board');
  if (!S.entries.length) {
    board.innerHTML = `<div class="empty">Nothing collected yet.<br><br>Turn on <b>Watch clipboard</b> and copy text that contains hosts, URLs or logins,<br>or paste it on the <b>Captured</b> page.</div>`;
    return;
  }
  if (!list.length) { board.innerHTML = '<div class="empty">No matches.</div>'; return; }
  const keyOf = e => S.groupBy === 'env' ? (e.env || 'No environment') : S.groupBy === 'protocol' ? (e.protocol || 'other') : (e.project || 'General');
  const groups = {};
  list.forEach(e => (groups[keyOf(e)] ||= []).push(e));
  board.innerHTML = Object.keys(groups).sort().map(g => {
    const items = groups[g];
    const body = S.layout === 'table' ? tableHTML(items) : cardsHTML(items);
    return `<div class="group"><div class="group-head"><h3>${esc(g)}</h3><span class="n">${items.length}</span>
      ${S.groupBy === 'project' ? `<button class="icon ghost" data-act="rename-project" data-project="${esc(g)}" title="Rename project">✎</button>` : ''}</div>${body}</div>`;
  }).join('');
}

function cardsHTML(items) {
  const hosts = {};
  items.forEach(e => {
    const k = (e.host || e.url || e.name).toLowerCase();
    (hosts[k] ||= []).push(e);
  });
  const cards = Object.values(hosts).sort((a, b) => (b.some(e => e.favorite) - a.some(e => e.favorite)) || (a[0].host || a[0].name).localeCompare(b[0].host || b[0].name));
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

function svcHTML(e) {
  const rows = [];
  const label = [dot(e), e.protocol && `<span class="proto">${esc(e.protocol)}</span>`, e.port && `<span class="proto">:${e.port}</span>`, e.name !== e.host ? esc(e.name) : ''].filter(Boolean).join(' ');
  if (label) rows.push(['', label]);
  if (e.url) rows.push(['URL', `${urlLabel(e.url) ? `<span class="ulabel">${esc(urlLabel(e.url))}</span>` : ''}<a href="${esc(e.url)}" target="_blank" rel="noopener" data-open="${e.id}">${esc(e.url)}</a> <button class="icon" data-copy="${esc(e.url)}">copy</button>`]);
  if (e.username) rows.push(['User', `<span class="copy" data-copy="${esc(e.username)}" title="Copy">${esc(e.username)}</span>`]);
  if (e.has_password) rows.push(['Password', `<span class="copy" data-copy="${esc(e.password)}" title="Copy">${esc(e.password)}</span>`]);
  if (e.key_file) rows.push(['Key', esc(e.key_file)]);
  if (e.last_dir) rows.push(['Last folder', `<span class="copy" data-copy="${esc(e.last_dir)}">${esc(e.last_dir)}</span>`]);
  Object.entries(e.extra || {}).forEach(([k, v]) => rows.push([esc(k), `<span class="copy" data-copy="${esc(v)}">${esc(v)}</span>`]));
  if (e.tags?.length) rows.push(['Tags', `<span class="tag">${e.tags.map(esc).join(', ')}</span>`]);
  if (e.notes) rows.push(['Notes', `<span class="muted">${esc(e.notes)}</span>`]);
  const acts = [
    canSSH(e) && `<button class="icon" data-act="ssh" data-id="${e.id}">SSH</button>`,
    canFiles(e) && `<button class="icon" data-act="sftp" data-id="${e.id}">${isFTP(e) ? 'FTP' : 'SFTP'}</button>`,
    canDB(e) && `<button class="icon" data-act="sql" data-id="${e.id}">SQL</button>`,
    e.url && `<button class="icon" data-act="open" data-id="${e.id}">Open</button>`,
    `<button class="icon" data-act="edit" data-id="${e.id}">Edit</button>`,
    `<button class="icon danger" data-act="del" data-id="${e.id}">Delete</button>`,
  ].filter(Boolean).join('');
  return `<div class="svc">${rows.map(([k, v]) => `<span class="k">${k}</span><span class="v">${v}</span>`).join('')}<div class="svc-actions">${acts}</div></div>`;
}

function tableHTML(items) {
  return `<table class="tbl"><thead><tr><th>Env</th><th>Name</th><th>Host</th><th>Port</th><th>Type</th><th>URL</th><th>User</th><th>Password</th><th></th></tr></thead><tbody>` +
    items.map(e => `<tr>
      <td>${dot(e)} ${e.env ? `<span class="badge ${esc(e.env)}">${esc(e.env)}</span>` : ''}</td>
      <td>${esc(e.name)}</td>
      <td><span class="copy" data-copy="${esc(e.host)}">${esc(e.host)}</span></td>
      <td>${e.port || ''}</td><td>${esc(e.protocol)}</td>
      <td>${urlLabel(e.url) ? `<span class="ulabel">${esc(urlLabel(e.url))}</span> ` : ''}${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener" data-open="${e.id}">${esc(e.url)}</a>` : ''}</td>
      <td><span class="copy" data-copy="${esc(e.username)}">${esc(e.username)}</span></td>
      <td><span class="copy" data-copy="${esc(e.password)}">${esc(e.password)}</span></td>
      <td>${canSSH(e) ? `<button class="icon" data-act="ssh" data-id="${e.id}">SSH</button> ` : ''}<button class="icon" data-act="edit" data-id="${e.id}">Edit</button></td>
    </tr>`).join('') + '</tbody></table>';
}

$('#board').addEventListener('click', async ev => {
  const c = ev.target.closest('[data-copy]');
  if (c) return copyText(c.dataset.copy);
  const b = ev.target.closest('[data-act]');
  if (!b) return;
  const e = byId(b.dataset.id);
  try {
    switch (b.dataset.act) {
      case 'ssh': return Term.open(e);
      case 'sftp': return Remote.connect(e);
      case 'sql': return SQL.open(e);
      case 'open': return openURL(e);
      case 'edit': return openEntryDialog(e);
      case 'del':
        if (!confirm(`Delete ${e.name}?`)) return;
        await api('DELETE', `/api/entries/${e.id}`); return poll();
      case 'fav': await api('POST', '/api/entries', { ...entryInput(e), favorite: !e.favorite }); return poll();
      case 'rename-project': {
        const to = prompt('Rename project', b.dataset.project);
        if (to && to !== b.dataset.project) { await api('POST', '/api/projects/rename', { from: b.dataset.project, to }); poll(); }
      }
    }
  } catch (err) { toast(err.message, true); }
});

['#search', '#fProject', '#fEnv'].forEach(s => $(s).addEventListener('input', renderBoard));
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
  f.tags.value = (v.tags || []).join(', ');
  f.extra.value = Object.entries(v.extra || {}).map(([k, x]) => `${k}=${x}`).join('\n');
  f.favorite.checked = !!v.favorite;
  f.password.value = f.password.dataset.orig = e?.password || '';
  if (e?.prev_passwords?.length) $('#prevPw').textContent = 'Previous passwords: ' + e.prev_passwords.join('   ·   ');
  $('#entryDlg').showModal();
}
$('#newEntry').onclick = () => openEntryDialog(null);
$('#entryDlg').addEventListener('close', async () => {
  if ($('#entryDlg').returnValue !== 'save') return;
  const f = $('#entryForm');
  const extra = {};
  f.extra.value.split('\n').forEach(l => { const i = l.indexOf('='); if (i > 0) extra[l.slice(0, i).trim()] = l.slice(i + 1).trim(); });
  const body = {
    id: editing?.id || '', name: f.name.value, project: f.project.value, host: f.host.value, port: +f.port.value || 0,
    protocol: f.protocol.value, env: f.env.value, url: f.url.value, username: f.username.value, key_file: f.key_file.value,
    tags: f.tags.value.split(',').map(s => s.trim()).filter(Boolean), extra, notes: f.notes.value, favorite: f.favorite.checked,
  };
  if (f.password.value !== f.password.dataset.orig) body.password = f.password.value;
  try { await api('POST', '/api/entries', body); toast('Saved'); poll(); } catch (err) { toast(err.message, true); }
});

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
      `<span class="chip" data-find="${esc(e.host || e.url || e.username)}">${urlLabel(e.url) ? esc(urlLabel(e.url)) + ' · ' : ''}${esc(e.username ? e.username + ' @ ' : '')}${esc(e.host || e.url || '')}${e.port ? ':' + e.port : ''}</span>`).join('');
    return `<div class="clip"><div class="clip-head"><span>${new Date(c.created).toLocaleString()}</span><span class="proto">${esc(c.source)}</span><span>${esc(c.project)}</span>
      <span class="spacer"></span><button class="icon danger" data-del="${c.id}">Delete</button></div>
      <pre>${esc(c.text)}</pre><div class="chips">${chips || '<span class="muted tiny">no hosts or credentials recognised</span>'}</div></div>`;
  }).join('');
}
$('#clips').addEventListener('click', async e => {
  const chip = e.target.closest('[data-find]');
  if (chip) { $('#search').value = chip.dataset.find; $('#fProject').value = ''; $('#fEnv').value = ''; show('dashboard'); return renderBoard(); }
  const del = e.target.closest('[data-del]');
  if (del) { await api('DELETE', `/api/clips/${del.dataset.del}`); poll(); }
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
    show('terminal');
    const el = document.createElement('div');
    el.className = 'termhost';
    $('#termWrap').append(el);
    const term = new Terminal({ cursorBlink: true, fontSize: Fonts.size('term'), scrollback: 20000, fontFamily: '"Cascadia Mono", Consolas, "SF Mono", Menlo, monospace', theme: { background: '#0c0e12' } });
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
    };
    ws.onmessage = m => t.term.write(new Uint8Array(m.data));
    ws.onclose = () => {
      t.closed = true;
      t.term.write('\r\n\x1b[90m[disconnected - press Enter to reconnect]\x1b[0m\r\n');
      this.renderTabs();
    };
  },

  activate(t) {
    this.active = t;
    this.tabs.forEach(x => x.el.classList.toggle('active', x === t));
    $('#termEmpty').style.display = t ? 'none' : '';
    this.renderTabs();
    if (t) requestAnimationFrame(() => { t.fit.fit(); t.term.focus(); });
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
    $('#termTabs').innerHTML = this.tabs.map(t => `<div class="tab ${t === this.active ? 'active' : ''}" data-t="${t.id}">
      <span style="color:${t.closed ? 'var(--muted)' : 'var(--ok)'}">●</span>${t.local ? '⌨ ' + esc(t.local.label) : esc((t.creds.username || t.entry.username || '') + '@' + t.entry.host)}
      <span class="x" data-x="${t.id}">✕</span></div>`).join('');
    $('#termCount').textContent = this.tabs.filter(t => !t.closed).length || '';
  },
};
function fitActiveTerm() { if (Term.active) requestAnimationFrame(() => Term.active.fit.fit()); }
window.addEventListener('resize', fitActiveTerm);
$('#termTabs').addEventListener('click', e => {
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
    async load(p) {
      try {
        const r = await loader(p);
        Object.assign(pane, { path: r.path, parent: r.parent, items: r.entries || [], sep: r.sep || '/', loaded: true, roots: !!r.roots });
        pane.sel.clear();
        $('.path', root).value = r.path;
        pane.render();
      } catch (err) { toast(err.message, true); }
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

const Local = makePane($('#localPane'), p => api('GET', '/api/local/ls?path=' + encodeURIComponent(p)));
const Remote = makePane($('#remotePane'), p => {
  if (!Remote.sid) throw new Error('Not connected');
  return api('GET', `/api/sftp/ls?sid=${Remote.sid}&path=${encodeURIComponent(p)}`);
});
Remote.join = name => (Remote.path === '/' ? '' : Remote.path) + '/' + name;
Local.onOpenFile = () => transfer('put');
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
  show('files');
  let creds = {};
  if (needsCreds(e) && !(isFTP(e) && !e.username)) { creds = await askCreds(e); if (!creds) return; }
  if (Remote.sid) api('POST', '/api/sftp/close', { sid: Remote.sid }).catch(() => {});
  $('.listing', Remote.root).innerHTML = `<div class="empty">Connecting to ${esc(e.host)}…</div>`;
  try {
    const r = await api('POST', '/api/sftp/open', { id: e.id, ...creds });
    Remote.sid = r.sid;
    Remote.entry = e;
    $('#sftpLabel').textContent = `${r.protocol.toUpperCase()}  ${creds.username || e.username || 'anonymous'}@${e.host}`;
    Tree.render();
    toast('Connected to ' + e.host);
    Remote.load(r.home);
  } catch (err) {
    $('.listing', Remote.root).innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    toast(err.message, true);
  }
};

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

const Jobs = {
  timer: null, running: 0,
  watch() { if (!this.timer) this.timer = setInterval(() => this.tick(), 800); this.tick(); },
  async tick() {
    const jobs = await api('GET', '/api/jobs').catch(() => []);
    $('#jobs').innerHTML = jobs.slice(0, 20).map(j => {
      const pct = j.total ? Math.round(j.done * 100 / j.total) : (j.status === 'done' ? 100 : 0);
      return `<div class="job ${j.status}"><span>${j.dir === 'upload' ? '↑ upload' : '↓ download'}</span><span>${esc(j.name)}${j.error ? ' — ' + esc(j.error) : ''}</span>
        <div class="bar"><i style="width:${pct}%"></i></div><span>${j.status === 'running' ? pct + '%' : j.status}</span></div>`;
    }).join('');
    const running = jobs.filter(j => j.status === 'running').length;
    if (running < this.running) { Local.load(Local.path); if (Remote.sid) Remote.load(Remote.path); }
    this.running = running;
    if (!running) { clearInterval(this.timer); this.timer = null; }
  },
};

// ---------- connection tree (Terminal + Files) ----------
// Folders come from the project name ("Payments/Batch" nests), then the
// environment. Drag a server onto a folder to move it.
const Tree = {
  collapsed: new Set(JSON.parse(localStorage.getItem('treeCollapsed') || '[]')),
  selected: null,

  build(q, mode) {
    const root = { kids: {}, items: [] };
    const want = { ssh: canSSH, sftp: canFiles, db: canDB }[mode];
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
    const kids = Object.entries(node.kids).sort(([a], [b]) => (a[0] === '#') - (b[0] === '#') || a.localeCompare(b));
    for (const [, k] of kids) {
      const key = k.project + (k.env ? '#' + k.env : '');
      const open = q || !this.collapsed.has(key);
      out += `<div class="tnode folder" style="padding-left:${8 + depth * 14}px" data-key="${esc(key)}" data-project="${esc(k.project)}" data-env="${esc(k.env || '')}">
        <span class="tw">${open ? '▾' : '▸'}</span>${k.env ? `<span class="badge ${esc(k.env)}">${esc(k.env)}</span>` : '📁 <span class="nm">' + esc(k.name) + '</span>'}<span class="n">${this.count(k)}</span></div>`;
      if (open) out += this.html(k, depth + 1, q);
    }
    for (const e of node.items.sort((a, b) => a.name.localeCompare(b.name))) {
      const live = Term.tabs.some(t => t.entry.id === e.id && !t.closed) || Remote.entry?.id === e.id && Remote.sid || SQL.tabs.some(t => t.entry.id === e.id);
      const port = isFTP(e) ? (e.port || 21) : sshPort(e), def = isFTP(e) ? 21 : 22;
      const target = `${isFTP(e) ? e.protocol || 'ftp' : ''}${isFTP(e) ? '://' : ''}${e.username ? e.username + '@' : ''}${e.host}${port !== def ? ':' + port : ''}`;
      out += `<div class="tnode item ${this.selected === e.id ? 'sel' : ''}" draggable="true" style="padding-left:${8 + depth * 14}px" data-id="${e.id}" title="${esc(target)}">
        <span class="tw"></span>${dot(e)} ${canDB(e) ? '🛢' : '🖥'} <span class="nm">${esc(e.name)}</span>${e.name !== e.host ? `<small>${esc(target)}</small>` : e.username ? `<small>${esc(e.username)}</small>` : ''}${live ? '<span class="live">●</span>' : ''}</div>`;
    }
    return out;
  },

  render() {
    for (const host of $$('.tree-host')) {
      if (!host.firstChild) {
        host.innerHTML = `<div class="tree-tools"><input type="search" placeholder="Filter servers…"><button data-tool="new" title="New connection">+</button><button data-tool="collapse" title="Collapse all">⊟</button></div><div class="tree"></div>`;
        this.wire(host);
      }
      const q = $('input', host).value.trim().toLowerCase();
      $('.tree', host).innerHTML = this.html(this.build(q, host.dataset.mode), 0, q) || '<div class="empty">No servers yet.<br>Copy or paste some details, or press +.</div>';
    }
  },

  activate(e, mode) { mode === 'sftp' ? Remote.connect(e) : mode === 'db' ? SQL.open(e) : Term.open(e); },

  wire(host) {
    const mode = host.dataset.mode;
    $('input', host).addEventListener('input', () => this.render());
    host.addEventListener('click', ev => {
      const tool = ev.target.closest('[data-tool]')?.dataset.tool;
      if (tool === 'new') return openEntryDialog(null);
      if (tool === 'collapse') {
        $$('.tnode.folder', host).forEach(f => this.collapsed.add(f.dataset.key));
        return this.saveCollapsed();
      }
      const n = ev.target.closest('.tnode');
      if (!n) return;
      if (n.dataset.key) {
        this.collapsed.has(n.dataset.key) ? this.collapsed.delete(n.dataset.key) : this.collapsed.add(n.dataset.key);
        return this.saveCollapsed();
      }
      this.selected = n.dataset.id;
      $$('.tnode.item').forEach(x => x.classList.toggle('sel', x.dataset.id === this.selected));
    });
    host.addEventListener('dblclick', ev => {
      const n = ev.target.closest('.tnode.item');
      if (n) this.activate(byId(n.dataset.id), mode);
    });
    host.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' && this.selected && ev.target.tagName !== 'INPUT') this.activate(byId(this.selected), mode);
    });
    host.addEventListener('contextmenu', ev => {
      ev.preventDefault();
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
      if (!f || !ev.dataTransfer.types.includes('text/x-entry')) return;
      ev.preventDefault();
      $$('.tnode.drop', host).forEach(x => x.classList.remove('drop'));
      f.classList.add('drop');
    });
    host.addEventListener('dragleave', ev => ev.target.closest?.('.tnode.folder')?.classList.remove('drop'));
    host.addEventListener('drop', async ev => {
      const f = ev.target.closest('.tnode.folder');
      const e = byId(ev.dataTransfer.getData('text/x-entry'));
      if (!f || !e) return;
      ev.preventDefault();
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

  menu(ev, node, mode) {
    const e = node?.dataset.id && byId(node.dataset.id);
    const items = [];
    if (e) {
      if (canDB(e)) items.push(['Open in SQL', () => SQL.open(e)]);
      if (canSSH(e)) items.push(['Open in PuTTY', () => Term.open(e)]);
      if (canFiles(e)) items.push([`Open in FileZilla (${isFTP(e) ? (e.protocol || 'ftp').toUpperCase() : 'SFTP'})`, () => Remote.connect(e)]);
      items.push('-',
        ['Copy host', () => copyText(e.host)]);
      if (e.username) items.push(['Copy username', () => copyText(e.username)]);
      if (e.password) items.push(['Copy password', () => copyText(e.password, 'Password copied')]);
      items.push(['Copy ssh command', () => copyText(`ssh ${e.username ? e.username + '@' : ''}${e.host}${sshPort(e) !== 22 ? ' -p ' + sshPort(e) : ''}`)], '-',
        ['Edit…', () => openEntryDialog(e)],
        ['Duplicate', async () => { await api('POST', '/api/entries', { ...entryInput(e), id: '', name: e.name + ' (copy)', password: e.password }); poll(); }],
        ['Move to folder…', () => { const p = prompt('Folder (use / for subfolders)', e.project); if (p) this.move(e, p.trim(), e.env); }],
        ['Delete', async () => { if (confirm(`Delete ${e.name}?`)) { await api('DELETE', `/api/entries/${e.id}`); poll(); } }]);
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
    $('#chatFab').hidden = !c.hidden;
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
      ? 'Paste connection details and tell me what to do — e.g. <code>ftp</code>, <code>sftp</code> or <code>terminal</code>. I\'ll show what I found and connect when you confirm. Type <code>help</code> for more.'
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
    if (/^\s*(help|\?)\s*$/.test(l)) return 'help';
    if (/^\s*(y|yes|ok|okay|go|confirm|do it)\s*!?\s*$/.test(l)) return 'yes';
    if (/^\s*(n|no|cancel|stop|nevermind)\s*$/.test(l)) return 'no';
    if (/^\s*(find|search|show|list|where|lookup|look up)\b/.test(l)) return 'find';
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
    if (intent === 'help') return this.help(false);
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
        : 'I didn\'t spot any host there. Paste connection details and add <code>terminal</code> or <code>ftp</code>, or type <code>help</code>.');
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
      `• <b>${esc(e.name)}</b>${urlLabel(e.url) ? ` <span class="ulabel">${esc(urlLabel(e.url))}</span>` : ''} ${e.env ? `<span class="badge ${esc(e.env)}">${esc(e.env)}</span>` : ''} <span class="muted">${esc(e.username || '')}${e.username ? '@' : ''}${esc(e.host || e.url || '')}</span>
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
$('#chatFab').onclick = () => Chat.toggle(true);
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
function openURL(e) {
  window.open(e.url, '_blank', 'noopener');
  api('POST', `/api/entries/${e.id}/opened`).then(poll).catch(() => {});
}
document.addEventListener('click', ev => {
  const a = ev.target.closest('a[data-open]');
  if (a) api('POST', `/api/entries/${a.dataset.open}/opened`).then(poll).catch(() => {});
});

function siteOf(host) {
  if (!host || /^[\d.]+$/.test(host) || !host.includes('.')) return host || 'Other';
  const p = host.toLowerCase().split('.');
  const n = p.length >= 3 && p.at(-1).length === 2 && ['co', 'com', 'gov', 'org', 'net', 'ac'].includes(p.at(-2)) ? 3 : 2;
  return p.slice(-n).join('.');
}
const ENV_ORDER = { PROD: 0, DR: 1, UAT: 2, STAGE: 3, TEST: 4, DEV: 5 };
function avatar(text) {
  let h = 0;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `<span class="av" style="background:hsl(${h} 55% 45%)">${esc((text.match(/[A-Za-z0-9]/) || ['?'])[0].toUpperCase())}</span>`;
}

const Bookmarks = {
  mode: localStorage.getItem('bmGroup') || 'smart',

  list() {
    const q = $('#bmSearch').value.trim().toLowerCase();
    return S.entries.filter(e => e.url && /^https?:/i.test(e.url) && matches(e, q));
  },

  sortItems(a, b) {
    return (b.open_count || 0) - (a.open_count || 0) || (ENV_ORDER[a.env] ?? 9) - (ENV_ORDER[b.env] ?? 9) || a.name.localeCompare(b.name);
  },

  tile(e) {
    const label = urlLabel(e.url);
    const when = e.open_count ? `${e.open_count}× · ${fmtTime(e.last_used)}` : '';
    return `<div class="bm env-${esc(e.env || '')}" data-bm="${e.id}" title="${esc(e.url)}">
      ${dot(e)}${avatar(label || e.name || e.host)}
      <div class="bm-body"><div class="bm-name">${esc(e.name !== e.host ? e.name : label || e.host)}</div>
        <div class="bm-sub">${label && e.name !== e.host ? `<span class="ulabel">${esc(label)}</span>` : ''}${esc(e.host)}${e.username ? ' · ' + esc(e.username) : ''}</div>
        ${e.folder && this.mode !== 'folder' ? `<div class="bm-sub" title="${esc(e.folder)}">📁 ${esc(e.folder.split(' › ').slice(1).join(' › ') || e.folder)}</div>` : ''}</div>
      <div class="bm-meta">${e.env ? `<span class="badge ${esc(e.env)}">${esc(e.env)}</span>` : ''}<span class="n">${when}</span>
        <span class="bm-tools"><button class="icon" data-bmcopy="${e.id}" title="Copy URL">URL</button>${e.password ? `<button class="icon" data-bmpw="${e.id}" title="Copy password">pw</button>` : ''}<button class="icon" data-bmedit="${e.id}">✎</button></span></div>
    </div>`;
  },

  section(title, items) {
    return items.length ? `<div class="group"><div class="group-head"><h3>${esc(title)}</h3><span class="n">${items.length}</span></div><div class="bm-grid">${items.map(e => this.tile(e)).join('')}</div></div>` : '';
  },

  render() {
    const all = this.list();
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
    if (this.mode === 'smart') {
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
      : (a, b) => weight(b) - weight(a) || groups[b].length - groups[a].length || a.localeCompare(b);
    Object.keys(groups).sort(order)
      .forEach(g => { html += this.section(g, groups[g].sort(this.sortItems)); });
    $('#bmBoard').innerHTML = html;
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
$('#bmBoard').addEventListener('click', ev => {
  const t = ev.target.closest('button');
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

  async open(e) {
    show('sql');
    const open = this.tabs.find(t => t.entry.id === e.id);
    if (open) return this.activate(open);
    let creds = {};
    if (!e.username || !e.password) { creds = await askCreds(e); if (!creds) return; }
    const kind = dbKindOf(e);
    const ex = e.extra || {};
    let database = '';
    if (!(ex.service || ex.service_name || ex.database || ex.db_name || ex.dbname || ex.sid || (kind === 'postgres' && /\/\w/.test((e.url || '').replace(/^.*?\/\/[^/]*/, ''))))) {
      database = prompt(kind === 'oracle' ? `Oracle service name for ${e.host} (e.g. ORCLPDB1):` : `PostgreSQL database on ${e.host}:`, kind === 'oracle' ? '' : 'postgres');
      if (database === null) return;
    }
    $('#sqlEmpty').innerHTML = `Connecting to ${esc(e.host)}…`;
    $('#sqlEmpty').hidden = false;
    try {
      const r = await api('POST', '/api/db/open', { id: e.id, ...creds, database: database.trim() });
      const t = { sid: r.sid, entry: e, kind: r.kind, info: r, sql: this.loadSQL(e), result: null, out: '', inTx: false, objects: null };
      this.tabs.push(t);
      this.activate(t);
      this.say(t, `<span class="ok">Connected: ${esc(r.user || '')}  ${esc(r.version || '')}</span>\n`);
      this.loadObjects(t, '');
      Tree.render();
    } catch (err) {
      $('#sqlEmpty').innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`;
      toast(err.message, true);
      poll();
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
      ${t.inTx ? '<span style="color:#e0a800" title="Uncommitted changes">●</span>' : dot(byId(t.entry.id) || t.entry)} 🛢 ${esc(t.entry.name)}${t.entry.env ? ` <span class="badge ${esc(t.entry.env)}">${esc(t.entry.env)}</span>` : ''}
      <span class="x" data-sx="${t.sid}">✕</span></div>`).join('');
    $('#sqlCount').textContent = this.tabs.length || '';
  },

  async close(t) {
    if (t.inTx && !confirm(`${t.entry.name} has uncommitted changes. Close and roll them back?`)) return;
    api('POST', '/api/db/close', { sid: t.sid }).catch(() => {});
    this.tabs = this.tabs.filter(x => x !== t);
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

// SQL page events
$('#sqlRun').onclick = () => SQL.run(false);
$('#sqlScript').onclick = () => SQL.run(true);
$('#sqlStop').onclick = () => SQL.active && api('POST', '/api/db/cancel', { sid: SQL.active.sid }).catch(() => {});
$('#sqlCommit').onclick = () => SQL.tx('commit');
$('#sqlRollback').onclick = () => SQL.tx('rollback');
$('#sqlAuto').checked = (() => { try { return localStorage.getItem('sqlAuto') === '1'; } catch { return false; } })();
$('#sqlAuto').onchange = e => { try { localStorage.setItem('sqlAuto', e.target.checked ? '1' : '0'); } catch { /* ignore */ } };
$('#sqlObjToggle').onclick = () => $('.sql-grid').classList.toggle('no-objects');
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
      ${d.dirty ? '●' : ''}${esc(d.title)}<span class="x" data-x="${esc(d.key)}">✕</span></div>`).join('');
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
  sizes: store.get('fonts', { term: 14, editor: 13, sql: 13 }),
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
setSide(store.get('sideW', 210));
Fonts.apply();
document.body.classList.toggle('side-collapsed', store.get('sideCollapsed', false));
dragBar($('#sideSplit'), {
  start: () => $('.side').getBoundingClientRect().width,
  apply: setSide,
  done: () => store.set('sideW', parseInt(getComputedStyle(root).getPropertyValue('--side-w'))),
});
function toggleSide() {
  const c = document.body.classList.toggle('side-collapsed');
  store.set('sideCollapsed', c);
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
  setW(store.get(key + '.w', 270));
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
