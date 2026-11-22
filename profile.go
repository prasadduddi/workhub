package main

// Personal profile: the user's own details (name, email…), typed in by each
// user and kept on their PC only, shared by all workspaces next to the default
// data folder. The email is where "Forgot PIN" sends a reset code, and it fills
// in the Jira email when that is empty.

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

type Profile struct {
	Name   string `json:"name"`
	Email  string `json:"email"`
	Phone  string `json:"phone,omitempty"`
	UserID string `json:"user_id,omitempty"` // company / Windows login
	Team   string `json:"team,omitempty"`
	Role   string `json:"role,omitempty"`
	Notes  string `json:"notes,omitempty"`
}

func (a *App) profileFile() string {
	if a.lockPath != "" { // -data given: keep it with that folder (demo, tests)
		return filepath.Join(filepath.Dir(a.lockPath), "profile.json")
	}
	return filepath.Join(filepath.Dir(defaultDataDir()), "profile.json")
}

func (a *App) profile() Profile {
	var p Profile
	if b, err := os.ReadFile(a.profileFile()); err == nil {
		_ = json.Unmarshal(b, &p)
	}
	return p
}

func (a *App) handleProfileGet(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, a.profile())
}

func (a *App) handleProfilePut(w http.ResponseWriter, r *http.Request) {
	var p Profile
	if err := readJSON(r, &p); err != nil {
		writeErr(w, 400, err)
		return
	}
	for _, f := range []*string{&p.Name, &p.Email, &p.Phone, &p.UserID, &p.Team, &p.Role} {
		*f = strings.TrimSpace(*f)
	}
	if p.Email != "" && !reEmail.MatchString(p.Email) {
		writeErr(w, 400, errors.New("that email address doesn't look right"))
		return
	}
	b, _ := json.MarshalIndent(p, "", "  ")
	_ = os.MkdirAll(filepath.Dir(a.profileFile()), 0o700)
	if err := writeAtomic(a.profileFile(), b); err != nil {
		writeErr(w, 500, err)
		return
	}
	if a.store != nil && p.Email != "" { // handy default for Jira Cloud's login
		if c := a.store.JiraConfig(); c.User == "" {
			c.User, c.Token = p.Email, ""
			a.store.SetJiraConfig(c)
		}
	}
	writeJSON(w, p)
}

// resetEmail: where the PIN reset code goes — the profile email, else the one
// saved with the PIN by an earlier version.
func (a *App) resetEmail() string {
	if e := a.profile().Email; e != "" {
		return e
	}
	c, _ := a.lockConf()
	return c.Email
}
