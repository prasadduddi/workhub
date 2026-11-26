package main

// Confluence (read only), for "Ask Confluence & Jira": searching pages and
// reading a page's text. Sign-in types as for Jira: cloud (email + API token),
// server (personal access token), basic (user + password), browser (WorkHub-
// Desktop: a sign-in window, SSO/MFA included — see jira_browser.go), or
// "jira" (the same site and login as WorkHub's Jira connection: Atlassian
// Cloud, where Confluence is at <site>/wiki). Tokens never go to the page.

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

type ConfluenceConfig struct {
	BaseURL string `json:"base_url"` // e.g. https://acme.atlassian.net/wiki or https://confluence.acme.local
	Mode    string `json:"mode"`     // jira, cloud, server, basic, browser
	User    string `json:"user"`
	Token   string `json:"token"` // never sent to the page
}

func (s *Store) ConfluenceConfig() ConfluenceConfig {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.st.Confluence
}

func (s *Store) SetConfluenceConfig(c ConfluenceConfig) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if c.Token == "" { // blank keeps the saved token
		c.Token = s.st.Confluence.Token
	}
	c.BaseURL = strings.TrimRight(strings.TrimSpace(c.BaseURL), "/")
	s.st.Confluence = c
	s.changed()
}

// Set by the Desktop version: Confluence's own sign-in window (same WebView2
// profile as Jira's, so a company single sign-on usually signs it in by itself).
var (
	confWinOpen  func(url string, show, reload bool) error
	confWinHide  func()
	confWinShown func() bool
	confWinFetch func(url string) (status int, body string, err error)
)

var confSess struct {
	sync.Mutex
	ok   bool
	name string
	at   time.Time
}

// effective: the address and login actually used ("jira" borrows Jira's).
func (a *App) confEffective() (ConfluenceConfig, error) {
	c := a.store.ConfluenceConfig()
	if c.Mode == "" && c.BaseURL == "" { // never set up: try the Jira login (Atlassian Cloud: <site>/wiki)
		c.Mode = "jira"
	}
	if c.Mode == "jira" {
		j := a.store.JiraConfig()
		if j.BaseURL == "" {
			return c, errors.New("set up Jira first (or give Confluence its own sign-in)")
		}
		if c.BaseURL == "" {
			c.BaseURL = strings.TrimRight(j.BaseURL, "/") + "/wiki"
		}
		c.Mode, c.User, c.Token = j.Mode, j.User, j.Token
		if c.Mode == "" {
			c.Mode = "cloud"
		}
	}
	if c.BaseURL == "" {
		return c, errors.New("Confluence isn't set up — ⚙ Settings → Ask")
	}
	if c.Mode != "browser" && c.Token == "" {
		return c, errors.New("Confluence needs a token or password — ⚙ Settings → Ask")
	}
	return c, nil
}

var confHTTP = &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{Proxy: http.ProxyFromEnvironment}}

// confGet reads a Confluence REST path (relative to the base address) as JSON.
func (a *App) confGet(path string, out any) error {
	c, err := a.confEffective()
	if err != nil {
		return err
	}
	var st int
	var body string
	if c.Mode == "browser" {
		if confWinFetch == nil {
			return errors.New("“Sign in with browser” works in WorkHub-Desktop.exe — in the web version use a token")
		}
		if err := confWinOpen(c.BaseURL+"/", false, false); err != nil {
			return err
		}
		if st, body, err = confWinFetch(c.BaseURL + path); err != nil {
			return err
		}
		if st == 0 || (st == 200 && strings.HasPrefix(strings.TrimSpace(body), "<")) {
			st = 401 // the window is on a login page
		}
	} else {
		req, _ := http.NewRequest(http.MethodGet, c.BaseURL+path, nil)
		req.Header.Set("Accept", "application/json")
		if c.Mode == "server" {
			req.Header.Set("Authorization", "Bearer "+c.Token)
		} else {
			req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(c.User+":"+c.Token)))
		}
		resp, err := confHTTP.Do(req)
		if err != nil {
			return fmt.Errorf("Confluence: %w", err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
		st, body = resp.StatusCode, string(b)
	}
	confSess.Lock()
	confSess.ok, confSess.at = st < 300, time.Now()
	confSess.Unlock()
	switch {
	case st == 401:
		return errors.New("not signed in to Confluence — ⚙ Settings → Ask")
	case st == 403:
		return errors.New("Confluence says you don't have access (403)")
	case st == 404:
		return errors.New("not found in Confluence (404) — check the Confluence address (Cloud: …atlassian.net/wiki)")
	case st >= 300:
		return fmt.Errorf("Confluence answered %d", st)
	}
	return json.Unmarshal([]byte(body), out)
}

type askResult struct {
	Source  string    `json:"source"` // confluence | jira
	ID      string    `json:"id"`     // page id / issue key
	Title   string    `json:"title"`
	URL     string    `json:"url"`
	Where   string    `json:"where,omitempty"` // space / project
	Kind    string    `json:"kind,omitempty"`  // page, blogpost, Story, Bug…
	Status  string    `json:"status,omitempty"`
	Snip    string    `json:"snip"`
	Updated time.Time `json:"updated,omitzero"`
	text    string    // more of the text, for the AI answer
	score   float64
}

