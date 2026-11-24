"""WorkHub browser smoke test: drives the real page against the demo (made-up
data, tools/demolab) and checks the main flows. Run it with tools/uitest/run.sh
(or ./build.sh check). Prints one line per check and exits 1 if any failed.

Only test data is used: the demo's pretend servers, Jira and files.
"""
import glob, json, os, sys, time, traceback

from playwright.sync_api import sync_playwright

URL, SIM = sys.argv[1], sys.argv[2]
results = []


BEFORE = []  # run before every check (closes dialogs that open by themselves, e.g. What's new)


class Skip(Exception):
    pass


def check(name):
    def wrap(fn):
        t = time.time()
        try:
            for f in BEFORE:
                f()
            fn()
            results.append((name, True, ""))
            print(f"  ✓ {name}  ({time.time() - t:.1f}s)")
        except Skip as e:
            print(f"  – {name}: skipped ({e})")
        except Exception as e:  # keep going: report every failure
            msg = str(e).splitlines()[0][:200] if str(e) else type(e).__name__
            results.append((name, False, msg))
            print(f"  ✗ {name}: {msg}")
            if os.environ.get("UITEST_TRACE"):
                traceback.print_exc()
        return fn
    return wrap


def expect(cond, what):
    if not cond:
        raise AssertionError(what)


def chromium():
    exe = os.environ.get("UITEST_CHROMIUM")
    if exe:
        return exe
    found = glob.glob(os.path.expanduser("~/Library/Caches/ms-playwright/chromium-*/chrome-mac*/*.app/Contents/MacOS/*")) + \
        glob.glob(os.path.expanduser("~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome"))
    return found[0] if found else None


