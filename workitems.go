package main

// Work items: one page per ticket/change/incident in Notepad++, made of
// blocks in order — notes, links, screenshots and files. Files are stored
// encrypted with the same attachment store as Properties.

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"
)

type WorkItem struct {
	ID      string    `json:"id"`
	Title   string    `json:"title"`
	Status  string    `json:"status"` // todo, doing, blocked, done
	Tags    []string  `json:"tags,omitempty"`
	Blocks  []*Block  `json:"blocks"`
	Created time.Time `json:"created"`
	Updated time.Time `json:"updated"`
}

type Block struct {
	ID    string      `json:"id"`
	Kind  string      `json:"kind"` // text, link, image, file
	Text  string      `json:"text,omitempty"`
	URL   string      `json:"url,omitempty"`
	Title string      `json:"title,omitempty"`
	File  *Attachment `json:"file,omitempty"`
	Added time.Time   `json:"added"`
}

func (s *Store) workItem(id string) *WorkItem {
	for _, w := range s.st.WorkItems {
		if w.ID == id {
			return w
		}
	}
	return nil
}

func (s *Store) WorkItems() []WorkItem {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []WorkItem{}
	for _, w := range s.st.WorkItems {
		c := *w
		c.Blocks = append([]*Block(nil), w.Blocks...)
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Updated.After(out[j].Updated) })
	return out
}

func (s *Store) GetWorkItem(id string) (WorkItem, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	w := s.workItem(id)
	if w == nil {
		return WorkItem{}, false
	}
	c := *w
	c.Blocks = append([]*Block{}, w.Blocks...)
	return c, true
}

func (s *Store) SaveWorkItem(in WorkItem) WorkItem {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	if w := s.workItem(in.ID); w != nil {
		w.Title, w.Status, w.Tags, w.Updated = orDefault(strings.TrimSpace(in.Title), w.Title), orDefault(in.Status, w.Status), in.Tags, now
		s.changed()
		return *w
	}
	w := &WorkItem{ID: randomHex(8), Title: orDefault(strings.TrimSpace(in.Title), "New work item"), Status: orDefault(in.Status, "todo"),
		Tags: in.Tags, Blocks: []*Block{}, Created: now, Updated: now}
	s.st.WorkItems = append(s.st.WorkItems, w)
	s.changed()
	return *w
}

func (s *Store) DeleteWorkItem(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, w := range s.st.WorkItems {
		if w.ID == id {
			for _, b := range w.Blocks {
				if b.File != nil {
					_ = removeFile(s.attachDir(), b.File.ID)
				}
			}
			s.st.WorkItems = append(s.st.WorkItems[:i], s.st.WorkItems[i+1:]...)
			s.changed()
			return
		}
	}
}

func (s *Store) AddBlock(id string, b Block) (Block, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	w := s.workItem(id)
	if w == nil {
		return Block{}, errors.New("work item not found")
	}
	b.ID, b.Added = randomHex(8), time.Now()
	w.Blocks = append(w.Blocks, &b)
	w.Updated = b.Added
	s.changed()
	return b, nil
}

// UpdateBlock edits a block's text/title; dir "up"/"down" moves it.
func (s *Store) UpdateBlock(id, bid string, text, title *string, dir string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	w := s.workItem(id)
	if w == nil {
		return errors.New("work item not found")
	}
	for i, b := range w.Blocks {
		if b.ID != bid {
			continue
		}
		if text != nil {
			b.Text = *text
		}
		if title != nil {
			b.Title = *title
		}
		if dir == "up" && i > 0 {
			w.Blocks[i-1], w.Blocks[i] = w.Blocks[i], w.Blocks[i-1]
		} else if dir == "down" && i < len(w.Blocks)-1 {
			w.Blocks[i+1], w.Blocks[i] = w.Blocks[i], w.Blocks[i+1]
		}
		w.Updated = time.Now()
		s.changed()
		return nil
	}
	return errors.New("block not found")
}

func (s *Store) DeleteBlock(id, bid string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	w := s.workItem(id)
	if w == nil {
		return errors.New("work item not found")
	}
	for i, b := range w.Blocks {
		if b.ID == bid {
			if b.File != nil {
				_ = removeFile(s.attachDir(), b.File.ID)
			}
			w.Blocks = append(w.Blocks[:i], w.Blocks[i+1:]...)
			w.Updated = time.Now()
			s.changed()
			return nil
		}
	}
	return errors.New("block not found")
}

