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
	h := "<p>Deployed to UAT at 10:00</p>"
	if err := s.EditPost(old.ID, p.ID, &h, nil); err != nil {
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

func TestThreadRepliesAndPins(t *testing.T) {
	s, _ := OpenStore(t.TempDir())
	w := s.SaveWorkItem(WorkItem{Title: "CM-9"})
	top, _ := s.AddPost(w.ID, Post{Kind: "note", HTML: "<p>Plan</p>"})
	r1, err := s.AddPost(w.ID, Post{Kind: "note", HTML: "<p>Agreed</p>", Parent: top.ID})
	if err != nil || r1.Parent != top.ID {
		t.Fatalf("reply: %v %+v", err, r1)
	}
	r2, _ := s.AddPost(w.ID, Post{Kind: "note", HTML: "<p>Me too</p>", Parent: r1.ID})
	if r2.Parent != top.ID {
		t.Fatal("a reply to a reply should answer the original post")
	}
	if _, err := s.AddPost(w.ID, Post{Kind: "note", Parent: "nope"}); err == nil {
		t.Fatal("reply to a missing post accepted")
	}
	pin := true
	if err := s.EditPost(w.ID, top.ID, nil, &pin); err != nil {
		t.Fatal(err)
	}
	got, _ := s.GetWorkItem(w.ID)
	if !got.Posts[0].Pinned || got.Posts[0].HTML != "<p>Plan</p>" {
		t.Fatalf("pin changed the text or didn't stick: %+v", got.Posts[0])
	}
	doc := s.threadHTML(got)
	if !strings.Contains(doc, "📌") || !strings.Contains(doc, "↳ reply") {
		t.Fatalf("Word copy lacks pin/replies: %s", doc)
	}
	if err := s.DeletePost(w.ID, top.ID); err != nil {
		t.Fatal(err)
	}
	if got, _ = s.GetWorkItem(w.ID); len(got.Posts) != 0 {
		t.Fatalf("replies left behind: %d", len(got.Posts))
	}
}
