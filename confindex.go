package main

// Confluence local index (⚙ Settings → Ask): the pages of the spaces you pick
// are downloaded once and kept in WorkHub's data folder (encrypted), then
// kept up to date — changed and new pages every hour (⚙ Settings → Ask), a full check once
// a day that also drops deleted / moved pages. 🔎 Ask searches this copy
// instantly (offline too) with word endings matched (restart ≈ restarting),
// the best passage of each page scored (BM25), titles, all-words and exact
// phrases counting extra. Live Confluence search still adds pages from other
// spaces when it can be reached.

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

type ConfIndexConfig struct {
	On     bool     `json:"on"`
	Spaces []string `json:"spaces,omitempty"` // space keys
	Every  int      `json:"every,omitempty"`  // minutes between syncs of changed pages (0 = 60)
}

// every: how often changed pages are fetched (default one hour, 15 minutes at the least).
func (c ConfIndexConfig) every() time.Duration {
	m := c.Every
	if m <= 0 {
		m = 60
	}
	return time.Duration(max(m, 15)) * time.Minute
}

func (s *Store) ConfIndexConfig() ConfIndexConfig {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.st.ConfIndex
}

func (s *Store) SetConfIndexConfig(c ConfIndexConfig) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.st.ConfIndex = c
	s.changed()
}

type ciPage struct {
	ID      string    `json:"id"`
	Space   string    `json:"space"`
	SpaceN  string    `json:"space_name,omitempty"`
	Kind    string    `json:"kind,omitempty"`
	Title   string    `json:"title"`
	URL     string    `json:"url"`
	Updated time.Time `json:"updated"`
	Version int       `json:"version"`
	Text    string    `json:"text"`
}

type ciChunk struct {
	page  *ciPage
	text  string
	tf    map[string]int
	n     int
	title map[string]bool
}

type confIndex struct {
	mu       sync.RWMutex
	Pages    map[string]*ciPage   `json:"pages"`
	Synced   map[string]time.Time `json:"synced"`    // space → last sync (changed pages since)
	FullAt   map[string]time.Time `json:"full_at"`   // space → last full check
	LastSync time.Time            `json:"last_sync"` // any space
	chunks   []*ciChunk
	df       map[string]int
	avg      float64
	loaded   bool
	running  bool
	progress string
	lastErr  string
}

var cidx = &confIndex{}

const (
	ciFullDays = 24 * time.Hour
	ciMaxPages = 20000
	ciMaxText  = 200000
	ciChunkLen = 700
)

func (s *Store) confIndexPath() string {
	return filepath.Join(filepath.Dir(s.path), "confluence-index.dat")
}

// ---- load / save (gzip, then WorkHub's encryption) ----

func (a *App) ciLoad() {
	cidx.mu.Lock()
	defer cidx.mu.Unlock()
	if cidx.loaded {
		return
	}
	cidx.loaded = true
	cidx.Pages, cidx.Synced, cidx.FullAt = map[string]*ciPage{}, map[string]time.Time{}, map[string]time.Time{}
	blob, err := os.ReadFile(a.store.confIndexPath())
	if err != nil {
		return
	}
	plain, err := a.store.decrypt(blob)
	if err != nil {
		cidx.lastErr = "the saved index couldn't be read — Rebuild it"
		return
	}
	zr, err := gzip.NewReader(bytes.NewReader(plain))
	if err != nil {
		return
	}
	var saved struct {
		Pages    map[string]*ciPage   `json:"pages"`
		Synced   map[string]time.Time `json:"synced"`
		FullAt   map[string]time.Time `json:"full_at"`
		LastSync time.Time            `json:"last_sync"`
	}
	if json.NewDecoder(zr).Decode(&saved) == nil {
		if saved.Pages != nil {
			cidx.Pages = saved.Pages
		}
		if saved.Synced != nil {
			cidx.Synced = saved.Synced
		}
		if saved.FullAt != nil {
			cidx.FullAt = saved.FullAt
		}
		cidx.LastSync = saved.LastSync
	}
	cidx.rebuild()
}

