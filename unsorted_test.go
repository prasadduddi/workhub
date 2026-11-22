package main

import "testing"

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
	_, again := s.Ingest("ssh deploy@app-07.uat.example.com", "clipboard", "General")
	if again[0].Unsorted {
		t.Fatal("capturing a known entry again must not put it back in the inbox")
	}
}
