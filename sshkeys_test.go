package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
)

// The keys are listed with a GitHub-ready line, the config hosts are read —
// and nothing in the folder changes.
func TestSSHKeysReadOnly(t *testing.T) {
	dir := t.TempDir()
	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	sp, _ := ssh.NewPublicKey(pub)
	line := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(sp))) + " jdoe@example.com"
	os.WriteFile(filepath.Join(dir, "id_ed25519.pub"), []byte(line+"\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "id_ed25519"), []byte("-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n"), 0o600)
	os.WriteFile(filepath.Join(dir, "config"), []byte("Host gh\n  HostName github.com\n  User git\n  IdentityFile ~/.ssh/id_ed25519\n\nHost jump\n  HostName 192.0.2.10\n  Port 2222\n"), 0o600)
	os.WriteFile(filepath.Join(dir, "known_hosts"), []byte("github.com ssh-ed25519 AAAA\n"), 0o644)
	snapshot := func() map[string]string {
		m := map[string]string{}
		ents, _ := os.ReadDir(dir)
		for _, e := range ents {
			b, _ := os.ReadFile(filepath.Join(dir, e.Name()))
			info, _ := e.Info()
			m[e.Name()] = string(sha256.New().Sum(b)) + info.ModTime().String() + info.Mode().String()
		}
		return m
	}
	before := snapshot()
	old := sshDirFunc
	sshDirFunc = func() string { return dir }
	defer func() { sshDirFunc = old }()

	w := httptest.NewRecorder()
	(&App{}).handleSSHKeys(w, httptest.NewRequest("GET", "/api/sshkeys", nil))
	var out struct {
		Keys  []sshKeyInfo
		Hosts []sshHost
	}
	json.Unmarshal(w.Body.Bytes(), &out)
	if len(out.Keys) != 1 || out.Keys[0].Public != line || !out.Keys[0].HasPrivate || !out.Keys[0].GitHubOK || !strings.HasPrefix(out.Keys[0].Fingerprint, "SHA256:") {
		t.Fatalf("keys: %+v", out.Keys)
	}
	if strings.Contains(w.Body.String(), "secret") {
		t.Fatal("a private key must never be read")
	}
	if len(out.Hosts) != 2 || out.Hosts[0].HostName != "github.com" || out.Hosts[1].Port != "2222" {
		t.Fatalf("hosts: %+v", out.Hosts)
	}
	after := snapshot()
	if len(after) != len(before) {
		t.Fatal("files were added or removed in ~/.ssh")
	}
	for k, v := range before {
		if after[k] != v {
			t.Fatalf("%s changed — ~/.ssh must stay read-only", k)
		}
	}
}

func TestPPKPublicOnly(t *testing.T) {
	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	sp, _ := ssh.NewPublicKey(pub)
	b64 := strings.Fields(string(ssh.MarshalAuthorizedKey(sp)))[1]
	p := filepath.Join(t.TempDir(), "work.ppk")
	os.WriteFile(p, []byte("PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\nComment: ops-laptop\nPublic-Lines: 1\n"+b64+"\nPrivate-Lines: 1\nPRIVATEPART\nPrivate-MAC: 00\n"), 0o600)
	line, ok := ppkPublic(p)
	if !ok || strings.Contains(line, "PRIVATEPART") || line != "ssh-ed25519 "+b64+" ops-laptop" {
		t.Fatalf("ppk: %q %v", line, ok)
	}
}
