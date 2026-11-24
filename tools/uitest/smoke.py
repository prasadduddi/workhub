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


def check(name):
    def wrap(fn):
        t = time.time()
        try:
            for f in BEFORE:
                f()
            fn()
            results.append((name, True, ""))
            print(f"  ✓ {name}  ({time.time() - t:.1f}s)")
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
        ev("show('terminal')")
        ev("Term.open(S.entries.find(e => e.port === 2222))")
        pg.wait_for_function("Term.tabs.some(t => !t.closed)", timeout=15000)
        pg.wait_for_timeout(800)
        expect(pg.query_selector("#view-terminal .tree-host .dot.live"), "no live dot in the tree")

    @check("pop out an SSH tab and dock it back")
    def _():
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
        ev("LogView.open(S.entries.find(e => e.port === 2222))"); pg.wait_for_timeout(400)
        pg.fill("#logPanel .lp-path", "app/logs/application.log"); pg.click("#logPanel [data-lp=follow]")
        pg.wait_for_function("LogView.lines.length > 50", timeout=15000)
        pg.click("#logPanel [data-lp=close]")

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

    @check("SSH keys window lists keys (read-only)")
    def _():
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
