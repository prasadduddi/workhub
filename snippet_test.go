package main

import "testing"

// A script attached to a thread can be edited in the viewer and saved.
func TestThreadFileEdit(t *testing.T) {
	s, _ := OpenStore(t.TempDir())
	wi := s.SaveWorkItem(WorkItem{Title: "x"})
	at, err := s.storeAttachment("restart.sh", []byte("#!/bin/bash\necho old\n"))
	if err != nil {
		t.Fatal(err)
	}
	if err := s.AddWorkFile(wi.ID, at); err != nil {
		t.Fatal(err)
	}
	if !at.Text {
		t.Fatal("a .sh script should count as text")
	}
	got, err := s.WriteAttachment(at.ID, []byte("echo new\n"))
	if err != nil || got.Size != 9 {
		t.Fatalf("save: %v %+v", err, got)
	}
	_, data, err := s.ReadAttachment(at.ID)
	if err != nil || string(data) != "echo new\n" {
		t.Fatalf("read back: %v %q", err, data)
	}
	if _, err := s.WriteAttachment("nope", []byte("x")); err == nil {
		t.Fatal("unknown file must fail")
	}
}
