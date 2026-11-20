package main

// Properties: a tree of applications/environments. Each node holds free-text
// instructions plus attached files (properties files, configs, documents)
// and screenshots. File contents are stored encrypted in <data>/attachments.

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

type PropNode struct {
	ID       string       `json:"id"`
	ParentID string       `json:"parent_id,omitempty"`
	Name     string       `json:"name"`
	Text     string       `json:"text,omitempty"` // instructions
	Order    int          `json:"order"`
	Files    []Attachment `json:"files,omitempty"`
	Created  time.Time    `json:"created"`
	Updated  time.Time    `json:"updated"`
}

type Attachment struct {
	ID    string    `json:"id"`
	Name  string    `json:"name"`
	Size  int64     `json:"size"`
	Mime  string    `json:"mime"`
	Image bool      `json:"image"`
	Text  bool      `json:"text"` // editable in the app
	Added time.Time `json:"added"`
}

const maxAttachment = 50 << 20

func (s *Store) attachDir() string { return filepath.Join(filepath.Dir(s.path), "attachments") }

func (s *Store) PropNodes() []PropNode {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]PropNode, 0, len(s.st.Props))
	for _, n := range s.st.Props {
		out = append(out, *n)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].Order < out[j].Order || out[i].Order == out[j].Order && out[i].Name < out[j].Name
	})
	return out
}

func (s *Store) propNode(id string) *PropNode {
	for _, n := range s.st.Props {
		if n.ID == id {
			return n
		}
	}
	return nil
}

func (s *Store) SavePropNode(in PropNode) (PropNode, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	in.Name = strings.TrimSpace(in.Name)
	if in.ParentID != "" && s.propNode(in.ParentID) == nil {
		return PropNode{}, errors.New("parent not found")
	}
	if n := s.propNode(in.ID); n != nil {
		// Moving under one of its own children would make a loop.
		for p := s.propNode(in.ParentID); p != nil; p = s.propNode(p.ParentID) {
			if p.ID == n.ID {
				return PropNode{}, errors.New("cannot move a node inside itself")
			}
		}
		n.Name, n.Text, n.ParentID, n.Order, n.Updated = orDefault(in.Name, n.Name), in.Text, in.ParentID, in.Order, now
		s.changed()
		return *n, nil
	}
	n := &PropNode{ID: randomHex(8), ParentID: in.ParentID, Name: orDefault(in.Name, "New node"), Text: in.Text, Order: in.Order, Created: now, Updated: now}
	s.st.Props = append(s.st.Props, n)
	s.changed()
	return *n, nil
}

// DeletePropNode removes a node, its children and their files.
func (s *Store) DeletePropNode(id string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	gone := map[string]bool{id: true}
	for changed := true; changed; {
		changed = false
		for _, n := range s.st.Props {
			if !gone[n.ID] && gone[n.ParentID] {
				gone[n.ID], changed = true, true
			}
		}
	}
	kept := s.st.Props[:0]
	for _, n := range s.st.Props {
		if gone[n.ID] {
			for _, f := range n.Files {
				_ = os.Remove(filepath.Join(s.attachDir(), f.ID))
			}
			continue
		}
		kept = append(kept, n)
	}
	s.st.Props = kept
	s.changed()
	return len(gone)
}

func isTextContent(name string, b []byte) bool {
	if len(b) > 5<<20 || bytes.IndexByte(b, 0) >= 0 || !utf8.Valid(b) {
		return false
	}
	switch strings.ToLower(filepath.Ext(name)) {
	case ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".pdf", ".zip", ".jar", ".docx", ".xlsx":
		return false
	}
	return true
}

