package main

// ⇆ Compare (Folders page): folder compare. Each side is a path in Folders
// ("ref") or anywhere on this PC ("local"). Files present on both sides are
// compared by size, then by content. File compare itself happens in the page.

import (
	"crypto/sha256"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
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
