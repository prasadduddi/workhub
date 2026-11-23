#!/usr/bin/env python3
"""Fill a WorkHub demo workspace with realistic but made-up data for a
fictional customer ("Acme Bank"): browser bookmarks, servers, databases,
tunnels, FTP, groups, naming rules, reference folders, a Git repo, a work
item and Jira issues. Used by run-demo.sh; all names, hosts and passwords
here are invented.

  seed.py home <sim-dir>          write the fake browser bookmarks (before WorkHub starts)
  seed.py api  <sim-dir> <port>   fill WorkHub through its API (after it starts)
"""
import json, os, subprocess, sys, time, urllib.request

def bm(name, url):
    return {"type": "url", "name": name, "url": url}

def folder(name, *children):
    return {"type": "folder", "name": name, "children": list(children)}

U, P, D = "uat.acme.local", "prod.acme.local", "dev.acme.local"

def jenkins(job, title=None):
    return bm(title or "Dashboard [Jenkins]", f"https://jenkins.acme.local/job/{job}/")

CHROME_BAR = [
    folder("Acme UAT",
        bm("Picasso", f"https://acme-app-01.{U}:8443/picasso"),
        bm("Picasso (node 2)", f"https://acme-app-02.{U}:8443/picasso"),
        bm("Login", f"https://acme-tpp-01.{U}/console"),
        bm("Config Manager", f"https://acme-cfg-01.{U}/cm/index.html"),
        bm("OFA login", f"https://acme-ofa-01.{U}/ofa/login"),
        bm("Barn", f"https://acme-bar-01.{U}/barn"),
        bm("Batch admin", f"https://acme-bat-01.{U}:8080/batch-admin"),
        bm("Tomcat", f"https://acme-app-01.{U}:8443/manager/html"),
        bm("API docs", f"https://acme-app-01.{U}:8443/swagger-ui/index.html"),
        bm("Grafana UAT", "https://grafana.uat.acme.local/d/pay-overview"),
    ),
    folder("Acme PROD",
        bm("Picasso PROD", f"https://acme-app-01.{P}:8443/picasso"),
        bm("Touchpoint PROD", f"https://acme-tpp-01.{P}/console"),
        bm("Config Manager PROD", f"https://acme-cfg-01.{P}/cm/index.html"),
        bm("OFA", f"https://acme-ofa-01.{P}/ofa/login"),
        bm("Kibana", "https://kibana.prod.acme.local/app/discover"),
        bm("Grafana", "https://grafana.prod.acme.local/d/pay-overview"),
    ),
    folder("Jenkins",
        jenkins("Payments/job/pay-api-deploy"),
        jenkins("Payments/job/pay-api-build"),
        jenkins("Payments/job/pay-batch-deploy"),
        jenkins("Ops/job/db-refresh-uat", "db-refresh-uat [Jenkins]"),
        jenkins("Ops/job/cert-renew"),
        bm("Dashboard [Jenkins]", "https://jenkins.acme.local/view/UAT/job/nightly-regression/"),
        bm("Console Output [Jenkins]", "https://jenkins.acme.local/job/Payments/job/pay-api-deploy/412/console"),
        bm("Dashboard [Jenkins]", "https://jenkins.acme.local/blue/organizations/jenkins/Payments%2Fpay-api-build/detail/pay-api-build/97/pipeline"),
    ),
    folder("DEV05",
        bm("Picasso dev05", f"https://acme-app-05.{D}:8443/picasso"),
        bm("Touchpoint dev05", f"https://acme-tpp-05.{D}/console"),
        bm("Batch dev05", f"https://acme-bat-05.{D}:8080/batch-admin"),
    ),
    folder("Tools",
        bm("Runbook – Payments", "https://wiki.acme.local/display/PAY/Runbook"),
        bm("Release 4.2.1 plan", "https://wiki.acme.local/display/PAY/Release+4.2.1"),
        bm("PAY board", "https://acme.atlassian.net/jira/software/projects/PAY/boards/12"),
        bm("PAY-123 Refund limits", "https://acme.atlassian.net/browse/PAY-123"),
        bm("ServiceNow", "https://acme.service-now.com/now/nav/ui/home"),
        bm("SonarQube", "https://sonar.acme.local/dashboard?id=pay-api"),
        bm("Nexus", "https://nexus.acme.local/#browse/browse:releases"),
        bm("Bitbucket pay-api", "https://bitbucket.acme.local/projects/PAY/repos/pay-api/browse"),
        bm("Vault", "https://vault.acme.local/ui/vault/secrets"),
    ),
    bm("Outlook", "https://outlook.office.com/mail/"),
]
CHROME_OTHER = [
    bm("Stack Overflow", "https://stackoverflow.com/questions/tagged/oracle"),
    bm("Oracle docs – DBMS_METADATA", "https://docs.oracle.com/en/database/oracle/oracle-database/19/arpls/DBMS_METADATA.html"),
    bm("GitHub", "https://github.com/"),
    bm("YouTube", "https://www.youtube.com/"),
    bm("BBC News", "https://www.bbc.co.uk/news"),
    bm("Amazon", "https://www.amazon.co.uk/"),
    bm("regex101", "https://regex101.com/"),
]
EDGE_BAR = [  # partly the same links: shows de-duplication
    bm("Picasso", f"https://acme-app-01.{U}:8443/picasso"),
    bm("Runbook", "https://wiki.acme.local/display/PAY/Runbook"),
    bm("HR portal", "https://hr.acme.local/self-service"),
    bm("Timesheets", "https://timesheets.acme.local/"),
]

