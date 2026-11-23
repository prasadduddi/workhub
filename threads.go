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
	Kind   string    `json:"kind"`             // note, capture, entry
	HTML   string    `json:"html,omitempty"`   // note: rich text (sanitised by the page)
	Text   string    `json:"text,omitempty"`   // capture: the copied text
	Ref    string    `json:"ref,omitempty"`    // capture: clip id; entry: entry id
	Parent string    `json:"parent,omitempty"` // a reply: the post it answers (one level)
	Pinned bool      `json:"pinned,omitempty"` // shown at the top of the thread
	Edited time.Time `json:"edited,omitzero"`
}

// migrateThreads turns each work item's document (or its older blocks) into
// its first post. The originals are kept in the data file untouched.
func (s *Store) migrateThreads() {
	for _, w := range s.st.WorkItems {
		if w.Jira == "" {
			w.Jira = jiraKeyOf(w.Title) // "PAY-123 refunds" is linked to PAY-123
		}
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
	if p.Parent != "" { // replies are one level deep: a reply to a reply answers its post
		var parent *Post
		for _, x := range w.Posts {
			if x.ID == p.Parent {
				parent = x
			}
		}
		if parent == nil {
			return Post{}, errors.New("the post being answered was deleted")
		}
		if parent.Parent != "" {
			p.Parent = parent.Parent
		}
	}
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

// EditPost changes a note's text (h != nil) and/or its pin (pin != nil).
func (s *Store) EditPost(id, pid string, h *string, pin *bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	w := s.workItem(id)
	if w == nil {
		return errors.New("thread not found")
	}
	for _, p := range w.Posts {
		if p.ID == pid {
			if h != nil {
				p.HTML, p.Edited = *h, time.Now()
			}
			if pin != nil {
				p.Pinned = *pin
			}
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
	n := len(w.Posts)
	keep := w.Posts[:0]
	for _, p := range w.Posts {
		if p.ID != pid && p.Parent != pid { // a post goes with its replies
			keep = append(keep, p)
		}
	}
	if len(keep) == n {
		return errors.New("post not found")
	}
	for i := len(keep); i < n; i++ {
		w.Posts[i] = nil
	}
	w.Posts = keep
	s.changed()
	return nil
}

// captureToThread adds copied text to the thread chosen with "Capture here"
// or, when none is chosen, to the General thread; "off" means no thread
// (called from Ingest, with s.mu held).
func (s *Store) captureToThread(text, clipID string, now time.Time) {
	var w *WorkItem
	switch id := s.st.Settings.ActiveThread; id {
	case "off":
		return
	case "":
		w = s.generalThread(now)
	default:
		if w = s.workItem(id); w == nil { // that thread was deleted
			w = s.generalThread(now)
		}
	}
	if w == nil || w.Archived {
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
	replies := map[string][]*Post{}
	var top []*Post
	for _, p := range w.Posts {
		if p.Parent != "" {
			replies[p.Parent] = append(replies[p.Parent], p)
		} else {
			top = append(top, p)
		}
	}
	var order []*Post
	for _, p := range top {
		order = append(order, p)
		order = append(order, replies[p.ID]...)
	}
	for _, p := range order {
		head := p.At.Local().Format("Mon 2 Jan 2006 15:04")
		if p.Parent != "" {
			head = "↳ reply · " + head
		}
		if p.Pinned {
			head = "📌 " + head
		}
		b.WriteString("<p><b>" + head + "</b></p>")
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
	p, err := a.store.AddPost(r.PathValue("id"), Post{Kind: in.Kind, HTML: in.HTML, Text: in.Text, Ref: in.Ref, At: in.At, Parent: in.Parent, Pinned: in.Pinned})
	if err != nil {
		writeErr(w, 404, err)
		return
	}
	_, _ = a.store.writeWorkDocx(r.PathValue("id"))
	writeJSON(w, p)
}

func (a *App) handlePostEdit(w http.ResponseWriter, r *http.Request) {
	var in struct {
		HTML   *string `json:"html"`
		Pinned *bool   `json:"pinned"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	if err := a.store.EditPost(r.PathValue("id"), r.PathValue("pid"), in.HTML, in.Pinned); err != nil {
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

// generalThread is the thread captures go to by default, made the first time
// it is needed (with s.mu held).
func (s *Store) generalThread(now time.Time) *WorkItem {
	for _, w := range s.st.WorkItems {
		if w.General {
			return w
		}
	}
	w := &WorkItem{ID: randomHex(8), Title: "General", Status: "doing", General: true, Blocks: []*Block{}, Created: now, Updated: now}
	s.st.WorkItems = append(s.st.WorkItems, w)
	s.changed()
	return w
}

// EnsureGeneral makes sure the General thread exists (shown on the Tasks page
// even before the first capture).
func (s *Store) EnsureGeneral() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.generalThread(time.Now())
}
