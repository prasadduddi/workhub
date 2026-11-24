'use strict';
// "A new version is available": checked quietly after start-up (WorkHub also
// downloads it in the background, without installing) and from ⟳ Check for updates. Updating replaces WorkHub's exe; you choose to restart
// now or let the new version start next time. Your data folder is not touched.

const Update = {
  info: null,
  skipped() { try { return localStorage.getItem('skipUpdate') || ''; } catch { return ''; } },

  async check(manual) {
    const r = await api('GET', '/api/update' + (manual ? '?force=1' : '')).catch(err => ({ error: err.message }));
    this.info = r;
    if (r.error) { if (manual) this.show(); return; }
    $('#updPill').hidden = !r.newer; // stays visible even after "Later" / "Skip"
    if (r.newer) $('#updPillText').textContent = this.ready() ? `WorkHub ${r.latest} — restart to finish` : r.downloaded === r.latest ? `WorkHub ${r.latest} downloaded — install` : `WorkHub ${r.latest} — install`;
    if (manual) return this.show();
    // Checking by itself is silent: no pop-up, just the pill — and one note when
    // a new version has been downloaded in the background (not installed).
    if (r.newer && r.downloaded === r.latest && !this.ready() && this.skipped() !== r.latest) {
      let told = ''; try { told = localStorage.getItem('updTold') || ''; } catch { /* ignore */ }
      if (told !== r.latest) {
        toast(`WorkHub ${r.latest} is downloaded — click ⬆ in the sidebar to install it when it suits you`);
        try { localStorage.setItem('updTold', r.latest); } catch { /* ignore */ }
      }
    }
  },

  // the latest version is already installed and starts next time
  ready() { const r = this.info || {}; return !!r.newer && r.pending === r.latest; },

  show() {
    const r = this.info || {};
    let html;
    this.asking = false;
    $('#updNow').textContent = 'Update now';
    $('#updNext').hidden = true;
    if (this.ready()) {
      $('#updBody').innerHTML = `<p>✅ <b>WorkHub ${esc(r.latest)}</b> is installed.</p><p class="muted tiny">It starts the next time you open WorkHub. Restart now to use it straight away.</p>`;
      $('#updNow').textContent = '↻ Restart now';
      $('#updNow').hidden = false;
      $('#updSkip').hidden = $('#updPage').hidden = true;
      $('#updLater').textContent = 'Close';
      if (!$('#updDlg').open) $('#updDlg').showModal();
      return;
    }
    if (r.error) {
      html = `<p>Couldn't check for a new version.</p><p class="muted tiny">${esc(r.error)}</p>`;
    } else if (!r.newer) {
      html = `<p>✅ You have the latest version${r.current === 'dev' ? ' (a development build)' : ''}.</p><p class="muted tiny">This version: ${esc(r.current)} · latest release: ${esc(r.latest || '?')}</p>`;
    } else {
      html = `<p><b>WorkHub ${esc(r.latest)}</b> is ${r.downloaded === r.latest ? 'downloaded and ready to install' : 'available'} — you have ${esc(r.current)}.</p>
        <p class="muted tiny">Released ${esc(new Date(r.published).toLocaleString())}${r.size ? ` · ${(r.size / 1048576).toFixed(1)} MB` : ''}. Your data and settings stay as they are.</p>
        ${r.notes ? `<details><summary>What's in it</summary><pre class="upd-notes">${esc(r.notes)}</pre></details>` : ''}`;
    }
    $('#updBody').innerHTML = html;
    $('#updNow').hidden = !(r.newer && r.can_apply);
    $('#updNow').textContent = r.downloaded === r.latest ? 'Install' : 'Update now';
    $('#updSkip').hidden = !r.newer;
    $('#updPage').hidden = !(r.newer || r.error);
    $('#updLater').textContent = r.newer ? 'Later' : 'Close';
    if (!$('#updDlg').open) $('#updDlg').showModal();
  },

  // "Update now": say WorkHub will restart, and let the user restart now or
  // have the new version start the next time WorkHub is opened.
  confirm() {
    const r = this.info || {};
    this.asking = true;
    $('#updBody').innerHTML = `<p>↻ <b>WorkHub will restart to finish updating to ${esc(r.latest)}.</b></p>
      <p class="muted tiny">Open SSH / FTP sessions, terminals and database connections will close. Your data and settings are saved first.</p>
      <p>Restart now, or update the next time you start WorkHub?</p>`;
    $('#updNow').textContent = '↻ Restart now';
    $('#updNext').hidden = false;
    $('#updSkip').hidden = $('#updPage').hidden = true;
    $('#updLater').textContent = 'Cancel';
  },

  restarting(v) {
    $('#updBody').innerHTML = `<p>✅ Updated to ${esc(v)} — WorkHub is restarting.</p><p class="muted tiny">A new WorkHub window or tab opens in a few seconds; you can close this one.</p>`;
    $('#updNow').hidden = $('#updNext').hidden = $('#updSkip').hidden = $('#updPage').hidden = true;
    $('#updLater').textContent = 'Close';
  },

  async apply(later) {
    this.asking = false;
    $('#updNow').disabled = $('#updNext').disabled = true;
    $('#updBody').innerHTML = `<p>${this.info?.downloaded === this.info?.latest ? '⬆ Installing' : '⬇ Downloading'} the new version…</p><p class="muted tiny">${later ? 'WorkHub keeps running; the new version starts next time.' : 'WorkHub restarts by itself when it is ready.'}</p>`;
    try {
      const r = await api('POST', '/api/update' + (later ? '?later=1' : ''));
      if (!later) return this.restarting(r.version);
      this.info.pending = r.version;
      $('#updPillText').textContent = `WorkHub ${r.version} — restart to finish`;
      $('#updDlg').close();
      toast(`WorkHub ${r.version} is installed — it starts the next time you open WorkHub`);
    } catch (err) {
      $('#updBody').innerHTML = `<p>Update failed.</p><p class="muted tiny">${esc(err.message)}</p>`;
      $('#updNow').hidden = $('#updNext').hidden = true;
      $('#updPage').hidden = false;
      $('#updLater').textContent = 'Close';
    } finally { $('#updNow').disabled = $('#updNext').disabled = false; }
  },

  async restartNow() {
    $('#updNow').disabled = true;
    try { this.restarting((await api('POST', '/api/update/restart')).version); }
    catch (err) { $('#updBody').innerHTML = `<p>Couldn't restart.</p><p class="muted tiny">${esc(err.message)} — close WorkHub and open it again.</p>`; }
    finally { $('#updNow').disabled = false; }
  },
};

