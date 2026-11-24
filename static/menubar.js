'use strict';
// Menu bar (File · Edit · View · Connect · Tools · Help) for actions, and the
// sidebar for pages only — in three groups (Work · Connect · Library) that
// fold, with pages you don't use hidden (View → Pages in the sidebar).
// Alt+F / E / V / C / T / H open the menus (not while typing in a terminal,
// an editor or a box, where Alt keys belong to them).

// name, icon, colour (none of them red: red is for PROD), what it holds, pages
const PAGE_GROUPS = [
  ['My work', '📋', '#7c5cd6', 'Your day: dashboard, threads, notes, calendar, Jira', ['dashboard', 'tasks', 'notes', 'cal', 'jira']],
  ['Connect', '🔌', '#2f7de1', 'Servers and services: SSH, FTP, SQL, API requests, Monitor, Git', ['terminal', 'files', 'sql', 'api', 'monitor', 'git']],
  ['Saved', '📚', '#2a9d8f', 'Things you keep: folders of files, bookmarks, groups, captured text', ['ref', 'bookmarks', 'groups', 'inbox']],
];

const Menubar = {
  store(k, v) { try { if (v === undefined) return JSON.parse(localStorage.getItem(k) || 'null'); localStorage.setItem(k, JSON.stringify(v)); } catch { return null; } },
  hidden() { return new Set(this.store('navHidden') || []); },
  folded() { return new Set(this.store('navFolded') || []); },
  label(v) { return $(`#nav [data-view="${v}"] .nl`)?.textContent || v; },
  pages() { return PAGE_GROUPS.flatMap(g => g[4]); },

  // ---- the sidebar: regroup the page buttons under three headings ----
  regroup() {
    const nav = $('#nav'); if (!nav) return;
    const btn = v => $(`#nav [data-view="${v}"]`);
    const dashRow = btn('dashboard')?.closest('.navrow'); // Dashboard shares a row with the search button
    $$('#nav .navhead').forEach(h => h.remove());
    const frag = document.createDocumentFragment();
    for (const [name, icon, color, about, views] of PAGE_GROUPS) {
      const box = Object.assign(document.createElement('div'), { className: 'navgroup' });
      box.dataset.grp = name; box.style.setProperty('--gc', color);
      const head = Object.assign(document.createElement('button'), { className: 'navhead navgrp', title: `${about}\nClick to fold / unfold` });
      head.dataset.grp = name;
      head.innerHTML = `<span class="ng-ic">${icon}</span><span class="ng-name">${name}</span><span class="ng-n"></span><span class="ng-tw"></span>`;
      box.append(head);
      for (const v of views) { const el = v === 'dashboard' && dashRow ? dashRow : btn(v); if (el) { el.dataset.grpOf = name; box.append(el); } }
      frag.append(box);
    }
    nav.append(frag);
    this.applyNav();
    nav.addEventListener('click', e => {
      const h = e.target.closest('.navgrp'); if (!h) return;
      const f = this.folded(); f.has(h.dataset.grp) ? f.delete(h.dataset.grp) : f.add(h.dataset.grp);
      this.store('navFolded', [...f]); this.applyNav();
    });
  },
  applyNav() {
    const hid = this.hidden(), fold = this.folded(), active = $('.view.active')?.id.replace('view-', '');
    for (const [name, , , , views] of PAGE_GROUPS) {
      const box = $(`#nav .navgroup[data-grp="${name}"]`); if (!box) continue;
      const isFolded = fold.has(name), shown = views.filter(v => !hid.has(v));
      box.classList.toggle('folded', isFolded);
      $('.ng-tw', box).textContent = isFolded ? '▸' : '▾';
      $('.ng-n', box).textContent = shown.length;
      for (const v of views) {
        const el = v === 'dashboard' ? $('#nav [data-view="dashboard"]')?.closest('.navrow') || $('#nav [data-view="dashboard"]') : $(`#nav [data-view="${v}"]`);
        if (el) el.hidden = hid.has(v) || (isFolded && v !== active); // a folded group still shows the page you are on
      }
      box.hidden = !shown.length;
    }
  },
  togglePage(v) {
    const h = this.hidden(); h.has(v) ? h.delete(v) : h.add(v);
    if (h.size >= this.pages().length) return toast('Keep at least one page in the sidebar', true);
    this.store('navHidden', [...h]); this.applyNav();
  },

  // ---- the menus ----
  recentConns(test) {
    return S.entries.filter(e => e.last_used && test(e)).sort((a, b) => new Date(b.last_used) - new Date(a.last_used)).slice(0, 10);
  },
  connName: e => `${e.env ? e.env + ' · ' : ''}${(canDB(e) ? dbLabel(e) : e.name || e.host).replace(/<[^>]*>/g, '')}`,
  menus() {
    const click = id => () => $(id)?.click();
    const go = v => () => show(v);
    const sess = openSessions(), open = sess.ssh.length + sess.ftp + sess.sql;
    const last = S.settings.last_session, lastN = last ? (last.ssh?.length || 0) + (last.sql?.length || 0) : 0;
    const theme = typeof Theme !== 'undefined' ? Theme.pref() : 'auto';
    const hid = this.hidden();
    return {
      File: [
        ['+ New connection…', () => openEntryDialog(null)],
        ['+ New thread…', async () => { show('tasks'); await Work.create(); }],
        ['+ New note', () => { show('notes'); $('#newNote')?.click(); }],
        ['+ New API request', () => { show('api'); Api.edit(Api.blank()); }],
        '-',
        ['⬇ Import', null, [
          ['Connections from DBeaver / PuTTY / FileZilla / SQL Developer…', () => ConnImport.open()],
          '-',
          ['WorkHub data (an older data folder)…', click('#importBtn')],
          ['Postman collection / environment…', () => { show('api'); $('#apiImportFiles').click(); }],
          ['Bruno collection folder…', () => { show('api'); $('#apiImportFolder').click(); }],
        ]],
        ['🛟 Backups…', click('#backupBtn')],
        ['📁 Data folder', () => DataDir.open()],
        '-',
        ['🔒 Lock\tCtrl+L', click('#lockBtn')],
        ['Quit WorkHub', click('#quitBtn')],
      ],
      Edit: [
        ['🔎 Search everything\tCtrl+K', () => { $('#search').focus(); $('#search').select(); }],
        ['⌘ Command palette…\tCtrl+Shift+P', () => Palette.open()],
        ['🔑 Change a password everywhere…', () => PwAll.open()],
        ['🏷 Naming rules…', () => openNameRules()],
        '-',
        ['⚙ Settings…', () => Settings.open()],
      ],
      View: [
        ['Go to', null, PAGE_GROUPS.flatMap(([g, ic, , , vs], i) => [...(i ? ['-'] : []), ...vs.map(v => [`${$('.view.active')?.id === 'view-' + v ? '● ' : ''}${ic} ${this.label(v)}`, go(v)])])],
        ['Pages in the sidebar', null, PAGE_GROUPS.flatMap(([g, ic, , , vs], i) => [...(i ? ['-'] : []), ...vs.map(v => [`${hid.has(v) ? '☐' : '☑'} ${this.label(v)}  — ${ic} ${g}`, () => this.togglePage(v)])])],
        '-',
        ['⧉ Open this page in a new window', () => Popout.popPage($('.view.active')?.id.replace('view-', '') || 'dashboard')],
        [`${document.body.classList.contains('side-collapsed') ? 'Show' : 'Hide'} the sidebar\tCtrl+B`, () => toggleSide()],
        [`Sidebar on the ${document.body.classList.contains('side-top') ? 'left' : 'top'}`, () => $('#sideFlip')?.click()],
        ['Theme', null, [['auto', 'Follow Windows'], ['light', 'Light'], ['dark', 'Dark']].map(([k, l]) => [`${theme === k ? '● ' : ''}${l}`, () => Theme.set(k)])],
        '-',
        ['✨ What\'s new', click('#whatsNewBtn')],
      ],
      Connect: [
        ['▶ Quick connect (user@host)…', () => { show('terminal'); setTimeout(() => $('#qcHost')?.focus(), 50); }],
        ['Recent', null, this.recentConns(isConn).map(e => [this.connName(e), () => connectEntry(e)]).concat(this.recentConns(isConn).length ? [] : [['(none yet)', null]])],
        '-',
        [`↺ Reopen last session${lastN ? ` (${lastN})` : ''}`, last && (lastN || last.thread) ? () => Session.restore(last) : null],
        [`⏏ Disconnect all${open ? ` (${open})` : ''}`, open ? () => disconnectAll() : null],
        '-',
        [`${S.settings.watch ? '☑' : '☐'} Watch clipboard`, () => $('#watchToggle').click()],
      ],
      Tools: [
        ['⇆ Compare files or folders…', () => { show('ref'); Compare.chooser(); }],
        ['📜 Tail a log', null, [...this.recentConns(canSSH).map(e => [this.connName(e), () => LogView.open(e)]), ...(this.recentConns(canSSH).length ? ['-'] : []), ['Choose a server in SSH…', go('terminal')]]],
        ['🌐 API requests', go('api')],
        ['🔑 My SSH keys (copy for GitHub)…', () => SSHKeys.open()],
        '-',
        ['↗ Programs for “Open in”…', () => External.settings()],
        ['📌 Install for easy access…', () => this.install()],
      ],
      Help: [
        ['❓ Help\tF1', () => Help.open()],
        ['⌨ Keyboard shortcuts\t?', () => Keys.open()],
        ['💬 Ask the assistant\tCtrl+J', () => Chat.toggle(true)],
        ['✨ What\'s new', click('#whatsNewBtn')],
        '-',
        [Update.ready?.() ? `↻ Restart to finish updating to ${Update.info.latest}` : Update.info?.newer ? `⬆ Install WorkHub ${Update.info.latest}…` : '⟳ Check for updates', () => Update.info?.newer ? Update.show() : Update.check(true)],
        [`About — ${$('#appVersion')?.textContent || 'WorkHub'}`, () => Settings.open()],
      ],
    };
  },

  // Tools → Install: Settings at "This PC", with the Install button highlighted.
  async install() {
    const inst = await api('GET', '/api/install').catch(() => ({}));
    if (!inst.supported) return toast('Install for easy access is for the Windows versions of WorkHub', true);
    await Settings.open();
    const b = $('#settingsBody [data-set="install"]'), row = b?.closest('.set-row') || $('#settingsBody .set-row');
    row?.scrollIntoView({ block: 'center' });
    if (b) { b.classList.add('flash'); setTimeout(() => b.classList.remove('flash'), 2400); b.focus(); }
    else toast(`Already installed in ${inst.target} — it is in the Start menu (type “WorkHub”)`);
  },

  openMenu(name, btn) {
    this.cur = name;
    $$('#menubar .mb').forEach(b => b.classList.toggle('on', b.dataset.menu === name));
    const r = btn.getBoundingClientRect();
    Tree.showMenu({ clientX: r.left, clientY: r.bottom + 2 }, this.menus()[name]);
    $('#ctxMenu').classList.add('mbmenu');
  },
  close() { this.cur = null; $$('#menubar .mb').forEach(b => b.classList.remove('on')); $('#ctxMenu')?.classList.remove('mbmenu'); },

  build() {
    const bar = document.createElement('nav');
    bar.id = 'menubar'; bar.className = 'menubar';
    bar.innerHTML = ['File', 'Edit', 'View', 'Connect', 'Tools', 'Help'].map(n => `<button class="mb" data-menu="${n}" title="Alt+${n[0]}"><u>${n[0]}</u>${n.slice(1)}</button>`).join('');
    $('header.appbar')?.prepend(bar);
    bar.addEventListener('click', e => {
      const b = e.target.closest('.mb'); if (!b) return;
      e.stopPropagation();
      if (this.cur === b.dataset.menu && !$('#ctxMenu').hidden) { $('#ctxMenu').hidden = true; return this.close(); }
      this.openMenu(b.dataset.menu, b);
    });
    // moving across the bar while a menu is open switches menus, like a desktop app
    bar.addEventListener('mouseover', e => { const b = e.target.closest('.mb'); if (b && this.cur && this.cur !== b.dataset.menu && !$('#ctxMenu').hidden) this.openMenu(b.dataset.menu, b); });
    new MutationObserver(() => { if ($('#ctxMenu').hidden && this.cur) this.close(); }).observe($('#ctxMenu'), { attributes: true, attributeFilter: ['hidden'] });
    document.addEventListener('keydown', e => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const t = e.target;
      if (t.closest?.('input, textarea, select, [contenteditable="true"], .CodeMirror, .xterm, .termhost')) return; // Alt keys belong there
      const name = { f: 'File', e: 'Edit', v: 'View', c: 'Connect', t: 'Tools', h: 'Help' }[e.key.toLowerCase()];
      if (!name) return;
      e.preventDefault();
      this.openMenu(name, $(`#menubar [data-menu="${name}"]`));
    });
    // ☰ (top of the sidebar): the same menus, one level down
    const mm = $('#mainMenuBtn');
    if (mm) {
      const fresh = mm.cloneNode(true); mm.replaceWith(fresh); // drop the old ☰ list
      fresh.title = 'Menu (the same as the menu bar)';
      fresh.onclick = () => {
        const r = fresh.getBoundingClientRect(), m = this.menus();
        setTimeout(() => Tree.showMenu({ clientX: r.left, clientY: r.bottom + 4 }, Object.entries(m).map(([k, items]) => [k, null, items])));
      };
    }
  },
};

// Shortcut text on the right of a menu item: "Label\tCtrl+K".
{
  const orig = Tree.showMenu.bind(Tree);
  Tree.showMenu = (ev, items) => {
    orig(ev, items);
    $$('#ctxMenu button').forEach(b => {
      const i = b.innerHTML.indexOf('\t');
      if (i > 0 && !b.querySelector('.ctxkey')) b.innerHTML = `<span>${b.innerHTML.slice(0, i)}</span><span class="ctxkey">${b.innerHTML.slice(i + 1)}</span>`;
    });
  };
}

Menubar.build();
Menubar.regroup();
// the page you are on stays visible inside a folded group
{ const s = show; window.show = v => { s(v); Menubar.applyNav(); }; }
