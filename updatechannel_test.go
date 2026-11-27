package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestBetaVersions(t *testing.T) {
	cur := "v1.17.0-2026-11-27-0912"
	cases := []struct {
		tag  string
		want bool
	}{
		{"v1.17.0", false}, {"v1.18.0-beta.1", true}, {"v1.17.0-beta.3", false}, {"v1.17.1", true}, {"v1.16.9", false},
	}
	for _, c := range cases {
		if got := isNewer(c.tag, time.Now(), cur); got != c.want {
			t.Errorf("isNewer(%s, %s) = %v", c.tag, cur, got)
		}
	}
	if !verLess("v1.18.0-beta.1", "v1.18.0-beta.2") || !verLess("v1.18.0-beta.2", "v1.18.0") || verLess("v1.18.0", "v1.18.0-beta.9") {
		t.Fatal("beta order")
	}
	if !isNewer("v1.18.0", time.Now(), "v1.18.0-beta.2-2026-12-01-1000") {
		t.Fatal("the final version is newer than its beta")
	}
}

func TestUpdateChannels(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/latest" {
			w.Write([]byte(`{"tag_name":"v1.17.0","prerelease":false}`))
			return
		}
		w.Write([]byte(`[{"tag_name":"v1.18.0-beta.2","prerelease":true},{"tag_name":"v1.18.0-beta.1","prerelease":true},{"tag_name":"v1.19.0-beta.1","draft":true},{"tag_name":"v1.17.0"}]`))
	}))
	defer srv.Close()
	oldU, oldL := updateURL, updateListURL
	updateURL, updateListURL = srv.URL+"/latest", srv.URL+"/list"
	defer func() { updateURL, updateListURL = oldU, oldL; setUpdChannel("") }()

	setUpdChannel("")
	if r, err := latestRelease(true); err != nil || r.Tag != "v1.17.0" {
		t.Fatalf("stable: %v %v", r, err)
	}
	setUpdChannel("beta")
	if r, err := latestRelease(true); err != nil || r.Tag != "v1.18.0-beta.2" {
		t.Fatalf("beta (drafts left out): %v %v", r, err)
	}
}
