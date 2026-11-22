#!/usr/bin/env python3
"""A pretend Jira (REST API subset) for the WorkHub demo: issues with
sub-tasks, linked CM- changes and pull requests. Token: "demo-token"."""
import json, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

DONE = {"Done", "Closed", "Resolved", "Released"}

def f(summary, status, kind, resolved=None):
    cat = "done" if status in DONE else "indeterminate"
    out = {"summary": summary, "status": {"name": status, "statusCategory": {"key": cat}}, "issuetype": {"name": kind}}
    if resolved:
        out["resolutiondate"] = resolved
    return out

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
    # My completed work (found by "Add my completed").
    "PAY-101": ("10101", {**f("Refund report CSV export", "Done", "Story", "2026-11-12T16:20:00.000+0000"), "assignee": {"displayName": "Me"},
        "subtasks": [sub("PAY-102", "CM- deploy to PROD", "Done")], "issuelinks": [link("CM-4390", "PROD release 4.1.7", "Closed")]},
        [("PAY-101 refund CSV", "https://bitbucket.acme.local/projects/PAY/repos/pay-api/pull-requests/38", "MERGED", "pay-api")]),
    "PAY-088": ("10088", {**f("Batch retry for failed refunds", "Closed", "Story", "2026-10-28T11:05:00.000+0000"), "assignee": {"displayName": "Me"},
        "subtasks": [sub("PAY-089", "CM- UAT deployment", "Done")], "issuelinks": []},
        [("PAY-088 batch retry", "https://bitbucket.acme.local/projects/PAY/repos/pay-batch/pull-requests/12", "MERGED", "pay-batch")]),
    "OPS-61": ("10061", {**f("Rotate Touchpoint TLS certificates", "Resolved", "Task", "2026-10-02T09:40:00.000+0000"), "assignee": {"displayName": "Me"},
        "subtasks": [], "issuelinks": [link("CM-4301", "Certificate change window", "Closed")]}, []),
}
MINE_DONE = ["PAY-101", "PAY-088", "OPS-61"]

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
        if u.path in ("/rest/api/3/search/jql", "/rest/api/2/search"):
            return self.send({"issues": [{"key": k} for k in MINE_DONE], "total": len(MINE_DONE)})
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
