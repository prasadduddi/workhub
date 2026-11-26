package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAskWords(t *testing.T) {
	got := strings.Join(askWords("How do we restart the batch server?"), " ")
	if got != "restart batch server" {
		t.Fatalf("words: %q", got)
	}
	if strings.Join(askWords("PAY-201 approver"), " ") != "pay-201 approver" {
		t.Fatal("issue keys must stay whole")
	}
}

func TestAskConfluenceAndJira(t *testing.T) {
	var aiReq map[string]any
	var aiHeaders http.Header
	atl := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			w.WriteHeader(401)
			return
		}
		js := func(v any) { json.NewEncoder(w).Encode(v) }
		switch {
		case r.URL.Path == "/wiki/rest/api/search":
			if !strings.Contains(r.URL.Query().Get("cql"), `text ~ "restart batch"`) {
				t.Errorf("cql: %s", r.URL.Query().Get("cql"))
			}
			js(map[string]any{"results": []any{map[string]any{"content": map[string]any{"id": "77", "type": "page", "title": "Batch restart runbook"},
				"excerpt": "Stop the @@@hl@@@batch@@@endhl@@@ first", "url": "/spaces/OPS/pages/77", "lastModified": "2026-11-01T09:00:00.000Z",
				"resultGlobalContainer": map[string]any{"title": "OPS"}}}, "_links": map[string]any{"base": "https://acme.example.com/wiki"}})
		case r.URL.Path == "/wiki/rest/api/content/77":
			js(map[string]any{"body": map[string]any{"storage": map[string]any{"value": "<p>Stop the batch first.</p><p>Then restart.</p>"}}})
		case r.URL.Path == "/rest/api/3/search/jql":
			// Cloud: the description in Atlassian Document Format
			js(map[string]any{"issues": []any{map[string]any{"key": "OPS-77", "fields": map[string]any{"summary": "Restart batch after cert renewal",
				"description": map[string]any{"type": "doc", "content": []any{map[string]any{"type": "paragraph", "content": []any{map[string]any{"type": "text", "text": "Restart the batch servers on Sunday"}}}}},
				"status":      map[string]any{"name": "To Do"}, "issuetype": map[string]any{"name": "Task"}, "project": map[string]any{"name": "Ops"},
				"updated": "2026-11-20T10:00:00.000+0000", "comment": map[string]any{"comments": []any{}}}}}})
		default:
			w.WriteHeader(404)
		}
	}))
	defer atl.Close()
	ai := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		aiHeaders = r.Header.Clone()
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &aiReq)
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-5-5","stop_reason":"end_turn","usage":{"input_tokens":10,"output_tokens":5},
			"content":[{"type":"text","text":"Stop the batch first, then restart.","citations":[{"type":"search_result_location","search_result_index":1,"source":"x","title":"t","cited_text":"Stop the batch first.","start_block_index":0,"end_block_index":0}]}]}`)
	}))
	defer ai.Close()
	old := askAPIBase
	askAPIBase = ai.URL
	defer func() { askAPIBase = old }()

	s, _ := OpenStore(t.TempDir())
	s.SetJiraConfig(JiraConfig{BaseURL: atl.URL, Mode: "server", Token: "tok"})
	// Confluence never set up: Jira's login is used (the site + /wiki)
	a := &App{store: s}
	call := func(body any) askReply {
		b, _ := json.Marshal(body)
		w := httptest.NewRecorder()
		a.handleAsk(w, httptest.NewRequest("POST", "/api/ask", bytes.NewReader(b)))
		var rep askReply
		_ = json.Unmarshal(w.Body.Bytes(), &rep)
		return rep
	}

	// the default: Confluence only
	if only := call(map[string]any{"q": "how do I restart the batch?"}); len(only.Sources) != 1 || len(only.Results) != 1 || only.Results[0].Source != "confluence" {
		t.Fatalf("default should search Confluence only: %v %+v", only.Sources, only.Results)
	}
	if only := call(map[string]any{"q": "how do I restart the batch?", "sources": []string{"jira"}}); len(only.Results) != 1 || only.Results[0].Source != "jira" {
		t.Fatalf("Jira only: %+v", only.Results)
	}
	rep := call(map[string]any{"q": "how do I restart the batch?", "ai": true, "sources": []string{"confluence", "jira"}})
	if len(rep.Sources) != 2 || !strings.HasPrefix(rep.Sources[0], "Confluence") {
		t.Fatalf("should search Confluence and Jira: %v", rep.Sources)
	}
	if len(rep.Errors) > 0 || len(rep.Results) != 2 {
		t.Fatalf("results: %+v", rep)
	}
	var conf, jira *askResult
	for i := range rep.Results {
		if rep.Results[i].Source == "confluence" {
			conf = &rep.Results[i]
		} else {
			jira = &rep.Results[i]
		}
	}
	if conf == nil || conf.URL != "https://acme.example.com/wiki/spaces/OPS/pages/77" || strings.Contains(conf.Snip, "@@@") || conf.Where != "OPS" {
		t.Fatalf("confluence result: %+v", conf)
	}
	if jira == nil || jira.URL != atl.URL+"/browse/OPS-77" || !strings.Contains(jira.Snip, "Sunday") {
		t.Fatalf("jira result (ADF text): %+v", jira)
	}
	if aiReq != nil || rep.Answer != nil {
		t.Fatal("AI used while switched off")
	}

	// AI on: the matches go as search results with citations; the answer cites them
	s.SetAskConfig(AskConfig{AI: true, Key: "sk-test"})
	rep = call(map[string]any{"q": "how do I restart the batch?", "ai": true, "sources": []string{"confluence", "jira"}})
	if aiReq == nil || (aiHeaders.Get("X-Api-Key") != "sk-test" && aiHeaders.Get("Authorization") != "Bearer sk-test") || !strings.Contains(aiHeaders.Get("Anthropic-Beta"), "server-side-fallback-2026-07-01") {
		t.Fatalf("AI request headers: %v", aiHeaders)
	}
	if aiReq["model"] != "claude-opus-5-5" || aiReq["fallbacks"] != "default" {
		t.Fatalf("model / fallbacks: %v %v", aiReq["model"], aiReq["fallbacks"])
	}
	raw, _ := json.Marshal(aiReq["messages"])
	if !strings.Contains(string(raw), `"type":"search_result"`) || !strings.Contains(string(raw), "Then restart.") || !strings.Contains(string(raw), `"citations":{"enabled":true}`) {
		t.Fatalf("messages: %s", raw)
	}
	if len(rep.Answer) != 1 || rep.Answer[0].Text != "Stop the batch first, then restart." || len(rep.Answer[0].Cites) != 1 || rep.Answer[0].Cites[0] != 1 {
		t.Fatalf("answer: %+v (err %q)", rep.Answer, rep.AIError)
	}
	// the key never goes back to the page
	w := httptest.NewRecorder()
	a.handleAskConfigGet(w, httptest.NewRequest("GET", "/api/ask/config", nil))
	if strings.Contains(w.Body.String(), "sk-test") || !strings.Contains(w.Body.String(), `"has_key":true`) {
		t.Fatalf("config: %s", w.Body.String())
	}
}
