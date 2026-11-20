package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A pretend Jira answering like the real REST API.
func fakeJira(t *testing.T) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			w.WriteHeader(401)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/rest/api/2/issue/PAY-123":
			json.NewEncoder(w).Encode(map[string]any{"id": "10001", "key": "PAY-123", "fields": map[string]any{
				"summary": "Refund limits", "status": map[string]any{"name": "In Progress"}, "issuetype": map[string]any{"name": "Story"},
				"assignee": map[string]any{"displayName": "Ann Dev"},
				"subtasks": []any{
					map[string]any{"key": "PAY-124", "fields": map[string]any{"summary": "CM- deploy to UAT", "status": map[string]any{"name": "Done"}, "issuetype": map[string]any{"name": "Sub-task"}}},
					map[string]any{"key": "PAY-125", "fields": map[string]any{"summary": "Write tests", "status": map[string]any{"name": "To Do"}, "issuetype": map[string]any{"name": "Sub-task"}}},
				},
				"issuelinks": []any{
					map[string]any{"type": map[string]any{"inward": "is implemented by", "outward": "implements"}, "outwardIssue": map[string]any{"key": "CM-4411", "fields": map[string]any{"summary": "Prod release", "status": map[string]any{"name": "Scheduled"}, "issuetype": map[string]any{"name": "Change"}}}},
					map[string]any{"type": map[string]any{"inward": "relates", "outward": "relates"}, "inwardIssue": map[string]any{"key": "OPS-9", "fields": map[string]any{"summary": "Unrelated", "status": map[string]any{"name": "Open"}, "issuetype": map[string]any{"name": "Task"}}}},
				}}})
		case r.URL.Path == "/rest/dev-status/latest/issue/summary":
			json.NewEncoder(w).Encode(map[string]any{"summary": map[string]any{"pullrequest": map[string]any{"byInstanceType": map[string]any{"GitHub": map[string]any{"count": 1}}}}})
		case r.URL.Path == "/rest/dev-status/latest/issue/detail" && r.URL.Query().Get("applicationType") == "GitHub":
			json.NewEncoder(w).Encode(map[string]any{"detail": []any{map[string]any{"pullRequests": []any{
				map[string]any{"name": "PAY-123 refund limits", "url": "https://github.com/acme/pay/pull/42", "status": "OPEN", "repositoryName": "acme/pay", "author": map[string]any{"name": "ann"}},
			}}}})
		case r.URL.Path == "/rest/api/2/issue/PAY-123/remotelink":
			json.NewEncoder(w).Encode([]any{
				map[string]any{"object": map[string]any{"url": "https://bitbucket.corp/projects/P/repos/r/pull-requests/7", "title": "Hotfix PR"}},
				map[string]any{"object": map[string]any{"url": "https://wiki.corp/page", "title": "Design"}},
			})
		default:
			w.WriteHeader(404)
		}
	}))
}

func TestJira(t *testing.T) {
	srv := fakeJira(t)
	defer srv.Close()
	if k, b := parseJiraRef(srv.URL + "/browse/PAY-123?focusedCommentId=1"); k != "PAY-123" || b != srv.URL {
		t.Fatalf("parseJiraRef: %q %q", k, b)
	}
	j := fetchJira(JiraConfig{BaseURL: srv.URL, Mode: "server", Token: "tok", ChildPrefix: "CM-"}, "PAY-123")
	if j.Error != "" || j.Summary != "Refund limits" || j.Assignee != "Ann Dev" {
		t.Fatalf("issue: %+v", j)
	}
	if len(j.PRs) != 2 || j.PRs[0].Status != "OPEN" || !strings.Contains(j.PRs[1].URL, "pull-requests/7") {
		t.Fatalf("PRs: %+v", j.PRs)
	}
	var keys []string
	for _, c := range j.Children {
		keys = append(keys, c.Key+"("+c.Relation+")")
	}
	if strings.Join(keys, ",") != "PAY-124(sub-task),CM-4411(implements)" {
		t.Fatalf("CM- children: %v", keys)
	}
	if bad := fetchJira(JiraConfig{BaseURL: srv.URL, Mode: "server", Token: "wrong"}, "PAY-123"); !strings.Contains(bad.Error, "401") {
		t.Fatalf("bad token error: %q", bad.Error)
	}
	// Token is kept server-side and blank on save keeps it.
	s, _ := OpenStore(t.TempDir())
	s.SetJiraConfig(JiraConfig{BaseURL: srv.URL + "/", Mode: "server", Token: "tok"})
	s.SetJiraConfig(JiraConfig{BaseURL: srv.URL, Mode: "server"})
	if c := s.JiraConfig(); c.Token != "tok" || c.ChildPrefix != "CM-" {
		t.Fatalf("config: %+v", c)
	}
}
