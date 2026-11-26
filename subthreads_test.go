package main

import "testing"

func TestSubThreads(t *testing.T) {
	s, _ := OpenStore(t.TempDir())
	top := s.SaveWorkItem(WorkItem{Title: "Release 4.2"})
	kid := s.SaveWorkItem(WorkItem{Title: "DB changes"})
	grand := s.SaveWorkItem(WorkItem{Title: "Index rebuild"})
	other := s.SaveWorkItem(WorkItem{Title: "Unrelated"})
	if err := s.SetWorkParent(kid.ID, top.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.SetWorkParent(grand.ID, kid.ID); err != nil {
		t.Fatal(err)
	}
	// no loops: a thread can't go under itself or its own sub-thread
	if s.SetWorkParent(top.ID, grand.ID) == nil || s.SetWorkParent(top.ID, top.ID) == nil {
		t.Fatal("a loop was allowed")
	}
	if s.SetWorkParent(kid.ID, "missing") == nil {
		t.Fatal("unknown parent accepted")
	}
	s.AddPost(grand.ID, Post{Kind: "note", HTML: "<p>Rebuild the refund index before the deadlock fix</p>"})
	s.AddPost(kid.ID, Post{Kind: "note", Text: "deadlock seen on ORA"})
	s.AddPost(other.ID, Post{Kind: "note", Text: "deadlock elsewhere"})
	hits := s.SearchSubThreads(top.ID, []string{"deadlock"})
	if len(hits) != 2 {
		t.Fatalf("want the 2 sub-thread messages, got %+v", hits)
	}
	for _, h := range hits {
		if h.Thread == other.ID || h.Thread == top.ID {
			t.Fatalf("searched outside the sub-threads: %+v", h)
		}
	}
	if len(s.SearchSubThreads(top.ID, []string{"deadlock", "index"})) != 1 {
		t.Fatal("all words must be in the message")
	}
	// deleting the middle one: its sub-thread moves up, not away
	s.DeleteWorkItem(kid.ID)
	g, _ := s.GetWorkItem(grand.ID)
	if g.Parent != top.ID {
		t.Fatalf("grandchild should move under the top thread, parent=%q", g.Parent)
	}
	if err := s.SetWorkParent(grand.ID, ""); err != nil || func() string { g, _ := s.GetWorkItem(grand.ID); return g.Parent }() != "" {
		t.Fatal("back to the top level failed")
	}
}
