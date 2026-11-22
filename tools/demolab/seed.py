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
    w = a.call("POST", "/api/work", {"title": "PAY-123 Refund limits – UAT testing", "status": "doing", "tags": ["PAY-123", "UAT"]})
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

if __name__ == "__main__":
    import urllib.parse
    if sys.argv[1] == "home":
        home(sys.argv[2])
    else:
        seed_api(sys.argv[2], int(sys.argv[3]))
