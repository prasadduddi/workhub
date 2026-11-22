package main

// Reference folders: a plain folder tree of files kept for reference (JSON,
// YAML, properties, schemas, scripts…). Everything is ordinary files in
// <data>/reference, so every WorkHub version — and Explorer — sees the same
// files, nothing depends on the app's own data format, and nothing is ever
// lost: overwritten files keep their old copies in <data>/reference-history
// and deleted ones move to <data>/reference-deleted.

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	refMaxFile     = 100 << 20 // per file
	refKeepHistory = 30        // old copies kept per file
)

func (a *App) refRoot() string    { return filepath.Join(a.dataDir, "reference") }
func (a *App) refHistory() string { return filepath.Join(a.dataDir, "reference-history") }
func (a *App) refDeleted() string { return filepath.Join(a.dataDir, "reference-deleted") }

var badNameChars = regexp.MustCompile(`[<>:"|?*\x00-\x1f]`)

// cleanRel turns a path from the page into a safe relative path ("a/b.json").
func cleanRel(p string) (string, error) {
	p = strings.ReplaceAll(strings.TrimSpace(p), `\`, "/")
	p = path.Clean("/" + p)[1:]
	if p == "" {
		return "", nil
	}
	for _, part := range strings.Split(p, "/") {
		part = strings.TrimSpace(part)
		if part == "" || part == "." || part == ".." || badNameChars.MatchString(part) || strings.HasSuffix(part, ".") {
			return "", fmt.Errorf("%q is not a valid name (no \\ / : * ? \" < > | characters)", part)
		}
	}
	return p, nil
}

func (a *App) refAbs(rel string) (string, string, error) {
	r, err := cleanRel(rel)
	if err != nil {
		return "", "", err
	}
	return r, filepath.Join(a.refRoot(), filepath.FromSlash(r)), nil
}

type RefItem struct {
	Path string    `json:"path"`
	Dir  bool      `json:"dir"`
	Size int64     `json:"size"`
	Mod  time.Time `json:"mod"`
}

// ensureReference creates the folder (with starter folders) and, once, copies
// the old Properties tree into it so nothing added there is lost.
func (a *App) ensureReference() {
	root := a.refRoot()
	if _, err := os.Stat(root); err == nil {
		return
	}
	_ = os.MkdirAll(root, 0o700)
	for _, n := range []string{"JSON", "YAML", "Properties"} {
		_ = os.MkdirAll(filepath.Join(root, n), 0o700)
	}
	if a.store != nil {
		a.exportProps(root)
	}
}

// exportProps writes every Properties node as a folder: its files (decrypted)
// and its instructions as "Instructions.txt". The old data is left in place.
func (a *App) exportProps(root string) {
	nodes := a.store.PropNodes()
	byID := map[string]PropNode{}
	for _, n := range nodes {
		byID[n.ID] = n
	}
	safe := func(s string) string {
		s = strings.TrimRight(strings.TrimSpace(badNameChars.ReplaceAllString(strings.NewReplacer("/", "-", `\`, "-").Replace(s), "_")), ".")
		if s == "" {
			s = "Untitled"
		}
		return s
	}
	for _, n := range nodes {
		var parts []string
		for x, ok := n, true; ok; x, ok = byID[x.ParentID] {
			parts = append([]string{safe(x.Name)}, parts...)
			if x.ParentID == "" {
				break
			}
		}
		dir := filepath.Join(append([]string{root, "From Properties"}, parts...)...)
		_ = os.MkdirAll(dir, 0o700)
		if strings.TrimSpace(n.Text) != "" {
			_ = os.WriteFile(uniqueName(filepath.Join(dir, "Instructions.txt")), []byte(n.Text), 0o600)
		}
		for _, f := range n.Files {
			if _, data, err := a.store.ReadAttachment(f.ID); err == nil {
				_ = os.WriteFile(uniqueName(filepath.Join(dir, safe(f.Name))), data, 0o600)
			}
		}
	}
}

// uniqueName returns p, or "name (2).ext" etc. if p exists.
func uniqueName(p string) string {
	if _, err := os.Stat(p); err != nil {
		return p
	}
	ext := filepath.Ext(p)
	base := strings.TrimSuffix(p, ext)
	for i := 2; ; i++ {
		c := fmt.Sprintf("%s (%d)%s", base, i, ext)
		if _, err := os.Stat(c); err != nil {
			return c
		}
	}
}

// keepOld copies an existing file into the history folder before it changes.
func (a *App) keepOld(rel, abs string) {
	data, err := os.ReadFile(abs)
	if err != nil {
		return
	}
	dir := filepath.Join(a.refHistory(), filepath.FromSlash(rel))
	if os.MkdirAll(dir, 0o700) != nil {
		return
	}
	_ = os.WriteFile(filepath.Join(dir, time.Now().Format("2006-01-02_150405.000")+filepath.Ext(abs)), data, 0o600)
	old, _ := os.ReadDir(dir)
	sort.Slice(old, func(i, j int) bool { return old[i].Name() < old[j].Name() })
	for len(old) > refKeepHistory {
		_ = os.Remove(filepath.Join(dir, old[0].Name()))
		old = old[1:]
	}
}

func writeAtomic(abs string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(abs), 0o700); err != nil {
		return err
	}
	tmp := abs + ".wh-tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	_ = os.Remove(abs) // Windows rename does not replace
	return os.Rename(tmp, abs)
}

// ---- HTTP ----

func (a *App) handleRefTree(w http.ResponseWriter, r *http.Request) {
	a.ensureReference()
	root := a.refRoot()
	out := []RefItem{}
	_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || p == root {
			return nil
		}
		if strings.HasSuffix(d.Name(), ".wh-tmp") {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		it := RefItem{Path: filepath.ToSlash(rel), Dir: d.IsDir()}
		if info, err := d.Info(); err == nil {
			it.Mod = info.ModTime()
			if !d.IsDir() {
				it.Size = info.Size()
			}
		}
		out = append(out, it)
		return nil
	})
	writeJSON(w, map[string]any{"root": root, "items": out})
}

func (a *App) handleRefFolder(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Path string `json:"path"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	rel, abs, err := a.refAbs(in.Path)
	if err == nil && rel == "" {
		err = errors.New("type a folder name")
	}
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	if err := os.MkdirAll(abs, 0o700); err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, map[string]string{"path": rel})
}

