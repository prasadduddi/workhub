package main

// 🛡 PROD activity log: what was done on PROD servers through WorkHub — terminals
// opened, lines typed or pasted there, SQL that changes data, commits and
// rollbacks, captures, commands run on several servers. Kept in the encrypted
// data file for a year (up to 20,000 events); searchable and exportable as CSV
// (Tools → PROD activity log). Lines typed right after a password prompt are
// never recorded, and passwords in SQL are masked.

import (
	"encoding/csv"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

type ProdEvent struct {
	At     time.Time `json:"at"`
	Kind   string    `json:"kind"` // terminal, typed, pasted, sql, commit, rollback, capture, run
	Server string    `json:"server"`
	Host   string    `json:"host"`
	User   string    `json:"user,omitempty"`
	What   string    `json:"what"`
	Note   string    `json:"note,omitempty"`
}

const prodLogMax = 20000

var reSQLSecret = regexp.MustCompile(`(?i)(identified\s+by\s+|password\s*[=:]\s*|password\s+)("[^"]*"|'[^']*'|\S+)`)

func isProdEntry(e Entry) bool { return strings.EqualFold(strings.TrimSpace(e.Env), "PROD") }

// prodLog records an event when e is a PROD server.
func (a *App) prodLog(e Entry, kind, user, what, note string) {
	if !isProdEntry(e) {
		return
	}
	what = reSQLSecret.ReplaceAllString(strings.TrimSpace(what), "${1}<hidden>")
	if len(what) > 4000 {
		what = strings.ToValidUTF8(what[:4000], "") + " …"
	}
	a.store.addProdEvent(ProdEvent{At: time.Now(), Kind: kind, Server: orDefault(e.Name, e.Host), Host: e.Host,
		User: orDefault(user, e.Username), What: what, Note: note})
}

func (s *Store) addProdEvent(ev ProdEvent) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cut := time.Now().AddDate(-1, 0, 0)
	l := s.st.ProdLog
	for len(l) > 0 && (l[0].At.Before(cut) || len(l) >= prodLogMax) {
		l = l[1:]
	}
	s.st.ProdLog = append(l, ev)
	s.dirty = true // saved, without making the page redraw
}

// ProdEvents: newest first, those matching every word of q.
func (s *Store) ProdEvents(q string, limit int) []ProdEvent {
	s.mu.RLock()
	defer s.mu.RUnlock()
	words := strings.Fields(strings.ToLower(q))
	out := []ProdEvent{}
	for i := len(s.st.ProdLog) - 1; i >= 0 && (limit <= 0 || len(out) < limit); i-- {
		ev := s.st.ProdLog[i]
		hay := strings.ToLower(strings.Join([]string{ev.Kind, ev.Server, ev.Host, ev.User, ev.What, ev.Note, ev.At.Local().Format("2006-01-02 15:04")}, " "))
		ok := true
		for _, w := range words {
			if !strings.Contains(hay, w) {
				ok = false
				break
			}
		}
		if ok {
			out = append(out, ev)
		}
	}
	return out
}

func (a *App) handleProdLog(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	if r.URL.Query().Get("format") == "csv" {
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="prod-activity-`+time.Now().Format("2006-01-02")+`.csv"`)
		w.Write([]byte("\xef\xbb\xbf")) // Excel: UTF-8
		cw := csv.NewWriter(w)
		cw.Write([]string{"When", "What kind", "Server", "Host", "User", "Command / statement", "Note"})
		for _, ev := range a.store.ProdEvents(q, 0) {
			what := ev.What
			if strings.HasPrefix(what, "=") || strings.HasPrefix(what, "+") || strings.HasPrefix(what, "@") {
				what = "'" + what // not a formula in Excel
			}
			cw.Write([]string{ev.At.Local().Format("2006-01-02 15:04:05"), ev.Kind, ev.Server, ev.Host, ev.User, what, ev.Note})
		}
		cw.Flush()
		return
	}
	writeJSON(w, map[string]any{"events": a.store.ProdEvents(q, 500)})
}

// lineRecorder turns what's typed into a PROD terminal into lines: printable
// characters, backspace, Enter. A line typed after the server asked for a
// password (or passphrase / PIN) isn't recorded. Keys like arrows or Tab make the
// typed text differ from what ran (history, completion): recorded as typed.
type lineRecorder struct {
	buf      []rune
	lastOut  string // the end of what the server showed
	secret   bool
	onLine   func(line string, pasted bool)
	pasted   bool // part of this line came in one piece with other text (a paste)
	inEscape bool
}

var rePwPrompt = regexp.MustCompile(`(?i)(password|passphrase|passcode|pin|token|secret)[^\n]{0,40}[:?]\s*$`)

func (l *lineRecorder) output(b []byte) {
	s := l.lastOut + reANSI.ReplaceAllString(string(b), "")
	if len(s) > 200 {
		s = s[len(s)-200:]
		for !utf8.ValidString(s) && len(s) > 0 {
			s = s[1:]
		}
	}
	l.lastOut = s
}

func (l *lineRecorder) input(d string) {
	if len(l.buf) == 0 && rePwPrompt.MatchString(l.lastOut) {
		l.secret = true
	}
	if utf8.RuneCountInString(d) > 2 {
		l.pasted = true
	}
	for _, r := range d {
		switch {
		case l.inEscape:
			if r >= '@' && r <= '~' && r != '[' {
				l.inEscape = false
			}
		case r == 0x1b:
			l.inEscape = true
		case r == '\r' || r == '\n':
			line := strings.TrimSpace(string(l.buf))
			if line != "" && !l.secret {
				l.onLine(line, l.pasted)
			}
			l.buf, l.secret, l.pasted = l.buf[:0], false, utf8.RuneCountInString(d) > 2
			l.lastOut = ""
		case r == 0x7f || r == 0x08:
			if len(l.buf) > 0 {
				l.buf = l.buf[:len(l.buf)-1]
			}
		case r == 0x03 || r == 0x15: // Ctrl+C, Ctrl+U: the line is gone
			l.buf = l.buf[:0]
		case r >= ' ':
			l.buf = append(l.buf, r)
		}
	}
}
