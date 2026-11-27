#!/usr/bin/env python3
"""How fast does WorkHub start with a lot of data?

  tools/perf/startup.py [--fill]      (run with tools/uitest/.venv/bin/python)

Builds WorkHub into dist/perf, fills a separate data folder (dist/perf/data) with
made-up data the first time (or with --fill): 3,000 connections, 300 threads with
100 messages each, 1,000 notes. Then starts it cold three times and prints:
  - server: start → answering
  - page: open → usable (connections drawn), and → quiet (no more requests)
  - the slowest requests during start-up and the page's long tasks
Nothing here touches your own WorkHub data.
"""
import json, os, shutil, subprocess, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DIR = os.path.join(ROOT, "dist", "perf")
DATA = os.path.join(DIR, "data")
BIN = os.path.join(DIR, "workhub")
PORT = 47970


def build():
    env = dict(os.environ, PATH=os.path.expanduser("~/sdk/go/bin") + ":" + os.environ["PATH"])
    subprocess.run(["go", "build", "-o", BIN, "."], cwd=ROOT, env=env, check=True)


def start():
    t0 = time.time()
    home = os.path.join(DIR, "home")
    os.makedirs(home, exist_ok=True)
    p = subprocess.Popen([BIN, "-data", DATA, "-port", str(PORT), "-no-browser"], env=dict(os.environ, HOME=home),
                         stdout=open(os.path.join(DIR, "workhub.log"), "w"), stderr=subprocess.STDOUT)
    tok = os.path.join(DATA, "session.token")
    while True:
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{PORT}/", timeout=1)
            break
        except urllib.error.HTTPError:
            break  # answering (401 without the cookie)
        except Exception:
            if time.time() - t0 > 60:
                raise SystemExit("WorkHub didn't start — see dist/perf/workhub.log")
            time.sleep(0.02)
    ready = time.time() - t0
    while not os.path.exists(tok):
        time.sleep(0.02)
    return p, ready, open(tok).read().strip()


def stop(p):
    p.terminate()
    try:
        p.wait(10)
    except subprocess.TimeoutExpired:
        p.kill()


def call(tok, method, path, body=None):
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", data=json.dumps(body).encode() if body is not None else None, method=method,
                                 headers={"Cookie": f"wh{PORT}={tok}", "Content-Type": "application/json", "Host": f"127.0.0.1:{PORT}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        b = r.read()
        return json.loads(b) if b else None


def fill(tok):
    print("filling: 3,000 connections, 300 threads × 100 messages, 1,000 notes …", flush=True)
    t0 = time.time()
    envs = ["DEV", "TEST", "UAT", "PROD"]
    kinds = [("ssh", 22), ("sftp", 22), ("oracle", 1521), ("postgres", 5432), ("http", 8443)]

    def entry(i):
        proto, port = kinds[i % len(kinds)]
        env = envs[i % 4]
        call(tok, "POST", "/api/entries", {"name": f"acme-{proto}-{i:04d}", "project": f"Team {i % 12}/{env}", "host": f"acme-{proto}-{i:04d}.{env.lower()}.acme.local",
                                           "port": port, "protocol": proto, "env": env, "username": "ops", "password": "Demo#2026",
                                           "tags": [f"tag{i % 7}"], "notes": f"Server {i} for the payments platform."})

    def thread(i):
        w = call(tok, "POST", "/api/work", {"title": f"PAY-{1000 + i} settlement batch issue {i}", "tags": ["payments"]})
        for j in range(100):
            call(tok, "POST", f"/api/work/{w['id']}/posts", {"kind": "note", "html": f"<p>Message {j} in thread {i}: checked the <b>batch</b> logs on acme-app-{j % 9:02d}, "
                                                                                     f"restarted the job, waiting for the DBA. See PAY-{1000 + i}.</p>"})

    def note(i):
        call(tok, "POST", "/api/notes", {"title": f"Runbook {i}", "body": ("Step: check the service, restart it, check the logs.\n" * 30)})

    with ThreadPoolExecutor(16) as ex:
        list(ex.map(entry, range(3000)))
        list(ex.map(note, range(1000)))
        list(ex.map(thread, range(300)))
    print(f"filled in {time.time() - t0:.0f} s; data file {os.path.getsize(os.path.join(DATA, 'workhub.dat')) / 1e6:.1f} MB", flush=True)


def page(tok):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        ctx = b.new_context(viewport={"width": 1400, "height": 900})
        pg = ctx.new_page()
        pg.add_init_script("""window.__long = []; try { new PerformanceObserver(l => l.getEntries().forEach(e => __long.push([e.startTime, e.duration])))
            .observe({ type: 'longtask', buffered: true }); } catch {}""")
        t0 = time.time()
        pg.goto(f"http://127.0.0.1:{PORT}/?t={tok}")
        pg.wait_for_function("typeof S !== 'undefined' && (S.allEntries || []).length > 0", timeout=120000)
        pg.evaluate("new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)))")  # drawn
        usable = time.time() - t0
        pg.wait_for_load_state("networkidle", timeout=60000)
        quiet = time.time() - t0
        res = pg.evaluate("""performance.getEntriesByType('resource').filter(r => r.name.includes('/api/'))
            .map(r => [new URL(r.name).pathname + new URL(r.name).search, Math.round(r.startTime), Math.round(r.duration), r.transferSize])""")
        nav = pg.evaluate("(() => { const n = performance.getEntriesByType('navigation')[0]; return [Math.round(n.responseEnd), Math.round(n.domContentLoadedEventEnd), Math.round(n.loadEventEnd)]; })()")
        longs = pg.evaluate("__long.map(([s, d]) => [Math.round(s), Math.round(d)])")
        b.close()
    return usable, quiet, res, nav, longs


def main():
    os.makedirs(DIR, exist_ok=True)
    build()
    if "--fill" in sys.argv or not os.path.exists(os.path.join(DATA, "workhub.dat")):
        shutil.rmtree(DATA, ignore_errors=True)
        p, _, tok = start()
        try:
            fill(tok)
            time.sleep(2)  # saved
        finally:
            stop(p)
    print(f"data file: {os.path.getsize(os.path.join(DATA, 'workhub.dat')) / 1e6:.1f} MB")
    for run in range(3):
        p, ready, tok = start()
        try:
            usable, quiet, res, nav, longs = page(tok)
        finally:
            stop(p)
        print(f"\nrun {run + 1}: server answering {ready * 1000:.0f} ms · page usable {usable * 1000:.0f} ms · quiet {quiet * 1000:.0f} ms"
              f" · html {nav[0]} ms, DOM ready {nav[1]} ms, load {nav[2]} ms")
        if run == 2:
            print("  slowest requests (path, started at ms, took ms, bytes):")
            for r in sorted(res, key=lambda r: -r[2])[:12]:
                print("   ", r)
            print("  requests started after 500 ms:")
            for r in sorted(res, key=lambda r: r[1]):
                if r[1] > 500:
                    print("   ", r)
            print(f"  long tasks (> 50 ms) on the page: {len(longs)}, {sum(d for _, d in longs)} ms in total; longest: {sorted(longs, key=lambda x: -x[1])[:6]}")


if __name__ == "__main__":
    main()
