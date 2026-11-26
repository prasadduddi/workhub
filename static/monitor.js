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
      if (was !== undefined && c.up !== null && was !== c.up) {
        const msg = `${c.up ? '✅ Back up' : '🔴 Down'}: ${c.name} — ${c.host}`;
        toast(msg, !c.up, () => show('monitor'), 'Show');
        try { if (Notification.permission === 'granted') new Notification(msg, { body: c.detail || '' }); } catch { /* not available */ }
      }
      if (c.up !== null) this.last[c.id] = c.up;
    }
    const down = d.checks.filter(c => c.up === false && !c.blocked).length;
    $('#monCount').textContent = d.on && down ? down : '';
  },
  render() {
    const d = this.data; if (!d) return;
    $('#monOn').checked = d.on; $('#monInterval').value = String(d.interval || 60); $('#monProd').checked = !!d.allow_prod;
    const up = d.checks.filter(c => c.up === true).length, down = d.checks.filter(c => c.up === false && !c.blocked).length;
    $('#monSum').textContent = d.checks.length ? `${up} up · ${down} down${d.checks.some(c => c.blocked) ? ` · ${d.checks.filter(c => c.blocked).length} not checked (PROD/UAT)` : ''}${d.on ? '' : ' · monitoring is off'}` : '';
    if (!d.checks.length) { $('#monList').innerHTML = '<div class="empty">No checks yet. Press <b>+ Add checks…</b> to pick Tomcat and Oracle servers from your connections (start with one or two DEV / TEST servers), or <b>+ Custom…</b> for any address.</div>'; return; }
    const byHost = {};
    for (const c of d.checks) (byHost[c.host || c.target] ||= []).push(c);
    const ago = t => { const s = (Date.now() - Date.parse(t)) / 1000; return s < 90 ? Math.round(s) + ' s' : s < 5400 ? Math.round(s / 60) + ' min' : Math.round(s / 3600) + ' h'; };
    $('#monList').innerHTML = Object.entries(byHost).sort(([a], [b]) => a.localeCompare(b)).map(([host, cs]) => {
      const env = cs.find(c => c.env)?.env || '', bad = cs.some(c => c.up === false && !c.blocked);
      return `<div class="mon-card ${bad ? 'bad' : ''}"><div class="mon-head"><b>${esc(host)}</b>${env ? ` <span class="badge ${esc(env)}">${esc(env)}</span>` : ''}</div>
        ${cs.map(c => {
          const state = c.blocked ? 'off' : c.up === true ? 'up' : c.up === false ? 'down' : 'wait';
          const hist = (c.hist || []).slice(-30).map(h => `<i class="${h ? 'u' : 'd'}"></i>`).join('');
          return `<div class="mon-row ${state}" data-mon="${c.id}">
            <span class="mon-dot" title="${{ up: 'Up', down: 'Down', off: 'Not checked (PROD/UAT/DR)', wait: 'Not checked yet' }[state]}"></span>
            <div class="mon-main"><div><b>${esc(c.name)}</b> <span class="muted tiny">${c.group === 'Oracle' ? '🛢' : c.group === 'Tomcat' ? '🐱' : '🔗'} ${esc(c.target)}</span></div>
              <div class="muted tiny">${c.blocked ? '🔒 not checked — PROD / UAT / DR' : c.at ? `${esc(c.detail || '')} · ${c.ms} ms · checked ${ago(c.at)} ago${c.since ? ` · ${c.up ? 'up' : 'down'} for ${ago(c.since)}` : ''}` : d.on ? 'checking…' : 'not checked yet — switch Monitoring on or press Check now'}</div></div>
            <span class="mon-hist" title="Last checks, oldest first">${hist}</span>
            <button class="icon" data-monrm="${c.id}" title="Stop checking this">✕</button></div>`;
        }).join('')}</div>`;
    }).join('');
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
$('#monList').addEventListener('click', e => {
  const rm = e.target.closest('[data-monrm]'); if (!rm) return;
  const c = Monitor.data.checks.find(x => x.id === rm.dataset.monrm);
  Monitor.save({ checks: Monitor.data.checks.filter(x => x !== c).map(({ id, entry_id, name, kind, target, group, host, env }) => ({ id, entry_id, name, kind, target, group, host, env })) });
  toast(`Stopped checking ${c.name}`);
});
// keep the status (and the red count in the menu) fresh, on any page
setInterval(() => Monitor.load(), 20 * 1000);
setTimeout(() => Monitor.load(), 3000);
