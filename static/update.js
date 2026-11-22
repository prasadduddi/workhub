'use strict';
// "A new version is available": checked a few seconds after start-up and from
// ⟳ Check for updates. Updating replaces WorkHub's exe and restarts it; your
// data folder is not touched.

const Update = {
  info: null,
  skipped() { try { return localStorage.getItem('skipUpdate') || ''; } catch { return ''; } },

  async check(manual) {
    const r = await api('GET', '/api/update' + (manual ? '?force=1' : '')).catch(err => ({ error: err.message }));
    this.info = r;
    if (r.error) { if (manual) this.show(); return; }
    $('#updPill').hidden = !r.newer; // stays visible even after "Later" / "Skip"
    if (r.newer) $('#updPillText').textContent = `WorkHub ${r.latest} — install`;
    if (r.newer && (manual || this.skipped() !== r.latest)) this.show();
    else if (manual) this.show();
  },

  show() {
    const r = this.info || {};
    let html;
    if (r.error) {
      html = `<p>Couldn't check for a new version.</p><p class="muted tiny">${esc(r.error)}</p>`;
    } else if (!r.newer) {
      html = `<p>✅ You have the latest version${r.current === 'dev' ? ' (a development build)' : ''}.</p><p class="muted tiny">This version: ${esc(r.current)} · latest release: ${esc(r.latest || '?')}</p>`;
    } else {
      html = `<p><b>WorkHub ${esc(r.latest)}</b> is available — you have ${esc(r.current)}.</p>
        <p class="muted tiny">Released ${esc(new Date(r.published).toLocaleString())}${r.size ? ` · ${(r.size / 1048576).toFixed(1)} MB` : ''}. Your data and settings stay as they are.</p>
        ${r.notes ? `<details><summary>What's in it</summary><pre class="upd-notes">${esc(r.notes)}</pre></details>` : ''}`;
    }
    $('#updBody').innerHTML = html;
    $('#updNow').hidden = !(r.newer && r.can_apply);
    $('#updSkip').hidden = !r.newer;
    $('#updPage').hidden = !(r.newer || r.error);
    $('#updLater').textContent = r.newer ? 'Later' : 'Close';
    if (!$('#updDlg').open) $('#updDlg').showModal();
  },

  async apply() {
    $('#updNow').disabled = true;
    $('#updBody').innerHTML = '<p>⬇ Downloading the new version…</p><p class="muted tiny">WorkHub restarts by itself when it is ready.</p>';
    try {
      const r = await api('POST', '/api/update');
      $('#updBody').innerHTML = `<p>✅ Updated to ${esc(r.version)} — WorkHub is restarting.</p><p class="muted tiny">A new WorkHub window or tab opens in a few seconds; you can close this one.</p>`;
      $('#updNow').hidden = $('#updSkip').hidden = $('#updPage').hidden = true;
    } catch (err) {
      $('#updBody').innerHTML = `<p>Update failed.</p><p class="muted tiny">${esc(err.message)}</p>`;
      $('#updPage').hidden = false;
    } finally { $('#updNow').disabled = false; }
  },
};

$('#updBtn').onclick = () => Update.check(true);
$('#updPill').onclick = () => Update.show();
// ☰ at the top of the sidebar: the same actions as the buttons at its foot
// (which can be scrolled out of sight on small screens).
$('#mainMenuBtn').onclick = () => {
  const r = $('#mainMenuBtn').getBoundingClientRect(), click = id => () => $(id).click();
  setTimeout(() => Tree.showMenu({ clientX: r.left, clientY: r.bottom + 4 }, [
    [Update.info?.newer ? `⬆ Install WorkHub ${Update.info.latest}…` : '⟳ Check for updates & install', () => Update.info?.newer ? Update.show() : Update.check(true)],
    ["✨ What's new & tips", click('#whatsNewBtn')],
    [`🌓 Theme: ${{ auto: 'follow Windows', light: 'light', dark: 'dark' }[Theme.pref()]} — switch to ${{ auto: 'light', light: 'dark', dark: 'follow Windows' }[Theme.pref()]}`, () => Theme.set({ auto: 'light', light: 'dark', dark: 'auto' }[Theme.pref()])], '-',
    ['👤 Your profile', click('#profileBtn')], ['🔒 Lock (Ctrl+L)', click('#lockBtn')], '-',
    ['↗ Programs for “Open in”…', click('#extBtn')], ['🛟 Backups…', click('#backupBtn')], ['Import data…', click('#importBtn')], ['Data location…', click('#dataLocBtn')], '-',
    ['Quit WorkHub', click('#quitBtn')]]));
};
$('#updNow').onclick = () => Update.apply();
$('#updLater').onclick = () => $('#updDlg').close();
$('#updSkip').onclick = () => { try { localStorage.setItem('skipUpdate', Update.info?.latest || ''); } catch { /* ignore */ } $('#updDlg').close(); toast('You won\'t be asked about this version again (⟳ Check for updates still shows it)'); };
$('#updPage').onclick = () => openExternal(Update.info?.page || 'https://github.com/prasadduddi/workhub/releases/latest');
setTimeout(() => { if (!Lock.shown) Update.check(false); }, 8000);
