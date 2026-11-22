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

// refLoc is where a path in the Folders tree really is. Links ("name.whlink"
// files holding a path) make a folder or file elsewhere on the PC appear in
// the tree without copying it.
type refLoc struct {
	rel      string
	abs      string
	linked   bool   // inside (or is) a linked folder/file: the user's real files
	linkFile string // set when rel names the link itself
}

const linkExt = ".whlink"

// readLink returns the target path stored in a .whlink file.
func readLink(p string) (string, bool) {
	b, err := os.ReadFile(p)
	if err != nil {
		return "", false
	}
	t := strings.TrimSpace(strings.SplitN(strings.TrimPrefix(string(b), "\ufeff"), "\n", 2)[0])
	return t, t != ""
}

func (a *App) refLoc(p string) (refLoc, error) {
	rel, err := cleanRel(p)
	if err != nil {
		return refLoc{}, err
	}
	loc := refLoc{rel: rel, abs: a.refRoot()}
	if rel == "" {
		return loc, nil
	}
	parts := strings.Split(rel, "/")
	for i, part := range parts {
		next := filepath.Join(loc.abs, part)
		if !loc.linked {
			if _, err := os.Lstat(next); err != nil {
				if t, ok := readLink(next + linkExt); ok {
					loc.linked = true
					if i == len(parts)-1 {
						loc.linkFile = next + linkExt
					}
					next = t
				}
			}
		}
		loc.abs = next
	}
	return loc, nil
}

// refAbs: path for changes inside the reference folder itself (not links).
func (a *App) refAbs(p string) (string, string, error) {
	loc, err := a.refLoc(p)
	if err != nil {
		return "", "", err
	}
	if loc.linked {
		return "", "", errLinked
	}
	return loc.rel, loc.abs, nil
}

var errLinked = errors.New("this is inside a linked folder — WorkHub only shows and edits those files; add, move or delete them in Explorer")

type RefItem struct {
	Path    string    `json:"path"`
	Dir     bool      `json:"dir"`
	Size    int64     `json:"size"`
	Mod     time.Time `json:"mod"`
	Link    string    `json:"link,omitempty"`    // a link: the real path it points to
	Linked  bool      `json:"linked,omitempty"`  // inside a linked folder
	Missing bool      `json:"missing,omitempty"` // link target not found (drive not mapped…)
	abs     string
}

const (
	linkMaxDepth = 6
	linkMaxItems = 4000
)

var skipLinkedDirs = map[string]bool{".git": true, "node_modules": true, ".svn": true, ".idea": true, "target": true, "__pycache__": true}

// refItems lists the tree: the reference folder plus the contents of links.
func (a *App) refItems() []RefItem {
	root := a.refRoot()
	out := []RefItem{}
	add := func(it RefItem, info fs.FileInfo) {
		if info != nil {
			it.Mod = info.ModTime()
			if !info.IsDir() {
				it.Size = info.Size()
			}
		}
		out = append(out, it)
	}
	var walkLinked func(abs, rel string, depth int)
	walkLinked = func(abs, rel string, depth int) {
		ents, err := os.ReadDir(abs)
		if err != nil || depth > linkMaxDepth {
			return
		}
		for _, e := range ents {
			if len(out) >= linkMaxItems || strings.HasPrefix(e.Name(), "~$") || (e.IsDir() && skipLinkedDirs[e.Name()]) {
				continue
			}
			p, r := filepath.Join(abs, e.Name()), rel+"/"+e.Name()
			info, _ := e.Info()
			add(RefItem{Path: r, Dir: e.IsDir(), Linked: true, abs: p}, info)
			if e.IsDir() {
				walkLinked(p, r, depth+1)
			}
		}
	}
	_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || p == root || strings.HasSuffix(d.Name(), ".wh-tmp") {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		rel = filepath.ToSlash(rel)
		info, _ := d.Info()
		if !d.IsDir() && strings.HasSuffix(strings.ToLower(d.Name()), linkExt) {
			target, _ := readLink(p)
			it := RefItem{Path: strings.TrimSuffix(rel, rel[len(rel)-len(linkExt):]), Link: target, abs: target}
			st, err := os.Stat(target)
			if err != nil {
				it.Missing = true
				add(it, nil)
				return nil
			}
			it.Dir = st.IsDir()
			add(it, st)
			if it.Dir {
				walkLinked(target, it.Path, 1)
			}
			return nil
		}
		add(RefItem{Path: rel, Dir: d.IsDir(), abs: p}, info)
		return nil
	})
	return out
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
	writeJSON(w, map[string]any{"root": a.refRoot(), "items": a.refItems()})
}

