package main

// ⇆ Compare (Folders page): folder compare. Each side is a path in Folders
// ("ref") or anywhere on this PC ("local"). Files present on both sides are
// compared by size, then by content. File compare itself happens in the page.

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/pkg/sftp"
)

type cmpSide struct {
	Kind string `json:"kind"` // ref or local
	Path string `json:"path"`
}

type cmpFile struct {
	Size  int64     `json:"size"`
	Mtime time.Time `json:"mtime"`
}

type cmpEntry struct {
	Rel    string   `json:"rel"`
	Dir    bool     `json:"dir"`
	A      *cmpFile `json:"a,omitempty"`
	B      *cmpFile `json:"b,omitempty"`
	Status string   `json:"status"` // same, diff, left, right
}

const maxCmpEntries = 20000

func (a *App) cmpRoot(s cmpSide) (string, error) {
	if s.Kind == "local" {
		p := filepath.Clean(expandPath(s.Path))
		if !filepath.IsAbs(p) {
			return "", errors.New("use a full path on this PC")
		}
		return p, nil
	}
	loc, err := a.refLoc(s.Path)
	return loc.abs, err
}

// walkSide lists everything under root by relative path (forward slashes).
func walkSide(root string) (map[string]*cmpEntry, error) {
	st, err := os.Stat(root)
	if err != nil {
		return nil, err
	}
	if !st.IsDir() {
		return nil, errors.New(filepath.Base(root) + " is not a folder")
	}
	out := map[string]*cmpEntry{}
	err = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || p == root {
			return nil // unreadable parts are left out
		}
		if len(out) >= maxCmpEntries {
			return filepath.SkipAll
		}
		rel, _ := filepath.Rel(root, p)
		info, ierr := d.Info()
		if ierr != nil {
			return nil
		}
		out[filepath.ToSlash(rel)] = &cmpEntry{Rel: filepath.ToSlash(rel), Dir: d.IsDir(), A: &cmpFile{Size: info.Size(), Mtime: info.ModTime()}}
		return nil
	})
	return out, err
}

func sameContent(a, b string) bool {
	h := func(p string) ([]byte, bool) {
		f, err := os.Open(p)
		if err != nil {
			return nil, false
		}
		defer f.Close()
		s := sha256.New()
		if _, err := io.Copy(s, f); err != nil {
			return nil, false
		}
		return s.Sum(nil), true
	}
	x, ok1 := h(a)
	y, ok2 := h(b)
	return ok1 && ok2 && string(x) == string(y)
}

// compareDirs merges both listings; folders get "diff" when anything inside differs.
func compareDirs(ra, rb string) ([]cmpEntry, error) {
	la, err := walkSide(ra)
	if err != nil {
		return nil, err
	}
	lb, err := walkSide(rb)
	if err != nil {
		return nil, err
	}
	all := map[string]*cmpEntry{}
	for k, e := range la {
		all[k] = &cmpEntry{Rel: k, Dir: e.Dir, A: e.A, Status: "left"}
	}
	for k, e := range lb {
		if x, ok := all[k]; ok && x.Dir == e.Dir {
			x.B = e.A
			if x.Dir {
				x.Status = "same"
			} else if x.A.Size != e.A.Size {
				x.Status = "diff"
			} else if x.A.Size == 0 || sameContent(filepath.Join(ra, filepath.FromSlash(k)), filepath.Join(rb, filepath.FromSlash(k))) {
				x.Status = "same"
			} else {
				x.Status = "diff"
			}
			continue
		}
		if x, ok := all[k]; ok { // a file on one side, a folder on the other
			x.Status = "diff"
			x.B = e.A
			continue
		}
		all[k] = &cmpEntry{Rel: k, Dir: e.Dir, B: e.A, Status: "right"}
	}
	// a folder differs when something inside it does
	for k, e := range all {
		if e.Status == "same" && e.Dir {
			continue
		}
		if e.Status != "same" {
			for p := parentRel(k); p != ""; p = parentRel(p) {
				if d, ok := all[p]; ok && d.Status == "same" {
					d.Status = "diff"
				}
			}
		}
	}
	out := make([]cmpEntry, 0, len(all))
	for _, e := range all {
		out = append(out, *e)
	}
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i].Rel) < strings.ToLower(out[j].Rel) })
	return out, nil
}

func parentRel(p string) string {
	if i := strings.LastIndex(p, "/"); i >= 0 {
		return p[:i]
	}
	return ""
}

func (a *App) handleCompareDirs(w http.ResponseWriter, r *http.Request) {
	var in struct{ A, B cmpSide }
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	ra, err := a.cmpRoot(in.A)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	rb, err := a.cmpRoot(in.B)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	list, err := compareDirs(ra, rb)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	writeJSON(w, map[string]any{"entries": list, "a": ra, "b": rb, "capped": len(list) >= maxCmpEntries})
}

// handleCompareStat tells whether a side is a file or a folder (and that it exists).
func (a *App) handleCompareStat(w http.ResponseWriter, r *http.Request) {
	var in cmpSide
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	p, err := a.cmpRoot(in)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	st, err := os.Stat(p)
	if err != nil {
		writeErr(w, 404, errors.New("not found: "+p))
		return
	}
	writeJSON(w, map[string]any{"dir": st.IsDir(), "size": st.Size(), "abs": p})
}

// ---- a file on a server (read-only, over SFTP) ----

type remoteSide struct {
	ID       string `json:"id"` // the connection
	Path     string `json:"path"`
	Username string `json:"username"`
	Password string `json:"password"`
}

const maxRemoteCompare = 10 << 20

// handleCompareRemote reads one file from a server for Compare. It only reads:
// nothing on the server is changed.
func (a *App) handleCompareRemote(w http.ResponseWriter, r *http.Request) {
	var in remoteSide
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	e, ok := a.store.Entry(in.ID)
	if !ok {
		writeErr(w, 404, errors.New("connection not found"))
		return
	}
	if strings.TrimSpace(in.Path) == "" {
		writeErr(w, 400, errors.New("type the file's path on the server"))
		return
	}
	client, err := a.dialSSH(e, in.Username, in.Password)
	a.store.SetStatus(e.ID, err)
	if err != nil {
		writeErr(w, 502, err)
		return
	}
	defer client.Close()
	sc, err := sftp.NewClient(client)
	if err != nil {
		writeErr(w, 502, fmt.Errorf("SFTP isn't available on %s: %v", e.Host, err))
		return
	}
	defer sc.Close()
	p := in.Path
	if strings.HasPrefix(p, "~/") {
		if home, err := sc.Getwd(); err == nil {
			p = home + p[1:]
		}
	}
	st, err := sc.Stat(p)
	if err != nil {
		writeErr(w, 404, fmt.Errorf("%s: %v", p, err))
		return
	}
	if st.IsDir() {
		writeErr(w, 400, errors.New(p+" is a folder — compare a file"))
		return
	}
	if st.Size() > maxRemoteCompare {
		writeErr(w, 400, fmt.Errorf("%s is %d MB; Compare reads files up to 10 MB", p, st.Size()>>20))
		return
	}
	f, err := sc.Open(p)
	if err != nil {
		writeErr(w, 502, err)
		return
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maxRemoteCompare))
	if err != nil {
		writeErr(w, 502, err)
		return
	}
	if bytes.IndexByte(b, 0) >= 0 || !utf8.Valid(b) {
		writeJSON(w, map[string]any{"binary": true, "size": len(b), "path": p})
		return
	}
	writeJSON(w, map[string]any{"text": string(b), "path": p, "mtime": st.ModTime(), "host": e.Host})
}
