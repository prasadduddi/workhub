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
    const [lock, master, backups] = await Promise.all([
      fetch('/api/lock').then(r => r.json()).catch(() => ({})),
      api('GET', '/api/master').catch(() => ({})),
      api('GET', '/api/backups').catch(() => ({})),
    ]);
    const row = (title, desc, ctl) => `<div class="set-row"><div class="set-txt"><b>${title}</b>${desc ? `<div class="muted tiny">${desc}</div>` : ''}</div><div class="set-ctl">${ctl}</div></div>`;
    const btn = (act, label, cls = '') => `<button type="button" class="${cls}" data-set="${act}">${label}</button>`;
    const sw = (act, on) => `<label class="switch small"><input type="checkbox" data-set="${act}" ${on ? 'checked' : ''}><span></span></label>`;
    const sel = (act, val, opts) => `<select data-set="${act}">${opts.map(([v, l]) => `<option value="${v}" ${v === val ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
    const latest = backups.backups?.[0];
    $('#settingsBody').innerHTML = `
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
      ${row('📝 Save SSH session text', 'Keep what each terminal shows, per server and day, searchable', sw('slog', !!S.settings.session_log) + btn('slogopen', 'Logs…'))}
      ${row('Import data', 'From an older WorkHub data folder or a file', btn('import', 'Import…'))}
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
  }
});
$('#settingsBody').addEventListener('change', async e => {
  const t = e.target.closest('[data-set]'); if (!t) return;
  switch (t.dataset.set) {
    case 'theme': Theme.set(t.value); break;
    case 'menu': if ((t.value === 'top') !== document.body.classList.contains('side-top')) $('#sideFlip').click(); break;
    case 'slog': await saveSettings({ session_log: t.checked }); toast(t.checked ? 'SSH sessions you open from now on are saved' : 'SSH sessions are no longer saved'); break;
    case 'tray': Tray.set(t.checked); break;
  }
});
$('#settingsClose').onclick = () => $('#settingsDlg').close();
// dialogs opened from Settings come back to an up-to-date Settings
for (const id of ['#masterDlg', '#pinDlg', '#profileDlg', '#backupDlg', '#slogDlg'])
  $(id)?.addEventListener('close', () => { if ($('#settingsDlg').open) Settings.render(); });
