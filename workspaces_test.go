package main

import (
	"bytes"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWorkspaces(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir()) // a fresh "laptop"
	defDir := chosenDataDir("")
	_ = os.MkdirAll(defDir, 0o700)
	s, _ := OpenStore(defDir)
	a := &App{store: s, dataDir: defDir, workspace: ""}

	var servers []*http.Server
	defer func() {
		for _, sv := range servers {
			sv.Close()
		}
	}()
	started := map[string]bool{}
	old := startWorkspaceProc
	defer func() { startWorkspaceProc = old }()
	startWorkspaceProc = func(ws string, window, sample bool) error { // stands in for starting another WorkHub
		started[ws] = sample
		dir := chosenDataDir(ws)
		_ = os.MkdirAll(dir, 0o700)
		_ = os.WriteFile(filepath.Join(dir, "workhub.dat"), []byte("x"), 0o600)
		_ = os.WriteFile(filepath.Join(dir, "session.token"), []byte("tok-"+ws), 0o600)
		ln, err := net.Listen("tcp", "127.0.0.1:"+itoaPort(workspacePort(ws)))
		if err != nil {
			t.Skipf("port %d busy: %v", workspacePort(ws), err)
		}
		sv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(pingReply(dir))) })}
		servers = append(servers, sv)
		go sv.Serve(ln)
		return nil
	}
	call := func(h http.HandlerFunc, body any) (int, map[string]any) {
		b, _ := json.Marshal(body)
		w := httptest.NewRecorder()
		h(w, httptest.NewRequest("POST", "/", bytes.NewReader(b)))
		var out map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out
	}

	if lastWorkspace() != "" {
		t.Fatal("a new laptop starts in Default")
	}
	code, out := call(a.handleWorkspaceOpen, map[string]any{"name": "Demo WS", "how": "same", "create": true, "sample": true})
	if code != 200 || !strings.Contains(out["url"].(string), "t=tok-Demo WS") || !started["Demo WS"] {
		t.Fatalf("create: %d %v", code, out)
	}
	if lastWorkspace() != "Demo WS" {
		t.Fatalf("last workspace: %q", lastWorkspace())
	}
	if code, _ = call(a.handleWorkspaceOpen, map[string]any{"name": "demo ws", "create": true}); code == 200 {
		t.Fatal("a second workspace with the same name")
	}
	if code, _ = call(a.handleWorkspaceOpen, map[string]any{"name": "Default"}); code == 200 {
		t.Fatal("switching to the workspace you're in")
	}
	if code, _ = call(a.handleWorkspaceOpen, map[string]any{"name": "Nope"}); code != 404 {
		t.Fatal("unknown workspace")
	}
	if code, _ = call(a.handleWorkspaceOpen, map[string]any{"name": "bad/name", "create": true}); code != 400 {
		t.Fatal("bad name accepted")
	}
	list := a.listWorkspaces()
	if len(list) != 2 || list[0].Name != "Default" || !list[0].Current || list[1].Name != "Demo WS" || !list[1].Running || !list[1].Last {
		t.Fatalf("list: %+v", list)
	}
	// Open workspace…: an existing data folder somewhere else
	other := filepath.Join(t.TempDir(), "ClientB")
	_ = os.MkdirAll(other, 0o700)
	_ = os.WriteFile(filepath.Join(other, "workhub.dat"), []byte("x"), 0o600)
	if code, out = call(a.handleWorkspaceOpen, map[string]any{"folder": other, "how": "new"}); code != 200 || out["name"] != "ClientB" {
		t.Fatalf("open folder: %d %v", code, out)
	}
	if chosenDataDir("ClientB") != other {
		t.Fatal("the folder isn't remembered for the workspace")
	}
	if code, _ = call(a.handleWorkspaceClose, nil); code != 400 {
		t.Fatal("Default can't be closed")
	}
	// 📤 copy connections to another workspace: the copy carries the password; not to itself / unknown ones
	pw := "Secret#1"
	e, _ := s.SaveEntry(EntryInput{Name: "app", Host: "app-01.example.com", Protocol: "ssh", Username: "deploy", Password: &pw, Env: "UAT"})
	var sent []EntryInput
	oldPost := instancePost
	defer func() { instancePost = oldPost }()
	instancePost = func(dir string, port int, path string, body any) error {
		if path != "/api/entries" || port != workspacePort("Demo WS") {
			t.Fatalf("posted to %d %s", port, path)
		}
		sent = append(sent, body.(EntryInput))
		return nil
	}
	if code, out = call(a.handleWorkspaceCopy, map[string]any{"to": "Demo WS", "ids": []string{e.ID}}); code != 200 || len(sent) != 1 || *sent[0].Password != pw || sent[0].Host != "app-01.example.com" || sent[0].Env != "UAT" {
		t.Fatalf("copy: %d %v %+v", code, out, sent)
	}
	if code, _ = call(a.handleWorkspaceCopy, map[string]any{"to": "Default", "ids": []string{e.ID}}); code != 400 {
		t.Fatal("copy into the same workspace")
	}
	if code, _ = call(a.handleWorkspaceCopy, map[string]any{"to": "Nope", "ids": []string{e.ID}}); code != 404 {
		t.Fatal("copy into an unknown workspace")
	}
	// only the workspace in use captures copies
	setLastWorkspace("Demo WS")
	demo := &App{workspace: "Demo WS"}
	if !demo.activeWorkspace() || a.activeWorkspace() {
		t.Fatal("the workspace in use should capture, the other not")
	}
	call(a.handleWorkspaceActive, nil) // Default's window got focus
	if !a.activeWorkspace() || demo.activeWorkspace() {
		t.Fatal("focus should move capturing to Default")
	}
	if !(&App{workspace: "x", ownData: true}).activeWorkspace() {
		t.Fatal("a WorkHub started with its own data folder always captures")
	}
}

func itoaPort(p int) string { b, _ := json.Marshal(p); return string(b) }

func TestSampleData(t *testing.T) {
	s, _ := OpenStore(t.TempDir())
	seedSample(s)
	if n := len(s.Entries()); n < 12 {
		t.Fatalf("entries: %d", n)
	}
	if n := len(s.WorkItems()); n < 4 {
		t.Fatalf("threads: %d", n)
	}
	roles := s.Settings().Demo.Roles
	for _, e := range s.Entries() {
		local := (e.Host == "127.0.0.1" || e.Host == "localhost") && roles[e.ID] != "" // a pretend server inside WorkHub (demolab.go)
		if e.Host != "" && !strings.HasSuffix(e.Host, ".example.com") && !local {
			t.Fatalf("sample data must be made up: %s", e.Host)
		}
	}
	if s.Settings().Workspace == "" || !s.Settings().NoBrowserSync {
		t.Fatal("a sample workspace gets a name and doesn't import this PC's browser bookmarks")
	}
}
