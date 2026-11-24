package main

// Search across the files attached to task threads (screenshots, documents,
// logs, dropped files and email attachments), for the search across
// everything: every word must be in the file's name, its thread's name, or
// the file's text (text files and Word documents).

import (
	"archive/zip"
	"bytes"
	"html"
	"io"
	"net/http"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

type threadFileHit struct {
	ID       string    `json:"id"`
	Name     string    `json:"name"`
	Size     int64     `json:"size"`
	Image    bool      `json:"image"`
	Added    time.Time `json:"added"`
	Thread   string    `json:"thread"`
	Title    string    `json:"thread_title"`
	Archived bool      `json:"archived,omitempty"`
	Post     string    `json:"post,omitempty"` // the message the file is in, to jump to
	Snip     string    `json:"snip,omitempty"`
}

// The text of each thread file, read once: thread files are never changed
// after they are stored (only Properties files are edited in place).
var threadFileText = struct {
	sync.Mutex
	m map[string]string
}{m: map[string]string{}}

var (
	docxParaEnd = regexp.MustCompile(`</w:p>|<w:br/>|<w:tab/>`)
	xmlTag      = regexp.MustCompile(`<[^>]*>`)
)

// docxPlainText: a Word document's words, one line per paragraph.
func docxPlainText(data []byte) string {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return ""
	}
	for _, f := range zr.File {
		if f.Name != "word/document.xml" {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return ""
		}
		b, _ := io.ReadAll(io.LimitReader(rc, 32<<20))
		rc.Close()
		t := docxParaEnd.ReplaceAllString(string(b), "\n")
		return html.UnescapeString(xmlTag.ReplaceAllString(t, ""))
	}
	return ""
}

// fileText returns the searchable text of a stored file ("" for pictures,
// PDFs and other binary files).
func (s *Store) fileText(a Attachment) string {
	ext := strings.ToLower(filepath.Ext(a.Name))
	if a.Image || a.Size > 8<<20 || (ext != ".docx" && !a.Text && a.Size > 4<<20) {
		return ""
	}
	threadFileText.Lock()
	t, ok := threadFileText.m[a.ID]
	threadFileText.Unlock()
	if ok {
		return t
	}
	_, b, err := s.ReadAttachment(a.ID)
	if err == nil {
		if ext == ".docx" {
			t = docxPlainText(b)
		} else if isTextContent(a.Name, b) {
			t = string(b)
		}
	}
	threadFileText.Lock()
	threadFileText.m[a.ID] = t
	threadFileText.Unlock()
	return t
}

// SearchThreadFiles finds thread files matching every word (lower case).
func (s *Store) SearchThreadFiles(words []string) []threadFileHit {
	hits := []threadFileHit{}
	if len(words) == 0 {
		return hits
	}
	type cand struct {
		a   Attachment
		hit threadFileHit
	}
	var cands []cand
	s.mu.RLock()
	seen := map[string]bool{}
	for _, w := range s.st.WorkItems {
		files := append([]Attachment(nil), w.Files...)
		for _, b := range w.Blocks {
			if b.File != nil {
				files = append(files, *b.File)
			}
		}
		for _, a := range files {
			if seen[a.ID] {
				continue
			}
			seen[a.ID] = true
			h := threadFileHit{ID: a.ID, Name: a.Name, Size: a.Size, Image: a.Image, Added: a.Added, Thread: w.ID, Title: w.Title, Archived: w.Archived}
			for _, p := range w.Posts {
				if strings.Contains(p.HTML, "/files/"+a.ID) {
					h.Post = p.ID
					break
				}
			}
			cands = append(cands, cand{a, h})
		}
	}
	s.mu.RUnlock()
	for _, c := range cands {
		// every word in the file's name, its thread's name or its text; at
		// least one in the file itself (a thread's name alone lists the thread)
		own, name := strings.ToLower(c.a.Name), strings.ToLower(c.a.Name+" "+c.hit.Title)
		inName, inOwn := true, false
		for _, w := range words {
			inName = inName && strings.Contains(name, w)
			inOwn = inOwn || strings.Contains(own, w)
		}
		if inName && inOwn {
			hits = append(hits, c.hit)
			continue
		}
		text := s.fileText(c.a)
		if text == "" {
			continue
		}
		if snip, ok := refMatch(name, text, words); ok && snip != "" {
			c.hit.Snip = snip
			hits = append(hits, c.hit)
		}
	}
	// a match in the file's own name first, then the newest
	sort.SliceStable(hits, func(i, j int) bool {
		ni, nj := hits[i].Snip == "", hits[j].Snip == ""
		if ni != nj {
			return ni
		}
		return hits[i].Added.After(hits[j].Added)
	})
	if len(hits) > 50 {
		hits = hits[:50]
	}
	return hits
}

func (a *App) handleWorkFileSearch(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, a.store.SearchThreadFiles(strings.Fields(strings.ToLower(r.URL.Query().Get("q")))))
}
