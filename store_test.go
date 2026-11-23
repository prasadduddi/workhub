package main

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"
)

// A brand-new workspace must send empty lists, not null, to the browser.
func TestEmptyListsAreNotNull(t *testing.T) {
	s, _ := OpenStore(t.TempDir())
	for name, v := range map[string]any{"entries": s.Entries(), "clips": s.Clips(10), "notes": s.Notes(), "recent": s.Recent()} {
		if b, _ := json.Marshal(v); string(b) != "[]" {
			t.Errorf("%s = %s, want []", name, b)
		}
	}
}

func TestBulk(t *testing.T) {
	s, _ := OpenStore(t.TempDir())
	s.Ingest("https://www.youtube.com/watch?v=1 https://youtube.com/c/x https://jenkins.corp.local/", "paste", "Links")
	var ids []string
	for _, e := range s.st.Entries {
		if strings.Contains(e.URL, "youtube") {
			ids = append(ids, e.ID)
		}
	}
	if n, err := s.Bulk(ids, "hide", ""); err != nil || n != 2 {
		t.Fatalf("hid %d (%v)", n, err)
	}
	visible := 0
	for _, e := range s.st.Entries {
		if !e.Hidden {
			visible++
		}
	}
	if visible != 1 {
		t.Fatalf("%d visible, want 1", visible)
	}
	if n, _ := s.Bulk(ids, "project", "Music"); n != 2 || s.st.Entries[0].Project != "Music" {
		t.Fatal("move to project failed")
	}
	if _, err := s.Bulk(ids, "explode", ""); err == nil {
		t.Fatal("unknown action should fail")
	}
}

func TestNameRules(t *testing.T) {
	st, _ := OpenStore(t.TempDir())
	_, got := st.Ingest("ssh ops@pay-bat-01.corp.local\nhttps://pay-tpp-02.corp.local/console\nhttps://other.corp.local/x", "paste", "General")
	if len(got) != 3 {
		t.Fatalf("%+v", got)
	}
	set := st.Settings()
	set.NameRules = []NameRule{{"-BAT-", "Batch"}, {"-TPP-", "Touchpoint"}, {"-APP-", "App/Picasso"}}
	st.SetSettings(set)
	names := map[string]string{}
	for _, e := range st.Entries() {
		names[e.Host] = e.Name
	}
	if names["pay-bat-01.corp.local"] != "Batch – pay-bat-01.corp.local-ops" || names["pay-tpp-02.corp.local"] != "Touchpoint – pay-tpp-02.corp.local" || names["other.corp.local"] != "other.corp.local" {
		t.Fatalf("%v", names)
	}
	// A name the user typed is kept; new captures are named straight away.
	var bat EntryView
	for _, e := range st.Entries() {
		if e.Host == "pay-bat-01.corp.local" {
			bat = e
		}
	}
	in := EntryInput{ID: bat.ID, Name: "My batch box", Host: bat.Host, Port: bat.Port, Protocol: bat.Protocol, Username: bat.Username, Project: bat.Project}
	st.SaveEntry(in)
	_, got = st.Ingest("sftp://x@crm-app-01.corp.local", "paste", "General")
	set.NameRules = append(set.NameRules, NameRule{"-BAR-", "Barn"})
	st.SetSettings(set)
	for _, e := range st.Entries() {
		if e.Host == "pay-bat-01.corp.local" && e.Name != "My batch box" {
			t.Fatalf("user's name changed: %q", e.Name)
		}
		if e.Host == "crm-app-01.corp.local" && e.Name != "App/Picasso – crm-app-01.corp.local-x" {
			t.Fatalf("new capture: %q", e.Name)
		}
	}
	// Removing the rules restores plain names.
	set.NameRules = nil
	st.SetSettings(set)
	for _, e := range st.Entries() {
		if e.Host == "pay-tpp-02.corp.local" && e.Name != "pay-tpp-02.corp.local" {
			t.Fatalf("not restored: %q", e.Name)
		}
	}
}

func TestJenkinsJobNames(t *testing.T) {
	for in, want := range map[string]string{
		"https://ci.corp.local/job/Payments/job/pay-api-deploy/123/console":                              "Payments › pay-api-deploy #123",
		"https://jenkins.corp.local/view/UAT/job/nightly%20batch/":                                       "nightly batch",
		"https://ci.corp.local/blue/organizations/jenkins/Payments%2Fpay-api/detail/pay-api/45/pipeline": "Payments › pay-api #45",
		"https://jenkins.corp.local/":                                                                    "",
	} {
		if got := jenkinsJob(in); got != want {
			t.Errorf("%s → %q, want %q", in, got, want)
		}
	}
	st, _ := OpenStore(t.TempDir())
	_, got := st.Ingest("https://ci.corp.local/job/Payments/job/pay-api-deploy/\nhttps://ci.corp.local/job/Payments/job/pay-batch/", "paste", "General")
	if len(got) != 2 || got[0].Name != "Jenkins – Payments › pay-api-deploy" || got[1].Name != "Jenkins – Payments › pay-batch" {
		t.Fatalf("%q %q", got[0].Name, got[1].Name)
	}
}

func TestBulkPassword(t *testing.T) {
	s, _ := OpenStore(t.TempDir())
	s.Ingest("ssh deploy@srv-01.example.com pass Old#1\n\nssh deploy@srv-02.example.com pass Old#1", "paste", "")
	var ids []string
	for _, e := range s.st.Entries {
		ids, e.Password, e.Status = append(ids, e.ID), "Old#1", "fail"
	}
	if n, err := s.Bulk(ids, "password", "New#2"); err != nil || n != 2 {
		t.Fatalf("changed %d, %v", n, err)
	}
	for _, e := range s.st.Entries {
		if e.Password != "New#2" || !slices.Contains(e.PrevPasswords, "Old#1") || e.Status != "" {
			t.Fatalf("%s: pw %q prev %v status %q", e.Name, e.Password, e.PrevPasswords, e.Status)
		}
	}
	if n, _ := s.Bulk(ids, "password", "New#2"); n != 0 {
		t.Fatalf("same password counted as a change: %d", n)
	}
}
