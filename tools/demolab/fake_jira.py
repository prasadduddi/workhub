#!/usr/bin/env python3
"""A pretend Jira (REST API subset) for the WorkHub demo: issues with
sub-tasks, linked CM- changes and pull requests. Token: "demo-token"."""
import json, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

def f(summary, status, kind):
    return {"summary": summary, "status": {"name": status}, "issuetype": {"name": kind}}

def sub(key, summary, status="To Do"):
    return {"key": key, "fields": f(summary, status, "Sub-task")}

def link(key, summary, status, out="implements", inn="is implemented by"):
    return {"type": {"outward": out, "inward": inn}, "outwardIssue": {"key": key, "fields": f(summary, status, "Change")}}

ISSUES = {
    "PAY-123": ("10123", {**f("Refund limits for merchants", "In Progress", "Story"), "assignee": {"displayName": "Ann Dev"},
        "subtasks": [sub("PAY-124", "CM- deploy to UAT", "Done"), sub("PAY-125", "Write tests", "In Progress"), sub("PAY-126", "CM- deploy to PROD")],
        "issuelinks": [link("CM-4411", "PROD release 4.2.1", "Scheduled"), link("OPS-9", "Unrelated ops task", "Open", "relates to", "relates to")]},
        [("PAY-123 refund limits API", "https://bitbucket.acme.local/projects/PAY/repos/pay-api/pull-requests/42", "OPEN", "pay-api"),
         ("PAY-123 DB migration", "https://bitbucket.acme.local/projects/PAY/repos/pay-db/pull-requests/7", "MERGED", "pay-db")]),
    "PAY-130": ("10130", {**f("Refund limits screen in Picasso", "Code Review", "Story"), "assignee": {"displayName": "Raj Dev"},
        "subtasks": [sub("PAY-131", "CM- UAT deployment", "To Do")], "issuelinks": []},
        [("PAY-130 limits UI", "https://bitbucket.acme.local/projects/PAY/repos/picasso-ui/pull-requests/88", "OPEN", "picasso-ui"),
         ("PAY-130 old attempt", "https://bitbucket.acme.local/projects/PAY/repos/picasso-ui/pull-requests/80", "DECLINED", "picasso-ui")]),
    "OPS-77": ("10077", {**f("Renew batch server certificates", "To Do", "Task"), "assignee": None, "subtasks": [],
        "issuelinks": [link("CM-4420", "Certificate renewal window", "Approved")]}, []),
}

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        u = urlparse(self.path); q = dict(p.split("=", 1) for p in u.query.split("&") if "=" in p)
        if self.headers.get("Authorization") != "Bearer demo-token":
            return self.send({}, 401)
        parts = u.path.split("/")
        if u.path.startswith("/rest/api/2/issue/"):
            key = parts[5]
            if key not in ISSUES:
                return self.send({}, 404)
            if u.path.endswith("/remotelink"):
                return self.send([])
            iid, fields, _ = ISSUES[key]
            return self.send({"id": iid, "key": key, "fields": fields})
        by_id = {v[0]: v for v in ISSUES.values()}
        iss = by_id.get(q.get("issueId", ""))
        if u.path.endswith("/issue/summary"):
            return self.send({"summary": {"pullrequest": {"byInstanceType": {"stash": {}} if iss and iss[2] else {}}}})
        if u.path.endswith("/issue/detail"):
            prs = [{"name": n, "url": url, "status": s, "repositoryName": r, "author": {"name": "dev"}} for n, url, s, r in (iss[2] if iss else [])]
            return self.send({"detail": [{"pullRequests": prs}]})
        self.send({}, 404)

ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 47990), H).serve_forever()
