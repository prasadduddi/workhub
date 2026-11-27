package main

// Several workspaces on one laptop (File → New / Open / Switch / Close workspace).
// Each workspace is its own WorkHub: its own data folder, key and port, so the
// data never mixes. Switching starts the other workspace in the background if
// needed and either moves this window to it or opens a new window. The last
// workspace opened is reopened at the next start. A new workspace can be filled
// with made-up sample data, to present WorkHub without showing real work.

import (
	"errors"
	"fmt"
	"hash/fnv"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

var wsNameRe = regexp.MustCompile(`^[A-Za-z0-9 _.-]{1,40}$`)

// wsName: "" is the default workspace ("Default" in the UI).
func wsName(n string) string {
	n = strings.TrimSpace(n)
	if strings.EqualFold(n, "default") {
		return ""
	}
	return n
}

func wsLabel(ws string) string { return orDefault(ws, "Default") }

func workspacePort(ws string) int {
	if ws == "" {
		return defaultPort
	}
	h := fnv.New32a()
	h.Write([]byte(strings.ToLower(ws)))
	return defaultPort + 1 + int(h.Sum32()%500) // stable per workspace
}

func wsBase() string { return filepath.Dir(defaultDataDir()) }

func lastWorkspaceFile() string { return filepath.Join(wsBase(), "last-workspace.txt") }

// lastWorkspace: the workspace opened most recently ("" = Default).
func lastWorkspace() string {
	b, err := os.ReadFile(lastWorkspaceFile())
	if err != nil {
		return ""
	}
	ws := wsName(string(b))
	if ws != "" && (!wsNameRe.MatchString(ws) || !fileExists(filepath.Join(chosenDataDir(ws), "workhub.dat"))) {
		return "" // gone or broken: the default one
	}
	return ws
}

func setLastWorkspace(ws string) {
	_ = os.MkdirAll(wsBase(), 0o700)
	_ = os.WriteFile(lastWorkspaceFile(), []byte(wsLabel(ws)), 0o600)
}

type wsInfo struct {
	Name    string `json:"name"`
	Dir     string `json:"dir"`
	Port    int    `json:"port"`
	Running bool   `json:"running"`
	Current bool   `json:"current"`
	Last    bool   `json:"last"`
}

// listWorkspaces: Default plus every named workspace (in the workspaces folder or opened from elsewhere).
func (a *App) listWorkspaces() []wsInfo {
	names := map[string]bool{"": true}
	if items, err := os.ReadDir(filepath.Join(wsBase(), "workspaces")); err == nil {
		for _, it := range items {
			n := it.Name()
			if it.IsDir() && fileExists(filepath.Join(wsBase(), "workspaces", n, "workhub.dat")) {
				names[n] = true
			} else if strings.HasSuffix(n, ".location.txt") {
				names[strings.TrimSuffix(n, ".location.txt")] = true
			}
		}
	}
	last := lastWorkspace()
	var out []wsInfo
	for n := range names {
		if n != "" && !wsNameRe.MatchString(n) {
			continue
		}
		dir := chosenDataDir(n)
		_, running := existingInstance(dir, workspacePort(n))
		cur := filepath.Clean(dir) == filepath.Clean(a.dataDir)
		out = append(out, wsInfo{Name: wsLabel(n), Dir: dir, Port: workspacePort(n), Running: running || cur, Current: cur, Last: n == last})
	}
	anyCur := false
	for _, w := range out {
		anyCur = anyCur || w.Current
	}
	for i := range out { // started with its own data folder (-data): the one with this name
		if !anyCur && out[i].Name == wsLabel(a.workspace) {
			out[i].Current, out[i].Running = true, true
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if (out[i].Name == "Default") != (out[j].Name == "Default") {
			return out[i].Name == "Default"
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out
}

// startWorkspace makes sure the workspace's WorkHub runs and returns its sign-in address.
// window: Desktop opens its own window for it (a new window).
var startWorkspaceProc = func(ws string, window, sample bool) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	args := []string{"-workspace", wsLabel(ws)}
	if !window {
		args = append(args, "-no-browser", "-server-only")
	}
	if sample {
		args = append(args, "-sample-data")
	}
	cmd := exec.Command(exe, args...)
	cmd.Dir = filepath.Dir(exe)
	return cmd.Start()
}

func (a *App) startWorkspace(ws string, window, sample bool) (string, error) {
	dir, port := chosenDataDir(ws), workspacePort(ws)
	if u, ok := existingInstance(dir, port); ok {
		return u, nil
	}
	if err := startWorkspaceProc(ws, window, sample); err != nil {
		return "", err
	}
	for i := 0; i < 80; i++ { // up to 20 s (a master password would make it wait longer)
		time.Sleep(250 * time.Millisecond)
		if u, ok := existingInstance(dir, port); ok {
			return u, nil
		}
	}
	return "", fmt.Errorf("the workspace “%s” didn't start in time — try again", wsLabel(ws))
}

func (a *App) handleWorkspaces(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]any{"current": wsLabel(a.workspace), "workspaces": a.listWorkspaces(), "desktop": isDesktop})
}

// handleWorkspaceOpen: POST /api/workspaces/open {name, how: same|new, create, sample, folder}.
func (a *App) handleWorkspaceOpen(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Name   string `json:"name"`
		How    string `json:"how"`
		Create bool   `json:"create"`
		Sample bool   `json:"sample"`
		Folder string `json:"folder"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	ws := wsName(in.Name)
	if ws != "" && !wsNameRe.MatchString(ws) {
		writeErr(w, 400, errors.New("a workspace name may use letters, digits, spaces, _ . - (up to 40)"))
		return
	}
	if in.Folder != "" { // Open workspace…: an existing WorkHub data folder
		dir, has := resolveDataFolder(in.Folder)
		if !has {
			writeErr(w, 400, errors.New("that folder holds no WorkHub data (workhub.dat) — pick a workspace's data folder"))
			return
		}
		if ws == "" {
			ws = wsName(filepath.Base(filepath.Dir(dir)))
			if filepath.Base(dir) != "workhub-data" && filepath.Base(dir) != "data" {
				ws = wsName(filepath.Base(dir))
			}
		}
		if ws == "" || !wsNameRe.MatchString(ws) {
			writeErr(w, 400, errors.New("give the workspace a name"))
			return
		}
		if err := setPointer(ws, dir); err != nil {
			writeErr(w, 500, err)
			return
		}
	}
	exists := fileExists(filepath.Join(chosenDataDir(ws), "workhub.dat"))
	if in.Create && exists {
		writeErr(w, 400, fmt.Errorf("there is already a workspace called “%s” — pick another name or switch to it", wsLabel(ws)))
		return
	}
	if !in.Create && in.Folder == "" && !exists {
		writeErr(w, 404, fmt.Errorf("no workspace called “%s”", wsLabel(ws)))
		return
	}
	if filepath.Clean(chosenDataDir(ws)) == filepath.Clean(a.dataDir) {
		writeErr(w, 400, errors.New("that is the workspace you are in"))
		return
	}
	newWin := in.How == "new"
	u, err := a.startWorkspace(ws, newWin && isDesktop, in.Create && in.Sample)
	if err != nil {
		writeErr(w, 502, err)
		return
	}
	setLastWorkspace(ws)
	writeJSON(w, map[string]any{"url": u, "name": wsLabel(ws), "opened": newWin && isDesktop})
}

// handleWorkspaceClose: Close workspace — this one stops; Default takes over (same window in a browser,
// its own window on the Desktop) and is what opens next time.
func (a *App) handleWorkspaceClose(w http.ResponseWriter, r *http.Request) {
	if a.workspace == "" {
		writeErr(w, 400, errors.New("this is the Default workspace — to stop WorkHub use File → Quit"))
		return
	}
	u, err := a.startWorkspace("", isDesktop, false)
	if err != nil {
		writeErr(w, 502, err)
		return
	}
	setLastWorkspace("")
	writeJSON(w, map[string]any{"url": u})
	go func() { time.Sleep(1500 * time.Millisecond); a.shutdown() }()
}

// activeWorkspace: this is the workspace in use (its window had focus last), so it captures copies.
// Started with its own data folder (-data): always.
func (a *App) activeWorkspace() bool {
	if a.ownData {
		return true
	}
	return strings.EqualFold(lastWorkspace(), a.workspace)
}

// handleWorkspaceActive: the page got focus — this workspace is the one in use now (captures go here).
func (a *App) handleWorkspaceActive(w http.ResponseWriter, r *http.Request) {
	if !a.ownData && !strings.EqualFold(lastWorkspace(), a.workspace) {
		setLastWorkspace(a.workspace)
	}
	writeJSON(w, map[string]bool{"ok": true})
}