def write_bookmarks(path, bar, other, bar_name):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    roots = {"bookmark_bar": folder(bar_name, *bar), "other": folder("Other bookmarks", *other), "synced": folder("Mobile bookmarks")}
    with open(path, "w") as f:
        json.dump({"roots": roots, "version": 1}, f, indent=1)

def home(sim):
    h = os.path.join(sim, "home", "Library", "Application Support")
    write_bookmarks(os.path.join(h, "Google", "Chrome", "Default", "Bookmarks"), CHROME_BAR, CHROME_OTHER, "Bookmarks bar")
    write_bookmarks(os.path.join(h, "Microsoft Edge", "Default", "Bookmarks"), EDGE_BAR, [], "Favorites bar")

# ---- things copied from emails, runbooks and chats ----
CLIPS = [
    ("Acme UAT", f"""UAT servers for release 4.2.1 (from: release manager)
acme-app-01.{U}  user: deploy  password: Uat!Deploy2026
acme-app-02.{U}  user: deploy  password: Uat!Deploy2026
acme-bat-01.{U}  user: batch   password: Batch!Uat26
acme-tpp-01.{U}  ssh port 22 user=tppadm pwd=Tpp#Uat1
acme-cfg-01.{U}  user: cfgadmin password: Cfg_2026
acme-ofa-01.{U}  user: ofa password: Ofa!uat
"""),
    ("Acme UAT", f"Barn file drop: sftp://barnftp@acme-bar-01.{U}:22/inbound  password: Barn#Ftp1\nStatements: sftp://statements:St@tements1@acme-ofa-01.{U}/outbound"),
    ("Acme PROD", f"""PROD access (break-glass only)
ssh ops@acme-app-01.{P}
ssh ops@acme-app-02.{P}
ssh ops@acme-bat-01.{P}
ssh ops@acme-tpp-01.{P}
sftp://mft@acme-bar-01.{P}
"""),
    ("Databases", f"""Payments DB (UAT)  jdbc:oracle:thin:@acme-ora-uat01.acme.local:1521/PAYUAT   user pay_app / Pay#App26
Payments DB (PROD) jdbc:oracle:thin:@acme-ora-prd01.acme.local:1521/PAYPRD  user pay_ro
Reporting: postgres://reporting:Rep0rt!@acme-pg-01.{U}:5432/reports
Legacy via tunnel: jdbc:oracle:thin:@localhost:1522:os08
"""),
    ("Databases", "To reach the legacy DB first run:\nssh -N -L1522:acme-ora-uat02.acme.local:1521 jdoe@acme-jump-01.acme.local"),
    ("Partners", "Partner bank SFTP – ftp://partnerftp:Ptnr2026@ftp.partner-bank.example.com:21/outbound"),
    ("DEV05", f"""DEV05 environment
acme-app-05.{D} deploy / dev05pass
acme-bat-05.{D} batch / dev05pass
acme-tpp-05.{D}
"""),
]

