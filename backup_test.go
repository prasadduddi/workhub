package main

import (
	"archive/zip"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestBackups(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "data")
	st, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	st.Ingest("ssh ops@app01.corp.local", "paste", "General")
	st.Flush()
	os.MkdirAll(filepath.Join(dir, "reference", "JSON"), 0o700)
	os.WriteFile(filepath.Join(dir, "reference", "JSON", "a.json"), []byte(`{"a":1}`), 0o600)
	os.WriteFile(filepath.Join(dir, "session.token"), []byte("secret"), 0o600)
	a := &App{store: st, dataDir: dir}
	n1, err := a.backup(false)
	if err != nil || n1 == "" {
		t.Fatalf("first backup: %q %v", n1, err)
	}
	if filepath.Dir(filepath.Join(a.backupDir(), n1)) != filepath.Join(root, "data-backups") {
		t.Fatal("backups must sit next to the data folder")
	}
	zr, err := zip.OpenReader(filepath.Join(a.backupDir(), n1))
	if err != nil {
		t.Fatal(err)
	}
	have := map[string]bool{}
	for _, f := range zr.File {
		have[f.Name] = true
	}
	zr.Close()
	if !have["workhub.dat"] || !have["key.bin"] || !have["reference/JSON/a.json"] || have["session.token"] {
		t.Fatalf("backup contents: %v", have)
	}
	if n, _ := a.backup(false); n != "" {
		t.Fatal("backed up again although nothing changed")
	}
	time.Sleep(10 * time.Millisecond)
	os.WriteFile(filepath.Join(dir, "reference", "JSON", "a.json"), []byte(`{"a":2}`), 0o600)
	if n, _ := a.backup(false); n == "" || n == n1 {
		t.Fatalf("change not backed up: %q", n)
	}
	for i := 0; i < backupKeep+3; i++ {
		a.backup(true)
	}
	if got := len(a.backups()); got != backupKeep {
		t.Fatalf("kept %d backups, want %d", got, backupKeep)
	}
}

// Backups are also copied to a second folder (e.g. OneDrive), newest 30 kept.
func TestBackupCopy(t *testing.T) {
	root := t.TempDir()
	dir, copyTo := filepath.Join(root, "data"), filepath.Join(root, "OneDrive", "WorkHub backups")
	st, _ := OpenStore(dir)
	st.Ingest("ssh ops@app01.corp.local", "paste", "General")
	set := st.Settings()
	set.BackupCopy = copyTo
	st.SetSettings(set)
	a := &App{store: st, dataDir: dir}
	n, err := a.backup(true)
	if err != nil {
		t.Fatal(err)
	}
	orig, _ := os.ReadFile(filepath.Join(a.backupDir(), n))
	cp, err := os.ReadFile(filepath.Join(copyTo, n))
	if err != nil || len(cp) != len(orig) || backupCopyErr != "" {
		t.Fatalf("copy: %v %q", err, backupCopyErr)
	}
	for i := 0; i < 35; i++ { // older ones already there
		os.WriteFile(filepath.Join(copyTo, "WorkHub-backup-2020-01-"+string(rune('a'+i%26))+string(rune('a'+i/26))+".zip"), []byte("x"), 0o600)
	}
	a.copyBackup(filepath.Join(a.backupDir(), n))
	ents, _ := os.ReadDir(copyTo)
	if len(ents) != backupKeep {
		t.Fatalf("kept %d in the copy folder, want %d", len(ents), backupKeep)
	}
	if _, err := os.Stat(filepath.Join(copyTo, n)); err != nil {
		t.Fatal("the newest copy was pruned")
	}
}
