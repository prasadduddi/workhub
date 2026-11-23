package main

// Saved SQL snippets: named queries kept with your data (encrypted, in
// backups), either for one connection or for all of them.

import (
	"errors"
	"net/http"
	"sort"
	"strings"
	"time"
)

type Snippet struct {
	ID      string    `json:"id"`
	Name    string    `json:"name"`
	SQL     string    `json:"sql"`
	Conn    string    `json:"conn,omitempty"` // entry id; "" = every connection
	Updated time.Time `json:"updated"`
	Used    int       `json:"used,omitempty"`
}

func (s *Store) Snippets() []Snippet {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Snippet, 0, len(s.st.Snippets))
	for _, x := range s.st.Snippets {
		out = append(out, *x)
	}
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name) })
	return out
}

func (s *Store) SaveSnippet(in Snippet) (Snippet, error) {
	in.Name, in.SQL = strings.TrimSpace(in.Name), strings.TrimSpace(in.SQL)
	if in.Name == "" || in.SQL == "" {
		return Snippet{}, errors.New("a snippet needs a name and some SQL")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	in.Updated = time.Now()
	for _, x := range s.st.Snippets {
		if x.ID == in.ID && in.ID != "" {
			in.Used = max(in.Used, x.Used)
			*x = in
			s.changed()
			return in, nil
		}
	}
	in.ID = randomHex(8)
	s.st.Snippets = append(s.st.Snippets, &in)
	s.changed()
	return in, nil
}

func (s *Store) UseSnippet(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, x := range s.st.Snippets {
		if x.ID == id {
			x.Used++
			s.changed()
		}
	}
}

func (s *Store) DeleteSnippet(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, x := range s.st.Snippets {
		if x.ID == id {
			s.st.Snippets = append(s.st.Snippets[:i], s.st.Snippets[i+1:]...)
			s.changed()
			return
		}
	}
}

func (a *App) handleSnippets(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, a.store.Snippets())
}

func (a *App) handleSaveSnippet(w http.ResponseWriter, r *http.Request) {
	var in Snippet
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	out, err := a.store.SaveSnippet(in)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	writeJSON(w, out)
}

func (a *App) handleUseSnippet(w http.ResponseWriter, r *http.Request) {
	a.store.UseSnippet(r.PathValue("id"))
	writeJSON(w, map[string]bool{"ok": true})
}

func (a *App) handleDeleteSnippet(w http.ResponseWriter, r *http.Request) {
	a.store.DeleteSnippet(r.PathValue("id"))
	writeJSON(w, map[string]bool{"ok": true})
}
