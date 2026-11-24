package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// While SSH is switched off nothing SSH happens and nothing in ~/.ssh is read.
func TestSSHSwitchedOff(t *testing.T) {
	if !sshOff {
		t.Skip("SSH is on")
	}
	dir := t.TempDir()
	s, _ := OpenStore(dir)
	a := &App{store: s, dataDir: dir}

	// the built-in SSH refuses before reading anything, even a key file
	if _, err := a.dialSSH(Entry{Host: "127.0.0.1", Port: 22, Username: "x", KeyFile: filepath.Join(dir, "no-such-key")}, "", ""); !errors.Is(err, errSSHOff) {
		t.Fatalf("dialSSH: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "known_hosts")); err == nil {
		t.Fatal("known_hosts was written")
	}

	// the SSH keys window doesn't look at ~/.ssh
	old := sshDirFunc
	sshDirFunc = func() string { t.Fatal("~/.ssh was looked up"); return "" }
	defer func() { sshDirFunc = old }()
	rec := httptest.NewRecorder()
	a.handleSSHKeys(rec, httptest.NewRequest("GET", "/api/sshkeys", nil))
	var got map[string]any
	json.Unmarshal(rec.Body.Bytes(), &got)
	if got["off"] != true {
		t.Fatalf("ssh keys: %s", rec.Body.String())
	}

	// testing an SSH connection says so and leaves the entry's status alone
	e, err := s.SaveEntry(EntryInput{Name: "srv", Host: "127.0.0.1", Port: 22, Username: "ops", Protocol: "ssh"})
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(EntryInput{ID: e.ID, Host: "127.0.0.1", Port: 22, Username: "ops", Protocol: "ssh"})
	rec = httptest.NewRecorder()
	a.handleTestConnection(rec, httptest.NewRequest("POST", "/api/test", bytes.NewReader(body)))
	if !strings.Contains(rec.Body.String(), "switched off") {
		t.Fatalf("test: %s", rec.Body.String())
	}
	if got, _ := s.Entry(e.ID); got.Status != "" {
		t.Fatalf("status changed to %q", got.Status)
	}
	// nor does any other SSH path (terminal, SFTP, tunnels, log tail, remote compare) when refused
	s.SetStatus(e.ID, fmt.Errorf("tunnel: %w", errSSHOff))
	if got, _ := s.Entry(e.ID); got.Status != "" {
		t.Fatalf("a refused SSH path set the status to %q", got.Status)
	}
}

// git, run the way WorkHub runs it, never starts ssh (which reads ~/.ssh and
// may add to ~/.ssh/known_hosts) — checked with a fake ssh that leaves a mark.
func TestGitNeverStartsSSH(t *testing.T) {
	if !sshOff {
		t.Skip("SSH is on")
	}
	gitExe, err := exec.LookPath("git")
	if err != nil || runtime.GOOS == "windows" {
		t.Skip("needs git and a shell")
	}
	bin, mark := t.TempDir(), filepath.Join(t.TempDir(), "ssh-was-started")
	fake := filepath.Join(bin, "ssh")
	os.WriteFile(fake, []byte("#!/bin/sh\ntouch '"+mark+"'\nexit 1\n"), 0o755)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	for _, c := range []struct{ name, key, val string }{
		{"ssh on the PATH", "", ""},
		{"GIT_SSH set by the user", "GIT_SSH", fake},
		{"GIT_SSH_COMMAND set by the user", "GIT_SSH_COMMAND", fake},
	} {
		if c.key != "" {
			t.Setenv(c.key, c.val)
		}
		cmd := exec.Command(gitExe, "ls-remote", "git@example.com:team/repo.git")
		cmd.Env = gitEnv()
		out, _ := cmd.CombinedOutput()
		if _, err := os.Stat(mark); err == nil {
			t.Fatalf("%s: ssh was started: %s", c.name, out)
		}
		if h := gitSSHHint(string(out)); !strings.Contains(h, "SSH is switched off") {
			t.Errorf("%s: no hint for: %s", c.name, out)
		}
	}
}
