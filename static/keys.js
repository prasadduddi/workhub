'use strict';
// ? — the keyboard shortcut sheet (press ? anywhere you are not typing).
// Only shortcuts that really exist in WorkHub are listed here.

const Keys = {
  GROUPS: [
    ['Everywhere', [
      ['?', 'This list'], ['Ctrl+K', 'Search everything'], ['Ctrl+J', 'Assistant'], ['F1', 'Help'],
      ['Ctrl+L', 'Lock (with a PIN set)'], ['Ctrl+B', 'Hide / show the sidebar'], ['Ctrl+Alt+N', 'Quick note into the capture thread'],
      ['Ctrl+Alt+W', 'Bring WorkHub up from any program (Desktop version)'], ['Esc', 'Close a menu or dialog']]],
    ['Search box', [
      ['↑ ↓', 'Choose a result'], ['Enter', 'Connect / open it'], ['Shift+Enter', 'Its details'],
      ['Alt+P · Alt+U', 'Copy password · username'], ['Alt+H · Alt+J', 'Copy host · JDBC / URL']]],
    ['Server trees (SSH · FTP · SQL)', [
      ['↑ ↓', 'Move'], ['→ ←', 'Open / close a folder'], ['Enter', 'Connect'], ['Right-click', 'Copy, Duplicate, Disconnect all, Tail a log…']]],
    ['SSH terminal', [
      ['Select text', 'Copies it'], ['Right-click', 'Pastes'], ['Enter (after disconnect)', 'Reconnects']]],
    ['SQL', [
      ['Ctrl+Enter', 'Run the statement at the cursor (or the selection)'], ['F5', 'Run everything as a script'],
      ['Ctrl+/', 'Comment / uncomment'], ['Ctrl+D', 'Duplicate the line'], ['Double-click a cell', 'Copy it']]],
    ['Tasks (threads)', [
      ['Enter', 'Post'], ['Shift+Enter', 'New line'], ['↑ (empty box)', 'Edit your last message'], ['Ctrl+K', 'Jump to a thread'], ['Ctrl+V', 'Paste a screenshot']]],
    ['API', [['Ctrl+Enter', 'Send'], ['Ctrl+S', 'Save the request']]],
  ],

  open() {
    let d = $('#keysDlg');
    if (!d) {
      d = Object.assign(document.createElement('dialog'), { id: 'keysDlg', className: 'keysdlg' });
      d.innerHTML = `<div class="keys-head"><h3>⌨ Keyboard shortcuts</h3><span class="spacer"></span><button class="icon" data-kclose>✕</button></div>
        <div class="keys-grid">${this.GROUPS.map(([g, rows]) => `<section><h4>${esc(g)}</h4>${rows.map(([k, t]) => `<div class="krow"><span class="kk">${k.split(' · ').map(x => x.split(/(?<=\S)\+(?=\S)/).map(p => `<kbd>${esc(p)}</kbd>`).join('+')).join(' · ')}</span><span>${esc(t)}</span></div>`).join('')}</section>`).join('')}</div>
        <p class="muted tiny">Press <kbd>?</kbd> again or <kbd>Esc</kbd> to close.</p>`;
      document.body.append(d);
      d.addEventListener('click', e => { if (e.target === d || e.target.closest('[data-kclose]')) d.close(); });
    }
    d.open ? d.close() : d.showModal();
  },
};

// ? only when not typing somewhere (boxes, editors, terminals).
document.addEventListener('keydown', e => {
  if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"], .CodeMirror, .xterm, .termhost')) return;
  e.preventDefault();
  Keys.open();
});
