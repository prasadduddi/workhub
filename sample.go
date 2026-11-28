package main

// Sample data for a demo workspace (File → New workspace… → with sample data):
// a fictional bank ("Acme Bank") with made-up servers, passwords and work —
// enough to show every part of WorkHub without anything real. The servers,
// database, FTP, Jira, Confluence, API and mailbox are pretend ones that run
// inside WorkHub while this workspace is open (demolab.go), so connecting,
// browsing files, running SQL, capturing traffic and checking email all work.

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	git "github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing/object"
)

const demoNote = "Demo server — runs inside WorkHub while this workspace is open (made-up data)."

func seedSample(s *Store) {
	pw := func(p string) *string { return &p }
	type ent struct {
		role, project, name, host string
		port                      int
		proto, url, user, pass    string
		env                       string
		extra                     map[string]string
		fav                       bool
	}
	const U, P = "uat.acme.example.com", "prod.acme.example.com"
	entries := []ent{
		// pretend servers (their 127.0.0.1 ports are set at each start). DEV so they show
	// at once (UAT / PROD are hidden until picked at the top); the PROD ones show that switch.
		{"app1", "Payments", "Payments app 1", "127.0.0.1", demoPorts["app1"], "ssh", "", "deploy", "Demo#2026", "DEV",
			map[string]string{"tunnels": "15432:db-01." + U + ":5432", "color": "#4caf50"}, true},
		{"app2", "Payments", "Payments app 2", "127.0.0.1", demoPorts["app2"], "ssh", "", "deploy", "Demo#2026", "DEV", nil, false},
		{"prod", "Payments", "Payments app PROD", "127.0.0.1", demoPorts["prod"], "ssh", "", "support", "Supp#2026", "PROD", nil, false},
		{"batch", "Batch", "Batch server", "127.0.0.1", demoPorts["batch"], "ssh", "", "batch", "Batch#2026", "DEV",
			map[string]string{"commands": "cd /opt/batch\ntail -n 20 logs/batch.log"}, false},
		{"partner", "Partners", "Partner file drop (SFTP)", "127.0.0.1", demoPorts["partner"], "sftp", "", "acme_drop", "Drop#2026", "", nil, false},
		{"ftp", "Partners", "Legacy reports (FTP)", "127.0.0.1", demoPorts["ftp"], "ftp", "", "ftpuser", "Ftp#2026", "", nil, false},
		{"pg", "Databases", "Payments DB", "127.0.0.1", demoPorts["pg"], "postgres", "", "pay_app", "Pay#App26", "DEV", map[string]string{"database": demoDBName}, true},
		{"pg#prod", "Databases", "Payments DB PROD (read-only)", "127.0.0.1", demoPorts["pg"], "postgres", "", "pay_ro", "PayRO#26", "PROD", map[string]string{"database": demoDBName}, false},
		{"pg-tunnel", "Databases", "Payments DB via jump server", "localhost", 15432, "postgres", "", "pay_app", "Pay#App26", "DEV",
			map[string]string{"database": demoDBName}, false},
		// links to the pretend Jira, Confluence and API
		{"url:jira:/browse/PAY-301", "Bookmarks", "Jira — PAY-301 Refund limits", "", 0, "", "http://127.0.0.1/", "", "", "DEV", nil, true},
		{"url:jira:/wiki/spaces/OPS/pages/9001", "Bookmarks", "Runbook: batch server restart", "", 0, "", "http://127.0.0.1/", "", "", "", nil, false},
		{"url:api:/actuator/health", "Bookmarks", "Payments API health", "", 0, "", "http://127.0.0.1/", "", "", "DEV", nil, false},
		{"url:apitls:/actuator/info", "Bookmarks", "Payments API (HTTPS)", "", 0, "", "https://127.0.0.1/", "", "", "DEV", nil, false},
		// names only: shown in search and bookmarks, not reachable
		{"", "Bookmarks", "Grafana — payments", "", 0, "", "https://grafana.acme.example.com/d/payments", "", "", "", nil, false},
		{"", "Bookmarks", "Jenkins — deploy payments", "", 0, "", "https://jenkins.acme.example.com/job/payments-deploy/", "", "", "", nil, false},
		{"", "Bookmarks", "Payments console PROD", "", 0, "", "https://app-01." + P + ":8443/console", "", "", "PROD", nil, false},
	}
	roles := map[string]string{}
	ids := map[string]string{}
	for _, e := range entries {
		in := EntryInput{Project: e.project, Name: e.name, Host: e.host, Port: e.port, Protocol: e.proto, URL: e.url, Username: e.user, Env: e.env, Extra: e.extra, Favorite: e.fav}
		if e.role != "" {
			in.Notes = demoNote
		} else {
			in.Notes = "Sample bookmark — this site doesn't exist."
		}
		if e.pass != "" {
			in.Password = pw(e.pass)
		}
		v, err := s.SaveEntry(in)
		if err != nil {
			continue
		}
		if e.role != "" {
			roles[v.ID] = e.role
			ids[e.role] = v.ID
		}
	}

	day := func(d int) time.Time { return time.Now().Add(time.Duration(d) * 24 * time.Hour) }
	type thread struct {
		title, status, jira string
		tags                []string
		starred             bool
		parent              string
		posts               []Post
	}
	note := func(h string) Post { return Post{Kind: "note", HTML: h} }
	threads := []thread{
		{"PAY-301 Refund limits per merchant", "doing", "PAY-301", []string{"UAT"}, true, "", []Post{
			{Kind: "note", HTML: "<p><b>Goal</b>: merchants get a daily refund limit by tier (A 5000, B 2500, C 1000 EUR).</p>", Pinned: true},
			note("<p>Deployed build 4.3.0-rc1 to UAT app-01 and app-02. Smoke test OK.</p>"),
			{Kind: "entry", Ref: ids["app1"]},
			note("<p>Limits are in <code>merchants.daily_refund_limit</code> — check with <code>SELECT name, tier, daily_refund_limit FROM merchants</code>.</p>"),
			{Kind: "note", HTML: "<p>Waiting for the tier list from the merchant team — asked on Monday.</p>", RemindAt: time.Now().Add(26 * time.Hour), Reactions: []string{"👀"}},
		}},
		{"PAY-301 · API tests", "doing", "", []string{"UAT"}, false, "PAY-301 Refund limits per merchant", []Post{
			note("<p>API page → <b>Payments API</b> → <i>Refund over the limit</i> returns 422 REFUND_LIMIT_EXCEEDED ✅</p>"),
		}},
		{"INC-118 Slow refunds after release", "doing", "INC-118", []string{"Incident"}, true, "", []Post{
			{Kind: "capture", Text: "2026-11-24 10:14:02 ERROR RefundService - timeout calling ledger after 30000 ms", From: "Teams"},
			note("<p>Same on both app servers. Ledger DB CPU at 95% between 10:00 and 10:20.</p>"),
			note("<p>Log viewer on <b>Payments app 1</b> → <code>/opt/payments/logs/application.log</code>, filter <code>ORA-</code>.</p>"),
			note("<p>Index rebuild tomorrow 22:00 — CM-515.</p>"),
		}},
		{"CM-512 PROD release 4.3.0", "todo", "CM-512", []string{"PROD", "Release"}, false, "", []Post{
			note("<p>Window: Saturday 21:00–23:30. Rollback plan: redeploy 4.2.7.</p>"),
			note("<ul><li>Stop batch</li><li>Deploy app-01, app-02</li><li>DB scripts</li><li>Start batch, smoke test</li></ul>"),
			{Kind: "entry", Ref: ids["prod"]},
		}},
		{"OPS-77 Renew batch certificates", "blocked", "OPS-77", []string{"UAT"}, false, "", []Post{
			note("<p>Monitor shows the payments API HTTPS certificate expires in 12 days 🔒 — renew it with the batch ones.</p>"),
		}},
		{"Partner settlement files", "todo", "", []string{"Partners"}, false, "", []Post{
			note("<p>Partner puts files in <code>/inbound</code> on the SFTP drop; old reports are on the legacy FTP in <code>/reports</code>.</p>"),
			{Kind: "entry", Ref: ids["partner"]},
		}},
		{"Onboarding notes", "done", "", nil, false, "", []Post{
			note("<p>Useful: the Ask page searches Confluence and Jira; Ctrl+K searches everything.</p>"),
			note("<p>All servers in this workspace are pretend ones — try anything: <code>ls</code>, <code>tail -f</code>, <code>systemctl status pay-api</code>, <code>./bin/restart.sh</code>.</p>"),
		}},
	}
	byTitle := map[string]string{}
	for _, t := range threads {
		w := s.SaveWorkItem(WorkItem{Title: t.title, Status: t.status, Jira: t.jira, Tags: t.tags})
		byTitle[t.title] = w.ID
		for i, p := range t.posts {
			if p.Kind == "entry" && p.Ref == "" {
				continue
			}
			p.At = day(-len(t.posts) + i).Add(-2 * time.Hour)
			_, _ = s.AddPost(w.ID, p)
		}
		if t.parent != "" {
			_ = s.SetWorkParent(w.ID, byTitle[t.parent])
		}
		if t.starred {
			s.mu.Lock()
			if x := s.workItem(w.ID); x != nil {
				x.Starred = true
				s.changed()
			}
			s.mu.Unlock()
		}
	}

	for _, n := range []Note{
		{Title: "Release checklist", Body: "# Release checklist\n\n1. Freeze merges\n2. Regression pack green\n3. CM approved\n4. Announce the window\n5. Deploy, smoke test, close CM\n"},
		{Title: "Who to call", Body: "Database team: dba@acme.example.com\nNetwork: network@acme.example.com\nOn-call: see the rota page\n"},
		{Title: "Useful SQL", Body: "# Useful SQL\n\n```sql\nSELECT * FROM v_failed_payments ORDER BY created_at DESC;\nSELECT status, count(*) FROM payments GROUP BY status;\n```\n"},
		{Title: "Demo servers", Body: "# Demo servers\n\nEverything here runs inside WorkHub while this workspace is open:\n\n- SSH: Payments app 1 / 2 / PROD, Batch server\n- SFTP: Partner file drop · FTP: Legacy reports\n- PostgreSQL: Payments DB (also via the jump server tunnel, and a read-only PROD login)\n- Jira + Confluence, a payments API (HTTP and HTTPS), and a mailbox for the email check\n"},
	} {
		s.SaveNote(n)
	}

	for _, ev := range []Event{
		{Title: "Daily stand-up", Date: day(0).Format("2006-01-02"), Start: "09:30", End: "09:45", Repeat: "weekdays", Remind: 5},
		{Title: "CM-512 PROD release 4.3.0", Date: day(2).Format("2006-01-02"), Start: "21:00", End: "23:30", Remind: 30, Color: "#e53935"},
		{Title: "CM-515 Ledger index rebuild", Date: day(1).Format("2006-01-02"), Start: "22:00", End: "23:00", Remind: 15},
		{Title: "Refund limits review with the merchant team", Date: day(1).Format("2006-01-02"), Start: "14:00", End: "15:00", Remind: 10},
		{Title: "Certificate renewal", Date: day(6).Format("2006-01-02"), Remind: -1, Notes: "OPS-77"},
	} {
		_, _ = s.SaveEvent(ev)
	}

	for _, sn := range []Snippet{
		{Name: "Failed payments today", SQL: "SELECT * FROM v_failed_payments WHERE created_at >= current_date ORDER BY created_at DESC"},
		{Name: "Payments by status", SQL: "SELECT status, count(*) AS payments, sum(amount) AS total FROM payments GROUP BY status ORDER BY 2 DESC"},
		{Name: "Refunds waiting for approval", SQL: "SELECT r.id, r.payment_id, r.amount, r.reason, r.requested_at FROM refunds r WHERE r.status = 'PENDING_APPROVAL' ORDER BY r.requested_at"},
		{Name: "Refund limits per merchant", SQL: "SELECT name, tier, daily_refund_limit FROM merchants ORDER BY tier, name"},
		{Name: "Last night's batch runs", SQL: "SELECT job, started_at, finished_at, status, rows_processed, message FROM batch_runs ORDER BY started_at DESC LIMIT 10"},
	} {
		_, _ = s.SaveSnippet(sn)
	}

	env, _ := s.SaveHTTPEnv(HTTPEnv{Name: demoAPIEnv, Vars: []KV{{K: "base_url", V: "http://127.0.0.1", On: true}, {K: "api_key", V: "demo-api-key", On: true}, {K: "jira", V: "http://127.0.0.1", On: true}}})
	_ = env
	bearer := HTTPAuth{Type: "bearer", Token: "{{api_key}}"}
	for _, r := range []HTTPReq{
		{Name: "Health", Folder: "Payments API", Method: "GET", URL: "{{base_url}}/actuator/health"},
		{Name: "Failed payments", Folder: "Payments API", Method: "GET", URL: "{{base_url}}/api/payments?status=FAILED&limit=5", Auth: bearer},
		{Name: "One payment", Folder: "Payments API", Method: "GET", URL: "{{base_url}}/api/payments/700001", Auth: bearer},
		{Name: "Refund (OK)", Folder: "Payments API", Method: "POST", URL: "{{base_url}}/api/refunds", Auth: bearer, BodyType: "json", Body: "{\n  \"payment_id\": 700001,\n  \"amount\": 12.50,\n  \"reason\": \"Customer request\"\n}"},
		{Name: "Refund over the limit", Folder: "Payments API", Method: "POST", URL: "{{base_url}}/api/refunds", Auth: bearer, BodyType: "json", Body: "{\n  \"payment_id\": 700001,\n  \"amount\": 99999,\n  \"reason\": \"Test the limit\"\n}"},
		{Name: "No sign-in (401)", Folder: "Payments API", Method: "GET", URL: "{{base_url}}/api/payments"},
		{Name: "Jira issue PAY-301", Folder: "Jira", Method: "GET", URL: "{{jira}}/rest/api/2/issue/PAY-301", Auth: HTTPAuth{Type: "bearer", Token: demoJiraToken}},
	} {
		_, _ = s.SaveHTTPReq(r)
	}

	root, _ := s.SavePropNode(PropNode{Name: "Payments", Text: "Where each setting lives, and how to change it safely."})
	uat, _ := s.SavePropNode(PropNode{ParentID: root.ID, Name: "UAT", Order: 1, Text: "application.properties is in /opt/payments/config on both app servers.\nRestart with /opt/payments/bin/restart.sh after a change."})
	_, _ = s.SavePropNode(PropNode{ParentID: uat.ID, Name: "Refund limits", Text: "refund.limit.tierA / tierB / tierC — must match merchants.daily_refund_limit in the database."})
	_, _ = s.SavePropNode(PropNode{ParentID: root.ID, Name: "PROD", Order: 2, Text: "Changes only through a CM change. Read-only login: support (SSH), pay_ro (database)."})

	s.SetJiraConfig(JiraConfig{BaseURL: "http://127.0.0.1", Mode: "server", Token: demoJiraToken, ChildPrefix: "CM-"})
	s.SetConfluenceConfig(ConfluenceConfig{Mode: "jira"})
	s.SetConfIndexConfig(ConfIndexConfig{On: true, Spaces: []string{"OPS", "PAY"}, Every: 60})

	s.IngestFrom("Hi, can you check pay-app-01? The refund API log shows ORA-00060 deadlocks since 10:00.\nssh deploy@127.0.0.1 -p 47201", "clipboard", "Teams", "Payments")
	s.IngestFrom("UAT DB for the refund tests: jdbc:postgresql://db-01.uat.acme.example.com:5432/payments user pay_app", "clipboard", "Outlook", "Databases")

	now := time.Now()
	for i, ev := range []ProdEvent{
		{Kind: "terminal", What: "opened a terminal"},
		{Kind: "typed", What: "systemctl status pay-api"},
		{Kind: "typed", What: "tail -n 100 /opt/payments/logs/application.log"},
		{Kind: "sql", What: "SELECT count(*) FROM payments WHERE status = 'FAILED'", Server: "Payments DB PROD (read-only)", Host: "127.0.0.1", User: "pay_ro"},
	} {
		if ev.Server == "" {
			ev.Server, ev.Host, ev.User = "Payments app PROD", "127.0.0.1", "support"
		}
		ev.At = now.Add(-time.Duration(30-i*5) * time.Hour)
		s.addProdEvent(ev)
	}

	st := s.Settings()
	if st.Workspace == "" { // the name you gave the workspace stays
		st.Workspace = "Demo — Acme Bank"
	}
	st.NoBrowserSync = true // a demo shows no real bookmarks from this PC
	st.Demo = &DemoSettings{Roles: roles}
	st.Groups = []Group{
		{Name: "Payments", Patterns: []string{"Payments app 1", "Payments app 2", "Payments DB"}, Color: "#4caf50"},
		{Name: "Batch", Patterns: []string{"Batch"}, Color: "#ff9800"},
		{Name: "Partners", Patterns: []string{"Partner", "Legacy reports"}, Color: "#2196f3"},
	}
	st.Saved = []SavedQuery{{Name: "PROD", Query: "env:prod"}, {Name: "Databases", Query: "postgres"}}
	st.NameRules = []NameRule{{Match: "partner", Label: "Partners"}}
	st.Monitor = MonitorSettings{On: true, Interval: 60} // the checks are added when the pretend servers start
	st.Mail = MailSettings{Enabled: true, Minutes: 1, Lookback: 2, KeepAll: true,
		Rules: []MailRule{{Match: "*@partner.example.com", Project: "Partners"}, {Match: "*@acme.example.com", Project: ""}, {Match: "support@tailspin.example.com", Project: "Vendors"}}}
	if repo := seedDemoRepo(filepath.Join(filepath.Dir(s.path), "demolab", "repos", "pay-api")); repo != "" {
		st.Repos = append(st.Repos, repo)
	}
	s.SetSettings(st)
	fmt.Println("sample data added")
}

