package main

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"
)

func TestCaptureWindowAsksFirst(t *testing.T) {
	dir := t.TempDir()
	s, _ := OpenStore(dir)
	a := &App{store: s, dataDir: dir}
	capWin = &captureWindow{}
	copied := "Prod app server: ssh ops@acme-app-01.prod.acme.local -p 22\njdbc:oracle:thin:@acme-ora-prd01.acme.local:1521/PAYPRD"

	// window closed: captured as before (saved, marked new)
	a.captureText("ssh deploy@other-01.acme.local", "Teams")
	if n := len(s.Entries()); n == 0 {
		t.Fatal("with the window closed, a copy should be captured as before")
	}
	before := len(s.Entries())

	// window open: offered, not saved
	rec := httptest.NewRecorder()
	a.handleCaptureProposals(rec, httptest.NewRequest("GET", "/api/capture/proposals", nil))
	if !capWin.active() {
		t.Fatal("polling should make the window active")
	}
	a.captureText(copied, "Teams")
	a.captureText(copied, "Teams") // the same copy again: one proposal
	if len(s.Entries()) != before {
		t.Fatal("a copy was saved while the capture window was open")
	}
	rec = httptest.NewRecorder()
	a.handleCaptureProposals(rec, httptest.NewRequest("GET", "/api/capture/proposals", nil))
	var got struct {
		Proposals []capProposal `json:"proposals"`
	}
	json.Unmarshal(rec.Body.Bytes(), &got)
	if len(got.Proposals) != 1 || len(got.Proposals[0].Findings) < 2 {
		t.Fatalf("want one proposal with the SSH server and the database: %s", rec.Body.String())
	}
	p := got.Proposals[0]
	var ssh, db *capFinding
	for i := range p.Findings {
		f := &p.Findings[i]
		if f.Host == "acme-app-01.prod.acme.local" {
			ssh = f
		}
		if f.Host == "acme-ora-prd01.acme.local" {
			db = f
		}
	}
	if ssh == nil || db == nil || ssh.Username != "ops" || db.Port != 1521 {
		t.Fatalf("findings: %+v", p.Findings)
	}

	// Yes: saved as a normal connection (not "new"), with the copied text kept
	accept := func(f Finding, idx int) map[string]any {
		body, _ := json.Marshal(map[string]any{"id": p.ID, "index": idx, "finding": f, "text": p.Text, "from": "Teams"})
		rec := httptest.NewRecorder()
		a.handleCaptureAccept(rec, httptest.NewRequest("POST", "/api/capture/accept", bytes.NewReader(body)))
		var r map[string]any
		json.Unmarshal(rec.Body.Bytes(), &r)
		return r
	}
	r := accept(ssh.Finding, 0)
	if r["created"] != true {
		t.Fatalf("accept: %v", r)
	}
	if len(s.Entries()) != before+1 {
		t.Fatalf("want exactly one new connection, have %d (was %d)", len(s.Entries()), before)
	}
	var saved EntryView
	for _, e := range s.Entries() {
		if e.Host == "acme-app-01.prod.acme.local" {
			saved = e
		}
	}
	if saved.Unsorted || saved.Username != "ops" || len(saved.ClipIDs) != 1 {
		t.Fatalf("saved: %+v", saved)
	}
	// the same again: not a second copy
	if r := accept(ssh.Finding, 0); r["created"] != false {
		t.Fatalf("second accept created again: %v", r)
	}
	if len(s.Entries()) != before+1 {
		t.Fatal("accepting twice made a duplicate")
	}

	// answered items are marked, not removed: the others keep their place
	capWin.mu.Lock()
	if len(capWin.list) != 1 || !capWin.list[0].Findings[0].Done || capWin.list[0].Findings[1].Done {
		capWin.mu.Unlock()
		t.Fatalf("after one Yes: %+v", capWin.list)
	}
	capWin.mu.Unlock()
	// No to everything else: the proposal goes away
	for i := 1; i < len(p.Findings); i++ {
		body, _ := json.Marshal(map[string]any{"id": p.ID, "index": i})
		a.handleCaptureDismiss(httptest.NewRecorder(), httptest.NewRequest("POST", "/api/capture/dismiss", bytes.NewReader(body)))
	}
	body, _ := json.Marshal(map[string]any{"id": p.ID, "index": -1})
	a.handleCaptureDismiss(httptest.NewRecorder(), httptest.NewRequest("POST", "/api/capture/dismiss", bytes.NewReader(body)))
	if len(capWin.list) != 0 {
		t.Fatal("dismiss left the proposal")
	}

	// the window closed a while ago: capture as before again
	capWin.seen = time.Now().Add(-time.Minute)
	if capWin.active() {
		t.Fatal("window should count as closed")
	}
}
