package main

// Session logs: when "Save SSH session text" is on, what each SSH terminal
// shows (commands echo back, so they are in it; typed passwords are not, as
// servers don't echo them) is appended to
// <data>/session-logs/<server>/<YYYY-MM-DD>.log as plain text, and can be
// searched from ☰ → Session logs. Logs older than 180 days are removed.

import (
	"bufio"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const sessionLogDays = 180

var (
	reANSI      = regexp.MustCompile(`\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78DEHMc]`)
	reLogUnsafe = regexp.MustCompile(`[^A-Za-z0-9._@-]+`)
)

func (a *App) sessionLogDir() string { return filepath.Join(a.dataDir, "session-logs") }

type sessionLog struct {
	mu   sync.Mutex
	f    *os.File
	line []byte // the current line, written when it ends
}

// openSessionLog starts (or continues) today's log for a server.
func (a *App) openSessionLog(host, user string) (*sessionLog, error) {
	dir := filepath.Join(a.sessionLogDir(), reLogUnsafe.ReplaceAllString(strings.ToLower(host), "_"))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(dir, time.Now().Format("2006-01-02")+".log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	fmt.Fprintf(f, "\n===== %s  %s@%s  connected =====\n", time.Now().Format("15:04:05"), user, host)
	return &sessionLog{f: f}, nil
}

// Write keeps what the screen shows as plain lines: colour and cursor codes
// are dropped, backspaces applied, carriage returns start the line again.
func (l *sessionLog) Write(b []byte) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.f == nil {
		return
	}
	for _, c := range reANSI.ReplaceAll(b, nil) {
		switch {
		case c == '\n':
			l.f.Write(append(l.line, '\n'))
			l.line = l.line[:0]
		case c == '\r':
			// "\r\n" ends the line; a lone "\r" (progress bars) is ignored
		case c == '\b' || c == 0x7f:
			if len(l.line) > 0 {
				l.line = l.line[:len(l.line)-1]
			}
		case c == '\t' || c >= 0x20:
			l.line = append(l.line, c)
		}
	}
}

func (l *sessionLog) Close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.f == nil {
		return
	}
	if len(l.line) > 0 {
		l.f.Write(append(l.line, '\n'))
	}
	fmt.Fprintf(l.f, "===== %s  disconnected =====\n", time.Now().Format("15:04:05"))
	l.f.Close()
	l.f = nil
}

// pruneSessionLogs removes logs older than sessionLogDays.
func (a *App) pruneSessionLogs() {
	cut := time.Now().AddDate(0, 0, -sessionLogDays).Format("2006-01-02")
	files, _ := filepath.Glob(filepath.Join(a.sessionLogDir(), "*", "*.log"))
	for _, f := range files {
		if strings.TrimSuffix(filepath.Base(f), ".log") < cut {
			_ = os.Remove(f)
		}
	}
}

type logHit struct {
	Host string `json:"host"`
	Day  string `json:"day"`
	Time string `json:"time"` // when that session started
	Line int    `json:"line"`
	Text string `json:"text"`
	File string `json:"file"` // relative to session-logs
}

// handleSessionLogs lists the logs (newest first) or, with q, the lines
// containing every word of q (at most 300).
func (a *App) handleSessionLogs(w http.ResponseWriter, r *http.Request) {
	q := strings.Fields(strings.ToLower(r.URL.Query().Get("q")))
	files, _ := filepath.Glob(filepath.Join(a.sessionLogDir(), "*", "*.log"))
	sort.Slice(files, func(i, j int) bool {
		bi, bj := filepath.Base(files[i]), filepath.Base(files[j])
		return bi > bj || bi == bj && files[i] < files[j]
	})
	type logFile struct {
		Host string `json:"host"`
		Day  string `json:"day"`
		Size int64  `json:"size"`
		File string `json:"file"`
	}
	list, hits := []logFile{}, []logHit{}
	for _, f := range files {
		rel, _ := filepath.Rel(a.sessionLogDir(), f)
		host, day := filepath.Base(filepath.Dir(f)), strings.TrimSuffix(filepath.Base(f), ".log")
		if len(q) == 0 {
			st, _ := os.Stat(f)
			list = append(list, logFile{host, day, st.Size(), filepath.ToSlash(rel)})
			continue
		}
		fh, err := os.Open(f)
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(fh)
		sc.Buffer(make([]byte, 64*1024), 1<<20)
		n, started := 0, ""
		for sc.Scan() && len(hits) < 300 {
			n++
			t := sc.Text()
			if strings.HasPrefix(t, "===== ") && strings.Contains(t, "connected") {
				started = strings.Fields(t)[1]
			}
			low := strings.ToLower(t)
			all := true
			for _, word := range q {
				all = all && strings.Contains(low, word)
			}
			if all {
				hits = append(hits, logHit{host, day, started, n, t, filepath.ToSlash(rel)})
			}
		}
		fh.Close()
	}
	if len(q) == 0 {
		writeJSON(w, map[string]any{"files": list, "dir": a.sessionLogDir()})
		return
	}
	writeJSON(w, map[string]any{"hits": hits, "dir": a.sessionLogDir()})
}

// handleSessionLogOpen opens a log (or, with no file, the folder).
func (a *App) handleSessionLogOpen(w http.ResponseWriter, r *http.Request) {
	var in struct{ File string }
	_ = readJSON(r, &in)
	target := a.sessionLogDir()
	if in.File != "" {
		target = filepath.Join(a.sessionLogDir(), filepath.FromSlash(in.File))
		if rel, err := filepath.Rel(a.sessionLogDir(), target); err != nil || strings.HasPrefix(rel, "..") {
			writeErr(w, 400, errors.New("not a session log"))
			return
		}
	}
	_ = os.MkdirAll(a.sessionLogDir(), 0o700)
	openPath(target)
	writeJSON(w, map[string]bool{"ok": true})
}