func (a *App) handleRefRead(w http.ResponseWriter, r *http.Request) {
	rel, abs, err := a.refAbs(r.URL.Query().Get("path"))
	if err != nil || rel == "" {
		writeErr(w, 400, errors.New("bad path"))
		return
	}
	f, err := os.Open(abs)
	if err != nil {
		writeErr(w, 404, errors.New("file not found"))
		return
	}
	defer f.Close()
	if r.URL.Query().Get("download") == "1" {
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", path.Base(rel)))
	}
	info, _ := f.Stat()
	http.ServeContent(w, r, path.Base(rel), info.ModTime(), f)
}

// handleRefWrite saves a file. ?new=1 (uploads, new files) never overwrites:
// it picks "name (2).ext" instead. Saving over a file keeps the old copy.
func (a *App) handleRefWrite(w http.ResponseWriter, r *http.Request) {
	rel, abs, err := a.refAbs(r.URL.Query().Get("path"))
	if err == nil && rel == "" {
		err = errors.New("missing file name")
	}
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, refMaxFile+1))
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	if len(data) > refMaxFile {
		writeErr(w, 413, errors.New("file is larger than 100 MB"))
		return
	}
	if st, err := os.Stat(abs); err == nil {
		if st.IsDir() {
			writeErr(w, 400, errors.New("a folder with that name exists"))
			return
		}
		if r.URL.Query().Get("new") == "1" {
			abs = uniqueName(abs)
			r2, _ := filepath.Rel(a.refRoot(), abs)
			rel = filepath.ToSlash(r2)
		} else {
			a.keepOld(rel, abs)
		}
	}
	if err := writeAtomic(abs, data); err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, map[string]any{"path": rel, "size": len(data)})
}

