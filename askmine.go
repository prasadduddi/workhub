package main

// 🔎 Ask → "My threads & notes": your own WorkHub threads (every message) and
// notes are searched too, on this PC, next to Confluence and Jira. With AI answers
// switched on, the best matches go to the AI like the other results.

import (
	"sort"
	"strings"
)

// mineSearch: threads and notes with every word (or, when anyWord, any of them).
func (a *App) mineSearch(words []string, anyWord bool, limit int) []askResult {
	if len(words) == 0 {
		return nil
	}
	match := func(low string) (n int, ok bool) {
		for _, w := range words {
			if strings.Contains(low, w) {
				n++
			}
		}
		return n, n == len(words) || (anyWord && n > 0)
	}
	s := a.store
	s.mu.RLock()
	defer s.mu.RUnlock()
	type hit struct {
		r askResult
		n int
	}
	var hits []hit
	for _, w := range s.st.WorkItems {
		var b strings.Builder
		b.WriteString(w.Title + " " + w.Jira + " " + strings.Join(w.Tags, " ") + "\n")
		updated := w.Updated
		for _, p := range w.Posts {
			b.WriteString(postPlain(p) + "\n")
			if p.At.After(updated) {
				updated = p.At
			}
		}
		text := b.String()
		n, ok := match(strings.ToLower(text))
		if !ok {
			continue
		}
		kind := "thread"
		if w.Archived {
			kind = "thread (archived)"
		}
		hits = append(hits, hit{askResult{Source: "workhub", ID: "thread:" + w.ID, Title: w.Title, URL: "workhub:thread/" + w.ID,
			Kind: kind, Snip: snipAround(text, words), Updated: updated, text: lastRunes(text, 4000)}, n})
	}
	for _, nt := range s.st.Notes {
		text := nt.Title + "\n" + nt.Body
		n, ok := match(strings.ToLower(text))
		if !ok {
			continue
		}
		hits = append(hits, hit{askResult{Source: "workhub", ID: "note:" + nt.ID, Title: orDefault(nt.Title, "Note"), URL: "workhub:note/" + nt.ID,
			Kind: "note", Snip: snipAround(text, words), Updated: nt.Updated, text: lastRunes(text, 4000)}, n})
	}
	sort.SliceStable(hits, func(i, j int) bool {
		if hits[i].n != hits[j].n {
			return hits[i].n > hits[j].n
		}
		return hits[i].r.Updated.After(hits[j].r.Updated)
	})
	out := []askResult{}
	for i := 0; i < len(hits) && i < limit; i++ {
		out = append(out, hits[i].r)
	}
	return out
}

// lastRunes: the newest part of a long thread (what was said last matters most).
func lastRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return "… " + string(r[len(r)-n:])
}
