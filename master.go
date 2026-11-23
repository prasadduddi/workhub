package main

// Master password: when one is set, the key that encrypts workhub.dat is no
// longer kept in key.bin (which only needs the Windows login) but in
// key.master, sealed with a key made from the master password, and a second
// time with a one-time recovery code. WorkHub then can't open the data until
// the password (or the code) is typed, so a copied data folder is useless and
// deleting a file can't get round it. Nothing about the password is stored.

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"
)

const masterIter = 600_000

var (
	errMasterNeeded = errors.New("the master password is needed")
	errBadMaster    = errors.New("wrong master password")
	errBadRecovery  = errors.New("wrong recovery code")
)

type masterFile struct {
	V       int    `json:"v"`
	Iter    int    `json:"iter"`
	Salt    string `json:"salt"`
	Key     string `json:"key"` // the data key sealed with the password
	RecSalt string `json:"rec_salt"`
	RecKey  string `json:"rec_key"` // ... and with the recovery code
}

func masterPath(dir string) string { return filepath.Join(dir, "key.master") }

func hasMaster(dir string) bool { return fileExists(masterPath(dir)) }

func checkMasterPassword(pw string) error {
	if utf8.RuneCountInString(pw) < 8 {
		return errors.New("the master password must be at least 8 characters")
	}
	return nil
}

func passKey(pw, saltHex string, iter int) []byte {
	salt, _ := hex.DecodeString(saltHex)
	k, _ := pbkdf2.Key(sha256.New, pw, salt, iter, 32)
	return k
}

func sealKey(kek, key []byte) string {
	block, _ := aes.NewCipher(kek)
	gcm, _ := cipher.NewGCM(block)
	nonce := make([]byte, gcm.NonceSize())
	rand.Read(nonce)
	return hex.EncodeToString(gcm.Seal(nonce, nonce, key, nil))
}

func openKey(kek []byte, sealed string) ([]byte, bool) {
	b, err := hex.DecodeString(sealed)
	block, _ := aes.NewCipher(kek)
	gcm, _ := cipher.NewGCM(block)
	if err != nil || len(b) < gcm.NonceSize() {
		return nil, false
	}
	k, err := gcm.Open(nil, b[:gcm.NonceSize()], b[gcm.NonceSize():], nil)
	return k, err == nil
}

func readMaster(dir string) (masterFile, error) {
	var m masterFile
	raw, err := os.ReadFile(masterPath(dir))
	if err != nil {
		return m, err
	}
	if raw, err = unprotectKey(raw); err != nil { // also tied to the Windows user, like key.bin
		return m, errors.New("key.master belongs to another Windows user or PC")
	}
	if err := json.Unmarshal(raw, &m); err != nil || m.Key == "" {
		return m, errors.New("key.master is damaged")
	}
	return m, nil
}

// unlockMaster returns the data key for a password or, failing that, for a
// recovery code (usedRecovery tells which).
func unlockMaster(dir, secret string) (key []byte, usedRecovery bool, err error) {
	if secret == "" {
		return nil, false, errMasterNeeded
	}
	m, err := readMaster(dir)
	if err != nil {
		return nil, false, err
	}
	if k, ok := openKey(passKey(secret, m.Salt, m.Iter), m.Key); ok {
		return k, false, nil
	}
	if k, ok := openKey(passKey(normRecovery(secret), m.RecSalt, m.Iter), m.RecKey); ok {
		return k, true, nil
	}
	return nil, false, errBadMaster
}

// writeMaster seals key with pw and a new recovery code (returned once).
func writeMaster(dir string, key []byte, pw string) (string, error) {
	rec := newRecoveryCode()
	m := masterFile{V: 1, Iter: masterIter, Salt: newSalt(), RecSalt: newSalt()}
	m.Key = sealKey(passKey(pw, m.Salt, m.Iter), key)
	m.RecKey = sealKey(passKey(normRecovery(rec), m.RecSalt, m.Iter), key)
	b, _ := json.Marshal(m)
	prot, err := protectKey(b)
	if err != nil {
		return "", err
	}
	return rec, writeAtomic(masterPath(dir), prot)
}

// SetMaster turns the master password on, or changes it (current is then
// required). key.bin is removed once key.master is safely written.
func (s *Store) SetMaster(current, pw string) (string, error) {
	if err := checkMasterPassword(pw); err != nil {
		return "", err
	}
	dir := filepath.Dir(s.path)
	if hasMaster(dir) {
		if k, _, err := unlockMaster(dir, current); err != nil || string(k) != string(s.key) {
			return "", errBadMaster
		}
	}
	rec, err := writeMaster(dir, s.key, pw)
	if err != nil {
		return "", err
	}
	if err := os.Remove(filepath.Join(dir, "key.bin")); err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	return rec, nil
}

// RemoveMaster goes back to the Windows-login key (key.bin).
func (s *Store) RemoveMaster(current string) error {
	dir := filepath.Dir(s.path)
	if k, _, err := unlockMaster(dir, current); err != nil || string(k) != string(s.key) {
		return errBadMaster
	}
	prot, err := protectKey(s.key)
	if err != nil {
		return err
	}
	if err := writeAtomic(filepath.Join(dir, "key.bin"), prot); err != nil {
		return err
	}
	return os.Remove(masterPath(dir))
}

func (a *App) handleMasterGet(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]bool{"on": hasMaster(a.dataDir)})
}

func (a *App) handleMasterSet(w http.ResponseWriter, r *http.Request) {
	var in struct{ Current, Password string }
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	rec, err := a.store.SetMaster(in.Current, in.Password)
	if err != nil {
		time.Sleep(700 * time.Millisecond)
		writeErr(w, 400, err)
		return
	}
	writeJSON(w, map[string]string{"recovery": rec})
}

func (a *App) handleMasterRemove(w http.ResponseWriter, r *http.Request) {
	var in struct{ Current string }
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	if err := a.store.RemoveMaster(strings.TrimRight(in.Current, "\r\n")); err != nil {
		time.Sleep(700 * time.Millisecond)
		writeErr(w, 400, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}
