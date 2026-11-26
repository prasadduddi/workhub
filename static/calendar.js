'use strict';
// Calendar: a month grid and the selected day's agenda with your own events
// (reminders, repeats), Outlook meetings (read-only, Windows) and CM-
// implementation windows from the Jira page. Reminders pop up in WorkHub (and
// as a Windows notification when allowed) for your events and CM windows.

const Cal = {
  month: (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); })(),
  sel: null, events: [], outlook: [], outlookErr: '', outlookRange: '',
  pref(k, def) { try { const v = localStorage.getItem('cal_' + k); return v === null ? def : JSON.parse(v); } catch { return def; } },
  setPref(k, v) { try { localStorage.setItem('cal_' + k, JSON.stringify(v)); } catch { /* ignore */ } },

  ymd(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; },
  at(day, hm) { const [y, m, d] = day.split('-').map(Number); const [h, mi] = (hm || '00:00').split(':').map(Number); return new Date(y, m - 1, d, h, mi); },
  hm(d) { return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); },

  async load() {
    this.events = await api('GET', '/api/events').catch(() => []) || [];
    await this.loadOutlook();
    this.render();
  },

  async loadOutlook(force) {
    if (!this.pref('outlook', true)) { this.outlook = []; return; }
    const from = new Date(this.month.getFullYear(), this.month.getMonth(), -6), to = new Date(this.month.getFullYear(), this.month.getMonth() + 1, 7);
    const range = this.ymd(from) + '/' + this.ymd(to);
    if (!force && range === this.outlookRange) return;
    const r = await api('GET', `/api/calendar/outlook?from=${this.ymd(from)}&to=${this.ymd(to)}`).catch(err => ({ events: [], error: err.message }));
    this.outlook = r.events || []; this.outlookErr = r.error || ''; this.outlookRange = range;
  },

  // Every occurrence between two dates, sorted: {kind, title, start, end, allDay, ev, day, url, sub}.
  occurrences(from, to) {
    const out = [];
    for (const e of this.events) {
      const first = this.at(e.date), until = e.until ? this.at(e.until, '23:59') : null;
      for (let d = new Date(Math.max(first, new Date(from.getFullYear(), from.getMonth(), from.getDate()))); d <= to; d.setDate(d.getDate() + 1)) {
        if (d < new Date(first.getFullYear(), first.getMonth(), first.getDate()) || (until && d > until)) continue;
        const day = this.ymd(d);
        const hit = !e.repeat ? day === e.date : e.repeat === 'daily' ? true : e.repeat === 'weekdays' ? d.getDay() > 0 && d.getDay() < 6
          : e.repeat === 'weekly' ? d.getDay() === first.getDay() : e.repeat === 'monthly' ? d.getDate() === first.getDate() : false;
        if (!hit || (e.skip || []).includes(day)) continue;
        out.push({ kind: 'mine', title: e.title, start: this.at(day, e.start), end: e.end ? this.at(day, e.end) : null, allDay: !e.start, ev: e, day, url: e.link, sub: e.notes });
        if (!e.repeat) break;
      }
    }
    if (this.pref('outlook', true)) for (const o of this.outlook) {
      const s = new Date(o.start), en = new Date(o.end);
      if (en >= from && s <= to) out.push({ kind: 'outlook', title: o.subject, start: s, end: en, allDay: o.all_day, sub: [o.location, o.organizer].filter(Boolean).join(' · ') });
    }
    if (this.pref('cm', true) && typeof Jira !== 'undefined') {
      const seen = new Set();
      const issues = Jira.issues.length ? Jira.issues : (this.lockedCM || []).map(c => ({ key: c.Parent, children: [{ key: c.Key, summary: c.Summary, status: c.Status, start: c.Start, end: c.End, url: c.URL }] }));
      for (const j of issues) for (const c of j.children || []) {
        if (!c.start || seen.has(c.key)) continue;
        seen.add(c.key);
        const s = new Date(c.start), en = c.end ? new Date(c.end) : null;
        if ((en || s) >= from && s <= to) out.push({ kind: 'cm', title: `${c.key} ${c.summary}`, start: s, end: en, allDay: false, url: c.url, sub: `${c.status} · for ${j.key}`, key: c.key, parent: j.key });
      }
    }
    return out.sort((a, b) => a.start - b.start);
  },

  render() {
    if (!$('#view-cal')) return;
    const m = this.month, today = this.ymd(new Date());
    this.sel ||= today;
    $('#calTitle').textContent = m.toLocaleDateString([], { month: 'long', year: 'numeric' });
    $('#calOutlook').checked = this.pref('outlook', true); $('#calCM').checked = this.pref('cm', true);
    $('#calCMRemind').value = String(this.pref('cmRemind', 30));
    const start = new Date(m.getFullYear(), m.getMonth(), 1 - ((m.getDay() + 6) % 7)); // weeks start Monday
    const end = new Date(start); end.setDate(end.getDate() + 41); end.setHours(23, 59);
    const occ = this.occurrences(start, end);
    const byDay = {};
    for (const o of occ) {
      const d = new Date(o.start); const last = o.end && o.allDay ? new Date(o.end.getTime() - 1) : d;
      for (const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x <= last; x.setDate(x.getDate() + 1)) (byDay[this.ymd(x)] ||= []).push(o);
    }
    let html = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => `<div class="cal-dow">${d}</div>`).join('');
    for (let i = 0; i < 42; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i);
      const day = this.ymd(d), list = byDay[day] || [];
      html += `<div class="cal-day ${d.getMonth() !== m.getMonth() ? 'other' : ''} ${day === today ? 'today' : ''} ${day === this.sel ? 'sel' : ''}" data-day="${day}">
        <div class="cal-num">${d.getDate()}</div>
        ${list.slice(0, 3).map(o => `<div class="cal-ev k-${o.kind}" title="${esc(o.title)}">${o.allDay ? '' : `<b>${this.hm(o.start)}</b> `}${esc(o.title)}</div>`).join('')}
        ${list.length > 3 ? `<div class="cal-more">+${list.length - 3} more</div>` : ''}</div>`;
    }
    $('#calGrid').innerHTML = html;
    this.renderDay(byDay[this.sel] || []);
    $('#calNote').textContent = this.pref('outlook', true) && this.outlookErr ? 'Outlook: ' + this.outlookErr : '';
  },

  renderDay(list) {
    const d = this.at(this.sel);
    const label = { mine: 'Mine', outlook: 'Outlook', cm: 'CM window' };
    $('#calAgenda').innerHTML = `<div class="ghead"><h3>${esc(d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }))}</h3><span class="spacer"></span><button class="primary" data-cal="new">+ Event</button></div>
      ${list.map((o, i) => `<div class="cal-item k-${o.kind}" data-ci="${i}">
        <div class="cal-time">${o.allDay ? 'All day' : this.hm(o.start) + (o.end ? '–' + this.hm(o.end) : '')}</div>
        <div class="cal-body"><b>${esc(o.title)}</b> <span class="cal-tag k-${o.kind}">${label[o.kind]}</span>${o.ev?.repeat ? ' <span class="muted tiny">↻ ' + esc(o.ev.repeat) + '</span>' : ''}
          ${o.sub ? `<div class="muted tiny">${esc(o.sub)}</div>` : ''}
          <div class="row">${o.url ? `<button class="icon" data-cal="open" data-i="${i}">Open ↗</button>` : ''}${o.kind === 'mine' ? `<button class="icon" data-cal="edit" data-i="${i}">Edit</button><button class="icon danger" data-cal="del" data-i="${i}">Delete</button>` : ''}</div></div></div>`).join('')
      || '<div class="empty">Nothing on this day.</div>'}`;
    this.dayList = list;
  },

  edit(ev, day) {
    const e = ev || { title: '', date: day || this.sel, start: '', end: '', remind: 10, repeat: '', until: '', link: '', notes: '' };
    this.editing = ev || null;
    $('#evTitle').value = e.title; $('#evDate').value = e.date; $('#evAllDay').checked = !!ev && !e.start;
    $('#evStart').value = e.start || '09:00'; $('#evEnd').value = e.end || '';
    $('#evRemind').value = String(e.remind ?? 10); $('#evRepeat').value = e.repeat || ''; $('#evUntil').value = e.until || '';
    $('#evLink').value = e.link || ''; $('#evNotes').value = e.notes || '';
    $('#evDelete').hidden = !ev; this.allDay();
    $('#eventDlg').showModal(); $('#evTitle').focus();
  },
  allDay() { const a = $('#evAllDay').checked; $('#evStart').disabled = $('#evEnd').disabled = a; },

  async save() {
    const all = $('#evAllDay').checked;
    const body = { ...(this.editing || {}), title: $('#evTitle').value, date: $('#evDate').value, start: all ? '' : $('#evStart').value, end: all ? '' : $('#evEnd').value,
      remind: +$('#evRemind').value, repeat: $('#evRepeat').value, until: $('#evUntil').value, link: $('#evLink').value.trim(), notes: $('#evNotes').value };
    try { await api('POST', '/api/events', body); $('#eventDlg').close(); this.sel = body.date; await this.load(); toast('Saved'); }
    catch (err) { toast(err.message, true); }
  },

  async del(ev, day) {
    if (ev.repeat) {
      const one = await askYes(`"${ev.title}" repeats. OK = delete only ${day}, Cancel = more choices`);
      if (one) { await api('DELETE', `/api/events/${ev.id}?day=${day}`); return this.load(); }
      if (!await askYes(`Delete every "${ev.title}"?`)) return;
    } else if (!await askYes(`Delete "${ev.title}"?`)) return;
    await api('DELETE', `/api/events/${ev.id}`); this.load();
  },

  // ---- reminders ----
  notified() { try { return new Set(JSON.parse(localStorage.getItem('calNotified') || '[]')); } catch { return new Set(); } },
  async remindTick() {
    if (typeof Lock !== 'undefined' && Lock.shown) { // locked: just the events and CM windows, from the lock endpoint
      const r = await fetch('/api/lock/reminders').then(x => x.json()).catch(() => null);
      if (!r) return;
      this.events = r.events || []; this.lockedCM = r.cm || [];
    }
    const now = new Date(), from = new Date(now.getTime() - 12 * 3600e3), to = new Date(now.getTime() + 26 * 3600e3);
    const done = this.notified(), due = [];
    const cmBefore = +this.pref('cmRemind', 30);
    for (const o of this.occurrences(from, to)) {
      const marks = [];
      if (o.kind === 'mine' && !o.allDay && o.ev.remind >= 0) marks.push([o.ev.remind, o.ev.remind ? `in ${o.ev.remind} min` : 'now']);
      if (o.kind === 'mine' && o.allDay && o.ev.remind >= 0) marks.push([0, 'today']);
      if (o.kind === 'cm' && cmBefore >= 0) { if (cmBefore > 0) marks.push([cmBefore, `starts in ${cmBefore} min`]); marks.push([0, 'implementation starts now']); }
      for (const [mins, when] of marks) {
        const at = new Date(o.start.getTime() - mins * 60e3), id = `${o.kind}|${o.ev?.id || o.key}|${o.start.toISOString()}|${mins}`;
        if (now >= at && now - at < 15 * 60e3 && !done.has(id)) { due.push({ o, when, id }); done.add(id); }
      }
    }
    if (!due.length) return;
    try { localStorage.setItem('calNotified', JSON.stringify([...done].slice(-300))); } catch { /* ignore */ }
    this.popup(due);
  },
  popup(due) {
    $('#remBody').innerHTML = due.map(({ o, when }) => `<div class="cal-item k-${o.kind}"><div class="cal-time">${o.allDay ? 'All day' : this.hm(o.start) + (o.end ? '–' + this.hm(o.end) : '')}</div>
      <div class="cal-body"><b>${esc(o.title)}</b><div class="muted tiny">${esc(when)}${o.sub ? ' · ' + esc(o.sub) : ''}</div>${o.url ? `<button class="icon" data-remurl="${esc(o.url)}">Open ↗</button>` : ''}${(t => t ? `<button class="icon" data-remthread="${t.id}" title="Open the task thread for this change">🧵 ${esc(t.title)}</button>` : '')(o.key && typeof Work !== 'undefined' && Work.byJira(o.key, o.parent))}</div></div>`).join('');
    $('#remCal').hidden = typeof Lock !== 'undefined' && Lock.shown;
    if ($('#remDlg').open) $('#remDlg').close();
    $('#remDlg').showModal(); // on top, even over the lock screen
    try {
      if (window.Notification && Notification.permission === 'granted') for (const { o, when } of due) new Notification('WorkHub · ' + (o.kind === 'cm' ? 'CM ' : '') + when, { body: o.title });
    } catch { /* desktop window may not support it */ }
  },
};

