'use strict';
// ▶ Run a command on several servers (multirun.go): type it once, see each
// server's output side by side. PROD servers are asked about first; PROD runs go
// to the 🛡 PROD activity log.

const MultiRun = {
  list: [],
  open(list) {
    this.list = list.filter(e => typeof canSSH !== 'function' || canSSH(e));
    if (!this.list.length) return toast('Choose SSH servers first', true);
    let d = $('#multiRunDlg');
    if (!d) {
      d = Object.assign(document.createElement('dialog'), { id: 'multiRunDlg', className: 'askyes multirun-dlg' });
      d.innerHTML = `<div class="ask-head"><span class="ask-logo">W</span>WorkHub</div><h3>▶ Run on several servers</h3>
        <div class="muted tiny mr-servers"></div>
        <div class="row"><input id="mrCmd" placeholder="A command, e.g. df -h /app" style="flex:1;font-family:var(--mono, monospace)">
          <button type="button" class="primary" data-mr="run">▶ Run</button></div>
        <div class="mr-out"></div>
        <div class="row end"><button type="button" data-mr="copy">📋 Copy all</button><button type="button" data-mr="close">Close</button></div>`;
      document.body.append(d);
      d.addEventListener('click', e => {
        const b = e.target.closest('[data-mr]'); if (!b) return;
        if (b.dataset.mr === 'close') d.close();
        if (b.dataset.mr === 'run') this.run();
        if (b.dataset.mr === 'copy') copyText((this.last || []).map(r => `== ${r.name} (${r.host})${r.err ? ' — ' + r.err : ' — exit ' + r.exit}\n${r.output}`).join('\n'), 'Copied');
      });
      $('#mrCmd').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); this.run(); } });
    }
    $('#multiRunDlg .mr-servers').innerHTML = `On ${this.list.length} server${this.list.length > 1 ? 's' : ''}: ` +
      this.list.map(e => `<span class="hostname">${esc(e.name || e.host)}</span>${isProd(e) ? ' <span class="badge PROD">PROD</span>' : ''}`).join(', ');
    $('#multiRunDlg .mr-out').innerHTML = '';
    this.last = null;
    if (!d.open) d.showModal();
    $('#mrCmd').focus();
  },
  async run() {
    const cmd = $('#mrCmd').value.trim(); if (!cmd) return;
    const prod = this.list.filter(isProd);
    if (prod.length && !await askYes(`⚠ PROD — run this on ${prod.length} production server${prod.length > 1 ? 's' : ''}?\n\n${cmd}\n\n${prod.map(e => '• ' + (e.name || e.host)).join('\n')}`)) return;
    const out = $('#multiRunDlg .mr-out'), btn = $('#multiRunDlg [data-mr=run]');
    out.innerHTML = `<div class="muted">▶ Running on ${this.list.length} server${this.list.length > 1 ? 's' : ''}…</div>`;
    btn.disabled = true;
    let r;
    try { r = await api('POST', '/api/multirun', { ids: this.list.map(e => e.id), command: cmd, prod_ok: prod.length > 0 }); }
    catch (err) { out.innerHTML = `<div class="ask-err">${esc(err.message)}</div>`; return; }
    finally { btn.disabled = false; }
    this.last = r.results;
    out.innerHTML = r.results.map(x => `<div class="mr-card ${x.err || x.exit ? 'bad' : ''}">
      <div class="mr-head"><b class="hostname">${esc(x.name)}</b>${x.env ? ` <span class="badge ${esc(x.env)}">${esc(x.env)}</span>` : ''}
        <span class="spacer"></span><span class="muted tiny">${x.err ? '⛔ ' + esc(x.err) : x.exit ? `exit ${x.exit}` : '✓'} · ${(x.ms / 1000).toFixed(1)} s</span></div>
      <pre>${esc(x.output || (x.err ? '' : '(no output)'))}</pre></div>`).join('');
  },
};
