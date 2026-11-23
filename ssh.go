package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return r.Header.Get("Origin") == "http://"+r.Host
	},
}

func sshPort(e Entry) int {
	switch e.Protocol {
	case "", "ssh", "sftp", "scp":
		if e.Port != 0 {
			return e.Port
		}
	}
	return 22
}

// dialSSH connects with the entry's password and/or private key. user and
// pass override the stored values when the user typed them at connect time.
func (a *App) dialSSH(e Entry, user, pass string) (*ssh.Client, error) {
	if user == "" {
		user = e.Username
	}
	if pass == "" {
		pass = e.Password
	}
	if user == "" {
		return nil, errors.New("no username")
	}
	var auths []ssh.AuthMethod
	if e.KeyFile != "" {
		pem, err := os.ReadFile(e.KeyFile)
		if err != nil {
			return nil, fmt.Errorf("key file: %w", err)
		}
		signer, err := ssh.ParsePrivateKey(pem)
		var missing *ssh.PassphraseMissingError
		if errors.As(err, &missing) {
			signer, err = ssh.ParsePrivateKeyWithPassphrase(pem, []byte(pass))
		}
		if err != nil {
			return nil, fmt.Errorf("key file %s: %w (PuTTY .ppk keys must be exported to OpenSSH format with PuTTYgen)", e.KeyFile, err)
		}
		auths = append(auths, ssh.PublicKeys(signer))
	}
	if pass != "" {
		auths = append(auths, ssh.Password(pass), ssh.KeyboardInteractive(
			func(_, _ string, questions []string, _ []bool) ([]string, error) {
				ans := make([]string, len(questions))
				for i := range ans {
					ans[i] = pass
				}
				return ans, nil
			}))
	}
	cfg := &ssh.ClientConfig{
		User:            user,
		Auth:            auths,
		HostKeyCallback: a.hostKeyCallback(),
		Timeout:         15 * time.Second,
	}
	client, err := ssh.Dial("tcp", net.JoinHostPort(e.Host, strconv.Itoa(sshPort(e))), cfg)
	if err != nil {
		return nil, err
	}
	go keepAlive(client)
	return client, nil
}

// keepAlive stops idle sessions from being cut by corporate firewalls, and
// notices a dead connection (network gone, server rebooted): when the server
// stops answering, the connection is closed so the terminal shows
// "disconnected" straight away instead of hanging.
func keepAlive(c *ssh.Client) {
	misses := 0
	for range time.Tick(keepAliveEvery) {
		reply := make(chan error, 1)
		go func() { _, _, err := c.SendRequest("keepalive@openssh.com", true, nil); reply <- err }()
		select {
		case err := <-reply:
			if err != nil { // connection already closed
				c.Close()
				return
			}
			misses = 0
		case <-time.After(keepAliveWait):
			if misses++; misses >= 2 {
				c.Close()
				return
			}
		}
	}
}

var keepAliveEvery, keepAliveWait = 30 * time.Second, 15 * time.Second

// hostKeyCallback trusts a server on first connect (like PuTTY's "store key
// in cache") and refuses if its key changes later.
func (a *App) hostKeyCallback() ssh.HostKeyCallback {
	path := filepath.Join(a.dataDir, "known_hosts")
	return func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		a.khMu.Lock()
		defer a.khMu.Unlock()
		if f, err := os.OpenFile(path, os.O_CREATE|os.O_RDONLY, 0o600); err == nil {
			f.Close()
		}
		check, err := knownhosts.New(path)
		if err != nil {
			return err
		}
		err = check(hostname, remote, key)
		var keyErr *knownhosts.KeyError
		if errors.As(err, &keyErr) && len(keyErr.Want) == 0 {
			f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
			if err != nil {
				return err
			}
			defer f.Close()
			_, err = fmt.Fprintln(f, knownhosts.Line([]string{knownhosts.Normalize(hostname)}, key))
			return err
		}
		if errors.As(err, &keyErr) {
			return fmt.Errorf("HOST KEY CHANGED for %s - possible man-in-the-middle attack. If the server was rebuilt, delete its line from %s", hostname, path)
		}
		return err
	}
}

