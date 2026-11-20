package main

import (
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"

	pty "github.com/aymanbagabas/go-pty"
	"github.com/gorilla/websocket"
)

type localShell struct {
	ID, Name, Path string
	Args           []string
}

// localShells lists shells for the command prompt tabs: cmd and PowerShell on
// Windows (plus Git Bash if installed), the login shell elsewhere.
func localShells() []localShell {
	if runtime.GOOS != "windows" {
		sh := orDefault(os.Getenv("SHELL"), "/bin/sh")
		return []localShell{{ID: "shell", Name: filepath.Base(sh), Path: sh, Args: []string{"-l"}}}
	}
	var out []localShell
	if p, err := exec.LookPath("cmd.exe"); err == nil {
		out = append(out, localShell{ID: "cmd", Name: "Command Prompt", Path: p})
	}
	if p, err := exec.LookPath("pwsh.exe"); err == nil {
		out = append(out, localShell{ID: "pwsh", Name: "PowerShell 7", Path: p, Args: []string{"-NoLogo"}})
	}
	if p, err := exec.LookPath("powershell.exe"); err == nil {
		out = append(out, localShell{ID: "powershell", Name: "PowerShell", Path: p, Args: []string{"-NoLogo"}})
	}
	for _, p := range []string{
		filepath.Join(os.Getenv("ProgramFiles"), "Git", "bin", "bash.exe"),
		filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "Git", "bin", "bash.exe"),
	} {
		if fileExists(p) {
			out = append(out, localShell{ID: "gitbash", Name: "Git Bash", Path: p, Args: []string{"--login", "-i"}})
			break
		}
	}
	return out
}

func (a *App) handleLocalShells(w http.ResponseWriter, r *http.Request) {
	type s struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	out := []s{}
	for _, sh := range localShells() {
		out = append(out, s{sh.ID, sh.Name})
	}
	writeJSON(w, out)
}

// handleLocalTerm runs a shell on this PC in a pseudo-console and bridges it
// to the browser terminal (same message format as SSH tabs).
func (a *App) handleLocalTerm(w http.ResponseWriter, r *http.Request) {
	var sh *localShell
	for _, s := range localShells() {
		if s.ID == r.URL.Query().Get("shell") {
			sh = &s
		}
	}
	if sh == nil {
		http.Error(w, "unknown shell", 404)
		return
	}
	// Start in the folder asked for, else the folder last open in FileZilla's
	// This PC pane, else the home folder.
	dir := r.URL.Query().Get("dir")
	if dir == "" && a.store != nil {
		dir = a.store.LocalDir()
	}
	if st, err := os.Stat(dir); dir == "" || err != nil || !st.IsDir() {
		dir, _ = os.UserHomeDir()
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
	p, err := pty.New()
	if err != nil {
		send([]byte("\x1b[31mCannot create a console: " + err.Error() + "\x1b[0m\r\n"))
		return
	}
	defer p.Close()
	_ = p.Resize(max(start.Cols, 20), max(start.Rows, 5))
	cmd := p.Command(sh.Path, sh.Args...)
	cmd.Dir = dir
	cmd.Env = append(shellEnv(), "TERM=xterm-256color")
	if err := cmd.Start(); err != nil {
		send([]byte("\x1b[31mCannot start " + sh.Name + ": " + err.Error() + "\x1b[0m\r\n"))
		return
	}
	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, err := p.Read(buf)
			if n > 0 {
				send(append([]byte(nil), buf[:n]...))
			}
			if err != nil {
				return
			}
		}
	}()
	go func() {
		_ = cmd.Wait()
		send([]byte("\r\n\x1b[90m[" + sh.Name + " closed]\x1b[0m\r\n"))
		conn.Close()
	}()
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			if cmd.Process != nil {
				_ = cmd.Process.Kill()
			}
			return
		}
		var m termMsg
		if json.Unmarshal(data, &m) != nil {
			continue
		}
		switch m.T {
		case "d":
			_, _ = p.Write([]byte(m.D))
		case "r":
			if m.Cols > 0 && m.Rows > 0 {
				_ = p.Resize(m.Cols, m.Rows)
			}
		}
	}
}
