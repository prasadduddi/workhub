package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestSSHArgs(t *testing.T) {
	e := Entry{Host: "jump.acme.local", Port: 2222, Protocol: "ssh", Username: "jdoe", Password: "secret", KeyFile: "/Users/me/.ssh/id_ed25519",
		Extra: map[string]string{"tunnels": "1522:dbhost:1521"}}
	got := strings.Join(sshArgs(e), " ")
	if want := "ssh -p 2222 -l jdoe -i /Users/me/.ssh/id_ed25519 -L 1522:dbhost:1521 jump.acme.local"; got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
	e.Extra["tunnels_off"], e.KeyFile, e.Protocol, e.Port = "1", `C:\keys\me.ppk`, "ftp", 21
	if got := strings.Join(sshArgs(e), " "); got != "ssh -p 22 -l jdoe jump.acme.local" {
		t.Fatalf("ppk / tunnels off / ftp port: %s", got)
	}
}

func TestOpenInMacTerminal(t *testing.T) {
	testMacTerminal = true
	defer func() { testMacTerminal = false; startProgram = func(c *exec.Cmd) error { return c.Start() } }()
	var ran []string
	startProgram = func(c *exec.Cmd) error { ran = c.Args; return nil }
	if err := openInMacTerminal(Entry{Name: "UAT app/01", Host: "app01.example.com", Username: "o'neil", Password: "never-written"}); err != nil {
		t.Fatal(err)
	}
	if len(ran) != 4 || ran[0] != "open" || ran[2] != "Terminal" || !strings.HasSuffix(ran[3], "ssh-UAT_app_01.command") {
		t.Fatalf("ran %v", ran)
	}
	b, err := os.ReadFile(ran[3])
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(strings.TrimSuffix(ran[3], "/ssh-UAT_app_01.command"))
	s := string(b)
	if !strings.Contains(s, `exec 'ssh' '-p' '22' '-l' 'o'\''neil' 'app01.example.com'`) || strings.Contains(s, "never-written") || !strings.Contains(s, `rm -f "$0"`) {
		t.Fatalf("script:\n%s", s)
	}
	if out, err := exec.Command("sh", "-n", ran[3]).CombinedOutput(); err != nil {
		t.Fatalf("not valid sh: %v %s", err, out)
	}
}

func TestFindToolMacApp(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("macOS apps only")
	}
	dir := t.TempDir()
	old := macAppsDir
	macAppsDir = dir
	defer func() { macAppsDir = old }()
	fz, _ := extToolByKey("filezilla")
	if got := macApp(fz); got != "" {
		t.Fatalf("found %q before it was installed", got)
	}
	p := filepath.Join(dir, "FileZilla.app", "Contents", "MacOS", "filezilla")
	os.MkdirAll(filepath.Dir(p), 0o755)
	os.WriteFile(p, []byte("x"), 0o755)
	if got := findTool(fz); got != p {
		t.Fatalf("found %q, want %q", got, p)
	}
}

func TestStartErrBadCPU(t *testing.T) {
	err := startErr("FileZilla", errors.New("fork/exec /Applications/FileZilla.app/Contents/MacOS/filezilla: bad CPU type in executable"))
	if !strings.Contains(err.Error(), "different kind of Mac") || !strings.Contains(err.Error(), "FileZilla") {
		t.Fatal(err)
	}
	if e := errors.New("other"); startErr("X", e) != e {
		t.Fatal("other errors should pass through")
	}
}
