package main

import (
	"strings"
	"testing"
)

func TestThreads(t *testing.T) {
	s, _ := OpenStore(t.TempDir())
	// An older work item with a document becomes a thread whose first post is that document.
	old := s.SaveWorkItem(WorkItem{Title: "PAY-1 release"})
	_ = s.SetWorkDoc(old.ID, "<p>Steps agreed with ops</p>")
	s.mu.Lock()
	s.migrateThreads()
	s.mu.Unlock()
	w, _ := s.GetWorkItem(old.ID)
	if len(w.Posts) != 1 || !strings.Contains(w.Posts[0].HTML, "Steps agreed") {
		t.Fatalf("document not carried over: %+v", w.Posts)
	}

	p, err := s.AddPost(old.ID, Post{Kind: "note", HTML: "<p>Deployed to UAT</p>"})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.EditPost(old.ID, p.ID, "<p>Deployed to UAT at 10:00</p>"); err != nil {
		t.Fatal(err)
	}
	// Captures go to the active thread; its Word copy hides saved passwords.
	s.mu.Lock()
	s.st.Settings.ActiveThread = old.ID
	s.mu.Unlock()
	s.Ingest("ssh deploy@app-01.uat.example.com password: S3cret-99", "paste", "")
	w, _ = s.GetWorkItem(old.ID)
	if len(w.Posts) != 3 || w.Posts[2].Kind != "capture" {
		t.Fatalf("capture not added to the active thread: %d posts", len(w.Posts))
	}
	doc := s.threadHTML(w)
	if !strings.Contains(doc, "Deployed to UAT at 10:00") || !strings.Contains(doc, "app-01.uat.example.com") {
		t.Fatalf("thread document incomplete: %s", doc)
	}
	if strings.Contains(doc, "S3cret-99") {
		t.Fatal("saved password shown in the Word copy")
	}
	if err := s.DeletePost(old.ID, p.ID); err != nil {
		t.Fatal(err)
	}
	if w, _ = s.GetWorkItem(old.ID); len(w.Posts) != 2 {
		t.Fatalf("delete: %d posts", len(w.Posts))
	}
}
