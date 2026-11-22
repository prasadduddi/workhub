package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A pretend sign-in window: requests carry its "session" until it ends.
func TestJiraBrowserMode(t *testing.T) {
	signedIn, reloads := true, 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !signedIn {
			w.WriteHeader(401)
			return
		}
		switch r.URL.Path {
		case "/rest/api/2/myself":
			w.Write([]byte(`{"displayName":"Alex Example"}`))
		case "/rest/api/2/issue/PAY-1":
			w.Write([]byte(`{"id":"1","key":"PAY-1","fields":{"summary":"Test issue","status":{"name":"Open"}}}`))
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()
	shown := false
	jiraWinOpen = func(u string, show, reload bool) error {
		if reload {
			reloads++
			signedIn = true // SSO signed in again by itself
		}
		return nil
	}
	jiraWinHide = func() {}
	jiraWinShown = func() bool { return shown }
	jiraWinFetch = func(u string) (int, string, error) {
		resp, err := http.Get(u)
		if err != nil {
			return 0, "", err
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(b), nil
	}
	defer func() { jiraWinOpen, jiraWinHide, jiraWinShown, jiraWinFetch = nil, nil, nil, nil }()

	cfg := JiraConfig{BaseURL: srv.URL, Mode: "browser"}
	if name, err := checkJiraSession(cfg); err != nil || name != "Alex Example" {
		t.Fatalf("session: %q %v", name, err)
	}
	if j := fetchJira(cfg, "PAY-1"); j.Error != "" || j.Summary != "Test issue" {
		t.Fatalf("issue: %+v", j)
	}
	// Session ended: reloaded quietly once, then works.
	signedIn = false
	if _, err := checkJiraSession(cfg); err != nil || reloads != 1 {
		t.Fatalf("silent re-login: %v reloads=%d", err, reloads)
	}
	// Ended while the window is on screen: no reload, clear error.
	signedIn, shown = false, true
	if _, err := checkJiraSession(cfg); err == nil || !strings.Contains(err.Error(), "Sign in with browser") || reloads != 1 {
		t.Fatalf("visible window was reloaded or no error: %v reloads=%d", err, reloads)
	}
	if !jiraReady(cfg) || jiraReady(JiraConfig{BaseURL: srv.URL}) {
		t.Fatal("jiraReady")
	}
}

func TestJiraBrowserWebVersion(t *testing.T) {
	c := &jiraClient{cfg: JiraConfig{BaseURL: "https://jira.example.com", Mode: "browser"}}
	var out any
	if err := c.get("/rest/api/2/myself", &out); err != errNoJiraWin {
		t.Fatalf("got %v", err)
	}
}

// Jira Cloud with browser sign-in: the old search is gone (410), the new one works.
func TestJiraBrowserCloudSearch(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/rest/api/3/search/jql" && strings.Contains(r.URL.Query().Get("jql"), "!= Done"):
			w.Write([]byte(`{"issues":[{"key":"PAY-7"}]}`))
		case r.URL.Path == "/rest/api/3/search/jql":
			w.Write([]byte(`{"issues":[]}`))
		case r.URL.Path == "/rest/api/2/search":
			w.WriteHeader(410)
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()
	jiraWinOpen = func(string, bool, bool) error { return nil }
	jiraWinShown = func() bool { return false }
	jiraWinFetch = func(u string) (int, string, error) {
		resp, err := http.Get(u)
		if err != nil {
			return 0, "", err
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(b), nil
	}
	defer func() { jiraWinOpen, jiraWinShown, jiraWinFetch = nil, nil, nil }()
	keys, err := searchMine(JiraConfig{BaseURL: srv.URL, Mode: "browser"})
	if err != nil || len(keys) != 1 || keys[0] != "PAY-7" {
		t.Fatalf("keys %v, %v", keys, err)
	}
}
