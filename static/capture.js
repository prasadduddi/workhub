'use strict';
// Adding connections by copying, in the 💬 Assistant: while the Assistant is
// open, what you copy is not saved by itself — each connection found in it is
// offered in the conversation ("I found an SSH server … Add it?") and saved
// when you say Yes. Server details or a JDBC URL pasted into its message box,
// or a screenshot, are recognised the same way when you press Send (pictures:
// the OCR built into Windows).
// With the Assistant closed, capture works as before.

const AsstCapture = {
  timer: null,
  shown: new Map(), // offers put in the conversation: id → proposal (copied or pasted)
  ocr: true,
  n: 0,

  // the Assistant opened or closed: ask WorkHub for copies while it is open
  // (asking is also what tells WorkHub to hold copies back)
  sync() {
    const open = !$('#chat').hidden;
    clearInterval(this.timer); this.timer = null;
    if (!open) return;
    this.timer = setInterval(() => { if ($('#chat').hidden) { clearInterval(this.timer); this.timer = null; } else this.poll(); }, 1200);
    this.poll();
  },
  async poll() {
    const r = await api('GET', '/api/capture/proposals').catch(() => null); if (!r) return;
    this.ocr = r.ocr;
    for (const p of r.proposals || []) if (!this.shown.has(p.id)) this.offer(p, false);
  },

  kind(f) { // what kind of connection a finding is, as WorkHub would treat it
    const e = { ...f };
    if (canDB(e)) return ['🛢', dbKindOf(e) === 'oracle' ? 'an Oracle database' : 'a PostgreSQL database'];
    if (isFTP(e)) return ['📂', 'an FTP server'];
    if (e.protocol === 'sftp') return ['📂', 'an SFTP server'];
    if (e.url && /^https?:/i.test(e.url) && !e.protocol) return ['🔗', 'a link'];
    if (canSSH(e)) return ['🖥', 'an SSH server'];
    return ['🖥', 'a ' + (e.protocol || 'server').toUpperCase() + ' connection'];
  },
  describe(f) {
    if (canDB({ ...f })) return `${f.username ? f.username + '@' : ''}${f.host}:${f.port || ''}${f.extra?.service ? ' / ' + f.extra.service : f.extra?.database ? ' / ' + f.extra.database : ''}`;
    if (f.url && !f.host) return f.url;
    return `${f.username ? f.username + '@' : ''}${f.host || f.url}${f.port ? ':' + f.port : ''}`;
  },

  // one message per copy / paste: a question per connection found
  offer(p, local) {
    this.shown.set(p.id, p);
    const where = p.source === 'screenshot' ? '🖼 In your screenshot' : local ? '📋 In what you pasted' : `📋 You copied${p.from ? ' (from ' + esc(p.from) + ')' : ''}`;
    const rows = p.findings.map((f, i) => {
      const [ic, what] = this.kind(f), existing = f.existing_id && byId(f.existing_id);
      return `<div class="asq" data-pid="${esc(p.id)}" data-i="${i}" data-local="${local ? 1 : ''}"><div>${ic} I found <b>${what}</b>: <code>${esc(this.describe(f))}</code>${f.password ? ' (with a password)' : ''}. Add it?${existing ? ` <span class="muted tiny">Already saved as <b>${esc(existing.name || existing.host)}</b> — Yes adds what is new.</span>` : ''}</div><div class="row"><button class="primary" data-asyes>Yes, add it</button><button data-asno>No</button></div></div>`;
    }).join('');
    Chat.say(`${where}:${rows}`);
  },

  async answer(q, yes) {
    const local = !!q.dataset.local, id = q.dataset.pid, i = +q.dataset.i;
    const p = this.shown.get(id), f = p?.findings[i]; if (!f) return;
    const row = q.querySelector('.row');
    q.querySelectorAll('button').forEach(b => { b.disabled = true; });
    if (!yes) {
      if (!local) await api('POST', '/api/capture/dismiss', { id, index: i }).catch(() => {});
      row.innerHTML = '<span class="muted tiny">Not added.</span>';
      return;
    }
    try {
      const r = await api('POST', '/api/capture/accept', { id: local ? '' : id, index: i, finding: f, text: p.text || '', from: p.from || '' });
      const [, what] = this.kind(f), name = r.entry?.name || this.describe(f);
      row.innerHTML = '<span class="muted tiny">Added.</span>';
      Chat.say(`✅ <b>${r.created ? 'Connection created' : 'Connection updated'}</b>: ${what.replace(/^an? /, '')} <b>${esc(name)}</b> <a href="#" data-asshow="${esc(r.entry?.id || '')}">Show</a>`);
      toast(`${r.created ? 'Connection created' : 'Connection updated'}: ${name}`);
      await poll();
    } catch (err) {
      q.querySelectorAll('button').forEach(b => { b.disabled = false; });
      Chat.say('Couldn\'t add it: ' + esc(err.message));
    }
  },

  // a picture pasted into the message box waits, shown under it, until Send
  img: null,
  paste(ev) {
    const item = [...(ev.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
    if (!item) return; // text: an ordinary paste — recognised when you press Send
    ev.preventDefault();
    this.img = item.getAsFile();
    this.imgChip();
    $('#chatText').focus();
  },
  imgChip() {
    let c = $('#asImg');
    if (!this.img) { c?.remove(); return; }
    if (!c) { c = Object.assign(document.createElement('div'), { id: 'asImg', className: 'as-img' }); $('#chat .chat-input').before(c); }
    c.innerHTML = '🖼 Screenshot attached — press <b>Send</b> to read it <button type="button" class="icon" data-asimgx title="Remove">✕</button>';
  },
  async sendImage() {
    const img = this.img; this.img = null; this.imgChip();
    Chat.say('🖼 <i>(screenshot)</i>', 'me');
    if (!this.ocr) return Chat.say('Reading text from pictures isn\'t available on this computer — paste the text instead.');
    const wait = Chat.say('🖼 Reading your screenshot…');
    const r = await fetch('/api/capture/ocr', { method: 'POST', body: img }).then(x => x.json()).catch(err => ({ error: err.message }));
    wait.remove();
    if (r.error) return Chat.say(esc(r.error));
    const text = r.text || '';
    if (!text.trim()) return Chat.say('I couldn\'t find any text in that picture.');
    const found = await api('POST', '/api/parse', { text }).catch(() => []);
    if (!found.length) return Chat.say('I read the screenshot but found no server, database or link in it:<pre>' + esc(text.slice(0, 600)) + '</pre>');
    this.offer({ id: 'local-' + (++this.n), source: 'screenshot', text, findings: found }, true);
  },
};

$('#chatText').addEventListener('paste', e => AsstCapture.paste(e));
$('#chat').addEventListener('click', e => { if (e.target.closest('[data-asimgx]')) { AsstCapture.img = null; AsstCapture.imgChip(); } });
$('#chatLog').addEventListener('click', e => {
  const q = e.target.closest('.asq');
  if (q && e.target.closest('[data-asyes]')) return AsstCapture.answer(q, true);
  if (q && e.target.closest('[data-asno]')) return AsstCapture.answer(q, false);
  const s = e.target.closest('[data-asshow]'); if (s) { e.preventDefault(); const x = byId(s.dataset.asshow); if (x) showDetails(x); }
});
