package main

// Browse… buttons remember their folder: each button (FTP's This PC, Git add,
// backup copy, Folders links, compare…) opens the picker where you last chose
// with that button; the first time at C:\ (the home folder elsewhere).

import (
	"net/http"
	"os"
	"path/filepath"
	"runtime"
)

var ( // the system dialogs (stubbed in tests)
	pickFolderFn = pickFolder
	pickFileFn   = pickFile
)

func defaultPickDir() string {
	if runtime.GOOS == "windows" {
		return `C:\`
	}
	home, _ := os.UserHomeDir()
	return home
}

func (s *Store) lastPick(key string) string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	d := s.st.PickDirs[orDefault(key, "default")]
	if st, err := os.Stat(d); d == "" || err != nil || !st.IsDir() { // gone (a USB stick, a deleted folder): the default
		return ""
	}
	return d
}

func (s *Store) setPick(key, dir string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.st.PickDirs == nil {
		s.st.PickDirs = map[string]string{}
	}
	s.st.PickDirs[orDefault(key, "default")] = dir
	s.changed()
}

// handleLocalPick: POST /api/local/pick {key, start}: a folder. start (a path typed next to the button) wins.
func (a *App) handleLocalPick(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Start string `json:"start"`
		Key   string `json:"key"`
	}
	_ = readJSON(r, &in)
	start := orDefault(orDefault(in.Start, a.store.lastPick(in.Key)), defaultPickDir())
	p, ok, err := pickFolderFn(start)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	if ok && p != "" {
		a.store.setPick(in.Key, p)
	}
	writeJSON(w, map[string]any{"path": p, "ok": ok})
}

// handlePickFile: POST /api/local/pickfile {key}: a file; its folder is remembered.
func (a *App) handlePickFile(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Key string `json:"key"`
	}
	_ = readJSON(r, &in)
	p, ok, err := pickFileFn(orDefault(a.store.lastPick(in.Key), defaultPickDir()))
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	if ok && p != "" {
		a.store.setPick(in.Key, filepath.Dir(p))
	}
	writeJSON(w, map[string]any{"path": p, "ok": ok})
}
