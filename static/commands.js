'use strict';
// Plain-English commands for the Ask panel, fully offline.
//
// parseCommand(text, ctx) is pure: it turns a sentence into a list of actions
// using synonyms and fuzzy matching against the user's own projects, servers,
// repositories and saved views (passed in ctx). runCommand() applies them.

const CMD = (() => {
  const ENVS = {
    PROD: ['prod', 'prd', 'production', 'live', 'prods'], UAT: ['uat', 'acceptance'], TEST: ['test', 'tst', 'qa', 'sit', 'testing'],
    STAGE: ['stage', 'stg', 'staging', 'preprod', 'pre-prod', 'preproduction'], DEV: ['dev', 'development', 'develop', 'sandbox', 'sbx'],
    DR: ['dr', 'disaster'], NONE: ['no env', 'no environment', 'without env', 'without environment', 'unknown env'],
  };
  const TYPES = {
    ssh: ['ssh', 'putty', 'unix', 'linux', 'shell servers'], ftp: ['ftp', 'ftps'], sftp: ['sftp', 'scp'], files: ['file servers', 'filezilla'],
    db: ['database', 'databases', 'db', 'dbs', 'sql'], oracle: ['oracle', 'ora'], postgres: ['postgres', 'postgresql', 'pg', 'psql'],
    web: ['url', 'urls', 'link', 'links', 'website', 'websites', 'web', 'site', 'sites', 'bookmark', 'bookmarks'],
    rdp: ['rdp', 'remote desktop', 'windows servers'], smb: ['share', 'shares', 'smb', 'file share'], ldap: ['ldap'],
    credential: ['credential only', 'logins only', 'credentials only'],
  };
  const STATUS = {
    fail: ['failed', 'failing', 'fail', 'broken', 'down', 'not working', "don't work", 'dont work', 'unreachable', 'red', 'dead', 'errors', 'error', 'bad'],
    ok: ['working', 'work', 'up', 'reachable', 'green', 'ok', 'healthy', 'good', 'successful'],
    none: ['untested', 'not tested', 'never tested', 'not tried', 'never tried', 'grey', 'gray', 'unchecked', 'unknown status'],
  };
  const PAGES = {
    dashboard: ['dashboard', 'home', 'overview', 'main page', 'start'], bookmarks: ['bookmarks', 'bookmark page', 'favourites page', 'links page'],
    inbox: ['captured', 'capture', 'captures', 'inbox', 'clips', 'capture history', 'clipboard history', 'outlook'],
    terminal: ['putty', 'terminal', 'terminals', 'ssh page', 'console'], jira: ['jira', 'jira page', 'tickets', 'pull requests', 'prs'], cal: ['calendar', 'diary', 'schedule', 'agenda', 'meetings', 'events', 'reminders', 'cm windows', 'change windows'], files: ['filezilla', 'file manager', 'files', 'sftp page', 'ftp page', 'transfers'],
    sql: ['sql', 'sql page', 'query window', 'database page', 'db page', 'sql developer'], git: ['git', 'repos', 'repositories', 'source control'], monitor: ['monitor', 'monitoring', 'server status', 'health', 'uptime', 'is it up', 'down servers'],
    tasks: ['tasks', 'task', 'threads', 'thread', 'task threads', 'work items', 'work item'], notes: ['notepad', 'notepad++', 'notes', 'editor', 'note'], ref: ['folders', 'folder tree', 'reference', 'reference files', 'properties', 'properties page', 'property files', 'configs', 'config files', 'json schemas', 'schemas', 'yaml files', 'app docs'],
  };
  const SORTS = {
    name: ['name', 'names', 'alphabet', 'alphabetical', 'a-z', 'a to z'], host: ['host', 'hostname', 'server', 'ip', 'address'],
    project: ['project', 'folder'], env: ['env', 'environment'], used: ['last used', 'recently used', 'recent', 'usage', 'used'],
    added: ['newest', 'latest', 'added', 'created', 'date added', 'new'], updated: ['updated', 'modified', 'changed'],
    status: ['status', 'health', 'broken first', 'failed first'], opens: ['most opened', 'popular', 'popularity', 'opens', 'clicks', 'most used'],
  };
  const GROUPS = { project: ['project', 'projects', 'folder', 'client'], env: ['env', 'environment', 'environments', 'stage'],
    protocol: ['type', 'types', 'protocol', 'kind'], status: ['status', 'health'], host: ['host', 'server', 'machine'], none: ['nothing', 'none', 'no group', 'no grouping'] };
  const COLS = { env: ['env', 'environment', 'status'], name: ['name'], host: ['host', 'server', 'ip'], port: ['port'], type: ['type', 'protocol'],
    url: ['url', 'link', 'links'], user: ['user', 'username', 'login'], password: ['password', 'passwords', 'pwd'], actions: ['actions', 'buttons'] };
  const COL_LABEL = { env: 'Env', name: 'Name', host: 'Host', port: 'Port', type: 'Type', url: 'URL', user: 'User', password: 'Password', actions: 'actions' };
  const LANGS = { text: ['text', 'plain', 'plain text'], log: ['log', 'logs'], sql: ['sql'], plsql: ['plsql', 'pl/sql', 'oracle'], pgsql: ['pgsql', 'postgres'],
    shell: ['shell', 'bash', 'ksh', 'sh'], powershell: ['powershell', 'ps1'], batch: ['batch', 'bat', 'cmd'], python: ['python', 'py'], java: ['java'],
    csharp: ['c#', 'csharp'], groovy: ['groovy', 'gradle'], js: ['javascript', 'js'], json: ['json'], xml: ['xml'], html: ['html'], css: ['css'],
    yaml: ['yaml', 'yml'], ini: ['ini', 'properties', 'conf', 'config'], md: ['markdown', 'md'], docker: ['dockerfile', 'docker'], diff: ['diff', 'patch'] };
  const FILLER = /\b(please|pls|plz|can you|could you|would you|i want to|i want|i'd like to|i would like to|i need to|i need|let me|kindly|just|me|the|a|an|my|all|of|to see|to|for me|now|thanks|thank you)\b/g;

  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const has = (s, words) => words.some(w => new RegExp(`(^|[^a-z0-9])${esc(w)}($|[^a-z0-9])`).test(s));
  const findKey = (s, dict) => Object.keys(dict).filter(k => has(s, dict[k]));

  function lev(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 9;
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }
  // Finds names (projects, servers…) mentioned in s: exact phrase, else a close spelling of a word.
  function findNames(s, names, strict = false) {
    const out = [];
    const words = s.split(/[^a-z0-9._-]+/).filter(w => w.length >= 3);
    for (const n of names) {
      const ln = n.toLowerCase();
      if (!ln) continue;
      const parts = ln.split(/[\/\s]+/).filter(Boolean);
      if (has(s, [ln]) || (!strict && parts.length > 1 && has(s, [parts.at(-1)]) && parts.at(-1).length >= 4)) { out.push(n); continue; }
      if (strict) {
        // Servers: also the short host name ("app-prod-01" for app-prod-01.corp.local).
        const short = ln.split('.')[0];
        if (ln.includes('.') && short.length >= 4 && /[\d-]/.test(short) && has(s, [short])) out.push(n);
        continue;
      }
      if (ln.length >= 4 && words.some(w => { const d = lev(w, ln); return d === 1 || (ln.length >= 7 && d === 2); })) out.push(n);
    }
    return out;
  }
  const num = s => { const m = s.match(/\b(\d{1,6})\b/); return m ? +m[1] : null; };
  const quoted = s => (s.match(/["“'‘]([^"”'’]+)["”'’]/) || [])[1];

  function parse(raw, ctx) {
    const text = raw.trim();
    let s = ' ' + text.toLowerCase().replace(/[!?.]+$/g, '').replace(/\s+/g, ' ') + ' ';
    const acts = [];
    const A = (type, v = {}) => acts.push({ type, ...v });
    const orig = re => { const mm = text.match(re); return mm ? mm[mm.length - 1].trim().replace(/^["'“‘]|["'”’.!?]$/g, '') : ''; };

    // ---- whole-sentence commands ----
    if (/^\s*(undo|go back|back|revert|undo that)\s*$/.test(s)) return [{ type: 'undo' }];
    if (/^\s*(reset|clear|clear all|clear filters?|remove (all )?filters?|show (me )?(all|everything)|start over|default view|everything)\s*$/.test(s)) return [{ type: 'reset' }];
    if (/^\s*(help|\?|what can (you|i) (do|say)|commands|examples)\s*$/.test(s)) return [{ type: 'help' }];
    let m;
    if ((m = s.match(/\bsave (this |the |current )?(view|filters?|layout|setup)?\s*(as|called|named)\s+(.+?)\s*$/))) return [{ type: 'saveView', name: quoted(text) || orig(/\b(?:as|called|named)\s+(.+?)\s*$/i) || m[4].trim() }];
    if ((m = s.match(/\b(delete|remove|forget) (the )?(saved )?view\s+(.+?)\s*$/))) return [{ type: 'deleteView', name: orig(/\bview\s+(.+?)\s*$/i) || m[4].trim() }];
    if (/\b(list|show|what are) (my |the )?(saved )?views\b/.test(s)) return [{ type: 'listViews' }];
    if ((m = s.match(/\b(open|load|apply|use|switch to|show) (my |the )?(saved )?view\s+(.+?)\s*$/))) return [{ type: 'loadView', name: m[4].trim() }];
    const sv = (ctx.views || []).find(v => s.trim() === v.toLowerCase() || s.trim() === 'open ' + v.toLowerCase() || s.trim() === 'show ' + v.toLowerCase());
    if (sv) return [{ type: 'loadView', name: sv }];

    // Desktop version: which browser opens links.
    if ((m = s.match(/\b(open|launch|show)\s+(the\s+)?(links?|urls?|bookmarks?)\s+(in|with|using)\s+(google chrome|chrome|edge|microsoft edge|(?:the\s+)?default( browser)?|my default browser)\b/)))
      return [{ type: 'linkBrowser', v: /chrome/.test(m[5]) ? 'chrome' : /edge/.test(m[5]) ? 'edge' : 'default' }];

    if (/^\s*(what'?s new|whats new|new features|release notes|changes|tips|show tips|help me|tip)\s*\??\s*$/.test(s)) return [{ type: 'whatsNew', tab: /tip/.test(s) ? 'tips' : 'new' }];

    // ---- naming rules: "name hosts containing -BAT- as Batch", "naming rules"
    if ((m = raw.match(/^\s*(?:name|label|call)\s+(?:all\s+)?(?:the\s+)?(?:hosts?|servers?|links?|connections?|anything|everything)?\s*(?:with|containing|that contain|which contain|matching|having)\s+(\S+)\s+(?:in (?:the )?(?:host ?name|name)\s+)?(?:as|to)\s+["']?(.+?)["']?\s*$/i))) return [{ type: 'nameRule', match: m[1], label: m[2] }];
    if (/^\s*(show |edit |open )?(the )?(naming|name) rules\s*$/.test(s)) return [{ type: 'nameRules' }];

    // ---- Jira ----
    if ((m = text.match(/^\s*(?:add|track|follow|watch)\s+(?:the\s+)?(?:jira\s*(?:issue|ticket)?s?\s+)?((?:[A-Za-z][A-Za-z0-9_]+-\d+|https?:\/\/\S+)(?:[\s,]+(?:and\s+)?(?:[A-Za-z][A-Za-z0-9_]+-\d+|https?:\/\/\S+))*)\s*(?:in|to)?\s*(?:jira)?\s*$/i))) return [{ type: 'jiraAdd', ref: m[1] }];
    if (/^\s*(refresh|update|sync)\s+(all\s+)?jira\b/.test(s)) return [{ type: 'jiraRefresh' }];

    // ---- work items (Notepad++ pages) ----
    if ((m = text.match(/^\s*(?:new|create|add|start|make)\s+(?:a\s+)?(?:new\s+)?(?:work ?item|ticket page|work page|page)(?:\s+(?:for|called|named|about))?\s*[:-]?\s*(.*)$/i))) return [{ type: 'workNew', title: m[1].trim() }];
    if ((m = text.match(/^\s*(?:open|show|go to)\s+(?:the\s+)?(?:work ?item|ticket page|work page)\s+(.+)$/i))) return [{ type: 'workOpen', q: m[1].trim() }];
    if (/\b(list|show)\s+(my\s+)?(open\s+|active\s+|all\s+)?work ?items\b/.test(s)) return [{ type: 'workList' }];

    // ---- blocked sites (never imported or captured) ----
    const siteList = t => t.replace(/\b(and |or )?(also )?(other |similar |related |any )+(sites?|websites?|domains?|ones)\b/gi, ' ').replace(/\b(sites? like|websites? like|domains? like|like|such as|the|site|website|domain|from (syncing|sync|importing|import)|syncing|sync|importing|import)\b/gi, ' ')
      .split(/\s*(?:,|\band\b|\bor\b|&)\s*/i).map(x => x.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(x => x.length >= 3);
    if (/\b(list|show|what are) (the |my )?(blocked|banned) (sites|websites|domains|list)\b|^\s*blocked sites\s*$/.test(s)) return [{ type: 'blockList' }];
    const SYNCW = String.raw`(?:synch?ing|synch?|importing|import|capturing|capture|showing|show)`;
    if ((m = text.match(new RegExp(String.raw`^\s*(?:please\s+)?(?:block|ban|blacklist|exclude|never ${SYNCW}|stop ${SYNCW}|avoid(?: ${SYNCW})?|skip(?: ${SYNCW})?|(?:don'?t|do not) ${SYNCW})(?:\s+of)?\s+(.+?)\s*$`, 'i'))) && !/\bcolumns?\b/i.test(text)) {
      const sites = siteList(m[1]); if (sites.length) return [{ type: 'block', sites, similar: /\b(similar|like|such|other|related)\b/i.test(m[1]) }];
    }
    if ((m = text.match(/^\s*(?:please\s+)?(?:unblock|allow|whitelist|un-block)\s+(.+?)\s*$/i))) { const sites = siteList(m[1]); if (sites.length) return [{ type: 'unblock', sites }]; }

    // ---- groups ----
    const splitList = t => t.split(/\s*(?:,|\band\b|\bor\b|\bplus\b|&)\s*/i).map(x => x.trim().replace(/^["'“‘]|["'”’]$/g, '')).filter(x => x && !/^(the|all|everything|servers?|windows?|links?|stuff)$/i.test(x));
    if (/\b(arrange|sort|order|organi[sz]e|line up|group) (the |my |all )?(open )?(tabs|windows)( by group)?\b/.test(s) && !/\b(related|for|matching|containing|about|with)\b/.test(s)) return [{ type: 'groupTabs' }];
    if (/\b(list|show|what are) (my |the |all )?groups\b/.test(s)) return [{ type: 'groupList' }];
    if ((m = s.match(/\b(delete|remove) (the )?group\s+(.+?)\s*$/))) return [{ type: 'groupDelete', name: orig(/\bgroup\s+(.+?)\s*$/i) || m[3] }];
    if ((m = s.match(/\bopen (all )?(the )?(servers|sessions|putty|links|bookmarks) (in|of|for) (the )?group\s+(.+?)\s*$/)))
      return [{ type: 'groupOpenAll', kind: /link|bookmark/.test(m[3]) ? 'links' : 'putty', name: orig(/\bgroup\s+(.+?)\s*$/i) || m[6] }];
    if ((m = text.match(/\badd\s+(.+?)\s+(?:to|into)\s+(?:the\s+)?group\s+(.+?)\s*$/i))) return [{ type: 'groupAdd', name: m[2].trim(), patterns: splitList(m[1]) }];
    if ((m = text.match(/\bremove\s+(.+?)\s+from\s+(?:the\s+)?group\s+(.+?)\s*$/i))) return [{ type: 'groupRemovePattern', name: m[2].trim(), patterns: splitList(m[1]) }];
    if ((m = s.match(/^\s*(show|open|view|go to) (the )?group\s+(.+?)\s*$/)) || ((m = s.match(/^\s*group\s+(.+?)\s*$/)) && (ctx.groups || []).some(g => g.toLowerCase() === m[1].trim())))
      return [{ type: 'groupShow', name: (m[3] || m[1]).trim() }];
    // "group all windows related to app-prod-01", "create group Release with a, b and c",
    // "make a group called Payments for payments and pay-api", "group everything about ora-uat"
    if (/\b(group|create (a |new )?group|make (a |new )?group|new group|start (a )?group|collect|gather|bundle)\b/.test(s) && !/\bgroup(ed)? by\b/.test(s)) {
      // The group's name may come at the end: "… and name them as DEV05",
      // "… call it DEV05", "… named DEV05", "… as DEV05".
      let gtext = text, givenName = '';
      const nameAt = [
        /[,;]?\s*(?:\band\s+|\bthen\s+)?(?:name|call|label|title|save)\s+(?:it|them|this|that|these|those|the group|the result|the list|the links)?\s*(?:as|to)?\s*["'“]?([^"'”]+?)["'”]?\s*$/i,
        /\s+(?:and\s+)?(?:as|into)\s+(?:a\s+)?(?:new\s+)?(?:group|collection)\s+(?:called\s+|named\s+)?["'“]?([^"'”]+?)["'”]?\s*$/i,
        /\s+(?:called|named)\s+["'“]?([^"'”]+?)["'”]?\s*$/i,
        /\s+as\s+["'“]?([^"'”\s][^"'”]*?)["'”]?\s*$/i,
      ];
      for (const re of nameAt) {
        const nm = gtext.match(re);
        // "called Night batch for *batch*" is a name followed by patterns, handled below.
        if (nm && nm.index > 0 && !/\s(for|with|from|containing|matching|of|related to|about)\s/i.test(nm[1])) { givenName = nm[1].trim(); gtext = gtext.slice(0, nm.index); break; }
      }
      const NAME_RE = String.raw`\s+["'“]?([^"'”,]+?)["'”]?\s+(?:with|for|from|containing|matching|of|that (?:has|have|contains?))\s+(.+)$`;
      let named = gtext.match(new RegExp(String.raw`\b(?:called|named)` + NAME_RE, 'i')) || gtext.match(new RegExp(String.raw`\bgroup` + NAME_RE, 'i'));
      if (named && /^(all|everything|every ?thing|servers?|windows?|links?|tabs?|items?|stuff|things|anything|these|those)$/i.test(named[1].trim())) named = null;
      const about = gtext.match(/\b(?:related to|relating to|for|about|matching|containing|with|around|on|mentioning|that match|that matches|of)\s+(.+)$/i)
        || (givenName && gtext.match(/^\s*(?:group|collect|gather|bundle)\s+(?:all\s+|the\s+|every\s+)?(?:links?|servers?|bookmarks?|windows?|items?|things?|everything)?\s*(.+)$/i));
      const pats = splitList((named ? named[2] : about ? about[1] : '').replace(/\s+(servers?|windows?|links?|tabs?)\s*$/i, ''));
      if (pats.length) return [{ type: 'groupCreate', name: givenName || (named ? named[1].trim() : pats[0]), patterns: pats }];
    }

    // Bulk actions on matching items — always confirmed before anything changes.
    if (!/\bcolumns?\b|\bfilters?\b/.test(s)) {
      const KIND = /\b(links?|bookmarks?|urls?|websites?|sites?|servers?|hosts?|connections?|entries|items?)\b/g;
      const target = rest => {
        const r = ' ' + rest.replace(/\b(all|every|each|of|the|my|those|these|them|that|this|ones?|stuff|any)\b/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
        const bookmarks = /\b(links?|bookmarks?|urls?|websites?|sites?)\b/.test(rest);
        const core = r.replace(KIND, ' ');
        const current = /\b(these|those|them|this|that|shown|visible|on screen|current)\b/.test(rest) && !core.trim();
        if (current) return { current, patch: {}, bookmarks };
        const patch = filterPatch(' ' + core + ' ', ctx);
        // Words that aren't an environment, type, status, project or server
        // narrow the selection by text ("youtube").
        const known = [...Object.values(ENVS), ...Object.values(TYPES), ...Object.values(STATUS)].flat();
        let left = ' ' + core.toLowerCase() + ' ';
        for (const w of [...known, ...(patch.projects || []), ...(patch.notProjects || []), patch.text || ''].map(x => x.toLowerCase()).filter(Boolean).sort((a, b) => b.length - a.length))
          left = left.replace(new RegExp(`(^|[^a-z0-9])${esc(w)}(?=$|[^a-z0-9])`, 'g'), ' ');
        left = left.replace(/\b(internal|external|public|private|company|pinned|starred|from|in|with|and|without|no|not|except|but|called|named|containing)\b/g, ' ').replace(/\s+/g, ' ').trim();
        if (left && !patch.text) patch.text = left;
        return { current, patch, bookmarks };
      };
      if ((m = s.match(/^\s*(delete|remove|get rid of|clear out|clean up|trash|bin|drop|erase|purge)\b\s*(.*)$/)))
        return [{ type: 'bulk', op: 'hide', ...target(m[2]) }];
      if ((m = s.match(/^\s*(restore|unhide|undelete|bring back|recover)\b\s*(.*)$/)))
        return [{ type: 'bulk', op: 'unhide', ...target(m[2]) }];
      if ((m = s.match(/^\s*(unpin|unstar|unfavou?rite)\b\s*(.*)$/))) return [{ type: 'bulk', op: 'unpin', ...target(m[2]) }];
      if ((m = s.match(/^\s*(pin|star|favou?rite)\b\s*(.*)$/))) return [{ type: 'bulk', op: 'pin', ...target(m[2]) }];
      if ((m = s.match(/^\s*(move|put|file|assign)\s+(.+?)\s+(to|into|under)\s+(the\s+)?(project|folder\s+)?\s*(.+?)\s*$/))) {
        const typed = orig(/\s(?:to|into|under)\s+(?:the\s+)?(?:project\s+|folder\s+)?(.+?)\s*$/i) || m[6];
        return [{ type: 'bulk', op: 'project', value: findNames(' ' + typed.toLowerCase() + ' ', ctx.projects || [])[0] || typed, ...target(m[2]) }];
      }
      if ((m = s.match(/^\s*(mark|set|tag|label)\s+(.+?)\s+(as|to)\s+(\S+)( env(ironment)?)?\s*$/))) {
        const env = findKey(' ' + m[4] + ' ', ENVS).filter(e => e !== 'NONE')[0];
        if (env) return [{ type: 'bulk', op: 'env', value: env, ...target(m[2]) }];
      }
    }

    // Questions about one server: password / user / host.
    if ((m = s.match(/\b(password|pwd|pass|login|username|user name|user|credentials?|details|host ?name|ip|url|link)\s+(for|of|on|to)\s+(.+?)\s*$/))) {
      const what = /pass|pwd/.test(m[1]) ? 'password' : /user|login/.test(m[1]) ? 'username' : /cred|detail/.test(m[1]) ? 'details' : /url|link/.test(m[1]) ? 'url' : 'host';
      return [{ type: 'lookup', what, target: m[3].trim() }];
    }
    if ((m = s.match(/^\s*(how many|count|number of)\b(.*)$/))) return [{ type: 'count', filter: filterPatch(' ' + m[2] + ' ', ctx) }];

    // ---- appearance ----
    if (/\b(dark) (mode|theme)\b|\b(make it|go|switch to|use) dark\b/.test(s)) A('theme', { mode: 'dark' });
    else if (/\b(light) (mode|theme)\b|\b(make it|go|switch to|use) light\b/.test(s)) A('theme', { mode: 'light' });
    else if (/\b(auto|automatic|system) (mode|theme)\b/.test(s)) A('theme', { mode: 'auto' });

    if (/\b(hide|collapse|close|minimi[sz]e|shrink) (the )?(side ?bar|left (menu|panel|bar)|menu|navigation|nav)\b/.test(s)) A('sidebar', { show: false });
    if (/\b(show|expand|open|restore) (the )?(side ?bar|left (menu|panel|bar)|menu|navigation|nav)\b/.test(s)) A('sidebar', { show: true });
    if (/\b(hide|collapse|close) (the )?(server |connection )?(tree|server list|servers list|connections( list)?)\b/.test(s)) A('tree', { show: false });
    if (/\b(show|expand|open|restore) (the )?(server |connection )?(tree|server list|servers list|connections( list)?)\b/.test(s)) A('tree', { show: true });

    // text size: "bigger font in putty", "font 16", "zoom out the editor"
    const bigger = /\b(bigger|larger|increase|zoom in|enlarge|grow|more readable)\b/.test(s), smaller = /\b(smaller|decrease|zoom out|reduce|tiny|less)\b/.test(s);
    const fontWord = /\b(font|text|letters?|writing|zoom|size)\b/.test(s);
    const size = (s.match(/\b(?:font|text|size)\s*(?:size\s*)?(?:to\s*)?(\d{1,2})\b/) || [])[1];
    if ((fontWord && (bigger || smaller)) || size) {
      const target = /putty|terminal|ssh|console|shell|cmd|powershell/.test(s) ? 'term' : /sql|query|result/.test(s) ? 'sql' : /notepad|editor|note|file/.test(s) ? 'editor' : 'current';
      A('font', { target, size: size ? +size : null, delta: size ? 0 : (bigger ? 2 : -2) });
    }

    // ---- dashboard layout ----
    if (/\b(as|in|use|switch to|show)( a)? (table|list|rows|grid view|spreadsheet)\b|\btable (view|layout|mode)\b/.test(s)) A('layout', { v: 'table' });
    if (/\b(as|in|use|switch to|show)( as)? cards?\b|\bcards? (view|layout|mode)\b|\btiles\b/.test(s)) A('layout', { v: 'cards' });
    if (/\b(wider|bigger|larger) cards?\b|\bcards? (wider|bigger|larger)\b/.test(s)) A('cardWidth', { delta: 80 });
    if (/\b(narrower|smaller|compact) cards?\b|\bcards? (narrower|smaller)\b|\bmore cards per row\b/.test(s)) A('cardWidth', { delta: -80 });

    // Connection trees: "group putty by app", "group sql connections by env", "group unix servers by domain"
    if ((m = s.match(/\b(?:group|organi[sz]e|arrange|sort|show)\s+(?:the\s+|my\s+)?(putty|ssh|unix|linux|terminal|filezilla|sftp|ftp|sql|db|database|oracle|postgres|connections?|servers?)\b[a-z\s]*?\s(?:by|per)\s+(folders?|projects?|env|envs|environments?|apps?|applications?|domains?|subnets?|sites?|types?|kinds?|my groups|groups?|users?|usernames?|logins?)\b/))) {
      const pageTree = { terminal: 'ssh', files: 'sftp', sql: 'db' }[ctx.page];
      const tree = /putty|ssh|unix|linux|terminal/.test(m[1]) ? ['ssh'] : /filezilla|sftp|ftp/.test(m[1]) ? ['sftp'] : /sql|db|database|oracle|postgres/.test(m[1]) ? ['db'] : pageTree ? [pageTree] : null;
      if (tree) {
      const g = [['folder', /^(folder|project)/], ['env', /^env/], ['app', /^app/], ['domain', /^(domain|subnet|site)/], ['type', /^(type|kind)/], ['group', /group/], ['user', /^(user|login)/]].find(([, r]) => r.test(m[2]))[0];
      return [{ type: 'treeGroup', trees: tree, v: g }];
      }
    }
    if ((m = s.match(/\b(group|grouped|organi[sz]e|organi[sz]ed|arrange|arranged|categori[sz]e|split)\s+(them |it |everything |servers |bookmarks |links )?by\s+([a-z ]+?)(?=\s(and|then|sorted|sort|as|with|in|only)\b|\s*$)/))) {
      const g = findKey(' ' + m[3] + ' ', GROUPS)[0];
      const bg = /\b(app|application|apps|category|categories|smart|folder|folders|site|sites|domain)\b/.exec(m[3]);
      if (/bookmark|link/.test(s) || ctx.page === 'bookmarks') A('bmGroup', { v: bg ? { app: 'app', application: 'app', apps: 'app', category: 'smart', categories: 'smart', smart: 'smart', folder: 'folder', folders: 'folder', site: 'site', sites: 'site', domain: 'site' }[bg[1]] : (g === 'env' ? 'env' : 'smart') });
      else if (g) A('group', { v: g });
    }
    if (!acts.some(a => a.type === 'bmGroup') && (m = s.match(/\b(bookmarks?|links?|favou?rites)\s+(by|per)\s+(folder|folders|app|apps|application|category|categories|site|sites|domain|env|environment)\b/))) {
      A('bmGroup', { v: { folder: 'folder', folders: 'folder', app: 'app', apps: 'app', application: 'app', category: 'smart', categories: 'smart', site: 'site', sites: 'site', domain: 'site', env: 'env', environment: 'env' }[m[3]] });
    }
    if (/\bungroup(ed)?\b|\bno grouping\b|\bdon'?t group\b/.test(s)) A('group', { v: 'none' });

    if ((m = s.match(/\b(sort|sorted|order|ordered|arrange)\s+(them |it |files |by |on )*(by |on )?([a-z -]+?)(?=\s(and|then|as|with|grouped|group|only)\b|\s*$)/)) || /\b(newest|latest|oldest|biggest|largest|smallest) first\b/.test(s)) {
      const phrase = m ? ' ' + m[4] + ' ' : s;
      const desc = /\b(desc|descending|newest|latest|reverse|biggest|largest|most|z-a|z to a|high to low)\b/.test(s), asc = /\b(asc|ascending|oldest|smallest|least|a-z|a to z|low to high)\b/.test(s);
      if (ctx.page === 'files' || /\bfiles?\b/.test(s)) {
        const k = /size|big|large|small/.test(phrase + s) ? 'size' : /type|kind|ext/.test(phrase) ? 'type' : /name|alpha/.test(phrase) ? 'name' : 'mtime';
        A('fileSort', { key: k, dir: asc ? 1 : desc ? -1 : (k === 'name' || k === 'type' ? 1 : -1) });
      } else {
        let k = findKey(phrase, SORTS)[0] || (/\bnewest|latest\b/.test(s) ? 'added' : /\boldest\b/.test(s) ? 'added' : '');
        if (k) A('sort', { key: k, dir: /\boldest\b/.test(s) && k === 'added' ? -1 : asc ? 1 : desc && !['added', 'updated', 'used', 'opens'].includes(k) ? -1 : 1 });
      }
    }
    if (/\b(unsort|no sort(ing)?|default order)\b/.test(s)) A('sort', { key: '', dir: 1 });

    // table columns: "hide password column", "show only host user password columns"
    if (/\bcolumns?\b/.test(s)) {
      const cols = findKey(s.replace(/\bcolumns?\b/g, ' '), COLS).map(c => COL_LABEL[c]);
      if (/\b(only|just)\b/.test(s) && /\bshow\b/.test(s) && cols.length) A('cols', { only: cols });
      else if (/\b(hide|remove|without|drop)\b/.test(s) && cols.length) A('cols', { hide: cols });
      else if (/\b(show|add|unhide|bring back)\b/.test(s)) A('cols', { show: cols.length ? cols : 'all' });
    }

    // ---- per-page actions ----
    if (/\b(check|test|verify|ping) (the |all |my )?(links|bookmarks|urls|sites)\b/.test(s)) A('checkLinks');
    if (/\b(updates?|new(er)? version|upgrade)\b/.test(s) && !/\bjira\b/.test(s)) A('checkUpdate');
    if (/^ (lock|lock (workhub|the app|it|now|screen)) $/.test(s)) A('lockNow');
    if (/\b(sync|refresh|reload|update) (the |my )?(browser )?(bookmarks|favou?rites)\b/.test(s)) A('syncBookmarks');
    if ((m = s.match(/\b(go to|open|cd|jump to|switch to|show) (my |the )?(downloads|desktop|documents|home|onedrive)( folder)?\b/))) A('localPlace', { place: m[3] });
    if ((m = text.match(/(?:go to|open|cd|browse)\s+(?:folder\s+)?("?)([A-Za-z]:\\[^"]*|\/[^\s"]+|~[^\s"]*)\1/i))) A('localPath', { path: m[2] });
    if ((m = s.match(/\bmax(imum)? ?rows?\s*(to |=|of )?(\d+)\b|\b(\d+) rows max\b/))) A('sqlMax', { n: +(m[3] || m[4]) });
    if (/\bauto ?-?commit (on|enabled?|true)\b|\b(enable|turn on|switch on) auto ?-?commit\b/.test(s)) A('sqlAuto', { on: true });
    if (/\bauto ?-?commit (off|disabled?|false)\b|\b(disable|turn off|switch off) auto ?-?commit\b/.test(s)) A('sqlAuto', { on: false });
    if (/\b(run|execute) (the )?(whole |entire |full )?(script|all statements|everything)\b/.test(s)) A('sqlRun', { all: true });
    else if (/\b(run|execute) (it|this|the query|query|the statement|statement|sql)\b/.test(s)) A('sqlRun', { all: false });
    if (/\b(hide|close) (the )?(tables|objects) (panel|list)\b/.test(s)) A('sqlTables', { show: false });
    if (/\b(show|open) (the )?(tables|objects) (panel|list)\b/.test(s)) A('sqlTables', { show: true });
    if (/\b(new|create|add|start) (a )?(blank )?note\b/.test(s)) A('newNote');
    if (/\b(word ?wrap|wrap( lines)?|line wrap)( on| enabled)?\b/.test(s) && !/\b(off|no|disable|unwrap)\b/.test(s)) A('wrap', { on: true });
    if (/\b(word ?wrap|wrap|line wrap) (off|disabled)\b|\b(no|disable|turn off) (word ?wrap|wrap)\b|\bunwrap\b/.test(s)) A('wrap', { on: false });
    if ((m = s.match(/\b(language|syntax|highlight(ing)?|mode)\s+(to |as |=)?([a-z+#/]+)\b/))) {
      const l = findKey(' ' + m[4] + ' ', LANGS)[0]; if (l) A('lang', { v: l });
    }
    if ((m = s.match(/\b(open|start|launch|new)\s+(a\s+)?(command prompt|cmd|powershell|pwsh|git bash|terminal on this pc|local (shell|terminal)|zsh|bash)\b/))) A('shell', { which: m[3] });
    if (/\b(stop|pause|turn off|disable) (watching|monitoring|capturing)( the)? clipboard\b|\bclipboard (watch(ing)? )?off\b/.test(s)) A('watch', { on: false });
    if (/\b(start|resume|turn on|enable) (watching|monitoring|capturing)( the)? clipboard\b|\bclipboard (watch(ing)? )?on\b|\bwatch (the )?clipboard\b/.test(s)) A('watch', { on: true });
    if ((m = s.match(/\bsave (new )?captures (in|to|into|under)\s+(.+?)\s*$/))) {
      const typed = orig(/\b(?:in|to|into|under)\s+(.+?)\s*$/i) || m[3].trim();
      A('captureProject', { name: findNames(' ' + typed.toLowerCase() + ' ', ctx.projects || [])[0] || typed });
    }
    if ((m = s.match(/\b(open|show|switch to|go to) (the )?(repo|repository|project repo)\s+(.+?)\s*$/))) {
      const r = findNames(' ' + m[4] + ' ', ctx.repoNames || [])[0]; A('gitRepo', { name: r || m[4] });
    }
    if ((m = s.match(/\b(show|open|switch to|view|check) (the )?branch\s+([\w./-]+)/)) || (m = s.match(/\bbranch\s+([\w./-]+)\b/))) A('gitBranch', { name: m[3] || m[1] });
    if ((m = s.match(/\bcommits? (by|from) (\w[\w .-]*?)\s*$/)) || (m = s.match(/\b(search|find) commits? (for |about |with )?(.+?)\s*$/))) A('gitSearch', { text: (m[2] && m[1] !== 'search' && m[1] !== 'find' ? m[2] : m[3]).trim() });

    // ---- navigation ----
    const navM = s.match(/\b(go to|goto|open|switch to|take me to|show me|show|bring up|navigate to|jump to)\s+(the\s+)?([a-z+ ]+?)(\s+(page|tab|view|screen|window|section))?\s*$/);
    let page = navM && findKey(' ' + navM[3] + ' ', PAGES).find(p => PAGES[p].some(w => navM[3].trim() === w || navM[3].trim() === w + 's'));
    if (!page) { const only = s.trim(); page = Object.keys(PAGES).find(p => PAGES[p].includes(only)); }
    if (page && !acts.some(a => ['localPlace', 'localPath', 'gitRepo', 'shell', 'loadView'].includes(a.type))) A('nav', { page });

    // ---- filters (dashboard / bookmarks) ----
    // Filters combine only with arranging (layout/group/sort/columns); other commands stand alone.
    if (!page && acts.every(a => ['layout', 'group', 'sort', 'cols', 'cardWidth'].includes(a.type))) {
      const f = filterPatch(s, ctx);
      if (Object.keys(f).length) {
        const add = /\b(also|add|plus|include|as well)\b/.test(s);
        A('filter', { patch: f, merge: add, page: /\b(bookmarks?|links?|urls?|sites?)\b/.test(s) && !/\bservers?\b/.test(s) ? 'bookmarks' : null });
      }
    }
    return acts;
  }

  // Filter words in a sentence → changes to the dashboard view.
  function filterPatch(s, ctx) {
    const f = {};
    // exclusions: "hide dev", "except prod", "without uat", "not payments"
    const ex = s.match(/\b(hide|except|excluding|exclude|without|not|no|but not|apart from|other than|remove)\s+([a-z0-9 /_-]+?)(?=\s(and|but|as|sorted|grouped|in|from)\b|\s*$|,)/g) || [];
    let rest = s;
    for (const chunk of ex) {
      const body = ' ' + chunk.replace(/^\s*\S+\s+/, '') + ' ';
      if (/\b(password|passwords|pwd|url|urls|link|links)\b/.test(body) && /\b(without|no)\b/.test(chunk)) continue; // handled below
      const envs = findKey(body, ENVS).filter(e => e !== 'NONE');
      const projs = findNames(body, ctx.projects || []);
      if (envs.length || projs.length) {
        if (envs.length) f.notEnvs = envs;
        if (projs.length) f.notProjects = projs;
        rest = rest.replace(chunk, ' ');
      }
    }
    // A server named in full ("app-prod-01") is a name, not the words inside it.
    const hostHit = findNames(rest, ctx.hosts || [], true);
    if (hostHit.length === 1) {
      f.text = hostHit[0];
      const ln = hostHit[0].toLowerCase();
      rest = rest.replace(ln, ' ').replace(new RegExp(`(^|[^a-z0-9])${esc(ln.split('.')[0])}($|[^a-z0-9])`), ' ');
    }
    const envs = findKey(rest, ENVS);
    if (envs.length) f.envs = envs;
    const projs = findNames(rest, ctx.projects || []).filter(p => !(f.notProjects || []).includes(p));
    if (projs.length) f.projects = projs;
    let types = findKey(rest, TYPES);
    // "oracle databases" means Oracle only; "sftp servers" means SFTP, not every file server.
    if (types.some(t => t === 'oracle' || t === 'postgres')) types = types.filter(t => t !== 'db');
    if (types.some(t => t === 'ftp' || t === 'sftp')) types = types.filter(t => t !== 'files');
    if (types.length > 1) types = types.filter(t => t !== 'web' || !/\b(bookmarks?|links?)\b/.test(rest));
    if (types.length) f.types = types;
    const st = findKey(rest, STATUS);
    if (st.length && /\b(server|servers|link|links|connection|connections|bookmark|bookmarks|db|database|sites?|hosts?|ones|that|which|are|is)\b/.test(rest) || /\b(broken|failed|failing|down|unreachable|untested|not working|not tested)\b/.test(rest)) {
      if (st.length) f.status = st[0];
    }
    if (/\b(pinned|starred|favou?rites?|stars?)\b/.test(rest)) f.pinned = true;
    if (/\b(external|public)\b/.test(rest)) f.internal = false;
    else if (/\b(internal|private|company|work|intranet)\b/.test(rest)) f.internal = true;
    if (/\b(with|having|has|that have) (a )?(password|passwords|credentials|logins?)\b/.test(s)) f.withPassword = true;
    if (/\b(without|no|missing) (a )?(password|passwords|credentials|logins?)\b/.test(s)) f.withPassword = false;
    if (/\b(with|having|has) (a )?(url|urls|link|links)\b/.test(s)) f.withUrl = true;
    if (/\b(without|no|missing) (a )?(url|urls|link|links)\b/.test(s)) f.withUrl = false;
    let m;
    if (/\b(used|opened|accessed) (today|recently)\b|\brecently used\b/.test(s)) f.recentDays = /today/.test(s) ? 1 : 7;
    if ((m = s.match(/\b(used|opened|accessed) (this|last) (week|month)\b|\b(used|opened) in the last (\d+) days?\b/))) f.recentDays = m[5] ? +m[5] : m[3] === 'week' ? 7 : 31;
    if ((m = s.match(/\b(named|called|containing|contains|matching|with name|like|about|mentioning)\s+(.+?)(?=\s(and|as|sorted|grouped|in)\b|\s*$)/))) f.text = m[2].trim().replace(/^["']|["']$/g, '');
    const q = (s.match(/"([^"]+)"/) || [])[1]; if (q) f.text = q;
    return f;
  }

  return { parse, filterPatch, lev, findNames };
})();
const parseCommand = CMD.parse;

// ---------- apply (browser only) ----------
const Views = {
  all() { try { return JSON.parse(localStorage.getItem('savedViews') || '{}'); } catch { return {}; } },
  put(all) { try { localStorage.setItem('savedViews', JSON.stringify(all)); } catch { /* ignore */ } },
};
const viewHistory = [];
let pendingBulk = null; // waiting for "yes"

async function confirmBulk() {
  const p = pendingBulk;
  pendingBulk = null;
  if (!p) return null;
  const r = await api('POST', '/api/entries/bulk', { ids: p.ids, op: p.op, value: p.value });
  await poll();
  const done = { hide: 'Removed', unhide: 'Restored', pin: 'Pinned', unpin: 'Unpinned', project: `Moved to "${esc(p.value)}":`, env: `Marked ${p.value}:` }[p.op];
  return `${done} ${r.changed} item${r.changed === 1 ? '' : 's'}.` + (p.op === 'hide' ? ' (Say "restore …" to bring any back.)' : '');
}
function snapshot() {
  return { view: JSON.parse(JSON.stringify(S.view)), groupBy: S.groupBy, layout: S.layout, bm: Bookmarks.mode, cardW: +$('#cardWidth').value,
    search: $('#search').value, fProject: $('#fProject').value, fEnv: $('#fEnv').value };
}
function restore(snap) {
  S.view = { ...emptyView(), ...snap.view }; saveView();
  setGroup(snap.groupBy); setLayout(snap.layout); Bookmarks.mode = snap.bm || Bookmarks.mode;
  if (snap.cardW) { $('#cardWidth').value = snap.cardW; $('#cardWidth').dispatchEvent(new Event('input')); $('#cardWidth').dispatchEvent(new Event('change')); }
  $('#search').value = snap.search || ''; $('#fProject').value = snap.fProject || ''; $('#fEnv').value = snap.fEnv || '';
  refreshViews();
}
function setGroup(g) { S.groupBy = g; localStorage.setItem('groupBy', g); $$('#groupBy button').forEach(b => b.classList.toggle('active', b.dataset.g === g)); }
function setLayout(l) { S.layout = l; localStorage.setItem('layout', l); $$('#layout button').forEach(b => b.classList.toggle('active', b.dataset.l === l)); }
function refreshViews() {
  renderBoard(); Bookmarks.render();
  $$('#bmGroup button').forEach(x => x.classList.toggle('active', x.dataset.g === Bookmarks.mode));
  try { localStorage.setItem('bmGroup', Bookmarks.mode); } catch { /* ignore */ }
}
const currentPage = () => ($('.view.active')?.id || 'view-dashboard').replace('view-', '');

function commandContext() {
  return {
    projects: [...new Set(S.entries.map(e => e.project).filter(Boolean).flatMap(p => p.split('/').map((_, i, a) => a.slice(0, i + 1).join('/'))))],
    hosts: [...new Set(S.entries.flatMap(e => [e.host, e.name]).filter(Boolean))],
    repoNames: (S.settings.repos || []).map(p => p.split(/[\\/]/).filter(Boolean).pop()),
    views: Object.keys(Views.all()),
    groups: (S.settings.groups || []).map(g => g.name),
    page: currentPage(),
  };
}

function describeView(list) {
  const v = S.view, bits = [];
  if (v.envs.length) bits.push(v.envs.map(e => e === 'NONE' ? 'no-env' : e).join('/'));
  if (v.types.length) bits.push(v.types.join('/'));
  if (v.status) bits.push({ ok: 'working', fail: 'failed', none: 'untested' }[v.status]);
  if (v.pinned) bits.push('pinned');
  const where = v.projects.length ? ` in ${v.projects.join(', ')}` : '';
  const not = [...v.notEnvs, ...v.notProjects];
  return `${[list.length, ...bits].join(' ')} item${list.length === 1 ? '' : 's'}${where}${not.length ? ` (excluding ${not.join(', ')})` : ''}${v.text ? ` matching "${v.text}"` : ''}`;
}

const HELP = `Things you can say (in your own words — I understand synonyms and typos):
<b>Filter</b>  "show prod servers in payments" · "only UAT oracle databases" · "hide dev" · "broken links" · "servers without passwords" · "used this week" · "pinned only" · "anything called refund"
<b>Arrange</b>  "as a table" · "group by environment" · "sort by last used" · "newest first" · "wider cards" · "hide password column" · "show only host user password columns"
<b>Change</b>  "delete all youtube links" · "delete these" · "restore youtube links" · "pin these" · "move all jenkins links to DevOps" · "mark ora-uat as UAT" — I always ask before changing anything
<b>Group</b>  "group all windows related to app-prod-01" · "create group Release with app-prod, ora-uat and jenkins" · "show group release" · "add pay-api to group payments" · "open all servers in group release" · "group tabs" · "list groups"
<b>Block</b>  "block xhamster.com and similar sites" · "block facebook.com" · "unblock facebook.com" · "list blocked sites"
<b>Folders</b>  "go to folders" — your own folder tree of JSON, YAML, properties… files: + adds folders, drop files/folders in, Format/Check/Validate JSON
<b>Links</b>  "open links in chrome" · "open links in edge" · "open links in default browser" (desktop version)
<b>Work items</b>  "new work item PAY-123 refund limits" · "open work item PAY-123" · "list work items" — then paste screenshots, links and notes onto the page
<b>Names</b>  "name hosts containing -BAT- as Batch" · "naming rules"
<b>Servers</b>  "group putty by app" · "group sql connections by env" · "group servers by domain" · "group filezilla by my groups"
<b>Jira</b>  "add jira PAY-123" · "track PAY-123, PAY-130" · "refresh jira" · "go to jira"
<b>Remember</b>  "save this view as Prod overview" · "open Prod overview" · "list my views" · "undo" · "reset"
<b>Ask</b>  "how many prod servers" · "password for app-prod-01" · "user for jenkins"
<b>Pages</b>  "go to filezilla" · "hide the sidebar" · "hide the tree" · "dark mode" · "bigger font in putty" · "font 16"
<b>Bookmarks</b>  "bookmarks by folder" · "group links by app" · "check links" · "sync bookmarks"
<b>FileZilla</b>  "sort files by size" · "newest first" · "go to downloads" · "open C:\\temp"
<b>SQL</b>  "max rows 5000" · "autocommit off" · "run script" · "hide tables panel"
<b>Other</b>  "new note" · "wrap on" · "language yaml" · "open repo payments" · "branch develop" · "commits by ann" · "open powershell" · "stop watching clipboard" · "save captures to Payments"
Connections still work as before: paste details and say putty / filezilla / sql.`;

async function runCommand(text) {
  const ctx = commandContext();
  const acts = parseCommand(text, ctx);
  if (!acts.length) return null;
  const before = snapshot();
  const said = [];
  let viewChanged = false, showDash = false;
  for (const a of acts) {
    switch (a.type) {
      case 'help': said.push(HELP); break;
      case 'undo': {
        const prev = viewHistory.pop();
        if (!prev) { said.push('Nothing to undo.'); break; }
        restore(prev); said.push('Undone.'); return said.join('\n');
      }
      case 'reset':
        Object.assign(S.view, emptyView()); saveView();
        $('#search').value = ''; $('#fProject').value = ''; $('#fEnv').value = ''; $('#bmSearch').value = '';
        viewChanged = true; said.push('Cleared all filters.'); break;
      case 'saveView': {
        const all = Views.all(); all[a.name] = snapshot(); Views.put(all);
        said.push(`Saved this view as <b>${esc(a.name)}</b>. Say "open ${esc(a.name)}" to come back to it.`); break;
      }
      case 'loadView': {
        const all = Views.all();
        const name = Object.keys(all).find(n => n.toLowerCase() === a.name.toLowerCase()) || CMD.findNames(' ' + a.name.toLowerCase() + ' ', Object.keys(all))[0];
        if (!name) { said.push(`I don't have a view called "${esc(a.name)}". ${Object.keys(all).length ? 'Saved views: ' + Object.keys(all).map(esc).join(', ') : 'No views saved yet.'}`); break; }
        viewHistory.push(before); restore(all[name]); show('dashboard');
        said.push(`Opened view <b>${esc(name)}</b>: ${describeView(filtered())}.`); return said.join('\n');
      }
      case 'deleteView': {
        const all = Views.all(); const name = Object.keys(all).find(n => n.toLowerCase() === a.name.toLowerCase());
        if (name) { delete all[name]; Views.put(all); said.push(`Deleted view ${esc(name)}.`); } else said.push(`No view called "${esc(a.name)}".`);
        break;
      }
      case 'listViews': { const n = Object.keys(Views.all()); said.push(n.length ? 'Saved views: ' + n.map(x => `<b>${esc(x)}</b>`).join(', ') : 'No saved views yet. Say "save this view as …".'); break; }
      case 'lookup': {
        const t = a.target.toLowerCase();
        const scored = S.entries.map(e => {
          const names = [e.host, e.name, e.url].filter(Boolean).map(x => x.toLowerCase());
          const sc = names.some(n => n === t) ? 3 : names.some(n => n.includes(t) || t.includes(n)) ? 2 : names.some(n => CMD.lev(n, t) <= 2) ? 1 : 0;
          return [sc, e];
        }).filter(x => x[0]).sort((x, y) => y[0] - x[0]);
        if (!scored.length) { said.push(`I couldn't find "${esc(a.target)}".`); break; }
        const best = scored.filter(x => x[0] === scored[0][0]).map(x => x[1]).slice(0, 5);
        for (const e of best) {
          const val = { password: e.password, username: e.username, url: e.url, host: e.host }[a.what];
          if (a.what === 'details') said.push(`<b>${esc(e.name)}</b>: ${esc(e.username || '-')} @ ${esc(e.host || e.url || '')}${e.port ? ':' + e.port : ''}  password: <code>${esc(e.password || '-')}</code>`);
          else said.push(`${a.what} for <b>${esc(e.name)}</b>${e.env ? ` (${e.env})` : ''}: <code>${esc(val || '(none saved)')}</code>`);
        }
        if (best.length === 1 && a.what !== 'details') {
          const val = { password: best[0].password, username: best[0].username, url: best[0].url, host: best[0].host }[a.what];
          if (val) { copyText(val, `${a.what[0].toUpperCase() + a.what.slice(1)} copied`); said.push('(copied to the clipboard)'); }
        }
        break;
      }
      case 'count': {
        const v = { ...emptyView(), ...a.filter };
        const list = S.entries.filter(e => viewMatch(e, v));
        const hosts = new Set(list.map(e => e.host).filter(Boolean)).size;
        said.push(`${list.length} matching item${list.length === 1 ? '' : 's'} (${hosts} distinct host${hosts === 1 ? '' : 's'}).`); break;
      }
      case 'treeGroup': {
        for (const t of a.trees) { try { localStorage.setItem('treeGroup_' + t, a.v); } catch { /* ignore */ } }
        Tree.render(); show({ ssh: 'terminal', sftp: 'files', db: 'sql' }[a.trees[0]]);
        said.push(`${{ ssh: 'SSH', sftp: 'FTP', db: 'SQL' }[a.trees[0]]} servers grouped by ${TREE_GROUPS[a.v].toLowerCase()}.`);
        break;
      }
      case 'nameRule': {
        const rules = (S.settings.name_rules || []).filter(r => r.match.toLowerCase() !== a.match.toLowerCase()).concat({ match: a.match, label: a.label });
        await saveSettings({ name_rules: rules }); await poll();
        said.push(`Servers and links whose host name contains <b>${esc(a.match)}</b> are now named <b>${esc(a.label)}</b> (this workspace only).`);
        break;
      }
      case 'whatsNew': WhatsNew.open(a.tab); said.push("Here's what's new."); break;
      case 'nameRules': openNameRules(); said.push('Opened the naming rules.'); break;
      case 'jiraAdd': show('jira'); await Jira.add(a.ref); said.push(`Added ${esc(a.ref.toUpperCase())} to the Jira page — its pull requests and ${esc(Jira.cfg?.child_prefix || 'CM-')} items appear under it.`); break;
      case 'jiraRefresh': show('jira'); $('#jiraRefreshAll').click(); said.push('Refreshing all Jira issues.'); break;
      case 'workNew': {
        const w = await Work.create(a.title || 'New task');
        if (w) said.push(`Started the task thread <b>${esc(w.title)}</b>. Post notes, paste screenshots, or press 📥 Capture here.`);
        break;
      }
      case 'workOpen': {
        await Work.loadList();
        const q = a.q.toLowerCase();
        const w = Work.list.find(x => x.title.toLowerCase() === q) || Work.list.find(x => x.title.toLowerCase().includes(q));
        if (!w) { said.push(`No task thread matching "${esc(a.q)}".`); break; }
        await Work.open(w.id); said.push(`Opened the thread <b>${esc(w.title)}</b>.`); break;
      }
      case 'workList': {
        await Work.loadList();
        const open = Work.list.filter(w => w.status !== 'done');
        said.push(open.length ? 'Open task threads: ' + open.map(w => `<b>${esc(w.title)}</b> (${(STATUSES.find(s => s[0] === w.status) || STATUSES[0])[1]})`).join(' · ') : 'No open task threads.');
        break;
      }
      case 'linkBrowser':
        await saveSettings({ link_browser: a.v });
        said.push(`Links from the desktop version will open in ${a.v === 'default' ? 'your default browser' : a.v === 'chrome' ? 'Chrome (new tab)' : 'Edge (new tab)'}.` +
          (window.WH_DESKTOP ? '' : ' (In the web version, links open in the browser you are using.)'));
        break;
      case 'block': {
        const list = [...new Set([...(S.settings.blocked_sites || []), ...a.sites.map(x => x.toLowerCase())])];
        await saveSettings({ blocked_sites: list }); await poll();
        said.push(`Blocked: ${a.sites.map(x => `<code>${esc(x)}</code>`).join(', ')}. They won't be imported or captured, and any already here are hidden.` +
          (a.similar ? ' Well-known adult sites (and site names containing words like "porn" or "xxx") are always blocked too.' : ''));
        break;
      }
      case 'unblock': {
        const rm = a.sites.map(x => x.toLowerCase());
        await saveSettings({ blocked_sites: (S.settings.blocked_sites || []).filter(x => !rm.includes(x)) });
        said.push(`Unblocked ${a.sites.map(esc).join(', ')}. (Already-hidden links stay hidden — say "restore …" to bring them back. Built-in adult-site blocking can't be turned off.)`);
        break;
      }
      case 'blockList': {
        const l = S.settings.blocked_sites || [];
        said.push((l.length ? 'Your blocked sites: ' + l.map(x => `<code>${esc(x)}</code>`).join(', ') + '. ' : 'You have no blocked sites of your own. ') + 'Well-known adult sites are always blocked.');
        break;
      }
      case 'groupCreate': {
        await Groups.create(a.name, a.patterns);
        const c = Groups.collect(Groups.get(a.name));
        show('groups');
        said.push(`Created group <b>${esc(a.name)}</b> (matches ${a.patterns.map(p => `<code>${esc(p)}</code>`).join(', ')}): ` +
          `${c.servers.length} server(s), ${c.links.length} link(s), ${c.windows.length} open window(s), ${c.notes.length + c.files.length} note(s)/file(s), ${c.repos.length} repo(s), ${c.clips.length} capture(s). Matching tabs now carry its label.`);
        break;
      }
      case 'groupShow': {
        const g = Groups.get(a.name) || Groups.all().find(x => x.name.toLowerCase().includes(a.name.toLowerCase()));
        if (!g) { said.push(`No group called "${esc(a.name)}". ${Groups.all().length ? 'Groups: ' + Groups.all().map(x => esc(x.name)).join(', ') : 'Say e.g. "group all windows related to app-prod-01".'}`); break; }
        Groups.selected = g.name; show('groups'); said.push(`Showing group <b>${esc(g.name)}</b>.`); break;
      }
      case 'groupList': { const l = Groups.all(); said.push(l.length ? 'Groups: ' + l.map(g => `<b>${esc(g.name)}</b> (${g.patterns.map(esc).join(', ')})`).join(' · ') : 'No groups yet.'); break; }
      case 'groupDelete': {
        const g = Groups.get(a.name); if (!g) { said.push(`No group called "${esc(a.name)}".`); break; }
        await Groups.save(Groups.all().filter(x => x !== g)); said.push(`Deleted group ${esc(g.name)} (nothing inside it was deleted).`); break;
      }
      case 'groupAdd': case 'groupRemovePattern': {
        const g = Groups.get(a.name) || Groups.all().find(x => x.name.toLowerCase().includes(a.name.toLowerCase()));
        if (!g) { said.push(`No group called "${esc(a.name)}".`); break; }
        g.patterns = a.type === 'groupAdd' ? [...new Set([...g.patterns, ...a.patterns])] : g.patterns.filter(p => !a.patterns.some(x => x.toLowerCase() === p.toLowerCase()));
        await Groups.save(Groups.all()); Groups.selected = g.name; show('groups');
        said.push(`Group <b>${esc(g.name)}</b> now matches: ${g.patterns.map(p => `<code>${esc(p)}</code>`).join(', ') || '(nothing)'}.`); break;
      }
      case 'groupOpenAll': {
        const g = Groups.get(a.name) || Groups.all().find(x => x.name.toLowerCase().includes(a.name.toLowerCase()));
        if (!g) { said.push(`No group called "${esc(a.name)}".`); break; }
        const n = await Groups.openAll(a.kind, g); said.push(`Opened ${n} ${a.kind === 'putty' ? 'PuTTY session(s)' : 'link(s)'} from ${esc(g.name)}.`); break;
      }
      case 'groupTabs': arrangeTabsByGroup(); said.push('Tabs arranged by group in SSH, SQL and Notes.'); break;
      case 'bulk': {
        const pool = a.op === 'unhide' ? S.allEntries.filter(e => e.hidden) : S.entries;
        const page = currentPage();
        let list;
        if (a.current) list = page === 'bookmarks' ? Bookmarks.list() : filtered();
        else {
          const v = { ...emptyView(), ...a.patch };
          list = pool.filter(e => viewMatch(e, v) && (!a.bookmarks || /^https?:/i.test(e.url || '')));
        }
        if (a.op === 'unhide') list = list.filter(e => e.hidden);
        if (!list.length) { said.push(a.op === 'unhide' ? 'No removed items match that.' : 'Nothing matches that, so nothing was changed.'); break; }
        const verb = { hide: 'Remove', unhide: 'Restore', pin: 'Pin', unpin: 'Unpin', project: `Move to project "${esc(a.value)}"`, env: `Mark as ${a.value}` }[a.op];
        pendingBulk = { ids: list.map(e => e.id), op: a.op, value: a.value || '', verb, count: list.length };
        const names = list.slice(0, 8).map(e => esc(e.name || e.host || e.url)).join(', ') + (list.length > 8 ? ` and ${list.length - 8} more` : '');
        said.push(`${verb} these ${list.length} item${list.length === 1 ? '' : 's'}: ${names}?<br>Say <b>yes</b> to confirm or <b>no</b> to cancel.` +
          (list.length > 50 ? `<br><b style="color:var(--danger)">That is a lot (${list.length}) — check this is what you meant.</b>` : '') +
          (a.op === 'hide' ? '<br><span class="muted tiny">Removed items are kept hidden (never re-imported) and can be brought back with "restore …".</span>' : ''));
        break;
      }
      case 'theme': Theme.set(a.mode); said.push(`Theme: ${a.mode}.`); break;
      case 'sidebar': if (document.body.classList.contains('side-collapsed') === a.show) toggleSide(); said.push(a.show ? 'Sidebar shown.' : 'Sidebar hidden — say "show sidebar" or press Ctrl+B to bring it back.'); break;
      case 'tree':
        $$('.with-tree').forEach(wt => { if (wt.classList.contains('tree-hidden') === a.show) $('.knob', wt).click(); });
        said.push(a.show ? 'Server tree shown.' : 'Server tree hidden.'); break;
      case 'font': {
        const page = currentPage();
        const target = a.target !== 'current' ? a.target : page === 'terminal' ? 'term' : page === 'sql' ? 'sql' : page === 'notes' ? 'editor' : null;
        if (!target) { said.push('Use Ctrl + and Ctrl − to zoom the whole app, or say e.g. "bigger font in putty".'); break; }
        Fonts.set(target, a.size || Fonts.size(target) + a.delta);
        said.push(`${{ term: 'Terminal', sql: 'SQL', editor: 'Editor' }[target]} text size: ${Fonts.size(target)}px.`); break;
      }
      case 'layout': setLayout(a.v); viewChanged = showDash = true; said.push(a.v === 'table' ? 'Showing as a table.' : 'Showing as cards.'); break;
      case 'cardWidth': {
        const sl = $('#cardWidth'); sl.value = clamp(+sl.value + a.delta, 240, 700);
        sl.dispatchEvent(new Event('input')); sl.dispatchEvent(new Event('change'));
        if (S.layout !== 'cards') setLayout('cards');
        viewChanged = showDash = true; said.push(`Card width ${sl.value}px.`); break;
      }
      case 'group': setGroup(a.v); viewChanged = showDash = true; said.push(a.v === 'none' ? 'No grouping.' : `Grouped by ${a.v === 'protocol' ? 'type' : a.v}.`); break;
      case 'sort': S.view.sort = a.key; S.view.sortDir = a.dir; viewChanged = showDash = true; said.push(a.key ? `Sorted by ${a.key}${a.dir < 0 ? ' (descending)' : ''}.` : 'Default order.'); break;
      case 'cols': {
        const all = TABLE_COLS.map(c => c[0] || 'actions');
        if (a.only) S.view.hideCols = all.filter(c => !a.only.includes(c) && c !== 'actions');
        else if (a.hide) S.view.hideCols = [...new Set([...S.view.hideCols, ...a.hide])];
        else S.view.hideCols = a.show === 'all' ? [] : S.view.hideCols.filter(c => !a.show.includes(c));
        if (S.layout !== 'table') setLayout('table');
        viewChanged = showDash = true; said.push(S.view.hideCols.length ? `Hidden columns: ${S.view.hideCols.join(', ')}.` : 'All columns shown.'); break;
      }
      case 'filter': {
        const p = a.patch;
        if (!a.merge) Object.assign(S.view, { ...emptyView(), sort: S.view.sort, sortDir: S.view.sortDir, hideCols: S.view.hideCols });
        for (const [k, v] of Object.entries(p)) S.view[k] = Array.isArray(v) ? [...new Set([...(a.merge ? S.view[k] : []), ...v])] : v;
        $('#search').value = ''; $('#fProject').value = ''; $('#fEnv').value = '';
        viewChanged = true;
        if (a.page === 'bookmarks' || currentPage() === 'bookmarks') { show('bookmarks'); said.push(`Bookmarks: ${describeView(Bookmarks.list())}.`); }
        else { showDash = true; said.push(`Showing ${describeView(filtered())}.`); }
        break;
      }
      case 'bmGroup': Bookmarks.mode = a.v; viewChanged = true; show('bookmarks'); said.push(`Bookmarks grouped by ${a.v === 'smart' ? 'category' : a.v}.`); break;
      case 'checkLinks': show('bookmarks'); Bookmarks.check(); said.push('Checking links — dots turn green or red in a few seconds.'); break;
      case 'checkUpdate': Update.check(true); said.push('Checking for a newer WorkHub…'); break;
      case 'lockNow': Lock.lockNow(); said.push('Locking WorkHub.'); break;
      case 'syncBookmarks': show('bookmarks'); Bookmarks.sync(true); said.push('Re-reading Edge/Chrome bookmarks.'); break;
      case 'fileSort': {
        show('files');
        for (const p of [Local, Remote]) { p.sortBy = { key: a.key, dir: a.dir }; try { localStorage.setItem('sort.' + p.root.id, JSON.stringify(p.sortBy)); } catch { /* ignore */ } if (p.loaded) p.render(); }
        said.push(`Files sorted by ${{ mtime: 'date modified', size: 'size', name: 'name', type: 'type' }[a.key]}${a.dir < 0 ? ', ' + (a.key === 'mtime' ? 'newest' : a.key === 'size' ? 'largest' : 'Z→A') + ' first' : ''}.`); break;
      }
      case 'localPlace': {
        show('files');
        const places = await api('GET', '/api/local/places').catch(() => []);
        const pl = places.find(x => x.name.toLowerCase() === a.place);
        if (pl) { Local.load(pl.path); said.push(`This PC: ${esc(pl.path)}`); } else said.push(`I couldn't find your ${a.place} folder.`);
        break;
      }
      case 'localPath': show('files'); Local.load(a.path); said.push(`This PC: ${esc(a.path)}`); break;
      case 'sqlMax': { const sel = $('#sqlMax'); if (![...sel.options].some(o => +o.value === a.n)) sel.add(new Option(String(a.n), String(a.n))); sel.value = String(a.n); said.push(`SQL max rows: ${a.n}.`); break; }
      case 'sqlAuto': $('#sqlAuto').checked = a.on; $('#sqlAuto').dispatchEvent(new Event('change')); said.push(`Auto-commit ${a.on ? 'on' : 'off'}.`); break;
      case 'sqlRun': if (!SQL.active) { said.push('Connect to a database on the SQL page first.'); break; } show('sql'); SQL.run(a.all); said.push(a.all ? 'Running the script.' : 'Running the statement at the cursor.'); break;
      case 'sqlTables': $('.sql-grid').classList.toggle('no-objects', !a.show); said.push(a.show ? 'Tables panel shown.' : 'Tables panel hidden.'); break;
      case 'newNote': show('notes'); $('#newNote').click(); said.push('New note created.'); break;
      case 'wrap': $('#wrapToggle').checked = a.on; $('#wrapToggle').dispatchEvent(new Event('change')); said.push(`Line wrap ${a.on ? 'on' : 'off'}.`); break;
      case 'lang':
        if (!Notes.active) { said.push('Open a note or file in Notes first.'); break; }
        $('#langPick').value = a.v; $('#langPick').dispatchEvent(new Event('change')); said.push(`Language: ${$('#langPick').selectedOptions[0].text}.`); break;
      case 'shell': {
        const want = a.which.toLowerCase();
        const sh = SHELLS.find(x => want.includes('powershell') || want === 'pwsh' ? /powershell/i.test(x.name) : want.includes('bash') ? /bash/i.test(x.name) : /command|cmd|zsh|sh/i.test(x.name)) || SHELLS[0];
        if (!sh) { said.push('No command prompt available.'); break; }
        Term.openLocal(sh, Local.loaded && !Local.roots ? Local.path : ''); said.push(`Opened ${esc(sh.name)}.`); break;
      }
      case 'watch': saveSettings({ watch: a.on }); said.push(a.on ? 'Watching the clipboard.' : 'Clipboard watching paused.'); break;
      case 'captureProject': saveSettings({ project: a.name }); $('#captureProject').value = a.name; said.push(`New captures go to project <b>${esc(a.name)}</b>.`); break;
      case 'gitRepo': {
        const repo = (S.settings.repos || []).find(p => p.split(/[\\/]/).filter(Boolean).pop().toLowerCase() === a.name.toLowerCase())
          || (S.settings.repos || []).find(p => p.toLowerCase().includes(a.name.toLowerCase()));
        if (!repo) { said.push(`No repository called "${esc(a.name)}". Add it on the Git page with + or Find.`); break; }
        show('git'); Git.open(repo); said.push(`Opened repository ${esc(repo.split(/[\\/]/).filter(Boolean).pop())}.`); break;
      }
      case 'gitBranch': {
        if (!Git.info) { said.push('Open a repository on the Git page first.'); break; }
        const b = Git.info.branches.find(x => x.name.toLowerCase() === a.name.toLowerCase()) || Git.info.branches.find(x => x.name.toLowerCase().endsWith('/' + a.name.toLowerCase()) || x.name.toLowerCase().includes(a.name.toLowerCase()));
        if (!b) { said.push(`No branch matching "${esc(a.name)}".`); break; }
        show('git'); Git.ref = b.name; Git.renderBranches(); Git.loadLog(); said.push(`Showing history of ${esc(b.name)}.`); break;
      }
      case 'gitSearch': show('git'); $('#gitSearch').value = a.text; if (Git.repo) Git.loadLog(); said.push(`Searching commits for "${esc(a.text)}".`); break;
      case 'nav': show(a.page); said.push(`Opened ${$(`#nav button[data-view="${a.page}"] .nl`)?.textContent || a.page}.`); break;
    }
  }
  if (viewChanged) { viewHistory.push(before); if (viewHistory.length > 30) viewHistory.shift(); saveView(); refreshViews(); }
  if (showDash && currentPage() !== 'dashboard' && currentPage() !== 'bookmarks') show('dashboard');
  return said.join('\n') || null;
}

// Theme: light / dark / follow Windows. Dark rules from the stylesheet are
// re-scoped to [data-theme=dark] so the choice can override the system.
const Theme = {
  init() {
    const rules = [];
    for (const sheet of document.styleSheets) {
      let list; try { list = sheet.cssRules; } catch { continue; }
      for (let i = list.length - 1; i >= 0; i--) {
        const r = list[i];
        if (r instanceof CSSMediaRule && /prefers-color-scheme:\s*dark/.test(r.conditionText || r.media.mediaText)) {
          for (const inner of r.cssRules) rules.push(inner.cssText.replace(/^([^{]+)/, sel => sel.split(',').map(x => x.trim() === ':root' ? ':root[data-theme="dark"]' : `:root[data-theme="dark"] ${x.trim()}`).join(', ')));
          sheet.deleteRule(i);
        }
      }
    }
    const st = document.createElement('style'); st.textContent = rules.join('\n'); document.head.append(st);
    this.mq = window.matchMedia('(prefers-color-scheme: dark)');
    this.mq.addEventListener('change', () => this.apply());
    this.apply();
  },
  pref() { try { return localStorage.getItem('theme') || 'auto'; } catch { return 'auto'; } },
  set(mode) { try { localStorage.setItem('theme', mode); } catch { /* ignore */ } this.apply(); },
  apply() {
    const m = this.pref(), dark = m === 'dark' || (m === 'auto' && this.mq.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  },
};
if (typeof document !== 'undefined' && document.styleSheets) Theme.init();
