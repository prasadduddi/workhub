package main

// Remote log viewer: `tail -F` of a file on an SSH server, streamed to the
// browser, plus a quick search for recently written log files. Read-only:
// the only commands run are tail and find.

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

type tailStart struct {
	T        string `json:"t"`
	Path     string `json:"path"`
	Lines    int    `json:"lines"`
	Username string `json:"username"`
	Password string `json:"password"`
}

// tailCommand: the last n lines, then follow the file even when it is rotated.
func tailCommand(path string, n int) string {
	if n <= 0 || n > 5000 {
		n = 200
	}
	return "tail -n " + strconv.Itoa(n) + " -F -- " + shQuote(path) + " 2>&1"
}

// findLogsCommand lists log files changed in the last 3 days under dir, newest
// first, as "epoch size path" lines. Portable: GNU stat, else BSD stat.
func findLogsCommand(dir string) string {
	if strings.TrimSpace(dir) == "" {
		dir = "/var/log"
	}
	return "find " + shQuote(dir) + ` -maxdepth 4 -type f \( -name '*.log' -o -name '*.log.[0-9]' -o -name '*.out' -o -name '*.err' -o -name 'messages' -o -name 'syslog' -o -name 'catalina.*' \) -mmin -4320 2>/dev/null | head -300 | ` +
		`while IFS= read -r f; do [ -r "$f" ] || continue; m=$(stat -c '%Y %s' "$f" 2>/dev/null || stat -f '%m %z' "$f" 2>/dev/null) && echo "$m $f"; done | sort -rn | head -200`
}

// handleTail: protocol — the client sends {t:"start", path, lines}; the server
// sends {t:"data", d} chunks of the file, {t:"info"/"err", d} messages.
func (a *App) handleTail(w http.ResponseWriter, r *http.Request) {
	e, ok := a.store.Entry(r.URL.Query().Get("id"))
	if !ok {
		http.Error(w, "entry not found", 404)
		return
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	var wmu sync.Mutex
	send := func(t, d string) {
		wmu.Lock()
		defer wmu.Unlock()
		_ = conn.WriteJSON(map[string]string{"t": t, "d": d})
	}
	var start tailStart
	if err := conn.ReadJSON(&start); err != nil || start.T != "start" || strings.TrimSpace(start.Path) == "" {
		send("err", "no file given")
		return
	}
	client, err := a.dialSSH(e, start.Username, start.Password)
	a.store.SetStatus(e.ID, err)
	if err != nil {
		send("err", err.Error())
		return
	}
	defer client.Close()
	sess, err := client.NewSession()
	if err != nil {
		send("err", err.Error())
		return
	}
	defer sess.Close()
	out, _ := sess.StdoutPipe()
	if err := sess.Start(tailCommand(start.Path, start.Lines)); err != nil {
		send("err", err.Error())
		return
	}
	send("info", "Following "+start.Path+" on "+e.Host)
	go func() { // the page closed or pressed Stop: end tail
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				sess.Close()
				client.Close()
				return
			}
		}
	}()
	// Send in small batches so a busy log doesn't flood the page.
	buf := make([]byte, 32*1024)
	var pend bytes.Buffer
	last := time.Now()
	for {
		n, err := out.Read(buf)
		pend.Write(buf[:n])
		if pend.Len() > 0 && (err != nil || pend.Len() > 64*1024 || time.Since(last) > 150*time.Millisecond || bytes.HasSuffix(pend.Bytes(), []byte("\n"))) {
			send("data", strings.ToValidUTF8(pend.String(), "?"))
			pend.Reset()
			last = time.Now()
		}
		if err != nil {
			if err != io.EOF {
				send("info", "stopped: "+err.Error())
			} else {
				send("info", "the file can no longer be read (tail ended)")
			}
			return
		}
	}
}

type logFile struct {
	Path string    `json:"path"`
	Size int64     `json:"size"`
	At   time.Time `json:"at"`
}

// handleFindLogs lists recently written log files in a folder on the server.
func (a *App) handleFindLogs(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ID, Dir, Username, Password string
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	e, ok := a.store.Entry(in.ID)
	if !ok {
		writeErr(w, 404, errors.New("entry not found"))
		return
	}
	client, err := a.dialSSH(e, in.Username, in.Password)
	a.store.SetStatus(e.ID, err)
	if err != nil {
		writeErr(w, 502, err)
		return
	}
	defer client.Close()
	sess, err := client.NewSession()
	if err != nil {
		writeErr(w, 502, err)
		return
	}
	defer sess.Close()
	b, _ := sess.Output(findLogsCommand(in.Dir))
	writeJSON(w, parseFoundLogs(string(b)))
}

// parseFoundLogs reads "epoch size path" lines from findLogsCommand.
func parseFoundLogs(s string) []logFile {
	out := []logFile{}
	for _, l := range strings.Split(s, "\n") {
		f := strings.SplitN(strings.TrimSpace(l), " ", 3)
		if len(f) != 3 {
			continue
		}
		sec, err1 := strconv.ParseFloat(f[0], 64)
		size, err2 := strconv.ParseInt(f[1], 10, 64)
		if err1 != nil || err2 != nil {
			continue
		}
		out = append(out, logFile{Path: f[2], Size: size, At: time.Unix(int64(sec), 0)})
	}
	return out
}

// CaptureText posts text (e.g. log lines) to the capture thread, without
// reading hosts or logins out of it.
func (s *Store) CaptureText(text, from string) error {
	if strings.TrimSpace(text) == "" {
		return errors.New("nothing to add")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	w := s.captureTarget(text, now)
	if w == nil {
		return errors.New("capturing into a thread is switched off")
	}
	w.Posts = append(w.Posts, &Post{ID: randomHex(8), At: now, Kind: "capture", Text: text, From: from})
	w.Updated = now
	s.changed()
	return nil
}

func (a *App) handleCaptureText(w http.ResponseWriter, r *http.Request) {
	var in struct{ Text, From string }
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	if err := a.store.CaptureText(in.Text, in.From); err != nil {
		writeErr(w, 400, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}
