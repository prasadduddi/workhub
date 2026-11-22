package main

import (
	"strings"
	"testing"
)

func TestUnsortedInbox(t *testing.T) {
	s, _ := OpenStore(t.TempDir())
	_, views := s.Ingest("ssh deploy@app-07.uat.example.com", "clipboard", "General")
	if len(views) == 0 || !views[0].Unsorted {
		t.Fatalf("new capture not unsorted: %+v", views)
	}
	e := views[0]
	in := EntryInput{ID: e.ID, Host: e.Host, Port: e.Port, Protocol: e.Protocol, Username: e.Username, URL: e.URL, Project: "Example UAT"}
	v, err := s.SaveEntry(in)
	if err != nil || v.Unsorted {
		t.Fatalf("saving should sort it: %v %+v", err, v)
	}
	_, again := s.Ingest("ssh deploy@app-07.uat.example.com", "paste", "General")
	if again[0].Unsorted {
		t.Fatal("capturing a known entry again must not put it back in the inbox")
	}
}

func TestDuplicateClipboardSkipped(t *testing.T) {
	s, _ := OpenStore(t.TempDir())
	if c, _ := s.Ingest("ssh ops@db-01.test.example.com", "clipboard", ""); c == nil {
		t.Fatal("first copy not captured")
	}
	if c, _ := s.Ingest("  ssh ops@db-01.test.example.com\n", "clipboard", ""); c != nil {
		t.Fatal("the same text copied again was captured twice")
	}
	if c, _ := s.Ingest("ssh ops@db-01.test.example.com", "paste", ""); c == nil {
		t.Fatal("an explicit paste should still be kept")
	}
}

func TestOwnLinkNeverCaptured(t *testing.T) {
	s, _ := OpenStore(t.TempDir())
	if c, _ := s.Ingest("http://127.0.0.1:47950/?t=0123456789abcdef0123456789abcdef", "clipboard", ""); c != nil {
		t.Fatal("WorkHub's own sign-in link was captured")
	}
	c, es := s.Ingest("see http://127.0.0.1:47950/?t=0123456789abcdef0123456789abcdef and ssh ops@app-03.test.example.com", "paste", "")
	if c == nil || strings.Contains(c.Text, "0123456789abcdef") {
		t.Fatalf("token kept in the capture: %+v", c)
	}
	for _, e := range es {
		if strings.Contains(e.URL, "127.0.0.1") {
			t.Fatalf("own address saved as an entry: %s", e.URL)
		}
	}
}

func TestTidyClipsMergesDuplicatesAndTokens(t *testing.T) {
	dir := t.TempDir()
	s, _ := OpenStore(dir)
	s.mu.Lock()
	tok := "http://127.0.0.1:47950/?t=0123456789abcdef0123456789abcdef"
	e := &Entry{ID: "e1", Host: "app-09.test.example.com", ClipIDs: []string{"c1", "c2"}}
	s.st.Entries = append(s.st.Entries, e, &Entry{ID: "e2", URL: tok})
	s.st.Clips = append(s.st.Clips,
		&Clip{ID: "c1", Text: "ssh ops@app-09.test.example.com", EntryIDs: []string{"e1"}},
		&Clip{ID: "c2", Text: "ssh  ops@app-09.test.example.com\n", EntryIDs: []string{"e1"}},
		&Clip{ID: "c3", Text: tok})
	s.tidyClips()
	s.mu.Unlock()
	if len(s.st.Clips) != 1 || s.st.Clips[0].ID != "c1" {
		t.Fatalf("clips after tidy: %d", len(s.st.Clips))
	}
	if len(s.st.Entries) != 1 || strings.Join(s.st.Entries[0].ClipIDs, ",") != "c1" {
		t.Fatalf("entries after tidy: %+v", s.st.Entries)
	}
}
