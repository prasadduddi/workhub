package main

// PIN lock: WorkHub locks itself after some minutes without use (and when it
// starts, or on "Lock now"). While locked the API answers 423 to everything
// except the lock endpoints, so nothing can be read until the PIN is typed.
// The PIN and a one-time recovery code (for "Forgot PIN") are kept only as
// salted PBKDF2 hashes, shared by all workspaces, next to the default data
// folder.

import (
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

type lockConf struct {
	Salt    string `json:"salt"`
	Hash    string `json:"hash"`
	RecSalt string `json:"rec_salt"`
	RecHash string `json:"rec_hash"`
	Minutes int    `json:"minutes"` // lock after this many idle minutes; 0 = only on start-up and "Lock now"
}

type lockState struct {
	mu       sync.Mutex
	locked   bool
	fails    int
	waitTill time.Time
}

var rePIN = regexp.MustCompile(`^\d{4,8}$`)

func (a *App) lockFile() string {
	if a.lockPath != "" {
		return a.lockPath
	}
	return filepath.Join(filepath.Dir(defaultDataDir()), "pin-lock.json")
}

func (a *App) lockConf() (lockConf, bool) {
	var c lockConf
	b, err := os.ReadFile(a.lockFile())
	if err != nil || json.Unmarshal(b, &c) != nil || c.Hash == "" {
		return lockConf{}, false
	}
	return c, true
}

func (a *App) saveLockConf(c *lockConf) error {
	if c == nil {
		err := os.Remove(a.lockFile())
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	b, _ := json.MarshalIndent(c, "", "  ")
	_ = os.MkdirAll(filepath.Dir(a.lockFile()), 0o700)
	return writeAtomic(a.lockFile(), b)
}

func pinHash(salt, pin string) string {
	s, _ := hex.DecodeString(salt)
	k, _ := pbkdf2.Key(sha256.New, pin, s, 200_000, 32)
	return hex.EncodeToString(k)
}

func newSalt() string { b := make([]byte, 16); rand.Read(b); return hex.EncodeToString(b) }

func checkHash(salt, hash, pin string) bool {
	return hash != "" && subtle.ConstantTimeCompare([]byte(pinHash(salt, pin)), []byte(hash)) == 1
}

// newRecoveryCode: 12 letters/digits in groups of four, easy to write down.
func newRecoveryCode() string {
	const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	b := make([]byte, 12)
	rand.Read(b)
	var sb strings.Builder
	for i, x := range b {
		if i > 0 && i%4 == 0 {
			sb.WriteByte('-')
		}
		sb.WriteByte(abc[int(x)%len(abc)])
	}
	return sb.String()
}

func normRecovery(s string) string {
	return strings.ToUpper(strings.NewReplacer("-", "", " ", "").Replace(strings.TrimSpace(s)))
}

// setPIN stores a new PIN and a new recovery code, which is returned once.
func (a *App) setPIN(pin string, minutes int) (string, error) {
	if !rePIN.MatchString(pin) {
		return "", errors.New("the PIN must be 4 to 8 digits")
	}
	rec := newRecoveryCode()
	c := lockConf{Salt: newSalt(), RecSalt: newSalt(), Minutes: minutes}
	c.Hash, c.RecHash = pinHash(c.Salt, pin), pinHash(c.RecSalt, normRecovery(rec))
	return rec, a.saveLockConf(&c)
}

// isLocked is checked for every API call.
func (a *App) isLocked() bool {
	a.lock.mu.Lock()
	defer a.lock.mu.Unlock()
	return a.lock.locked
}

func (a *App) setLocked(v bool) {
	a.lock.mu.Lock()
	a.lock.locked = v
	a.lock.mu.Unlock()
}

// tryUnlock checks a PIN or recovery code, slowing down guessing: after 5
// wrong tries each further try waits 30 s more (up to 10 minutes).
func (a *App) tryCode(check func(lockConf) bool) error {
	a.lock.mu.Lock()
	defer a.lock.mu.Unlock()
	if wait := time.Until(a.lock.waitTill); wait > 0 {
		return fmt.Errorf("too many wrong tries — wait %d seconds", int(wait.Seconds())+1)
	}
	c, ok := a.lockConf()
	if !ok {
		a.lock.locked = false
		return nil
	}
	if !check(c) {
		a.lock.fails++
		if a.lock.fails >= 5 {
			a.lock.waitTill = time.Now().Add(min(time.Duration(a.lock.fails-4)*30*time.Second, 10*time.Minute))
		}
		return errors.New("wrong PIN")
	}
	a.lock.fails, a.lock.locked = 0, false
	return nil
}

func (a *App) lockAllowed(path string) bool {
	return strings.HasPrefix(path, "/api/lock") || path == "/api/version" || !strings.HasPrefix(path, "/api/")
}

func (a *App) handleLockStatus(w http.ResponseWriter, r *http.Request) {
	c, ok := a.lockConf()
	writeJSON(w, map[string]any{"enabled": ok, "locked": a.isLocked(), "minutes": c.Minutes, "file": a.lockFile()})
}

func (a *App) handleLockNow(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.lockConf(); !ok {
		writeErr(w, 400, errors.New("set a PIN first"))
		return
	}
	a.setLocked(true)
	writeJSON(w, map[string]bool{"locked": true})
}

func (a *App) handleUnlock(w http.ResponseWriter, r *http.Request) {
	var in struct {
		PIN string `json:"pin"`
	}
	_ = readJSON(r, &in)
	if err := a.tryCode(func(c lockConf) bool { return checkHash(c.Salt, c.Hash, strings.TrimSpace(in.PIN)) }); err != nil {
		writeErr(w, 403, err)
		return
	}
	writeJSON(w, map[string]bool{"locked": false})
}

// handleLockSet sets, changes or removes the PIN, or changes the minutes.
// Changing or removing needs the current PIN.
func (a *App) handleLockSet(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Current string `json:"current"`
		PIN     string `json:"pin"`
		Minutes int    `json:"minutes"`
		Remove  bool   `json:"remove"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	if c, ok := a.lockConf(); ok {
		if err := a.tryCode(func(c lockConf) bool { return checkHash(c.Salt, c.Hash, strings.TrimSpace(in.Current)) }); err != nil {
			writeErr(w, 403, errors.New("the current PIN is wrong"))
			return
		}
		switch {
		case in.Remove:
			if err := a.saveLockConf(nil); err != nil {
				writeErr(w, 500, err)
				return
			}
			writeJSON(w, map[string]any{"enabled": false})
			return
		case in.PIN == "": // only the minutes
			c.Minutes = in.Minutes
			if err := a.saveLockConf(&c); err != nil {
				writeErr(w, 500, err)
				return
			}
			writeJSON(w, map[string]any{"enabled": true, "minutes": c.Minutes})
			return
		}
	}
	rec, err := a.setPIN(strings.TrimSpace(in.PIN), in.Minutes)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	writeJSON(w, map[string]any{"enabled": true, "minutes": in.Minutes, "recovery": rec})
}

// handleLockRecover: "Forgot PIN" — the recovery code sets a new PIN (and a
// new recovery code, since the old one has been used).
func (a *App) handleLockRecover(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Code string `json:"code"`
		PIN  string `json:"pin"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	if !rePIN.MatchString(strings.TrimSpace(in.PIN)) {
		writeErr(w, 400, errors.New("the new PIN must be 4 to 8 digits"))
		return
	}
	c, _ := a.lockConf()
	if err := a.tryCode(func(c lockConf) bool { return checkHash(c.RecSalt, c.RecHash, normRecovery(in.Code)) }); err != nil {
		writeErr(w, 403, errors.New(strings.Replace(err.Error(), "wrong PIN", "wrong recovery code", 1)))
		return
	}
	rec, err := a.setPIN(strings.TrimSpace(in.PIN), c.Minutes)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, map[string]any{"locked": false, "recovery": rec})
}
