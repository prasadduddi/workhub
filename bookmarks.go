package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// normURL gives one key for links that are really the same page: ignores
// http/https, "www.", default ports, a trailing slash, the #fragment and
// tracking parameters.
func normURL(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" {
		return strings.TrimRight(strings.ToLower(strings.TrimSpace(raw)), "/")
	}
	host := strings.TrimPrefix(strings.ToLower(u.Hostname()), "www.")
	if p := u.Port(); p != "" && p != "80" && p != "443" {
		host += ":" + p
	}
	q := u.Query()
	for k := range q {
		lk := strings.ToLower(k)
		if strings.HasPrefix(lk, "utm_") || lk == "fbclid" || lk == "gclid" || lk == "mc_cid" || lk == "mc_eid" {
			q.Del(k)
		}
	}
	key := host + strings.TrimRight(u.EscapedPath(), "/")
	if enc := q.Encode(); enc != "" {
		key += "?" + enc
	}
	return key
}

type Bookmark struct {
	Name, URL, Folder, Source string
}

// browserBookmarkFiles finds Edge and Chrome bookmark files for every
// browser profile of the current user (plain JSON, readable without admin).
func browserBookmarkFiles() []string {
	var bases []string
	if runtime.GOOS == "windows" {
		la := os.Getenv("LOCALAPPDATA")
		bases = []string{filepath.Join(la, "Microsoft", "Edge", "User Data"), filepath.Join(la, "Google", "Chrome", "User Data")}
	} else {
		home, _ := os.UserHomeDir()
		as := filepath.Join(home, "Library", "Application Support")
		bases = []string{filepath.Join(as, "Microsoft Edge"), filepath.Join(as, "Google", "Chrome")}
	}
	var out []string
	for _, b := range bases {
		m, _ := filepath.Glob(filepath.Join(b, "*", "Bookmarks"))
		out = append(out, m...)
	}
	return out
}

type bmNode struct {
	Type     string   `json:"type"`
	Name     string   `json:"name"`
	URL      string   `json:"url"`
	Children []bmNode `json:"children"`
}

// readBookmarkFile reads one browser profile's bookmarks, keeping the folder
// path, e.g. "Edge › Favorites bar › Infra".
func readBookmarkFile(path string) ([]Bookmark, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var doc struct {
		Roots map[string]bmNode `json:"roots"`
	}
	if err := json.Unmarshal(b, &doc); err != nil {
		return nil, err
	}
	browser, source := "Chrome", "chrome"
	if strings.Contains(path, "Edge") {
		browser, source = "Edge", "edge"
	}
	if profile := filepath.Base(filepath.Dir(path)); profile != "Default" {
		browser += " (" + profile + ")"
	}
	var out []Bookmark
	var walk func(n bmNode, folder string)
	walk = func(n bmNode, folder string) {
		if n.Type == "url" {
			if strings.HasPrefix(n.URL, "http") {
				out = append(out, Bookmark{Name: n.Name, URL: n.URL, Folder: folder, Source: source})
			}
			return
		}
		sub := folder
		if n.Name != "" {
			sub = folder + " › " + n.Name
		}
		for _, c := range n.Children {
			walk(c, sub)
		}
	}
	for _, key := range []string{"bookmark_bar", "other", "synced"} { // browser order
		if r, ok := doc.Roots[key]; ok {
			walk(r, browser)
		}
	}
	return out, nil
}

// syncBrowserBookmarks re-reads Edge and Chrome; called on start-up and
// whenever the Bookmarks page is opened.
func (a *App) syncBrowserBookmarks() (found, added, removed int, err error) {
	if a.store.Settings().NoBrowserSync {
		return 0, 0, 0, nil
	}
	var all []Bookmark
	files := browserBookmarkFiles()
	for _, f := range files {
		list, err := readBookmarkFile(f)
		if err != nil {
			// A file we can't read must not make its bookmarks look deleted.
			return 0, 0, 0, fmt.Errorf("reading %s: %w", f, err)
		}
		all = append(all, list...)
	}
	added, removed = a.store.SyncBookmarks(all)
	return len(all), added, removed, nil
}

func (a *App) handleSyncBookmarks(w http.ResponseWriter, r *http.Request) {
	found, added, removed, err := a.syncBrowserBookmarks()
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, map[string]int{"found": found, "added": added, "removed": removed})
}

func (a *App) handleOpened(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("only") != "searched" {
		a.store.Opened(r.PathValue("id"))
	}
	if r.URL.Query().Get("searched") == "1" || r.URL.Query().Get("only") == "searched" {
		a.store.Searched(r.PathValue("id"))
	}
	writeJSON(w, map[string]bool{"ok": true})
}