FILES = {
    "JSON/Payments/payment.schema.json": json.dumps({
        "$schema": "https://json-schema.org/draft/2020-12/schema", "$id": "https://acme.local/schemas/payment",
        "type": "object", "required": ["id", "amount", "currency"],
        "properties": {"id": {"type": "integer"}, "amount": {"type": "number", "minimum": 0.01},
                       "currency": {"enum": ["GBP", "EUR", "USD"]}, "reference": {"type": "string", "maxLength": 18}}}, indent=2),
    "JSON/Payments/sample-payment.json": json.dumps({"id": 1001, "amount": 250.0, "currency": "GBP", "reference": "INV-2026-11"}, indent=2),
    "JSON/Payments/sample-payment-bad.json": json.dumps({"id": "1002", "amount": 0, "currency": "JPY", "reference": "THIS-REFERENCE-IS-TOO-LONG"}, indent=2),
    "YAML/k8s/pay-api-deployment.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: pay-api\n  namespace: payments-uat\nspec:\n  replicas: 2\n  template:\n    spec:\n      containers:\n        - name: pay-api\n          image: nexus.acme.local/pay-api:4.2.1\n          ports:\n            - containerPort: 8443\n",
    "YAML/ansible/restart-batch.yml": "- hosts: batch_uat\n  become: true\n  tasks:\n    - name: Restart batch\n      service: name=acme-batch state=restarted\n",
    "Properties/UAT/application.properties": "server.port=8443\nspring.datasource.url=jdbc:oracle:thin:@acme-ora-uat01.acme.local:1521/PAYUAT\ntpp.gateway.url=https://acme-tpp-01.uat.acme.local/gateway\n",
    "Properties/PROD/application.properties": "server.port=8443\nspring.datasource.url=jdbc:oracle:thin:@acme-ora-prd01.acme.local:1521/PAYPRD\n",
    "Runbooks/Release 4.2.1 checklist.txt": "1. Freeze batch (acme-bat-01)\n2. Deploy pay-api 4.2.1 via Jenkins pay-api-deploy\n3. Smoke test Picasso + Touchpoint\n4. Unfreeze batch\n",
}

CONFIG_REPO = {  # a folder elsewhere on disk, linked (not copied) into Folders
    "README.md": "# acme-config\nShared configuration for all environments.\n",
    "uat/pay-api.properties": "feature.instant-payments=true\nlimits.refund.max=5000\n",
    "prod/pay-api.properties": "feature.instant-payments=false\nlimits.refund.max=2500\n",
    "uat/batch.properties": "batch.threads=8\n",
}

