package main

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPINLock(t *testing.T) {
	a := &App{lockPath: filepath.Join(t.TempDir(), "pin-lock.json")}
	if _, err := a.setPIN("12a4", 10, ""); err == nil {
		t.Fatal("letters accepted in a PIN")
	}
	rec, err := a.setPIN("2468", 10, "")
	if err != nil || len(rec) != 14 {
		t.Fatalf("set: %q %v", rec, err)
	}
	a.setLocked(true)
	if !a.isLocked() || a.lockAllowed("/api/entries") || !a.lockAllowed("/api/lock/unlock") || !a.lockAllowed("/app.js") {
		t.Fatal("lock rules")
	}
	post := func(h http.HandlerFunc, body string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		h(w, httptest.NewRequest("POST", "/", strings.NewReader(body)))
		return w
	}
	if w := post(a.handleUnlock, `{"pin":"1111"}`); w.Code != 403 || !a.isLocked() {
		t.Fatalf("wrong PIN unlocked: %d", w.Code)
	}
	if w := post(a.handleUnlock, `{"pin":"2468"}`); w.Code != 200 || a.isLocked() {
		t.Fatalf("right PIN: %d %s", w.Code, w.Body)
	}
	// Change needs the current PIN.
	if w := post(a.handleLockSet, `{"current":"0000","pin":"1357","minutes":5}`); w.Code != 403 {
		t.Fatalf("change without current PIN: %d", w.Code)
	}
	if w := post(a.handleLockSet, `{"current":"2468","pin":"1357","minutes":5}`); w.Code != 200 || !strings.Contains(w.Body.String(), "recovery") {
		t.Fatalf("change: %d %s", w.Code, w.Body)
	}
	// Forgot PIN: the old recovery code no longer works, the new one does.
	a.setLocked(true)
	if w := post(a.handleLockRecover, `{"code":"`+rec+`","pin":"9999"}`); w.Code != 403 {
		t.Fatalf("old recovery code accepted: %d", w.Code)
	}
	c, _ := a.lockConf()
	rec2, _ := a.setPIN("1357", c.Minutes, "") // fresh code to test with
	if w := post(a.handleLockRecover, `{"code":"`+strings.ToLower(strings.ReplaceAll(rec2, "-", " "))+`","pin":"8642"}`); w.Code != 200 || a.isLocked() {
		t.Fatalf("recover: %d %s", w.Code, w.Body)
	}
	if w := post(a.handleUnlock, `{"pin":"8642"}`); w.Code != 200 {
		t.Fatal("new PIN after recovery")
	}
	// Guessing slows down.
	a.setLocked(true)
	for range 6 {
		post(a.handleUnlock, `{"pin":"0000"}`)
	}
	if w := post(a.handleUnlock, `{"pin":"8642"}`); w.Code != 403 || !strings.Contains(w.Body.String(), "wait") {
		t.Fatalf("no wait after many wrong tries: %d %s", w.Code, w.Body)
	}
}

func TestPINEmailCode(t *testing.T) {
	a := &App{lockPath: filepath.Join(t.TempDir(), "pin-lock.json")}
	a.setPIN("2468", 10, "someone@example.com")
	if m := maskEmail("someone@example.com"); m != "s******@example.com" {
		t.Fatalf("mask: %s", m)
	}
	// Simulate a sent code (sending needs Outlook).
	a.lock.mailSalt = newSalt()
	a.lock.mailHash, a.lock.mailTill = pinHash(a.lock.mailSalt, "123456"), time.Now().Add(time.Minute)
	a.setLocked(true)
	post := func(body string) int {
		w := httptest.NewRecorder()
		a.handleLockRecover(w, httptest.NewRequest("POST", "/", strings.NewReader(body)))
		return w.Code
	}
	if post(`{"via":"email","code":"000000","pin":"1111"}`) != 403 {
		t.Fatal("wrong emailed code accepted")
	}
	if post(`{"via":"email","code":"123456","pin":"1111"}`) != 200 || a.isLocked() {
		t.Fatal("emailed code refused")
	}
	if c, _ := a.lockConf(); c.Email != "someone@example.com" || !checkHash(c.Salt, c.Hash, "1111") {
		t.Fatalf("after reset: %+v", c)
	}
	if post(`{"via":"email","code":"123456","pin":"2222"}`) != 403 {
		t.Fatal("emailed code worked twice")
	}
}
