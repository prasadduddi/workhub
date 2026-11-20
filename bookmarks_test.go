package main

import (
	"os"
	"path/filepath"
	"testing"
)

const fakeBookmarks = `{"roots":{
 "bookmark_bar":{"type":"folder","name":"Favorites bar","children":[
   {"type":"folder","name":"Infra","children":[
     {"type":"url","name":"Tomcat UAT","url":"http://app-uat-01:8080/manager/html"},
     {"type":"url","name":"Grafana","url":"https://grafana.example.com/"}]},
   {"type":"url","name":"Jira","url":"https://corp.atlassian.net/jira"}]},
 "other":{"type":"folder","name":"Other favorites","children":[
   {"type":"url","name":"Old wiki","url":"https://wiki.corp.local/old"}]}}}`

func TestSyncBookmarks(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "Microsoft", "Edge", "User Data", "Default")
	os.MkdirAll(dir, 0o700)
	file := filepath.Join(dir, "Bookmarks")
	os.WriteFile(file, []byte(fakeBookmarks), 0o600)

	list, err := readBookmarkFile(file)
	if err != nil || len(list) != 4 {
		t.Fatalf("read %d bookmarks, err %v", len(list), err)
	}
	if list[0].Folder != "Edge › Favorites bar › Infra" || list[3].Folder != "Edge › Other favorites" {
		t.Fatalf("folders not preserved: %q, %q", list[0].Folder, list[3].Folder)
	}

	s, _ := OpenStore(t.TempDir())
	if a, r := s.SyncBookmarks(list); a != 4 || r != 0 {
		t.Fatalf("first sync added %d removed %d", a, r)
	}
	// User adds a login to one bookmark; then both are deleted in the browser.
	for _, e := range s.st.Entries {
		if e.Name == "Grafana" {
			e.Username = "viewer"
		}
	}
	// Browser now only has Tomcat and Grafana: Jira and Old wiki go.
	if a, r := s.SyncBookmarks(list[:2]); a != 0 || r != 2 {
		t.Fatalf("second sync added %d removed %d, want 0, 2", a, r)
	}
	names := map[string]bool{}
	for _, e := range s.st.Entries {
		names[e.Name] = true
	}
	if !names["Tomcat UAT"] || !names["Grafana"] || names["Jira"] || names["Old wiki"] {
		t.Fatalf("after browser deletions: %v", names)
	}
	// Grafana deleted in the browser but kept because it has a login now.
	if _, r := s.SyncBookmarks(list[:1]); r != 0 {
		t.Fatalf("entry with a login was removed")
	}
}