// workAttachment finds a file stored on a work item block (see ReadAttachment).
func (s *Store) workAttachment(aid string) *Attachment {
	for _, w := range s.st.WorkItems {
		for _, b := range w.Blocks {
			if b.File != nil && b.File.ID == aid {
				return b.File
			}
		}
	}
	return nil
}

// ---- HTTP ----

func (a *App) handleWorkList(w http.ResponseWriter, r *http.Request) {
	out := []map[string]any{}
	for _, wi := range a.store.WorkItems() {
		n := map[string]int{}
		var sb strings.Builder
		sb.WriteString(strings.ToLower(wi.Title + " " + strings.Join(wi.Tags, " ")))
		for _, b := range wi.Blocks {
			n[b.Kind]++
			sb.WriteString(" " + strings.ToLower(b.Text+" "+b.URL+" "+b.Title))
			if b.File != nil {
				sb.WriteString(" " + strings.ToLower(b.File.Name))
			}
		}
		out = append(out, map[string]any{"id": wi.ID, "title": wi.Title, "status": wi.Status, "tags": wi.Tags, "updated": wi.Updated,
			"notes": n["text"], "links": n["link"], "images": n["image"], "files": n["file"], "search": sb.String()})
	}
	writeJSON(w, out)
}

func (a *App) handleWorkGet(w http.ResponseWriter, r *http.Request) {
	wi, ok := a.store.GetWorkItem(r.PathValue("id"))
	if !ok {
		writeErr(w, 404, errors.New("work item not found"))
		return
	}
	writeJSON(w, wi)
}

func (a *App) handleWorkSave(w http.ResponseWriter, r *http.Request) {
	var in WorkItem
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	writeJSON(w, a.store.SaveWorkItem(in))
}

func (a *App) handleWorkDelete(w http.ResponseWriter, r *http.Request) {
	a.store.DeleteWorkItem(r.PathValue("id"))
	writeJSON(w, map[string]bool{"ok": true})
}

// handleWorkAdd adds blocks: JSON {kind:"text"|"link", ...} or multipart
// files (images become screenshot blocks, others file blocks).
func (a *App) handleWorkAdd(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/") {
		mr, err := r.MultipartReader()
		if err != nil {
			writeErr(w, 400, err)
			return
		}
		var added []Block
		for {
			part, err := mr.NextPart()
			if err == io.EOF {
				break
			}
			if err != nil {
				writeErr(w, 400, err)
				return
			}
			if part.FileName() == "" {
				continue
			}
			data, err := io.ReadAll(io.LimitReader(part, maxAttachment+1))
			if err != nil {
				writeErr(w, 400, err)
				return
			}
			at, err := a.store.storeAttachment(part.FileName(), data)
			if err != nil {
				writeErr(w, 400, err)
				return
			}
			kind := "file"
			if at.Image {
				kind = "image"
			}
			b, err := a.store.AddBlock(id, Block{Kind: kind, File: &at, Title: at.Name})
			if err != nil {
				writeErr(w, 400, err)
				return
			}
			added = append(added, b)
		}
		writeJSON(w, added)
		return
	}
	var in Block
	if err := json.NewDecoder(io.LimitReader(r.Body, 5<<20)).Decode(&in); err != nil {
		writeErr(w, 400, err)
		return
	}
	if in.Kind != "text" && in.Kind != "link" {
		writeErr(w, 400, errors.New("kind must be text or link"))
		return
	}
	b, err := a.store.AddBlock(id, Block{Kind: in.Kind, Text: in.Text, URL: strings.TrimSpace(in.URL), Title: in.Title})
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	writeJSON(w, []Block{b})
}

func (a *App) handleWorkBlock(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Text  *string `json:"text"`
		Title *string `json:"title"`
		Dir   string  `json:"dir"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	if err := a.store.UpdateBlock(r.PathValue("id"), r.PathValue("bid"), in.Text, in.Title, in.Dir); err != nil {
		writeErr(w, 400, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (a *App) handleWorkBlockDelete(w http.ResponseWriter, r *http.Request) {
	if err := a.store.DeleteBlock(r.PathValue("id"), r.PathValue("bid")); err != nil {
		writeErr(w, 400, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}