class Api:
    def __init__(self, sim, port):
        self.base = f"http://127.0.0.1:{port}"
        tok = open(os.path.join(sim, "data", "session.token")).read().strip()
        self.cookie = f"wh{port}={tok}"
    def call(self, method, path, body=None, raw=None):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(self.base + path, data=data, method=method, headers={"Cookie": self.cookie, "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=60) as r:
            t = r.read()
            return json.loads(t) if t[:1] in (b"{", b"[") else t

def git_repo(path):
    if os.path.isdir(os.path.join(path, ".git")):
        return
    os.makedirs(path, exist_ok=True)
    env = {**os.environ, "GIT_AUTHOR_NAME": "Demo Dev", "GIT_AUTHOR_EMAIL": "dev@acme.example", "GIT_COMMITTER_NAME": "Demo Dev", "GIT_COMMITTER_EMAIL": "dev@acme.example"}
    g = lambda *a: subprocess.run(["git", "-C", path, *a], env=env, check=True, capture_output=True)
    g("init", "-q", "-b", "main")
    steps = [("README.md", "# pay-api\n", "Initial commit"), ("src/Payment.java", "class Payment {}\n", "PAY-101 payment model"),
             ("src/RefundLimits.java", "class RefundLimits {}\n", "PAY-123 refund limits"), ("pom.xml", "<project/>\n", "Bump to 4.2.1")]
    for i, (f, body, msg) in enumerate(steps):
        os.makedirs(os.path.dirname(os.path.join(path, f)) or path, exist_ok=True)
        open(os.path.join(path, f), "w").write(body)
        g("add", "-A"); g("commit", "-q", "-m", msg, "--date", f"2026-11-{10 + i}T10:00:00")
    g("branch", "feature/PAY-130-limits-ui"); g("branch", "release/4.2.1"); g("tag", "v4.2.1")

def seed_api(sim, port):
    a = Api(sim, port)
    st = a.call("GET", "/api/settings")
    st.update({
        "workspace": "Acme Bank (demo)", "project": "Acme UAT",
        "name_rules": [{"match": m, "label": l} for m, l in [("-BAT-", "Batch"), ("-BAR-", "Barn"), ("-TPP-", "Touchpoint"), ("-APP-", "App/Picasso"), ("-CFG-", "Configuration Manager"), ("-OFA-", "OFA")]],
        "groups": [{"name": "DEV05", "patterns": ["-05.dev", "dev05"]}, {"name": "Release 4.2.1", "patterns": ["acme-app-0*.uat", "acme-bat-01.uat", "4.2.1", "pay-api-deploy"]},
                   {"name": "Batch", "patterns": ["-bat-"]}, {"name": "Databases", "patterns": ["acme-ora", "acme-pg", "jdbc"]}],
        "repos": [os.path.join(sim, "repos", "pay-api")],
    })
    a.call("PUT", "/api/settings", st)
    for project, text in CLIPS:
        a.call("POST", "/api/ingest", {"text": text, "source": "clipboard", "project": project})
    # The two lab servers really answer (tools/demolab): green after connecting.
    a.call("POST", "/api/entries", {"name": "LAB acme-app-01 (live demo)", "project": "Lab", "host": "127.0.0.1", "port": 2222, "protocol": "ssh", "env": "UAT",
                                    "username": "deploy", "password": "Demo#2026", "notes": "A real server on this Mac (tools/demolab). Try PuTTY and FileZilla."})
    a.call("POST", "/api/entries", {"name": "LAB acme-bat-01 (live demo)", "project": "Lab", "host": "127.0.0.1", "port": 2223, "protocol": "sftp", "env": "UAT",
                                    "username": "batch", "password": "Batch#2026", "extra": {"tunnels": "15222:127.0.0.1:2222", "tunnels_auto": "1"}})
    # Reference folders: copies, plus a link to a folder that stays where it is.
    for rel, body in FILES.items():
        a.call("PUT", "/api/ref/file?path=" + urllib.parse.quote(rel), raw=body.encode())
    repo = os.path.join(sim, "acme-config")
    for rel, body in CONFIG_REPO.items():
        os.makedirs(os.path.dirname(os.path.join(repo, rel)), exist_ok=True)
        open(os.path.join(repo, rel), "w").write(body)
    try:
        a.call("POST", "/api/ref/link", {"dir": "Properties", "name": "acme-config (linked)", "target": repo})
    except Exception:
        pass
    git_repo(os.path.join(sim, "repos", "pay-api"))
    w = a.call("POST", "/api/work", {"title": "PAY-123 Refund limits – UAT testing", "status": "doing", "tags": ["PAY-123", "UAT"], "jira": "PAY-123"})
    for h in ["<p><b>What:</b> raise refund limits for merchants (PAY-123).</p>",
              "<p>Deployed to UAT — <a href=\"https://jenkins.acme.local/job/Payments/job/pay-api-deploy/412/console\">Deploy #412</a></p>",
              "<ul><li>Batch frozen 01:00–05:30</li><li>Check Touchpoint gateway timeouts</li></ul>"]:
        a.call("POST", "/api/work/%s/posts" % w["id"], {"kind": "note", "html": h})
    a.call("POST", "/api/notes", {"title": "Handover", "content": "Release 4.2.1 handover\n- pay-api deployed to UAT\n- batch EOD passed\n- PROD change CM-4411 scheduled\n"})
    # Jira (pretend server from fake_jira.py)
    try:
        a.call("PUT", "/api/jira/config", {"base_url": "http://127.0.0.1:47990", "mode": "server", "token": "demo-token", "child_prefix": "CM-"})
        a.call("POST", "/api/jira", {"ref": "PAY-123, PAY-130, OPS-77"})
    except Exception as e:
        print("jira:", e)
    print("seeded")

# ---- test threads: linked to the pretend Jira, with messages and screenshots ----
import struct, zlib, datetime

def png(w, h, shapes, bg):
    """A small PNG drawn from rectangles: shapes = [(x, y, w, h, (r, g, b)), …]."""
    px = [bytearray(bytes(bg) * w) for _ in range(h)]
    for x, y, ww, hh, c in shapes:
        for yy in range(max(0, y), min(h, y + hh)):
            row = px[yy]
            for xx in range(max(0, x), min(w, x + ww)):
                row[xx * 3:xx * 3 + 3] = bytes(c)
    raw = b"".join(b"\x00" + bytes(r) for r in px)
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")

def shot_terminal():  # a terminal with log lines and one error line
    s = [(0, 0, 640, 26, (45, 52, 69)), (12, 9, 9, 9, (237, 106, 94)), (28, 9, 9, 9, (245, 191, 79)), (44, 9, 9, 9, (98, 197, 84))]
    for i in range(12):
        y = 40 + i * 20
        col = (224, 82, 82) if i == 7 else (120, 200, 120) if i == 11 else (170, 178, 190)
        s.append((16, y, 90, 10, (110, 118, 130)))
        s.append((116, y, 160 + (i * 37) % 300, 10, col))
    return png(640, 290, s, (29, 35, 48))

def shot_chart():  # a monitoring chart with one spike
    s = [(40, 20, 2, 230, (150, 150, 150)), (40, 248, 580, 2, (150, 150, 150))]
    for i in range(24):
        h = 40 + (i * 17) % 60 + (150 if i == 17 else 0)
        s.append((50 + i * 23, 248 - h, 16, h, (231, 140, 40) if i == 17 else (47, 125, 225)))
    return png(640, 270, s, (255, 255, 255))

def shot_ui():  # a web form with a validation error
    s = [(0, 0, 640, 40, (47, 111, 222)), (0, 40, 150, 320, (236, 240, 246))]
    for i in range(5):
        s.append((20, 60 + i * 30, 110, 12, (170, 180, 195)))
    for i, err in enumerate([False, False, True, False]):
        y = 70 + i * 62
        s += [(180, y, 120, 10, (90, 98, 110)), (180, y + 16, 400, 28, (224, 82, 82) if err else (200, 206, 214)), (182, y + 18, 396, 24, (255, 255, 255))]
    s.append((180, 320, 120, 30, (47, 111, 222)))
    return png(640, 370, s, (250, 251, 253))

def shot_table():  # a query result grid
    s = [(10, 10, 620, 26, (225, 232, 242))]
    for r in range(8):
        for c in range(5):
            s.append((14 + c * 124, 44 + r * 26, 100 - (r * c * 7) % 50, 10, (110, 118, 130) if (r, c) != (3, 2) else (231, 140, 40)))
        s.append((10, 62 + r * 26, 620, 1, (220, 224, 230)))
    return png(640, 260, s, (255, 255, 255))

class Uploader(Api):
    def upload(self, thread, name, data):
        b = "----workhubdemo%d" % len(data)
        body = (f"--{b}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\nContent-Type: image/png\r\n\r\n").encode() + data + f"\r\n--{b}--\r\n".encode()
        req = urllib.request.Request(self.base + "/api/work/%s/files" % thread, data=body, method="POST",
                                     headers={"Cookie": self.cookie, "Content-Type": "multipart/form-data; boundary=" + b})
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read())[0]

THREADS = [
    ("PAY-130 Refund limits screen – review", "PAY-130", "doing", ["PAY-130", "UI"], False, [
        ("note", "<p><b>Review notes</b> for the limits screen:</p><ul><li>Amount field accepts negative values ❌</li><li>Currency missing next to the limit</li><li>Save button disabled until a tier is chosen ✅</li></ul>"),
        ("capture", "From: Raj Dev\nSubject: RE: limits screen review\n\nFixed the negative amounts in build 4.2.2-rc1, please re-test on acme-app-02.uat.acme.local", "Outlook — RE: limits screen review"),
        ("shot", shot_ui, "limits-screen-validation.png", "<p>The validation error on <i>Max refund</i> — screenshot from UAT:</p>"),
        ("reply", "<p>Re-tested on rc1: negative amounts now refused 👍</p>"),
    ]),
    ("PAY-201 Refund approval workflow", "PAY-201", "doing", ["PAY-201", "design"], True, [
        ("note", "<p><b>Design</b>: refunds over the merchant limit wait for a second approver.</p><pre><code>status: PENDING_APPROVAL -&gt; APPROVED | REJECTED\napprover != requester</code></pre>"),
        ("entry", "acme-ora-uat01.acme.local"),
        ("shot", shot_chart, "approvals-per-hour.png", "<p>Approvals per hour in UAT — note the spike at 17:00 (batch replay):</p>"),
        ("remind", 2),
    ]),
    ("PAY-205 Limits per merchant tier – blocked", "PAY-205", "blocked", ["PAY-205"], False, [
        ("note", "<p>⛔ <b>Blocked</b>: waiting for the tier list from the merchant team (asked on Monday).</p>"),
        ("capture", "Tier A: 5000 EUR\nTier B: 2500 EUR\nTier C: 1000 EUR (draft, not confirmed)", "Teams — Merchant onboarding"),
    ]),
    ("OPS-77 Renew batch server certificates", "OPS-77", "todo", ["OPS-77", "certs"], False, [
        ("capture", "$ openssl x509 -enddate -noout -in /etc/pki/tls/certs/batch.crt\nnotAfter=Dec 14 23:59:59 2026 GMT", "PuTTY — batch@acme-bat-01"),
        ("shot", shot_terminal, "cert-check.png", "<p>Expiry check on acme-bat-01 (the red line is the old intermediate cert):</p>"),
        ("note", "<p>Plan: order new certs → install on <b>acme-bat-01</b> and <b>acme-bat-02</b> → restart batch in the 01:00 window.</p>"),
    ]),
    ("OPS-90 Scale refund batch for 2.0 volumes", "OPS-90", "doing", ["OPS-90", "batch"], False, [
        ("pin", "<p>📌 <b>Target</b>: 3× today's refunds within the 01:00–05:30 window.</p>"),
        ("shot", shot_table, "batch-durations.png", "<p>Batch step durations from <code>pay_batch_runs</code> (step 3 is the slow one):</p>"),
        ("note", "<p>Try <code>batch.threads=16</code> on UAT tonight.</p>"),
    ]),
    ("CM-4411 PROD release 4.2.1", "CM-4411", "doing", ["CM-4411", "PROD", "release"], True, [
        ("pin", "<p><b>Release checklist</b></p><ul><li>☑ UAT sign-off</li><li>☐ DB migration dry run</li><li>☐ Deploy pay-api 4.2.1</li><li>☐ Smoke test</li></ul>"),
        ("note", "<p>Change window: <b>Saturday 06:00–08:00</b>. Rollback plan in the Folders page (Runbooks).</p>"),
        ("remind", 20),
    ]),
    ("Incident: ORA-00060 deadlocks in refunds", "PAY-200", "doing", ["incident", "PAY-200"], False, [
        ("capture", "2026-11-23 10:14:02,881 ERROR [pool-3-thread-4] c.a.pay.PaymentService - Payment 700097 failed: ORA-00060: deadlock detected while waiting for resource", "Log acme-app-01:/app/logs/application.log"),
        ("shot", shot_terminal, "deadlock-log.png", "<p>Same error on both app servers at 10:14:</p>"),
        ("react", "👀"),
        ("reply", "<p>Looks like two refunds for the same payment in parallel — adding a row lock (PAY-200).</p>"),
    ]),
    ("PAY-101 Refund report CSV export", "PAY-101", "done", ["PAY-101"], False, [
        ("note", "<p>Released in 4.1.7 ✅ — CSV export works for all merchants.</p>"),
    ]),
]

def seed_threads(sim, port):
    a = Uploader(sim, port)
    have = {w["title"] for w in a.call("GET", "/api/work")}
    entries = a.call("GET", "/api/entries")
    for title, jira, status, tags, starred, posts in THREADS:
        if title in have:
            continue
        w = a.call("POST", "/api/work", {"title": title, "status": status, "tags": tags, "jira": jira})
        last = None
        for p in posts:
            kind = p[0]
            if kind == "note" or kind == "pin":
                last = a.call("POST", "/api/work/%s/posts" % w["id"], {"kind": "note", "html": p[1], "pinned": kind == "pin"})
            elif kind == "capture":
                last = a.call("POST", "/api/work/%s/posts" % w["id"], {"kind": "capture", "text": p[1], "from": p[2]})
            elif kind == "shot":
                at = a.upload(w["id"], p[2], p[1]())
                last = a.call("POST", "/api/work/%s/posts" % w["id"], {"kind": "note", "html": p[3] + '<p><img src="/api/props/files/%s" alt="%s"></p>' % (at["id"], p[2])})
            elif kind == "reply" and last:
                a.call("POST", "/api/work/%s/posts" % w["id"], {"kind": "note", "html": p[1], "parent": last["id"]})
            elif kind == "react" and last:
                a.call("PUT", "/api/work/%s/posts/%s" % (w["id"], last["id"]), {"reactions": [p[1]]})
            elif kind == "remind" and last:
                at = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=p[1])).isoformat()
                a.call("PUT", "/api/work/%s/posts/%s" % (w["id"], last["id"]), {"remind_at": at})
            elif kind == "entry":
                e = next((x for x in entries if x.get("host") == p[1]), None)
                if e:
                    a.call("POST", "/api/work/%s/posts" % w["id"], {"kind": "entry", "ref": e["id"]})
        if starred:
            a.call("POST", "/api/work/%s/star" % w["id"], {"starred": True})
    try:  # the linked issues show on the Jira page too
        a.call("POST", "/api/jira", {"ref": ", ".join(t[1] for t in THREADS if t[1] and not t[1].startswith("CM-"))})
    except Exception as e:
        print("jira:", e)
    print("threads seeded")

if __name__ == "__main__":
    import urllib.parse
    if sys.argv[1] == "home":
        home(sys.argv[2])
    elif sys.argv[1] == "threads":
        seed_threads(sys.argv[2], int(sys.argv[3]))
    else:
        seed_api(sys.argv[2], int(sys.argv[3]))
        seed_threads(sys.argv[2], int(sys.argv[3]))