type termMsg struct {
	T        string `json:"t"`
	D        string `json:"d"`
	Cols     int    `json:"cols"`
	Rows     int    `json:"rows"`
	Username string `json:"username"`
	Password string `json:"password"`
	Save     bool   `json:"save"`
}

// handleTerm bridges a browser terminal (xterm.js) to an SSH shell.
// Protocol: client sends JSON {t:"start"} first, then {t:"d"} keystrokes and
// {t:"r"} resizes; server sends raw terminal output as binary frames.
func (a *App) handleTerm(w http.ResponseWriter, r *http.Request) {
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
	send := func(b []byte) {
		wmu.Lock()
		defer wmu.Unlock()
		_ = conn.WriteMessage(websocket.BinaryMessage, b)
	}

	var start termMsg
	if err := conn.ReadJSON(&start); err != nil || start.T != "start" {
		return
	}
	user := orDefault(start.Username, e.Username)
	send([]byte(fmt.Sprintf("\x1b[90mConnecting to %s@%s:%d ...\x1b[0m\r\n", user, e.Host, sshPort(e))))
	client, err := a.dialSSH(e, start.Username, start.Password)
	a.store.SetStatus(e.ID, err)
	if err != nil {
		send([]byte("\x1b[31m" + err.Error() + "\x1b[0m\r\n"))
		return
	}
	defer client.Close()
	if start.Save {
		a.store.SetCredentials(e.ID, start.Username, start.Password)
	}
	a.store.Touch(e.ID)
	// PuTTY-style tunnels on this server start with the session.
	if tunnelsOff(e) {
		// saved but switched off
	} else if fws, ferr := parseForwards(e.Extra["tunnels"]); ferr != nil {
		send([]byte("\x1b[33m" + ferr.Error() + "\x1b[0m\r\n"))
	} else if len(fws) > 0 && a.tunnels.byEntry(e.ID) == nil {
		ts, errs := startForwards(client, fws)
		ts.entryID, ts.name = e.ID, e.Name
		a.tunnels.add(ts)
		defer func() { ts.close(); a.tunnels.remove(ts) }()
		for _, f := range ts.forwards {
			send([]byte("\x1b[90mTunnel ready: " + f.String() + "\x1b[0m\r\n"))
		}
		for _, e := range errs {
			send([]byte("\x1b[33m" + e.Error() + "\x1b[0m\r\n"))
		}
	}

	if a.store.Settings().SessionLog { // ⚙ Settings → Save SSH session text: keep the text of this session
		if lg, err := a.openSessionLog(e.Host, user); err == nil {
			defer lg.Close()
			show := send
			send = func(b []byte) { show(b); lg.Write(b) }
			show([]byte("\x1b[90m[saving this session's text — ⚙ Settings › Session logs]\x1b[0m\r\n"))
		}
	}
	cols, rows := max(start.Cols, 20), max(start.Rows, 5)
	t := &termSession{app: a, client: client, entryID: e.ID, send: send, cols: cols, rows: rows}
	go t.run(e.LastDir, conn)

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			t.close()
			return
		}
		var m termMsg
		if json.Unmarshal(data, &m) != nil {
			continue
		}
		switch m.T {
		case "d":
			t.write([]byte(m.D))
		case "r":
			if m.Cols > 0 && m.Rows > 0 {
				t.resize(m.Cols, m.Rows)
			}
		}
	}
}

// termSession runs the remote shell for one terminal tab and keeps track of
// its working directory so the next session (or the Files page) can start
// there.
type termSession struct {
	app     *App
	client  *ssh.Client
	entryID string
	send    func([]byte)

	mu         sync.Mutex
	sess       *ssh.Session
	stdin      io.Writer
	cols, rows int
	closed     bool
}

func (t *termSession) write(b []byte) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.stdin != nil {
		_, _ = t.stdin.Write(b)
	}
}

func (t *termSession) resize(cols, rows int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.cols, t.rows = cols, rows
	if t.sess != nil {
		_ = t.sess.WindowChange(rows, cols)
	}
}

func (t *termSession) close() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.closed = true
	if t.sess != nil {
		t.sess.Close()
	}
}

// pidMarker is printed by the start-up wrapper so we learn the shell's PID;
// it is removed from the output before it reaches the browser.
var pidMarker = regexp.MustCompile("\x1b\\]7777;(\\d+)\x07")

func shQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

