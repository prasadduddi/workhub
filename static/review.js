'use strict';
// 🔍 Review a pull request (Bitbucket Server / Data Center, GitLab): WorkHub
// fetches it into your local clone (read-only — nothing is sent to Bitbucket
// or GitLab) and checks the lines it adds (see review.go). The result can
// become a review thread with a checklist.

const Review = {
  open(prefill = '') {
    $('#reviewDlg')?.remove();
    const d = document.createElement('dialog'); d.id = 'reviewDlg'; d.className = 'review-dlg';
    d.innerHTML = `<h3>🔍 Review a pull request</h3>
      <div class="muted tiny">Bitbucket (Server / Data Center) pull request or GitLab merge request. WorkHub fetches it into your local copy of the repository (Git page) with your normal git login and checks it here — nothing is posted to Bitbucket or GitLab.</div>
      <div class="row" style="margin-top:8px"><input id="revUrl" type="url" placeholder="https://bitbucket…/projects/PAY/repos/refunds/pull-requests/123" style="flex:1" value="${esc(prefill)}">
        <input id="revTarget" placeholder="target branch (optional)" style="width:170px" title="Leave empty: Bitbucket's merge preview, or the repository's default branch"><button id="revGo" class="primary">Review</button></div>
      <div id="revOut"></div>
      <div class="row end" style="margin-top:10px"><button id="revThread" hidden>🧵 Save as review thread</button><button id="revCopy" hidden title="Copy the findings as text, e.g. to paste into a comment yourself">📋 Copy findings</button><button id="revPR" hidden>↗ Open the pull request</button><span class="spacer"></span><button id="revClose">Close</button></div>`;
    document.body.append(d); d.showModal();
    const go = () => this.run();
    $('#revGo').onclick = go;
    $('#revUrl').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    $('#revClose').onclick = () => d.close();
    $('#revThread').onclick = () => this.toThread();
    $('#revCopy').onclick = () => copyText(this.text(), 'Findings copied');
    $('#revPR').onclick = () => openExternal(this.res.pr.web);
    d.addEventListener('close', () => d.remove());
    $('#revUrl').focus();
    if (prefill) go();
  },
  async run() {
    const url = $('#revUrl').value.trim(); if (!url) return $('#revUrl').focus();
    $('#revGo').disabled = true;
    $('#revOut').innerHTML = '<p class="muted">⏳ Fetching the pull request and checking it…</p>';
    try {
      this.res = await api('POST', '/api/review', { url, target: $('#revTarget').value.trim() });
      this.render();
    } catch (err) {
      $('#revOut').innerHTML = `<p class="rev-err">${esc(err.message)}</p>${/no local copy/.test(err.message) ? '<p><button id="revGit">Open the Git page</button></p>' : ''}`;
      $('#revGit')?.addEventListener('click', () => { $('#reviewDlg').close(); show('git'); });
    } finally { $('#revGo').disabled = false; }
  },
  sev: { high: ['🔴', 'Must fix'], medium: ['🟠', 'Should fix'], low: ['🟡', 'Worth a look'] },
  render() {
    const r = this.res, n = s => r.findings.filter(f => f.severity === s).length;
    const add = r.files.reduce((a, f) => a + f.added, 0), del = r.files.reduce((a, f) => a + f.deleted, 0);
    $('#revOut').innerHTML = `<div class="rev-head"><b>${esc(r.pr.repo)}</b> · ${r.pr.kind === 'gitlab' ? 'MR !' : 'PR #'}${r.pr.number}${r.jira ? ` · ◆ ${esc(r.jira)}` : ''}
        <span class="muted tiny">${esc(r.base)}..${esc(r.head)}${r.target ? ' vs ' + esc(r.target) : ''} · ${r.commits.length} commit${r.commits.length === 1 ? '' : 's'} · ${r.files.length} file${r.files.length === 1 ? '' : 's'} · +${add} −${del}</span></div>
      <div class="rev-sum">${['high', 'medium', 'low'].map(s => `<span class="rev-chip ${s}">${this.sev[s][0]} ${n(s)} ${this.sev[s][1].toLowerCase()}</span>`).join('')}${r.findings.length ? '' : '<span class="rev-chip ok">✅ Nothing found by the checks</span>'}</div>
      <div class="rev-list">${r.findings.map(f => `<div class="rev-f ${f.severity}"><div><b>${this.sev[f.severity][0]} ${esc(f.title)}</b> <span class="muted tiny">${esc(f.file)}${f.line ? ':' + f.line : ''}</span></div>${f.text ? `<code>${esc(f.text)}</code>` : ''}<div class="muted tiny">${esc(f.why)}</div></div>`).join('')}</div>
      <details class="rev-files"><summary>${r.files.length} changed file${r.files.length === 1 ? '' : 's'} · ${r.commits.length} commit${r.commits.length === 1 ? '' : 's'}</summary>
        ${r.files.map(f => `<div class="mono tiny">${f.binary ? 'binary' : `<span class="rev-add">+${f.added}</span> <span class="rev-del">−${f.deleted}</span>`} ${esc(f.path)}</div>`).join('')}<hr>${r.commits.map(c => `<div class="mono tiny">${esc(c)}</div>`).join('')}</details>`;
    for (const id of ['#revThread', '#revCopy', '#revPR']) $(id).hidden = false;
  },
  text() {
    const r = this.res;
    return `Review of ${r.pr.repo} ${r.pr.kind === 'gitlab' ? 'MR !' : 'PR #'}${r.pr.number} (${r.base}..${r.head})\n` + (r.findings.map(f => `${this.sev[f.severity][0]} ${f.title} — ${f.file}${f.line ? ':' + f.line : ''}${f.text ? `\n    ${f.text}` : ''}\n    ${f.why}`).join('\n') || '✅ Nothing found by the checks');
  },
  // A thread for the review: link, summary, a checklist, and the findings.
  async toThread() {
    const r = this.res, title = `Review: ${r.pr.repo.split('/').pop()} ${r.pr.kind === 'gitlab' ? 'MR !' : 'PR #'}${r.pr.number}`;
    if (!Work.list.length) await Work.loadList();
    let w = Work.list.find(x => x.title === title);
    if (!w) w = await api('POST', '/api/work', { title, jira: r.jira || '', status: 'doing' });
    const n = s => r.findings.filter(f => f.severity === s).length;
    await Work.post('note', { html: `<p>🔍 <b>Review</b> of <a href="${esc(r.pr.web)}">${esc(r.pr.repo)} ${r.pr.kind === 'gitlab' ? 'MR !' : 'PR #'}${r.pr.number}</a> — ${esc(r.base)}..${esc(r.head)}, ${r.files.length} files, ${r.commits.length} commits</p><p>🔴 ${n('high')} must fix · 🟠 ${n('medium')} should fix · 🟡 ${n('low')} worth a look</p>
      <ul><li><input type="checkbox"> Builds and tests pass</li><li><input type="checkbox"> Must-fix items resolved</li><li><input type="checkbox"> Logic and edge cases checked</li><li><input type="checkbox"> Config / DB changes reviewed for each environment</li><li><input type="checkbox"> Logging and error handling OK</li><li><input type="checkbox"> Approved in ${r.pr.kind === 'gitlab' ? 'GitLab' : 'Bitbucket'}</li></ul>` }, w.id);
    if (r.findings.length) await Work.post('note', { html: `<p><b>Findings</b></p><ul>${r.findings.map(f => `<li>${this.sev[f.severity][0]} <b>${esc(f.title)}</b> — <code>${esc(f.file)}${f.line ? ':' + f.line : ''}</code>${f.text ? `<br><code>${esc(f.text)}</code>` : ''}</li>`).join('')}</ul>` }, w.id);
    $('#reviewDlg').close();
    await Work.loadList(); Work.open(w.id);
    toast(`Saved to “${title}”`);
  },
};
$('#gitReview')?.addEventListener('click', () => Review.open());
// a pull request link pasted into WorkHub's search: offer the review
document.addEventListener('paste', e => {
  const t = (e.clipboardData?.getData('text/plain') || '').trim();
  if (e.target.id === 'search' && /\/pull-requests\/\d+|\/-\/merge_requests\/\d+/.test(t)) setTimeout(() => toast('A pull request — review it?', false, () => Review.open(t), '🔍 Review'), 50);
});
