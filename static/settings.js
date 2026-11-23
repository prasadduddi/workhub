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
    $('#settingsBody').innerHTML = `
      ${inst.supported ? `<h4>This PC</h4>
      ${inst.installed
        ? row('📌 Installed for easy access', `In <code class="set-path">${esc(inst.target)}</code>${inst.start_menu ? ' · in the Start menu (type “WorkHub” in Start; right-click → Pin to taskbar)' : ''}`, '')
        : row('📌 Install for easy access', `Running from <code class="set-path">${esc(inst.exe)}</code>. Install copies WorkHub to your own programs folder (safe from Downloads clean-ups), adds it to the Start menu and restarts it from there. Your data stays where it is.`, btn('install', 'Install', 'primary'))}
      ${row('Desktop shortcut', '', sw('inst-desktop', inst.desktop))}
      ${row('Start with Windows', 'Opens when you sign in' + (window.WH_DESKTOP ? ' (with the tray, it waits there)' : ''), sw('inst-startup', inst.startup))}` : ''}
      <h4>Appearance</h4>
      ${row('Theme', '', sel('theme', Theme.pref(), [['auto', 'Follow Windows'], ['light', 'Light'], ['dark', 'Dark']]))}
      ${row('Menu position', 'The pages menu on the left, or across the top', sel('menu', document.body.classList.contains('side-top') ? 'top' : 'left', [['left', 'Left'], ['top', 'Top']]))}
      <h4>You &amp; security</h4>
      ${row('👤 Your profile', 'Name, email (where recovery codes are sent), team', btn('profile', 'Edit…'))}
      ${row('🔒 PIN lock', lock.enabled ? `On — locks after ${lock.minutes ? lock.minutes + ' idle minutes' : 'start-up and Lock now only'}` : 'Off — set a PIN to lock WorkHub when you step away', btn('pin', lock.enabled ? 'Change…' : 'Set up…'))}
      ${row('🔐 Master password', master.on ? 'On — asked the first time each new version starts' : 'Off — protects your data if the data folder is copied', btn('master', master.on ? 'Change…' : 'Turn on…'))}
      <h4>Data</h4>
      ${row('📁 Data folder', `<code class="set-path">${esc(S.dataDir || '')}</code>`, btn('dataopen', 'Open') + btn('datacopy', 'Copy path') + btn('dataloc', 'Change…'))}
      ${row('🛟 Backups', `${latest ? 'Latest ' + esc(fmtDateTime(latest.when)) : 'None yet'}${backups.copy_to ? ` · also copied to <code class="set-path">${esc(backups.copy_to)}</code>` : ''}`, btn('backups', 'Manage…'))}
      ${row('📸 Capture screenshots', 'Pictures you copy (Win+Shift+S, PrtScn) go into the capture thread — General, a thread with 📥 Capture here, or the one for a Jira key', sw('shots', !S.settings.no_shots))}
      ${row('📝 Save SSH session text', 'Keep what each terminal shows, per server and day, searchable', sw('slog', !!S.settings.session_log) + btn('slogopen', 'Logs…'))}
      ${row('Import data', 'From an older WorkHub data folder or a file', btn('import', 'Import…'))}
      ${row('⬇ Download updates in the background', 'New versions are fetched quietly and wait — nothing is installed until you click ⬆ in the sidebar', sw('updfetch', !S.settings.no_update_fetch))}
      <h4>Programs</h4>
      ${row('↗ Programs for “Open in”', 'PuTTY, FileZilla, SQL Developer, DBeaver…', btn('ext', 'Choose…'))}
      ${window.WH_DESKTOP ? `<h4>Desktop window</h4>${row('Close button keeps WorkHub running', 'In the tray by the clock — capture, tunnels and transfers carry on', sw('tray', Tray.on()))}` : ''}
      <div class="muted tiny set-ver">WorkHub ${esc($('#appVersion')?.textContent || '')}</div>`;
  },
};

$('#settingsBody').addEventListener('click', async e => {
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
  }
});
Settings.install = async () => {
  const removeOld = !!Settings.inst && !Settings.inst.installed;
  const desktop = $('[data-set="inst-desktop"]')?.checked, startup = $('[data-set="inst-startup"]')?.checked;
  if (removeOld && !confirm(`Install WorkHub for easy access?\n\n• Copies it to ${Settings.inst.target}\n• Adds WorkHub to the Start menu${desktop ? ' and the Desktop' : ''}${startup ? '\n• Starts it when you sign in to Windows' : ''}\n• Restarts WorkHub from there and deletes the copy in\n  ${Settings.inst.exe}\n\nOpen sessions (SSH, FTP, SQL) close. Your data is not moved.`)) return Settings.render();
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
    case 'menu': if ((t.value === 'top') !== document.body.classList.contains('side-top')) $('#sideFlip').click(); break;
    case 'slog': await saveSettings({ session_log: t.checked }); toast(t.checked ? 'SSH sessions you open from now on are saved' : 'SSH sessions are no longer saved'); break;
    case 'tray': Tray.set(t.checked); break;
    case 'updfetch': await saveSettings({ no_update_fetch: !t.checked }); toast(t.checked ? 'New versions download in the background — you choose when to install' : 'New versions are no longer downloaded until you ask'); break;
    case 'shots': await saveSettings({ no_shots: !t.checked }); toast(t.checked ? 'Copied screenshots go into the capture thread' : 'Screenshots are no longer captured'); break;
    case 'inst-desktop': case 'inst-startup': if (Settings.inst?.installed) Settings.install(); break; // not installed yet: used by Install
  }
});
$('#settingsClose').onclick = () => $('#settingsDlg').close();
// dialogs opened from Settings come back to an up-to-date Settings
for (const id of ['#masterDlg', '#pinDlg', '#profileDlg', '#backupDlg', '#slogDlg'])
  $(id)?.addEventListener('close', () => { if ($('#settingsDlg').open) Settings.render(); });