// run starts the shell. First it tries a wrapper that changes to the last
// folder, reports the shell's PID and then becomes the user's normal login
// shell (exec keeps the PID). If that fails quickly (csh, restricted shells,
// network devices) it falls back to a plain shell.
func (t *termSession) run(lastDir string, conn *websocket.Conn) {
	defer conn.Close()
	plain := false
	for {
		var cmd string
		if !plain {
			cmd = `printf '\033]7777;%s\007' $$; exec "$SHELL" -l`
			if lastDir != "" {
				cmd = "cd " + shQuote(lastDir) + " 2>/dev/null; " + cmd
			}
		}
		started := time.Now()
		err := t.start(cmd)
		if err == nil {
			err = t.wait()
		}
		t.mu.Lock()
		closed := t.closed
		t.mu.Unlock()
		if closed {
			return
		}
		if !plain && err != nil && time.Since(started) < 3*time.Second {
			plain = true
			t.send([]byte("\x1b[90m[starting a plain shell]\x1b[0m\r\n"))
			continue
		}
		if err != nil && plain {
			t.send([]byte("\x1b[31m" + err.Error() + "\x1b[0m\r\n"))
		}
		t.send([]byte("\r\n\x1b[90m[session closed]\x1b[0m\r\n"))
		return
	}
}

func (t *termSession) start(cmd string) error {
	sess, err := t.client.NewSession()
	if err != nil {
		return err
	}
	t.mu.Lock()
	cols, rows := t.cols, t.rows
	t.mu.Unlock()
	modes := ssh.TerminalModes{ssh.ECHO: 1, ssh.TTY_OP_ISPEED: 14400, ssh.TTY_OP_OSPEED: 14400}
	if err := sess.RequestPty("xterm-256color", rows, cols, modes); err != nil {
		sess.Close()
		return err
	}
	stdin, _ := sess.StdinPipe()
	stdout, _ := sess.StdoutPipe()
	stderr, _ := sess.StderrPipe()
	if cmd == "" {
		err = sess.Shell()
	} else {
		err = sess.Start(cmd)
	}
	if err != nil {
		sess.Close()
		return err
	}
	t.mu.Lock()
	t.sess, t.stdin = sess, stdin
	t.mu.Unlock()
	go t.pump(stdout, cmd != "")
	go t.pump(stderr, false)
	return nil
}

func (t *termSession) wait() error {
	t.mu.Lock()
	sess := t.sess
	t.mu.Unlock()
	err := sess.Wait()
	sess.Close()
	return err
}

func (t *termSession) pump(rd io.Reader, watchPID bool) {
	buf := make([]byte, 32*1024)
	for {
		n, err := rd.Read(buf)
		if n > 0 {
			out := append([]byte(nil), buf[:n]...)
			if watchPID {
				if m := pidMarker.FindSubmatch(out); m != nil {
					watchPID = false
					pid, _ := strconv.Atoi(string(m[1]))
					out = pidMarker.ReplaceAll(out, nil)
					go t.trackDir(pid)
				}
			}
			if len(out) > 0 {
				t.send(out)
			}
		}
		if err != nil {
			return
		}
	}
}

// trackDir polls the shell's working directory over a side channel (Linux
// /proc, Solaris pwdx) and remembers it for the entry. It stops quietly on
// systems that support neither.
func (t *termSession) trackDir(pid int) {
	cmd := fmt.Sprintf("readlink /proc/%d/cwd 2>/dev/null || pwdx %d 2>/dev/null", pid, pid)
	misses := 0
	for range time.Tick(4 * time.Second) {
		t.mu.Lock()
		closed := t.closed
		t.mu.Unlock()
		if closed || misses >= 3 {
			return
		}
		s, err := t.client.NewSession()
		if err != nil {
			return
		}
		out, _ := s.Output(cmd)
		s.Close()
		dir := strings.TrimSpace(string(out))
		if _, after, ok := strings.Cut(dir, ": "); ok && strings.HasPrefix(dir, strconv.Itoa(pid)+":") {
			dir = after // pwdx prints "PID: /path"
		}
		if !strings.HasPrefix(dir, "/") {
			misses++
			continue
		}
		misses = 0
		t.app.store.SetLastDir(t.entryID, dir)
	}
}
