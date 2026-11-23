package main

// Automatic backups: a zip of the whole data folder, made when WorkHub starts
// and every morning — only if something changed since the last one. They go
// next to the data folder (<data>-backups), so losing the data folder doesn't
// lose them, and the newest 30 are kept. Each can also be copied to a second
// folder, such as OneDrive (Settings.BackupCopy), where the newest 30 are
// kept too. Restoring: quit WorkHub, unzip one into an empty folder and
// choose it with "Data location…".

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	backupKeep    = 30
	backupMorning = 7 // hour after which the daily backup is made
)

var (
	backupMu      sync.Mutex
	backupCopyErr string // why the last copy to the second folder failed
	backupCopyAt  time.Time
)

func (a *App) backupDir() string {
	return filepath.Join(filepath.Dir(a.dataDir), filepath.Base(a.dataDir)+"-backups")
}

// backupSkip: files that are not data (or are other backups).
func backupSkip(rel string, d fs.DirEntry) bool {
	n := d.Name()
	if d.IsDir() {
		return n == "webview2" || strings.HasSuffix(n, "-backups")
	}
	return n == "session.token" || strings.HasSuffix(n, ".tmp") || strings.HasSuffix(n, ".wh-tmp") || strings.HasPrefix(n, "~$")
}

// dataFingerprint changes whenever any data file changes.
func (a *App) dataFingerprint() string {
	h := sha256.New()
	_ = filepath.WalkDir(a.dataDir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || p == a.dataDir {
			return nil
		}
		rel, _ := filepath.Rel(a.dataDir, p)
		if backupSkip(rel, d) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if info, err := d.Info(); err == nil && !d.IsDir() {
			fmt.Fprintf(h, "%s|%d|%d\n", filepath.ToSlash(rel), info.Size(), info.ModTime().UnixNano())
		}
		return nil
	})
	return hex.EncodeToString(h.Sum(nil))
}

type backupInfo struct {
	Name string    `json:"name"`
	Size int64     `json:"size"`
	When time.Time `json:"when"`
}

func (a *App) backups() []backupInfo {
	ents, _ := os.ReadDir(a.backupDir())
	out := []backupInfo{}
	for _, e := range ents {
		if e.IsDir() || !strings.HasPrefix(e.Name(), "WorkHub-backup-") || !strings.HasSuffix(e.Name(), ".zip") {
			continue
		}
		if info, err := e.Info(); err == nil {
			out = append(out, backupInfo{e.Name(), info.Size(), info.ModTime()})
		}
	}
	sort.Slice(out, func(i, j int) bool { // newest first
		if !out[i].When.Equal(out[j].When) {
			return out[i].When.After(out[j].When)
		}
		return out[i].Name > out[j].Name
	})
	return out
}

// backup makes a zip if the data changed (or force). Returns the file name,
// or "" when nothing changed.
func (a *App) backup(force bool) (string, error) {
	backupMu.Lock()
	defer backupMu.Unlock()
	dir := a.backupDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	fp := a.dataFingerprint()
	last, _ := os.ReadFile(filepath.Join(dir, "last-fingerprint.txt"))
	if !force && strings.TrimSpace(string(last)) == fp {
		return "", nil
	}
	if a.store != nil {
		a.store.Flush() // what's on screen is on disk
		fp = a.dataFingerprint()
	}
	name := "WorkHub-backup-" + time.Now().Format("2006-01-02-1504") + ".zip"
	path := uniqueName(filepath.Join(dir, name))
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return "", err
	}
	zw := zip.NewWriter(f)
	werr := filepath.WalkDir(a.dataDir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || p == a.dataDir {
			return nil
		}
		rel, _ := filepath.Rel(a.dataDir, p)
		if backupSkip(rel, d) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		hdr, _ := zip.FileInfoHeader(info)
		hdr.Name, hdr.Method = filepath.ToSlash(rel), zip.Deflate
		w, err := zw.CreateHeader(hdr)
		if err != nil {
			return err
		}
		src, err := os.Open(p)
		if err != nil {
			return nil // locked file: skip it rather than fail the backup
		}
		_, err = io.Copy(w, src)
		src.Close()
		return err
	})
	if err := zw.Close(); werr == nil {
		werr = err
	}
	if err := f.Close(); werr == nil {
		werr = err
	}
	if werr != nil {
		os.Remove(tmp)
		return "", werr
	}
	if err := os.Rename(tmp, path); err != nil {
		return "", err
	}
	_ = os.WriteFile(filepath.Join(dir, "last-fingerprint.txt"), []byte(fp+"\n"), 0o600)
	for _, old := range a.backups()[min(backupKeep, len(a.backups())):] {
		_ = os.Remove(filepath.Join(dir, old.Name))
	}
	a.copyBackup(path)
	return filepath.Base(path), nil
}

