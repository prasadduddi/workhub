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
	// Bookmarks deleted in the browser stay in WorkHub (import only).
	if a, r := s.SyncBookmarks(list[:1]); a != 0 || r != 0 || len(s.st.Entries) != 4 {
		t.Fatalf("after browser deletions: added %d removed %d, %d entries", a, r, len(s.st.Entries))
	}
}

// Deleting a browser bookmark in WorkHub keeps it deleted across syncs.
func TestDeletedBookmarkStaysDeleted(t *testing.T) {
	s, _ := OpenStore(t.TempDir())
	list := []Bookmark{{Name: "Wiki", URL: "https://wiki.corp.local/", Folder: "Edge › Favorites bar", Source: "edge"}}
	s.SyncBookmarks(list)
	s.DeleteEntry(s.st.Entries[0].ID)
	if len(s.st.Entries) != 1 || !s.st.Entries[0].Hidden {
		t.Fatal("deleting a browser bookmark should hide it, not remove it")
	}
	if a, _ := s.SyncBookmarks(list); a != 0 || len(s.st.Entries) != 1 || !s.st.Entries[0].Hidden {
		t.Fatalf("hidden bookmark came back (added %d)", a)
	}
	s.SetHidden(s.st.Entries[0].ID, false)
	if s.st.Entries[0].Hidden {
		t.Fatal("restore failed")
	}
}

func TestBookmarkDuplicates(t *testing.T) {
	same := []string{"https://wiki.corp.local/display/OPS/", "http://www.wiki.corp.local/display/OPS#top", "https://wiki.corp.local:443/display/OPS?utm_source=mail"}
	for _, u := range same[1:] {
		if normURL(u) != normURL(same[0]) {
			t.Errorf("%s ≠ %s (%s vs %s)", u, same[0], normURL(u), normURL(same[0]))
		}
	}
	if normURL("https://wiki.corp.local/display/OPS?page=2") == normURL(same[0]) {
		t.Error("real query parameters must keep links apart")
	}
	s, _ := OpenStore(t.TempDir())
	list := []Bookmark{
		{Name: "Runbook", URL: same[0], Source: "edge"},
		{Name: "Runbook (chrome)", URL: same[1], Source: "chrome"},
		{Name: "Other", URL: "https://jenkins.corp.local/", Source: "chrome"},
	}
	if a, _ := s.SyncBookmarks(list); a != 2 {
		t.Fatalf("added %d, want 2 (one per real link)", a)
	}
}

// Two customers' workspaces import the same browser links; removing one in
// workspace A leaves workspace B untouched.
func TestRemovalIsPerWorkspace(t *testing.T) {
	list := []Bookmark{{Name: "YouTube", URL: "https://www.youtube.com/", Source: "chrome"}, {Name: "Wiki", URL: "https://wiki.corp.local/", Source: "chrome"}}
	a, _ := OpenStore(t.TempDir())
	b, _ := OpenStore(t.TempDir())
	a.SyncBookmarks(list)
	b.SyncBookmarks(list)
	for _, e := range a.st.Entries {
		if e.Name == "YouTube" {
			a.DeleteEntry(e.ID)
		}
	}
	a.SyncBookmarks(list)
	b.SyncBookmarks(list)
	visible := func(s *Store) (n int) {
		for _, e := range s.st.Entries {
			if !e.Hidden {
				n++
			}
		}
		return
	}
	if visible(a) != 1 || visible(b) != 2 {
		t.Fatalf("workspace A shows %d, B shows %d; want 1 and 2", visible(a), visible(b))
	}
}

func TestBlockedSites(t *testing.T) {
	for u, want := range map[string]bool{
		"https://xhamster.com/videos/x": true, "https://www.pornhub.com/": true, "https://de.xhamster.desi/": true,
		"https://something-porn-site.net/": true, "https://www.essex.ac.uk/": false, "https://www.sussex.gov.uk/": false,
		"https://wiki.corp.local/": false, "https://github.com/": false, "https://middlesex.edu/": false,
	} {
		if got := blockedURL(u, nil); got != want {
			t.Errorf("%s: blocked=%v, want %v", u, got, want)
		}
	}
	if !blockedURL("https://news.example.com/a", []string{"example.com"}) || blockedURL("https://example.org/", []string{"example.com"}) {
		t.Error("own block list")
	}
	s, _ := OpenStore(t.TempDir())
	s.SyncBookmarks([]Bookmark{{Name: "x", URL: "https://xhamster.com/", Source: "chrome"}, {Name: "Wiki", URL: "https://wiki.corp.local/", Source: "chrome"}})
	if len(s.st.Entries) != 1 || s.st.Entries[0].Name != "Wiki" {
		t.Fatalf("blocked site was imported: %d entries", len(s.st.Entries))
	}
	if _, es := s.Ingest("see https://www.pornhub.com/view and https://jenkins.corp.local/", "paste", ""); len(es) != 1 {
		t.Fatalf("captured %d, want only jenkins", len(es))
	}
	st := s.Settings()
	st.BlockedSites = []string{"wiki.corp.local"}
	s.SetSettings(st)
	if !s.st.Entries[0].Hidden {
		t.Fatal("blocking a site should hide what was already imported")
	}
}
