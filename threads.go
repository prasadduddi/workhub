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
	"os"
	"path/filepath"
	"regexp"
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
	// Slack-style extras
	Reactions []string  `json:"reactions,omitempty"` // emoji added to the post (✅ 👀 …)
	Saved     bool      `json:"saved,omitempty"`     // 🔖 "Save for later"
	RemindAt  time.Time `json:"remind_at,omitzero"`  // ⏰ "Remind me about this"
	From      string    `json:"from,omitempty"`      // capture: the app/window it was copied from
	Via       string    `json:"via,omitempty"`       // "Moved from …" / "Copied from …" another thread
}

// PostPatch changes parts of a post; nil fields stay as they are.
type PostPatch struct {
	HTML      *string    `json:"html"`
	Pinned    *bool      `json:"pinned"`
	Reactions *[]string  `json:"reactions"`
	Saved     *bool      `json:"saved"`
	RemindAt  *time.Time `json:"remind_at"` // zero time clears it
}

// migrateThreads turns each work item's document (or its older blocks) into
// its first post. The originals are kept in the data file untouched.
func (s *Store) migrateThreads() {
	for _, w := range s.st.WorkItems {
		if w.Jira == "" {
			w.Jira = jiraKeyOf(w.Title) // "PAY-123 refunds" is linked to PAY-123
		}
		if w.ReadAt.IsZero() { // threads from before unread counts: all read
			w.ReadAt = time.Now()
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
	return s.PatchPost(id, pid, PostPatch{HTML: h, Pinned: pin})
}

func (s *Store) PatchPost(id, pid string, in PostPatch) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	w := s.workItem(id)
	if w == nil {
		return errors.New("thread not found")
	}
	for _, p := range w.Posts {
		if p.ID == pid {
			if in.HTML != nil {
				p.HTML, p.Edited = *in.HTML, time.Now()
			}
			if in.Pinned != nil {
				p.Pinned = *in.Pinned
			}
			if in.Reactions != nil {
				p.Reactions = *in.Reactions
			}
			if in.Saved != nil {
				p.Saved = *in.Saved
			}
			if in.RemindAt != nil {
				p.RemindAt = *in.RemindAt
			}
			s.changed()
			return nil
		}
	}
	return errors.New("post not found")
}

// MarkRead: everything in the thread up to now has been seen.
func (s *Store) MarkRead(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if w := s.workItem(id); w != nil {
		w.ReadAt = time.Now()
		s.changed()
	}
}

func (s *Store) StarWork(id string, on bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	w := s.workItem(id)
	if w == nil {
		return errors.New("thread not found")
	}
	w.Starred = on
	s.changed()
	return nil
}

// unread counts posts that arrived after the thread was last looked at.
func (w *WorkItem) unread() int {
	n := 0
	for _, p := range w.Posts {
		if p.At.After(w.ReadAt) {
			n++
		}
	}
	return n
}

// postRef is a post with its thread, for the Saved list and reminders.
type postRef struct {
	Thread string `json:"thread"`
	Title  string `json:"title"`
	Post   Post   `json:"post"`
}

// MarkedPosts lists saved posts, or posts with a reminder.
func (s *Store) MarkedPosts(reminders bool) []postRef {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []postRef{}
	for _, w := range s.st.WorkItems {
		for _, p := range w.Posts {
			if reminders && !p.RemindAt.IsZero() || !reminders && p.Saved {
				out = append(out, postRef{w.ID, w.Title, *p})
			}
		}
	}
	return out
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

var reAttachRef = regexp.MustCompile(`/api/props/files/([0-9a-f]+)`)

// MovePost moves (or, with copy, copies) a message and its replies to another
// thread. It lands at the end of that thread with "Moved from …" on it; files
// and pictures in it go along, so they still show there.
func (s *Store) MovePost(fromID, pid, toID string, copy bool) (Post, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	src, dst := s.workItem(fromID), s.workItem(toID)
	if src == nil || dst == nil {
		return Post{}, errors.New("thread not found")
	}
	if src == dst {
		return Post{}, errors.New("that is the same thread")
	}
	var group []*Post
	for _, p := range src.Posts {
		if p.ID == pid || (p.Parent == pid && pid != "") {
			group = append(group, p)
		}
	}
	found := false
	for _, p := range group {
		found = found || p.ID == pid
	}
	if !found {
		return Post{}, errors.New("message not found")
	}
	now := time.Now()
	verb := "Moved"
	if copy {
		verb = "Copied"
	}
	ids := map[string]string{}
	var main Post
	for i, p := range group {
		c := *p
		if copy {
			c.ID = randomHex(8)
			c.Saved, c.RemindAt, c.Pinned = false, time.Time{}, false
		}
		ids[p.ID] = c.ID
		if p.ID == pid {
			c.Parent = "" // a reply becomes a message of its own there
			c.Via = fmt.Sprintf("%s from “%s” · first posted %s", verb, src.Title, p.At.Local().Format("2 Jan 15:04"))
		} else if np, ok := ids[p.Parent]; ok {
			c.Parent = np
		}
		c.At = now.Add(time.Duration(i) * time.Millisecond) // keeps their order, at the end
		for _, m := range reAttachRef.FindAllStringSubmatch(c.HTML, -1) {
			if !hasFile(dst.Files, m[1]) {
				if a := s.workAttachment(m[1]); a != nil {
					dst.Files = append(dst.Files, *a)
				}
			}
		}
		dst.Posts = append(dst.Posts, &c)
		if p.ID == pid {
			main = c
		}
	}
	dst.Updated = now
	if !copy {
		keep := src.Posts[:0]
		for _, p := range src.Posts {
			if _, moved := ids[p.ID]; !moved {
				keep = append(keep, p)
			}
		}
		for i := len(keep); i < len(src.Posts); i++ {
			src.Posts[i] = nil
		}
		src.Posts = keep
	}
	s.changed()
	return main, nil
}

func hasFile(files []Attachment, id string) bool {
	for _, f := range files {
		if f.ID == id {
			return true
		}
	}
	return false
}

func (a *App) handlePostMove(w http.ResponseWriter, r *http.Request) {
	var in struct {
		To   string `json:"to"`
		Copy bool   `json:"copy"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	p, err := a.store.MovePost(r.PathValue("id"), r.PathValue("pid"), in.To, in.Copy)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	writeJSON(w, p)
}

// captureToThread adds copied text to the thread chosen with "Capture here"
// or, when none is chosen, to the General thread; "off" means no thread
// (called from Ingest, with s.mu held).
func (s *Store) captureToThread(text, clipID, from string, now time.Time) {
	w := s.captureTarget(text, now)
	if w == nil {
		return
	}
	w.Posts = append(w.Posts, &Post{ID: randomHex(8), At: now, Kind: "capture", Text: text, Ref: clipID, From: from})
	w.Updated = now
}

// captureTarget is the thread a capture goes to: the one with "Capture here";
// else the thread linked to a Jira key mentioned in the text (PAY-123 →
// the PAY-123 thread); else General. nil = none (off, or archived).
func (s *Store) captureTarget(text string, now time.Time) *WorkItem {
	var w *WorkItem
	switch id := s.st.Settings.ActiveThread; id {
	case "off":
		return nil
	case "":
	default:
		w = s.workItem(id) // nil if that thread was deleted
	}
	if w == nil {
		for _, k := range jiraKeysIn(text) {
			for _, t := range s.st.WorkItems {
				if t.Jira == k && !t.Archived {
					return t
				}
			}
		}
		w = s.generalThread(now)
	}
	if w == nil || w.Archived {
		return nil
	}
	return w
}

var reJiraKeyAll = regexp.MustCompile(`\b[A-Z][A-Z0-9_]+-\d+\b`)

func jiraKeysIn(text string) []string { return reJiraKeyAll.FindAllString(text, 20) }

// CaptureImage posts a copied picture (a screenshot) to the capture thread.
func (s *Store) CaptureImage(png []byte, from string) (*WorkItem, error) {
	name := "screenshot-" + time.Now().Format("2006-01-02-15-04-05") + ".png"
	at, err := s.storeAttachment(name, png)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	w := s.captureTarget("", now)
	if w == nil {
		_ = os.Remove(filepath.Join(s.attachDir(), at.ID))
		return nil, nil
	}
	w.Files = append(w.Files, at)
	w.Posts = append(w.Posts, &Post{ID: randomHex(8), At: now, Kind: "capture", From: from,
		HTML: fmt.Sprintf(`<p><img src="/api/props/files/%s" alt="%s"></p>`, at.ID, html.EscapeString(at.Name))})
	w.Updated = now
	s.changed()
	return w, nil
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
	p, err := a.store.AddPost(r.PathValue("id"), Post{Kind: in.Kind, HTML: in.HTML, Text: in.Text, Ref: in.Ref, At: in.At, Parent: in.Parent, Pinned: in.Pinned,
		Reactions: in.Reactions, Saved: in.Saved, From: in.From})
	if err != nil {
		writeErr(w, 404, err)
		return
	}
	a.store.MarkRead(r.PathValue("id")) // you just wrote it: nothing new to you
	_, _ = a.store.writeWorkDocx(r.PathValue("id"))
	writeJSON(w, p)
}

func (a *App) handlePostEdit(w http.ResponseWriter, r *http.Request) {
	var in PostPatch
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	if err := a.store.PatchPost(r.PathValue("id"), r.PathValue("pid"), in); err != nil {
		writeErr(w, 404, err)
		return
	}
	if in.HTML != nil || in.Pinned != nil { // what the Word copy shows
		_, _ = a.store.writeWorkDocx(r.PathValue("id"))
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (a *App) handleWorkRead(w http.ResponseWriter, r *http.Request) {
	a.store.MarkRead(r.PathValue("id"))
	writeJSON(w, map[string]bool{"ok": true})
}

func (a *App) handleWorkStar(w http.ResponseWriter, r *http.Request) {
	var in struct{ Starred bool }
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	if err := a.store.StarWork(r.PathValue("id"), in.Starred); err != nil {
		writeErr(w, 404, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

// handleMarked: GET /api/work/saved and /api/work/reminders.
func (a *App) handleMarked(reminders bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) { writeJSON(w, a.store.MarkedPosts(reminders)) }
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
	w := &WorkItem{ID: randomHex(8), Title: "General", Status: "doing", General: true, Blocks: []*Block{}, Created: now, Updated: now, ReadAt: now}
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
