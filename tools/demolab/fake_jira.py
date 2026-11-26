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
    # An epic whose stories point to it (Jira Cloud "parent"): found as child work items.
    "PAY-200": ("10200", {**f("Merchant refunds 2.0", "In Progress", "Epic"), "assignee": {"displayName": "Me"}, "subtasks": [],
        "issuelinks": [link("CM-4433", "Refunds 2.0 go-live", "Scheduled")]}, []),
    "PAY-201": ("10201", {**f("Refund approval workflow", "In Progress", "Story"), "assignee": {"displayName": "Me"},
        "subtasks": [sub("PAY-202", "Approval rules engine", "In Progress"), sub("PAY-203", "Approval emails", "To Do"),
                     sub("PAY-204", "CM- deploy approval workflow to UAT", "Done")],
        "issuelinks": [link("CM-4433", "Refunds 2.0 go-live", "Scheduled"), link("QA-31", "Regression pack for approvals", "Open", "is tested by", "tests")]},
        [("PAY-201 approval workflow", "https://bitbucket.acme.local/projects/PAY/repos/pay-api/pull-requests/57", "OPEN", "pay-api"),
         ("PAY-201 approval emails", "https://bitbucket.acme.local/projects/PAY/repos/pay-notify/pull-requests/9", "MERGED", "pay-notify")]),
    "OPS-90": ("10090", {**f("Scale refund batch for 2.0 volumes", "To Do", "Task"), "assignee": {"displayName": "Me"},
        "subtasks": [sub("OPS-91", "Add batch node", "To Do")], "issuelinks": []}, []),
    "PAY-205": ("10205", {**f("Refund limits per merchant tier", "Blocked", "Story"), "assignee": {"displayName": "Me"}, "subtasks": [], "issuelinks": []},
        [("PAY-205 tier limits (draft)", "https://bitbucket.acme.local/projects/PAY/repos/pay-api/pull-requests/61", "DECLINED", "pay-api")]),
}
MINE_DONE = ["PAY-101", "PAY-088", "OPS-61"]
CHILDREN = {"PAY-123": [("PAY-140", "Validate refund limits in the API", "In Progress", "Story"),
                         ("PAY-141", "Show limit errors to merchants", "To Do", "Story")],
            # the epic's stories, from two projects
            "PAY-200": [("PAY-201", "Refund approval workflow", "In Progress", "Story"), ("PAY-205", "Refund limits per merchant tier", "Blocked", "Story"),
                        ("OPS-90", "Scale refund batch for 2.0 volumes", "To Do", "Task"), ("PAY-206", "Refund reports for finance", "Done", "Story")]}
MINE_OPEN = ["PAY-123", "PAY-130", "PAY-200", "PAY-201", "OPS-90", "PAY-205"]  # assigned to me, not done (found by "Add my issues")

# CM change issues with an implementation window (times relative to today, so
# the demo calendar always has some).
import datetime as _dt
def _at(days, hour, minute=0):
    d = _dt.datetime.now().astimezone().replace(hour=hour, minute=minute, second=0, microsecond=0) + _dt.timedelta(days=days)
    return d.strftime("%Y-%m-%dT%H:%M:%S.000%z")
CM = {
    "CM-4411": ("PROD release 4.2.1", "Scheduled", _at(2, 21), _at(2, 23, 30)),
    "CM-4420": ("Certificate renewal window", "Approved", _at(6, 19), _at(6, 20)),
    "CM-4390": ("PROD release 4.1.7", "Closed", _at(-10, 21), _at(-10, 22)),
    "CM-4433": ("Refunds 2.0 go-live", "Scheduled", _at(1, 20), _at(1, 23)),
}

