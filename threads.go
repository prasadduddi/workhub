package main

// Task threads (replacing the Notes work items): each work item is a thread
// of time-stamped posts — notes with pasted screenshots and files, captured
// clipboard text, and connections added from anywhere. A work item's old
// free-form document becomes its first post, so nothing is lost; the Word
// copy in <data>/work-items is rebuilt from the posts.

import (
	"errors"
	"fmt"
	"html"
	"net/http"
	"strings"
	"time"
)

type Post struct {
	ID     string    `json:"id"`
	At     time.Time `json:"at"`
	Kind   string    `json:"kind"`           // note, capture, entry
	HTML   string    `json:"html,omitempty"` // note: rich text (sanitised by the page)
	Text   string    `json:"text,omitempty"` // capture: the copied text
	Ref    string    `json:"ref,omitempty"`  // capture: clip id; entry: entry id
	Edited time.Time `json:"edited,omitzero"`
}

// migrateThreads turns each work item's document (or its older blocks) into
// its first post. The originals are kept in the data file untouched.
func (s *Store) migrateThreads() {
	for _, w := range s.st.WorkItems {
		if len(w.Posts) > 0 {
			continue
		}
		at := w.Updated
		if at.IsZero() {
			at = w.Created
		}
		if strings.TrimSpace(tagRe.ReplaceAllString(w.Doc, "")) != "" || strings.Contains(w.Doc, "<img") {
			w.Posts = append(w.Posts, &Post{ID: randomHex(8), At: at, Kind: "note", HTML: w.Doc})
			continue
		}
		for _, b := range w.Blocks {
			var h string
			switch {
			case b.Kind == "link":
				h = fmt.Sprintf(`<p><a href="%s">%s</a></p>`, html.EscapeString(b.URL), html.EscapeString(orDefault(b.Title, b.URL)))
			case b.File != nil && b.File.Image:
				h = fmt.Sprintf(`<p><img src="/api/props/files/%s" alt="%s"></p>`, b.File.ID, html.EscapeString(b.File.Name))
			case b.File != nil:
				h = fmt.Sprintf(`<p>📎 <a href="/api/props/files/%s?download=1">%s</a></p>`, b.File.ID, html.EscapeString(b.File.Name))
			default:
				h = "<p>" + strings.ReplaceAll(html.EscapeString(b.Text), "\n", "<br>") + "</p>"
			}
			w.Posts = append(w.Posts, &Post{ID: randomHex(8), At: b.Added, Kind: "note", HTML: h})
		}
	}
}

func (s *Store) AddPost(id string, p Post) (Post, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	w := s.workItem(id)
	if w == nil {
		return Post{}, errors.New("thread not found")
	}
	p.ID = randomHex(8)
	if p.At.IsZero() || p.At.After(time.Now()) {
		p.At = time.Now()
		w.Updated = p.At
	}
	// Restored (Undo) posts keep their time and go back in their place.
	i := len(w.Posts)
	for i > 0 && w.Posts[i-1].At.After(p.At) {
		i--
	}
	w.Posts = append(w.Posts[:i], append([]*Post{&p}, w.Posts[i:]...)...)
	s.changed()
	return p, nil
}

func (s *Store) EditPost(id, pid, h string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	w := s.workItem(id)
	if w == nil {
		return errors.New("thread not found")
	}
	for _, p := range w.Posts {
		if p.ID == pid {
			p.HTML, p.Edited = h, time.Now()
			s.changed()
			return nil
		}
	}
	return errors.New("post not found")
}

func (s *Store) DeletePost(id, pid string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	w := s.workItem(id)
	if w == nil {
		return errors.New("thread not found")
	}
	for i, p := range w.Posts {
		if p.ID == pid {
			w.Posts = append(w.Posts[:i], w.Posts[i+1:]...)
			s.changed()
			return nil
		}
	}
	return errors.New("post not found")
}

// captureToThread adds copied text to the thread chosen as "Capturing to"
// (called from Ingest, with s.mu held).
func (s *Store) captureToThread(text, clipID string, now time.Time) {
	w := s.workItem(s.st.Settings.ActiveThread)
	if w == nil {
		return
	}
	w.Posts = append(w.Posts, &Post{ID: randomHex(8), At: now, Kind: "capture", Text: text, Ref: clipID})
	w.Updated = now
}

// threadHTML is the thread as one document, for the Word copy: each post
// under its date, saved passwords in captured text replaced by dots.
func (s *Store) threadHTML(w WorkItem) string {
	if len(w.Posts) == 0 {
		return w.Doc
	}
	s.mu.RLock()
	var pws []string
	byID := map[string]*Entry{}
	for _, e := range s.st.Entries {
		byID[e.ID] = e
		if len(e.Password) >= 3 {
			pws = append(pws, e.Password)
		}
	}
	s.mu.RUnlock()
	var b strings.Builder
	for _, p := range w.Posts {
		b.WriteString("<p><b>" + p.At.Local().Format("Mon 2 Jan 2006 15:04") + "</b></p>")
		switch p.Kind {
		case "capture":
			t := p.Text
			for _, pw := range pws {
				t = strings.ReplaceAll(t, pw, "••••••••")
			}
			b.WriteString("<p><i>Captured:</i></p><pre>" + html.EscapeString(t) + "</pre>")
		case "entry":
			if e := byID[p.Ref]; e != nil {
				b.WriteString("<p>🖥 " + html.EscapeString(e.Name) + " — " + html.EscapeString(strings.TrimSpace(e.Username+" @ "+orDefault(e.Host, e.URL))) + "</p>")
			}
			if p.HTML != "" {
				b.WriteString(p.HTML)
			}
		default:
			b.WriteString(p.HTML)
		}
	}
	return b.String()
}

// ---- HTTP ----

func (a *App) handlePostAdd(w http.ResponseWriter, r *http.Request) {
	var in Post
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	switch in.Kind {
	case "", "note":
		in.Kind = "note"
	case "capture", "entry":
	default:
		writeErr(w, 400, errors.New("kind must be note, capture or entry"))
		return
	}
	p, err := a.store.AddPost(r.PathValue("id"), Post{Kind: in.Kind, HTML: in.HTML, Text: in.Text, Ref: in.Ref, At: in.At})
	if err != nil {
		writeErr(w, 404, err)
		return
	}
	_, _ = a.store.writeWorkDocx(r.PathValue("id"))
	writeJSON(w, p)
}

func (a *App) handlePostEdit(w http.ResponseWriter, r *http.Request) {
	var in struct {
		HTML string `json:"html"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	if err := a.store.EditPost(r.PathValue("id"), r.PathValue("pid"), in.HTML); err != nil {
		writeErr(w, 404, err)
		return
	}
	_, _ = a.store.writeWorkDocx(r.PathValue("id"))
	writeJSON(w, map[string]bool{"ok": true})
}

func (a *App) handlePostDelete(w http.ResponseWriter, r *http.Request) {
	if err := a.store.DeletePost(r.PathValue("id"), r.PathValue("pid")); err != nil {
		writeErr(w, 404, err)
		return
	}
	_, _ = a.store.writeWorkDocx(r.PathValue("id"))
	writeJSON(w, map[string]bool{"ok": true})
}
