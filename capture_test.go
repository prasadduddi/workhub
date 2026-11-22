package main

import (
	"errors"
	"testing"
)

func TestRecaptureKeepsWorkingPassword(t *testing.T) {
	s, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	_, es := s.Ingest("host: app01.corp.local user: bob password: good1", "clipboard", "P")
	id := es[0].ID
	s.SetStatus(id, nil) // connected with good1
	s.Ingest("host: app01.corp.local user: bob password: other2", "paste", "P")
	e, _ := s.Entry(id)
	if e.Password != "good1" || len(e.PrevPasswords) != 1 || e.PrevPasswords[0] != "other2" {
		t.Fatalf("working password not kept: %q prev %v", e.Password, e.PrevPasswords)
	}
	if len(e.Captures) != 2 || e.Captures[0].Source != "clipboard" || e.Captures[1].Source != "paste" || e.Captures[0].At.IsZero() {
		t.Fatalf("captures: %+v", e.Captures)
	}

	// A failed one is replaced by the new details, which are then untried.
	_, es = s.Ingest("host: app02.corp.local user: amy password: bad1", "clipboard", "P")
	s.SetStatus(es[0].ID, errors.New("auth failed"))
	s.Ingest("host: app02.corp.local user: amy password: new2", "clipboard", "P")
	e, _ = s.Entry(es[0].ID)
	if e.Password != "new2" || e.Status != "" || e.PrevPasswords[0] != "bad1" {
		t.Fatalf("failed password not replaced: %+v", e)
	}
}

func TestBookmarkCaptureSource(t *testing.T) {
	s, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s.SyncBookmarks([]Bookmark{{Name: "Wiki", URL: "https://wiki.corp.local/", Folder: "Chrome › Bookmarks bar", Source: "chrome"}})
	for _, e := range s.Entries() {
		if c := e.Captures; len(c) != 1 || c[0].Source != "chrome" || c[0].Detail != "Chrome › Bookmarks bar" {
			t.Fatalf("captures: %+v", c)
		}
	}
}