# A pretend Confluence (at /wiki, same login) for 🔎 Ask: a few pages.
PAGES = {
    "9001": ("Batch server restart runbook", "OPS", "<h2>Restart order</h2><p>Stop the refund batch first: <code>/opt/batch/stop.sh</code>, wait for the queue to drain, then restart the app servers.</p><p>Start the batch again with <code>/opt/batch/start.sh</code> and check logs/batch.log for ERROR lines.</p>"),
    "9002": ("Refund limits per merchant tier", "PAY", "<p>Tier A merchants may refund up to 5000 EUR per day, tier B 2500 EUR, tier C 1000 EUR. Limits are approved by the risk team; changes go through a CM change.</p>"),
    "9003": ("Release checklist 4.2", "PAY", "<p>Before the PROD release: freeze merges, run the regression pack, get CM approval, announce the window in the release channel.</p>"),
    "9004": ("Team lunch menu", "SOCIAL", "<p>Pizza on Fridays.</p>"),
}
DESC = {"PAY-123": "Merchants need a daily refund limit. Limits per tier come from the risk team.", "PAY-205": "Blocked: waiting for the tier list (refund limits per merchant tier) from the merchant team.",
        "OPS-77": "Renew the TLS certificates on the batch servers before they expire; restart the batch after.", "PAY-201": "Refunds above the merchant limit need a second approver."}

def words_of(s):
    import re
    return [w for w in re.findall(r"[a-z0-9-]+", s.lower()) if len(w) > 1]

def hits(text, words, any_word):
    t = text.lower()
    return any(w in t for w in words) if any_word else all(w in t for w in words)

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
        if u.path == "/wiki/rest/api/space":
            return self.send({"results": [{"key": "PAY"}], "size": 1})
        if u.path == "/wiki/rest/api/search":
            from urllib.parse import unquote_plus
            import re
            cql = unquote_plus(q.get("cql", "")); words = [w for t in re.findall(r'text ~ "([^"]*)"', cql) for w in words_of(t)]
            res = []
            for pid, (title, space, body) in PAGES.items():
                plain = re.sub("<[^>]+>", " ", body)
                if hits(title + " " + plain, words, False):
                    res.append({"content": {"id": pid, "type": "page", "title": title}, "title": title, "url": f"/spaces/{space}/pages/{pid}",
                        "excerpt": " ".join(plain.split())[:160], "lastModified": "2026-11-18T09:00:00.000Z", "resultGlobalContainer": {"title": space}})
            return self.send({"results": res, "_links": {"base": "http://127.0.0.1:47990/wiki"}})
        if u.path.startswith("/wiki/rest/api/content/"):
            pid = parts[5]
            if pid in PAGES:
                return self.send({"id": pid, "title": PAGES[pid][0], "body": {"storage": {"value": PAGES[pid][2]}}})
            return self.send({}, 404)
        if u.path in ("/rest/api/3/search/jql", "/rest/api/2/search"):
            from urllib.parse import unquote_plus
            jql = unquote_plus(q.get("jql", ""))
            if "text ~" in jql:  # 🔎 Ask: issues whose summary / description has the words
                import re
                terms = re.findall(r'text ~ "([^"]*)"', jql); any_word = " OR " in jql
                words = [w for t in terms for w in words_of(t)]
                out = []
                for k, (iid, fields, _) in ISSUES.items():
                    if hits(fields["summary"] + " " + DESC.get(k, ""), words, any_word):
                        out.append({"key": k, "fields": {**fields, "description": DESC.get(k, ""), "updated": "2026-11-20T10:00:00.000+0000",
                            "project": {"name": k.split("-")[0]}, "comment": {"comments": []}}})
                return self.send({"issues": out})
            if jql.startswith("parent = ") or jql.startswith('"Epic Link" = '):  # child work items (Cloud parent / Server Epic Link)
                kids = CHILDREN.get(jql.split(" = ")[1].split()[0], [])
                return self.send({"issues": [{"key": k, "fields": {"summary": s, "status": {"name": st}, "issuetype": {"name": t}}} for k, s, st, t in kids]})
            keys = MINE_OPEN if "!=" in jql else MINE_DONE
            return self.send({"issues": [{"key": k} for k in keys], "total": len(keys)})
        if u.path.startswith("/rest/api/2/issue/CM-") and parts[5] in CM:
            summary, status, start, end = CM[parts[5]]
            return self.send({"key": parts[5], "names": {"summary": "Summary", "customfield_10501": "Planned start", "customfield_10502": "Planned end"},
                "fields": {"summary": summary, "status": {"name": status}, "customfield_10501": start, "customfield_10502": end}})
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
