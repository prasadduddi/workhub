package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"
)

const maxEditFile = 10 << 20

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, err error) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
}

func readJSON(r *http.Request, v any) error {
	return json.NewDecoder(http.MaxBytesReader(nil, r.Body, 20<<20)).Decode(v)
}

// ---- misc ----

func (a *App) handleVersion(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]any{"v": a.store.Version(), "data_dir": a.dataDir, "app_version": version, "desktop": isDesktop})
}

// handleImport merges an old data folder chosen with the folder picker.
func (a *App) handleImport(w http.ResponseWriter, r *http.Request) {
	p, ok, err := pickFolder(a.store.LocalDir())
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	if !ok {
		writeJSON(w, map[string]any{"cancelled": true})
		return
	}
	if _, err := os.Stat(filepath.Join(p, "workhub.dat")); err != nil {
		if sub := filepath.Join(p, "workhub-data"); fileExists(filepath.Join(sub, "workhub.dat")) {
			p = sub
		} else {
			writeErr(w, 400, errors.New("no WorkHub data in that folder; pick the workhub-data folder"))
			return
		}
	}
	if filepath.Clean(p) == filepath.Clean(a.dataDir) {
		writeErr(w, 400, errors.New("that is the folder already in use"))
		return
	}
	st, err := readDataFolder(p)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	e, n := a.store.Merge(st)
	writeJSON(w, map[string]any{"entries": e, "notes": n, "from": p})
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func (a *App) handleQuit(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]bool{"ok": true})
	go func() {
		time.Sleep(300 * time.Millisecond)
		a.shutdown()
	}()
}

func (a *App) handleGetSettings(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, a.store.Settings())
}

func (a *App) handlePutSettings(w http.ResponseWriter, r *http.Request) {
	var s Settings
	if err := readJSON(r, &s); err != nil {
		writeErr(w, 400, err)
		return
	}
	a.store.SetSettings(s)
	writeJSON(w, a.store.Settings())
}

// ---- entries ----

func (a *App) handleListEntries(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, a.store.Entries())
}

func (a *App) handleSaveEntry(w http.ResponseWriter, r *http.Request) {
	var in EntryInput
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	v, err := a.store.SaveEntry(in)
	if err != nil {
		writeErr(w, 404, err)
		return
	}
	writeJSON(w, v)
}

func (a *App) handleDeleteEntry(w http.ResponseWriter, r *http.Request) {
	a.store.DeleteEntry(r.PathValue("id"))
	writeJSON(w, map[string]bool{"ok": true})
}

func (a *App) handleBulk(w http.ResponseWriter, r *http.Request) {
	var in struct {
		IDs   []string `json:"ids"`
		Op    string   `json:"op"`
		Value string   `json:"value"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	n, err := a.store.Bulk(in.IDs, in.Op, in.Value)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	writeJSON(w, map[string]int{"changed": n})
}

func (a *App) handleHide(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Hidden bool `json:"hidden"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	a.store.SetHidden(r.PathValue("id"), in.Hidden)
	writeJSON(w, map[string]bool{"ok": true})
}

func (a *App) handleSecret(w http.ResponseWriter, r *http.Request) {
	e, ok := a.store.Entry(r.PathValue("id"))
	if !ok {
		writeErr(w, 404, errors.New("not found"))
		return
	}
	writeJSON(w, map[string]any{"password": e.Password, "previous": e.PrevPasswords})
}

func (a *App) handleRenameProject(w http.ResponseWriter, r *http.Request) {
	var in struct{ From, To string }
	if err := readJSON(r, &in); err != nil || strings.TrimSpace(in.To) == "" {
		writeErr(w, 400, errors.New("new project name required"))
		return
	}
	a.store.RenameProject(in.From, strings.TrimSpace(in.To))
	writeJSON(w, map[string]bool{"ok": true})
}

// ---- capture ----

func (a *App) handleIngest(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Text    string `json:"text"`
		Source  string `json:"source"`
		Project string `json:"project"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	if strings.TrimSpace(in.Text) == "" {
		writeErr(w, 400, errors.New("nothing to capture"))
		return
	}
	clip, entries := a.store.Ingest(in.Text, orDefault(in.Source, "paste"), in.Project)
	writeJSON(w, map[string]any{"clip": clip != nil, "entries": entries})
}

// handleParse extracts connection details without saving anything; the chat
// panel uses it to propose a connection the user confirms first.
func (a *App) handleParse(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Text string `json:"text"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	type proposal struct {
		Finding
		ExistingID string `json:"existing_id,omitempty"`
	}
	out := []proposal{}
	for _, f := range Parse(in.Text) {
		out = append(out, proposal{Finding: f, ExistingID: a.store.FindEntry(f)})
	}
	writeJSON(w, out)
}

func (a *App) handleListClips(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, a.store.Clips(300))
}