// copyBackup puts a backup in the second folder (e.g. OneDrive), if one is set,
// and keeps the newest backupKeep there.
func (a *App) copyBackup(path string) {
	if a.store == nil {
		return
	}
	to := strings.TrimSpace(a.store.Settings().BackupCopy)
	if to == "" {
		return
	}
	err := os.MkdirAll(to, 0o700)
	if err == nil {
		tmp := filepath.Join(to, filepath.Base(path)+".tmp")
		if err = copyFile(path, tmp); err == nil {
			err = os.Rename(tmp, filepath.Join(to, filepath.Base(path)))
		}
		if err != nil {
			os.Remove(tmp)
		}
	}
	backupCopyAt, backupCopyErr = time.Now(), ""
	if err != nil {
		backupCopyErr = err.Error()
		log.Println("backup copy:", err)
		return
	}
	ents, _ := os.ReadDir(to)
	var names []string
	for _, e := range ents {
		if !e.IsDir() && strings.HasPrefix(e.Name(), "WorkHub-backup-") && strings.HasSuffix(e.Name(), ".zip") {
			names = append(names, e.Name())
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(names))) // the names carry the date: newest first
	for _, n := range names[min(backupKeep, len(names)):] {
		_ = os.Remove(filepath.Join(to, n))
	}
}

// oneDriveDir suggests a folder in the user's OneDrive (work account first).
func oneDriveDir(workspace string) string {
	for _, v := range []string{"OneDriveCommercial", "OneDrive", "OneDriveConsumer"} {
		if d := os.Getenv(v); d != "" {
			if st, err := os.Stat(d); err == nil && st.IsDir() {
				name := "WorkHub backups"
				if workspace != "" {
					name += " - " + workspace
				}
				return filepath.Join(d, name)
			}
		}
	}
	return ""
}

// handleBackupCopy sets (or, with "", stops) the second backup folder and
// copies the latest backup there straight away.
func (a *App) handleBackupCopy(w http.ResponseWriter, r *http.Request) {
	var in struct{ Folder string }
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	st := a.store.Settings()
	st.BackupCopy = strings.TrimSpace(in.Folder)
	a.store.SetSettings(st)
	if st.BackupCopy != "" {
		if list := a.backups(); len(list) > 0 {
			backupMu.Lock()
			a.copyBackup(filepath.Join(a.backupDir(), list[0].Name))
			backupMu.Unlock()
		} else if _, err := a.backup(true); err != nil {
			writeErr(w, 500, err)
			return
		}
		if backupCopyErr != "" {
			writeErr(w, 500, fmt.Errorf("can't copy backups there: %s", backupCopyErr))
			return
		}
	}
	a.handleBackupsList(w, r)
}

// backupWatcher: one backup at start-up, then one each morning (the first
// check after 07:00), each only if something changed.
func (a *App) backupWatcher() {
	if n, err := a.backup(false); err != nil {
		log.Println("backup:", err)
	} else if n != "" {
		log.Println("backup:", n)
	}
	lastDay := time.Now().Format("2006-01-02")
	for range time.Tick(10 * time.Minute) {
		now := time.Now()
		if day := now.Format("2006-01-02"); day != lastDay && now.Hour() >= backupMorning {
			lastDay = day
			if _, err := a.backup(false); err != nil {
				log.Println("backup:", err)
			}
		}
	}
}

func (a *App) handleBackupsList(w http.ResponseWriter, r *http.Request) {
	out := map[string]any{"folder": a.backupDir(), "backups": a.backups(), "onedrive": oneDriveDir(a.workspace)}
	if a.store != nil {
		out["copy_to"] = a.store.Settings().BackupCopy
	}
	if !backupCopyAt.IsZero() {
		out["copy_at"], out["copy_error"] = backupCopyAt, backupCopyErr
	}
	writeJSON(w, out)
}

func (a *App) handleBackupNow(w http.ResponseWriter, r *http.Request) {
	n, err := a.backup(true)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, map[string]string{"name": n})
}

func (a *App) handleBackupReveal(w http.ResponseWriter, r *http.Request) {
	_ = os.MkdirAll(a.backupDir(), 0o700)
	openPath(a.backupDir())
	writeJSON(w, map[string]string{"folder": a.backupDir()})
}
