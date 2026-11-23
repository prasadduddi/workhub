'use strict';
// 📜 Remote log viewer: right-click an SSH server → Tail a log… Follows a file
// (tail -F) in a floating window you can move and resize while you keep
// working: filter, highlight words, pause, and 📌 send lines to the capture
// thread. Read-only on the server (only tail and find run there).

const LogView = {
  ws: null, entry: null, path: '', lines: [], paused: false, held: 0, creds: {},
  MAX: 5000,

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

  async open(e) {
    if (needsCreds(e)) { const c = await askCreds(e); if (!c) return; this.creds = c; } else this.creds = {};
    this.stop();
    this.entry = e; this.lines = []; this.path = '';
    const p = this.el(); p.hidden = false;
    $('.lp-title', p).textContent = `📜 ${e.host}`;
    $('#lpRecent').innerHTML = this.recent(e).map(x => `<option value="${esc(x)}">`).join('');
    $('.lp-path', p).value = this.recent(e)[0] || '';
    $('.lp-found', p).innerHTML = '';
    $('.lp-pick', p).hidden = false;
    $('.lp-body', p).innerHTML = ''; this.status('Choose a file to follow'); this.foot();
    $('.lp-path', p).focus();
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
      case 'copy': copyText(this.shown().map(l => l.t).join('\n'), 'Lines copied'); break;
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
      const list = await api('POST', '/api/logs/find', { id: this.entry.id, dir, ...this.creds });
      $('.lp-found', p).innerHTML = list.length ? list.map(f => `<div class="lp-file" data-lpf="${esc(f.path)}" title="Follow this file"><span class="mono">${esc(f.path)}</span><span class="spacer"></span><span class="muted tiny">${fmtSize(f.size)} · ${esc(fmtTime(f.at))}</span></div>`).join('')
        : `<div class="muted tiny">No log files changed in the last 3 days under ${esc(dir)} (or no permission to read them).</div>`;
    } catch (err) { $('.lp-found', p).innerHTML = `<div class="muted tiny">${esc(err.message)}</div>`; }
  },

  follow(path, n) {
    this.stop();
    const p = this.el(), e = this.entry;
    this.path = path; this.lines = []; this.held = 0; this.paused = false;
    $('[data-lp=pause]', p).textContent = '⏸ Pause';
    $('.lp-title', p).textContent = `📜 ${e.host}:${path}`;
    $('.lp-pick', p).hidden = true;
    this.remember(e, path);
    this.renderAll(); this.status('Connecting…');
    const ws = new WebSocket(`ws://${location.host}/ws/tail?id=${encodeURIComponent(e.id)}`);
    this.ws = ws;
    let partial = '';
    ws.onopen = () => ws.send(JSON.stringify({ t: 'start', path, lines: n, ...this.creds }));
    ws.onmessage = m => {
      const msg = JSON.parse(m.data);
      if (msg.t !== 'data') { this.status(msg.d, msg.t === 'err'); if (msg.t === 'err') toast(msg.d, true); return; }
      const parts = (partial + msg.d).split('\n');
      partial = parts.pop();
      this.add(parts);
    };
    ws.onclose = () => { if (this.ws === ws) { this.ws = null; this.status(this.statusText + ' · stopped'); } };
  },

  stop() { const ws = this.ws; this.ws = null; if (ws) try { ws.close(); } catch { /* closed */ } },

  add(texts) {
    const now = Date.now();
    for (const t of texts) this.lines.push({ t: t.replace(/\r$/, ''), at: now });
    let cut = 0;
    if (this.lines.length > this.MAX) { cut = this.lines.length - this.MAX; this.lines.splice(0, cut); }
    if (this.paused) { this.held += texts.length; return this.foot(); }
    const body = $('.lp-body', this.el()), stick = this.atBottom();
    if (cut) for (let i = 0; i < cut && body.firstChild; i++) body.firstChild.remove();
    const f = this.filter(), html = texts.map(t => ({ t })).filter(l => this.match(l, f)).map(l => this.lineHTML(l.t)).join('');
    body.insertAdjacentHTML('beforeend', html);
    if (stick) this.scrollEnd(); else { this.held += texts.length; this.foot(); }
    this.status();
  },

  filter() {
    const q = $('.lp-filter', this.el()).value.trim().toLowerCase();
    return (q.match(/-?"[^"]*"|\S+/g) || []).map(w => ({ neg: w.startsWith('-') && w.length > 1, v: w.replace(/^-/, '').replace(/"/g, '') })).filter(w => w.v);
  },
  match(l, f) { const t = l.t.toLowerCase(); return f.every(w => t.includes(w.v) !== w.neg); },
  shown() { const f = this.filter(); return this.lines.filter(l => this.match(l, f)); },

  lineHTML(t) {
    const words = $('.lp-hl', this.el()).value.split(',').map(s => s.trim()).filter(Boolean);
    let html = esc(t);
    if (words.length) {
      const re = new RegExp('(' + words.map(w => esc(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'gi');
      html = html.replace(re, '<mark>$1</mark>');
    }
    const lvl = /\b(ERROR|FATAL|SEVERE|Exception|ORA-\d+)/i.test(t) ? 'lv-err' : /\bWARN(ING)?\b/i.test(t) ? 'lv-warn' : /^\s+at\s|^\s*Caused by:/.test(t) ? 'lv-trace' : '';
    return `<div class="lp-line ${lvl}">${html || '&nbsp;'}</div>`;
  },

  renderAll() {
    const body = $('.lp-body', this.el());
    body.innerHTML = this.shown().map(l => this.lineHTML(l.t)).join('');
    this.held = 0; this.scrollEnd(); this.foot(); this.status();
  },

  atBottom() { const b = $('.lp-body', this.el()); return b.scrollHeight - b.scrollTop - b.clientHeight < 30; },
  scrollEnd() { const b = $('.lp-body', this.el()); b.scrollTop = b.scrollHeight; },
  foot() { const n = $('.lp-new', this.el()); n.hidden = !this.held; n.textContent = `⬇ ${this.held} new line${this.held === 1 ? '' : 's'}`; },
  status(text, err) {
    if (text !== undefined) { this.statusText = text; this.statusErr = !!err; }
    const shown = this.shown().length, total = this.lines.length;
    $('.lp-status', this.el()).innerHTML = `<span${this.statusErr ? ' class="err"' : ''}>${esc(this.statusText || '')}</span>${total ? ` · ${shown === total ? total : `${shown} of ${total}`} lines` : ''}${this.paused ? ' · ⏸ paused' : ''}`;
  },

  async pin() {
    const sel = String(getSelection() || '').trim();
    const inside = sel && $('.lp-body', this.el()).contains(getSelection().anchorNode);
    const text = inside ? sel : this.shown().slice(-20).map(l => l.t).join('\n');
    if (!text) return toast('Nothing to send yet', true);
    try {
      await api('POST', '/api/capture/text', { text, from: `Log ${this.entry.host}:${this.path}` });
      toast(`${inside ? 'Selected lines' : 'Last 20 lines'} added to the capture thread`);
    } catch (err) { toast(err.message, true); }
  },
};
