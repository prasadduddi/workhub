'use strict';
// Microsoft Teams: forward a thread message to a person / group chat, and bring
// Teams messages into a thread.
// • No setup: Forward opens Teams on that chat with the text typed in (pictures
//   on the clipboard: Ctrl+V); Add from Teams adds what you copied in Teams.
// • Signed in (⚙ Settings → Teams, an app IT registers): sends directly with the
//   pictures, and lets you pick a chat and its messages.

const Teams = {
  st: null,
  async status(fresh) {
    if (!this.st || fresh) this.st = await api('GET', '/api/teams/status').catch(() => ({}));
    return this.st;
  },
  recent() { try { return JSON.parse(localStorage.getItem('teamsTo') || '[]'); } catch { return []; } },
  remember(list) { try { localStorage.setItem('teamsTo', JSON.stringify([...new Set([...list, ...this.recent()])].slice(0, 12))); } catch { /* ignore */ } },

  // 💬 Forward to Teams…
  async forward(p, postEl) {
    const st = await this.status(true);
    const to = await askText(`Send to (email${st.signed_in ? '' : ', comma-separated for a group'})${this.recent().length ? ' — recent: ' + this.recent().slice(0, 3).join(', ') : ''}`, this.recent()[0] || '', st.signed_in ? 'Send' : 'Open in Teams');
    const list = (to || '').split(/[,;\s]+/).map(x => x.trim()).filter(x => /@/.test(x));
    if (!list.length) return to === null ? null : toast('Enter an email address (name@example.com)', true);
    this.remember(list);
    if (st.signed_in) {
      try {
        const r = await api('POST', '/api/teams/send', { thread: Work.current.id, post: p.id, to: list });
        return toast(`Sent to Teams${r.pictures ? ` with ${r.pictures} picture${r.pictures > 1 ? 's' : ''}` : ''} ✓`);
      } catch (err) { toast(err.message + ' — opening Teams instead', true); }
    }
    // no setup: the message on the clipboard (text + pictures) and Teams opened on that chat with the text typed in
    await copyPost(p, postEl);
    const text = (p.kind === 'capture' && !p.html ? p.text : postEl.querySelector('.tbody')?.innerText || '').trim().slice(0, 1800);
    const url = `https://teams.microsoft.com/l/chat/0/0?users=${encodeURIComponent(list.join(','))}&message=${encodeURIComponent(text)}`;
    (typeof openExternal === 'function' ? openExternal : u => window.open(u, '_blank'))(url);
    const pics = postEl.querySelectorAll('.tbody img').length;
    toast(`Teams is opening on the chat with the text typed in${pics ? ' — press Ctrl+V there to add the picture' + (pics > 1 ? 's' : '') : ''}, then Send`);
  },

  // 📥 Add from Teams…
  async addFrom() {
    const st = await this.status(true);
    if (st.signed_in) return this.pickChat();
    // no setup: what was copied in Teams (Ctrl+C on the messages)
    let html = '', text = '';
    try { const r = await api('GET', '/api/clipboard/html'); html = r.html || ''; text = r.text || ''; } catch { /* WorkHub couldn't read it */ }
    if (!html.trim() && !text.trim()) { // the browser's own clipboard, only as a last resort (it may ask Allow / Block)
      try {
        for (const item of await navigator.clipboard.read()) {
          if (item.types.includes('text/html')) html = await (await item.getType('text/html')).text();
          if (item.types.includes('text/plain')) text = await (await item.getType('text/plain')).text();
        }
      } catch { /* not allowed: say how */ }
    }
    if (!html.trim() && !text.trim()) return toast('Copy the messages in Teams first (select them, Ctrl+C), then choose Add from Teams again — or paste them into the message box', true);
    let body = html.trim() ? sanitizeHTML(html.replace(/<!--[\s\S]*?-->/g, '')) : '<p>' + esc(text).replace(/\r?\n/g, '<br>') + '</p>';
    for (const [, uri, ext] of [...body.matchAll(/src="(data:image\/(\w+);base64,[^"]+)"/g)]) { // pictures that came along: stored
      const bin = Uint8Array.from(atob(uri.split(',')[1]), ch => ch.charCodeAt(0));
      const stored = await Work.storeFiles([new File([bin], `teams.${ext}`, { type: 'image/' + ext })]);
      const id = (stored.match(/files\/([0-9a-f]+)/) || [])[1];
      body = body.replace(uri, id ? '/api/props/files/' + id : '');
    }
    await api('POST', `/api/work/${Work.current.id}/posts`, { kind: 'note', html: `<p><i>📥 From Teams</i></p>${body}`, from: 'Teams' });
    Work.current = await api('GET', '/api/work/' + Work.current.id); Work.render(true);
    toast('Added from Teams');
  },

  // signed in: pick a chat, then its messages
  async pickChat() {
    const d = this.dlg();
    d.querySelector('.tm-body').innerHTML = '<div class="muted">Loading your chats…</div>';
    d.showModal();
    let chats = [];
    try { chats = await api('GET', '/api/teams/chats'); } catch (err) { d.querySelector('.tm-body').innerHTML = `<div class="muted">${esc(err.message)}</div>`; return; }
    d.querySelector('.tm-title').textContent = '📥 Add from Teams — pick a chat';
    d.querySelector('.tm-body').innerHTML = chats.map(c => `<button type="button" class="tm-chat" data-chat="${esc(c.id)}" data-name="${esc(c.name)}">${c.kind === 'oneOnOne' ? '👤' : '👥'} <b>${esc(c.name)}</b></button>`).join('') || '<div class="muted">No chats.</div>';
    d.querySelector('.tm-add').hidden = true;
  },
  async pickMessages(chat, name) {
    const d = this.dlg(), body = d.querySelector('.tm-body');
    body.innerHTML = '<div class="muted">Loading messages…</div>';
    let ms = [];
    try { ms = await api('GET', '/api/teams/messages?chat=' + encodeURIComponent(chat)); } catch (err) { body.innerHTML = `<div class="muted">${esc(err.message)}</div>`; return; }
    d.querySelector('.tm-title').textContent = `📥 ${name} — tick the messages to add`;
    body.innerHTML = ms.map(m => `<label class="tm-msg"><input type="checkbox" value="${esc(m.id)}"><span><b>${esc(m.from)}</b> <span class="muted tiny">${esc(fmtTime(m.at))}</span><br>${esc(m.preview)}</span></label>`).join('') || '<div class="muted">No messages.</div>';
    const add = d.querySelector('.tm-add'); add.hidden = false;
    add.onclick = async () => {
      const ids = [...body.querySelectorAll('input:checked')].map(i => i.value);
      if (!ids.length) return toast('Tick the messages to add', true);
      try {
        const r = await api('POST', '/api/teams/import', { thread: Work.current.id, chat, name, ids });
        d.close(); Work.current = await api('GET', '/api/work/' + Work.current.id); Work.render(true);
        toast(`Added ${r.added} message${r.added > 1 ? 's' : ''} from Teams`);
      } catch (err) { toast(err.message, true); }
    };
  },
  dlg() {
    let d = $('#teamsDlg');
    if (!d) {
      d = Object.assign(document.createElement('dialog'), { id: 'teamsDlg', className: 'teams-dlg' });
      d.innerHTML = '<h3 class="tm-title">Teams</h3><div class="tm-body"></div><div class="row end"><button type="button" class="tm-close">Close</button><button type="button" class="primary tm-add" hidden>Add to the thread</button></div>';
      document.body.append(d);
      d.addEventListener('click', e => {
        if (e.target.closest('.tm-close')) return d.close();
        const c = e.target.closest('[data-chat]'); if (c) this.pickMessages(c.dataset.chat, c.dataset.name);
      });
    }
    return d;
  },

  // ⚙ Settings → Teams
  async settingsHTML(row, btn) {
    const st = await this.status(true);
    const inp = (k, v, ph) => `<input data-set="${k}" value="${esc(v || '')}" placeholder="${ph}" style="width:280px">`;
    return [
      row('Without setup', 'Forward opens Teams on the chat with the text typed in (pictures: Ctrl+V); Add from Teams adds what you copied there.', ''),
      row('Tenant ID', 'Directory (tenant) ID of your company — from IT', inp('teams-tenant', st.tenant, 'e.g. contoso.onmicrosoft.com or a GUID')),
      row('Client ID', 'Application (client) ID of the app IT registered', inp('teams-client', st.client_id, 'a GUID')),
      row(st.signed_in ? `Signed in as ${esc(st.user || 'you')}` : 'Sign in', st.pending === 'waiting' ? `Open <a href="#" data-teamsverify>${esc(st.verify)}</a> and enter the code <b class="tm-code">${esc(st.user_code)}</b>` : st.pending?.startsWith('error') ? esc(st.pending) : st.signed_in ? 'Forward sends directly (pictures too); Add from Teams lists your chats.' : 'Signs in with Microsoft (your password stays with Microsoft).', st.signed_in ? btn('teams-signout', 'Sign out') : btn('teams-signin', 'Sign in', 'primary')),
      row('For IT', 'App registration (Entra ID): public client flows on; delegated permissions Chat.ReadWrite, User.Read, User.ReadBasic.All, offline_access (admin consent).', ''),
    ];
  },
};
