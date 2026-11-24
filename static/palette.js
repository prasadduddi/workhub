'use strict';
// Ctrl+Shift+P (or Ctrl+P): the command palette. Type to find any menu action,
// page, connection, thread or saved API request; Enter runs it. What you pick
// often comes first.

const Palette = {
  sel: 0, list: [],
  used() { try { return JSON.parse(localStorage.getItem('paletteUsed') || '{}'); } catch { return {}; } },
  bump(id) { const u = this.used(); u[id] = (u[id] || 0) + 1; try { localStorage.setItem('paletteUsed', JSON.stringify(u)); } catch { /* ignore */ } },

  // Everything that can be run: [id, icon, label, detail, fn]
  items() {
    const out = [];
    const walk = (items, path) => {
      for (const it of items || []) {
        if (it === '-' || !it) continue;
        const label = it[0].replace(/\t.*$/, '').replace(/^[●☑☐]\s*/, '');
        if (it[2]) walk(it[2], [...path, label]);
        else if (it[1]) out.push([`menu:${[...path, label].join('›')}`, '▸', [...path, label].join(' › '), (it[0].split('\t')[1] || ''), it[1]]);
      }
    };
    for (const [name, items] of Object.entries(Menubar.menus())) {
      if (name === 'View') walk(items.filter(i => i !== '-' && !/^Go to$/.test(i[0])), [name]); // pages are listed below
      else walk(items, [name]);
    }
    for (const v of Menubar.pages()) out.push([`page:${v}`, '📄', `Go to ${Menubar.label(v)}`, 'page', () => show(v)]);
    for (const e of S.entries.filter(isConn)) { // UAT / PROD only when picked at the top (S.entries follows the switch)
      const what = canDB(e) ? 'SQL' : canFiles(e) && !canSSH(e) ? 'FTP' : 'SSH';
      out.push([`conn:${e.id}`, canDB(e) ? '🛢' : '🖥', `${what}: ${(canDB(e) ? dbLabel(e) : e.name || e.host).replace(/<[^>]*>/g, '')}`, [e.env, e.username ? e.username + '@' + e.host : e.host].filter(Boolean).join(' · '), () => connectEntry(e)]);
    }
    if (typeof Work !== 'undefined') for (const w of Work.list.filter(w => !w.archived)) out.push([`thread:${w.id}`, '🧵', `Thread: ${w.title}`, w.jira || '', () => { show('tasks'); Work.open(w.id); }]);
    if (typeof Api !== 'undefined') for (const r of Api.reqs || []) out.push([`api:${r.id}`, '🌐', `API: ${r.method} ${r.name}`, r.folder || '', () => { show('api'); Api.edit(r); }]);
    return out;
  },

  // every word must be found in the label or detail (in any order); a word
  // that starts a label word scores higher; often-used first.
  rank(q) {
    const used = this.used(), words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return this.all.map(it => {
      const hay = (it[2] + ' ' + it[3]).toLowerCase();
      let score = 0;
      for (const w of words) {
        const i = hay.indexOf(w);
        if (i < 0) return null;
        score += i === 0 ? 30 : /[\s:›/@.-]/.test(hay[i - 1]) ? 15 : 3;
      }
      return [it, score + Math.min(used[it[0]] || 0, 20) * 4 + (it[0].startsWith('menu:') ? 2 : 0)];
    }).filter(Boolean).sort((a, b) => b[1] - a[1]).slice(0, 60).map(x => x[0]);
  },

  open() {
    let d = $('#paletteDlg');
    if (!d) {
      d = Object.assign(document.createElement('dialog'), { id: 'paletteDlg', className: 'palettedlg' });
      d.innerHTML = `<input id="palIn" placeholder="Type a command, page, server, database, thread or API request…" autocomplete="off" spellcheck="false"><div id="palList" class="pal-list"></div>
        <div class="pal-foot muted tiny"><kbd>↑</kbd><kbd>↓</kbd> choose · <kbd>Enter</kbd> run · <kbd>Esc</kbd> close · <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> anywhere</div>`;
      document.body.append(d);
      $('#palIn').addEventListener('input', () => { this.sel = 0; this.render(); });
      $('#palIn').addEventListener('keydown', e => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); this.sel = Math.max(0, Math.min(this.list.length - 1, this.sel + (e.key === 'ArrowDown' ? 1 : -1))); this.render(true); }
        else if (e.key === 'Enter') { e.preventDefault(); this.run(this.list[this.sel]); }
      });
      $('#palList').addEventListener('click', e => { const r = e.target.closest('[data-pi]'); if (r) this.run(this.list[+r.dataset.pi]); });
      d.addEventListener('click', e => { if (e.target === d) d.close(); });
    }
    this.all = this.items();
    $('#palIn').value = ''; this.sel = 0; this.render();
    if (!d.open) d.showModal();
    $('#palIn').focus();
  },
  render(keep) {
    const q = $('#palIn').value.trim();
    this.list = q ? this.rank(q) : this.recent();
    $('#palList').innerHTML = this.list.map((it, i) => `<div class="pal-row ${i === this.sel ? 'sel' : ''}" data-pi="${i}"><span class="pal-ic">${it[1]}</span><span class="pal-t">${esc(it[2])}</span><span class="pal-d muted tiny">${esc(it[3])}</span></div>`).join('')
      || `<div class="empty">${q ? 'Nothing matches.' : 'Start typing…'}</div>`;
    if (keep) $('#palList .pal-row.sel')?.scrollIntoView({ block: 'nearest' });
  },
  // nothing typed yet: what you use most
  recent() {
    const used = this.used();
    return this.all.filter(it => used[it[0]]).sort((a, b) => used[b[0]] - used[a[0]]).slice(0, 12);
  },
  run(it) {
    if (!it) return;
    $('#paletteDlg').close();
    this.bump(it[0]);
    setTimeout(() => it[4](), 0);
  },
};

document.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== 'p') return;
  if (e.target.closest?.('.xterm, .CodeMirror')) return; // Ctrl+P belongs to the terminal and editors (Ctrl+Shift+P still opens it)
  e.preventDefault();
  Palette.open();
}, true);
// Ctrl+Shift+P also from inside terminals and editors
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'p' && e.target.closest?.('.xterm, .CodeMirror')) { e.preventDefault(); e.stopPropagation(); Palette.open(); }
}, true);
