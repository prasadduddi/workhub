package main

// A pretend Jira + Confluence for the demo workspace (see demolab.go): the
// parts of their REST APIs WorkHub uses — issues with sub-tasks, linked CM
// changes with windows, pull requests, "my issues", Ask's search, the
// Confluence local copy — and simple pages for /browse/KEY and wiki links so
// clicking a link shows something. 127.0.0.1 only; made-up data. Sign-in:
// personal access token "demo-token".

import (
	"encoding/json"
	"fmt"
	"html"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const demoJiraToken = "demo-token"

type djIssue struct {
	id, summary, status, kind, assignee, desc, resolved string
	subs                                                [][3]string // key, summary, status
	links                                               [][5]string // key, summary, status, outward, inward
	prs                                                 [][4]string // name, url, status, repo
}

var djDone = map[string]bool{"Done": true, "Closed": true, "Resolved": true, "Released": true}

const djRepo = "https://bitbucket.acme.example.com/projects/PAY/repos/"

var djIssues = map[string]djIssue{
	"PAY-301": {id: "10301", summary: "Refund limits per merchant", status: "In Progress", kind: "Story", assignee: "Me",
		desc:  "Merchants get a daily refund limit by tier: A 5000, B 2500, C 1000 EUR. Limits come from the risk team; changes go through a CM change.",
		subs:  [][3]string{{"PAY-302", "CM- deploy to UAT", "Done"}, {"PAY-303", "Write tests", "In Progress"}, {"PAY-304", "CM- deploy to PROD", "To Do"}},
		links: [][5]string{{"CM-512", "PROD release 4.3.0", "Scheduled", "implements", "is implemented by"}, {"OPS-140", "Index rebuild on the ledger DB", "Open", "relates to", "relates to"}},
		prs:   [][4]string{{"PAY-301 refund limits API", djRepo + "pay-api/pull-requests/142", "OPEN", "pay-api"}, {"PAY-301 DB migration", djRepo + "pay-db/pull-requests/37", "MERGED", "pay-db"}}},
	"PAY-310": {id: "10310", summary: "Refund limits screen in the merchant portal", status: "Code Review", kind: "Story", assignee: "Raj Dev",
		subs: [][3]string{{"PAY-311", "CM- UAT deployment", "To Do"}},
		prs:  [][4]string{{"PAY-310 limits UI", djRepo + "merchant-portal/pull-requests/88", "OPEN", "merchant-portal"}, {"PAY-310 old attempt", djRepo + "merchant-portal/pull-requests/80", "DECLINED", "merchant-portal"}}},
	"INC-118": {id: "10118", summary: "Slow refunds after release 4.2.7", status: "In Progress", kind: "Incident", assignee: "Me",
		desc:  "Refunds take 30 s and time out calling the ledger. Ledger DB CPU at 95% between 10:00 and 10:20. Index rebuild planned (CM-512 window).",
		links: [][5]string{{"CM-515", "Ledger index rebuild", "Approved", "is fixed by", "fixes"}}},
	"OPS-140": {id: "10140", summary: "Index rebuild on the ledger DB", status: "Open", kind: "Task", assignee: "",
		desc: "Rebuild idx_payments_merchant during a quiet window; check the batch timings afterwards."},
	"OPS-77": {id: "10077", summary: "Renew batch server certificates", status: "To Do", kind: "Task", assignee: "Me",
		desc:  "Renew the TLS certificates on the batch servers before they expire; restart the batch after.",
		links: [][5]string{{"CM-520", "Certificate renewal window", "Approved", "implements", "is implemented by"}}},
	"PAY-200": {id: "10200", summary: "Merchant refunds 2.0", status: "In Progress", kind: "Epic", assignee: "Me",
		links: [][5]string{{"CM-533", "Refunds 2.0 go-live", "Scheduled", "implements", "is implemented by"}}},
	"PAY-201": {id: "10201", summary: "Refund approval workflow", status: "In Progress", kind: "Story", assignee: "Me",
		desc:  "Refunds above the merchant limit need a second approver.",
		subs:  [][3]string{{"PAY-202", "Approval rules engine", "In Progress"}, {"PAY-203", "Approval emails", "To Do"}, {"PAY-204", "CM- deploy approval workflow to UAT", "Done"}},
		links: [][5]string{{"CM-533", "Refunds 2.0 go-live", "Scheduled", "implements", "is implemented by"}, {"QA-31", "Regression pack for approvals", "Open", "is tested by", "tests"}},
		prs:   [][4]string{{"PAY-201 approval workflow", djRepo + "pay-api/pull-requests/157", "OPEN", "pay-api"}, {"PAY-201 approval emails", djRepo + "pay-notify/pull-requests/9", "MERGED", "pay-notify"}}},
	"PAY-205": {id: "10205", summary: "Refund limits per merchant tier (data load)", status: "Blocked", kind: "Story", assignee: "Me",
		desc: "Blocked: waiting for the tier list from the merchant team.",
		prs:  [][4]string{{"PAY-205 tier limits (draft)", djRepo + "pay-api/pull-requests/161", "DECLINED", "pay-api"}}},
	"OPS-90": {id: "10090", summary: "Scale refund batch for 2.0 volumes", status: "To Do", kind: "Task", assignee: "Me",
		subs: [][3]string{{"OPS-91", "Add batch node", "To Do"}}},
	// my completed work (found by "Add my completed")
	"PAY-101": {id: "10101", summary: "Refund report CSV export", status: "Done", kind: "Story", assignee: "Me", resolved: "-16d",
		subs:  [][3]string{{"PAY-102", "CM- deploy to PROD", "Done"}},
		links: [][5]string{{"CM-490", "PROD release 4.1.7", "Closed", "implements", "is implemented by"}},
		prs:   [][4]string{{"PAY-101 refund CSV", djRepo + "pay-api/pull-requests/138", "MERGED", "pay-api"}}},
	"PAY-088": {id: "10088", summary: "Batch retry for failed refunds", status: "Closed", kind: "Story", assignee: "Me", resolved: "-31d",
		subs: [][3]string{{"PAY-089", "CM- UAT deployment", "Done"}},
		prs:  [][4]string{{"PAY-088 batch retry", djRepo + "pay-batch/pull-requests/12", "MERGED", "pay-batch"}}},
	"OPS-61": {id: "10061", summary: "Rotate TLS certificates on the payment gateway", status: "Resolved", kind: "Task", assignee: "Me", resolved: "-57d"},
}

var djMineOpen = []string{"PAY-301", "INC-118", "OPS-77", "PAY-200", "PAY-201", "OPS-90", "PAY-205"}
var djMineDone = []string{"PAY-101", "PAY-088", "OPS-61"}

var djChildren = map[string][][4]string{
	"PAY-301": {{"PAY-320", "Validate refund limits in the API", "In Progress", "Story"}, {"PAY-321", "Show limit errors to merchants", "To Do", "Story"}},
	"PAY-200": {{"PAY-201", "Refund approval workflow", "In Progress", "Story"}, {"PAY-205", "Refund limits per merchant tier (data load)", "Blocked", "Story"},
		{"OPS-90", "Scale refund batch for 2.0 volumes", "To Do", "Task"}, {"PAY-206", "Refund reports for finance", "Done", "Story"}},
}

// djCM: change issues with an implementation window, relative to today.
var djCM = map[string][5]any{ // summary, status, days from today, start hour, hours long
	"CM-512": {"PROD release 4.3.0", "Scheduled", 2, 21, 2.5},
	"CM-515": {"Ledger index rebuild", "Approved", 1, 22, 1.0},
	"CM-520": {"Certificate renewal window", "Approved", 6, 19, 1.0},
	"CM-490": {"PROD release 4.1.7", "Closed", -16, 21, 1.0},
	"CM-533": {"Refunds 2.0 go-live", "Scheduled", 9, 20, 3.0},
}

type djPage struct{ title, space, body string }

var djPages = map[string]djPage{
	"9001": {"Batch server restart runbook", "OPS", "<h2>Restart order</h2><p>Stop the refund batch first: <code>/opt/batch/bin/stop.sh</code>, wait for the queue to drain, then restart the app servers with <code>/opt/payments/bin/restart.sh</code>.</p><p>Start the batch again with <code>/opt/batch/bin/start.sh</code> and check <code>/opt/batch/logs/batch.log</code> for ERROR lines.</p>"},
	"9002": {"Refund limits per merchant tier", "PAY", "<p>Tier A merchants may refund up to 5000 EUR per day, tier B 2500 EUR, tier C 1000 EUR. Limits are approved by the risk team; changes go through a CM change.</p><p>The limits are in the <code>merchants.daily_refund_limit</code> column of the payments database.</p>"},
	"9003": {"Release checklist 4.3", "PAY", "<p>Before the PROD release: freeze merges, run the regression pack, get CM approval, announce the window in the release channel.</p><ol><li>Stop batch</li><li>Deploy app-01, app-02</li><li>DB scripts</li><li>Start batch, smoke test</li></ol>"},
	"9004": {"Team lunch menu", "SOCIAL", "<p>Pizza on Fridays.</p>"},
	"9005": {"Restarting payment services after an outage", "OPS", "<p>If payments stop after an outage, restarting the payment API usually clears stuck connections. Check the ORA errors in <code>/opt/payments/logs/application.log</code> first.</p>"},
	"9006": {"Certificate renewal procedure", "OPS", "<p>Certificates on the batch servers expire yearly. Renew them in the keystore and restart the batch afterwards. WorkHub's Monitor shows the days left for every HTTPS check.</p>"},
	"9007": {"Partner file drop (SFTP / FTP)", "OPS", "<p>Partners put settlement files in <code>/inbound</code> on the partner server; we put reports in <code>/outbound</code>. Files are named <code>SETTLEMENT_YYYYMMDD.csv</code>.</p>"},
	"9008": {"Payments database: useful queries", "PAY", "<p>Failed payments today: <code>SELECT * FROM v_failed_payments WHERE created_at &gt;= current_date</code>. Refunds waiting for approval: <code>SELECT * FROM refunds WHERE status = 'PENDING_APPROVAL'</code>.</p>"},
}

var djSpaces = [][2]string{{"OPS", "Operations"}, {"PAY", "Payments"}, {"SOCIAL", "Social"}}

func djFields(i djIssue) map[string]any {
	cat := "indeterminate"
	if djDone[i.status] {
		cat = "done"
	}
	f := map[string]any{"summary": i.summary, "status": map[string]any{"name": i.status, "statusCategory": map[string]string{"key": cat}},
		"issuetype": map[string]string{"name": i.kind}, "description": i.desc, "updated": time.Now().Add(-3 * time.Hour).Format("2006-01-02T15:04:05.000-0700")}
	if i.assignee != "" {
		f["assignee"] = map[string]string{"displayName": i.assignee}
	} else {
		f["assignee"] = nil
	}
	if i.resolved != "" {
		d, _ := strconv.Atoi(strings.TrimSuffix(i.resolved, "d"))
		f["resolutiondate"] = time.Now().AddDate(0, 0, d).Format("2006-01-02T15:04:05.000-0700")
	}
	subs := []any{}
	for _, s := range i.subs {
		subs = append(subs, map[string]any{"key": s[0], "fields": djFields(djIssue{summary: s[1], status: s[2], kind: "Sub-task"})})
	}
	links := []any{}
	for _, l := range i.links {
		kind := "Change"
		if !strings.HasPrefix(l[0], "CM-") {
			kind = "Task"
		}
		links = append(links, map[string]any{"type": map[string]string{"outward": l[3], "inward": l[4]},
			"outwardIssue": map[string]any{"key": l[0], "fields": djFields(djIssue{summary: l[1], status: l[2], kind: kind})}})
	}
	f["subtasks"], f["issuelinks"] = subs, links
	return f
}

func djWords(s string) []string {
	var out []string
	for _, w := range regexp.MustCompile(`[a-z0-9-]+`).FindAllString(strings.ToLower(s), -1) {
		if len(w) > 1 {
			out = append(out, w)
		}
	}
	return out
}

func djHits(text string, words []string, anyWord bool) bool {
	t := strings.ToLower(text)
	if len(words) == 0 {
		return false
	}
	for _, w := range words {
		if strings.Contains(t, w) == anyWord {
			return anyWord
		}
	}
	return !anyWord
}

var (
	reDJText  = regexp.MustCompile(`text ~ "([^"]*)"`)
	reDJSpace = regexp.MustCompile(`space = "([^"]+)"`)
	reTags    = regexp.MustCompile(`<[^>]+>`)
)

func (l *demoLab) jiraHandler() http.Handler {
	mux := http.NewServeMux()
	send := func(w http.ResponseWriter, v any, code int) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(code)
		_ = json.NewEncoder(w).Encode(v)
	}
	base := func() string { return fmt.Sprintf("http://127.0.0.1:%d", l.port("jira")) }
	page := func(w http.ResponseWriter, title, body string) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprintf(w, `<!doctype html><meta charset="utf-8"><title>%s</title><body style="font:15px/1.5 system-ui,sans-serif;max-width:820px;margin:40px auto;color:#172b4d">
<div style="background:#0052cc;color:#fff;padding:8px 14px;border-radius:6px;margin-bottom:18px">Acme Bank — pretend Jira &amp; Confluence (WorkHub demo, made-up data)</div>%s</body>`, html.EscapeString(title), body)
	}
	mux.HandleFunc("/browse/", func(w http.ResponseWriter, r *http.Request) {
		key := strings.TrimPrefix(r.URL.Path, "/browse/")
		i, ok := djIssues[key]
		if cm, isCM := djCM[key]; isCM {
			i, ok = djIssue{summary: cm[0].(string), status: cm[1].(string), kind: "Change"}, true
		}
		if !ok {
			page(w, key, "<h1>"+html.EscapeString(key)+"</h1><p>This issue is not in the demo.</p>")
			return
		}
		var b strings.Builder
		fmt.Fprintf(&b, "<h1>%s %s</h1><p><b>%s</b> · %s · assignee %s</p><p>%s</p>", key, html.EscapeString(i.summary), i.status, i.kind, html.EscapeString(orDefault(i.assignee, "nobody")), html.EscapeString(i.desc))
		for _, s := range i.subs {
			fmt.Fprintf(&b, "<div>↳ <a href='/browse/%s'>%s</a> %s — %s</div>", s[0], s[0], html.EscapeString(s[1]), s[2])
		}
		page(w, key, b.String())
	})
	mux.HandleFunc("/wiki/spaces/", func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Split(r.URL.Path, "/")
		if p, ok := djPages[parts[len(parts)-1]]; ok {
			page(w, p.title, "<h1>"+html.EscapeString(p.title)+"</h1><p style='color:#6b778c'>Space "+p.space+"</p>"+p.body)
			return
		}
		page(w, "Confluence", "<p>Page not found in the demo.</p>")
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/rest/") && !strings.HasPrefix(r.URL.Path, "/wiki/rest/") {
			page(w, "Jira", "<h1>Acme Bank Jira (demo)</h1><p>Open an issue from WorkHub's Jira page.</p>")
			return
		}
		if r.Header.Get("Authorization") != "Bearer "+demoJiraToken {
			send(w, map[string]any{"errorMessages": []string{"You are not signed in"}}, 401)
			return
		}
		q := r.URL.Query()
		p := r.URL.Path
		parts := strings.Split(p, "/")
		switch {
		case p == "/rest/api/2/myself":
			send(w, map[string]string{"displayName": "Demo User", "name": "demo", "emailAddress": "demo.user@acme.example.com"}, 200)
		case p == "/wiki/rest/api/space":
			res := []any{}
			for _, s := range djSpaces {
				res = append(res, map[string]string{"key": s[0], "name": s[1]})
			}
			send(w, map[string]any{"results": res, "size": len(res)}, 200)
		case p == "/wiki/rest/api/content/search": // the local copy: a space's pages, two per answer
			cql := q.Get("cql")
			var ids []string
			if m := reDJSpace.FindStringSubmatch(cql); m != nil {
				for id, pg := range djPages {
					if pg.space == m[1] {
						ids = append(ids, id)
					}
				}
			}
			sort.Strings(ids)
			start, _ := strconv.Atoi(q.Get("cursor"))
			end := min(start+2, len(ids))
			res := []any{}
			if !strings.Contains(cql, "lastmodified") {
				for _, id := range ids[min(start, len(ids)):end] {
					pg := djPages[id]
					res = append(res, map[string]any{"id": id, "type": "page", "title": pg.title, "version": map[string]any{"number": 1, "when": time.Now().AddDate(0, 0, -10).UTC().Format("2006-01-02T15:04:05.000Z")},
						"space": map[string]string{"key": pg.space, "name": pg.space}, "body": map[string]any{"storage": map[string]string{"value": pg.body}},
						"_links": map[string]string{"webui": "/spaces/" + pg.space + "/pages/" + id}})
				}
			}
			links := map[string]string{"base": base() + "/wiki"}
			if end < len(ids) && !strings.Contains(cql, "lastmodified") {
				links["next"] = "/rest/api/content/search?cql=" + url.QueryEscape(cql) + "&expand=body.storage,version,space&limit=50&cursor=" + strconv.Itoa(end)
			}
			send(w, map[string]any{"results": res, "_links": links}, 200)
		case p == "/wiki/rest/api/search":
			var words []string
			for _, m := range reDJText.FindAllStringSubmatch(q.Get("cql"), -1) {
				words = append(words, djWords(m[1])...)
			}
			res := []any{}
			for id, pg := range djPages {
				plain := strings.Join(strings.Fields(reTags.ReplaceAllString(pg.body, " ")), " ")
				if djHits(pg.title+" "+plain, words, false) {
					res = append(res, map[string]any{"content": map[string]string{"id": id, "type": "page", "title": pg.title}, "title": pg.title,
						"url": "/spaces/" + pg.space + "/pages/" + id, "excerpt": plain[:min(160, len(plain))], "lastModified": time.Now().AddDate(0, 0, -10).UTC().Format("2006-01-02T15:04:05.000Z"),
						"resultGlobalContainer": map[string]string{"title": pg.space}})
				}
			}
			send(w, map[string]any{"results": res, "_links": map[string]string{"base": base() + "/wiki"}}, 200)
		case strings.HasPrefix(p, "/wiki/rest/api/content/"):
			if pg, ok := djPages[parts[5]]; ok {
				send(w, map[string]any{"id": parts[5], "title": pg.title, "body": map[string]any{"storage": map[string]string{"value": pg.body}}}, 200)
			} else {
				send(w, map[string]any{}, 404)
			}
		case p == "/rest/api/3/search/jql" || p == "/rest/api/2/search":
			jql := q.Get("jql")
			switch {
			case strings.Contains(jql, "text ~"): // Ask: issues whose summary / description has the words
				var words []string
				for _, m := range reDJText.FindAllStringSubmatch(jql, -1) {
					words = append(words, djWords(m[1])...)
				}
				out := []any{}
				for k, i := range djIssues {
					if djHits(i.summary+" "+i.desc, words, strings.Contains(jql, " OR ")) {
						f := djFields(i)
						f["project"], f["comment"] = map[string]string{"name": strings.Split(k, "-")[0]}, map[string]any{"comments": []any{}}
						out = append(out, map[string]any{"key": k, "fields": f})
					}
				}
				send(w, map[string]any{"issues": out}, 200)
			case strings.HasPrefix(jql, "parent = ") || strings.HasPrefix(jql, `"Epic Link" = `):
				key := strings.Fields(strings.SplitN(jql, " = ", 2)[1])[0]
				out := []any{}
				for _, c := range djChildren[strings.Trim(key, `"`)] {
					out = append(out, map[string]any{"key": c[0], "fields": map[string]any{"summary": c[1], "status": map[string]string{"name": c[2]}, "issuetype": map[string]string{"name": c[3]}}})
				}
				send(w, map[string]any{"issues": out}, 200)
			default:
				keys := djMineDone
				if strings.Contains(jql, "!=") {
					keys = djMineOpen
				}
				out := []any{}
				for _, k := range keys {
					out = append(out, map[string]string{"key": k})
				}
				send(w, map[string]any{"issues": out, "total": len(out)}, 200)
			}
		case strings.HasPrefix(p, "/rest/api/2/issue/") && len(parts) > 5:
			key := parts[5]
			if cm, ok := djCM[key]; ok {
				day := time.Now().AddDate(0, 0, cm[2].(int))
				start := time.Date(day.Year(), day.Month(), day.Day(), cm[3].(int), 0, 0, 0, time.Local)
				end := start.Add(time.Duration(cm[4].(float64) * float64(time.Hour)))
				f := "2006-01-02T15:04:05.000-0700"
				send(w, map[string]any{"key": key, "names": map[string]string{"summary": "Summary", "customfield_10501": "Planned start", "customfield_10502": "Planned end"},
					"fields": map[string]any{"summary": cm[0], "status": map[string]string{"name": cm[1].(string)}, "customfield_10501": start.Format(f), "customfield_10502": end.Format(f)}}, 200)
				return
			}
			i, ok := djIssues[key]
			if !ok {
				send(w, map[string]any{"errorMessages": []string{"Issue does not exist"}}, 404)
				return
			}
			if strings.HasSuffix(p, "/remotelink") {
				send(w, []any{}, 200)
				return
			}
			send(w, map[string]any{"id": i.id, "key": key, "fields": djFields(i)}, 200)
		case strings.HasPrefix(p, "/rest/dev-status/"):
			var iss *djIssue
			for _, i := range djIssues {
				if i.id == q.Get("issueId") {
					iss = &i
					break
				}
			}
			if strings.HasSuffix(p, "/issue/summary") {
				by := map[string]any{}
				if iss != nil && len(iss.prs) > 0 {
					by["stash"] = map[string]any{}
				}
				send(w, map[string]any{"summary": map[string]any{"pullrequest": map[string]any{"byInstanceType": by}}}, 200)
				return
			}
			prs := []any{}
			if iss != nil {
				for _, pr := range iss.prs {
					prs = append(prs, map[string]any{"name": pr[0], "url": pr[1], "status": pr[2], "repositoryName": pr[3], "author": map[string]string{"name": "dev"}})
				}
			}
			send(w, map[string]any{"detail": []any{map[string]any{"pullRequests": prs}}}, 200)
		default:
			send(w, map[string]any{}, 404)
		}
	})
	return mux
}