// handleRefLink adds a link to a folder or file anywhere on this PC.
func (a *App) handleRefLink(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Dir    string `json:"dir"`
		Name   string `json:"name"`
		Target string `json:"target"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	target := expandPath(expandWinEnv(in.Target)) // %USERPROFILE%\x works too
	if !filepath.IsAbs(target) && !strings.HasPrefix(target, `\\`) {
		writeErr(w, 400, errors.New("type a full path, e.g. C:\\work\\configs or \\\\server\\share\\folder"))
		return
	}
	if _, err := os.Stat(target); err != nil {
		writeErr(w, 400, fmt.Errorf("can't open %s from this PC", target))
		return
	}
	name := strings.TrimSpace(in.Name)
	if name == "" {
		name = filepath.Base(target)
	}
	rel, abs, err := a.refAbs(strings.TrimSuffix(in.Dir, "/") + "/" + name)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	if _, err := os.Stat(abs); err == nil {
		writeErr(w, 409, fmt.Errorf("%s already exists here — pick another name", name))
		return
	}
	if _, err := os.Stat(abs + linkExt); err == nil {
		writeErr(w, 409, fmt.Errorf("there is already a link called %s here", name))
		return
	}
	if err := writeAtomic(abs+linkExt, []byte(target+"\n")); err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, map[string]string{"path": rel, "target": target})
}

// expandWinEnv expands %NAME% the way Windows does.
func expandWinEnv(s string) string {
	return regexp.MustCompile(`%([A-Za-z0-9_()]+)%`).ReplaceAllStringFunc(s, func(m string) string {
		if v, ok := os.LookupEnv(m[1 : len(m)-1]); ok {
			return v
		}
		return m
	})
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
	loc, err := a.refLoc(r.URL.Query().Get("path"))
	rel, abs := loc.rel, loc.abs
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
	loc, err := a.refLoc(r.URL.Query().Get("path"))
	if err == nil && loc.rel == "" {
		err = errors.New("missing file name")
	}
	if err == nil && loc.linked { // a linked file: edit it in place, never create
		if st, serr := os.Stat(loc.abs); serr != nil || st.IsDir() || r.URL.Query().Get("new") == "1" {
			err = errLinked
		}
	}
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	rel, abs := loc.rel, loc.abs
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
	if from, err := a.refLoc(in.From); err == nil && from.linkFile != "" { // move/rename the link itself
		tr, ta, err := a.refAbs(in.To)
		if err != nil || tr == "" {
			writeErr(w, 400, errors.Join(err, errors.New("bad name")))
			return
		}
		if _, err := os.Stat(ta + linkExt); err == nil {
			writeErr(w, 409, fmt.Errorf("%s already exists", tr))
			return
		}
		_ = os.MkdirAll(filepath.Dir(ta), 0o700)
		if err := os.Rename(from.linkFile, ta+linkExt); err != nil {
			writeErr(w, 500, err)
			return
		}
		writeJSON(w, map[string]string{"path": tr})
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
	if loc, err := a.refLoc(r.URL.Query().Get("path")); err == nil && loc.linkFile != "" {
		dest := filepath.Join(a.refDeleted(), time.Now().Format("2006-01-02_150405"), filepath.FromSlash(loc.rel)+linkExt)
		_ = os.MkdirAll(filepath.Dir(dest), 0o700)
		if err := os.Rename(loc.linkFile, uniqueName(dest)); err != nil {
			writeErr(w, 500, err)
			return
		}
		writeJSON(w, map[string]string{"removed": "link", "kept_in": a.refDeleted()})
		return
	}
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
		if loc, err := a.refLoc(in.Path); err == nil {
			abs := loc.abs
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

// handleRefSearch: files whose name or text content contains q (linked
// folders included).
func (a *App) handleRefSearch(w http.ResponseWriter, r *http.Request) {
	q := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	out := []string{}
	if q == "" {
		writeJSON(w, out)
		return
	}
	for _, it := range a.refItems() {
		if strings.Contains(strings.ToLower(path.Base(it.Path)), q) {
			out = append(out, it.Path)
			continue
		}
		if it.Dir || it.Missing || it.Size >= 4<<20 {
			continue
		}
		if b, err := os.ReadFile(it.abs); err == nil && isTextContent(it.Path, b) && strings.Contains(strings.ToLower(string(b)), q) {
			out = append(out, it.Path)
		}
	}
	writeJSON(w, out)
}

// handleRefHistory lists a file's older copies (newest first), or returns
// one of them with ?v=<name>.
func (a *App) handleRefHistory(w http.ResponseWriter, r *http.Request) {
	loc, err := a.refLoc(r.URL.Query().Get("path"))
	rel := loc.rel
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
