package main

// Adding connections by copying, through the 💬 Assistant: while it is open,
// what you copy is not saved by itself. Each connection found in it (SSH,
// SFTP/FTP, a database from a JDBC URL, a link) is offered in the conversation
// — "I found an SSH server … Add it?" — and saved only when you say Yes. Text
// or a screenshot pasted into it is read the same way (pictures: the OCR built
// into the system). With the Assistant closed, capture works as before.
// ("captureWindow" below is that ask-first state: the Assistant is open.)

import (
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

type capFinding struct {
	Finding
	ExistingID string `json:"existing_id,omitempty"` // already saved as this entry
	Done       bool   `json:"done,omitempty"`        // answered (Yes or No)
}

type capProposal struct {
	ID       string       `json:"id"`
	At       time.Time    `json:"at"`
	From     string       `json:"from,omitempty"` // the program it was copied from
	Source   string       `json:"source"`         // "copy" or "screenshot"
	Text     string       `json:"text"`
	Findings []capFinding `json:"findings"`
}

type captureWindow struct {
	mu   sync.Mutex
	seen time.Time // the window asked for news (it does every second or two)
	list []*capProposal
	last string
}

var capWin = &captureWindow{}

// active: the window is open (it polled lately).
func (c *captureWindow) active() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return !c.seen.IsZero() && time.Since(c.seen) < 6*time.Second
}

// propose offers the connections found in text; false when there are none.
func (c *captureWindow) propose(s *Store, text, from, source string) bool {
	found := Parse(text)
	if len(found) == 0 {
		return false
	}
	p := &capProposal{ID: randomHex(6), At: time.Now(), From: from, Source: source, Text: text}
	for _, f := range found {
		p.Findings = append(p.Findings, capFinding{Finding: f, ExistingID: s.FindEntry(f)})
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if strings.TrimSpace(text) == c.last {
		return true // the same copy again
	}
	c.last = strings.TrimSpace(text)
	c.list = append(c.list, p)
	if len(c.list) > 30 {
		c.list = c.list[len(c.list)-30:]
	}
	return true
}

func (c *captureWindow) take(id string, index int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for i, p := range c.list {
		if p.ID != id {
			continue
		}
		if index >= 0 && index < len(p.Findings) {
			p.Findings[index].Done = true // marked, not removed: the others keep their place
		}
		all := true
		for _, f := range p.Findings {
			all = all && f.Done
		}
		if index < 0 || all {
			c.list = append(c.list[:i:i], c.list[i+1:]...)
		}
		return
	}
}

// captureText handles copied text: offered in the capture window while it is
// open, otherwise captured as before.
func (a *App) captureText(txt, from string) {
	if capWin.active() {
		capWin.propose(a.store, txt, from, "copy")
		return
	}
	a.store.IngestFrom(txt, "clipboard", from, "")
}

// captureShotText: a screenshot copied while the capture window is open is
// read (OCR) and its connections offered too.
func (a *App) captureShotText(png []byte, from string) {
	if !capWin.active() || !ocrSupported {
		return
	}
	if txt, err := ocrImage(png); err == nil && strings.TrimSpace(txt) != "" {
		capWin.propose(a.store, txt, from, "screenshot")
	}
}

// AddFinding saves one connection confirmed in the capture window; created is
// false when it was already saved (then it is completed with what is new).
func (s *Store) AddFinding(f Finding, text, from string) (EntryView, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	k := entryKey(f.Host, f.Port, f.Username, f.URL)
	var e *Entry
	for _, x := range s.st.Entries {
		if entryKey(x.Host, x.Port, x.Username, x.URL) == k {
			e = x
			break
		}
	}
	created := e == nil || e.Hidden
	if e == nil {
		e = &Entry{ID: randomHex(8), Project: s.st.Settings.Project, Created: now}
		s.st.Entries = append(s.st.Entries, e)
	}
	e.Hidden = false // you asked for it
	mergeFinding(e, f)
	e.addCapture("capture window", "", now)
	e.Updated = now
	if strings.TrimSpace(text) != "" {
		clip := &Clip{ID: randomHex(8), Text: text, Source: "capture", From: from, Project: e.Project, Created: now, EntryIDs: []string{e.ID}}
		s.st.Clips = append(s.st.Clips, clip)
		if len(s.st.Clips) > maxClips {
			s.st.Clips = s.st.Clips[len(s.st.Clips)-maxClips:]
		}
		e.ClipIDs = appendUnique(e.ClipIDs, clip.ID)
	}
	s.applyNameRules()
	s.changed()
	return view(e), created
}

// ---- HTTP ----

func (a *App) handleCaptureProposals(w http.ResponseWriter, r *http.Request) {
	capWin.mu.Lock()
	capWin.seen = time.Now()
	list := append([]*capProposal(nil), capWin.list...)
	capWin.mu.Unlock()
	writeJSON(w, map[string]any{"proposals": list, "ocr": ocrSupported, "watching": a.store.Settings().Watch})
}

func (a *App) handleCaptureOCR(w http.ResponseWriter, r *http.Request) {
	if !ocrSupported {
		writeErr(w, 400, errors.New("reading text from pictures isn't available on this computer — paste the text instead"))
		return
	}
	img, err := io.ReadAll(io.LimitReader(r.Body, 20<<20))
	if err != nil || len(img) == 0 {
		writeErr(w, 400, errors.New("no picture"))
		return
	}
	txt, err := ocrImage(img)
	if err != nil {
		writeErr(w, 400, errors.New("couldn't read text from the picture: "+err.Error()))
		return
	}
	writeJSON(w, map[string]string{"text": txt})
}

func (a *App) handleCaptureAccept(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ID      string  `json:"id"` // proposal (copied text); empty for pasted text
		Index   int     `json:"index"`
		Finding Finding `json:"finding"`
		Text    string  `json:"text"`
		From    string  `json:"from"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	if in.Finding.Host == "" && in.Finding.URL == "" {
		writeErr(w, 400, errors.New("nothing to save: no host or address"))
		return
	}
	e, created := a.store.AddFinding(in.Finding, in.Text, in.From)
	if in.ID != "" {
		capWin.take(in.ID, in.Index)
	}
	writeJSON(w, map[string]any{"entry": e, "created": created})
}

func (a *App) handleCaptureDismiss(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ID    string `json:"id"`
		Index int    `json:"index"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	capWin.take(in.ID, in.Index)
	writeJSON(w, map[string]bool{"ok": true})
}
