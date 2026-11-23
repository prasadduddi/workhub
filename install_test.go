package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// After "Install for easy access" the new copy deletes the one it came from.
func TestRemoveOldCopy(t *testing.T) {
	old := filepath.Join(t.TempDir(), "WorkHub-Desktop.exe")
	os.WriteFile(old, []byte("MZ"), 0o755)
	t.Setenv("WORKHUB_REMOVE_OLD", old)
	removeOldCopy()
	for i := 0; i < 30 && fileExists(old); i++ {
		time.Sleep(100 * time.Millisecond)
	}
	if fileExists(old) {
		t.Fatal("old copy not removed")
	}
	if os.Getenv("WORKHUB_REMOVE_OLD") != "" {
		t.Fatal("the variable should be cleared so a later restart doesn't repeat it")
	}
	if !samePath(`C:\Users\Jdoe\AppData`, `c:\users\jdoe\appdata\`) && filepath.Separator == '\\' {
		t.Fatal("paths on Windows compare without case")
	}
}