// ciSave: caller holds cidx.mu (read is enough).
func (a *App) ciSave() error {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if err := json.NewEncoder(zw).Encode(map[string]any{"pages": cidx.Pages, "synced": cidx.Synced, "full_at": cidx.FullAt, "last_sync": cidx.LastSync}); err != nil {
		return err
	}
	_ = zw.Close()
	blob, err := a.store.encrypt(buf.Bytes())
	if err != nil {
		return err
	}
	p := a.store.confIndexPath()
	if err := os.WriteFile(p+".tmp", blob, 0o600); err != nil {
		return err
	}
	return os.Rename(p+".tmp", p)
}

// ---- words: lower case, common endings off (restarting → restart) ----

var ciWordRe = regexp.MustCompile(`[\p{L}\p{N}]+`)

func ciStem(w string) string {
	n := len(w)
	switch {
	case n > 5 && strings.HasSuffix(w, "ies"):
		return w[:n-3] + "y"
	case n > 5 && strings.HasSuffix(w, "ing"):
		w = w[:n-3]
	case n > 4 && strings.HasSuffix(w, "ed"):
		w = w[:n-2]
	case n > 4 && strings.HasSuffix(w, "es") && !strings.HasSuffix(w, "ses"):
		w = w[:n-2]
	case n > 3 && strings.HasSuffix(w, "s") && !strings.HasSuffix(w, "ss"):
		w = w[:n-1]
	case n > 5 && strings.HasSuffix(w, "ly"):
		w = w[:n-2]
	}
	if m := len(w); m > 3 && w[m-1] == w[m-2] && !strings.ContainsRune("lsz", rune(w[m-1])) { // stopp(ed) → stop
		w = w[:m-1]
	}
	if m := len(w); m > 3 && w[m-1] == 'e' { // restore/restored → restor
		w = w[:m-1]
	}
	return w
}

func ciTerms(text string) []string {
	var out []string
	for _, w := range ciWordRe.FindAllString(strings.ToLower(text), -1) {
		if len(w) < 2 || askStop[w] {
			continue
		}
		out = append(out, ciStem(w))
	}
	return out
}

// rebuild: passages and word counts for searching (caller holds the lock).
func (x *confIndex) rebuild() {
	x.chunks, x.df = nil, map[string]int{}
	total := 0
	for _, p := range x.Pages {
		title := map[string]bool{}
		for _, t := range ciTerms(p.Title) {
			title[t] = true
		}
		for _, part := range ciSplit(p.Text) {
			c := &ciChunk{page: p, text: part, tf: map[string]int{}, title: title}
			for _, t := range ciTerms(part) {
				c.tf[t]++
				c.n++
			}
			for t := range title { // the title belongs to every passage of its page
				c.tf[t]++
				c.n++
			}
			for t := range c.tf {
				x.df[t]++
			}
			total += c.n
			x.chunks = append(x.chunks, c)
		}
	}
	if len(x.chunks) > 0 {
		x.avg = float64(total) / float64(len(x.chunks))
	}
}

// ciSplit: a page's text in passages of about ciChunkLen characters, at line breaks.
func ciSplit(text string) []string {
	var out []string
	var cur strings.Builder
	for _, line := range strings.Split(text, "\n") {
		if cur.Len() > 0 && cur.Len()+len(line) > ciChunkLen {
			out = append(out, cur.String())
			cur.Reset()
		}
		if cur.Len() > 0 {
			cur.WriteString("\n")
		}
		cur.WriteString(line)
	}
	if cur.Len() > 0 || len(out) == 0 {
		out = append(out, cur.String())
	}
	return out
}

// ---- search ----

