'use strict';
// 🔑 My SSH keys (☰ menu): the public keys in your ~/.ssh, ready to paste into
// GitHub (Settings → SSH and GPG keys), and the hosts in ~/.ssh/config.
// Read-only: WorkHub never changes anything in ~/.ssh.

const SSHKeys = {
  async open() {
    if (S.sshOff) return toast('SSH is switched off in this version of WorkHub — ~/.ssh is not read.', true);
    let d = $('#sshKeysDlg');
    if (!d) {
      d = Object.assign(document.createElement('dialog'), { id: 'sshKeysDlg', className: 'sshkeysdlg' });
      document.body.append(d);
      d.addEventListener('click', e => {
        if (e.target.closest('[data-skclose]')) return d.close();
        const c = e.target.closest('[data-skcopy]'); if (c) return copyText(this.data.keys[+c.dataset.skcopy].public, 'Public key copied — paste it into GitHub → New SSH key');
        if (e.target.closest('[data-skgh]')) return openExternal('https://github.com/settings/ssh/new');
        if (e.target.closest('[data-skreload]')) return this.open();
      });
    }
    d.innerHTML = '<div class="empty">Reading…</div>';
    if (!d.open) d.showModal();
    this.data = await api('GET', '/api/sshkeys').catch(err => ({ error: err.message, keys: [], hosts: [] }));
    const r = this.data;
    const keys = r.keys.map((k, i) => `<div class="sk-key ${k.github_ok ? '' : 'weak'}">
        <div class="sk-top"><b>${esc(k.file)}</b><span class="sk-type">${esc(k.type.replace('ssh-', ''))}${k.bits ? ' ' + k.bits : ''}</span>${k.comment ? `<span class="muted tiny">${esc(k.comment)}</span>` : ''}<span class="spacer"></span>
          <button class="primary" data-skcopy="${i}" title="Copy the public key (one line) to paste into GitHub">📋 Copy for GitHub</button></div>
        <div class="mono tiny sk-fp" title="Fingerprint — GitHub shows the same one after you add the key">${esc(k.fingerprint)}</div>
        <div class="mono tiny sk-pub">${esc(k.public.length > 120 ? k.public.slice(0, 70) + '…' + k.public.slice(-40) : k.public)}</div>
        ${k.note ? `<div class="sk-note">⚠ ${esc(k.note)}</div>` : ''}${!k.has_private ? '<div class="muted tiny">No matching private key next to it on this PC.</div>' : ''}
        <div class="muted tiny">Changed ${esc(fmtDateTime(k.modified))}</div></div>`).join('');
    const hosts = r.hosts.length ? `<h4>Hosts in ~/.ssh/config</h4><table class="sk-hosts"><tr><th>Host</th><th>HostName</th><th>User</th><th>Port</th><th>Key</th></tr>${r.hosts.map(h => `<tr><td>${esc(h.host)}</td><td>${esc(h.hostname || '')}</td><td>${esc(h.user || '')}</td><td>${esc(h.port || '')}</td><td class="mono tiny">${esc(h.identity || '')}</td></tr>`).join('')}</table>` : '';
    d.innerHTML = `<div class="sk-head"><h3>🔑 My SSH keys</h3><span class="spacer"></span><button class="icon" data-skreload title="Read again">↻</button><button class="icon" data-skclose>✕</button></div>
      <p class="muted tiny">From <code>${esc(r.dir || '~/.ssh')}</code> — WorkHub only reads this folder; it never changes it, and private keys are never read or copied.</p>
      ${r.error ? `<div class="sk-note">${esc(r.error)}</div>` : ''}
      ${keys || `<div class="empty">${r.exists ? 'No public keys (.pub or PuTTY .ppk) found in this folder.' : 'There is no .ssh folder in your user folder.'}<br><span class="muted tiny">A key is made with <code>ssh-keygen -t ed25519 -C "you@example.com"</code> in a command prompt (or PuTTYgen) — WorkHub doesn't create keys.</span></div>`}
      ${r.keys.length ? `<div class="sk-how"><b>Add a key to GitHub:</b> 📋 Copy for GitHub → <a href="#" data-skgh>open GitHub → New SSH key ↗</a> → paste it into <i>Key</i>, give it a title, Add. The fingerprint GitHub shows afterwards should match the one here.</div>` : ''}
      ${hosts}`;
  },
};
