package main

import (
	"strings"
	"testing"
)

func TestSearchThreadsGivesMessagesWithContext(t *testing.T) {
	s, _ := OpenStore(t.TempDir())
	w := s.SaveWorkItem(WorkItem{Title: "PAY-200 refunds incident"})
	s.AddPost(w.ID, Post{Kind: "note", HTML: "<p>Nothing to see here.</p>"})
	a, _ := s.AddPost(w.ID, Post{Kind: "capture", Text: "2026-11-23 ERROR PaymentService - Payment 700097 failed: ORA-00060: Deadlock detected while waiting for resource", From: "Log app-01"})
	b, _ := s.AddPost(w.ID, Post{Kind: "note", HTML: "<p>The <b>deadlock</b> also hit app-02 at 10:14.<br>Batch replay is the suspect.</p>"})
	other := s.SaveWorkItem(WorkItem{Title: "Unrelated"})
	s.AddPost(other.ID, Post{Kind: "note", HTML: "<p>a deadlock, nothing else</p>"})

	got := s.SearchThreads([]string{"deadlock", "replay"})
	hits := got[w.ID]
	if len(hits) != 2 {
		t.Fatalf("want 2 matching messages, got %+v", got)
	}
	if hits[0].Post != b.ID || !strings.Contains(hits[0].Snip, "The deadlock also hit app-02") || !strings.Contains(hits[0].Snip, "Batch replay") {
		t.Fatalf("best match (both words) first, as written: %+v", hits[0])
	}
	if hits[1].Post != a.ID || !strings.Contains(hits[1].Snip, "Deadlock detected") || hits[1].From != "Log app-01" {
		t.Fatalf("second: %+v", hits[1])
	}
	if _, ok := got[other.ID]; ok {
		t.Fatal("a thread without every word matched")
	}
	if len(s.SearchThreads(nil)) != 0 {
		t.Fatal("no words: nothing")
	}
}