func (a *App) ciSearch(q string, limit int) []askResult {
	a.ciLoad()
	cidx.mu.RLock()
	defer cidx.mu.RUnlock()
	terms := ciTerms(q)
	if len(terms) == 0 || len(cidx.chunks) == 0 {
		return nil
	}
	uniq := map[string]bool{}
	for _, t := range terms {
		uniq[t] = true
	}
	N := float64(len(cidx.chunks))
	phrase := strings.ToLower(strings.Join(askWords(q), " "))
	type hit struct {
		c     *ciChunk
		score float64
	}
	best := map[string]hit{}
	second := map[string][]*ciChunk{}
	for _, c := range cidx.chunks {
		s, have := 0.0, 0
		for t := range uniq {
			f := float64(c.tf[t])
			if f == 0 {
				continue
			}
			have++
			idf := math.Log(1 + (N-float64(cidx.df[t])+0.5)/(float64(cidx.df[t])+0.5))
			s += idf * f * 2.2 / (f + 1.2*(0.25+0.75*float64(c.n)/cidx.avg))
			if c.title[t] {
				s += 1.2 * idf // in the title: counts extra
			}
		}
		if have == 0 {
			continue
		}
		s *= 0.5 + float64(have)/float64(len(uniq)) // more of the words: better
		if len(phrase) > 4 && strings.Contains(strings.ToLower(c.text), phrase) {
			s += 3 // the exact phrase
		}
		id := c.page.ID
		if b, ok := best[id]; !ok || s > b.score {
			if ok {
				second[id] = append(second[id], b.c)
			}
			best[id] = hit{c, s}
		} else {
			second[id] = append(second[id], c)
		}
	}
	hits := make([]hit, 0, len(best))
	for _, h := range best {
		hits = append(hits, h)
	}
	sort.Slice(hits, func(i, j int) bool { return hits[i].score > hits[j].score })
	if len(hits) > limit {
		hits = hits[:limit]
	}
	words := askWords(q)
	out := []askResult{}
	for _, h := range hits {
		p := h.c.page
		more := h.c.text // the best passage first, then the page's other passages (for the AI answer)
		for _, c := range second[p.ID] {
			if len(more) > 5000 {
				break
			}
			more += "\n…\n" + c.text
		}
		out = append(out, askResult{Source: "confluence", ID: p.ID, Title: p.Title, URL: p.URL, Where: orDefault(p.SpaceN, p.Space), Kind: orDefault(p.Kind, "page"),
			Snip: snipAround(strings.Join(strings.Fields(h.c.text), " "), words), Updated: p.Updated, text: more, score: h.score})
	}
	return out
}

// ---- sync ----

// storageText: a page's storage-format body as plain text.
func storageText(storage string) string {
	h := strings.NewReplacer("</p>", "\n", "<br/>", "\n", "<br>", "\n", "</li>", "\n", "</tr>", "\n", "</h1>", "\n", "</h2>", "\n", "</h3>", "\n", "</h4>", "\n", "</pre>", "\n").Replace(storage)
	t := html.UnescapeString(tagRe.ReplaceAllString(h, " "))
	var lines []string
	for _, l := range strings.Split(t, "\n") {
		if l = strings.Join(strings.Fields(l), " "); l != "" {
			lines = append(lines, l)
		}
	}
	t = strings.Join(lines, "\n")
	if len(t) > ciMaxText {
		t = t[:ciMaxText]
	}
	return t
}

type ciResults struct {
	Results []struct {
		ID      string `json:"id"`
		Type    string `json:"type"`
		Title   string `json:"title"`
		Version struct {
			Number int    `json:"number"`
			When   string `json:"when"`
		} `json:"version"`
		Space struct {
			Key  string `json:"key"`
			Name string `json:"name"`
		} `json:"space"`
		Body struct {
			Storage struct {
				Value string `json:"value"`
			} `json:"storage"`
		} `json:"body"`
		Links struct {
			WebUI string `json:"webui"`
		} `json:"_links"`
	} `json:"results"`
	Links struct {
		Base string `json:"base"`
		Next string `json:"next"`
	} `json:"_links"`
}

