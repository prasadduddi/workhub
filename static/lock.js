'use strict';
// PIN lock screen and settings. WorkHub (the server) refuses everything while
// locked, so this screen only collects the PIN; the idle timer here asks the
// server to lock after the chosen minutes without mouse or keyboard use.

const Lock = {
  enabled: false, minutes: 0, last: Date.now(), shown: false, emailHint: '', email: '', via: '',

  async init() {
    const r = await fetch('/api/lock').then(x => x.json()).catch(() => null);
    if (!r) return;
    this.enabled = r.enabled; this.minutes = r.minutes; this.quiet = !!r.quiet; this.emailHint = r.email_hint || ''; this.email = r.email || '';
    if (r.locked) this.show();
  },

  show() {
    if (this.shown) return;
    fetch('/api/lock').then(x => x.json()).then(r => { this.emailHint = r.email_hint || ''; }).catch(() => {});
    this.shown = true;
    $$('dialog[open]').forEach(d => d !== $('#lockDlg') && d.close());
    $('#ctxMenu').hidden = true;
    this.mode(false);
    $('#lockMsg').textContent = '';
    $('#lockDlg').showModal();
    $('#lockPin').focus();
  },

  hide() {
    this.shown = false; this.last = Date.now();
    if (typeof Cal !== 'undefined') Cal.lockedCM = null;
    $('#lockDlg').close();
    $('#lockPin').value = $('#lockCode').value = $('#lockNew').value = '';
    if (typeof poll === 'function') poll();
    if (typeof Jira !== 'undefined') Jira.load();
  },

  // Forgot PIN: an emailed code (to the profile email) or the recovery code.
  mode(recover, via) {
    $('#lockMain').hidden = recover; $('#lockRecover').hidden = !recover;
    $('#lockMsg').textContent = '';
    if (recover) {
      this.via = via || (this.emailHint ? 'email' : 'code');
      const email = this.via === 'email';
      $('#lockEmailBtn').hidden = !email;
      $('#lockEmailBtn').textContent = `✉ Email me a code (to ${this.emailHint})`;
      $('#lockRecHint').textContent = email ? 'A 6-digit code is sent from your Outlook to your profile email. Type it below with a new PIN.' : 'Type the recovery code you saved when you set the PIN, and choose a new PIN.';
      $('#lockCode').placeholder = email ? 'Code from the email (6 digits)' : 'Recovery code, e.g. ABCD-EFGH-JKLM';
      $('#lockSwitch').textContent = email ? 'Use the recovery code instead' : (this.emailHint ? 'Email me a code instead' : '');
      $('#lockSwitch').hidden = !this.emailHint;
    }
    (recover ? $('#lockCode') : $('#lockPin')).focus();
  },

  async emailCode() {
    try { const r = await this.post('/api/lock/email', {}); $('#lockMsg').textContent = ''; $('#lockRecHint').textContent = `Code sent to ${r.sent_to} — it works once, for 15 minutes. Check junk mail too.`; $('#lockCode').focus(); }
    catch (err) { $('#lockMsg').textContent = err.message; }
  },

  async post(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || r.statusText);
    return d;
  },

  async unlock() {
    try { await this.post('/api/lock/unlock', { pin: $('#lockPin').value }); this.hide(); }
    catch (err) { $('#lockMsg').textContent = err.message; $('#lockPin').select(); }
  },

  async recover() {
    try {
      const r = await this.post('/api/lock/recover', { code: $('#lockCode').value, pin: $('#lockNew').value, via: this.via === 'email' ? 'email' : '' });
      this.hide();
      this.showRecovery(r.recovery, true);
    } catch (err) { $('#lockMsg').textContent = err.message; }
  },

  async lockNow() {
    if (!this.enabled) return this.settings();
    try { await api('POST', '/api/lock'); } catch { /* the 423 shows the screen */ }
    this.show();
  },

  // Settings: set a PIN, or change it / the minutes / remove it (needs the current PIN).
  settings() {
    const on = this.enabled;
    $('#pinIntro').innerHTML = on
      ? 'Change your PIN or how soon WorkHub locks. The current PIN is needed for any change.'
      : 'With a PIN, WorkHub starts locked and locks itself after the minutes you choose, so nobody can read your passwords at an unlocked laptop. You get a <b>recovery code</b> for “Forgot PIN” — write it down.';
    $('#pinCurRow').hidden = !on;
    $('#pinNewLabel').textContent = on ? 'New PIN (leave empty to keep it)' : 'New PIN (4–8 digits)';
    $('#pinRemove').hidden = !on;
    $('#pinRec').hidden = true; $('#pinFields').hidden = false; $('#pinSave').hidden = false;
    ['#pinCur', '#pinNew', '#pinNew2'].forEach(s => ($(s).value = ''));
    $('#pinMinutes').value = String(on ? this.minutes : 10);
    $('#pinQuiet').checked = !(on && this.quiet);
    $('#pinEmailHint').innerHTML = this.email
      ? `Forgot PIN: a code can be emailed to <b>${esc(this.email)}</b> (from your 👤 profile), or use the recovery code.`
      : 'Tip: add your email in 👤 <b>Profile</b> so “Forgot PIN” can email you a code. Without it, only the recovery code works.';
    $('#pinDlg').showModal();
  },

  showRecovery(code, afterForgot) {
    $('#pinIntro').textContent = afterForgot ? 'New PIN set. Your old recovery code no longer works — here is the new one.' : 'PIN saved.';
    $('#pinRec').innerHTML = `<b>Recovery code</b> — write it down or keep it somewhere safe (not on this laptop). It is shown only now and is the only way back in if you forget the PIN.<div style="margin-top:6px"><code>${esc(code)}</code></div>`;
    $('#pinRec').hidden = false;
    $('#pinFields').hidden = true; $('#pinSave').hidden = true; $('#pinRemove').hidden = true;
    if (!$('#pinDlg').open) $('#pinDlg').showModal();
  },

  async save() {
    const pin = $('#pinNew').value.trim(), minutes = +$('#pinMinutes').value;
    if (pin !== $('#pinNew2').value.trim()) return toast('The two PINs are different', true);
    if (!this.enabled && !/^\d{4,8}$/.test(pin)) return toast('The PIN must be 4 to 8 digits', true);
    try {
      const quiet = !$('#pinQuiet').checked;
      const r = await api('POST', '/api/lock/set', { current: $('#pinCur').value, pin, minutes, quiet, email: this.email });
      this.enabled = true; this.minutes = minutes; this.quiet = quiet;
      if (r.recovery) this.showRecovery(r.recovery, false);
      else { $('#pinDlg').close(); toast('Lock settings saved'); }
    } catch (err) { toast(err.message, true); }
  },

  async remove() {
    if (!confirm('Remove the PIN? WorkHub will no longer lock.')) return;
    try { await api('POST', '/api/lock/set', { current: $('#pinCur').value, remove: true }); this.enabled = false; $('#pinDlg').close(); toast('PIN removed'); }
    catch (err) { toast(err.message, true); }
  },
};