$('#updBtn').onclick = () => Update.check(true);
$('#updPill').onclick = () => Update.show();
// ☰ at the top of the sidebar: the same actions as the buttons at its foot
// (which can be scrolled out of sight on small screens).
$('#mainMenuBtn').onclick = () => {
  const r = $('#mainMenuBtn').getBoundingClientRect(), click = id => () => $(id).click();
  setTimeout(() => Tree.showMenu({ clientX: r.left, clientY: r.bottom + 4 }, [
    [Update.ready() ? `↻ Restart to finish updating to ${Update.info.latest}` : Update.info?.newer ? `⬆ Install WorkHub ${Update.info.latest}…` : '⟳ Check for updates & install', () => Update.info?.newer ? Update.show() : Update.check(true)],
    ['❓ Help (F1)', () => Help.open()],
    ['💬 Ask the assistant (Ctrl+J)', () => Chat.toggle(true)],
    ["✨ What's new & tips", click('#whatsNewBtn')],
    '-',
    ...((o => o.ssh.length || o.ftp || o.sql ? [[`⏏ Disconnect all (${[o.ssh.length && o.ssh.length + ' SSH', o.ftp && o.ftp + ' FTP', o.sql && o.sql + ' SQL'].filter(Boolean).join(', ')})`, disconnectAll]] : [])(openSessions())),
    ['🔑 Change a password everywhere…', () => PwAll.open()],
    ...(S.sshKeysOff ? [] : [['🔑 My SSH keys (copy for GitHub)…', () => SSHKeys.open()]]),
    ['🔒 Lock (Ctrl+L)', click('#lockBtn')], '-',
    ['⚙ Settings…', () => Settings.open()], '-',
    ['↻ Restart WorkHub', () => restartApp()],
    ['Quit WorkHub', click('#quitBtn')]]));
};
$('#updNow').onclick = () => Update.ready() ? Update.restartNow() : Update.asking ? Update.apply(false) : Update.confirm();
$('#updNext').onclick = () => Update.apply(true);
$('#updLater').onclick = () => { Update.asking = false; $('#updDlg').close(); };
$('#updSkip').onclick = () => { try { localStorage.setItem('skipUpdate', Update.info?.latest || ''); } catch { /* ignore */ } $('#updDlg').close(); toast('You won\'t be asked about this version again (⟳ Check for updates still shows it)'); };
$('#updPage').onclick = () => openExternal(Update.info?.page || 'https://github.com/prasadduddi/workhub/releases/latest');
setTimeout(() => { if (!Lock.shown) Update.check(false); }, 8000);
setInterval(() => { if (!Lock.shown) Update.check(false); }, 15 * 60000); // picks up a background download

// Desktop version: the window's ✕ hides WorkHub to the tray (clipboard capture,
// tunnels and transfers carry on) unless this is switched off.
const Tray = {
  on() { try { return localStorage.getItem('closeToTray') !== '0'; } catch { return true; } },
  set(v) {
    try { localStorage.setItem('closeToTray', v ? '1' : '0'); } catch { /* private mode */ }
    window.whCloseToTray?.(v);
    toast(v ? 'Closing the window now keeps WorkHub running in the tray — right-click its icon to quit' : 'Closing the window now quits WorkHub');
  },
};
if (window.WH_DESKTOP) window.whCloseToTray?.(Tray.on());
