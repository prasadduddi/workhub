package main

// ▶ Run a command on several servers: the same command on each chosen SSH
// server at the same time (at most 8 at once), each server's output shown side by
// side. PROD servers only with prod_ok (the page asks first), and every PROD run
// goes to the 🛡 PROD activity log.

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

type runResult struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Host   string `json:"host"`
	Env    string `json:"env,omitempty"`
	Output string `json:"output"`
	Exit   int    `json:"exit"`
	Err    string `json:"err,omitempty"`
	Ms     int64  `json:"ms"`
}

const runMaxOutput = 256 << 10

var runOnServer = func(a *App, e Entry, cmd string, timeout time.Duration) (string, int, error) {
	client, err := a.dialSSH(e, "", "")
	a.store.SetStatus(e.ID, err)
	if err != nil {
		return "", -1, err
	}
	defer client.Close()
	sess, err := client.NewSession()
	if err != nil {
		return "", -1, err
	}
	defer sess.Close()
	var out limitedBuf
	sess.Stdout, sess.Stderr = &out, &out
	done := make(chan error, 1)
	go func() { done <- sess.Run(cmd) }()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	select {
	case err = <-done:
	case <-ctx.Done():
		_ = sess.Signal(ssh.SIGTERM)
		client.Close()
		return out.String(), -1, errors.New("stopped: still running after " + timeout.String())
	}
	var ee *ssh.ExitError
	if errors.As(err, &ee) {
		return out.String(), ee.ExitStatus(), nil
	}
	if err != nil {
		return out.String(), -1, err
	}
	return out.String(), 0, nil
}

// limitedBuf keeps the first 256 KB of a command's output.
type limitedBuf struct {
	mu  sync.Mutex
	b   bytes.Buffer
	cut bool
}

func (l *limitedBuf) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if room := runMaxOutput - l.b.Len(); room > 0 {
		if len(p) > room {
			l.b.Write(p[:room])
			l.cut = true
		} else {
			l.b.Write(p)
		}
	} else {
		l.cut = true
	}
	return len(p), nil
}

func (l *limitedBuf) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	s := strings.ToValidUTF8(l.b.String(), "?")
	if l.cut {
		s += "\n… (more output — only the first 256 KB is shown)"
	}
	return s
}

func (a *App) handleMultiRun(w http.ResponseWriter, r *http.Request) {
	var in struct {
		IDs     []string `json:"ids"`
		Command string   `json:"command"`
		ProdOK  bool     `json:"prod_ok"` // the page asked about the PROD servers
		Timeout int      `json:"timeout"` // seconds (default 60, at most 600)
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	cmd := strings.TrimSpace(in.Command)
	if cmd == "" || len(in.IDs) == 0 {
		writeErr(w, 400, errors.New("choose servers and type a command"))
		return
	}
	if len(in.IDs) > 50 {
		writeErr(w, 400, errors.New("at most 50 servers at once"))
		return
	}
	var list []Entry
	for _, id := range in.IDs {
		e, ok := a.store.Entry(id)
		if !ok {
			writeErr(w, 404, errors.New("a server isn't there any more — refresh"))
			return
		}
		if isProdEntry(e) && !in.ProdOK {
			writeErr(w, 403, errors.New(orDefault(e.Name, e.Host)+" is PROD — confirm first"))
			return
		}
		list = append(list, e)
	}
	timeout := time.Duration(min(max(in.Timeout, 0), 600)) * time.Second
	if timeout == 0 {
		timeout = 60 * time.Second
	}
	res := make([]runResult, len(list))
	sem := make(chan struct{}, 8)
	var wg sync.WaitGroup
	for i, e := range list {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			start := time.Now()
			out, code, err := runOnServer(a, e, cmd, timeout)
			x := runResult{ID: e.ID, Name: orDefault(e.Name, e.Host), Host: e.Host, Env: e.Env, Output: out, Exit: code, Ms: time.Since(start).Milliseconds()}
			note := "exit " + strconv.Itoa(code)
			if err != nil {
				x.Err, note = err.Error(), err.Error()
			}
			a.prodLog(e, "run", "", cmd, "on several servers · "+note) // 🛡
			res[i] = x
		}()
	}
	wg.Wait()
	writeJSON(w, map[string]any{"results": res})
}
