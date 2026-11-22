package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestIsNewer(t *testing.T) {
	pub := time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC)
	for _, c := range []struct {
		tag, cur string
		want     bool
	}{
		{"v1.7", "v1.6-2026-11-20-0900", true},
		{"v1.7", "v1.7-2026-11-25-1000", false},
		{"v1.10", "v1.9", true},
		{"v1.6", "v1.7", false},
		{"v1.7", "dev", false},
		{"v1.7", "2026-11-22-1503", true},  // dated local build, older than the release
		{"v1.7", "2026-11-26-0900", false}, // built after the release
	} {
		if got := isNewer(c.tag, pub, c.cur); got != c.want {
			t.Errorf("isNewer(%s, %s) = %v", c.tag, c.cur, got)
		}
	}
}

func TestUpdateCheck(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"tag_name": "v9.0", "name": "v9.0", "body": "notes", "published_at": time.Now(),
			"assets": []any{map[string]any{"name": "WorkHub-web.exe", "browser_download_url": "x", "size": 9000000}}})
	}))
	defer srv.Close()
	old, oldV := updateURL, version
	updateURL, version = srv.URL, "v1.7-2026-11-22-1500"
	defer func() { updateURL, version = old, oldV }()
	w := httptest.NewRecorder()
	(&App{}).handleUpdateCheck(w, httptest.NewRequest("GET", "/api/update?force=1", nil))
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	if out["newer"] != true || out["latest"] != "v9.0" || out["size"] == nil {
		t.Fatalf("check: %v", out)
	}
}
