package main

// 🔑 My SSH keys: lists the public keys in your own ~/.ssh (and the public
// half of PuTTY .ppk keys) with a Copy button for GitHub, plus the hosts in
// ~/.ssh/config. READ-ONLY: nothing in ~/.ssh is ever written, created or
// changed, and private keys are never read (only whether one exists).

import (
	"bufio"
	"crypto/rsa"
	"encoding/base64"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

type sshKeyInfo struct {
	File        string    `json:"file"`
	Type        string    `json:"type"`
	Bits        int       `json:"bits,omitempty"`
	Comment     string    `json:"comment,omitempty"`
	Fingerprint string    `json:"fingerprint"`
	Public      string    `json:"public"` // the line to paste into GitHub
	HasPrivate  bool      `json:"has_private"`
	GitHubOK    bool      `json:"github_ok"`
	Note        string    `json:"note,omitempty"`
	Modified    time.Time `json:"modified"`
}

type sshHost struct {
	Host     string `json:"host"`
	HostName string `json:"hostname,omitempty"`
	User     string `json:"user,omitempty"`
	Port     string `json:"port,omitempty"`
	Identity string `json:"identity,omitempty"`
}

var sshDirFunc = func() string { // tests point it elsewhere
	h, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(h, ".ssh")
}

// describeKey turns an OpenSSH public key line into sshKeyInfo.
func describeKey(line string) (sshKeyInfo, bool) {
	pub, comment, _, _, err := ssh.ParseAuthorizedKey([]byte(line))
	if err != nil {
		return sshKeyInfo{}, false
	}
	k := sshKeyInfo{Type: pub.Type(), Comment: comment, Fingerprint: ssh.FingerprintSHA256(pub),
		Public: strings.TrimSpace(string(ssh.MarshalAuthorizedKey(pub))) + map[bool]string{true: " " + comment, false: ""}[comment != ""]}
	if c, ok := pub.(ssh.CryptoPublicKey); ok {
		if r, ok := c.CryptoPublicKey().(*rsa.PublicKey); ok {
			k.Bits = r.N.BitLen()
		}
	}
	switch {
	case k.Type == ssh.KeyAlgoDSA:
		k.Note = "DSA keys are no longer accepted by GitHub — ask for an ed25519 key"
	case k.Type == ssh.KeyAlgoRSA && k.Bits < 2048:
		k.Note = "RSA keys under 2048 bits are weak; GitHub may refuse them"
		k.GitHubOK = k.Bits >= 1024
	default:
		k.GitHubOK = true
	}
	return k, true
}

// ppkPublic reads only the header and Public-Lines of a PuTTY key file; the
// private lines are not used.
func ppkPublic(path string) (string, bool) {
	f, err := os.Open(path)
	if err != nil {
		return "", false
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	var algo, comment string
	var b64 strings.Builder
	for sc.Scan() {
		l := strings.TrimRight(sc.Text(), "\r")
		switch {
		case strings.HasPrefix(l, "PuTTY-User-Key-File-"):
			if _, v, ok := strings.Cut(l, ": "); ok {
				algo = v
			}
		case strings.HasPrefix(l, "Comment: "):
			comment = strings.TrimPrefix(l, "Comment: ")
		case strings.HasPrefix(l, "Public-Lines: "):
			n, _ := strconv.Atoi(strings.TrimPrefix(l, "Public-Lines: "))
			for i := 0; i < n && sc.Scan(); i++ {
				b64.WriteString(strings.TrimSpace(sc.Text()))
			}
			if _, err := base64.StdEncoding.DecodeString(b64.String()); err != nil || algo == "" {
				return "", false
			}
			return algo + " " + b64.String() + " " + comment, true // stop before the private part
		}
	}
	return "", false
}

func readSSHKeys(dir string) []sshKeyInfo {
	out := []sshKeyInfo{}
	ents, err := os.ReadDir(dir)
	if err != nil {
		return out
	}
	for _, e := range ents {
		if e.IsDir() {
			continue
		}
		name, p := e.Name(), filepath.Join(dir, e.Name())
		info, _ := e.Info()
		var line string
		var ok bool
		switch {
		case strings.HasSuffix(name, ".pub"):
			b, err := os.ReadFile(p)
			if err != nil || len(b) > 64<<10 {
				continue
			}
			line, ok = strings.TrimSpace(string(b)), true
		case strings.HasSuffix(strings.ToLower(name), ".ppk"):
			line, ok = ppkPublic(p)
		}
		if !ok {
			continue
		}
		k, good := describeKey(line)
		if !good {
			continue
		}
		k.File = name
		if strings.HasSuffix(name, ".pub") {
			_, err := os.Stat(strings.TrimSuffix(p, ".pub")) // only whether it exists
			k.HasPrivate = err == nil
		} else {
			k.HasPrivate = true // a .ppk holds both
		}
		if info != nil {
			k.Modified = info.ModTime()
		}
		out = append(out, k)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Modified.After(out[j].Modified) })
	return out
}

// readSSHConfig lists the Host blocks of ~/.ssh/config (read-only).
func readSSHConfig(path string) []sshHost {
	out := []sshHost{}
	f, err := os.Open(path)
	if err != nil {
		return out
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	var cur *sshHost
	for sc.Scan() {
		l := strings.TrimSpace(sc.Text())
		if l == "" || strings.HasPrefix(l, "#") {
			continue
		}
		k, v, ok := strings.Cut(strings.Replace(l, "=", " ", 1), " ")
		if !ok {
			continue
		}
		k, v = strings.ToLower(strings.TrimSpace(k)), strings.Trim(strings.TrimSpace(v), `"`)
		switch k {
		case "host":
			out = append(out, sshHost{Host: v})
			cur = &out[len(out)-1]
		case "match":
			cur = nil
		}
		if cur == nil {
			continue
		}
		switch k {
		case "hostname":
			cur.HostName = v
		case "user":
			cur.User = v
		case "port":
			cur.Port = v
		case "identityfile":
			cur.Identity = v
		}
	}
	return out
}

func (a *App) handleSSHKeys(w http.ResponseWriter, r *http.Request) {
	if a.sshKeysOff() { // not ticked in Settings: ~/.ssh is not read at all
		writeJSON(w, map[string]any{"off": true, "keys": []sshKeyInfo{}, "hosts": []sshHost{}})
		return
	}
	dir := sshDirFunc()
	_, err := os.Stat(dir)
	writeJSON(w, map[string]any{"dir": dir, "exists": err == nil, "keys": readSSHKeys(dir), "hosts": readSSHConfig(filepath.Join(dir, "config"))})
}
