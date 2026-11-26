'use strict';
// 📡 Capture traffic on a server (right-click a server → Capture traffic…):
// tcpdump runs there over SSH; the packets come in live, Wireshark-style; the
// clicked packet's bytes show as hex + text; Save .pcap opens in Wireshark.

const Pcap = {
  id: null, e: null, last: 0, rows: [], timer: null,
  async open(e) {
    if (!e) return toast('Pick a server to capture on', true);
    if (isProd(e) && !await askYes(`⚠ PROD — capture network traffic on ${prodName ? prodName(e) : e.host}?\n\nWorkHub runs tcpdump there (with sudo) until you press Stop.`)) return;
    this.e = e; this.reset();
    const d = this.dlg();
    d.querySelector('.pc-title').textContent = `📡 Capture traffic — ${e.name || e.host}`;
    d.querySelector('.pc-user').textContent = e.username === 'root' ? '' : '(runs tcpdump with sudo)';
    d.showModal();
    d.querySelector('[data-pc=filter]').focus();
  },
  reset() { this.stopPoll(); this.id = null; this.last = 0; this.rows = []; this.sel = null; },
  dlg() {
    let d = $('#pcapDlg'); if (d) return d;
    d = Object.assign(document.createElement('dialog'), { id: 'pcapDlg', className: 'pcap-dlg' });
    d.innerHTML = `<div class="pc-head"><h3 class="pc-title">📡 Capture traffic</h3><span class="spacer"></span><button type="button" class="icon" data-pc="close" title="Close (stops the capture)">✕</button></div>
      <div class="pc-ctl">
        <label>Interface <input data-pc="iface" value="any" spellcheck="false" title="any = all interfaces; or eth0, ens192…"></label>
        <label class="grow">Filter <input data-pc="filter" spellcheck="false" placeholder="e.g. port 1521 · host 10.0.0.31 · port 8443 and host 10.0.0.15 (empty = everything)"></label>
        <label class="pc-chk" title="tcpdump needs root: runs it with sudo (with the server's saved password)"><input type="checkbox" data-pc="sudo" checked> use sudo <span class="muted tiny pc-user"></span></label>
        <label class="pc-chk" title="Leave out this SSH connection's own packets, so they don't flood the list"><input type="checkbox" data-pc="hidessh" checked> leave out WorkHub's SSH</label>
        <button type="button" class="primary" data-pc="start">▶ Start</button><button type="button" data-pc="stop" hidden>■ Stop</button>
        <button type="button" data-pc="save" disabled title="Download everything captured as a .pcap file — open it in Wireshark">⬇ Save .pcap</button>
      </div>
      <div class="pc-status muted tiny">Pick a filter (or none) and press Start.</div>
      <div class="pc-find"><input data-pc="find" type="search" placeholder="Show only rows with… (address, protocol, port, text)"><span class="muted tiny pc-count"></span></div>
      <div class="pc-table"><table><thead><tr><th>No.</th><th>Time</th><th>Source</th><th>Destination</th><th>Protocol</th><th>Length</th><th>Info</th></tr></thead><tbody></tbody></table></div>
      <pre class="pc-hex muted">Click a packet to see its bytes.</pre>`;
    document.body.append(d);
    d.addEventListener('click', e => {
      const b = e.target.closest('[data-pc]'); const tr = e.target.closest('tr[data-n]');
      if (tr) return this.show(+tr.dataset.n, tr);
      if (!b) return;
      ({ start: () => this.start(), stop: () => this.stop(), save: () => this.save(), close: () => d.close() })[b.dataset.pc]?.();
    });
    d.querySelector('[data-pc=filter]').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); if (!this.running) this.start(); } });
    d.querySelector('[data-pc=find]').addEventListener('input', () => this.draw(true));
    d.addEventListener('close', () => { if (this.id) api('DELETE', `/api/pcap/${this.id}`).catch(() => {}); this.reset(); });
    return d;
  },
  async start() {
    const d = $('#pcapDlg'), v = k => d.querySelector(`[data-pc=${k}]`);
    if (this.id) api('DELETE', `/api/pcap/${this.id}`).catch(() => {});
    this.reset(); this.draw(true);
    d.querySelector('.pc-hex').textContent = 'Click a packet to see its bytes.';
    let r;
    try {
      r = await api('POST', '/api/pcap/start', { entry: this.e.id, iface: v('iface').value.trim(), filter: v('filter').value.trim(), sudo: v('sudo').checked, hide_ssh: v('hidessh').checked });
    } catch (err) { return this.status(`✕ ${err.message}`, true); }
    this.id = r.id; this.running = true; this.ui();
    this.status('Starting tcpdump…');
    this.poll();
  },
  async stop() {
    if (this.id) await api('POST', `/api/pcap/${this.id}/stop`).catch(() => {});
  },
  save() { if (this.id) location.href = `/api/pcap/${this.id}/file`; },
  stopPoll() { clearTimeout(this.timer); this.timer = null; this.running = false; },
  async poll() {
    if (!this.id) return;
    const id = this.id;
    let r; try { r = await api('GET', `/api/pcap/${id}?since=${this.last}`); } catch (err) { return this.status('✕ ' + err.message, true); }
    if (id !== this.id) return;
    if (r.packets.length) { this.rows.push(...r.packets); this.last = r.packets.at(-1).n; if (this.rows.length > 5000) this.rows = this.rows.slice(-5000); this.draw(); }
    const errs = (r.errors || []).join(' · ');
    this.status(errs ? '✕ ' + errs : `${r.running ? '● ' + (r.info || 'capturing…') : '■ Stopped'} — ${r.total} packet${r.total === 1 ? '' : 's'}${r.bytes ? ' · ' + fmtSize(r.bytes) : ''}${r.truncated ? ' (the .pcap stopped growing at 200 MB)' : ''}`, !!errs);
    this.running = r.running; this.ui(r.total > 0);
    if (r.running) this.timer = setTimeout(() => this.poll(), 700);
  },
  ui(has) {
    const d = $('#pcapDlg'); if (!d) return;
    d.querySelector('[data-pc=start]').hidden = this.running;
    d.querySelector('[data-pc=stop]').hidden = !this.running;
    d.querySelector('[data-pc=save]').disabled = !this.id || !(has ?? this.rows.length);
    for (const k of ['iface', 'filter', 'sudo', 'hidessh']) d.querySelector(`[data-pc=${k}]`).disabled = this.running;
  },
  status(t, bad) { const s = $('#pcapDlg .pc-status'); if (s) { s.textContent = t; s.classList.toggle('pc-bad', !!bad); } },
  draw(all) {
    const d = $('#pcapDlg'), body = d.querySelector('tbody'), q = d.querySelector('[data-pc=find]').value.trim().toLowerCase();
    const show = this.rows.filter(p => !q || `${p.src} ${p.dst} ${p.proto} ${p.info} ${p.len}`.toLowerCase().includes(q));
    const wrap = d.querySelector('.pc-table'), atEnd = wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 30;
    const rows = show.slice(-3000); // the newest 3000 on screen (all in the .pcap)
    body.innerHTML = rows.map(p => `<tr data-n="${p.n}" class="pc-${esc(p.proto.toLowerCase().replace(/[^a-z0-9]/g, ''))} ${this.sel === p.n ? 'sel' : ''}"><td>${p.n}</td><td>${p.t.toFixed(6)}</td><td>${esc(p.src)}</td><td>${esc(p.dst)}</td><td>${esc(p.proto)}</td><td>${p.len}</td><td>${esc(p.info)}</td></tr>`).join('');
    d.querySelector('.pc-count').textContent = q ? `${show.length} of ${this.rows.length} shown` : '';
    if (atEnd || all) wrap.scrollTop = wrap.scrollHeight; // keeps following the newest, unless you scrolled up
  },
  async show(n, tr) {
    this.sel = n; $$('#pcapDlg tr.sel').forEach(x => x.classList.remove('sel')); tr.classList.add('sel');
    const pre = $('#pcapDlg .pc-hex');
    try {
      const p = await api('GET', `/api/pcap/${this.id}?pkt=${n}`);
      const bytes = Uint8Array.from(atob(p.data || ''), c => c.charCodeAt(0));
      const lines = [`#${p.n}  ${p.src} → ${p.dst}  ${p.proto}  ${p.len} bytes${bytes.length < p.len ? ` (first ${bytes.length} shown)` : ''}`, `${p.info}`, ''];
      for (let i = 0; i < bytes.length; i += 16) {
        const row = [...bytes.slice(i, i + 16)];
        lines.push(`${i.toString(16).padStart(4, '0')}  ${row.map(b => b.toString(16).padStart(2, '0')).join(' ').padEnd(48)}  ${row.map(b => b >= 32 && b < 127 ? String.fromCharCode(b) : '.').join('')}`);
      }
      pre.textContent = lines.join('\n'); pre.classList.remove('muted');
    } catch (err) { pre.textContent = err.message; }
  },
};
