package main

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// Each Browse button opens where it last chose; the first time at the default (C:\ on Windows).
func TestBrowseRemembersFolder(t *testing.T) {
	dir := t.TempDir()
	s, _ := OpenStore(dir)
	a := &App{store: s}
	var startedAt string
	choose := filepath.Join(dir, "chosen")
	_ = os.Mkdir(choose, 0o700)
	oldF, oldFile := pickFolderFn, pickFileFn
	defer func() { pickFolderFn, pickFileFn = oldF, oldFile }()
	pickFolderFn = func(start string) (string, bool, error) { startedAt = start; return choose, true, nil }
	pickFileFn = func(start string) (string, bool, error) {
		startedAt = start
		return filepath.Join(choose, "x.txt"), true, nil
	}
	call := func(path string, body map[string]string) {
		b, _ := json.Marshal(body)
		w := httptest.NewRecorder()
		if path == "file" {
			a.handlePickFile(w, httptest.NewRequest("POST", "/api/local/pickfile", bytes.NewReader(b)))
		} else {
			a.handleLocalPick(w, httptest.NewRequest("POST", "/api/local/pick", bytes.NewReader(b)))
		}
	}
	call("folder", map[string]string{"key": "ftp-local"})
	if startedAt != defaultPickDir() {
		t.Fatalf("first time should start at %q, got %q", defaultPickDir(), startedAt)
	}
	call("folder", map[string]string{"key": "ftp-local"})
	if startedAt != choose {
		t.Fatalf("second time should start where it chose: %q", startedAt)
	}
	call("folder", map[string]string{"key": "git-add"})
	if startedAt != defaultPickDir() {
		t.Fatal("another button keeps its own folder")
	}
	call("file", map[string]string{"key": "notes-file"})
	call("file", map[string]string{"key": "notes-file"})
	if startedAt != choose {
		t.Fatalf("file picker: the chosen file's folder: %q", startedAt)
	}
	_ = os.RemoveAll(choose) // the folder is gone: back to the default
	call("folder", map[string]string{"key": "ftp-local"})
	if startedAt != defaultPickDir() {
		t.Fatalf("gone folder: %q", startedAt)
	}
}