// ciSyncSpace downloads a space's pages: all of them (full: also drops pages
// that are gone) or the ones changed since the last sync.
func (a *App) ciSyncSpace(space string, full bool) (int, error) {
	c, err := a.confEffective()
	if err != nil {
		return 0, err
	}
	started := time.Now()
	cql := fmt.Sprintf(`space = "%s" AND type in (page, blogpost)`, strings.ReplaceAll(space, `"`, ``))
	cidx.mu.RLock()
	since, had := cidx.Synced[space]
	cidx.mu.RUnlock()
	if !full && had {
		cql += fmt.Sprintf(` AND lastmodified >= "%s"`, since.Add(-15*time.Minute).Local().Format("2006/01/02 15:04")) // a margin for clocks
	}
	path := "/rest/api/content/search?cql=" + url.QueryEscape(cql) + "&expand=body.storage,version,space&limit=50"
	seen := map[string]bool{}
	n := 0
	for page := 0; path != "" && page < ciMaxPages/50; page++ {
		var res ciResults
		if err := a.confGet(path, &res); err != nil {
			return n, err
		}
		base := strings.TrimRight(orDefault(res.Links.Base, c.BaseURL), "/")
		cidx.mu.Lock()
		for _, r := range res.Results {
			seen[r.ID] = true
			t, _ := time.Parse(time.RFC3339, r.Version.When)
			if old := cidx.Pages[r.ID]; old != nil && old.Version == r.Version.Number && r.Version.Number > 0 {
				continue // unchanged
			}
			if len(cidx.Pages) >= ciMaxPages && cidx.Pages[r.ID] == nil {
				continue
			}
			cidx.Pages[r.ID] = &ciPage{ID: r.ID, Space: orDefault(r.Space.Key, space), SpaceN: r.Space.Name, Kind: r.Type, Title: r.Title,
				URL: base + r.Links.WebUI, Updated: t, Version: r.Version.Number, Text: storageText(r.Body.Storage.Value)}
			n++
		}
		cidx.progress = fmt.Sprintf("%s: %d pages…", space, len(seen))
		cidx.mu.Unlock()
		next := res.Links.Next
		if next != "" { // relative to the Confluence address (Cloud: /rest/api/…?cursor=…)
			if u, err := url.Parse(next); err == nil && u.IsAbs() {
				next = strings.TrimPrefix(next, strings.TrimRight(c.BaseURL, "/"))
			}
			next = strings.TrimPrefix(next, "/wiki")
		}
		path = next
	}
	cidx.mu.Lock()
	if full { // pages no longer there (deleted, moved, no access): out
		for id, p := range cidx.Pages {
			if p.Space == space && !seen[id] {
				delete(cidx.Pages, id)
				n++
			}
		}
		cidx.FullAt[space] = started
	}
	cidx.Synced[space] = started
	cidx.mu.Unlock()
	return n, nil
}

// ciSync brings the chosen spaces up to date (full = check every page).
func (a *App) ciSync(full bool) error {
	a.ciLoad()
	cfg := a.store.ConfIndexConfig()
	cidx.mu.Lock()
	if cidx.running {
		cidx.mu.Unlock()
		return errors.New("already syncing")
	}
	cidx.running, cidx.lastErr = true, ""
	cidx.mu.Unlock()
	defer func() {
		cidx.mu.Lock()
		cidx.running, cidx.progress = false, ""
		cidx.mu.Unlock()
	}()
	chosen := map[string]bool{}
	var errs []string
	changed := 0
	for _, sp := range cfg.Spaces {
		chosen[sp] = true
		cidx.mu.RLock()
		fullAt := cidx.FullAt[sp]
		cidx.mu.RUnlock()
		n, err := a.ciSyncSpace(sp, full || time.Since(fullAt) > ciFullDays)
		changed += n
		if err != nil {
			errs = append(errs, sp+": "+err.Error())
		}
	}
	cidx.mu.Lock()
	defer cidx.mu.Unlock()
	for id, p := range cidx.Pages { // spaces no longer chosen: out
		if !chosen[p.Space] {
			delete(cidx.Pages, id)
			changed++
		}
	}
	if len(errs) == 0 || changed > 0 {
		cidx.LastSync = time.Now()
	}
	if changed > 0 || full {
		cidx.rebuild()
	}
	if err := a.ciSave(); err != nil {
		errs = append(errs, "saving: "+err.Error())
	}
	if len(errs) > 0 {
		cidx.lastErr = strings.Join(errs, "; ")
		return errors.New(cidx.lastErr)
	}
	return nil
}

