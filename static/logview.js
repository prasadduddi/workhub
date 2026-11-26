'use strict';
// 📜 Remote log viewer: right-click an SSH server → Tail a log…, or a folder /
// group → Tail a log on all N servers…. Follows a file (tail -F) on one or
// several servers in a floating window you can move and resize while you keep
// working: each line tagged with its server, filter, highlight words, pause,
// and 📌 send lines to the capture thread. Read-only on the servers (only tail
// and find run there).

const LogView = {
  sources: [], path: '', lines: [], paused: false, held: 0,
  MAX: 8000,
  // Server tag colours (no red: that is for PROD; no orange: UAT).
  COLORS: ['#2f6fdb', '#13877a', '#7b4fc4', '#3f8f3a', '#8a6d3b', '#c2477e', '#4b6382', '#6f7d1f', '#1f86b8', '#9b5a9b'],
  get entry() { return this.sources[0]?.entry; },

  el() {
    let p = $('#logPanel');
    if (p) return p;
    p = document.createElement('div');
    p.id = 'logPanel'; p.className = 'logpanel'; p.hidden = true;
    p.innerHTML = `
      <div class="lp-head"><b class="lp-title">📜 Log</b><span class="spacer"></span>
        <button data-lp="pause" title="Stop scrolling new lines in (they are kept)">⏸ Pause</button>
        <button data-lp="pin" title="Send the selected lines (or the last 20 shown) to the capture thread">📌 To thread</button>
        <button data-lp="copy" title="Copy the lines shown">Copy</button>
        <button data-lp="clear" title="Empty the window (the file is not touched)">Clear</button>
        <label class="lp-wrap" title="Wrap long lines"><input type="checkbox" data-lp="wrap" checked> Wrap</label>
        <button data-lp="file" title="Follow another file">📂 File…</button>
        <button data-lp="close" title="Stop following and close">✕</button></div>
      <div class="lp-pick" hidden>
        <div class="lp-row"><input class="lp-path" list="lpRecent" placeholder="/path/to/app.log"><datalist id="lpRecent"></datalist>
          <select class="lp-lines" title="Lines to show from the end of the file first"><option>100</option><option selected>200</option><option>1000</option><option>5000</option></select>
          <button class="primary" data-lp="follow">Follow</button></div>
        <div class="lp-row"><span class="muted tiny">Find logs changed in the last 3 days under</span><input class="lp-dir" value="/var/log"><button data-lp="find">Find</button></div>
        <div class="lp-found"></div>
      </div>
      <div class="lp-tools"><input class="lp-filter" type="search" placeholder="Show only lines with… (words, all must match; -word leaves out)">
        <input class="lp-hl" placeholder="Highlight: ERROR, WARN, Exception" title="Words to highlight, separated by commas"></div>
      <div class="lp-servers" hidden></div>
      <div class="lp-body" tabindex="0"></div>
      <div class="lp-foot muted tiny"><span class="lp-status"></span><span class="spacer"></span><button class="lp-new" data-lp="bottom" hidden></button></div>`;
    document.body.append(p);
    try { $('.lp-hl', p).value = localStorage.getItem('logHighlight') || 'ERROR, WARN, Exception, ORA-, FATAL'; } catch { $('.lp-hl', p).value = 'ERROR, WARN, Exception, ORA-, FATAL'; }
    p.addEventListener('click', e => { const a = e.target.closest('[data-lp]')?.dataset.lp; if (a && e.target.type !== 'checkbox') this.act(a, e.target.closest('[data-lp]')); });
    $('[data-lp=wrap]', p).addEventListener('change', e => p.classList.toggle('nowrap', !e.target.checked));
    $('.lp-filter', p).addEventListener('input', () => this.renderAll());
    $('.lp-hl', p).addEventListener('input', e => { try { localStorage.setItem('logHighlight', e.target.value); } catch { /* ignore */ } this.renderAll(); });
    $('.lp-path', p).addEventListener('keydown', e => { if (e.key === 'Enter') this.act('follow'); });
    $('.lp-dir', p).addEventListener('keydown', e => { if (e.key === 'Enter') this.act('find'); });
    $('.lp-found', p).addEventListener('click', e => { const f = e.target.closest('[data-lpf]'); if (f) { $('.lp-path', p).value = f.dataset.lpf; this.act('follow'); } });
    // Server chips: click shows / hides that server's lines; double-click shows only it.
    $('.lp-servers', p).addEventListener('click', e => { const c = e.target.closest('[data-lps]'); if (c) { const s = this.sources[+c.dataset.lps]; s.on = !s.on; this.chips(); this.renderAll(); } });
    $('.lp-servers', p).addEventListener('dblclick', e => { const c = e.target.closest('[data-lps]'); if (c) { this.sources.forEach((s, i) => { s.on = i === +c.dataset.lps; }); this.chips(); this.renderAll(); } });
    const body = $('.lp-body', p);
    body.addEventListener('scroll', () => { if (this.atBottom()) { this.held = 0; this.foot(); } });
    // Move by dragging the title bar.
    $('.lp-head', p).addEventListener('mousedown', e => {
      if (e.target.closest('button, input, label')) return;
      const r = p.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      const move = ev => { p.style.left = Math.max(0, Math.min(innerWidth - 120, ev.clientX - dx)) + 'px'; p.style.top = Math.max(0, Math.min(innerHeight - 40, ev.clientY - dy)) + 'px'; p.style.right = p.style.bottom = 'auto'; };
      const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
      addEventListener('mousemove', move); addEventListener('mouseup', up);
    });
    return p;
  },

  recent(e) { try { return JSON.parse(localStorage.getItem('logPaths.' + e.id) || '[]'); } catch { return []; } },
  remember(e, path) { try { localStorage.setItem('logPaths.' + e.id, JSON.stringify([path, ...this.recent(e).filter(x => x !== path)].slice(0, 15))); } catch { /* ignore */ } },

  // Short server tag: acme-app-01 from acme-app-01.uat.acme.local (the full
  // host when two would look the same).
  tags(list) {
    const short = list.map(e => (e.host || '').split('.')[0]);
    const full = list.map((e, i) => short.filter(x => x === short[i]).length > 1 ? e.host : short[i]);
    return list.map((e, i) => full.filter(x => x === full[i]).length > 1 ? `${full[i]}:${sshPort(e)}` : full[i]);
  },

  open(e) { return this.openMany([e]); },

  async openMany(entries) {
    if (sshBlocked()) return;
    // One per server (several logins on it: the one used most, with a password).
    const byHost = {};
    for (const e of entries.filter(canSSH)) {
      const k = `${(e.host || '').toLowerCase()}:${sshPort(e)}`, cur = byHost[k];
      if (!cur || (needsCreds(cur) && !needsCreds(e)) || (needsCreds(cur) === needsCreds(e) && usageScore(e) > usageScore(cur))) byHost[k] = e;
    }
    const list = Object.values(byHost);
    if (!list.length) return toast('No SSH servers here', true);
    if (list.length > 12 && !await askYes(`Follow a log on ${list.length} servers at once?`)) return;
    // Servers without a saved login: ask once, use it for all of them.
    let shared = null;
    const need = list.filter(needsCreds);
    if (need.length) { shared = await askCreds(need[0]); if (!shared) return; }
    this.stop();
    const tags = this.tags(list);
    this.sources = list.map((e, i) => ({ entry: e, tag: tags[i], color: this.COLORS[i % this.COLORS.length], on: true, creds: needsCreds(e) ? shared : {}, ws: null, state: '' }));
    this.lines = []; this.path = '';
    const p = this.el(); p.hidden = false;
    $('.lp-title', p).textContent = list.length > 1 ? `📜 ${list.length} servers` : `📜 ${list[0].host}`;
    const recent = [...new Set(list.flatMap(e => this.recent(e)))];
    $('#lpRecent').innerHTML = recent.map(x => `<option value="${esc(x)}">`).join('');
    $('.lp-path', p).value = recent[0] || '';
    $('.lp-found', p).innerHTML = '';
    $('.lp-pick', p).hidden = false;
    $('.lp-body', p).innerHTML = ''; this.status(list.length > 1 ? `Choose a file to follow on ${list.length} servers (${tags.join(', ')})` : 'Choose a file to follow'); this.foot();
    this.chips();
    $('.lp-path', p).focus();
  },

  // ● connected · ◌ connecting · ✕ failed (hover for why) — click to show/hide.
  chips() {
    const box = $('.lp-servers', this.el());
    box.hidden = this.sources.length < 2;
    box.innerHTML = this.sources.map((s, i) => `<button class="lp-chip${s.on ? '' : ' off'}" data-lps="${i}" style="--c:${s.color}" title="${esc(s.entry.host)}${s.err ? '\n' + s.err : ''}\nClick: show / hide · Double-click: only this one"><i class="lp-st ${s.state}"></i>${esc(s.tag)}</button>`).join('');
  },

  act(a, btn) {
    const p = this.el();
    switch (a) {
      case 'close': this.stop(); p.hidden = true; break;
      case 'file': $('.lp-pick', p).hidden = !$('.lp-pick', p).hidden; break;
      case 'clear': this.lines = []; this.renderAll(); break;
      case 'bottom': this.held = 0; this.scrollEnd(); this.foot(); break;
      case 'pause':
        this.paused = !this.paused;
        btn.textContent = this.paused ? '▶ Resume' : '⏸ Pause';
        if (!this.paused) { this.renderAll(); this.scrollEnd(); }
        this.status(); break;
      case 'copy': copyText(this.shown().map(l => this.plain(l)).join('\n'), 'Lines copied'); break;
      case 'pin': this.pin(); break;
      case 'find': this.find(); break;
      case 'follow': {
        const path = $('.lp-path', p).value.trim();
        if (!path) return toast('Type or pick a file', true);
        this.follow(path, +$('.lp-lines', p).value);
        break;
      }
    }
  },

  async find() {
    const p = this.el(), dir = $('.lp-dir', p).value.trim() || '/var/log';
    $('.lp-found', p).innerHTML = '<div class="muted tiny">Looking…</div>';
    try {
      const src = this.sources.find(s => s.state !== 'err') || this.sources[0]; // looks on the first server
      const list = await api('POST', '/api/logs/find', { id: src.entry.id, dir, ...src.creds });
      $('.lp-found', p).innerHTML = list.length ? list.map(f => `<div class="lp-file" data-lpf="${esc(f.path)}" title="Follow this file"><span class="mono">${esc(f.path)}</span><span class="spacer"></span><span class="muted tiny">${fmtSize(f.size)} · ${esc(fmtTime(f.at))}</span></div>`).join('')
        : `<div class="muted tiny">No log files changed in the last 3 days under ${esc(dir)} (or no permission to read them).</div>`;
    } catch (err) { $('.lp-found', p).innerHTML = `<div class="muted tiny">${esc(err.message)}</div>`; }
  },

  follow(path, n) {
    this.stop();
    const p = this.el();
    this.path = path; this.lines = []; this.held = 0; this.paused = false;
    $('[data-lp=pause]', p).textContent = '⏸ Pause';
    $('.lp-title', p).textContent = this.sources.length > 1 ? `📜 ${path} on ${this.sources.length} servers` : `📜 ${this.entry.host}:${path}`;
    $('.lp-pick', p).hidden = true;
    this.sources.forEach(s => this.remember(s.entry, path));
    this.renderAll(); this.status('Connecting…');
    this.sources.forEach((src, i) => {
      const ws = new WebSocket(`ws://${location.host}/ws/tail?id=${encodeURIComponent(src.entry.id)}`);
      Object.assign(src, { ws, state: 'wait', err: '' });
      let partial = '';
      ws.onopen = () => ws.send(JSON.stringify({ t: 'start', path, lines: n, ...src.creds }));
      ws.onmessage = m => {
        const msg = JSON.parse(m.data);
        if (msg.t === 'data') {
          if (src.state !== 'ok') { src.state = 'ok'; this.chips(); }
          const parts = (partial + msg.d).split('\n');
          partial = parts.pop();
          return this.add(parts, i);
        }
        if (msg.t === 'err') { src.state = 'err'; src.err = msg.d; this.chips(); if (this.sources.length === 1) toast(msg.d, true); }
        else if (msg.t === 'info' && src.state === 'wait') { src.state = 'ok'; this.chips(); }
        this.status(this.sources.length > 1 ? undefined : msg.d, msg.t === 'err');
      };
      ws.onclose = () => { if (src.ws === ws) { src.ws = null; if (src.state !== 'err') src.state = 'off'; this.chips(); this.status(); } };
    });
    this.chips();
  },

  stop() {
    for (const s of this.sources) { const ws = s.ws; s.ws = null; if (ws) try { ws.close(); } catch { /* closed */ } }
  },
  get ws() { return this.sources.find(s => s.ws)?.ws || null; },

  add(texts, src = 0) {
    const now = Date.now(), fresh = texts.map(t => ({ t: t.replace(/\r$/, ''), at: now, s: src }));
    this.lines.push(...fresh);
    let cut = 0;
    if (this.lines.length > this.MAX) { cut = this.lines.length - this.MAX; this.lines.splice(0, cut); }
    if (this.paused) { this.held += texts.length; return this.foot(); }
    const body = $('.lp-body', this.el()), stick = this.atBottom();
    if (cut) for (let i = 0; i < cut && body.firstChild; i++) body.firstChild.remove();
    const f = this.filter(), html = fresh.filter(l => this.match(l, f)).map(l => this.lineHTML(l)).join('');
    body.insertAdjacentHTML('beforeend', html);
    if (stick) this.scrollEnd(); else { this.held += texts.length; this.foot(); }
    this.status();
  },

  filter() {
    const q = $('.lp-filter', this.el()).value.trim().toLowerCase();
    return (q.match(/-?"[^"]*"|\S+/g) || []).map(w => ({ neg: w.startsWith('-') && w.length > 1, v: w.replace(/^-/, '').replace(/"/g, '') })).filter(w => w.v);
  },
  match(l, f) { if (this.sources[l.s] && !this.sources[l.s].on) return false; const t = l.t.toLowerCase(); return f.every(w => t.includes(w.v) !== w.neg); },
  shown() { const f = this.filter(); return this.lines.filter(l => this.match(l, f)); },

  lineHTML(l) {
    const t = l.t, src = this.sources.length > 1 && this.sources[l.s];
    const words = $('.lp-hl', this.el()).value.split(',').map(s => s.trim()).filter(Boolean);
    let html = esc(t);
    if (words.length) {
      const re = new RegExp('(' + words.map(w => esc(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'gi');
      html = html.replace(re, '<mark>$1</mark>');
    }
    const lvl = /\b(ERROR|FATAL|SEVERE|Exception|ORA-\d+)/i.test(t) ? 'lv-err' : /\bWARN(ING)?\b/i.test(t) ? 'lv-warn' : /^\s+at\s|^\s*Caused by:/.test(t) ? 'lv-trace' : '';
    const tag = src ? `<span class="lp-tag" style="--c:${src.color}">${esc(src.tag)}</span>` : '';
    return `<div class="lp-line ${lvl}">${tag}${html || '&nbsp;'}</div>`;
  },

  renderAll() {
    const body = $('.lp-body', this.el());
    body.innerHTML = this.shown().map(l => this.lineHTML(l)).join('');
    this.held = 0; this.scrollEnd(); this.foot(); this.status();
  },

  atBottom() { const b = $('.lp-body', this.el()); return b.scrollHeight - b.scrollTop - b.clientHeight < 30; },
  scrollEnd() { const b = $('.lp-body', this.el()); b.scrollTop = b.scrollHeight; },
  foot() { const n = $('.lp-new', this.el()); n.hidden = !this.held; n.textContent = `⬇ ${this.held} new line${this.held === 1 ? '' : 's'}`; },
  status(text, err) {
    if (text !== undefined) { this.statusText = text; this.statusErr = !!err; }
    else if (this.sources.length > 1 && this.path) {
      const ok = this.sources.filter(s => s.state === 'ok').length, bad = this.sources.filter(s => s.state === 'err').length;
      this.statusText = `Following ${this.path} on ${ok} of ${this.sources.length} servers${bad ? ` · ${bad} failed (hover its tag)` : ''}`; this.statusErr = false;
    }
    const shown = this.shown().length, total = this.lines.length;
    $('.lp-status', this.el()).innerHTML = `<span${this.statusErr ? ' class="err"' : ''}>${esc(this.statusText || '')}</span>${total ? ` · ${shown === total ? total : `${shown} of ${total}`} lines` : ''}${this.paused ? ' · ⏸ paused' : ''}`;
  },

  plain(l) { return this.sources.length > 1 ? `[${this.sources[l.s]?.tag}] ${l.t}` : l.t; },

  async pin() {
    const sel = String(getSelection() || '').trim();
    const inside = sel && $('.lp-body', this.el()).contains(getSelection().anchorNode);
    const text = inside ? sel : this.shown().slice(-20).map(l => this.plain(l)).join('\n');
    if (!text) return toast('Nothing to send yet', true);
    try {
      await api('POST', '/api/capture/text', { text, from: this.sources.length > 1 ? `Log ${this.path} on ${this.sources.map(s => s.tag).join(', ')}` : `Log ${this.entry.host}:${this.path}` });
      toast(`${inside ? 'Selected lines' : 'Last 20 lines'} added to the capture thread`);
    } catch (err) { toast(err.message, true); }
  },
};
