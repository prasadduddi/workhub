package main

// "Sign in with browser" (Desktop version): Jira is opened in a small Edge
// (WebView2) window where you log in as usual — SSO and MFA included. Every
// Jira request is then made from inside that window, so Jira sees your normal
// session; no token is needed and no cookie leaves the window. The window
// stays open hidden while WorkHub runs, a keep-alive stops the session going
// idle, and the login is kept in WorkHub's own WebView2 profile, so after a
// restart it usually signs in again by itself.

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Set by the Desktop version (desktop_windows.go); nil elsewhere.
var (
	jiraWinOpen  func(url string, show, reload bool) error // creates the window at url if needed
	jiraWinHide  func()
	jiraWinShown func() bool // the window is on screen (the user may be logging in)
	jiraWinFetch func(url string) (status int, body string, err error)
)

var errNoJiraWin = errors.New("“Sign in with browser” works in WorkHub-Desktop.exe — in the web version use an API token or personal access token")

var (
	jiraSess struct {
		sync.Mutex
		ok    bool
		name  string
		at    time.Time
		since time.Time
	}
	jiraRelogin sync.Mutex
)

func jiraSignedIn(ok bool, name string) {
	jiraSess.Lock()
	defer jiraSess.Unlock()
	if ok && !jiraSess.ok {
		jiraSess.since = time.Now()
	}
	jiraSess.ok, jiraSess.at = ok, time.Now()
	if name != "" {
		jiraSess.name = name
	}
}

// browserFetch makes one request in the sign-in window. A login page, a 401
// or a window that isn't on Jira means the session has ended.
func browserFetch(base, path string) (int, string, error) {
	if jiraWinFetch == nil {
		return 0, "", errNoJiraWin
	}
	if err := jiraWinOpen(base+"/", false, false); err != nil {
		return 0, "", err
	}
	st, body, err := jiraWinFetch(base + path)
	if err != nil {
		return 0, "", err
	}
	if st == 0 || st == 401 || (st == 200 && strings.HasPrefix(strings.TrimSpace(body), "<")) {
		return 401, body, nil
	}
	return st, body, nil
}

// browserGet is jiraClient.get for the "browser" sign-in type. When the
// session has ended it reloads Jira once (SSO usually signs in again without
// asking) before giving up.
func (c *jiraClient) browserGet(path string, out any) error {
	base := strings.TrimRight(c.cfg.BaseURL, "/")
	st, body, err := browserFetch(base, path)
	if err != nil {
		return err
	}
	if st == 401 && reloginSilently(base) {
		if st, body, err = browserFetch(base, path); err != nil {
			return err
		}
	}
	switch {
	case st == 401:
		jiraSignedIn(false, "")
		return errors.New("not signed in to Jira — press “Sign in with browser” in Jira settings")
	case st == 403:
		return errors.New("Jira says you don't have access (403)")
	case st == 404:
		return errors.New("not found in Jira (404): check the key and the Jira address")
	case st >= 300:
		return fmt.Errorf("Jira answered %d", st)
	}
	jiraSignedIn(true, "")
	return json.Unmarshal([]byte(body), out)
}

// reloginSilently reloads Jira in the hidden window and waits a little for a
// single sign-on to finish by itself.
func reloginSilently(base string) bool {
	jiraRelogin.Lock()
	defer jiraRelogin.Unlock()
	if st, _, err := browserFetch(base, "/rest/api/2/myself"); err == nil && st == 200 {
		return true // another request already signed in again
	}
	if jiraWinShown != nil && jiraWinShown() {
		return false // never reload under someone typing their password
	}
	if jiraWinOpen(base+"/", false, true) != nil {
		return false
	}
	for i := 0; i < 10; i++ {
		time.Sleep(3 * time.Second)
		if st, _, err := browserFetch(base, "/rest/api/2/myself"); err == nil && st == 200 {
			return true
		}
	}
	return false
}

// checkJiraSession asks Jira who is signed in.
func checkJiraSession(cfg JiraConfig) (string, error) {
	var me struct {
		DisplayName string `json:"displayName"`
		Name        string `json:"name"`
	}
	c := &jiraClient{cfg: cfg}
	if err := c.browserGet("/rest/api/2/myself", &me); err != nil {
		return "", err
	}
	name := orDefault(me.DisplayName, me.Name)
	jiraSignedIn(true, name)
	return name, nil
}

// jiraKeepAlive opens the hidden window when WorkHub starts and touches the
// session every few minutes so it doesn't time out while you aren't using Jira.
func (a *App) jiraKeepAlive() {
	time.Sleep(5 * time.Second) // the Desktop window sets jiraWinFetch as it opens
	if jiraWinFetch == nil {
		return
	}
	for {
		if c := a.store.JiraConfig(); c.Mode == "browser" && c.BaseURL != "" {
			_, _ = checkJiraSession(c)
		}
		time.Sleep(4 * time.Minute)
	}
}

func (a *App) handleJiraBrowserStatus(w http.ResponseWriter, r *http.Request) {
	out := map[string]any{"available": jiraWinFetch != nil}
	if c := a.store.JiraConfig(); jiraWinFetch != nil && c.Mode == "browser" && c.BaseURL != "" {
		if r.URL.Query().Get("check") == "1" {
			if _, err := checkJiraSession(c); err != nil {
				out["error"] = err.Error()
			}
		}
		jiraSess.Lock()
		out["signed_in"], out["name"], out["checked"] = jiraSess.ok, jiraSess.name, jiraSess.at
		if jiraSess.ok {
			out["since"] = jiraSess.since
		}
		jiraSess.Unlock()
	}
	writeJSON(w, out)
}

// handleJiraBrowserOpen shows the sign-in window (or hides it: {"hide":true}).
func (a *App) handleJiraBrowserOpen(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Hide bool `json:"hide"`
	}
	_ = readJSON(r, &in)
	if jiraWinOpen == nil {
		writeErr(w, 400, errNoJiraWin)
		return
	}
	if in.Hide {
		jiraWinHide()
		writeJSON(w, map[string]bool{"ok": true})
		return
	}
	c := a.store.JiraConfig()
	if c.BaseURL == "" {
		writeErr(w, 400, errors.New("enter the Jira address first"))
		return
	}
	if err := jiraWinOpen(strings.TrimRight(c.BaseURL, "/")+"/", true, true); err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

// jiraReady: enough settings to talk to Jira.
func jiraReady(c JiraConfig) bool {
	return c.BaseURL != "" && (c.Token != "" || c.Mode == "browser")
}
