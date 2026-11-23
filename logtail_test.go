package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestFindLogsCommand(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "app", "logs"), 0o755)
	os.WriteFile(filepath.Join(dir, "app", "logs", "pay api.log"), []byte("x\n"), 0o644) // a space in the name
	os.WriteFile(filepath.Join(dir, "readme.txt"), []byte("x"), 0o644)
	out, err := exec.Command("/bin/sh", "-c", findLogsCommand(dir)).Output()
	if err != nil {
		t.Fatal(err)
	}
	got := parseFoundLogs(string(out))
	if len(got) != 1 || filepath.Base(got[0].Path) != "pay api.log" || got[0].Size != 2 {
		t.Fatalf("found %+v from %q", got, out)
	}
	if c := tailCommand("/var/log/a'b.log", 0); c != `tail -n 200 -F -- '/var/log/a'\''b.log' 2>&1` {
		t.Fatalf("tail command %s", c)
	}
}
