package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCompareDirs(t *testing.T) {
	a, b := t.TempDir(), t.TempDir()
	w := func(root, rel, s string) {
		p := filepath.Join(root, filepath.FromSlash(rel))
		os.MkdirAll(filepath.Dir(p), 0o755)
		os.WriteFile(p, []byte(s), 0o644)
	}
	w(a, "same.txt", "x=1")
	w(b, "same.txt", "x=1")
	w(a, "conf/app.properties", "port=1")
	w(b, "conf/app.properties", "port=2") // same size, other content
	w(a, "only-left.txt", "l")
	w(b, "logs/only-right.log", "r")
	got, err := compareDirs(a, b)
	if err != nil {
		t.Fatal(err)
	}
	st := map[string]string{}
	for _, e := range got {
		st[e.Rel] = e.Status
	}
	want := map[string]string{"same.txt": "same", "conf": "diff", "conf/app.properties": "diff", "only-left.txt": "left", "logs": "right", "logs/only-right.log": "right"}
	for k, v := range want {
		if st[k] != v {
			t.Errorf("%s: got %q want %q (all: %v)", k, st[k], v, st)
		}
	}
}
