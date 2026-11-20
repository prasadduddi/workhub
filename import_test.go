package main

import (
	"path/filepath"
	"testing"
)

func TestImportOldFolder(t *testing.T) {
	old := filepath.Join(t.TempDir(), "workhub-data")
	a, err := OpenStore(old)
	if err != nil {
		t.Fatal(err)
	}
	a.Ingest("host: old01.corp.local user: bob password: pw1", "paste", "Old")
	a.SaveNote(Note{Title: "n1", Body: "n1"})
	a.Flush()

	b, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	b.Ingest("host: new01.corp.local user: amy password: pw2", "paste", "New")
	st, err := readDataFolder(old)
	if err != nil {
		t.Fatal(err)
	}
	if e, n := b.Merge(st); e != 1 || n != 1 {
		t.Fatalf("merged %d entries, %d notes; want 1, 1", e, n)
	}
	if e, n := b.Merge(st); e != 0 || n != 0 { // importing twice adds nothing
		t.Fatalf("second merge added %d entries, %d notes", e, n)
	}
	got := map[string]string{}
	for _, e := range b.st.Entries {
		got[e.Host] = e.Password
	}
	if got["old01.corp.local"] != "pw1" || got["new01.corp.local"] != "pw2" {
		t.Fatalf("entries after merge: %v", got)
	}
}
