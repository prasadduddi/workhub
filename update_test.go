package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
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

// A newer release is downloaded next to the exe and reported as downloaded,
// without replacing the running exe; switched off in Settings it isn't.
func TestBackgroundDownload(t *testing.T) {
	exeBytes := append([]byte("MZ"), make([]byte, 2<<20)...)
	var srvURL string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/exe" {
			w.Write(exeBytes)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"tag_name": "v9.1", "published_at": time.Now(),
			"assets": []any{map[string]any{"name": exeName(), "browser_download_url": srvURL + "/exe", "size": len(exeBytes)}}})
	}))
	defer srv.Close()
	srvURL = srv.URL
	old, oldV, oldC := updateURL, version, canSelfUpdate
	updateURL, version, canSelfUpdate = srv.URL, "v1.10.2", true
	updMu.Lock()
	updCache = nil
	updMu.Unlock()
	defer func() { updateURL, version, canSelfUpdate = old, oldV, oldC }()
	bin, ver := stagedPaths()
	defer os.Remove(bin)
	defer os.Remove(ver)

	st, _ := OpenStore(t.TempDir())
	a := &App{store: st}
	set := st.Settings()
	set.NoUpdateFetch = true
	st.SetSettings(set)
	a.fetchUpdate()
	if stagedTag("v9.1") != "" {
		t.Fatal("downloaded although switched off")
	}
	set.NoUpdateFetch = false
	st.SetSettings(set)
	a.fetchUpdate()
	if stagedTag("v9.1") != "v9.1" {
		t.Fatal("not downloaded in the background")
	}
	w := httptest.NewRecorder()
	a.handleUpdateCheck(w, httptest.NewRequest("GET", "/api/update", nil))
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	if out["downloaded"] != "v9.1" || out["newer"] != true {
		t.Fatalf("check: %v", out)
	}
	if exe, _ := os.Executable(); fileExists(exe+".old") || !fileExists(exe) {
		t.Fatal("the running exe must not be touched")
	}
}