with sync_playwright() as p:
    exe = chromium()
    b = p.chromium.launch(executable_path=exe) if exe else p.chromium.launch()
    ctx = b.new_context(viewport={"width": 1400, "height": 900}, accept_downloads=True)
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.on("dialog", lambda d: d.accept())
    pg.goto(URL)
    pg.wait_for_function("typeof S !== 'undefined' && S.entries.length > 0", timeout=20000)
    pg.evaluate("document.querySelectorAll('dialog[open]').forEach(d => d.close())")
    ev = pg.evaluate
    ssh_off = lambda: bool(ev("S.sshOff"))
    ssh_keys_off = lambda: bool(ev("S.sshKeysOff"))
    close_dialogs = lambda: ev("document.querySelectorAll('dialog[open]').forEach(d => d.close())")
    pg.wait_for_timeout(9000)  # What's new opens a few seconds after a first start
    BEFORE.append(lambda: (close_dialogs(), pg.keyboard.press("Escape")))

    @check("page loads without errors")
    def _():
        expect(not errors, f"errors: {errors[:3]}")

    @check("every page opens")
    def _():
        for v in ["dashboard", "tasks", "notes", "cal", "jira", "terminal", "files", "sql", "api", "git", "ref", "bookmarks", "groups", "inbox"]:
            ev(f"show('{v}')")
            expect(ev("document.querySelector('.view.active').id") == "view-" + v, f"{v} did not open")
        expect(not errors, f"errors: {errors[:3]}")

    @check("menu bar: every menu opens")
    def _():
        for m in ["File", "Edit", "View", "Connect", "Tools", "Help"]:
            pg.click(f"#menubar [data-menu={m}]")
            expect(pg.is_visible("#ctxMenu") and len(pg.query_selector_all("#ctxMenu button")) > 2, f"{m} menu empty")
            pg.keyboard.press("Escape")

    @check("sidebar groups fold and pages hide")
    def _():
        expect(len(pg.query_selector_all("#nav .navgroup")) == 3, "three groups")
        ev("show('dashboard')")
        pg.click("#nav .navgrp[data-grp='Saved']")
        expect(not pg.is_visible("#nav [data-view=bookmarks]"), "fold Saved")
        pg.click("#nav .navgrp[data-grp='Saved']")
        expect(pg.is_visible("#nav [data-view=bookmarks]"), "unfold Saved")

    @check("search finds connections, threads and notes")
    def _():
        ev("show('dashboard')")
        pg.fill("#search", "acme"); pg.dispatch_event("#search", "input"); pg.wait_for_timeout(500)
        expect(ev("filtered().length") > 0, "no connections for 'acme'")
        pg.fill("#search", ""); pg.dispatch_event("#search", "input")

    @check("command palette runs a page")
    def _():
        pg.keyboard.press("Control+Shift+P"); pg.wait_for_timeout(200)
        pg.fill("#palIn", "go sql"); pg.keyboard.press("Enter"); pg.wait_for_timeout(300)
        expect(ev("document.querySelector('.view.active').id") == "view-sql", "palette did not open SQL")

    @check("SSH: connect to the lab server, then the tree shows it live")
    def _():
        if ssh_off():
            raise Skip("SSH is switched off")
        ev("show('terminal')")
        ev("Term.open(S.entries.find(e => e.port === 2222))")
        pg.wait_for_function("Term.tabs.some(t => !t.closed)", timeout=15000)
        pg.wait_for_timeout(800)
        expect(pg.query_selector("#view-terminal .tree-host .dot.live"), "no live dot in the tree")

    @check("pop out an SSH tab and dock it back")
    def _():
        if ssh_off():
            raise Skip("SSH is switched off")
        with ctx.expect_page() as pw:
            pg.click("#termTabs [data-pop]")
        w = pw.value
        w.wait_for_function("typeof Term !== 'undefined' && Term.tabs.some(t => !t.closed)", timeout=15000)
        expect(ev("Term.tabs.length") == 0, "main window kept the tab")
        w.click("#popDock")
        pg.wait_for_function("Term.tabs.some(t => !t.local)", timeout=15000)
        expect(w.is_closed(), "pop-out window stayed open")
        ev("Term.tabs.slice().forEach(t => Term.close(t))")

    @check("log viewer follows a file on the lab server")
    def _():
        if ssh_off():
            raise Skip("SSH is switched off")
        ev("LogView.open(S.entries.find(e => e.port === 2222))"); pg.wait_for_timeout(400)
        pg.fill("#logPanel .lp-path", "app/logs/application.log"); pg.click("#logPanel [data-lp=follow]")
        pg.wait_for_function("LogView.lines.length > 50", timeout=15000)
        pg.click("#logPanel [data-lp=close]")

    @check("SSH switched off: nothing connects, ~/.ssh isn't read")
    def _():
        if not ssh_off():
            raise Skip("SSH is on")
        lab = "S.entries.find(e => e.port === 2222)"
        ev("show('terminal')"); ev(f"Term.open({lab})"); pg.wait_for_timeout(400)
        expect(ev("Term.tabs.filter(t => !t.local).length") == 0, "an SSH tab opened")
        expect(pg.is_visible("#view-terminal .sshoff-note"), "no notice on the SSH page")
        ev(f"Remote.connect({lab})"); pg.wait_for_timeout(400)
        expect(not ev("Remote.sid"), "SFTP connected")
        ev(f"LogView.open({lab})"); pg.wait_for_timeout(300)
        expect(not pg.is_visible("#logPanel"), "log viewer opened")
        expect(ev("api('GET', '/api/sshkeys').then(r => r.off === true && r.keys.length === 0)"), "SSH keys were read")
        err = ev(f"api('POST', '/api/compare/remote', {{ id: {lab}.id, path: 'x' }}).then(() => '', e => e.message)")
        expect("switched off" in err, f"remote compare: {err!r}")
        err = ev(f"api('POST', '/api/tunnels/' + {lab}.id + '/start').then(() => '', e => e.message)")
        expect("switched off" in err or err, f"tunnel started: {err!r}")
        r = ev(f"api('POST', '/api/test', {{ id: {lab}.id, host: '127.0.0.1', port: 2222, username: 'deploy', protocol: 'ssh' }})")
        expect(not r["ok"] and "switched off" in r["message"], f"SSH test: {r}")
        expect(ev(f"api('GET', '/api/entries').then(l => l.find(e => e.port === 2222).status || '')") != "fail", "the switched-off test marked the entry failed")

    @check("threads: open one with a screenshot")
    def _():
        ev("show('tasks')")
        pg.wait_for_function("Work.list.length > 3", timeout=10000)
        ev("Work.open(Work.list.find(w => w.images > 0).id)")
        pg.wait_for_function("[...document.querySelectorAll('#taskMain img')].some(i => i.complete && i.naturalWidth > 0)", timeout=10000)

    @check("move a message to another thread and back")
    def _():
        ev("show('tasks')")
        src = ev("Work.list.find(w => w.title.startsWith('PAY-205')).id")
        dst = ev("Work.list.find(w => w.title.startsWith('OPS-77')).id")
        ev(f"Work.open('{src}')"); pg.wait_for_timeout(500)
        pid = ev("Work.current.posts.find(p => !p.parent).id")
        moved = ev(f"api('POST', '/api/work/{src}/posts/{pid}/move', {{ to: '{dst}' }})")
        expect("Moved from" in moved["via"], "no 'Moved from' label")
        ev(f"api('POST', '/api/work/{dst}/posts/{moved['id']}/move', {{ to: '{src}' }})")

    @check("✎ Edit is the first thing on a message (hover bar and ⋯ menu)")
    def _():
        ev("show('tasks')")
        ev("Work.open(Work.list.find(w => w.title.startsWith('PAY-205')).id)"); pg.wait_for_timeout(500)
        msg = pg.locator("#tposts .tmsg.k-note").first
        msg.hover(); pg.wait_for_timeout(200)
        first = msg.locator(".thover button").first
        expect(first.is_visible() and "Edit" in first.inner_text(), f"first hover button: {first.inner_text()!r}")
        msg.locator(".thover [data-pact=more]").click(); pg.wait_for_timeout(200)
        expect(pg.locator("#ctxMenu button").first.inner_text().startswith("✎ Edit"), "⋯ menu doesn't start with Edit")
        pg.keyboard.press("Escape"); pg.wait_for_timeout(100)
        msg.hover(); first.click(); pg.wait_for_timeout(200)
        expect(ev("!!document.querySelector('#tposts .tbody.editing')"), "Edit didn't start editing")
        pg.click("#tposts [data-pact=cancel]")

    @check("add a Word document to a thread, formatting kept")
    def _():
        import io, zipfile
        W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
        doc = (f'<?xml version="1.0"?><w:document {W}><w:body>'
               '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Cutover steps</w:t></w:r></w:p>'
               '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Stop</w:t></w:r><w:r><w:t xml:space="preserve"> the batch</w:t></w:r></w:p>'
               '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>srv-01</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>ops</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
               '</w:body></w:document>')
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("word/document.xml", doc)
        ev("show('tasks')")
        ev("Work.open(Work.list.find(w => w.title.startsWith('PAY-205')).id)"); pg.wait_for_timeout(500)
        n = ev("Work.current.posts.length")
        pg.click("#taskMain [data-tact=more]")
        with pg.expect_file_chooser() as fc:
            pg.click("#ctxMenu button:has-text('Add a Word document to this thread')")
        fc.value.set_files(files=[{"name": "Cutover plan.docx", "mimeType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "buffer": buf.getvalue()}])
        pg.wait_for_function(f"Work.current.posts.length === {n + 1}", timeout=10000)
        last = pg.locator("#tposts .tmsg").last
        expect(last.locator("h1", has_text="Cutover steps").count() == 1, "heading lost")
        expect(last.locator("b", has_text="Stop").count() == 1, "bold lost")
        expect(last.locator("table td", has_text="srv-01").count() == 1, "table lost")
        expect(last.locator("a", has_text="Cutover plan.docx").count() == 1, "document not attached")

    @check("search lists files attached to threads")
    def _():
        ev("show('dashboard')")
        ev("() => { const s = document.querySelector('#search'); s.value = 'cert-check'; s.dispatchEvent(new Event('input', { bubbles: true })); }")
        pg.wait_for_selector("#board .card.tcard[data-tpost]", timeout=10000)
        expect("cert-check.png" in pg.inner_text("#board"), "file not listed")
        pg.click("#board .card.tcard[data-tpost]")
        pg.wait_for_function("document.querySelector('#view-tasks').classList.contains('active') && Work.current?.title.startsWith('OPS-77')", timeout=10000)
        ev("() => { const s = document.querySelector('#search'); s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); }")

    @check("UAT / PROD switch filters everywhere")
    def _():
        total = ev("S.entries.length")
        pg.click("#envSwitch [data-envsw=PROD]")
        pg.wait_for_timeout(300)
        envs = ev("[...new Set(S.entries.map(e => e.env))]")
        expect(envs == ["PROD"] and ev("S.entries.length") < total, f"PROD only expected, got {envs}")
        pg.click("#envSwitch [data-envsw=UAT]")
        pg.wait_for_timeout(300)
        expect(all(e.upper().startswith("UAT") for e in ev("S.entries.map(e => e.env)")), "UAT only expected")
        pg.click("#envSwitch [data-envsw='']")
        pg.wait_for_timeout(300)
        expect(ev("S.entries.length") == total, "All should show everything again")

    @check("capture button at the top pauses and resumes clipboard capture")
    def _():
        was = ev("!!S.settings.watch")
        pg.click("#capBtn"); pg.wait_for_timeout(500)
        expect(ev("!!S.settings.watch") == (not was), "capture not switched")
        expect(("Capture off" in pg.inner_text("#capBtn")) == was, "button label wrong")
        expect(ev("api('GET', '/api/settings').then(s => !!s.watch)") == (not was), "not saved")
        pg.click("#capBtn"); pg.wait_for_timeout(500)
        expect(ev("!!S.settings.watch") == was, "capture not switched back")

    @check("new capture: Test tries the connection, failure shows Needs attention")
    def _():
        ev("show('dashboard')")
        if ssh_off():  # new SSH captures just get ✓ OK; a new database is tested instead
            sid = ev("(S.entries.find(e => e.unsorted && canSSH(e) && !canDB(e) && !suggestPlace(e)) || {}).id")
            if sid:
                pg.wait_for_selector(f"#board [data-act=accept][data-id='{sid}']", timeout=5000)
                expect(not pg.query_selector(f"#board [data-act=trytest][data-id='{sid}']"), "Test offered for SSH while SSH is off")
            eid = ev("(S.entries.find(e => e.unsorted && canDB(e) && !suggestPlace(e)) || {}).id")
            if not eid:
                raise Skip("no new database capture in the demo")
        else:
            eid = ev("(S.entries.find(e => e.unsorted && canSSH(e) && !suggestPlace(e)) || {}).id")
        expect(eid, "no new SSH capture in the demo")
        btn = f"#board [data-act=trytest][data-id='{eid}']"
        pg.wait_for_selector(btn, timeout=5000)
        pg.click(btn)
        pg.wait_for_function(f"(e => e && !e.unsorted && e.status)(byId('{eid}'))", timeout=30000)
        st = ev(f"byId('{eid}').status")
        if st == "fail":
            pg.wait_for_selector(f"#board .warnchip.fail[data-id='{eid}']", timeout=5000)
        else:
            expect(st == "ok", f"status {st}")

    @check("SQL snippets save and insert (stand-in session)")
    def _():
        ev("""() => { const e = S.entries.find(x => canDB(x)); const t = { sid: 'smoke', entry: e, kind: 'oracle', info: { user: 'x' }, sql: '', out: '', result: null, objects: [] };
               SQL.tabs.push(t); show('sql'); SQL.activate(t); SQL.cm.setValue('select 42 from dual'); }""")
        n = ev("api('GET', '/api/snippets').then(l => l.length)")
        ev("api('POST', '/api/snippets', { name: 'smoke test', sql: 'select 42 from dual', conn: '' })")
        ev("SQL.showOut('snip')"); pg.wait_for_timeout(500)
        expect(ev("Snippets.list.length") == n + 1, "snippet not saved")
        sid = ev("Snippets.list.find(s => s.name === 'smoke test').id")
        ev(f"api('DELETE', '/api/snippets/{sid}')")
        ev("SQL.tabs = SQL.tabs.filter(t => t.sid !== 'smoke'); SQL.activate(SQL.tabs[0] || null)")

    @check("API page: send a request through WorkHub")
    def _():
        ev("show('api')"); pg.wait_for_timeout(400)
        ev("Api.edit(Api.blank(), true)")
        pg.fill("#apiURL", "http://127.0.0.1:47990/rest/api/2/serverInfo")
        pg.click("#apiSend")
        pg.wait_for_function("Api.resp && Api.resp.status > 0", timeout=15000)

    @check("compare two folders and two files")
    def _():
        d = os.path.join(SIM, "data", "reference", "smoke")
        os.makedirs(os.path.join(d, "A"), exist_ok=True); os.makedirs(os.path.join(d, "B"), exist_ok=True)
        open(os.path.join(d, "A", "x.properties"), "w").write("a=1\nb=2\n")
        open(os.path.join(d, "B", "x.properties"), "w").write("a=1\nb=3\n")
        ev("Compare.st = null")
        ev("Compare.open(Compare.ref('smoke/A'), Compare.ref('smoke/B'))")
        pg.wait_for_function("Compare.st && Compare.st.entries", timeout=10000)
        expect(ev("Compare.st.entries.find(e => e.rel === 'x.properties').status") == "diff", "files should differ")
        ev("Compare.openFiles(Compare.ref('smoke/A/x.properties'), Compare.ref('smoke/B/x.properties'))")
        pg.wait_for_function("Compare.st.mode === 'file'", timeout=10000)
        expect(ev("Compare.st.file.blocks.length") == 1, "one difference expected")
        close_dialogs()

    @check("compare a file on two servers (read-only)")
    def _():
        if ssh_off():
            raise Skip("SSH is switched off")
        lab = os.path.join(SIM, "lab")
        for n, v in (("acme-app-01", "1"), ("acme-bat-01", "2")):
            os.makedirs(os.path.join(lab, n, "conf"), exist_ok=True)
            open(os.path.join(lab, n, "conf", "smoke.properties"), "w").write(f"x={v}\npassword=p{v}\n")
        ev("Compare.st = null")  # not the previous check's result
        ev("""Compare.openFiles(Compare.remote(S.entries.find(e => e.port === 2222), 'conf/smoke.properties'),
                            Compare.remote(S.entries.find(e => e.port === 2223), 'conf/smoke.properties'))""")
        pg.wait_for_function("Compare.st && Compare.st.mode === 'file'", timeout=15000)
        expect(not pg.query_selector("#cmpDlg [data-cto]"), "copy buttons must be off for servers")
        expect("p1" not in pg.inner_text("#cmpDlg .cmp-files"), "password should be hidden")
        close_dialogs()

    @check("import connections from a PuTTY .reg file")
    def _():
        reg = ('Windows Registry Editor Version 5.00\r\n\r\n[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\smoke%20jump]\r\n'
               '"HostName"="smoke-jump.example.com"\r\n"UserName"="ops"\r\n"PortNumber"=dword:00000016\r\n"Protocol"="ssh"\r\n')
        import base64
        r = ev(f"api('POST', '/api/import/conns/read', {{ name: 'x.reg', content: '{base64.b64encode(reg.encode()).decode()}' }})")
        expect(r["source"] == "putty" and r["items"][0]["host"] == "smoke-jump.example.com", f"read: {r}")

    @check("SSH keys window switched off: ~/.ssh not read, menu items hidden")
    def _():
        if not ssh_keys_off():
            raise Skip("the SSH keys window is on")
        expect(ev("api('GET', '/api/sshkeys').then(r => r.off === true && !r.keys.length && !r.hosts.length)"), "~/.ssh was read")
        ev("SSHKeys.open()"); pg.wait_for_timeout(300)
        expect(not pg.is_visible("#sshKeysDlg"), "the keys window opened")
        ev("show('terminal')"); pg.wait_for_timeout(200)
        expect(not pg.is_visible("#view-terminal [data-tool=sshkeys]"), "🔑 Keys button shown")
        pg.click("#menubar [data-menu=Tools]"); pg.wait_for_timeout(200)
        expect("SSH keys" not in pg.inner_text("#ctxMenu"), "SSH keys in the Tools menu")
        pg.keyboard.press("Escape")

    @check("SSH keys window lists keys (read-only)")
    def _():
        if ssh_keys_off():
            raise Skip("the SSH keys window is switched off")
        ev("SSHKeys.open()"); pg.wait_for_timeout(600)
        expect(pg.is_visible("#sshKeysDlg"), "keys window")
        close_dialogs()

    @check("? shortcut sheet")
    def _():
        ev("document.activeElement && document.activeElement.blur()")
        pg.keyboard.press("?"); pg.wait_for_timeout(200)
        expect(ev("!!document.getElementById('keysDlg')?.open"), "sheet did not open")
        close_dialogs()

    @check("no page errors during the whole run")
    def _():
        expect(not errors, f"errors: {errors[:3]}")

    b.close()

failed = [r for r in results if not r[1]]
print(f"\n{len(results) - len(failed)} passed, {len(failed)} failed")
sys.exit(1 if failed else 0)
