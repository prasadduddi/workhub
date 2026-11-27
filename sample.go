package main

// Sample data for a demo workspace (File → New workspace… → with sample data):
// a fictional bank ("Acme Bank"), made-up hosts, passwords and work — enough to
// present WorkHub without showing anything real. These servers don't exist, so
// connecting to them fails; everything else (search, threads, notes, calendar,
// Dashboard) can be shown.

import (
	"fmt"
	"time"
)

func seedSample(s *Store) {
	pw := func(p string) *string { return &p }
	type ent struct {
		project, name, host string
		port                int
		proto, url, user    string
		pass                string
		env                 string
		extra               map[string]string
		fav                 bool
	}
	const U, P, D = "uat.acme.example.com", "prod.acme.example.com", "dev.acme.example.com"
	entries := []ent{
		{"Payments", "Payments app 1", "app-01." + U, 22, "ssh", "", "deploy", "Demo#2026", "UAT", nil, true},
		{"Payments", "Payments app 2", "app-02." + U, 22, "ssh", "", "deploy", "Demo#2026", "UAT", nil, false},
		{"Payments", "Payments app PROD", "app-01." + P, 22, "ssh", "", "support", "", "PROD", nil, false},
		{"Batch", "Batch server", "batch-01." + U, 22, "ssh", "", "batch", "Batch#2026", "UAT", map[string]string{"commands": "cd /opt/batch\ntail -n 50 logs/batch.log"}, false},
		{"Batch", "Batch server DEV", "batch-01." + D, 22, "ssh", "", "batch", "Batch#2026", "DEV", nil, false},
		{"Databases", "Payments DB", "ora-01." + U, 1521, "oracle", "jdbc:oracle:thin:@ora-01." + U + ":1521/PAYUAT", "pay_app", "Pay#App26", "UAT", nil, true},
		{"Databases", "Payments DB PROD", "ora-01." + P, 1521, "oracle", "jdbc:oracle:thin:@ora-01." + P + ":1521/PAYPRD", "pay_ro", "", "PROD", nil, false},
		{"Databases", "Reporting DB", "pg-01." + U, 5432, "postgres", "", "report", "Report#26", "UAT", map[string]string{"database": "reporting"}, false},
		{"Partners", "Partner file drop", "sftp.partner.example.com", 22, "sftp", "", "acme_drop", "Drop#2026", "", nil, false},
		{"Bookmarks", "Payments console", "", 0, "", "https://app-01." + U + ":8443/console", "", "", "UAT", nil, true},
		{"Bookmarks", "Payments console PROD", "", 0, "", "https://app-01." + P + ":8443/console", "", "", "PROD", nil, false},
		{"Bookmarks", "Grafana", "", 0, "", "https://grafana.acme.example.com/d/payments", "", "", "", nil, false},
		{"Bookmarks", "Jenkins — deploy payments", "", 0, "", "https://jenkins.acme.example.com/job/payments-deploy/", "", "", "", nil, false},
		{"Bookmarks", "Runbook: batch restart", "", 0, "", "https://wiki.acme.example.com/ops/batch-restart", "", "", "", nil, false},
	}
	for _, e := range entries {
		in := EntryInput{Project: e.project, Name: e.name, Host: e.host, Port: e.port, Protocol: e.proto, URL: e.url, Username: e.user, Env: e.env, Extra: e.extra, Favorite: e.fav,
			Notes: "Sample data for demos — this server doesn't exist."}
		if e.pass != "" {
			in.Password = pw(e.pass)
		}
		_, _ = s.SaveEntry(in)
	}

	day := func(d int) time.Time { return time.Now().Add(time.Duration(d) * 24 * time.Hour) }
	threads := []struct {
		title, status, jira string
		tags                []string
		posts               []string
	}{
		{"PAY-301 Refund limits per merchant", "doing", "PAY-301", []string{"UAT"}, []string{
			"<p><b>Goal</b>: merchants get a daily refund limit by tier (A 5000, B 2500, C 1000 EUR).</p>",
			"<p>Deployed build 4.3.0-rc1 to UAT app-01 and app-02. Smoke test OK.</p>",
			"<p>Waiting for the tier list from the merchant team — asked on Monday.</p>"}},
		{"INC-118 Slow refunds after release", "doing", "", []string{"Incident"}, []string{
			"<pre>2026-11-24 10:14:02 ERROR RefundService - timeout calling ledger after 30000 ms</pre>",
			"<p>Same on both app servers. Ledger DB CPU at 95% between 10:00 and 10:20.</p>",
			"<p>Index rebuild scheduled tonight 22:00 — CM-512.</p>"}},
		{"CM-512 PROD release 4.3.0", "todo", "CM-512", []string{"PROD", "Release"}, []string{
			"<p>Window: Saturday 21:00–23:30. Rollback plan: redeploy 4.2.7.</p>",
			"<ul><li>Stop batch</li><li>Deploy app-01, app-02</li><li>DB scripts</li><li>Start batch, smoke test</li></ul>"}},
		{"Onboarding notes", "done", "", nil, []string{
			"<p>Useful: the Ask page searches Confluence and Jira; Ctrl+K searches everything.</p>"}},
	}
	for _, t := range threads {
		w := s.SaveWorkItem(WorkItem{Title: t.title, Status: t.status, Jira: t.jira, Tags: t.tags})
		for i, h := range t.posts {
			_, _ = s.AddPost(w.ID, Post{Kind: "note", HTML: h, At: day(-len(t.posts) + i).Add(-2 * time.Hour)})
		}
	}

	s.SaveNote(Note{Title: "Release checklist", Body: "# Release checklist\n\n1. Freeze merges\n2. Regression pack green\n3. CM approved\n4. Announce the window\n5. Deploy, smoke test, close CM\n"})
	s.SaveNote(Note{Title: "Who to call", Body: "Database team: dba@acme.example.com\nNetwork: network@acme.example.com\nOn-call: see the rota page\n"})

	for _, ev := range []Event{
		{Title: "Daily stand-up", Date: day(0).Format("2006-01-02"), Start: "09:30", End: "09:45", Repeat: "weekdays", Remind: 5},
		{Title: "CM-512 PROD release 4.3.0", Date: day(2).Format("2006-01-02"), Start: "21:00", End: "23:30", Remind: 30},
		{Title: "Refund limits review with the merchant team", Date: day(1).Format("2006-01-02"), Start: "14:00", End: "15:00", Remind: 10},
	} {
		_, _ = s.SaveEvent(ev)
	}
	st := s.Settings()
	if st.Workspace == "" { // the name you gave the workspace stays
		st.Workspace = "Demo — Acme Bank"
	}
	st.NoBrowserSync = true // a demo shows no real bookmarks from this PC
	s.SetSettings(st)
	fmt.Println("sample data added")
}
