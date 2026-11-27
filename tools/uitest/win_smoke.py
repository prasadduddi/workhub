#!/usr/bin/env python3
"""Windows check (GitHub Actions, windows-latest): WorkHub-web runs, every page opens without page
errors, and the Windows-only parts answer (native clipboard, workspaces, support report).

  win_smoke.py <url-with-token>
"""
import json, sys
from playwright.sync_api import sync_playwright

URL = sys.argv[1]
failed = []

def check(name, ok, detail=""):
    print(("  ✓ " if ok else "  ✗ ") + name + ("" if ok else f": {detail}"))
    if not ok:
        failed.append(name)

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 1400, "height": 900})
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(URL)
    pg.wait_for_function("typeof S !== 'undefined' && S.settings", timeout=60000)
    pg.wait_for_timeout(2000)
    pg.evaluate("document.querySelectorAll('dialog[open]').forEach(d => d.close())")
    check("the page loads", not errors, errors[:3])
    views = pg.evaluate("[...document.querySelectorAll('#nav button[data-view]')].map(b => b.dataset.view)")
    bad = []
    for v in views:
        pg.evaluate(f"show('{v}')"); pg.wait_for_timeout(300)
        if not pg.evaluate(f"document.querySelector('#view-{v}')?.classList.contains('active')"):
            bad.append(v)
    check(f"every page opens ({len(views)})", not bad and not errors, bad or errors[:3])
    r = pg.evaluate("api('GET', '/api/clipboard/text').then(r => typeof r.text, e => 'error: ' + e.message)")
    check("native clipboard read", r == "string", r)
    r = pg.evaluate("api('GET', '/api/clipboard/html').then(r => typeof r.html, e => 'error: ' + e.message)")
    check("native formatted clipboard read", r == "string", r)
    r = pg.evaluate("api('GET', '/api/workspaces').then(r => r.workspaces.map(w => w.name), e => 'error: ' + e.message)")
    check("workspaces", isinstance(r, list) and "Default" in r, r)
    r = pg.evaluate("api('GET', '/api/support').then(r => r.report, e => 'error: ' + e.message)")
    check("support report (windows)", "windows/amd64" in r, r[:200])
    check("no page errors at the end", not errors, errors[:3])
    pg.evaluate("api('POST', '/api/quit').catch(() => {})")
    b.close()

print(f"{'all passed' if not failed else str(len(failed)) + ' failed'}")
sys.exit(1 if failed else 0)
