'use strict';
// Monitor: Tomcat manager / admin pages and ports, Oracle listeners — green
// when they answer, red when not (see monitor.go). PROD / UAT / DR are left
// alone unless allowed. Changes pop up (and as Windows notifications).

const Monitor = {
  data: null, last: {},
  async load(run) {
    const d = await api(run ? 'POST' : 'GET', '/api/monitor' + (run ? '/run' : '')).catch(err => (toast(err.message, true), null));
    if (!d) return;
    this.notify(d);
    this.data = d;
    this.render();
  },
  // up → down and down → up: say so
  notify(d) {
    for (const c of d.checks) {
      const was = this.last[c.id];
      // down / up: told by WorkHub's notifications (🔔 notify.go), not here too
      if (c.up !== null) this.last[c.id] = c.up;
    }
    const down = d.checks.filter(c => c.up === false && !c.blocked).length;
    $('#monCount').textContent = d.on && down ? down : '';
  },
  filter: 'all',
  certDays(c) { return c.cert_expires ? Math.floor((new Date(c.cert_expires) - Date.now()) / 864e5) : null; },
  render() {
    const d = this.data; if (!d) return;
    $('#monOn').checked = d.on; $('#monInterval').value = String(d.interval || 60); $('#monProd').checked = !!d.allow_prod;
    const live = d.checks.filter(c => !c.blocked);
    const up = live.filter(c => c.up === true).length, down = live.filter(c => c.up === false).length, wait = live.filter(c => c.up == null).length;
    const blocked = d.checks.length - live.length;
    const certSoon = d.checks.filter(c => { const n = this.certDays(c); return n !== null && n < 30; });
    const ms = live.filter(c => c.up).map(c => c.ms || 0), avg = ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : null;
    const hist = live.flatMap(c => c.hist || []), uptime = hist.length ? (100 * hist.filter(Boolean).length / hist.length) : null;
    const last = Math.max(0, ...d.checks.map(c => c.at ? Date.parse(c.at) : 0));
    const every = { 30: '30 s', 60: 'minute', 300: '5 min', 900: '15 min' }[d.interval] || 'minute';
    $('#monSum').textContent = d.checks.length ? `${up} up · ${down} down${blocked ? ` · ${blocked} not checked (PROD/UAT)` : ''}${d.on ? '' : ' · monitoring is off'}` : '';
    const ago = t => { const s = (Date.now() - t) / 1000; return s < 90 ? Math.round(s) + ' s' : s < 5400 ? Math.round(s / 60) + ' min' : Math.round(s / 3600) + ' h'; };
    // the status banner and the tiles
    const state = !d.checks.length ? 'none' : !d.on ? 'off' : down ? 'bad' : certSoon.some(c => this.certDays(c) < 14) ? 'warn' : wait === live.length ? 'wait' : 'ok';
    const headline = { none: 'Nothing monitored yet', off: 'Monitoring is off', bad: `${down} check${down > 1 ? 's' : ''} down`, warn: 'Certificates need attention', wait: 'Checking…', ok: 'All systems normal' }[state];
    const sub = state === 'bad' ? live.filter(c => c.up === false).map(c => esc(c.name) + ' · ' + esc(c.host || c.target)).slice(0, 3).join(' &nbsp;·&nbsp; ')
      : state === 'off' ? 'Switch “Monitoring” on to check every ' + every
      : last ? `Last check ${ago(last)} ago · every ${every}` : '';
    const tile = (k, v, label, cls = '', title = '') => `<div class="mon-kpi ${cls}" ${k ? `data-monf="${k}"` : ''} title="${esc(title)}"><div class="mon-kpi-v">${v}</div><div class="mon-kpi-l">${label}</div></div>`;
    $('#monHero').innerHTML = d.checks.length ? `<div class="mon-banner ${state}"><span class="mon-beacon"></span><div><div class="mon-headline">${headline}</div><div class="mon-sub">${sub}</div></div></div>
      <div class="mon-kpis">${tile('all', up, 'Up', 'ok', 'Click: show all')}${tile('problems', down, 'Down', down ? 'bad' : '', 'Click: only problems')}${tile('', wait + blocked, 'Not checked', '', 'Waiting for the first check, or PROD / UAT / DR (locked)')}${tile('certs', certSoon.length, 'Certificates &lt; 30 days', certSoon.length ? 'warn' : '', 'Click: only checks with a certificate')}${tile('', avg === null ? '–' : (avg || '&lt;1') + '<small> ms</small>', 'Average response')}${tile('', uptime === null ? '–' : uptime.toFixed(uptime === 100 ? 0 : 1) + '<small>%</small>', 'Uptime (recent checks)', uptime !== null && uptime < 99 ? 'warn' : '')}</div>` : '';
    $$('#monSeg [data-monf]').forEach(b => b.classList.toggle('active', b.dataset.monf === this.filter));
    if (!d.checks.length) { $('#monList').innerHTML = '<div class="empty mon-empty">📡 No checks yet. Press <b>+ Add checks…</b> to pick Tomcat and Oracle servers from your connections (start with one or two DEV / TEST servers), or <b>+ Custom…</b> for any web address or host:port.</div>'; return; }
    // the tiles of each server: problems first
    const q = ($('#monQ')?.value || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    const show = c => (this.filter === 'all' || (this.filter === 'problems' ? (c.up === false && !c.blocked) || (this.certDays(c) ?? 99) < 30 : this.filter === 'certs' ? !!(c.cert_expires || c.cert_err) : c.group === this.filter))
      && q.every(w => `${c.name} ${c.host} ${c.target} ${c.env}`.toLowerCase().includes(w));
    const byHost = {};
    for (const c of d.checks.filter(show)) (byHost[c.host || c.target] ||= []).push(c);
    const rank = cs => cs.some(c => c.up === false && !c.blocked) ? 0 : cs.some(c => (this.certDays(c) ?? 99) < 30) ? 1 : 2;
    const hosts = Object.entries(byHost).sort(([a, x], [b, y]) => rank(x) - rank(y) || a.localeCompare(b));
    $('#monList').innerHTML = hosts.length ? hosts.map(([host, cs]) => {
      const env = cs.find(c => c.env)?.env || '', r = rank(cs), n = cs.filter(c => c.up === true).length;
      const light = r === 0 ? 'bad' : cs.every(c => c.blocked) ? 'off' : r === 1 ? 'warn' : 'ok';
      return `<div class="mon-card ${r === 0 ? 'bad' : r === 1 ? 'warn' : ''}"><div class="mon-head"><span class="mon-light ${light}"></span><b class="hostname">${esc(host)}</b>${env ? ` <span class="badge ${esc(env)}">${esc(env)}</span>` : ''}<span class="spacer"></span><span class="mon-count">${n}/${cs.length} up</span></div>
        ${cs.map(c => {
          const st = c.blocked ? 'off' : c.up === true ? 'up' : c.up === false ? 'down' : 'wait';
          const h = c.hist || [], pct = h.length ? Math.round(100 * h.filter(Boolean).length / h.length) : null;
          const bars = h.slice(-30).map(x => `<i class="${x ? 'u' : 'd'}"></i>`).join('');
          const lat = c.up ? `<span class="mon-ms ${c.ms > 2000 ? 'slow' : c.ms > 800 ? 'meh' : ''}">${c.ms || '&lt;1'}<small> ms</small></span>` : c.up === false ? '<span class="mon-ms down">DOWN</span>' : '<span class="mon-ms">–</span>';
          return `<div class="mon-row ${st}" data-mon="${c.id}">
            <span class="mon-dot" title="${{ up: 'Up', down: 'Down', off: 'Not checked (PROD/UAT/DR)', wait: 'Not checked yet' }[st]}"></span>
            <div class="mon-main"><div><b>${esc(c.name)}</b> ${this.certChip(c)}</div>
              <div class="muted tiny mon-target">${c.group === 'Oracle' ? '🛢' : c.group === 'Tomcat' ? '🐱' : '🔗'} ${esc(c.target)}</div>
              <div class="muted tiny">${c.blocked ? '🔒 not checked — PROD / UAT / DR' : c.at ? `${esc(c.detail || '')} · checked ${ago(Date.parse(c.at))} ago${c.since ? ` · ${c.up ? 'up' : 'down'} for ${ago(Date.parse(c.since))}` : ''}` : d.on ? 'checking…' : 'not checked — monitoring is off'}</div></div>
            <div class="mon-graph" title="Response time, last checks">${lat}${this.spark(c.ms_hist)}</div>
            <div class="mon-up" title="Last ${h.length} checks, oldest first">${pct === null ? '' : `<span class="mon-pct">${pct}%</span>`}<span class="mon-hist">${bars}</span></div>
            <button class="icon mon-x" data-monrm="${c.id}" title="Stop checking this">✕</button></div>`;
        }).join('')}</div>`;
    }).join('') : '<div class="empty mon-empty">Nothing matches this filter.</div>';
  },
  // response times as a small line (red marks where it was down)
  spark(list) {
    const v = (list || []).slice(-30); if (v.length < 2) return '<svg class="mon-spark"></svg>';
    const ok = v.filter(x => x >= 0), hi = Math.max(10, ...ok), W = 96, H = 26, step = W / (v.length - 1);
    let path = '', pen = false;
    v.forEach((x, i) => { if (x < 0) { pen = false; return; } const y = H - 2 - (x / hi) * (H - 4); path += `${pen ? 'L' : 'M'}${(i * step).toFixed(1)},${y.toFixed(1)}`; pen = true; });
    const downs = v.map((x, i) => x < 0 ? `<rect x="${(i * step - 1.5).toFixed(1)}" y="0" width="3" height="${H}" class="d"/>` : '').join('');
    return `<svg class="mon-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Response times">${downs}<path d="${path}"/></svg>`;
  },
  // 🔒 the TLS certificate: days left (amber under 30, red under 14 / expired)
  certChip(c) {
    if (c.cert_err) return `<span class="cert-chip" title="Couldn't read the certificate: ${esc(c.cert_err)}">🔒 ?</span>`;
    if (!c.cert_expires) return '';
    const days = Math.floor((new Date(c.cert_expires) - Date.now()) / 864e5);
    const cls = days < 0 || days < 14 ? 'bad' : days < 30 ? 'warn' : 'ok';
    const label = days < 0 ? 'expired' : `${days} day${days === 1 ? '' : 's'}`;
    return `<span class="cert-chip ${cls}" title="Certificate ${esc(c.cert_subject || '')} (from ${esc(c.cert_issuer || '?')}) — valid until ${esc(new Date(c.cert_expires).toLocaleDateString())}">🔒 ${label}</span>`;
  },
  async save(patch) {
    const d = this.data;
    const body = { on: d.on, interval: d.interval, allow_prod: d.allow_prod, checks: d.checks.map(({ id, entry_id, name, kind, target, group, host, env }) => ({ id, entry_id, name, kind, target, group, host, env })), ...patch };
    try { this.data = await api('POST', '/api/monitor', body); this.render(); } catch (err) { toast(err.message, true); this.load(); }
  },
  // Pick from what WorkHub knows: Tomcat pages/ports and Oracle listeners.
  async add() {
    const list = await api('GET', '/api/monitor/suggest').catch(err => (toast(err.message, true), null));
    if (!list) return;
    $('#monAddDlg')?.remove();
    const dlg = document.createElement('dialog'); dlg.id = 'monAddDlg'; dlg.className = 'mon-add';
    dlg.innerHTML = `<h3>Add checks</h3><div class="muted tiny">From your saved connections. Start with one or two DEV / TEST servers. PROD / UAT ones are locked unless “also PROD / UAT” is on.</div>
      <input type="search" placeholder="Filter… e.g. dev, oracle, app-05" class="mon-filter">
      <div class="mon-sugs">${list.map((c, i) => `<label class="mon-sug ${c.blocked ? 'locked' : ''}" data-text="${esc((c.host + ' ' + c.name + ' ' + c.target + ' ' + (c.env || '')).toLowerCase())}"><input type="checkbox" value="${i}" ${c.blocked ? 'disabled' : ''}>${c.blocked ? '🔒' : c.group === 'Oracle' ? '🛢' : '🐱'} <b>${esc(c.host)}</b> ${c.env ? `<span class="badge ${esc(c.env)}">${esc(c.env)}</span>` : ''} <span>${esc(c.name)}</span> <span class="muted tiny">${esc(c.target)}</span></label>`).join('') || '<div class="muted tiny">No Tomcat or Oracle servers found in your connections — use + Custom….</div>'}</div>
      <div class="row end"><button value="cancel">Cancel</button><button value="add" class="primary">Add and check</button></div>`;
    document.body.append(dlg); dlg.showModal();
    $('.mon-filter', dlg).addEventListener('input', e => { const q = e.target.value.trim().toLowerCase(); $$('.mon-sug', dlg).forEach(l => { l.hidden = !!q && !q.split(/\s+/).every(w => l.dataset.text.includes(w)); }); });
    dlg.addEventListener('close', () => dlg.remove());
    dlg.addEventListener('click', async e => {
      const b = e.target.closest('button[value]'); if (!b) return;
      if (b.value === 'cancel') return dlg.close();
      const picked = $$('.mon-sug input:checked', dlg).map(x => list[+x.value]);
      dlg.close();
      if (!picked.length) return;
      await this.save({ on: true, checks: [...this.data.checks, ...picked].map(({ id, entry_id, name, kind, target, group, host, env }) => ({ id, entry_id, name, kind, target, group, host, env })) });
      try { if (Notification.permission === 'default') Notification.requestPermission(); } catch { /* not available */ }
      toast(`Checking ${picked.length} more — monitoring is on`);
      this.load(true);
    });
  },
  async custom() {
    const t = await askText('What to check?\n• a web address, e.g. http://dev-app-01:8080/manager/html\n• or host:port, e.g. dev-db-01:1521', '');
    if (!t?.trim()) return;
    const v = t.trim(), http = /^https?:\/\//i.test(v);
    let host = v; try { host = http ? new URL(v).hostname : v.split(':')[0]; } catch { /* checked by the server */ }
    const name = await askText('A name for it', http ? 'Web page' : 'Port ' + (v.split(':')[1] || '')) || v;
    const known = S.entries.find(e => (e.host || '').toLowerCase() === host.toLowerCase() && e.env);
    if (known && ['PROD', 'UAT', 'DR'].includes(known.env) && !this.data.allow_prod && !await askYes(`${host} is a ${known.env} server — it won't be checked unless “also PROD / UAT” is on. Add it anyway?`)) return;
    await this.save({ checks: [...this.data.checks, { name, kind: http ? 'http' : 'tcp', target: v, group: 'Custom', host, env: known?.env || '', entry_id: known?.id || '' }] });
    this.load(true);
  },
};
$('#monOn').onchange = e => Monitor.save({ on: e.target.checked }).then(() => e.target.checked && Monitor.load(true));
$('#monInterval').onchange = e => Monitor.save({ interval: +e.target.value });
$('#monProd').onchange = async e => {
  if (e.target.checked && !await askYes('Also check PROD, UAT and DR servers?\n\nThe checks only open the page or port (no login), but this sends requests to those servers every interval.')) { e.target.checked = false; return; }
  Monitor.save({ allow_prod: e.target.checked });
};
$('#monRun').onclick = () => Monitor.load(true);
$('#monAdd').onclick = () => Monitor.add();
$('#monCustom').onclick = () => Monitor.custom();
$('#view-monitor').addEventListener('click', e => { // the filter buttons, and the tiles that filter
  const f = e.target.closest('[data-monf]'); if (!f) return;
  Monitor.filter = f.dataset.monf; Monitor.render();
});
$('#monQ').addEventListener('input', () => Monitor.render());
$('#monList').addEventListener('click', e => {
  const rm = e.target.closest('[data-monrm]'); if (!rm) return;
  const c = Monitor.data.checks.find(x => x.id === rm.dataset.monrm);
  Monitor.save({ checks: Monitor.data.checks.filter(x => x !== c).map(({ id, entry_id, name, kind, target, group, host, env }) => ({ id, entry_id, name, kind, target, group, host, env })) });
  toast(`Stopped checking ${c.name}`);
});
// keep the status (and the red count in the menu) fresh, on any page
setInterval(() => Monitor.load(), 20 * 1000);
setTimeout(() => Monitor.load(), 3000);