// confIndexLoop keeps the index up to date while WorkHub runs.
func (a *App) confIndexLoop() {
	time.Sleep(20 * time.Second)
	a.ciLoad()
	for {
		c := a.store.ConfIndexConfig()
		cidx.mu.RLock()
		due := time.Since(cidx.LastSync) >= c.every()
		cidx.mu.RUnlock()
		if c.On && len(c.Spaces) > 0 && due {
			_ = a.ciSync(false)
		}
		time.Sleep(time.Minute) // checks each minute, so a new interval counts at once
	}
}

// ---- HTTP ----

func (a *App) handleConfIndexStatus(w http.ResponseWriter, r *http.Request) {
	a.ciLoad()
	cfg := a.store.ConfIndexConfig()
	cidx.mu.RLock()
	per := map[string]int{}
	for _, p := range cidx.Pages {
		per[p.Space]++
	}
	out := map[string]any{"on": cfg.On, "spaces": cfg.Spaces, "every": int(cfg.every() / time.Minute), "pages": len(cidx.Pages), "per_space": per, "last_sync": cidx.LastSync,
		"running": cidx.running, "progress": cidx.progress, "error": cidx.lastErr}
	cidx.mu.RUnlock()
	if st, err := os.Stat(a.store.confIndexPath()); err == nil {
		out["size"] = st.Size()
	}
	writeJSON(w, out)
}

func (a *App) handleConfIndexConfig(w http.ResponseWriter, r *http.Request) {
	var c ConfIndexConfig
	if err := readJSON(r, &c); err != nil {
		writeErr(w, 400, err)
		return
	}
	a.store.SetConfIndexConfig(c)
	if c.On && len(c.Spaces) > 0 {
		go func() { _ = a.ciSync(false) }()
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (a *App) handleConfIndexSync(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Full bool `json:"full"`
	}
	_ = readJSON(r, &in)
	if c := a.store.ConfIndexConfig(); !c.On || len(c.Spaces) == 0 {
		writeErr(w, 400, errors.New("switch the local index on and pick at least one space"))
		return
	}
	if r.URL.Query().Get("wait") == "1" {
		if err := a.ciSync(in.Full); err != nil {
			writeErr(w, 502, err)
			return
		}
	} else {
		go func() { _ = a.ciSync(in.Full) }()
	}
	writeJSON(w, map[string]bool{"ok": true})
}

// handleConfIndexDelete removes the downloaded copy (the setting goes off).
func (a *App) handleConfIndexDelete(w http.ResponseWriter, r *http.Request) {
	c := a.store.ConfIndexConfig()
	c.On = false
	a.store.SetConfIndexConfig(c)
	cidx.mu.Lock()
	cidx.Pages, cidx.Synced, cidx.FullAt, cidx.LastSync = map[string]*ciPage{}, map[string]time.Time{}, map[string]time.Time{}, time.Time{}
	cidx.rebuild()
	cidx.loaded = true
	cidx.mu.Unlock()
	_ = os.Remove(a.store.confIndexPath())
	writeJSON(w, map[string]bool{"ok": true})
}

// handleConfSpaces lists the Confluence spaces you can see (for picking).
func (a *App) handleConfSpaces(w http.ResponseWriter, r *http.Request) {
	type space struct {
		Key  string `json:"key"`
		Name string `json:"name"`
	}
	out := []space{}
	path := "/rest/api/space?limit=100&type=global"
	for i := 0; path != "" && i < 10; i++ {
		var res struct {
			Results []space `json:"results"`
			Links   struct {
				Next string `json:"next"`
			} `json:"_links"`
		}
		if err := a.confGet(path, &res); err != nil {
			writeErr(w, 502, err)
			return
		}
		out = append(out, res.Results...)
		path = strings.TrimPrefix(res.Links.Next, "/wiki")
	}
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name) })
	writeJSON(w, out)
}

func (a *App) ciPages() int {
	a.ciLoad()
	cidx.mu.RLock()
	defer cidx.mu.RUnlock()
	return len(cidx.Pages)
}

// ago: "12 min ago", "3 h ago", "never".
func ago(t time.Time) string {
	if t.IsZero() {
		return "never"
	}
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%d min ago", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%d h ago", int(d.Hours()))
	}
	return fmt.Sprintf("%d days ago", int(d.Hours()/24))
}
