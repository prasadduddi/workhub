package main

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestNotifyMonitorDownAndUp(t *testing.T) {
	s, _ := OpenStore(t.TempDir())
	a := &App{store: s, mon: &monitor{status: map[string]*monStatus{}, kick: make(chan struct{}, 1)}}
	notices.Lock()
	notices.list, notices.n = nil, 0
	notices.Unlock()
	var shown []string
	old := systemNotify
	systemNotify = func(title, body string) { shown = append(shown, title) }
	defer func() { systemNotify = old }()

	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := ln.Addr().String()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()
	set := MonitorSettings{On: true, Checks: []MonitorCheck{{ID: "m1", Name: "App port", Kind: "tcp", Target: addr, Host: "127.0.0.1"}}}
	wait := func(n int) {
		for i := 0; i < 50 && func() bool { notices.Lock(); defer notices.Unlock(); return len(notices.list) < n }(); i++ {
			time.Sleep(20 * time.Millisecond)
		}
	}
	a.runChecks(set) // first check: up — nothing to tell
	ln.Close()
	a.runChecks(set) // down
	wait(1)
	a.runChecks(set) // still down: no repeat
	ln2, err := net.Listen("tcp", addr)
	if err != nil {
		t.Skip("port taken again:", err)
	}
	defer ln2.Close()
	go func() {
		for {
			c, err := ln2.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()
	a.runChecks(set) // up again
	wait(2)
	time.Sleep(100 * time.Millisecond)
	notices.Lock()
	var titles []string
	for _, n := range notices.list {
		titles = append(titles, n.Title)
	}
	notices.Unlock()
	if len(titles) != 2 || !strings.HasPrefix(titles[0], "🔴 Down — App port") || !strings.HasPrefix(titles[1], "✅ Up again — App port") {
		t.Fatalf("notices: %v", titles)
	}
	if len(shown) != 2 {
		t.Fatalf("Windows notifications: %v", shown)
	}
	// the page gets only what's new
	w := httptest.NewRecorder()
	a.handleNotifications(w, httptest.NewRequest("GET", "/api/notifications?since=1", nil))
	var out struct {
		Notices []notice `json:"notices"`
		Last    int      `json:"last"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	if len(out.Notices) != 1 || out.Last != 2 {
		t.Fatalf("since=1: %+v", out)
	}
	// switched off: nothing
	st := s.Settings()
	st.NoNotifyMonitor = true
	s.SetSettings(st)
	a.notify("monitor", "x", "", "", "")
	notices.Lock()
	n := len(notices.list)
	notices.Unlock()
	if n != 2 {
		t.Fatal("a switched-off notification was shown")
	}
}

func TestNotifyJiraStatusChange(t *testing.T) {
	srv := httptest.NewServer(httpHandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/issue/PAY-1") && !strings.Contains(r.URL.Path, "remotelink") {
			w.Write([]byte(`{"id":"1","key":"PAY-1","fields":{"summary":"Refund limits","status":{"name":"In Progress","statusCategory":{"key":"indeterminate"}},"issuetype":{"name":"Story"},"subtasks":[],"issuelinks":[]}}`))
			return
		}
		w.Write([]byte(`[]`))
	}))
	defer srv.Close()
	s, _ := OpenStore(t.TempDir())
	s.SetJiraConfig(JiraConfig{BaseURL: srv.URL, Mode: "server", Token: "t"})
	s.putJiraIssue(JiraIssue{Key: "PAY-1", Summary: "Refund limits", Status: "To Do"})
	a := &App{store: s}
	notices.Lock()
	notices.list, notices.n = nil, 0
	notices.Unlock()
	a.refreshJira("PAY-1")
	time.Sleep(100 * time.Millisecond)
	notices.Lock()
	defer notices.Unlock()
	if len(notices.list) != 1 || notices.list[0].Title != "◆ PAY-1 is now In Progress" || !strings.Contains(notices.list[0].Body, "was To Do") {
		t.Fatalf("notices: %+v", notices.list)
	}
}