func (a *App) handleDeleteClip(w http.ResponseWriter, r *http.Request) {
	a.store.DeleteClip(r.PathValue("id"))
	writeJSON(w, map[string]bool{"ok": true})
}

// ---- notes and local files ----

func (a *App) handleListNotes(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, a.store.Notes())
}

func (a *App) handleSaveNote(w http.ResponseWriter, r *http.Request) {
	var n Note
	if err := readJSON(r, &n); err != nil {
		writeErr(w, 400, err)
		return
	}
	writeJSON(w, a.store.SaveNote(n))
}

func (a *App) handleDeleteNote(w http.ResponseWriter, r *http.Request) {
	a.store.DeleteNote(r.PathValue("id"))
	writeJSON(w, map[string]bool{"ok": true})
}

// expandPath accepts pasted paths: surrounding quotes and a leading ~.
func expandPath(p string) string {
	p = strings.Trim(strings.TrimSpace(p), `"'`)
	if p == "~" || strings.HasPrefix(p, "~/") || strings.HasPrefix(p, `~\`) {
		home, _ := os.UserHomeDir()
		p = filepath.Join(home, p[1:])
	}
	return filepath.Clean(p)
}

// handlePickFile shows the system "Open" window, starting in the folder of
// the last opened file (or the last This PC folder).
func (a *App) handlePickFile(w http.ResponseWriter, r *http.Request) {
	start := a.store.LocalDir()
	if rec := a.store.Recent(); len(rec) > 0 {
		start = filepath.Dir(rec[0].Path)
	}
	p, ok, err := pickFile(start)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	writeJSON(w, map[string]any{"path": p, "ok": ok})
}

func (a *App) handleReadFile(w http.ResponseWriter, r *http.Request) {
	p := expandPath(r.URL.Query().Get("path"))
	st, err := os.Stat(p)
	if err != nil {
		writeErr(w, 404, fmt.Errorf("cannot open %s: file not found or not accessible", p))
		return
	}
	if st.IsDir() {
		writeErr(w, 400, errors.New("that is a folder"))
		return
	}
	if st.Size() > maxEditFile {
		writeErr(w, 400, fmt.Errorf("file is %d MB; the editor opens files up to 10 MB", st.Size()>>20))
		return
	}
	b, err := os.ReadFile(p)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	if bytes.IndexByte(b, 0) >= 0 || !utf8.Valid(b) {
		writeErr(w, 400, errors.New("binary or non-UTF-8 file; not opened to avoid corrupting it"))
		return
	}
	a.store.AddRecent(p)
	writeJSON(w, map[string]any{"path": p, "content": string(b), "mtime": st.ModTime()})
}

// handleWriteFile saves a local file. The first save of each file per run
// keeps a copy of the original in workhub-data/backups.
func (a *App) handleWriteFile(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	p := filepath.Clean(in.Path)
	if !filepath.IsAbs(p) {
		writeErr(w, 400, errors.New("use a full path, e.g. C:\\work\\notes.txt"))
		return
	}
	mode := os.FileMode(0o644)
	if st, err := os.Stat(p); err == nil {
		mode = st.Mode().Perm()
		a.backupMu.Lock()
		if !a.backedUp[p] {
			dir := filepath.Join(a.dataDir, "backups")
			_ = os.MkdirAll(dir, 0o700)
			name := fmt.Sprintf("%s.%s.bak", filepath.Base(p), time.Now().Format("20060102-150405"))
			if err := copyFile(p, filepath.Join(dir, name)); err == nil {
				a.backedUp[p] = true
			}
		}
		a.backupMu.Unlock()
	}
	if err := os.WriteFile(p, []byte(in.Content), mode); err != nil {
		writeErr(w, 500, err)
		return
	}
	a.store.AddRecent(p)
	writeJSON(w, map[string]any{"ok": true, "saved": time.Now()})
}

func (a *App) handleRecent(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, a.store.Recent())
}
