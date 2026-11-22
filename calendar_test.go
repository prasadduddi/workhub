package main

import "testing"

func TestEvents(t *testing.T) {
	s, _ := OpenStore(t.TempDir())
	if _, err := s.SaveEvent(Event{Title: "x", Date: "2026-11-3"}); err == nil {
		t.Fatal("bad date accepted")
	}
	if _, err := s.SaveEvent(Event{Title: "x", Date: "2026-11-30", Start: "25:00"}); err == nil {
		t.Fatal("bad time accepted")
	}
	e, err := s.SaveEvent(Event{Title: "Stand-up", Date: "2026-11-23", Start: "09:30", End: "09:45", Repeat: "weekdays", Remind: 5})
	if err != nil || e.ID == "" {
		t.Fatal(err)
	}
	s.DeleteEvent(e.ID, "2026-11-24") // one day of a repeat
	if l := s.Events(); len(l) != 1 || len(l[0].Skip) != 1 {
		t.Fatalf("skip: %+v", l)
	}
	s.DeleteEvent(e.ID, "")
	if len(s.Events()) != 0 {
		t.Fatal("not deleted")
	}
}