// seedDemoRepo makes a small Git repository with a few commits for the Git page.
func seedDemoRepo(dir string) string {
	if fileExists(filepath.Join(dir, ".git")) {
		return dir
	}
	r, err := git.PlainInit(dir, false)
	if err != nil {
		return ""
	}
	wt, err := r.Worktree()
	if err != nil {
		return ""
	}
	commits := []struct {
		days  int
		msg   string
		files map[string]string
	}{
		{-20, "Initial import of pay-api", map[string]string{"README.md": "# pay-api\n\nPayments REST API (demo repository, made-up code).\n", "src/RefundService.java": "class RefundService {\n  void refund(long paymentId, double amount) { }\n}\n"}},
		{-9, "PAY-101 refund report CSV export", map[string]string{"src/RefundReport.java": "class RefundReport {\n  String csv() { return \"id,amount\"; }\n}\n"}},
		{-3, "PAY-301 refund limits per merchant tier", map[string]string{"src/RefundService.java": "class RefundService {\n  static final double TIER_A = 5000, TIER_B = 2500, TIER_C = 1000;\n  void refund(long paymentId, double amount) {\n    if (amount > limitFor(paymentId)) throw new IllegalStateException(\"REFUND_LIMIT_EXCEEDED\");\n  }\n  double limitFor(long paymentId) { return TIER_B; }\n}\n"}},
		{-1, "PAY-301 tests for the limits", map[string]string{"test/RefundServiceTest.java": "class RefundServiceTest {\n  void overTheLimitIsRefused() { }\n}\n"}},
	}
	for _, c := range commits {
		for name, body := range c.files {
			p := filepath.Join(dir, filepath.FromSlash(name))
			_ = os.MkdirAll(filepath.Dir(p), 0o755)
			_ = os.WriteFile(p, []byte(body), 0o644)
			_, _ = wt.Add(name)
		}
		when := time.Now().AddDate(0, 0, c.days)
		if _, err := wt.Commit(c.msg, &git.CommitOptions{Author: &object.Signature{Name: "Demo User", Email: "demo.user@acme.example.com", When: when}}); err != nil {
			return ""
		}
	}
	// a change not committed yet, so the Git page shows one
	_ = os.WriteFile(filepath.Join(dir, "README.md"), []byte("# pay-api\n\nPayments REST API (demo repository, made-up code).\n\nRefund limits: see PAY-301.\n"), 0o644)
	return dir
}
