package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	git "github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/object"
	"github.com/gorilla/websocket"
)

func TestGitBrowse(t *testing.T) {
	dir := t.TempDir()
	repo, _ := git.PlainInit(dir, false)
	wt, _ := repo.Worktree()
	sig := &object.Signature{Name: "Ann", Email: "ann@x", When: time.Now().Add(-time.Hour)}
	commit := func(file, body, msg string) plumbing.Hash {
		os.WriteFile(filepath.Join(dir, file), []byte(body), 0o644)
		wt.Add(file)
		h, err := wt.Commit(msg, &git.CommitOptions{Author: sig})
		if err != nil {
			t.Fatal(err)
		}
		sig.When = sig.When.Add(time.Minute)
		return h
	}
	commit("a.txt", "one\n", "first commit")
	h2 := commit("a.txt", "one\ntwo\n", "add line two")
	wt.Checkout(&git.CheckoutOptions{Branch: plumbing.NewBranchReferenceName("feature/x"), Create: true})
	commit("b.txt", "new\n", "feature work")
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("changed\n"), 0o644)

	a := &App{}
	call := func(fn func(rec *httptest.ResponseRecorder), out any) {
		rec := httptest.NewRecorder()
		fn(rec)
		if rec.Code != 200 {
			t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
		}
		json.Unmarshal(rec.Body.Bytes(), out)
	}
	p := url.QueryEscape(dir)

	var info map[string]any
	call(func(rec *httptest.ResponseRecorder) {
		a.handleGitInfo(rec, httptest.NewRequest("GET", "/?path="+p, nil))
	}, &info)
	if info["current"] != "feature/x" || len(info["branches"].([]any)) != 2 {
		t.Fatalf("info: %v", info)
	}
	var log []gitCommit
	call(func(rec *httptest.ResponseRecorder) {
		a.handleGitLog(rec, httptest.NewRequest("GET", "/?path="+p, nil))
	}, &log)
	if len(log) != 3 || log[0].Subject != "feature work" || !strings.Contains(strings.Join(log[0].Refs, ","), "feature/x") {
		t.Fatalf("log: %+v", log)
	}
	call(func(rec *httptest.ResponseRecorder) {
		a.handleGitLog(rec, httptest.NewRequest("GET", "/?ref=master&path="+p, nil))
	}, &log)
	if len(log) != 2 {
		t.Fatalf("master log has %d commits", len(log))
	}
	var c map[string]any
	call(func(rec *httptest.ResponseRecorder) {
		a.handleGitCommit(rec, httptest.NewRequest("GET", "/?hash="+h2.String()+"&path="+p, nil))
	}, &c)
	if !strings.Contains(c["patch"].(string), "+two") || c["files"].([]any)[0].(map[string]any)["status"] != "M" {
		t.Fatalf("commit: %v", c)
	}
	var st []map[string]string
	call(func(rec *httptest.ResponseRecorder) {
		a.handleGitStatus(rec, httptest.NewRequest("GET", "/?path="+p, nil))
	}, &st)
	if len(st) != 1 || st[0]["path"] != "a.txt" {
		t.Fatalf("status: %v", st)
	}
}

func TestLocalShell(t *testing.T) {
	a := &App{}
	srv := httptest.NewServer(httpHandlerFunc(a.handleLocalTerm))
	defer srv.Close()
	u := "ws" + strings.TrimPrefix(srv.URL, "http") + "/?shell=" + localShells()[0].ID
	ws, _, err := websocket.DefaultDialer.Dial(u, map[string][]string{"Origin": {srv.URL}})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	ws.WriteJSON(map[string]any{"t": "start", "cols": 80, "rows": 24})
	out := make(chan string, 256)
	go func() { // the shell's output, as it comes
		for {
			_, b, err := ws.ReadMessage()
			if err != nil {
				close(out)
				return
			}
			out <- string(b)
		}
	}()
	// Wait until the shell has finished starting (a user's zsh may ask a question first, e.g. oh-my-zsh's
	// "Ignore insecure files and continue [y]") — typing earlier loses letters to that question.
	var got strings.Builder
	answered := false
	for deadline := time.After(15 * time.Second); ; {
		select {
		case b, ok := <-out:
			if !ok {
				t.Fatalf("the shell closed: %q", got.String())
			}
			got.WriteString(b)
			if s := got.String(); !answered && strings.Contains(s, "[y]") && strings.Contains(s, "compinit") {
				ws.WriteJSON(map[string]any{"t": "d", "d": "y"})
				answered = true
			}
			continue
		case <-time.After(1200 * time.Millisecond): // quiet for a moment: ready
		case <-deadline:
		}
		break
	}
	got.Reset()
	ws.WriteJSON(map[string]any{"t": "d", "d": "echo work''hub-ok\r"})
	timeout := time.After(10 * time.Second)
	for !strings.Contains(got.String(), "workhub-ok") {
		select {
		case b, ok := <-out:
			if !ok {
				t.Fatalf("no output: %q", got.String())
			}
			got.WriteString(b)
		case <-timeout:
			t.Fatalf("no output: %q", got.String())
		}
	}
}

type httpHandlerFunc func(w http.ResponseWriter, r *http.Request)

func (f httpHandlerFunc) ServeHTTP(w http.ResponseWriter, r *http.Request) { f(w, r) }
