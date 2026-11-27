package main

import (
	"errors"
	"strings"
	"testing"
)

func TestSupportReportHasNoSecrets(t *testing.T) {
	s, _ := OpenStore(t.TempDir())
	s.SetJiraConfig(JiraConfig{BaseURL: "https://jira.example.com", Mode: "server", Token: "SECRET-TOKEN-123"})
	a := &App{store: s}
	noteErr("Jira", errors.New(`Get "https://jira.example.com/rest/api/2/myself": dial tcp 10.0.0.31:443: connect: connection refused (token=abc123def)`))
	noteErr("Confluence", errors.New("Confluence refused bob@example.com from C:\\Users\\me\\x and /Users/me/y on wiki.example.com"))
	noteErr("Jira", errors.New("not found in Jira (404): check the key")) // not a fault: left out
	rep := a.supportReport()
	for _, bad := range []string{"SECRET-TOKEN-123", "jira.example.com", "10.0.0.31", "abc123def", "bob@example.com", `Users\me\`, "/Users/me/", "wiki.example.com", "(404)"} {
		if strings.Contains(rep, bad) {
			t.Fatalf("the report shows %q:\n%s", bad, rep)
		}
	}
	for _, want := range []string{"Jira:        set up (server)", "connection refused", "<address>", "<email>", "Confluence:"} {
		if !strings.Contains(rep, want) {
			t.Fatalf("the report misses %q:\n%s", want, rep)
		}
	}
}
