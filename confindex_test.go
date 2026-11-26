package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
)

func TestConfluenceLocalIndex(t *testing.T) {
	type page struct {
		id, title, body string
		ver             int
	}
	var mu sync.Mutex
	pages := []page{
		{"1", "Batch restart runbook", "<p>Stop the batch first, then restart the app servers.</p>", 1},
		{"2", "Refund limits", "<p>Tier A may refund 5000 EUR per day.</p>", 1},
		{"3", "Team lunch", "<p>Pizza on Fridays.</p>", 1},
	}
	var lastCQL []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			w.WriteHeader(401)
			return
		}
		if r.URL.Path != "/wiki/rest/api/content/search" {
			w.WriteHeader(404)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		cql := r.URL.Query().Get("cql")
		lastCQL = append(lastCQL, cql)
		if !strings.Contains(cql, `space = "OPS"`) || r.URL.Query().Get("expand") != "body.storage,version,space" {
			t.Errorf("query: %s", r.URL.RawQuery)
		}
		list := pages
		if strings.Contains(cql, "lastmodified") { // changed since: only page 1 changes in this test
			list = nil
			for _, p := range pages {
				if p.ver > 1 {
					list = append(list, p)
				}
			}
		}
		start := 0
		if r.URL.Query().Get("cursor") == "2" {
			start = 2
		}
		end := min(start+2, len(list)) // two per answer: the next link must be followed
		var res []any
		for _, p := range list[start:end] {
			res = append(res, map[string]any{"id": p.id, "type": "page", "title": p.title, "version": map[string]any{"number": p.ver, "when": "2026-11-20T10:00:00.000Z"},
				"space": map[string]any{"key": "OPS", "name": "Operations"}, "body": map[string]any{"storage": map[string]any{"value": p.body}},
				"_links": map[string]any{"webui": "/spaces/OPS/pages/" + p.id}})
		}
		links := map[string]any{"base": "https://acme.example.com/wiki"}
		if end < len(list) {
			links["next"] = "/rest/api/content/search?cql=" + url.QueryEscape(cql) + "&expand=body.storage,version,space&limit=50&cursor=2"
		}
		json.NewEncoder(w).Encode(map[string]any{"results": res, "_links": links})
	}))
	defer srv.Close()

	dir := t.TempDir()
	s, _ := OpenStore(dir)
	cidx = &confIndex{}
	s.SetJiraConfig(JiraConfig{BaseURL: srv.URL, Mode: "server", Token: "tok"})
	s.SetConfluenceConfig(ConfluenceConfig{Mode: "jira"})
	s.SetConfIndexConfig(ConfIndexConfig{On: true, Spaces: []string{"OPS"}})
	a := &App{store: s}

	if err := a.ciSync(false); err != nil {
		t.Fatal(err)
	}
	if a.ciPages() != 3 {
		t.Fatalf("pages after the first sync (two answers): %d", a.ciPages())
	}
	// word endings: "restarting" finds "restart"; the runbook first
	hits := a.ciSearch("restarting the batch", 5)
	if len(hits) == 0 || hits[0].ID != "1" || hits[0].URL != "https://acme.example.com/wiki/spaces/OPS/pages/1" || hits[0].Where != "Operations" {
		t.Fatalf("search: %+v", hits)
	}
	if len(a.ciSearch("pizza", 5)) != 1 || len(a.ciSearch("kubernetes", 5)) != 0 {
		t.Fatal("search precision")
	}
	// saved encrypted: no page text in the file
	blob, err := os.ReadFile(s.confIndexPath())
	if err != nil || strings.Contains(string(blob), "Pizza") || !strings.HasPrefix(string(blob), fileMagic) {
		t.Fatalf("index file not encrypted (%v)", err)
	}

	// a page changes: the next sync asks only for changed pages and replaces it
	mu.Lock()
	pages[0] = page{"1", "Batch restart runbook", "<p>Use the new restart script restart-all.sh.</p>", 2}
	mu.Unlock()
	if err := a.ciSync(false); err != nil {
		t.Fatal(err)
	}
	if c := lastCQL[len(lastCQL)-1]; !strings.Contains(c, "lastmodified >=") {
		t.Fatalf("incremental sync should ask for changed pages: %s", c)
	}
	if h := a.ciSearch("restart script", 5); len(h) == 0 || !strings.Contains(h[0].Snip, "restart-all.sh") {
		t.Fatalf("changed page not updated: %+v", h)
	}

	// a page is deleted: the full check drops it
	mu.Lock()
	pages = pages[:2]
	mu.Unlock()
	if err := a.ciSync(true); err != nil {
		t.Fatal(err)
	}
	if a.ciPages() != 2 || len(a.ciSearch("pizza", 5)) != 0 {
		t.Fatalf("deleted page still there: %d", a.ciPages())
	}

	// loads again from the file (a restart)
	cidx = &confIndex{}
	if a.ciPages() != 2 {
		t.Fatalf("after reload: %d", a.ciPages())
	}
	// delete the copy
	w := httptest.NewRecorder()
	a.handleConfIndexDelete(w, httptest.NewRequest("DELETE", "/api/confindex", nil))
	if _, err := os.Stat(s.confIndexPath()); !os.IsNotExist(err) || a.ciPages() != 0 || s.ConfIndexConfig().On {
		t.Fatal("delete left the copy")
	}
	cidx = &confIndex{}
}

func TestCiStem(t *testing.T) {
	for in, want := range map[string]string{"restarting": "restart", "restarted": "restart", "restarts": "restart", "stopped": "stop", "policies": "policy", "class": "class", "restore": "restor"} {
		if got := ciStem(in); got != want {
			t.Errorf("%s → %s, want %s", in, got, want)
		}
	}
}
