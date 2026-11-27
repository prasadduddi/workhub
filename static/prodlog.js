'use strict';
// 🛡 PROD activity log (prodlog.go): what was done on PROD servers — terminals,
// typed / pasted lines, SQL that changes data, commits, captures, runs on several
// servers. Search it; export it for a change review.

const ProdLog = {
  icon: { terminal: '🖥', typed: '⌨', pasted: '📋', sql: '🛢', commit: '✅', rollback: '↩', capture: '📡', run: '▶' },
  async open() {
    let d = $('#prodLogDlg');
    if (!d) {
      d = Object.assign(document.createElement('dialog'), { id: 'prodLogDlg', className: 'askyes prodlog-dlg' });
      d.innerHTML = `<div class="ask-head"><span class="ask-logo">W</span>WorkHub</div><h3>🛡 PROD activity log</h3>
        <div class="muted tiny">What was done on PROD servers through WorkHub: terminals opened, lines typed or pasted, SQL that changes data, commits, captures, commands run on several servers. Kept for a year, on this PC only. Lines typed at a password prompt and passwords in SQL are never kept.</div>
        <div class="row"><input id="prodLogQ" type="search" placeholder="Search: server, command, date (2026-11-27)…" style="flex:1">
          <button type="button" data-pl="csv" title="Save what's shown as a CSV file (opens in Excel)">⬇ Export CSV</button></div>
        <div class="prodlog-list"></div>
        <div class="row end"><button type="button" class="primary" data-pl="close">Close</button></div>`;
      document.body.append(d);
      d.addEventListener('click', e => {
        const b = e.target.closest('[data-pl]'); if (!b) return;
        if (b.dataset.pl === 'close') d.close();
        if (b.dataset.pl === 'csv') location.href = '/api/prodlog?format=csv&q=' + encodeURIComponent($('#prodLogQ').value);
      });
      let t; $('#prodLogQ').oninput = () => { clearTimeout(t); t = setTimeout(() => this.draw(), 250); };
    }
    $('#prodLogQ').value = '';
    await this.draw(); if (!d.open) d.showModal();
    $('#prodLogQ').focus();
  },
  async draw() {
    const r = await api('GET', '/api/prodlog?q=' + encodeURIComponent($('#prodLogQ').value)).catch(err => (toast(err.message, true), { events: [] }));
    const list = $('#prodLogDlg .prodlog-list');
    list.innerHTML = r.events.length ? `<table class="prodlog"><thead><tr><th>When</th><th>Server</th><th>What</th></tr></thead><tbody>${r.events.map(ev => `<tr>
        <td class="nowrap muted">${esc(new Date(ev.at).toLocaleString())}</td>
        <td><b class="hostname">${esc(ev.server)}</b>${ev.user ? `<div class="muted tiny">${esc(ev.user)}</div>` : ''}</td>
        <td><span title="${esc(ev.kind)}">${this.icon[ev.kind] || '•'}</span> <code>${esc(ev.what)}</code>${ev.note ? ` <span class="muted tiny">· ${esc(ev.note)}</span>` : ''}</td></tr>`).join('')}</tbody></table>`
      : `<div class="muted bin-empty">${$('#prodLogQ').value ? 'Nothing matches.' : 'Nothing done on PROD yet.'}</div>`;
  },
};
