package main

// Search inside task threads for the search across everything: for each
// thread that has every word (in its name or its messages), the messages that
// matched — who, when and a few lines around the match, as written — so the
// result says where it was found and opens the thread at that message.

import (
	"html"
	"net/http"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

type threadHit struct {
	Post  string    `json:"post"`
	At    time.Time `json:"at"`
	Kind  string    `json:"kind"`
	From  string    `json:"from,omitempty"`
	Reply bool      `json:"reply,omitempty"`
	Snip  string    `json:"snip"`
	score int
}

// postPlain is a message's text as you read it.
func postPlain(p *Post) string {
	t := p.Text
	if p.HTML != "" {
		h := strings.NewReplacer("<br>", "\n", "</p>", "\n", "</li>", "\n", "</tr>", "\n", "</div>", "\n").Replace(p.HTML)
		t = strings.TrimSpace(t + "\n" + html.UnescapeString(tagRe.ReplaceAllString(h, " ")))
	}
	return t
}

// snipAround: about three lines of text around the first word found.
func snipAround(text string, words []string) string {
	low := strings.ToLower(text)
	first := -1
	for _, w := range words {
		if i := strings.Index(low, w); i >= 0 && (first < 0 || i < first) {
			first = i
		}
	}
	if first < 0 || len(low) != len(text) {
		first = 0
	}
	start, end := max(0, first-90), min(len(text), first+260)
	for start > 0 && !utf8.RuneStart(text[start]) {
		start--
	}
	for end < len(text) && !utf8.RuneStart(text[end]) {
		end++
	}
	s := strings.Join(strings.Fields(text[start:end]), " ")
	if start > 0 {
		s = "…" + s
	}
	if end < len(text) {
		s += "…"
	}
	return s
}

// SearchThreads: thread id → its best matching messages (at most 3).
func (s *Store) SearchThreads(words []string) map[string][]threadHit {
	out := map[string][]threadHit{}
	if len(words) == 0 {
		return out
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, w := range s.st.WorkItems {
		all := workSearchText(w)
		var hits []threadHit
		for _, p := range w.Posts {
			t := postPlain(p)
			low := strings.ToLower(t)
			n := 0
			for _, x := range words {
				if strings.Contains(low, x) {
					n++
				}
			}
			if n > 0 {
				hits = append(hits, threadHit{Post: p.ID, At: p.At, Kind: p.Kind, From: p.From, Reply: p.Parent != "", Snip: snipAround(t, words), score: n})
			}
		}
		ok := true
		for _, x := range words {
			ok = ok && strings.Contains(all, x)
		}
		if !ok {
			continue
		}
		sort.SliceStable(hits, func(i, j int) bool { // most of the words first, then the newest
			if hits[i].score != hits[j].score {
				return hits[i].score > hits[j].score
			}
			return hits[i].At.After(hits[j].At)
		})
		if len(hits) > 3 {
			hits = hits[:3]
		}
		out[w.ID] = hits
	}
	return out
}

func (a *App) handleThreadSearch(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, a.store.SearchThreads(strings.Fields(strings.ToLower(r.URL.Query().Get("q")))))
}
