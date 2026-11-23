'use strict';
// Reopen the last session: the SSH terminals, SQL tabs, thread and page that
// were open. After WorkHub restarts itself (an update, Install) it reopens
// them at once; after a normal start it offers to. Connections that need a
// password you haven't saved are skipped; PROD ones are asked about first.

const Session = {
  ready: false, last: '',

  snap() {
    const uniq = a => [...new Set(a)];
    const view = $('.view.active')?.id.replace('view-', '') || 'dashboard';
    return {
      ssh: uniq(Term.tabs.filter(t => !t.local && t.entry).map(t => t.entry.id)),
      sql: uniq(SQL.tabs.map(t => t.entry.id)),
      thread: typeof Work !== 'undefined' && Work.current ? Work.current.id : '',
      view,
    };
  },

  // Saved every few seconds while something changed (only after the start-up
  // decision, so an empty start never overwrites what was open).
  save() {
    if (!this.ready || Lock.shown || /[?&]popout=/.test(location.search)) return; // a popped-out window isn't the session
    const s = this.snap(), key = JSON.stringify(s);
    if (key === this.last) return;
    this.last = key;
    saveSettings({ last_session: { ...s, at: new Date().toISOString() } }).catch(() => {});
  },

  describe(s) {
    return [s.ssh?.length && `${s.ssh.length} SSH`, s.sql?.length && `${s.sql.length} SQL`, s.thread && 'your thread'].filter(Boolean).join(', ');
  },

  async start() {
    if (/[?&]popout=/.test(location.search)) return; // a popped-out window: nothing to reopen
    // wait until the data is there (and the PIN screen, if any, is passed)
    for (let i = 0; i < 120 && (Lock.shown || !S.entries.length); i++) await new Promise(r => setTimeout(r, 500));
    const s = S.settings.last_session;
    const has = s && (s.ssh?.length || s.sql?.length || s.thread);
    if (has && S.restarted) await this.restore(s, true);
    else if (has && !S.settings.no_reopen) {
      const what = this.describe(s);
      if (what) toast(`Reopen what you had open last time (${what})?`, false, () => this.restore(s), 'Reopen');
    }
    this.ready = true;
    this.last = JSON.stringify(this.snap());
    if (!has || S.restarted) this.save();
  },

  async restore(s, auto) {
    const byIdOk = id => S.entries.find(e => e.id === id);
    const ssh = (s.ssh || []).map(byIdOk).filter(Boolean), sql = (s.sql || []).map(byIdOk).filter(Boolean);
    const skipped = [...ssh, ...sql].filter(e => needsCreds(e));
    let prod = [...ssh, ...sql].filter(e => e.env === 'PROD' && !needsCreds(e));
    if (prod.length && !confirm(`Reopen these PROD connections too?\n\n${prod.map(e => '• ' + (e.name || e.host)).join('\n')}\n\nOK = yes · Cancel = only the others`)) prod = prod.map(e => e.id);
    else prod = [];
    const go = e => !needsCreds(e) && !prod.includes(e.id);
    for (const e of ssh.filter(go)) { try { await Term.open(e, { confirmed: true }); } catch { /* shown in its tab */ } }
    for (const e of sql.filter(go)) { try { await SQL.open(e, { stay: true }); } catch { /* shown in the tree */ } }
    if (s.thread && typeof Work !== 'undefined') { try { await Work.loadList?.(); if (Work.list?.some(w => w.id === s.thread)) await Work.open(s.thread); } catch { /* gone */ } }
    if (s.view && document.getElementById('view-' + s.view)) show(s.view);
    const n = ssh.filter(go).length + sql.filter(go).length;
    toast((auto ? 'WorkHub restarted — ' : '') + (n ? `reopened ${n} connection${n > 1 ? 's' : ''}` : 'reopened') +
      (skipped.length ? ` · not reopened (no saved password): ${skipped.map(e => e.name || e.host).join(', ')}` : ''), false);
  },
};
setInterval(() => Session.save(), 4000);
Session.start();
