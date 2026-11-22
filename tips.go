package main

// "What's new" popup: remembers which release notes the user chose to hide
// (shared by all workspaces, next to the default data folder) so each new
// version shows its notes once at start-up.

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func tipsFile() string { return filepath.Join(filepath.Dir(defaultDataDir()), "whats-new-hidden.txt") }

func (a *App) handleTipsGet(w http.ResponseWriter, r *http.Request) {
	b, _ := os.ReadFile(tipsFile())
	writeJSON(w, map[string]string{"hidden": strings.TrimSpace(string(b)), "version": version})
}

func (a *App) handleTipsHide(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Hidden string `json:"hidden"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	_ = os.MkdirAll(filepath.Dir(tipsFile()), 0o700)
	if err := os.WriteFile(tipsFile(), []byte(in.Hidden+"\n"), 0o600); err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}