$('#calPrev').onclick = async () => { Cal.month.setMonth(Cal.month.getMonth() - 1); await Cal.loadOutlook(); Cal.render(); };
$('#calNext').onclick = async () => { Cal.month.setMonth(Cal.month.getMonth() + 1); await Cal.loadOutlook(); Cal.render(); };
$('#calToday').onclick = async () => { const d = new Date(); Cal.month = new Date(d.getFullYear(), d.getMonth(), 1); Cal.sel = Cal.ymd(d); await Cal.loadOutlook(); Cal.render(); };
$('#calOutlook').onchange = async e => { Cal.setPref('outlook', e.target.checked); await Cal.loadOutlook(true); Cal.render(); };
$('#calCM').onchange = e => { Cal.setPref('cm', e.target.checked); Cal.render(); };
$('#calCMRemind').onchange = e => Cal.setPref('cmRemind', +e.target.value);
$('#calGrid').addEventListener('click', e => { const d = e.target.closest('[data-day]'); if (d) { Cal.sel = d.dataset.day; Cal.render(); } });
$('#calGrid').addEventListener('dblclick', e => { const d = e.target.closest('[data-day]'); if (d) Cal.edit(null, d.dataset.day); });
$('#calAgenda').addEventListener('click', e => {
  const b = e.target.closest('[data-cal]'); if (!b) return;
  const o = Cal.dayList?.[+b.dataset.i];
  if (b.dataset.cal === 'new') return Cal.edit(null, Cal.sel);
  if (b.dataset.cal === 'open') return openExternal(o.url);
  if (b.dataset.cal === 'edit') return Cal.edit(o.ev);
  if (b.dataset.cal === 'del') return Cal.del(o.ev, o.day);
});
$('#calNew').onclick = () => Cal.edit(null, Cal.sel);
$('#calNotify').onclick = async () => {
  if (!window.Notification) return toast('Notifications are not available here — reminders still pop up inside WorkHub');
  const p = await Notification.requestPermission(); toast(p === 'granted' ? 'Windows notifications on' : 'Notifications not allowed — reminders still pop up inside WorkHub');
};
$('#evAllDay').onchange = () => Cal.allDay();
$('#evSave').onclick = () => Cal.save();
$('#evCancel').onclick = () => $('#eventDlg').close();
$('#evDelete').onclick = () => { $('#eventDlg').close(); Cal.del(Cal.editing, Cal.sel); };
$('#remClose').onclick = () => $('#remDlg').close();
$('#remCal').onclick = () => { $('#remDlg').close(); show('cal'); };
$('#remBody').addEventListener('click', e => {
  const u = e.target.closest('[data-remurl]'); if (u) openExternal(u.dataset.remurl);
  const t = e.target.closest('[data-remthread]'); if (t) { $('#remDlg').close(); Work.open(t.dataset.remthread); }
});
Cal.load();
setInterval(() => Cal.remindTick(), 30000);
setTimeout(() => Cal.remindTick(), 5000);
setInterval(async () => { if (Cal.pref('outlook', true)) { await Cal.loadOutlook(true); Cal.render(); } }, 15 * 60000);
