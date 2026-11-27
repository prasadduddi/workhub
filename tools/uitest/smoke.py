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
    native = []  # the browser's own pop-ups ("127.0.0.1 says") — there should be none
    pg.on("dialog", lambda d: (native.append(d.type + ": " + d.message[:80]), d.accept()))
    # WorkHub's own yes/no box (askYes) replaces the browser's confirm(): OK it like the browser's was,
    # unless a check sets window.__askManual to answer it itself
    pg.add_init_script("""new MutationObserver(() => { if (window.__askManual) return;
        for (const d of document.querySelectorAll('dialog.askyes[open]')) d.querySelector('[data-ask=ok]')?.click(); })
        .observe(document, { childList: true, subtree: true });""")
    pg.goto(URL)
    pg.wait_for_function("typeof S !== 'undefined' && S.entries.length > 0", timeout=20000)
    pg.evaluate("document.querySelectorAll('dialog[open]').forEach(d => d.close())")
    ev = pg.evaluate
    ssh_off = lambda: bool(ev("S.sshOff"))
    ssh_keys_off = lambda: bool(ev("S.sshKeysOff"))
    close_dialogs = lambda: ev("document.querySelectorAll('dialog[open]').forEach(d => d.close())")
    pg.wait_for_timeout(9000)  # What's new opens a few seconds after a first start
    BEFORE.append(lambda: (close_dialogs(), pg.keyboard.press("Escape")))
    ev("EnvSwitch.set('ALL')")  # most checks use the lab servers (UAT); the default (Others) is checked on its own

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

    @check("Files: each server in its own tab; opening an open one switches to it")
    def _():
        if ssh_off():
            raise Skip("SSH is switched off")
        a, b = "S.entries.find(e => e.port === 2222)", "S.entries.find(e => e.port === 2223)"
        ev(f"Remote.connect({a})"); pg.wait_for_function("Remote.tabs.length === 1 && Remote.items.length > 0", timeout=15000)
        first_path = ev("Remote.path")
        ev(f"Remote.connect({b})"); pg.wait_for_function("Remote.tabs.length === 2 && Remote.tab === Remote.tabs[1]", timeout=15000)
        expect(pg.locator("#ftpTabs .ftab").count() == 2, "two tabs not shown")
        ev(f"Remote.connect({a})"); pg.wait_for_timeout(500)
        expect(ev("Remote.tabs.length") == 2 and ev("Remote.tab === Remote.tabs[0]"), "the open server got a new tab instead of switching")
        expect(ev("Remote.path") == first_path, "the tab lost its folder")
        pg.click("#ftpTabs [data-fx='1']"); pg.wait_for_timeout(300)
        expect(ev("Remote.tabs.length") == 1, "✕ didn't close the tab")
        ev("disconnectAll()"); pg.wait_for_timeout(300)
        expect(ev("Remote.tabs.length") == 0 and not ev("Remote.sid"), "Disconnect all left FTP open")

    @check("💬 Assistant: details or a screenshot + Send → 'I found … Add it?' → Yes creates it, with a message; clear")
    def _():
        ev("Chat.toggle(true)"); pg.wait_for_timeout(300)
        expect("anything you copy" in pg.inner_text("#chatLog"), "the Assistant doesn't say it asks first")
        n0 = ev("S.entries.length")
        pg.fill("#chatText", "Host: smoke-app-09.dev.acme.local  user: deploy  port 22\njdbc:oracle:thin:@smoke-ora-09.dev.acme.local:1521/SMK\nalso 10.0.0.9")
        expect(pg.locator("#chatLog .asq").count() == 0, "recognised before Send")
        pg.click("#chatSend")
        pg.wait_for_function("document.querySelectorAll('#chatLog .asq').length >= 3", timeout=10000)
        txt = pg.inner_text("#chatLog")
        expect("an SSH server" in txt and "an Oracle database" in txt, f"questions: {txt[-400:]}")
        pg.locator("#chatLog .asq", has_text="smoke-app-09").locator("[data-asyes]").click()
        pg.wait_for_function("/Connection created/.test(document.querySelector('#chatLog').textContent)", timeout=10000)
        pg.wait_for_function(f"S.entries.length === {n0} + 1", timeout=10000)
        e = ev("S.entries.find(e => e.host === 'smoke-app-09.dev.acme.local')")
        expect(e and e["username"] == "deploy" and not e.get("unsorted"), f"created: {e}")
        pg.locator("#chatLog .asq", has_text="10.0.0.9").locator("[data-asno]").click(); pg.wait_for_timeout(200)
        expect("Not added" in pg.locator("#chatLog .asq", has_text="10.0.0.9").inner_text(), "No didn't answer")
        pg.fill("#chatText", "find picasso"); pg.click("#chatSend"); pg.wait_for_timeout(500)  # a command stays a command
        expect(pg.locator("#chatLog .asq").count() == 3, "a command was taken for details")
        if ev("AsstCapture.ocr"):  # a pasted screenshot waits, then is read with the system's OCR on Send
            ev("""(async () => { const c = Object.assign(document.createElement('canvas'), { width: 900, height: 120 }); const x = c.getContext('2d');
                x.fillStyle = '#fff'; x.fillRect(0, 0, 900, 120); x.fillStyle = '#000'; x.font = '26px Arial';
                x.fillText('jdbc:oracle:thin:@shot-ora-77.uat.acme.local:1521/SHOT', 20, 70);
                const blob = await new Promise(r => c.toBlob(r, 'image/png')); const dt = new DataTransfer(); dt.items.add(new File([blob], 'shot.png', { type: 'image/png' }));
                document.querySelector('#chatText').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()""")
            pg.wait_for_selector("#asImg", timeout=5000)
            expect(not pg.locator("#chatLog", has_text="shot-ora-77").count(), "read before Send")
            pg.click("#chatSend")
            pg.wait_for_function("/shot-ora-77/.test(document.querySelector('#chatLog').textContent)", timeout=20000)
            expect("In your screenshot" in pg.inner_text("#chatLog") and not pg.query_selector("#asImg"), "screenshot not read on Send")
        pg.fill("#chatText", "clear"); pg.click("#chatSend"); pg.wait_for_timeout(200)
        expect(ev("document.querySelector('#chatLog').children.length") == 0, "clear left the conversation")
        ev("Chat.toggle(false)")

    @check("double-click on empty space in the left menu toggles its size")
    def _():
        was = ev("document.body.classList.contains('side-collapsed')")
        empty = """(() => { const s = document.querySelector('.side'), r = s.getBoundingClientRect();
            for (let y = r.bottom - 10; y > r.top + 40; y -= 6) for (const x of [r.left + 12, r.left + r.width / 2])
              if (document.elementFromPoint(x, y) === s) return [x, y];
            return null; })()"""
        for step, want in (("first", not was), ("second", was)):
            pt = ev(empty)
            expect(pt, f"no empty space found in the menu ({step} double-click)")
            pg.mouse.dblclick(pt[0], pt[1]); pg.wait_for_timeout(300)
            expect(ev("document.body.classList.contains('side-collapsed')") == want, f"the {step} double-click didn't toggle the menu")
        # (a page entry is not empty space: clicking the page you are on already toggles the menu, so it's left out here)
        if ev("document.body.classList.contains('side-collapsed')"):
            pg.click("#sideToggle"); pg.wait_for_timeout(200)  # leave the menu open for the next checks

    @check("Files: columns resize by dragging a heading's edge (kept); a drag doesn't sort")
    def _():
        ev("show('files')"); pg.wait_for_function("document.querySelectorAll('#localPane .fhead span').length === 4", timeout=10000)
        sort0 = ev("JSON.stringify(Local.sortBy)")
        type_w = pg.locator("#localPane .fhead span").nth(1).bounding_box()["width"]
        g = pg.locator("#localPane .fhead .fgrip[data-fcol='1']").bounding_box()
        pg.mouse.move(g["x"] + 4, g["y"] + g["height"] / 2); pg.mouse.down(); pg.mouse.move(g["x"] + 84, g["y"] + g["height"] / 2, steps=5); pg.mouse.up(); pg.wait_for_timeout(200)
        new_w = pg.locator("#localPane .fhead span").nth(1).bounding_box()["width"]
        expect(abs(new_w - (type_w + 80)) < 12, f"Type column {type_w} → {new_w}, wanted +80")
        expect(abs(pg.locator("#localPane .frow .ty").first.bounding_box()["width"] - new_w) < 4, "rows don't follow the heading")
        expect(ev("JSON.stringify(Local.sortBy)") == sort0, "the drag also sorted")
        expect(ev("store.get('fcols.localPane', null)") is not None, "width not remembered")
        pg.locator("#localPane .fhead .fgrip[data-fcol='1']").dblclick(); pg.wait_for_timeout(200)
        expect(abs(pg.locator("#localPane .fhead span").nth(1).bounding_box()["width"] - type_w) < 6, "double-click didn't restore the default")

    @check("✨ What's new sits after the version (bottom left); naming rules live in Settings → Connections")
    def _():
        expect(ev("document.querySelector('#whatsNewTop')?.parentElement?.classList.contains('ver-row')"), "✨ isn't after the version")
        pg.click("#whatsNewTop"); pg.wait_for_timeout(400)
        expect(ev("document.querySelector('#whatsNewDlg').open"), "✨ didn't open What's new")
        close_dialogs()
        ev("show('terminal')"); pg.wait_for_timeout(200)
        expect(not pg.query_selector("#view-terminal [data-tool=rules]"), "🏷 Names still on the tree")
        pg.click("#settingsTop"); pg.wait_for_timeout(400); pg.click("[data-settab=connections]")
        pg.click("#settingsBody [data-set=namerules]"); pg.wait_for_timeout(300)
        expect(ev("document.querySelector('#nameRulesDlg').open"), "Settings → Connections → Naming rules didn't open")
        close_dialogs()

    @check("🎨 a connection's background colour in the tree (kept by the edit dialog, removable)")
    def _():
        ev("show('terminal')"); pg.wait_for_timeout(300)
        eid = ev("S.entries.find(e => e.port === 2222).id")
        node = pg.locator(f"#view-terminal .tnode.item[data-id='{eid}']").first
        node.click(button="right"); pg.wait_for_timeout(300)
        expect("Background colour" in pg.inner_text("#ctxMenu"), "no Background colour in the menu")
        pg.keyboard.press("Escape")
        ev(f"setEntryColor(byId('{eid}'), '#4caf50')"); pg.wait_for_timeout(600)
        row = pg.locator(f"#view-terminal .tnode.item[data-id='{eid}']").first
        expect("tinted" in (row.get_attribute("class") or "") and "#4caf50" in (row.get_attribute("style") or ""), "row not tinted")
        ev(f"openEntryDialog(byId('{eid}'))"); pg.wait_for_timeout(300)
        expect("color" not in ev("document.querySelector('#entryForm').extra.value"), "colour shown as a field")
        body = ev("entryFormBody()")
        expect((body.get("extra") or {}).get("color") == "#4caf50", "the edit dialog would drop the colour")
        close_dialogs()
        ev(f"setEntryColor(byId('{eid}'), '')"); pg.wait_for_timeout(600)
        expect("tinted" not in (pg.locator(f"#view-terminal .tnode.item[data-id='{eid}']").first.get_attribute("class") or ""), "colour not removed")

    @check("the left menu slides when it opens and closes")
    def _():
        ev("show('dashboard')")
        pg.click("#sideToggle")
        tr = ev("getComputedStyle(document.querySelector('.side')).transitionProperty")
        expect("width" in tr, f"no slide: transition {tr}")
        pg.wait_for_timeout(400)
        expect(ev("getComputedStyle(document.querySelector('.side')).transitionProperty") in ("all", "none") or not ev("document.body.classList.contains('side-anim')"), "still animating afterwards")
        pg.click("#sideToggle"); pg.wait_for_timeout(400)

    @check("💬 Assistant starts below the search bar and resizes by its left edge (remembered)")
    def _():
        ev("Chat.toggle(true)"); pg.wait_for_timeout(300)
        chat, srch = pg.locator("#chat").bounding_box(), pg.locator("#search").bounding_box()
        expect(chat["y"] >= srch["y"] + srch["height"], f"Assistant covers the search: chat top {chat['y']} vs search bottom {srch['y'] + srch['height']}")
        pg.click("#search"); expect(ev("document.activeElement.id") == "search", "the search can't be used with the Assistant open")
        g = pg.locator("#chat .chat-grip").bounding_box()
        pg.mouse.move(g["x"] + 4, g["y"] + 200); pg.mouse.down(); pg.mouse.move(g["x"] - 116, g["y"] + 200, steps=5); pg.mouse.up(); pg.wait_for_timeout(200)
        w = pg.locator("#chat").bounding_box()["width"]
        expect(abs(w - (chat["width"] + 120)) < 12, f"resize: {chat['width']} → {w}")
        expect(abs(ev("store.get('chatW', 0)") - w) < 3, "width not remembered")
        pg.locator("#chat .chat-grip").dblclick(); pg.wait_for_timeout(200)
        ev("Chat.toggle(false)")

    @check("threads: open one with a screenshot")
    def _():
        ev("show('tasks')")
        pg.wait_for_function("Work.list.length > 3", timeout=10000)
        ev("Work.open(Work.list.find(w => w.images > 0).id)")
        pg.wait_for_function("[...document.querySelectorAll('#taskMain img')].some(i => i.complete && i.naturalWidth > 0)", timeout=10000)

    @check("🔍 search inside a thread: marks, counts, Enter moves, only matches, Esc clears")
    def _():
        ev("show('tasks')")
        tid = ev("Work.list.find(w => w.title.startsWith('Incident')).id")
        ev(f"Work.open('{tid}')"); pg.wait_for_timeout(600)
        pg.keyboard.press("Control+f"); pg.wait_for_timeout(100)
        expect(ev("document.activeElement.id") == "tfindIn", "Ctrl+F didn't go to the thread search")
        pg.keyboard.type("deadlock"); pg.wait_for_function("document.querySelectorAll('#taskMain mark.tfind').length > 0", timeout=3000)
        n = ev("Work.find.ids.length")
        expect(n >= 1, f"no matches")
        expect(pg.inner_text("#tfindN").strip() == f"1 / {n}", f"counter: {pg.inner_text('#tfindN')!r}")
        if n > 1:
            pg.keyboard.press("Enter"); pg.wait_for_timeout(200)
            expect(pg.inner_text("#tfindN").strip() == f"2 / {n}", "Enter didn't move to the next match")
        total = pg.locator("#tposts .tmsg").count()
        pg.check("#tfindOnly"); pg.wait_for_timeout(200)
        visible = ev("[...document.querySelectorAll('#tposts .tmsg')].filter(m => m.offsetParent).length")
        expect(visible < total or visible == n, f"only matches: {visible} of {total} shown")
        pg.uncheck("#tfindOnly")
        pg.focus("#tfindIn"); pg.keyboard.press("Escape"); pg.wait_for_timeout(200)
        expect(pg.locator("#taskMain mark.tfind").count() == 0 and ev("Work.find.q") == "", "Esc didn't clear")

    @check("Teams without setup: Forward opens a Teams chat link with the text; Add from Teams adds what was copied")
    def _():
        ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin=URL.split("/?")[0])
        ev("show('tasks')")
        tid = ev("Work.list.find(w => w.title.startsWith('PAY-205')).id")
        ev(f"Work.open('{tid}')"); pg.wait_for_timeout(600)
        ev("window._opened = []; window.openExternal = u => _opened.push(u); 0")
        msg = pg.locator("#tposts .tmsg.k-note").first
        msg.click(button="right"); pg.wait_for_timeout(200)
        pg.click("#ctxMenu button:has-text('Forward to Teams')"); pg.wait_for_selector(".askbox")
        pg.keyboard.type("bob@acme.example.com"); pg.keyboard.press("Enter"); pg.wait_for_timeout(1500)
        opened = ev("_opened")
        expect(opened and opened[0].startswith("https://teams.microsoft.com/l/chat/0/0?users=bob%40acme.example.com&message="), f"opened: {opened}")
        expect(ev("Teams.recent()[0]") == "bob@acme.example.com", "recipient not remembered")
        n = ev("Work.current.posts.length")
        # what was copied in Teams, as WorkHub's own clipboard read returns it (never the real clipboard in a test)
        pg.route("**/api/clipboard/html", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps({"html": "<p><b>Bob</b>: restarted app-01</p>", "text": "Bob: restarted app-01"})))
        ev("window._clipAsked2 = 0; const r2 = navigator.clipboard.read.bind(navigator.clipboard); navigator.clipboard.read = () => (window._clipAsked2++, r2()); 0")
        ev("Teams.addFrom()"); pg.wait_for_function(f"Work.current.posts.length === {n} + 1", timeout=5000)
        pg.unroute("**/api/clipboard/html")
        expect(ev("window._clipAsked2") == 0, "Add from Teams asked the browser for the clipboard (Allow / Block box)")
        last = ev("Work.current.posts[Work.current.posts.length - 1]")
        expect(last["from"] == "Teams" and "restarted app-01" in last["html"], f"added: {last}")

    @check("⚙ Settings → Teams: tenant and client saved; sign-in asks for them first")
    def _():
        pg.click("#settingsTop"); pg.wait_for_timeout(400); pg.click("[data-settab=teams]"); pg.wait_for_timeout(300)
        expect("For IT" in pg.inner_text("#settingsBody") and pg.is_visible("[data-set='teams-tenant']"), "no Teams section")
        pg.fill("[data-set='teams-tenant']", "contoso.example"); pg.dispatch_event("[data-set='teams-tenant']", "change"); pg.wait_for_timeout(500)
        expect(ev("api('GET', '/api/teams/status').then(s => s.tenant)") == "contoso.example", "tenant not saved")
        r = ev("api('POST', '/api/teams/signin').then(() => 'ok', e => e.message)")
        expect("Client ID" in r, f"sign-in without client: {r}")
        ev("api('PUT', '/api/teams/config', { tenant: '', client_id: '' })")
        close_dialogs()

    @check("+ Attach: copied script saved as a file on the thread (card, View, edit, Copy), not as message text")
    def _():
        ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin=URL.split("/?")[0])
        ev("show('tasks')")
        tid = ev("Work.list.find(w => w.title.startsWith('PAY-205')).id")
        ev(f"Work.open('{tid}')"); pg.wait_for_timeout(600)
        script = "#!/bin/bash\n# restart batch\ncd /opt/batch && ./stop.sh\n./start.sh\n"
        # the text comes from WorkHub's own clipboard read (no browser Allow / Block box): give it the script
        ev(f"window._clipAsked = 0; const r = navigator.clipboard.readText.bind(navigator.clipboard); navigator.clipboard.readText = () => (window._clipAsked++, r()); window.clipText = async () => {script!r}; 0")
        expect(isinstance(ev("api('GET', '/api/clipboard/text').then(r => typeof r.text)"), str), "no native clipboard read")
        n = ev("Work.current.posts.length")
        pg.click("#tplus"); pg.wait_for_timeout(200)
        pg.click("#ctxMenu button:has-text('Attach copied text')"); pg.wait_for_selector("#snipDlg[open]")
        expect(pg.input_value("#snipText") == script.replace("\\n", "\n"), f"clipboard not pasted: {pg.input_value('#snipText')!r}")
        expect(ev("window._clipAsked") == 0, "the page asked the browser for the clipboard (Allow / Block box)")
        name = pg.input_value("#snipName")
        expect(name.startswith("script-") and name.endswith(".sh"), f"name: {name}")
        pg.fill("#snipNote", "restart script")
        pg.click("[data-snip=save]"); pg.wait_for_function(f"Work.current.posts.length === {n} + 1", timeout=5000)
        last = ev("Work.current.posts[Work.current.posts.length - 1]")
        expect("/api/props/files/" in last["html"] and name in last["html"] and "stop.sh" not in last["html"], f"post: {last['html'][:200]}")
        card = pg.locator(f"#tposts [data-post='{last['id']}'] .tatt")
        expect(card.count() == 1 and card.locator("[data-att=view]").count() == 1, "no attachment card")
        card.locator("[data-att=view]").click(); pg.wait_for_selector("#attView[open]")
        expect("./start.sh" in pg.input_value("#attView textarea.av-text"), "viewer text")
        expect(ev("document.querySelector('#attView textarea.av-text').cm.getOption('mode')") == "text/x-sh", "viewer not coloured as a shell script")
        expect(pg.locator("#attView .CodeMirror .cm-comment").count() >= 1, "no highlighted comment in the viewer")
        ev("document.querySelector('#attView textarea.av-text').cm.setValue('echo changed\\n')"); pg.wait_for_timeout(100)
        pg.click("#attView [data-av=save]"); pg.wait_for_timeout(400)
        pg.click("#attView [data-av=close]")
        card.locator("[data-att=copy]").click(); pg.wait_for_timeout(400)
        expect(ev("navigator.clipboard.readText()") == "echo changed\n", "Copy didn't give the saved text")
        expect(ev("guessSnippetName('SELECT * FROM dual')").endswith(".sql") and ev("guessSnippetName('{\"a\": 1}')").endswith(".json"), "name guessing")

    @check("threads use the bundled Lato (Slack's type): 15px body, black names, fonts load")
    def _():
        ev("show('tasks')")
        tid = ev("Work.list.find(w => w.title.startsWith('Incident')).id")
        ev(f"Work.open('{tid}')"); pg.wait_for_timeout(600)
        st = ev("""(async () => { await document.fonts.ready; const b = document.querySelector('#tposts .tbody'), n = document.querySelector('#tposts .tname');
            const scale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
            return { fam: getComputedStyle(b).fontFamily, px: parseFloat(getComputedStyle(b).fontSize) / scale, w: getComputedStyle(n).fontWeight,
              ok: document.fonts.check('900 15px "WH Lato"') && document.fonts.check('15px "WH Lato"'),
              loaded: [...document.fonts].filter(f => f.family.includes('WH Lato') && f.status === 'loaded').length }; })()""")
        expect(st["fam"].startswith('"WH Lato"') and abs(st["px"] - 15) < 0.2 and st["w"] == "900", f"style: {st}")
        expect(st["loaded"] >= 2, f"Lato not loaded: {st}")

    @check("thread order: oldest first by default; newest first only for the thread where it was chosen")
    def _():
        ev("localStorage.setItem('threadOrder', 'desc'); localStorage.removeItem('threadNewest'); 0")  # an old all-threads choice is cleared
        ev("show('tasks')")
        tid = ev("Work.list.find(w => w.title.startsWith('Incident')).id")
        ev(f"Work.open('{tid}')"); pg.wait_for_timeout(500)
        first = lambda: ev("document.querySelector('#tposts .tmsg')?.dataset.post")
        old = first(); pg.click("#torder"); pg.wait_for_timeout(300)
        expect("Newest" in pg.inner_text("#torder") and first() != old, "newest first didn't change the order")
        other = ev(f"Work.list.find(w => w.id !== '{tid}' && w.title.startsWith('PAY-201')).id")
        ev(f"Work.open('{other}')"); pg.wait_for_timeout(500)
        expect("Oldest" in pg.inner_text("#torder"), "another thread should stay oldest first")
        ev(f"Work.open('{tid}')"); pg.wait_for_timeout(500)
        expect("Newest" in pg.inner_text("#torder"), "the thread should keep its own newest first")
        top = ev("[...Work.current.posts].filter(p => !p.parent).sort((a, b) => new Date(b.at) - new Date(a.at))[0].id")
        expect(first() == top, "the newest message isn't at the top")
        y = lambda sel: ev(f"document.querySelector('{sel}').getBoundingClientRect().top")
        expect(y("#taskMain .tcompose") < y("#tposts"), "newest first: the message box should be above the messages")
        pg.click("#torder"); pg.wait_for_timeout(300)
        expect("Oldest" in pg.inner_text("#torder") and first() == old, "back to oldest first")
        expect(y("#taskMain .tcompose") > y("#tposts"), "oldest first: the message box should be below the messages")

    @check("sub-threads: drag a thread onto another; searching the parent finds messages in its sub-threads")
    def _():
        ev("show('tasks')")
        par = ev("Work.list.find(w => w.title.startsWith('PAY-201')).id")
        kid = ev("Work.list.find(w => w.title.startsWith('Incident')).id")
        src = pg.locator(f"#workList [data-work='{kid}']"); dst = pg.locator(f"#workList [data-work='{par}']")
        src.drag_to(dst); pg.wait_for_timeout(800)
        expect(ev(f"Work.list.find(w => w.id === '{kid}').parent") == par, "drop didn't make it a sub-thread")
        expect(ev(f"document.querySelector('#workList [data-work=\"{kid}\"]').classList.contains('sub')"), "not indented under its thread")
        ev(f"Work.open('{par}')"); pg.wait_for_timeout(500)
        pg.fill("#tfindIn", "deadlock"); pg.dispatch_event("#tfindIn", "input")
        pg.wait_for_selector("#tfindSub:not([hidden]) .tfs-row", timeout=5000)
        expect("sub-thread" in pg.inner_text("#tfindN") and pg.locator("#tfindSub mark.tfind").count() > 0, f"counter: {pg.inner_text('#tfindN')}")
        pg.locator("#tfindSub .tfs-row").first.click(); pg.wait_for_timeout(700)
        expect(ev("Work.current.id") == kid and ev("Work.find.q") == "deadlock", "clicking a sub-thread match didn't open it there")
        # a loop is refused; back to the top level
        r = ev(f"api('POST', '/api/work/{par}/parent', {{ parent: '{kid}' }}).then(() => 'ok', e => e.message)")
        expect("itself" in r, f"a loop was allowed: {r}")
        ev(f"Work.setParent('{kid}', '')"); pg.wait_for_timeout(500)
        expect(not ev(f"Work.list.find(w => w.id === '{kid}').parent"), "back to the top level failed")

    @check("⧉ Only this thread: its own window without the thread list; connections: Open in its own window")
    def _():
        ev("show('tasks')")
        tid = ev("Work.list.find(w => w.title.startsWith('PAY-205')).id")
        ev(f"Work.open('{tid}')"); pg.wait_for_timeout(500)
        expect(pg.is_visible("#workPop") and pg.locator("[data-tact=popout]").count() == 0, "⧉ New window should be over the thread list, not in the thread")
        with ctx.expect_page() as pw:
            pg.click("[data-tact=popone]")
        w = pw.value
        w.wait_for_function("typeof Work !== 'undefined' && Work.current", timeout=15000); w.wait_for_timeout(500)
        expect(w.evaluate("document.body.classList.contains('pop-single') && !document.querySelector('.tasks-side').offsetParent"), "thread list still shown")
        expect(w.evaluate(f"Work.current.id") == tid, "wrong thread")
        w.click("#popDock"); pg.wait_for_timeout(800)
        expect(w.is_closed() and pg.locator("#popChips .popchip").count() == 0, "didn't dock back")
        e = ev("S.entries.find(e => canSSH(e))?.id")
        if e:
            ev(f"show('terminal'); Tree.menu({{ clientX: 300, clientY: 300 }}, document.querySelector('#view-terminal [data-id=\"{e}\"]') || {{ dataset: {{ id: '{e}' }} }}, 'ssh')"); pg.wait_for_timeout(300)
            expect(pg.locator("#ctxMenu button:has-text('Open in its own window')").count() == 1, "no 'Open in its own window' on a connection")
            pg.keyboard.press("Escape")

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

    @check("✎ Edit on a clipboard capture: real text, still a capture; on a server card: the connection")
    def _():
        ev("show('tasks')")
        find = lambda test: ev(f"""(async () => {{ for (const w of Work.list) {{ const d = await api('GET', '/api/work/' + w.id);
                    if (d.posts.some(p => {test})) return w.id; }} return ''; }})()""")
        tid = find("p.kind === 'capture' && !p.html")
        expect(tid, "no demo thread with a clipboard capture")
        ev(f"Work.open('{tid}')"); pg.wait_for_timeout(500)
        cap = pg.locator("#tposts .tmsg.k-capture").first
        cap.scroll_into_view_if_needed(); cap.hover(); pg.wait_for_timeout(200)
        first = cap.locator(".thover button").first
        expect("Edit" in first.inner_text(), f"capture's first button: {first.inner_text()!r}")
        pid = cap.get_attribute("data-post")
        raw = ev(f"Work.current.posts.find(p => p.id === '{pid}').text")
        first.click(); pg.wait_for_timeout(200)
        expect(pg.inner_text(f"#tposts [data-post='{pid}'] .tbody").strip() == raw.strip(), "edit box doesn't hold the real text")
        pg.evaluate(f"(() => {{ const pre = document.querySelector(\"#tposts [data-post='{pid}'] .tedit-pre\"); pre.textContent += '\\nchecked by smoke'; }})()")
        pg.click(f"#tposts [data-post='{pid}'] [data-pact=save-edit]"); pg.wait_for_timeout(400)
        saved = ev(f"api('GET', '/api/work/{tid}').then(d => d.posts.find(p => p.id === '{pid}'))")
        expect(saved["kind"] == "capture" and saved["text"].endswith("checked by smoke") and not saved.get("html"), f"saved: {saved}")
        expect(saved["text"].startswith(raw.rstrip()), "the original text (passwords included) was changed")
        eid = find("p.kind === 'entry'")
        if not eid:  # the demo has no server card in a thread: post one
            eid = tid
            ev(f"api('POST', '/api/work/{tid}/posts', {{ kind: 'entry', ref: S.entries.find(e => e.port === 2222).id }})")
        ev(f"Work.open('{eid}')"); pg.wait_for_timeout(500)
        card = pg.locator("#tposts .tmsg.k-entry").first
        card.scroll_into_view_if_needed(); card.hover(); pg.wait_for_timeout(200)
        card.locator(".thover button").first.click(); pg.wait_for_timeout(400)
        expect(ev("!!document.querySelector('dialog[open]')"), "the connection didn't open for editing")
        close_dialogs()

    @check("pictures in messages: drag the corner to resize; right-click → Copy image; ⋯ → 📋 Copy (text + picture)")
    def _():
        ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin=URL.split("/?")[0])
        ev("show('tasks')")
        tid = ev("Work.list.find(w => w.images > 0).id")
        ev(f"Work.open('{tid}')"); pg.wait_for_timeout(600)
        img = pg.locator("#tposts .tmsg.k-note .tbody img").first
        img.scroll_into_view_if_needed(); pg.wait_for_function("[...document.querySelectorAll('#tposts .tbody img')].some(i => i.complete && i.naturalWidth > 0)", timeout=10000)
        pid = img.evaluate("i => i.closest('[data-post]').dataset.post")
        b = img.bounding_box()
        pg.mouse.move(b["x"] + b["width"] - 6, b["y"] + b["height"] - 6); pg.mouse.down()
        pg.mouse.move(b["x"] + b["width"] - 120, b["y"] + b["height"] - 6, steps=5); pg.mouse.up(); pg.wait_for_timeout(600)
        html = ev(f"api('GET', '/api/work/{tid}').then(d => d.posts.find(p => p.id === '{pid}').html)")
        import re
        m = re.search(r'width="(\d+)"', html)
        expect(m and abs(int(m.group(1)) - (b["width"] - 114)) < 12, f"resized width not saved: {m and m.group(1)} vs {b['width'] - 114}")
        img = pg.locator(f"#tposts [data-post='{pid}'] .tbody img").first
        img.click(button="right"); pg.wait_for_timeout(300)
        menu = pg.inner_text("#ctxMenu")
        expect("Copy image" in menu and "Original size" in menu and "📋 Copy" in menu and "Copy text" not in menu, f"menu: {menu[:200]}")
        pg.click("#ctxMenu button:has-text('Original size')"); pg.wait_for_timeout(600)
        expect("width=" not in ev(f"api('GET', '/api/work/{tid}').then(d => d.posts.find(p => p.id === '{pid}').html)"), "Original size kept the width")
        ev(f"(() => {{ const el = document.querySelector(\"#tposts [data-post='{pid}']\"); copyPost(Work.current.posts.find(p => p.id === '{pid}'), el); }})()"); pg.wait_for_timeout(1500)
        types = ev("navigator.clipboard.read().then(items => items.flatMap(i => i.types))")
        expect("image/png" in types and ("text/html" in types or "text/plain" in types), f"clipboard: {types}")

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
        pg.click("#envSwitch [data-envsw=ALL]")
        pg.wait_for_timeout(300)
        expect(ev("S.entries.length") == total, "All should show everything again")

    @check("search: thread results full width, with the matching messages (who, when, highlighted) that open the thread there")
    def _():
        ev("show('dashboard')"); pg.wait_for_function("!document.body.classList.contains('side-anim')", timeout=3000); pg.wait_for_timeout(100)
        pg.fill("#search", "deadlock"); pg.dispatch_event("#search", "input")
        pg.wait_for_selector("#board .tresult .thit", timeout=10000); pg.wait_for_timeout(300)  # drawn again when the matches arrive
        card = pg.locator("#board .tresult").first
        expect(card.bounding_box()["width"] > 700, "the thread card is still narrow")
        hit = card.locator(".thit").first
        expect(hit.locator("mark").count() > 0, "the search word isn't highlighted")
        tid, pid = hit.get_attribute("data-thread"), hit.get_attribute("data-tpost")
        hit.click(); pg.wait_for_timeout(600)
        expect(ev("Work.current?.id") == tid, "didn't open that thread")
        pg.fill("#search", ""); pg.dispatch_event("#search", "input"); ev("show('dashboard')")

    @check("💬 Assistant button sits next to ● Capturing")
    def _():
        expect(ev("document.querySelector('#capBtn').previousElementSibling?.id === 'chatFab' || document.querySelector('#capBtn').nextElementSibling?.id === 'chatFab'"), "💬 isn't next to Capturing")
        pg.click("#chatFab"); pg.wait_for_timeout(200)
        expect(not ev("document.querySelector('#chat').hidden"), "💬 didn't open the Assistant")
        pg.click("#chatFab"); pg.wait_for_timeout(200)

    @check("+ New thread asks in WorkHub's own box, right of the click (not the browser's prompt)")
    def _():
        ev("show('tasks')"); pg.wait_for_timeout(300); pg.wait_for_function("!document.body.classList.contains('side-anim')", timeout=3000); pg.wait_for_timeout(100)  # the menu has finished sliding
        n = ev("Work.list.length")
        b = pg.locator("#workNew").bounding_box()
        pg.mouse.click(b["x"] + 20, b["y"] + 10); pg.wait_for_selector(".askbox", timeout=3000)
        box = pg.locator(".askbox").bounding_box()
        expect(box["x"] >= b["x"] + 20 and abs(box["y"] - (b["y"] - 2)) < 40, f"box not right of the click: {box} vs click {b['x'] + 20},{b['y'] + 10}")
        pg.keyboard.type("SMOKE-1 thread from the box"); pg.keyboard.press("Enter")
        pg.wait_for_function(f"Work.list.length === {n} + 1", timeout=5000)
        pg.wait_for_function("Work.current?.title === 'SMOKE-1 thread from the box'", timeout=5000)  # it opens a moment later
        pg.click("#workNew"); pg.wait_for_selector(".askbox"); pg.keyboard.press("Escape"); pg.wait_for_timeout(200)
        expect(not pg.query_selector(".askbox") and ev("Work.list.length") == n + 1, "Esc didn't cancel")

    @check("File → + New ▸ holds the new items (connection, thread, note, API request)")
    def _():
        pg.click("#menubar [data-menu=File]"); pg.wait_for_timeout(200)
        top = ev("[...document.querySelectorAll('#ctxMenu > button, #ctxMenu > .ctxsub > .ctxsub-btn')].map(b => b.textContent.trim())")
        expect(not any(t.startswith("+ New ") for t in top) and any(t.startswith("+ New") for t in top), f"File menu: {top}")
        pg.hover("#ctxMenu .ctxsub-btn:has-text('+ New')"); pg.wait_for_timeout(200)
        sub = pg.inner_text("#ctxMenu .ctxsub:has(.ctxsub-btn:has-text('+ New')) .ctxsub-menu")
        expect(all(x in sub for x in ["Connection", "Thread", "Note", "API request"]), f"+ New ▸: {sub}")
        pg.click("#ctxMenu .ctxsub-menu button:has-text('Connection')"); pg.wait_for_timeout(300)
        expect(ev("!!document.querySelector('dialog[open]')"), "New → Connection didn't open the dialog")
        close_dialogs()

    @check("server trees name connections hostname-username-sid")
    def _():
        ev("show('terminal')"); pg.wait_for_timeout(300)
        e = ev("S.entries.find(x => canSSH(x) && !canDB(x) && x.username && x.host && !x.host.startsWith('127.'))")
        row = pg.locator(f"#view-terminal .tnode.item[data-id='{e['id']}'] .nm").first
        expect(row.inner_text().strip().startswith(f"{e['host']}-{e['username']}"), f"SSH row: {row.inner_text()!r}")
        ev("show('files')"); pg.wait_for_timeout(300)
        f = ev("S.entries.find(x => canFiles(x) && isFTP(x) && x.username && x.host)") or ev("S.entries.find(x => canFiles(x) && x.username && x.host && !x.host.startsWith('127.'))")
        row = pg.locator(f"#view-files .tnode.item[data-id='{f['id']}'] .nm").first
        expect(row.inner_text().strip().startswith(f"{f['host']}-{f['username']}"), f"FTP row: {row.inner_text()!r}")
        ev("show('sql')"); pg.wait_for_timeout(300)
        d = ev("S.entries.find(x => canDB(x) && x.username && dbService(x))")
        if d:
            want = f"{d['host']}-{d['username']}-" + ev(f"dbService(byId('{d['id']}')).name")
            row = pg.locator(f"#view-sql .tnode.item[data-id='{d['id']}'] .nm").first
            expect(row.inner_text().strip().startswith(want), f"DB row: {row.inner_text()!r}, want {want}")
        ev("show('dashboard')")

    @check("search highlights every matching word in yellow (cards, notes, files, threads)")
    def _():
        ev("show('dashboard')"); ev("EnvSwitch.set('ALL')")
        pg.fill("#search", "picasso"); pg.dispatch_event("#search", "input"); pg.wait_for_timeout(800)
        marks = ev("[...document.querySelectorAll('#board mark')].map(m => m.textContent.toLowerCase())")
        expect(len(marks) >= 3 and all("picasso" in m for m in marks), f"marks: {marks[:5]}")
        expect(pg.evaluate("getComputedStyle(document.querySelector('#board mark')).backgroundColor") not in ("rgba(0, 0, 0, 0)", "transparent"), "marks not coloured")
        pg.fill("#search", ""); pg.dispatch_event("#search", "input")

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
        ev("show('dashboard')"); ev("Home.set(true)")  # the cards are in the full list
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
        ev("Home.set(false)")

    @check("Dashboard overview: recent connections and links, pinned, full list one click away")
    def _():
        ev("Home.set(false)"); ev("show('dashboard')")
        ev("""async () => { const l = S.entries.find(e => e.url && !isConn(e)); await api('POST', '/api/entries/' + l.id + '/opened'); await poll(); }""")
        pg.wait_for_timeout(600)
        expect(pg.is_visible("#today [data-tlink]"), "no Recent links")
        expect(pg.locator("#board .card").count() == 0, "the full list is on the overview")
        expect(not pg.is_visible("#viewBtn"), "View button on the overview")
        pg.click("[data-homeall='1']"); pg.wait_for_timeout(300)
        expect(pg.locator("#board .card").count() > 10 and pg.inner_html("#today") == "", "full list didn't open")
        pg.click("[data-homeall='0']"); pg.wait_for_timeout(300)
        expect(pg.locator("#board .card").count() == 0, "didn't go back to the overview")
        pg.fill("#search", "picasso"); pg.dispatch_event("#search", "input"); pg.wait_for_timeout(400)
        expect(pg.locator("#board .card").count() > 0, "search shows no results")
        pg.fill("#search", ""); pg.dispatch_event("#search", "input")

    @check("Tools → Outlook monitoring opens the mail panel")
    def _():
        pg.click("#menubar [data-menu=Tools]"); pg.wait_for_timeout(200)
        pg.click("#ctxMenu button:has-text('Outlook monitoring')"); pg.wait_for_timeout(300)
        expect(ev("document.querySelector('.view.active').id") == "view-inbox" and ev("$('#mailPanel').open"), "mail panel not shown")
        expect(pg.is_visible("label.switch:has(#mailOn)"), "the Watch Outlook switch isn't visible")

    @check("⚙ at the top right opens Settings (both layouts) and Ctrl+, too")
    def _():
        try:
            for top in (False, True):
                ev(f"applySideTop({'true' if top else 'false'})"); pg.wait_for_timeout(300)
                expect(pg.is_visible("#settingsTop"), f"⚙ not visible (menu {'top' if top else 'left'})")
                box = pg.locator("#settingsTop").bounding_box()
                expect(box["x"] + box["width"] <= 1400, "⚙ is cut off at the right")
                pg.click("#settingsTop"); pg.wait_for_timeout(300)
                expect(ev("!!document.querySelector('dialog[open]')"), "Settings didn't open")
                close_dialogs()
        finally:
            ev("applySideTop(false)"); pg.wait_for_timeout(200)
        ev("document.activeElement && document.activeElement.blur()")
        pg.keyboard.press("Control+Comma"); pg.wait_for_timeout(300)
        expect(ev("!!document.querySelector('dialog[open]')"), "Ctrl+, didn't open Settings")
        close_dialogs()

    @check("Settings: sections on the left, each with its controls; Watch clipboard there too")
    def _():
        pg.click("#settingsTop"); pg.wait_for_timeout(500)
        tabs = ev("[...document.querySelectorAll('#settingsBody [data-settab]')].map(b => b.dataset.settab)")
        expect(tabs[:2] == ["general", "look"] and "capture" in tabs and "data" in tabs, f"tabs: {tabs}")
        for t in tabs:
            pg.click(f"[data-settab={t}]"); pg.wait_for_timeout(100)
            n = ev(f"document.querySelectorAll('#settingsBody [data-setpane={t}]:not([hidden]) .set-row').length")
            expect(n > 0, f"section {t} is empty")
        pg.click("[data-settab=capture]")
        was = ev("!!S.settings.watch")
        pg.click("#settingsBody label.switch:has([data-set=watch])"); pg.wait_for_timeout(500)
        expect(ev("!!S.settings.watch") == (not was), "Watch clipboard in Settings didn't switch capture")
        pg.click("#settingsBody label.switch:has([data-set=watch])"); pg.wait_for_timeout(500)
        close_dialogs()

    @check("left menu: fits, no page counts, no duplicate search; the rail can be expanded again")
    def _():
        expect(not pg.is_visible("#nav .navsearch"), "🔍 beside Dashboard is back")
        expect(not pg.is_visible("#nav .ng-n"), "page counts shown")
        expect(not pg.is_visible("#mainMenuBtn") and not pg.is_visible("#sideFlip"), "☰ / layout switch shown on the left")
        expect(not pg.is_visible("#nav [data-view=groups]"), "Groups still in the menu")
        expect(ev("show('groups'), document.querySelector('.view.active').id") == "view-groups", "Groups page no longer opens")
        ev("show('dashboard')")
        pg.click("#sideToggle"); pg.wait_for_timeout(300)
        expect(pg.is_visible("#sideToggle"), "» not visible on the rail")
        pg.click("#sideToggle"); pg.wait_for_timeout(300)
        expect(not ev("document.body.classList.contains('side-collapsed')"), "menu didn't expand again")

    @check("Others (default) hides UAT and PROD everywhere — trees, full list, search — until picked at the top")
    def _():
        ev("show('dashboard')"); ev("EnvSwitch.set('')")
        envs = ev("S.entries.map(e => (e.env || '').toUpperCase())")
        expect(envs and not any(e.startswith("UAT") or e.startswith("PROD") for e in envs), f"UAT/PROD listed: {set(envs)}")
        expect(pg.inner_text("#envSwitch [data-envsw=PROD] .envn").strip().isdigit(), "no hidden count on PROD")
        ev("show('terminal')"); pg.wait_for_timeout(300)
        expect(not pg.locator("#view-terminal .tree-host", has_text="prod.acme.local").count(), "PROD servers in the SSH tree")
        ev("show('dashboard')")
        pg.fill("#search", "acme"); pg.dispatch_event("#search", "input"); pg.wait_for_timeout(500)
        envs = ev("filtered().map(e => (e.env || '').toUpperCase())")
        expect(not any(e.startswith("UAT") or e.startswith("PROD") for e in envs), f"UAT/PROD in results: {set(envs)}")
        expect(pg.is_visible("#board .guard-note"), "no note about hidden UAT/PROD results")
        pg.click("#board [data-guardenv=PROD]"); pg.wait_for_timeout(400)
        envs = ev("filtered().map(e => (e.env || '').toUpperCase())")
        expect(envs and all(e.startswith("PROD") for e in envs), f"PROD picked, results: {set(envs)}")
        ev("EnvSwitch.set('')")
        pg.fill("#search", "acme env:prod"); pg.dispatch_event("#search", "input"); pg.wait_for_timeout(400)
        expect(pg.is_visible("#board .guard-note"), "env:prod typed: no way to show them")
        pg.fill("#search", ""); pg.dispatch_event("#search", "input")
        ev("EnvSwitch.set('ALL')")

    @check("text size: bigger by default, Settings → Appearance changes it")
    def _():
        expect(float(ev("parseFloat(getComputedStyle(document.body).fontSize)")) > 15.5, "default text not bigger")
        expect(abs(float(ev("Fonts.ui()")) - 1.14) < 0.001, f"Normal should be 1.14: {ev('Fonts.ui()')}")
        pg.click("#settingsTop"); pg.wait_for_timeout(400); pg.click("[data-settab=look]")
        pg.select_option("#settingsBody select[data-set=uiscale]", "1.32"); pg.wait_for_timeout(300)
        expect(float(ev("parseFloat(getComputedStyle(document.body).fontSize)")) > 18, "Larger didn't apply")
        pg.select_option("#settingsBody select[data-set=uiscale]", "1.14"); pg.wait_for_timeout(200)
        # someone who had picked the old "Normal" (1.08) moves up to the new one, once
        ev("store.set('uiScale', 1.08); store.set('uiScaleV2', false)")
        expect(abs(float(ev("Fonts.ui()")) - 1.14) < 0.001 and abs(float(ev("Fonts.ui()")) - 1.14) < 0.001, "old Normal not moved up")
        close_dialogs()

    @check("thread list: the capture thread says Active; no 'To do' badges")
    def _():
        ev("show('tasks')"); pg.wait_for_timeout(400)
        act = ev("Work.active()")
        expect(act, "no capture thread")
        expect("Active" in pg.inner_text(f"#workList [data-work='{act}'] .tli-top"), "capture thread isn't Active")
        expect(pg.locator("#workList .wstatus.todo").count() == 0, "To do badges shown")
        expect(pg.locator("#workList .wstatus.active").count() == 1, "more than one Active")

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
        pg.wait_for_timeout(300)
        expect(ev("document.querySelector('#apiResp').classList.contains('cm-s-wh')") and "cm-property" in ev("highlightHTML('{\"a\": 1}', 'application/json')"), "answer not coloured")
        ev("$('#apiBodyType').value = 'json'; $('#apiBodyType').dispatchEvent(new Event('change')); Api.dirty = false; $('#apiBody').value = '{\"id\": 4711}'; 0")
        expect(ev("$('#apiBody').cm.getOption('mode')") == "application/json" and ev("$('#apiBody').value") == '{"id": 4711}', "body editor")
        expect(not ev("Api.dirty"), "setting the body from code counted as an edit")

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

    @check("SSH keys window: off by default (~/.ssh not read, hidden); Settings → Security turns it on")
    def _():
        expect(ev("S.sshKeysOff"), "the SSH keys window is on by default")
        expect(ev("api('GET', '/api/sshkeys').then(r => r.off === true && !r.keys.length && !r.hosts.length)"), "~/.ssh was read")
        ev("show('terminal')"); pg.wait_for_timeout(200)
        expect(not pg.is_visible("#view-terminal [data-tool=sshkeys]"), "🔑 Keys button shown while off")
        pg.click("#settingsTop"); pg.wait_for_timeout(400); pg.click("[data-settab=security]")
        pg.click("#settingsBody label.switch:has([data-set=sshkeys])"); pg.wait_for_timeout(800)
        expect(not ev("S.sshKeysOff"), "ticking didn't turn it on")
        close_dialogs()
        expect(pg.is_visible("#view-terminal [data-tool=sshkeys]"), "🔑 Keys button not shown when on")
        pg.click("#menubar [data-menu=Tools]"); pg.wait_for_timeout(200)
        expect("SSH keys" in pg.inner_text("#ctxMenu"), "SSH keys not in the Tools menu when on")
        pg.keyboard.press("Escape")

    @check("SSH keys window lists keys (read-only)")
    def _():
        if ssh_keys_off():
            raise Skip("the SSH keys window is off in Settings")
        ev("SSHKeys.open()"); pg.wait_for_timeout(600)
        expect(pg.is_visible("#sshKeysDlg"), "keys window")
        close_dialogs()

    @check("? shortcut sheet")
    def _():
        ev("document.activeElement && document.activeElement.blur()")
        pg.keyboard.press("?"); pg.wait_for_timeout(200)
        expect(ev("!!document.getElementById('keysDlg')?.open"), "sheet did not open")
        close_dialogs()

    @check("questions are WorkHub boxes titled WorkHub, never the browser's “127.0.0.1 says”")
    def _():
        ev("window.__askManual = true; window._ans = 'pending'; askYes('Delete the thing?').then(v => _ans = v); 0")
        pg.wait_for_selector("dialog.askyes[open]")
        expect("WorkHub" in pg.inner_text("dialog.askyes .ask-head") and "127.0.0.1" not in pg.inner_text("dialog.askyes"), "no WorkHub title")
        expect("danger" in pg.get_attribute("dialog.askyes [data-ask=ok]", "class"), "Delete question should have the delete-style OK")
        pg.keyboard.press("Escape"); pg.wait_for_timeout(200)
        expect(ev("_ans") is False, f"Esc should answer no: {ev('_ans')}")
        ev("askYes('Go on?').then(v => _ans = v); 0"); pg.wait_for_selector("dialog.askyes[open]")
        pg.keyboard.press("Enter"); pg.wait_for_timeout(200)
        expect(ev("_ans") is True, "Enter should answer yes")
        ev("askText('Name?', 'abc').then(v => _ans = v); 0"); pg.wait_for_selector("dialog.askbox[open]")
        expect("WorkHub" in pg.inner_text("dialog.askbox .ask-head"), "question box title")
        pg.keyboard.type("xyz"); pg.keyboard.press("Enter"); pg.wait_for_timeout(200)
        expect(ev("_ans") == "xyz", f"askText answer: {ev('_ans')}")
        ev("window.__askManual = false")
        expect(not native, f"browser pop-ups appeared: {native[:3]}")

    @check("dashboard: tidy overview (no empty boxes, attention on the Today line); bookmarks as rows")
    def _():
        ev("show('dashboard'); Home.set(false)"); pg.wait_for_timeout(600)
        expect(pg.locator("#todayStats .stat").count() >= 1 and pg.locator("#stats .stat").count() == 0, "attention buttons not on the Today line")
        boxes = ev("[...document.querySelectorAll('#today .tcardx')].map(c => c.querySelectorAll('.tc-row').length)")
        expect(all(n > 0 for n in boxes), f"an empty box is shown: {boxes}")
        ev("Home.set(true)"); pg.wait_for_timeout(600)
        rows = pg.locator("#board .linkrows .linkrow").count()
        expect(rows >= 3, f"bookmarks not shown as rows ({rows})")
        expect(pg.locator("#board .card .host").filter(has_text="www.bbc.co.uk").count() == 0, "a bookmark is still a card")
        ev("Home.set(false)")

    @check("⧉ New window in each tree area opens that whole page (SSH, FTP, SQL, Tasks)")
    def _():
        for view in ("terminal", "files", "sql"):
            ev(f"show('{view}')"); pg.wait_for_timeout(300)
            b = pg.locator(f"#view-{view} .tree-tools [data-tool=popout]")
            expect(b.count() == 1 and b.is_visible(), f"no ⧉ New window in the {view} tree")
        ev("show('files')"); pg.wait_for_timeout(300)
        with ctx.expect_page() as pw:
            pg.click("#view-files .tree-tools [data-tool=popout]")
        w = pw.value
        w.wait_for_function("document.body.classList.contains('popout') && document.querySelector('#view-files').classList.contains('active')", timeout=15000)
        expect(not w.evaluate("document.body.classList.contains('pop-single')"), "whole FTP page expected")
        w.wait_for_timeout(800)
        expect(w.evaluate("!!document.querySelector('#view-files .tree-host').offsetParent && document.querySelectorAll('#view-files .tree .tnode.item').length > 0"), "no connections in the FTP window")
        expect(w.evaluate("document.querySelector('#view-files .tree-main').getBoundingClientRect().width > innerWidth * 0.5"), "the FTP panes are squeezed")
        w.click("#popDock"); pg.wait_for_timeout(800)
        expect(w.is_closed(), "didn't dock back")
        ev("show('tasks')"); pg.wait_for_timeout(300)
        with ctx.expect_page() as pw:
            pg.click("#workPop")
        w = pw.value
        w.wait_for_function("document.body.classList.contains('popout') && document.querySelector('#view-tasks').classList.contains('active')", timeout=15000)
        expect(w.evaluate("!!document.querySelector('.tasks-side').offsetParent"), "the whole Tasks page should keep its thread list")
        w.click("#popDock"); pg.wait_for_timeout(800)

    @check("new windows open centred the first time, then where that kind of window was when docked back")
    def _():
        ev("localStorage.removeItem('wh-popwin:page:files')")
        p = ev("Popout.place('page', 'files')")
        cx = ev("screen.availLeft + screen.availWidth / 2"); cy = ev("screen.availTop + screen.availHeight / 2")
        expect(abs(p["x"] + p["w"] / 2 - cx) <= 2 and abs(p["y"] + p["h"] / 2 - cy) <= 2, f"not centred: {p}")
        ev("show('files')"); pg.wait_for_timeout(300)
        with ctx.expect_page() as pw:
            pg.click("#view-files .tree-tools [data-tool=popout]")
        w = pw.value; w.wait_for_function("document.body.classList.contains('popout')", timeout=15000)
        w.evaluate("Popout.savePlace = function () { localStorage.setItem(this.posKey(this.me.kind, this.me.id), JSON.stringify({ x: 40, y: 60, w: 900, h: 640 })); }; 0")  # headless windows can't be moved: pretend it was
        w.click("#popDock"); pg.wait_for_timeout(600)
        got = ev("Popout.place('page', 'files')")
        expect(got == {"x": 40, "y": 60, "w": 900, "h": 640}, f"position not kept: {got}")
        ev("localStorage.removeItem('wh-popwin:page:files')")

    @check("🔎 Ask: Confluence pages and Jira issues together, words in yellow; ⚙ Settings → Ask has the Confluence sign-in")
    def _():
        ev("show('ask')"); pg.wait_for_timeout(500)
        expect(pg.is_visible("#askQ") and pg.is_hidden("#askAIWrap"), "Ask page / AI should be off by default")
        expect(pg.is_checked("#askInConf") and not pg.is_checked("#askInJira"), "default should be Confluence only")
        pg.check("#askInJira")
        pg.fill("#askQ", "how do we restart the batch server?"); pg.press("#askQ", "Enter")
        pg.wait_for_selector("#askOut .ask-row", timeout=15000)
        srcs = ev("[...document.querySelectorAll('#askOut .ask-src')].map(x => x.textContent)")
        expect(any("Confluence" in x for x in srcs) and any("Jira" in x for x in srcs), f"sources: {srcs}")
        expect("restart runbook" in pg.inner_text("#askOut").lower() and pg.locator("#askOut mark.tfind").count() > 0, "runbook / marks missing")
        expect(pg.locator("#askOut .ask-err").count() == 0, pg.inner_text("#askOut")[:200])
        srch = pg.inner_text("#askOut .ask-srcs")
        expect("Confluence" in srch and "Jira" in srch, f"searched: {srch}")
        pg.click("#settingsTop"); pg.wait_for_timeout(400); pg.click("[data-settab=ask]"); pg.wait_for_timeout(400)
        expect(pg.locator("#settingsBody select[data-set=conf-mode]").count() == 1 and "AI answers" in pg.inner_text("#settingsBody"), "no Ask settings")
        pg.select_option("#settingsBody select[data-set=conf-mode]", "browser"); pg.wait_for_timeout(600)
        expect(pg.locator("#settingsBody [data-set=conf-signin]").count() == 1, "no Sign in with browser button")
        pg.select_option("#settingsBody select[data-set=conf-mode]", "jira"); pg.wait_for_timeout(600)
        pg.click("#settingsBody [data-set=conf-test]"); pg.wait_for_timeout(1500)
        expect("connected" in pg.inner_text("#confTestState"), f"test: {pg.inner_text('#confTestState')}")
        expect(ev("api('GET', '/api/ask/config').then(c => c.ai)") is False, "AI must be off by default")
        close_dialogs()

    @check("📚 Confluence local copy: pick spaces in Settings, it downloads, Ask searches it (word endings), every hour by default")
    def _():
        pg.click("#settingsTop"); pg.wait_for_timeout(400); pg.click("[data-settab=ask]"); pg.wait_for_timeout(500)
        expect(pg.input_value("#settingsBody select[data-set=ci-every]") == "60", "should fetch changes every hour by default")
        pg.click("#settingsBody [data-set=ci-pick]"); pg.wait_for_selector("dialog.ci-pick[open] .ci-list input", timeout=10000)
        pg.check("dialog.ci-pick input[value=OPS]"); pg.check("dialog.ci-pick input[value=PAY]")
        pg.click("dialog.ci-pick [data-ci=ok]")
        pg.wait_for_function("api('GET', '/api/confindex').then(x => !x.running && x.pages >= 5)", timeout=20000)
        ix = ev("api('GET', '/api/confindex')")
        expect(ix["on"] and sorted(ix["spaces"]) == ["OPS", "PAY"] and ix["per_space"].get("OPS", 0) >= 3, f"index: {ix}")
        pg.select_option("#settingsBody select[data-set=ci-every]", "120"); pg.wait_for_timeout(400)
        expect(ev("api('GET', '/api/confindex').then(x => x.every)") == 120, "interval not saved")
        close_dialogs()
        ev("show('ask')"); pg.wait_for_timeout(300)
        ev("$('#askInJira').checked = false; localStorage.setItem('askSources', '[\"confluence\"]'); 0")
        pg.fill("#askQ", "restart payment after outage"); pg.press("#askQ", "Enter")
        pg.wait_for_selector("#askOut .ask-row", timeout=15000)
        txt = pg.inner_text("#askOut")
        expect("Restarting payment services after an outage" in txt and "local copy" in txt, txt[:300])
        expect(pg.locator("#askOut .ask-src.jira").count() == 0, "Jira searched while only Confluence is ticked")
        pg.click("#askInConf"); pg.wait_for_timeout(200)
        expect(pg.is_checked("#askInConf"), "unticking both should be refused")
        ev("api('PUT', '/api/confindex', { on: false, spaces: [], every: 60 }).then(() => api('DELETE', '/api/confindex'))")

    @check("📌 pinned left menu stays as it is; 🔎 Ask button at the top next to 💬")
    def _():
        ev("show('dashboard')"); pg.wait_for_timeout(300)
        if ev("document.body.classList.contains('side-collapsed')"): ev("toggleSide()"); pg.wait_for_timeout(400)
        coll = lambda: ev("document.body.classList.contains('side-collapsed')")
        expect(not coll(), "menu should be full size to start")
        pg.click("#sidePin"); pg.wait_for_timeout(200)
        expect(ev("document.body.classList.contains('side-pinned')") and pg.get_attribute("#sidePin", "aria-pressed") == "true", "pin didn't take")
        ev("show('terminal')"); pg.wait_for_timeout(500)
        expect(not coll(), "pinned menu shrank on the SSH page")
        ev("toggleSide()"); pg.wait_for_timeout(300)
        expect(not coll(), "Ctrl+B / « changed a pinned menu")
        pg.reload(); pg.wait_for_function("typeof S !== 'undefined' && S.entries.length > 0", timeout=20000); pg.wait_for_timeout(1500); close_dialogs()
        expect(ev("document.body.classList.contains('side-pinned')"), "pin not kept after a restart")
        pg.click("#sidePin"); pg.wait_for_timeout(200)
        ev("show('terminal')"); pg.wait_for_timeout(500)
        expect(coll(), "unpinned: the SSH page should shrink the menu again")
        ev("show('dashboard')"); pg.wait_for_timeout(400)
        expect(pg.locator("#gsearch #askTop + #chatFab").count() == 1, "Ask button not right before the chat button")
        pg.click("#askTop"); pg.wait_for_timeout(400)
        expect(ev("document.querySelector('#view-ask').classList.contains('active') && document.activeElement.id === 'askQ'"), "Ask button didn't open Ask")
        ev("EnvSwitch.set('ALL')")

    @check("⧉ every page opens in its own window (top bar icon, left-menu right-click) and docks back")
    def _():
        views = ev("[...document.querySelectorAll('#nav button[data-view]')].map(b => b.dataset.view).filter(v => !['terminal', 'files', 'sql', 'tasks', 'groups'].includes(v))")
        own = ['api', 'git', 'ref', 'notes']  # beside their own list
        expect(len(views) >= 8, f"pages: {views}")
        bad = []
        for v in views:
            ev(f"show('{v}')"); pg.wait_for_timeout(250)
            sel = f"#view-{v} [data-pagepop={v}]" if v in own else "#pagePop"
            if not pg.is_visible(sel):
                bad.append(v + ": no icon"); continue
            if v in own and pg.is_visible("#pagePop"):
                bad.append(v + ": icon twice")
            with ctx.expect_page() as pw:
                pg.click(sel)
            w = pw.value
            errs = []; w.on("pageerror", lambda e: errs.append(str(e)))
            try:
                w.wait_for_function(f"document.body.classList.contains('popout') && document.querySelector('#view-{v}')?.classList.contains('active')", timeout=15000)
            except Exception:
                bad.append(v + ": didn't open")
            if errs: bad.append(v + ": " + errs[0][:80])
            w.click("#popDock"); pg.wait_for_timeout(500)
        expect(not bad, f"pages: {bad}")
        ev("show('notes')"); pg.wait_for_timeout(200)
        pg.click("#nav button[data-view=cal]", button="right"); pg.wait_for_timeout(300)
        expect(pg.locator("#ctxMenu button:has-text('Open in a new window')").count() == 1, "no left-menu right-click option")
        pg.keyboard.press("Escape")
        ev("show('terminal')"); pg.wait_for_timeout(200)
        expect(not pg.is_visible("#pagePop"), "SSH has its icon by the tree, not in the top bar")
        ev("show('dashboard')")

    @check("📡 Capture traffic on a server: live packets Wireshark-style, filter, bytes, stop, .pcap")
    def _():
        if ssh_off():
            raise Skip("SSH is switched off")
        e = ev("S.entries.find(e => e.port === 2222)")
        ev(f"show('terminal'); Tree.menu({{ clientX: 300, clientY: 300 }}, {{ dataset: {{ id: '{e['id']}' }} }}, 'ssh')"); pg.wait_for_timeout(300)
        expect(pg.locator("#ctxMenu button:has-text('Capture traffic')").count() == 1, "no Capture traffic on a server")
        pg.keyboard.press("Escape")
        ev(f"Pcap.open(S.entries.find(e => e.id === '{e['id']}'))"); pg.wait_for_selector("#pcapDlg[open]")
        pg.uncheck("#pcapDlg [data-pc=sudo]")
        pg.fill("#pcapDlg [data-pc=filter]", "port 1521"); pg.click("#pcapDlg [data-pc=start]")
        pg.wait_for_function("document.querySelectorAll('#pcapDlg tbody tr').length >= 4", timeout=15000)
        protos = ev("[...document.querySelectorAll('#pcapDlg tbody tr td:nth-child(5)')].map(td => td.textContent)")
        expect(set(protos) == {"TNS"}, f"filter port 1521: {set(protos)}")
        info = pg.inner_text("#pcapDlg tbody tr:first-child td:last-child")
        expect("1521" in info and "PSH" in info, f"info: {info}")
        pg.click("#pcapDlg tbody tr:first-child"); pg.wait_for_timeout(500)
        ascii = ev("document.querySelector('#pcapDlg .pc-hex').textContent.split('\\n').filter(l => /^[0-9a-f]{4}  /.test(l)).map(l => l.slice(56)).join('')")
        expect("SELECT status FROM refunds" in ascii, f"packet bytes not shown: {ascii[:120]!r}")
        pg.click("#pcapDlg [data-pc=stop]"); pg.wait_for_function("!Pcap.running", timeout=10000)
        expect("Stopped" in pg.inner_text("#pcapDlg .pc-status"), pg.inner_text("#pcapDlg .pc-status"))
        head = ev("fetch(`/api/pcap/${Pcap.id}/file`).then(r => r.arrayBuffer()).then(b => [...new Uint8Array(b.slice(0, 4))])")
        expect(head == [0xd4, 0xc3, 0xb2, 0xa1], f"not a pcap: {head}")
        pg.fill("#pcapDlg [data-pc=find]", "nothing-matches-this"); pg.wait_for_timeout(200)
        expect(pg.locator("#pcapDlg tbody tr").count() == 0, "row filter")
        close_dialogs()

    @check("🗂 workspaces: File menu; a new workspace with sample data opens separately; listed to switch to")
    def _():
        pg.click("#menubar .mb[data-menu=File]"); pg.wait_for_timeout(300)
        labels = pg.inner_text("#ctxMenu")
        expect(all(x in labels for x in ("New workspace", "Open workspace", "Switch workspace", "Close workspace")), labels[:300])
        pg.keyboard.press("Escape")
        ev("window.open = (u) => { window._wsURL = u; return {}; }; 0")  # catch the new window's address
        wsn = "Smoke Demo " + str(int(time.time()) % 100000)  # a fresh name each run
        ev(f"Workspaces.go({{ name: '{wsn}', create: true, sample: true }}, 'new')")
        pg.wait_for_function("!!window._wsURL", timeout=30000)
        u = ev("window._wsURL")
        expect(":%d/" % ev("+location.port") not in u, f"same port as this workspace: {u}")
        w = ctx.new_page(); w.goto(u)
        w.wait_for_function("typeof S !== 'undefined' && S.settings && S.entries.length > 0", timeout=20000)
        w.evaluate("EnvSwitch.set('ALL')"); w.wait_for_timeout(800)  # sample servers are mostly UAT / PROD
        expect(w.evaluate("S.settings.workspace") == wsn and w.evaluate("S.entries.length") >= 12, f"not the sample workspace: {w.evaluate('S.settings.workspace')} / {w.evaluate('S.entries.length')}")
        expect(w.evaluate("S.entries.every(e => !e.host || e.host.endsWith('.example.com'))"), "sample data isn't made up")
        expect(not ev("S.entries.some(e => (e.host || '').endsWith('.acme.example.com'))"), "data leaked into this workspace")
        ev("Workspaces.load()"); pg.wait_for_timeout(500)
        names = ev("Workspaces.list.map(w => w.name)")
        expect(wsn in names, f"not listed: {names}")
        expect(any(it[0].startswith(wsn) for it in ev("Workspaces.menuItems()")), "not in Switch workspace")
        w.evaluate("api('POST', '/api/quit').catch(() => {})"); w.close()

    @check("no page errors during the whole run")
    def _():
        expect(not errors, f"errors: {errors[:3]}")

    b.close()

failed = [r for r in results if not r[1]]
print(f"\n{len(results) - len(failed)} passed, {len(failed)} failed")
sys.exit(1 if failed else 0)
