package main

// Sub-threads: a thread can sit under another one (drag it onto it in the
// thread list), like a tree. Searching inside a thread also finds matching
// messages in all the threads under it.

import (
	"errors"
	"net/http"
	"sort"
	"strings"
	"time"
)

// SetWorkParent puts thread id under parent ("" = back to the top level).
// A thread can't go under itself or under one of its own sub-threads.
func (s *Store) SetWorkParent(id, parent string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	w := s.workItem(id)
	if w == nil {
		return errors.New("thread not found")
	}
	if parent != "" {
		if s.workItem(parent) == nil {
			return errors.New("that thread no longer exists")
		}
		for p := parent; p != ""; { // walk up from the new parent: it must not reach this thread
			if p == id {
				return errors.New("a thread can't go under itself or one of its own sub-threads")
			}
			x := s.workItem(p)
			if x == nil {
				break
			}
			p = x.Parent
		}
	}
	w.Parent = parent
	w.Updated = time.Now()
	s.changed()
	return nil
}

// subThreads: the threads under id, at any depth (caller holds the lock).
func (s *Store) subThreads(id string) []*WorkItem {
	var out []*WorkItem
	seen := map[string]bool{id: true}
	queue := []string{id}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for _, w := range s.st.WorkItems {
			if w.Parent == cur && !seen[w.ID] {
				seen[w.ID] = true
				out = append(out, w)
				queue = append(queue, w.ID)
			}
		}
	}
	return out
}

type subHit struct {
	Thread string    `json:"thread"`
	Title  string    `json:"title"`
	Post   string    `json:"post"`
	At     time.Time `json:"at"`
	From   string    `json:"from,omitempty"`
	Reply  bool      `json:"reply,omitempty"`
	Snip   string    `json:"snip"`
}

// SearchSubThreads: messages in the threads under id that contain every word.
func (s *Store) SearchSubThreads(id string, words []string) []subHit {
	out := []subHit{}
	if len(words) == 0 {
		return out
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, w := range s.subThreads(id) {
		for _, p := range w.Posts {
			t := postPlain(p)
			low := strings.ToLower(t)
			ok := true
			for _, x := range words {
				ok = ok && strings.Contains(low, x)
			}
			if ok {
				out = append(out, subHit{Thread: w.ID, Title: w.Title, Post: p.ID, At: p.At, From: p.From, Reply: p.Parent != "", Snip: snipAround(t, words)})
			}
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].At.After(out[j].At) })
	if len(out) > 200 {
		out = out[:200]
	}
	return out
}

func (a *App) handleWorkParent(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Parent string `json:"parent"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	if err := a.store.SetWorkParent(r.PathValue("id"), in.Parent); err != nil {
		writeErr(w, 400, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (a *App) handleSubSearch(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, a.store.SearchSubThreads(r.PathValue("id"), strings.Fields(strings.ToLower(r.URL.Query().Get("q")))))
}