var confHL = strings.NewReplacer("@@@hl@@@", "", "@@@endhl@@@", "")

// confSearch: pages and blog posts with the words (Confluence's own ranking).
func (a *App) confSearch(words []string, limit int) ([]askResult, error) {
	cql := fmt.Sprintf(`type in (page, blogpost) AND text ~ "%s"`, strings.ReplaceAll(strings.Join(words, " "), `"`, ``))
	var res struct {
		Results []struct {
			Content struct {
				ID    string `json:"id"`
				Type  string `json:"type"`
				Title string `json:"title"`
			} `json:"content"`
			Title        string `json:"title"`
			Excerpt      string `json:"excerpt"`
			URL          string `json:"url"`
			LastModified string `json:"lastModified"`
			Container    struct {
				Title string `json:"title"`
			} `json:"resultGlobalContainer"`
		} `json:"results"`
		Links struct {
			Base string `json:"base"`
		} `json:"_links"`
	}
	if err := a.confGet(fmt.Sprintf("/rest/api/search?cql=%s&limit=%d&excerpt=highlight", url.QueryEscape(cql), limit), &res); err != nil {
		return nil, err
	}
	c, _ := a.confEffective()
	base := orDefault(res.Links.Base, c.BaseURL)
	out := []askResult{}
	for _, r := range res.Results {
		if r.Content.ID == "" {
			continue
		}
		u := r.URL
		if !strings.HasPrefix(u, "http") {
			u = strings.TrimRight(base, "/") + u
		}
		t, _ := time.Parse(time.RFC3339, r.LastModified)
		snip := strings.Join(strings.Fields(html.UnescapeString(tagRe.ReplaceAllString(confHL.Replace(r.Excerpt), " "))), " ")
		out = append(out, askResult{Source: "confluence", ID: r.Content.ID, Title: orDefault(r.Content.Title, r.Title), URL: u, Where: r.Container.Title,
			Kind: r.Content.Type, Snip: snip, Updated: t})
	}
	return out, nil
}

// confPageText: a page's text (for the AI answer), at most max characters.
func (a *App) confPageText(id string, max int) string {
	var p struct {
		Body struct {
			Storage struct {
				Value string `json:"value"`
			} `json:"storage"`
		} `json:"body"`
	}
	if a.confGet("/rest/api/content/"+url.PathEscape(id)+"?expand=body.storage", &p) != nil {
		return ""
	}
	h := strings.NewReplacer("</p>", "\n", "<br/>", "\n", "<br>", "\n", "</li>", "\n", "</tr>", "\n", "</h1>", "\n", "</h2>", "\n", "</h3>", "\n").Replace(p.Body.Storage.Value)
	t := html.UnescapeString(tagRe.ReplaceAllString(h, " "))
	lines := []string{}
	for _, l := range strings.Split(t, "\n") {
		if l = strings.Join(strings.Fields(l), " "); l != "" {
			lines = append(lines, l)
		}
	}
	t = strings.Join(lines, "\n")
	if len([]rune(t)) > max {
		t = string([]rune(t)[:max]) + " …"
	}
	return t
}

// ---- settings ----

func (a *App) handleConfluenceGet(w http.ResponseWriter, r *http.Request) {
	c := a.store.ConfluenceConfig()
	has := c.Token != ""
	c.Token = ""
	confSess.Lock()
	ok, at := confSess.ok, confSess.at
	confSess.Unlock()
	writeJSON(w, map[string]any{"config": c, "has_token": has, "browser": confWinFetch != nil, "signed_in": ok, "checked": at})
}

func (a *App) handleConfluencePut(w http.ResponseWriter, r *http.Request) {
	var c ConfluenceConfig
	if err := readJSON(r, &c); err != nil {
		writeErr(w, 400, err)
		return
	}
	a.store.SetConfluenceConfig(c)
	writeJSON(w, map[string]bool{"ok": true})
}

// handleConfluenceTest: is the connection working? (a one-result search)
func (a *App) handleConfluenceTest(w http.ResponseWriter, r *http.Request) {
	var res struct {
		Size int `json:"size"`
	}
	if err := a.confGet("/rest/api/space?limit=1", &res); err != nil {
		writeErr(w, 400, err)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

// handleConfluenceBrowser shows the sign-in window (or hides it: {"hide":true}).
func (a *App) handleConfluenceBrowser(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Hide bool `json:"hide"`
	}
	_ = readJSON(r, &in)
	if confWinOpen == nil {
		writeErr(w, 400, errors.New("“Sign in with browser” works in WorkHub-Desktop.exe — in the web version use a token"))
		return
	}
	if in.Hide {
		confWinHide()
		writeJSON(w, map[string]bool{"ok": true})
		return
	}
	c := a.store.ConfluenceConfig()
	if c.BaseURL == "" {
		writeErr(w, 400, errors.New("enter the Confluence address first"))
		return
	}
	if err := confWinOpen(c.BaseURL+"/", true, true); err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}
