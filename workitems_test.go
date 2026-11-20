package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWorkItems(t *testing.T) {
	dir := t.TempDir()
	s, _ := OpenStore(dir)
	w := s.SaveWorkItem(WorkItem{Title: "PAY-123 refund limits", Tags: []string{"payments"}})
	if w.Status != "todo" {
		t.Fatalf("default status %q", w.Status)
	}
	note, _ := s.AddBlock(w.ID, Block{Kind: "text", Text: "Raised with DBA"})
	link, _ := s.AddBlock(w.ID, Block{Kind: "link", URL: "https://corp.atlassian.net/browse/PAY-123"})
	at, err := s.storeAttachment("screen.png", []byte("\x89PNG\r\n\x1a\n...."))
	if err != nil {
		t.Fatal(err)
	}
	s.AddBlock(w.ID, Block{Kind: "image", File: &at})
	if _, data, err := s.ReadAttachment(at.ID); err != nil || len(data) == 0 {
		t.Fatalf("work item file not readable: %v", err)
	}
	txt := "Raised with DBA, waiting"
	s.UpdateBlock(w.ID, note.ID, &txt, nil, "down")
	got, _ := s.GetWorkItem(w.ID)
	if got.Blocks[0].ID != link.ID || got.Blocks[1].Text != txt {
		t.Fatalf("edit/move failed: %+v", got.Blocks)
	}
	s.DeleteWorkItem(w.ID)
	if _, err := os.Stat(filepath.Join(dir, "attachments", at.ID)); !os.IsNotExist(err) {
		t.Fatal("screenshot file left behind after deleting the work item")
	}
}
