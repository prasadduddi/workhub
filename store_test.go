package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// A brand-new workspace must send empty lists, not null, to the browser.
func TestEmptyListsAreNotNull(t *testing.T) {
	s, _ := OpenStore(t.TempDir())
	for name, v := range map[string]any{"entries": s.Entries(), "clips": s.Clips(10), "notes": s.Notes(), "recent": s.Recent()} {
		if b, _ := json.Marshal(v); string(b) != "[]" {
			t.Errorf("%s = %s, want []", name, b)
		}
	}
}

func TestBulk(t *testing.T) {
	s, _ := OpenStore(t.TempDir())
	s.Ingest("https://www.youtube.com/watch?v=1 https://youtube.com/c/x https://jenkins.corp.local/", "paste", "Links")
	var ids []string
	for _, e := range s.st.Entries {
		if strings.Contains(e.URL, "youtube") {
			ids = append(ids, e.ID)
		}
	}
	if n, err := s.Bulk(ids, "hide", ""); err != nil || n != 2 {
		t.Fatalf("hid %d (%v)", n, err)
	}
	visible := 0
	for _, e := range s.st.Entries {
		if !e.Hidden {
			visible++
		}
	}
	if visible != 1 {
		t.Fatalf("%d visible, want 1", visible)
	}
	if n, _ := s.Bulk(ids, "project", "Music"); n != 2 || s.st.Entries[0].Project != "Music" {
		t.Fatal("move to project failed")
	}
	if _, err := s.Bulk(ids, "explode", ""); err == nil {
		t.Fatal("unknown action should fail")
	}
}