$('#lockGo').onclick = () => Lock.unlock();
$('#lockPin').addEventListener('keydown', e => { if (e.key === 'Enter') Lock.unlock(); });
$('#lockForgot').onclick = () => Lock.mode(true);
$('#lockEmailBtn').onclick = () => Lock.emailCode();
$('#lockSwitch').onclick = () => Lock.mode(true, Lock.via === 'email' ? 'code' : 'email');
$('#lockBack').onclick = () => Lock.mode(false);
$('#lockRecoverGo').onclick = () => Lock.recover();
$('#lockNew').addEventListener('keydown', e => { if (e.key === 'Enter') Lock.recover(); });
$('#lockDlg').addEventListener('cancel', e => e.preventDefault()); // Esc doesn't close the lock screen
$('#lockBtn').onclick = () => Lock.lockNow();
$('#lockBtn').addEventListener('contextmenu', e => { e.preventDefault(); Lock.settings(); });
$('#pinSave').onclick = () => Lock.save();
$('#pinCancel').onclick = () => $('#pinDlg').close();
$('#pinRemove').onclick = () => Lock.remove();
document.addEventListener('keydown', e => { if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'l' && Lock.enabled) { e.preventDefault(); Lock.lockNow(); } });
['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'].forEach(ev => document.addEventListener(ev, () => { if (!Lock.shown) Lock.last = Date.now(); }, { passive: true }));
setInterval(() => {
  if (Lock.enabled && Lock.minutes > 0 && !Lock.shown && Date.now() - Lock.last > Lock.minutes * 60000) Lock.lockNow();
}, 15000);
Lock.init();

// 👤 Profile: the user's own details.
const Profile = {
  data: {},
  async load() {
    this.data = await api('GET', '/api/profile').catch(() => ({})) || {};
    $('#profileName').textContent = this.data.name || 'Your profile';
  },
  async open() {
    await this.load();
    const d = this.data;
    [['#pfName', 'name'], ['#pfEmail', 'email'], ['#pfPhone', 'phone'], ['#pfUser', 'user_id'], ['#pfTeam', 'team'], ['#pfRole', 'role'], ['#pfNotes', 'notes']].forEach(([s, k]) => ($(s).value = d[k] || ''));
    $('#profileDlg').showModal();
  },
  body() {
    return { name: $('#pfName').value, email: $('#pfEmail').value, phone: $('#pfPhone').value, user_id: $('#pfUser').value, team: $('#pfTeam').value, role: $('#pfRole').value, notes: $('#pfNotes').value };
  },
  async save() {
    try { this.data = await api('PUT', '/api/profile', this.body()); $('#profileName').textContent = this.data.name || 'Your profile'; $('#profileDlg').close(); toast('Profile saved'); Lock.init(); }
    catch (err) { toast(err.message, true); }
  },
  text() {
    const b = this.body();
    return [['Name', b.name], ['Email', b.email], ['Phone', b.phone], ['User ID', b.user_id], ['Team', b.team], ['Role', b.role]].filter(([, v]) => v.trim()).map(([k, v]) => `${k}: ${v.trim()}`).join('\n');
  },
};
$('#profileBtn').onclick = () => Profile.open();
$('#pfSave').onclick = () => Profile.save();
$('#pfCancel').onclick = () => $('#profileDlg').close();
$('#pfCopy').onclick = () => copyText(Profile.text(), 'Your details copied');
Profile.load();
