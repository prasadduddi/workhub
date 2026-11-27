package main

// 🗑 Recycle bin: deleted threads, connections and notes are kept for 30 days
// (File → Recycle bin…) and can be put back; a thread's files stay until it is
// removed for good (after 30 days, "Delete forever" or "Empty the bin").

import (
	"errors"
	"net/http"
	"sort"
	"time"
)

const binDays = 30

type BinItem struct {
	ID      string    `json:"id"`
	Kind    string    `json:"kind"` // thread, entry, note
	Title   string    `json:"title"`
	Ref     string    `json:"ref,omitempty"` // the thread / connection / note's own id
	Deleted time.Time `json:"deleted"`
	Entry   *Entry    `json:"entry,omitempty"`
	Note    *Note     `json:"note,omitempty"`
	Thread  *WorkItem `json:"thread,omitempty"`
}

// toBin keeps a deleted thing (caller holds the lock).
func (s *Store) toBin(it BinItem) {
	it.ID, it.Deleted = randomHex(8), time.Now()
	s.st.Bin = append(s.st.Bin, it)
}

// threadFiles: the files of a thread no other thread shows (caller holds the lock).
func (s *Store) removeThreadFiles(w *WorkItem) {
	for _, b := range w.Blocks {
		if b.File != nil && s.workAttachment(b.File.ID) == nil {
			_ = removeFile(s.attachDir(), b.File.ID)
		}
	}
	for _, f := range w.Files {
		if s.workAttachment(f.ID) == nil {
			_ = removeFile(s.attachDir(), f.ID)
		}
	}
}

// purgeBin removes what has been in the bin longer than 30 days (or everything / one item).
func (s *Store) purgeBin(all bool, id string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	keep := s.st.Bin[:0:0]
	n := 0
	for _, it := range s.st.Bin {
		if all || it.ID == id || (id == "" && time.Since(it.Deleted) > binDays*24*time.Hour) {
			if it.Thread != nil {
				s.removeThreadFiles(it.Thread)
			}
			n++
			continue
		}
		keep = append(keep, it)
	}
	if n > 0 {
		s.st.Bin = keep
		s.changed()
	}
	return n
}

func (s *Store) BinItems() []BinItem {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]BinItem, 0, len(s.st.Bin))
	for _, it := range s.st.Bin {
		ref := ""
		switch {
		case it.Entry != nil:
			ref = it.Entry.ID
		case it.Note != nil:
			ref = it.Note.ID
		case it.Thread != nil:
			ref = it.Thread.ID
		}
		out = append(out, BinItem{ID: it.ID, Kind: it.Kind, Title: it.Title, Ref: ref, Deleted: it.Deleted})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Deleted.After(out[j].Deleted) })
	return out
}

// RestoreBin puts a deleted thing back.
func (s *Store) RestoreBin(id string) (BinItem, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, it := range s.st.Bin {
		if it.ID != id {
			continue
		}
		switch {
		case it.Entry != nil:
			s.st.Entries = append(s.st.Entries, it.Entry)
		case it.Note != nil:
			s.st.Notes = append(s.st.Notes, it.Note)
		case it.Thread != nil:
			if it.Thread.Parent != "" && s.workItem(it.Thread.Parent) == nil {
				it.Thread.Parent = "" // its thread is gone: back at the top level
			}
			it.Thread.General = false
			s.st.WorkItems = append(s.st.WorkItems, it.Thread)
		}
		s.st.Bin = append(s.st.Bin[:i], s.st.Bin[i+1:]...)
		s.changed()
		return BinItem{ID: it.ID, Kind: it.Kind, Title: it.Title}, nil
	}
	return BinItem{}, errors.New("not in the recycle bin any more")
}

// binLoop empties what is older than 30 days, at start and once a day.
func (a *App) binLoop() {
	for {
		a.store.purgeBin(false, "")
		time.Sleep(24 * time.Hour)
	}
}

func (a *App) handleBinList(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]any{"items": a.store.BinItems(), "days": binDays})
}

func (a *App) handleBinRestore(w http.ResponseWriter, r *http.Request) {
	it, err := a.store.RestoreBin(r.PathValue("id"))
	if err != nil {
		writeErr(w, 404, err)
		return
	}
	writeJSON(w, it)
}

func (a *App) handleBinDelete(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]int{"removed": a.store.purgeBin(false, r.PathValue("id"))})
}

func (a *App) handleBinEmpty(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]int{"removed": a.store.purgeBin(true, "")})
}
