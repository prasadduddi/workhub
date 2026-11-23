package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMasterPassword(t *testing.T) {
	dir := t.TempDir()
	s, _ := OpenStore(dir)
	s.Ingest("ssh deploy@srv-01.example.com", "paste", "")
	s.Flush()
	if _, err := s.SetMaster("", "short"); err == nil {
		t.Fatal("a 5-character master password was accepted")
	}
	rec, err := s.SetMaster("", "Correct horse 1")
	if err != nil || rec == "" {
		t.Fatalf("set: %v", err)
	}
	if fileExists(filepath.Join(dir, "key.bin")) {
		t.Fatal("key.bin still there: the data opens without the password")
	}
	if _, err := OpenStore(dir); !errors.Is(err, errMasterNeeded) {
		t.Fatalf("opened without the password: %v", err)
	}
	if _, _, err := unlockMaster(dir, "wrong one!"); !errors.Is(err, errBadMaster) {
		t.Fatalf("wrong password: %v", err)
	}
	key, usedRec, err := unlockMaster(dir, "Correct horse 1")
	if err != nil || usedRec {
		t.Fatalf("right password: %v %v", err, usedRec)
	}
	s2, err := OpenStoreKey(dir, key)
	if err != nil || len(s2.Entries()) != 1 {
		t.Fatalf("reopen: %v", err)
	}
	if _, usedRec, err := unlockMaster(dir, strings.ToLower(rec)); err != nil || !usedRec {
		t.Fatalf("recovery code: %v %v", err, usedRec)
	}
	// changing needs the current password
	if _, err := s2.SetMaster("nope nope", "Another pass 2"); err == nil {
		t.Fatal("changed without the current password")
	}
	if _, err := s2.SetMaster("Correct horse 1", "Another pass 2"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := unlockMaster(dir, "Correct horse 1"); err == nil {
		t.Fatal("old password still works")
	}
	if _, _, err := unlockMaster(dir, rec); err == nil {
		t.Fatal("old recovery code still works")
	}
	// turning it off brings key.bin back
	if err := s2.RemoveMaster("wrong"); err == nil {
		t.Fatal("removed without the password")
	}
	if err := s2.RemoveMaster("Another pass 2"); err != nil {
		t.Fatal(err)
	}
	if hasMaster(dir) {
		t.Fatal("key.master left behind")
	}
	if s3, err := OpenStore(dir); err != nil || len(s3.Entries()) != 1 {
		t.Fatalf("open after removing: %v", err)
	}
}

func gateCall(t *testing.T, h http.Handler, a *App, body any) (int, map[string]any) {
	b, _ := json.Marshal(body)
	r := httptest.NewRequest("POST", "http://"+a.addr+"/api/gate", bytes.NewReader(b))
	r.AddCookie(&http.Cookie{Name: a.cookieName(), Value: a.token})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

func TestGate(t *testing.T) {
	dir := t.TempDir()
	s, _ := OpenStore(dir)
	rec, _ := s.SetMaster("", "Correct horse 1")
	s.Flush()

	oldSalt, oldCheck := accessSalt, accessCheck
	defer func() { accessSalt, accessCheck = oldSalt, oldCheck }()
	accessSalt = "00112233445566778899aabbccddeeff"
	sum := sha256Hex(accessProof("Team pass 99"))
	accessCheck = sum

	a := &App{dataDir: dir, token: "tok", lockPath: filepath.Join(dir, "pin-lock.json"), addr: "127.0.0.1:1"}
	opened := 0
	h := a.gateRoutes(func(key []byte) error {
		if _, err := OpenStoreKey(dir, key); err != nil {
			return err
		}
		opened++
		return nil
	})
	if a.accessOK() {
		t.Fatal("access OK before the password")
	}
	if code, out := gateCall(t, h, a, map[string]string{"access": "guess", "password": "Correct horse 1"}); code != 403 || out["field"] != "access" {
		t.Fatalf("wrong access password: %d %v", code, out)
	}
	if code, out := gateCall(t, h, a, map[string]string{"access": "Team pass 99", "password": "bad"}); code != 403 || out["field"] != "password" {
		t.Fatalf("wrong master: %d %v", code, out)
	}
	if !a.accessOK() {
		t.Fatal("access password not remembered")
	}
	if b, _ := os.ReadFile(a.accessFile()); strings.Contains(string(b), "Team pass") {
		t.Fatal("access password saved in clear")
	}
	if code, out := gateCall(t, h, a, map[string]string{"password": "Correct horse 1"}); code != 200 || opened != 1 {
		t.Fatalf("right master: %d %v", code, out)
	}
	// the recovery code asks for a new password, then gives a new code
	if _, out := gateCall(t, h, a, map[string]string{"password": rec}); out["need_new"] != true {
		t.Fatalf("recovery: %v", out)
	}
	_, out := gateCall(t, h, a, map[string]string{"password": rec, "newpassword": "Brand new 77"})
	if out["ok"] != true || out["recovery"] == "" || out["recovery"] == rec {
		t.Fatalf("new password: %v", out)
	}
	if _, _, err := unlockMaster(dir, "Brand new 77"); err != nil {
		t.Fatal("new password doesn't work")
	}
}

func TestMasterAskedOncePerVersion(t *testing.T) {
	dir := t.TempDir()
	s, _ := OpenStore(dir)
	old := version
	defer func() { version = old }()
	version = "v1.9.4"
	if _, err := s.SetMaster("", "Correct horse 1"); err != nil {
		t.Fatal(err)
	}
	if k := cachedKey(dir); k == nil || string(k) != string(s.key) {
		t.Fatal("same version should open without the password")
	}
	version = "v1.9.5"
	if cachedKey(dir) != nil {
		t.Fatal("a new version must ask for the password")
	}
	if err := s.RemoveMaster("Correct horse 1"); err != nil || fileExists(cachePath(dir)) {
		t.Fatalf("turning off should remove key.cache: %v", err)
	}
}