// AddAttachment stores an encrypted copy of a file on a node.
func (s *Store) AddAttachment(nodeID, name string, data []byte) (Attachment, error) {
	if len(data) > maxAttachment {
		return Attachment{}, fmt.Errorf("%s is larger than 50 MB", name)
	}
	blob, err := s.encrypt(data)
	if err != nil {
		return Attachment{}, err
	}
	a := Attachment{ID: randomHex(10), Name: filepath.Base(strings.ReplaceAll(name, `\`, "/")), Size: int64(len(data)), Added: time.Now()}
	a.Mime = mime.TypeByExtension(strings.ToLower(filepath.Ext(a.Name)))
	if a.Mime == "" {
		a.Mime = http.DetectContentType(data)
	}
	a.Image = strings.HasPrefix(a.Mime, "image/")
	a.Text = !a.Image && isTextContent(a.Name, data)
	if err := os.MkdirAll(s.attachDir(), 0o700); err != nil {
		return Attachment{}, err
	}
	if err := os.WriteFile(filepath.Join(s.attachDir(), a.ID), blob, 0o600); err != nil {
		return Attachment{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	n := s.propNode(nodeID)
	if n == nil {
		_ = os.Remove(filepath.Join(s.attachDir(), a.ID))
		return Attachment{}, errors.New("node not found")
	}
	n.Files = append(n.Files, a)
	n.Updated = time.Now()
	s.changed()
	return a, nil
}

func (s *Store) findAttachment(id string) (*PropNode, int) {
	for _, n := range s.st.Props {
		for i, f := range n.Files {
			if f.ID == id {
				return n, i
			}
		}
	}
	return nil, -1
}

func (s *Store) ReadAttachment(id string) (Attachment, []byte, error) {
	s.mu.RLock()
	n, i := s.findAttachment(id)
	var a Attachment
	if n != nil {
		a = n.Files[i]
	}
	s.mu.RUnlock()
	if n == nil {
		return a, nil, errors.New("file not found")
	}
	blob, err := os.ReadFile(filepath.Join(s.attachDir(), id))
	if err != nil {
		return a, nil, err
	}
	data, err := s.decrypt(blob)
	return a, data, err
}

// WriteAttachment replaces a text file's content (edited in the app).
func (s *Store) WriteAttachment(id string, data []byte) (Attachment, error) {
	blob, err := s.encrypt(data)
	if err != nil {
		return Attachment{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	n, i := s.findAttachment(id)
	if n == nil {
		return Attachment{}, errors.New("file not found")
	}
	if err := os.WriteFile(filepath.Join(s.attachDir(), id), blob, 0o600); err != nil {
		return Attachment{}, err
	}
	n.Files[i].Size = int64(len(data))
	n.Files[i].Added = time.Now()
	n.Updated = time.Now()
	s.changed()
	return n.Files[i], nil
}

func (s *Store) DeleteAttachment(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	n, i := s.findAttachment(id)
	if n == nil {
		return errors.New("file not found")
	}
	n.Files = append(n.Files[:i], n.Files[i+1:]...)
	s.changed()
	return os.Remove(filepath.Join(s.attachDir(), id))
}

// SearchProps returns ids of nodes whose name, instructions, file names or
// text-file contents contain q.
func (s *Store) SearchProps(q string) []string {
	q = strings.ToLower(strings.TrimSpace(q))
	hits := []string{}
	for _, n := range s.PropNodes() {
		hit := strings.Contains(strings.ToLower(n.Name+" "+n.Text), q)
		for _, f := range n.Files {
			if hit {
				break
			}
			if strings.Contains(strings.ToLower(f.Name), q) {
				hit = true
			} else if f.Text {
				if _, b, err := s.ReadAttachment(f.ID); err == nil && strings.Contains(strings.ToLower(string(b)), q) {
					hit = true
				}
			}
		}
		if hit {
			hits = append(hits, n.ID)
		}
	}
	return hits
}

// ---- HTTP ----

func (a *App) handlePropsList(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, a.store.PropNodes())
}

func (a *App) handlePropsSave(w http.ResponseWriter, r *http.Request) {
	var in PropNode
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	n, err := a.store.SavePropNode(in)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	writeJSON(w, n)
}

func (a *App) handlePropsDelete(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]int{"deleted": a.store.DeletePropNode(r.PathValue("id"))})
}

func (a *App) handlePropsUpload(w http.ResponseWriter, r *http.Request) {
	mr, err := r.MultipartReader()
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	var added []Attachment
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
		at, err := a.store.AddAttachment(r.PathValue("id"), part.FileName(), data)
		if err != nil {
			writeErr(w, 400, err)
			return
		}
		added = append(added, at)
	}
	writeJSON(w, added)
}

func (a *App) handlePropsFile(w http.ResponseWriter, r *http.Request) {
	at, data, err := a.store.ReadAttachment(r.PathValue("aid"))
	if err != nil {
		writeErr(w, 404, err)
		return
	}
	w.Header().Set("Content-Type", orDefault(at.Mime, "application/octet-stream"))
	disp := "inline"
	if r.URL.Query().Get("download") != "" {
		disp = "attachment"
	}
	w.Header().Set("Content-Disposition", fmt.Sprintf("%s; filename=%q", disp, at.Name))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if !at.Image && disp == "inline" && !strings.HasPrefix(at.Mime, "text/") && at.Mime != "application/pdf" {
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", at.Name))
	}
	if strings.Contains(at.Mime, "html") || strings.Contains(at.Mime, "svg") { // never run attached pages inside WorkHub
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	}
	_, _ = w.Write(data)
}

func (a *App) handlePropsFileSave(w http.ResponseWriter, r *http.Request) {
	data, err := io.ReadAll(io.LimitReader(r.Body, maxAttachment+1))
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	at, err := a.store.WriteAttachment(r.PathValue("aid"), data)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	writeJSON(w, at)
}

func (a *App) handlePropsFileDelete(w http.ResponseWriter, r *http.Request) {
	if err := a.store.DeleteAttachment(r.PathValue("aid")); err != nil {
		writeErr(w, 400, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (a *App) handlePropsSearch(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, a.store.SearchProps(r.URL.Query().Get("q")))
}
