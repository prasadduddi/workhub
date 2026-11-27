package main

import (
	"testing"
	"time"
)

func TestRecycleBin(t *testing.T) {
	s, _ := OpenStore(t.TempDir())
	e, _ := s.SaveEntry(EntryInput{Name: "app", Host: "app-01.example.com", Protocol: "ssh"})
	n := s.SaveNote(Note{Title: "Checklist", Body: "1. a"})
	par := s.SaveWorkItem(WorkItem{Title: "Parent"})
	w := s.SaveWorkItem(WorkItem{Title: "Release"})
	_ = s.SetWorkParent(w.ID, par.ID)
	s.AddPost(w.ID, Post{Kind: "note", Text: "hello"})

	s.DeleteEntry(e.ID)
	s.DeleteNote(n.ID)
	s.DeleteWorkItem(par.ID)
	s.DeleteWorkItem(w.ID)
	if len(s.Entries()) != 0 || len(s.Notes()) != 0 {
		t.Fatal("deleted things still listed")
	}
	items := s.BinItems()
	if len(items) != 4 || items[0].Title != "Release" {
		t.Fatalf("bin: %+v", items)
	}
	for _, it := range items {
		if _, err := s.RestoreBin(it.ID); err != nil {
			t.Fatal(err)
		}
	}
	got, ok := s.GetWorkItem(w.ID)
	if !ok || len(got.Posts) != 1 || len(s.Entries()) != 1 || len(s.Notes()) != 1 || len(s.BinItems()) != 0 {
		t.Fatalf("restore: thread %v posts %d entries %d notes %d", ok, len(got.Posts), len(s.Entries()), len(s.Notes()))
	}
	if _, err := s.RestoreBin("nope"); err == nil {
		t.Fatal("restoring something not in the bin")
	}
	// older than 30 days: gone by itself
	s.DeleteNote(n.ID)
	s.mu.Lock()
	s.st.Bin[0].Deleted = time.Now().Add(-31 * 24 * time.Hour)
	s.mu.Unlock()
	if s.purgeBin(false, "") != 1 || len(s.BinItems()) != 0 {
		t.Fatal("30-day clean-up")
	}
}