func (a *App) handleRefMove(w http.ResponseWriter, r *http.Request) {
	var in struct {
		From string `json:"from"`
		To   string `json:"to"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	fr, fa, err1 := a.refAbs(in.From)
	tr, ta, err2 := a.refAbs(in.To)
	if err := errors.Join(err1, err2); err != nil || fr == "" || tr == "" {
		writeErr(w, 400, errors.Join(err, errors.New("bad name")))
		return
	}
	if tr == fr || strings.HasPrefix(tr+"/", fr+"/") {
		writeErr(w, 400, errors.New("can't move a folder into itself"))
		return
	}
	if _, err := os.Stat(ta); err == nil && !strings.EqualFold(fr, tr) {
		writeErr(w, 409, fmt.Errorf("%s already exists", tr))
		return
	}
	_ = os.MkdirAll(filepath.Dir(ta), 0o700)
	if err := os.Rename(fa, ta); err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, map[string]string{"path": tr})
}

// handleRefDelete moves the file or folder to reference-deleted/<time>/…
// (kept, never erased by WorkHub).
func (a *App) handleRefDelete(w http.ResponseWriter, r *http.Request) {
	rel, abs, err := a.refAbs(r.URL.Query().Get("path"))
	if err != nil || rel == "" {
		writeErr(w, 400, errors.New("bad path"))
		return
	}
	dest := filepath.Join(a.refDeleted(), time.Now().Format("2006-01-02_150405"), filepath.FromSlash(rel))
	_ = os.MkdirAll(filepath.Dir(dest), 0o700)
	if err := os.Rename(abs, uniqueName(dest)); err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, map[string]string{"kept_in": a.refDeleted()})
}

func (a *App) handleRefReveal(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Path  string `json:"path"`
		Where string `json:"where"` // "", "history", "deleted"
	}
	_ = readJSON(r, &in)
	a.ensureReference()
	target := a.refRoot()
	switch in.Where {
	case "history":
		target = a.refHistory()
	case "deleted":
		target = a.refDeleted()
	default:
		if _, abs, err := a.refAbs(in.Path); err == nil {
			if st, err := os.Stat(abs); err == nil {
				target = abs
				if !st.IsDir() {
					target = filepath.Dir(abs)
				}
			}
		}
	}
	_ = os.MkdirAll(target, 0o700)
	openPath(target)
	writeJSON(w, map[string]string{"path": target})
}

// handleRefSearch: files whose name or text content contains q.
func (a *App) handleRefSearch(w http.ResponseWriter, r *http.Request) {
	q := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	out := []string{}
	if q == "" {
		writeJSON(w, out)
		return
	}
	root := a.refRoot()
	_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || p == root {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		rel = filepath.ToSlash(rel)
		if strings.Contains(strings.ToLower(path.Base(rel)), q) {
			out = append(out, rel)
			return nil
		}
		if d.IsDir() {
			return nil
		}
		if info, err := d.Info(); err == nil && info.Size() < 4<<20 {
			if b, err := os.ReadFile(p); err == nil && isTextContent(rel, b) && strings.Contains(strings.ToLower(string(b)), q) {
				out = append(out, rel)
			}
		}
		return nil
	})
	writeJSON(w, out)
}

// handleRefHistory lists a file's older copies (newest first), or returns
// one of them with ?v=<name>.
func (a *App) handleRefHistory(w http.ResponseWriter, r *http.Request) {
	rel, _, err := a.refAbs(r.URL.Query().Get("path"))
	if err != nil || rel == "" {
		writeErr(w, 400, errors.New("bad path"))
		return
	}
	dir := filepath.Join(a.refHistory(), filepath.FromSlash(rel))
	if v := r.URL.Query().Get("v"); v != "" {
		if v != filepath.Base(v) {
			writeErr(w, 400, errors.New("bad version"))
			return
		}
		http.ServeFile(w, r, filepath.Join(dir, v))
		return
	}
	type ver struct {
		Name string    `json:"name"`
		Size int64     `json:"size"`
		Mod  time.Time `json:"mod"`
	}
	out := []ver{}
	ents, _ := os.ReadDir(dir)
	for i := len(ents) - 1; i >= 0; i-- {
		if info, err := ents[i].Info(); err == nil && !info.IsDir() {
			out = append(out, ver{ents[i].Name(), info.Size(), info.ModTime()})
		}
	}
	writeJSON(w, out)
}
