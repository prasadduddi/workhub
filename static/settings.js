'use strict';
// ⚙ Settings: everything that is set once and then left alone — look, you
// and security, where the data is, backups, session logs, programs and the
// desktop window. The ☰ menu keeps only everyday actions.

const Settings = {
  async open() {
    await this.render();
    if (!$('#settingsDlg').open) $('#settingsDlg').showModal();
  },

  async render() {
    const [lock, master, backups, inst] = await Promise.all([
      fetch('/api/lock').then(r => r.json()).catch(() => ({})),
      api('GET', '/api/master').catch(() => ({})),
      api('GET', '/api/backups').catch(() => ({})),
      api('GET', '/api/install').catch(() => ({})),
    ]);
    this.inst = inst;
    const row = (title, desc, ctl) => `<div class="set-row"><div class="set-txt"><b>${title}</b>${desc ? `<div class="muted tiny">${desc}</div>` : ''}</div><div class="set-ctl">${ctl}</div></div>`;
    const btn = (act, label, cls = '') => `<button type="button" class="${cls}" data-set="${act}">${label}</button>`;
    const sw = (act, on) => `<label class="switch small"><input type="checkbox" data-set="${act}" ${on ? 'checked' : ''}><span></span></label>`;
    const sel = (act, val, opts) => `<select data-set="${act}">${opts.map(([v, l]) => `<option value="${v}" ${v === val ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
    const latest = backups.backups?.[0];
    const teamsRows = typeof Teams !== 'undefined' ? await Teams.settingsHTML(row, btn) : [];
    const askRows = typeof Ask !== 'undefined' ? await Ask.settingsHTML(row, btn, sw, sel) : [];
    const ver = $('#appVersion')?.textContent || '';
    // One page per section, chosen on the left: a few related rows each, instead of one long list.
    const sections = [
      ['general', '⚙', 'General', [
        ...(inst.supported ? [inst.installed
          ? row('Installed for easy access', `In <code class="set-path">${esc(inst.target)}</code>${inst.start_menu ? ' · in the Start menu' : ''}`, '')
          : row('Install for easy access', 'Copies WorkHub to your programs folder and adds it to the Start menu. Your data stays where it is.', btn('install', 'Install', 'primary')),
          row('Start with Windows', 'Opens when you sign in', sw('inst-startup', inst.startup)),
          row('Desktop shortcut', '', sw('inst-desktop', inst.desktop))] : []),
        ...(window.WH_DESKTOP ? [row('Close button keeps WorkHub running', 'In the tray by the clock — capture, tunnels and transfers carry on', sw('tray', Tray.on()))] : []),
        row('Reopen last session', 'Offer to reopen your SSH, SQL tabs and thread when WorkHub starts', sw('reopen', !S.settings.no_reopen)),
        row('Check for new versions automatically', 'Asks GitHub about once an hour (sends only “WorkHub/version”). Off: only when you press ⟳ Check for updates', sw('updcheck', !S.settings.no_update_check)),
        row('Download updates in the background', 'Nothing is installed until you choose to', sw('updfetch', !S.settings.no_update_fetch)),
      ]],
      ['look', '🎨', 'Appearance', [
        row('Theme', '', sel('theme', Theme.pref(), [['auto', 'Follow Windows'], ['light', 'Light'], ['dark', 'Dark']])),
        row('Text size', 'Bigger text for small or high-resolution screens (terminal and editor: A− / A+ there)', sel('uiscale', String(Fonts.ui()), [['1.06', 'Small'], ['1.14', 'Normal'], ['1.22', 'Large'], ['1.32', 'Larger']])),
        row('Menu position', 'Pages on the left, or across the top', sel('menu', document.body.classList.contains('side-top') ? 'top' : 'left', [['left', 'Left'], ['top', 'Top']])),
      ]],
      ['capture', '📥', 'Capture', [
        row('Watch clipboard', 'Hosts, logins and links you copy are saved (also “● Capturing” at the top)', sw('watch', !!S.settings.watch)),
        row('Capture screenshots', 'Pictures you copy go into the capture thread', sw('shots', !S.settings.no_shots)),
        row('Keep clips with no info', 'Also keep copied text in which nothing was recognised', sw('capall', !!S.settings.capture_all)),
        row('Outlook monitoring', 'Capture details from mail sent by chosen senders', btn('mail', 'Open…')),
      ]],
      ['security', '🔒', 'Security', [
        row('Your profile', 'Name, email (where recovery codes are sent), team', btn('profile', 'Edit…')),
        row('PIN lock', lock.enabled ? `On — locks after ${lock.minutes ? lock.minutes + ' idle minutes' : 'start-up and Lock only'}` : 'Off — lock WorkHub when you step away', btn('pin', lock.enabled ? 'Change…' : 'Set up…')),
        row('Master password', master.on ? 'On' : 'Off — protects your data if the data folder is copied', btn('master', master.on ? 'Change…' : 'Turn on…')),
        row('Show my SSH keys', 'The 🔑 SSH keys window reads your public keys and ~/.ssh/config (read-only) — off: WorkHub never looks in ~/.ssh', sw('sshkeys', !S.sshKeysOff)),
      ]],
      ['data', '🗂', 'Data & backups', [
        row('Data folder', `<code class="set-path">${esc(S.dataDir || '')}</code>`, btn('dataopen', 'Open') + btn('datacopy', 'Copy path') + btn('dataloc', 'Change…')),
        row('Backups', `${latest ? 'Latest ' + esc(fmtDateTime(latest.when)) : 'None yet'}${backups.copy_to ? ` · also copied to <code class="set-path">${esc(backups.copy_to)}</code>` : ''}`, btn('backups', 'Manage…')),
        row('Save SSH session text', 'What each terminal shows, per server and day, searchable', sw('slog', !!S.settings.session_log) + btn('slogopen', 'Logs…')),
        row('Import data', 'From an older WorkHub data folder or a file', btn('import', 'Import…')),
      ]],
      ['connections', '🏷', 'Connections', [
        row('Naming rules', 'Name servers and links by what their host name contains (e.g. -BAT- → Batch); this workspace only', btn('namerules', 'Edit…')),
      ]],
      ['ask', '🔎', 'Ask (Confluence)', askRows],
      ['teams', '💬', 'Teams', teamsRows],
      ['programs', '↗', 'Programs', [
        row('Programs for “Open in”', 'PuTTY, FileZilla, SQL Developer, DBeaver…', btn('ext', 'Choose…')),
      ]],
      ['about', 'ℹ', 'About', [
        row('Version', esc(ver.replace(/^Version\s*/, '')) || '—', btn('updcheck', 'Check for updates')),
        row('What’s new & tips', '', btn('whatsnew', 'Open…')),
      ]],
    ];
    if (!sections.some(x => x[0] === this.tab)) this.tab = 'general';
    $('#settingsBody').innerHTML = `<div class="set-layout"><nav class="set-tabs">${sections.map(([k, ic, name]) => `<button type="button" data-settab="${k}" class="${k === this.tab ? 'on' : ''}"><span class="set-ic">${ic}</span>${name}</button>`).join('')}</nav>
      <div class="set-pane">${sections.map(([k, , name, rows]) => `<section data-setpane="${k}" ${k === this.tab ? '' : 'hidden'}><h4>${name}</h4>${rows.join('')}</section>`).join('')}</div></div>`;
  },
};

$('#settingsBody').addEventListener('click', async e => {
  const tab = e.target.closest('[data-settab]');
  if (tab) { // switch section without asking the server again
    Settings.tab = tab.dataset.settab;
    $$('#settingsBody [data-settab]').forEach(x => x.classList.toggle('on', x === tab));
    $$('#settingsBody [data-setpane]').forEach(x => { x.hidden = x.dataset.setpane !== Settings.tab; });
    return;
  }
  const b = e.target.closest('button[data-set]'); if (!b) return;
  const click = id => $(id).click();
  switch (b.dataset.set) {
    case 'profile': click('#profileBtn'); break;
    case 'pin': Lock.settings(); break;
    case 'master': Master.open(); break;
    case 'dataopen': DataDir.open(); break;
    case 'datacopy': copyText(S.dataDir, 'Data folder path copied'); break;
    case 'dataloc': $('#settingsDlg').close(); click('#dataLocBtn'); break;
    case 'backups': click('#backupBtn'); break;
    case 'slogopen': SessionLogs.open(); break;
    case 'import': $('#settingsDlg').close(); click('#importBtn'); break;
    case 'ext': click('#extBtn'); break;
    case 'install': Settings.install(); break;
    case 'mail': $('#settingsDlg').close(); show('inbox'); $('#mailPanel').open = true; break;
    case 'namerules': openNameRules(); break;
    case 'teams-signin': {
      try {
        const r = await api('POST', '/api/teams/signin');
        if (r.verify) (typeof openExternal === 'function' ? openExternal : u => window.open(u, '_blank'))(r.verify);
        toast(`Enter the code ${r.user_code} on the Microsoft page that opened`);
        Settings.tab = 'teams'; await Settings.render();
        const poll = setInterval(async () => { // until the sign-in is done (or the window is closed)
          const st = await Teams.status(true);
          if (st.pending !== 'waiting' || !$('#settingsDlg').open) { clearInterval(poll); if ($('#settingsDlg').open) Settings.render(); if (st.signed_in) toast(`Signed in to Teams as ${st.user}`); }
        }, 2000);
      } catch (err) { toast(err.message, true); }
      break;
    }
    case 'teams-signout': await api('POST', '/api/teams/signout'); Settings.render(); toast('Signed out of Teams'); break;
    case 'updcheck': $('#settingsDlg').close(); Update.check(true); break;
    case 'whatsnew': $('#settingsDlg').close(); click('#whatsNewBtn'); break;
  }
});
Settings.install = async () => {
  const removeOld = !!Settings.inst && !Settings.inst.installed;
  const desktop = $('[data-set="inst-desktop"]')?.checked, startup = $('[data-set="inst-startup"]')?.checked;
  if (removeOld && !await askYes(`Install WorkHub for easy access?\n\n• Copies it to ${Settings.inst.target}\n• Adds WorkHub to the Start menu${desktop ? ' and the Desktop' : ''}${startup ? '\n• Starts it when you sign in to Windows' : ''}\n• Restarts WorkHub from there and deletes the copy in\n  ${Settings.inst.exe}\n\nOpen sessions (SSH, FTP, SQL) close. Your data is not moved.`)) return Settings.render();
  try {
    const r = await api('POST', '/api/install', { desktop, startup, removeold: removeOld });
    if (r.moved) {
      $('#settingsBody').innerHTML = '<p>✅ Installed. WorkHub is restarting from its new place — a new window opens in a few seconds; you can close this one.</p><p class="muted tiny">Next time, start it from the Start menu: type “WorkHub”. To pin it: right-click it there → Pin to taskbar.</p>';
      return;
    }
    toast('Shortcuts updated');
  } catch (err) { toast(err.message, true); }
  Settings.render();
};
$('#settingsBody').addEventListener('change', async e => {
  const t = e.target.closest('[data-set]'); if (!t) return;
  switch (t.dataset.set) {
    case 'theme': Theme.set(t.value); break;
    case 'uiscale': Fonts.setUI(+t.value); break;
    case 'menu': if ((t.value === 'top') !== document.body.classList.contains('side-top')) $('#sideFlip').click(); break;
    case 'slog': await saveSettings({ session_log: t.checked }); toast(t.checked ? 'SSH sessions you open from now on are saved' : 'SSH sessions are no longer saved'); break;
    case 'tray': Tray.set(t.checked); break;
    case 'reopen': await saveSettings({ no_reopen: !t.checked }); toast(t.checked ? 'You will be offered to reopen your last session' : 'The last session is no longer offered at start (an update still reopens it)'); break;
    case 'updcheck': await saveSettings({ no_update_check: !t.checked }); toast(t.checked ? 'WorkHub checks for new versions by itself again' : 'No automatic update checks — press ⟳ Check for updates when you want'); break;
    case 'updfetch': await saveSettings({ no_update_fetch: !t.checked }); toast(t.checked ? 'New versions download in the background — you choose when to install' : 'New versions are no longer downloaded until you ask'); break;
    case 'watch': if ($('#watchToggle').checked !== t.checked) $('#watchToggle').click(); break; // same as ● Capturing at the top
    case 'capall': await saveSettings({ capture_all: t.checked }); break;
    case 'teams-tenant': case 'teams-client':
      await api('PUT', '/api/teams/config', { tenant: $('[data-set="teams-tenant"]').value, client_id: $('[data-set="teams-client"]').value });
      toast('Teams details saved — now Sign in'); Settings.render(); break;
    case 'sshkeys': await saveSettings({ ssh_keys: t.checked }); await poll(); toast(t.checked ? '🔑 SSH keys window on — Tools → My SSH keys' : 'SSH keys window off — ~/.ssh is not read'); break;
    case 'shots': await saveSettings({ no_shots: !t.checked }); toast(t.checked ? 'Copied screenshots go into the capture thread' : 'Screenshots are no longer captured'); break;
    case 'inst-desktop': case 'inst-startup': if (Settings.inst?.installed) Settings.install(); break; // not installed yet: used by Install
  }
});
$('#settingsClose').onclick = () => $('#settingsDlg').close();
// dialogs opened from Settings come back to an up-to-date Settings
for (const id of ['#masterDlg', '#pinDlg', '#profileDlg', '#backupDlg', '#slogDlg'])
  $(id)?.addEventListener('close', () => { if ($('#settingsDlg').open) Settings.render(); });

$('#settingsBody').addEventListener('click', e => { const v = e.target.closest('[data-teamsverify]'); if (v) { e.preventDefault(); (typeof openExternal === 'function' ? openExternal : u => window.open(u, '_blank'))(v.textContent); } });
