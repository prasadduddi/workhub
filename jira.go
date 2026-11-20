package main

// Jira page: tracked issues shown as a tree with their pull requests (from
// Jira's development panel and remote links) and their "CM-" items
// (sub-tasks and linked issues whose key or summary starts with a prefix).

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

type JiraConfig struct {
	BaseURL     string `json:"base_url"`
	Mode        string `json:"mode"`  // cloud (email + API token), server (personal access token), basic
	User        string `json:"user"`  // email or username
	Token       string `json:"token"` // never sent to the page
	ChildPrefix string `json:"child_prefix"`
}

type JiraPR struct {
	Name   string `json:"name"`
	URL    string `json:"url"`
	Status string `json:"status"` // OPEN, MERGED, DECLINED
	Repo   string `json:"repo,omitempty"`
	Author string `json:"author,omitempty"`
}

type JiraChild struct {
	Key      string `json:"key"`
	Summary  string `json:"summary"`
	Status   string `json:"status"`
	Type     string `json:"type"`
	URL      string `json:"url"`
	Relation string `json:"relation"` // sub-task or the link name
}

type JiraIssue struct {
	Key      string      `json:"key"`
	Summary  string      `json:"summary"`
	Status   string      `json:"status"`
	Type     string      `json:"type"`
	Assignee string      `json:"assignee"`
	URL      string      `json:"url"`
	PRs      []JiraPR    `json:"prs"`
	Children []JiraChild `json:"children"`
	Error    string      `json:"error,omitempty"`
	Fetched  time.Time   `json:"fetched,omitzero"`
	Added    time.Time   `json:"added"`
}

var jiraKeyRe = regexp.MustCompile(`\b([A-Z][A-Z0-9_]+-\d+)\b`)

// parseJiraRef accepts "PAY-123" or a link like https://jira.corp/browse/PAY-123.
func parseJiraRef(s string) (key, base string) {
	s = strings.TrimSpace(s)
	if u, err := url.Parse(s); err == nil && u.Host != "" {
		if m := jiraKeyRe.FindString(strings.ToUpper(u.Path + " " + u.RawQuery)); m != "" {
			p := u.Path
			if i := strings.Index(p, "/browse/"); i >= 0 {
				p = p[:i]
			} else if i := strings.Index(p, "/projects/"); i >= 0 {
				p = p[:i]
			} else {
				p = ""
			}
			return m, strings.TrimRight(u.Scheme+"://"+u.Host+p, "/")
		}
	}
	return jiraKeyRe.FindString(strings.ToUpper(s)), ""
}

// ---- store ----

func (s *Store) JiraConfig() JiraConfig {
	s.mu.RLock()
	defer s.mu.RUnlock()
	c := s.st.Jira
	if c.ChildPrefix == "" {
		c.ChildPrefix = "CM-"
	}
	return c
}

func (s *Store) SetJiraConfig(c JiraConfig) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if c.Token == "" { // blank keeps the saved token
		c.Token = s.st.Jira.Token
	}
	c.BaseURL = strings.TrimRight(strings.TrimSpace(c.BaseURL), "/")
	s.st.Jira = c
	s.changed()
}

func (s *Store) JiraIssues() []JiraIssue {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]JiraIssue, 0, len(s.st.JiraIssues))
	for _, j := range s.st.JiraIssues {
		out = append(out, *j)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Added.After(out[j].Added) })
	return out
}

func (s *Store) putJiraIssue(j JiraIssue) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, x := range s.st.JiraIssues {
		if x.Key == j.Key {
			j.Added = x.Added
			*x = j
			s.changed()
			return
		}
	}
	if j.Added.IsZero() {
		j.Added = time.Now()
	}
	s.st.JiraIssues = append(s.st.JiraIssues, &j)
	s.changed()
}

func (s *Store) removeJiraIssue(key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, x := range s.st.JiraIssues {
		if x.Key == key {
			s.st.JiraIssues = append(s.st.JiraIssues[:i], s.st.JiraIssues[i+1:]...)
			s.changed()
			return
		}
	}
}

// ---- Jira REST ----

type jiraClient struct {
	cfg  JiraConfig
	http *http.Client
}

func (c *jiraClient) get(path string, out any) error {
	req, _ := http.NewRequest("GET", c.cfg.BaseURL+path, nil)
	req.Header.Set("Accept", "application/json")
	switch c.cfg.Mode {
	case "server":
		req.Header.Set("Authorization", "Bearer "+c.cfg.Token)
	default: // cloud (email + API token) and basic (username + password)
		req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(c.cfg.User+":"+c.cfg.Token)))
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	switch {
	case resp.StatusCode == 401:
		return errors.New("Jira refused the login (401): check the email/username and token in Jira settings")
	case resp.StatusCode == 403:
		return errors.New("Jira says you don't have access (403)")
	case resp.StatusCode == 404:
		return errors.New("not found in Jira (404): check the key and the Jira address")
	case resp.StatusCode >= 300:
		return fmt.Errorf("Jira answered %s", resp.Status)
	}
	return json.Unmarshal(body, out)
}

type jiraFields struct {
	Summary   string                `json:"summary"`
	Status    struct{ Name string } `json:"status"`
	IssueType struct{ Name string } `json:"issuetype"`
	Assignee  *struct {
		DisplayName string `json:"displayName"`
	} `json:"assignee"`
	Subtasks []struct {
		Key    string `json:"key"`
		Fields struct {
			Summary   string                `json:"summary"`
			Status    struct{ Name string } `json:"status"`
			IssueType struct{ Name string } `json:"issuetype"`
		} `json:"fields"`
	} `json:"subtasks"`
	IssueLinks []struct {
		Type struct {
			Inward  string `json:"inward"`
			Outward string `json:"outward"`
		} `json:"type"`
		InwardIssue, OutwardIssue *struct {
			Key    string `json:"key"`
			Fields struct {
				Summary   string                `json:"summary"`
				Status    struct{ Name string } `json:"status"`
				IssueType struct{ Name string } `json:"issuetype"`
			} `json:"fields"`
		}
	} `json:"issuelinks"`
}

var prURLRe = regexp.MustCompile(`(?i)/pull/\d+|/pull-requests/\d+|/merge_requests/\d+|/pullrequests?/\d+`)

// fetchJira reads one issue with its pull requests and prefixed children.
func fetchJira(cfg JiraConfig, key string) JiraIssue {
	j := JiraIssue{Key: key, URL: cfg.BaseURL + "/browse/" + key, Fetched: time.Now(), PRs: []JiraPR{}, Children: []JiraChild{}}
	if cfg.BaseURL == "" {
		j.Error = "set the Jira address in Jira settings first"
		return j
	}
	c := &jiraClient{cfg: cfg, http: &http.Client{Timeout: 20 * time.Second}}
	var issue struct {
		ID     string     `json:"id"`
		Key    string     `json:"key"`
		Fields jiraFields `json:"fields"`
	}
	if err := c.get("/rest/api/2/issue/"+url.PathEscape(key)+"?fields=summary,status,issuetype,assignee,subtasks,issuelinks", &issue); err != nil {
		j.Error = err.Error()
		return j
	}
	f := issue.Fields
	j.Summary, j.Status, j.Type = f.Summary, f.Status.Name, f.IssueType.Name
	if f.Assignee != nil {
		j.Assignee = f.Assignee.DisplayName
	}
	prefix := strings.ToUpper(strings.TrimSpace(orDefault(cfg.ChildPrefix, "CM-")))
	wanted := func(k, summary string) bool {
		return prefix == "*" || strings.HasPrefix(strings.ToUpper(k), prefix) || strings.HasPrefix(strings.ToUpper(strings.TrimSpace(summary)), prefix)
	}
	for _, st := range f.Subtasks {
		if wanted(st.Key, st.Fields.Summary) {
			j.Children = append(j.Children, JiraChild{st.Key, st.Fields.Summary, st.Fields.Status.Name, st.Fields.IssueType.Name, cfg.BaseURL + "/browse/" + st.Key, "sub-task"})
		}
	}
	for _, l := range f.IssueLinks {
		other, rel := l.OutwardIssue, l.Type.Outward
		if other == nil {
			other, rel = l.InwardIssue, l.Type.Inward
		}
		if other != nil && wanted(other.Key, other.Fields.Summary) {
			j.Children = append(j.Children, JiraChild{other.Key, other.Fields.Summary, other.Fields.Status.Name, other.Fields.IssueType.Name, cfg.BaseURL + "/browse/" + other.Key, rel})
		}
	}

	// Pull requests from the development panel (GitHub, Bitbucket, GitLab…).
	seen := map[string]bool{}
	var summary struct {
		Summary struct {
			PullRequest struct {
				ByInstanceType map[string]any `json:"byInstanceType"`
			} `json:"pullrequest"`
		} `json:"summary"`
	}
	types := []string{}
	if c.get("/rest/dev-status/latest/issue/summary?issueId="+url.QueryEscape(issue.ID), &summary) == nil {
		for t := range summary.Summary.PullRequest.ByInstanceType {
			types = append(types, t)
		}
	}
	if len(types) == 0 {
		types = []string{"GitHub", "bitbucket", "stash", "gitlab"}
	}
	sort.Strings(types)
	for _, t := range types {
		var det struct {
			Detail []struct {
				PullRequests []struct {
					Name           string `json:"name"`
					URL            string `json:"url"`
					Status         string `json:"status"`
					RepositoryName string `json:"repositoryName"`
					Author         struct {
						Name string `json:"name"`
					} `json:"author"`
				} `json:"pullRequests"`
			} `json:"detail"`
		}
		if c.get("/rest/dev-status/latest/issue/detail?issueId="+url.QueryEscape(issue.ID)+"&applicationType="+url.QueryEscape(t)+"&dataType=pullrequest", &det) != nil {
			continue
		}
		for _, d := range det.Detail {
			for _, p := range d.PullRequests {
				if p.URL != "" && !seen[p.URL] {
					seen[p.URL] = true
					j.PRs = append(j.PRs, JiraPR{p.Name, p.URL, strings.ToUpper(p.Status), p.RepositoryName, p.Author.Name})
				}
			}
		}
	}
	// Pull requests attached as plain web links.
	var links []struct {
		Object struct {
			URL   string `json:"url"`
			Title string `json:"title"`
		} `json:"object"`
	}
	if c.get("/rest/api/2/issue/"+url.PathEscape(key)+"/remotelink", &links) == nil {
		for _, l := range links {
			if prURLRe.MatchString(l.Object.URL) && !seen[l.Object.URL] {
				seen[l.Object.URL] = true
				j.PRs = append(j.PRs, JiraPR{Name: orDefault(l.Object.Title, l.Object.URL), URL: l.Object.URL, Status: ""})
			}
		}
	}
	return j
}

// ---- background refresh ----

var jiraMu sync.Mutex

func (a *App) refreshJira(keys ...string) {
	jiraMu.Lock()
	defer jiraMu.Unlock()
	cfg := a.store.JiraConfig()
	if len(keys) == 0 {
		for _, j := range a.store.JiraIssues() {
			keys = append(keys, j.Key)
		}
	}
	for _, k := range keys {
		a.store.putJiraIssue(fetchJira(cfg, k))
	}
}

func (a *App) jiraWatcher() {
	for range time.Tick(15 * time.Minute) {
		if a.store.JiraConfig().BaseURL != "" {
			a.refreshJira()
		}
	}
}

// ---- HTTP ----

func (a *App) handleJiraConfigGet(w http.ResponseWriter, r *http.Request) {
	c := a.store.JiraConfig()
	has := c.Token != ""
	c.Token = ""
	writeJSON(w, map[string]any{"config": c, "has_token": has})
}

func (a *App) handleJiraConfigPut(w http.ResponseWriter, r *http.Request) {
	var c JiraConfig
	if err := readJSON(r, &c); err != nil {
		writeErr(w, 400, err)
		return
	}
	a.store.SetJiraConfig(c)
	go a.refreshJira()
	writeJSON(w, map[string]bool{"ok": true})
}

func (a *App) handleJiraList(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, a.store.JiraIssues())
}

func (a *App) handleJiraAdd(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Ref string `json:"ref"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	var keys []string
	for _, part := range strings.FieldsFunc(in.Ref, func(r rune) bool { return r == ',' || r == ' ' || r == '\n' || r == ';' }) {
		key, base := parseJiraRef(part)
		if key == "" {
			continue
		}
		if base != "" && a.store.JiraConfig().BaseURL == "" { // first pasted link sets the Jira address
			c := a.store.JiraConfig()
			c.BaseURL = base
			a.store.SetJiraConfig(c)
		}
		keys = append(keys, key)
	}
	if len(keys) == 0 {
		writeErr(w, 400, errors.New("type a Jira key like PAY-123, or paste an issue link"))
		return
	}
	a.refreshJira(keys...)
	writeJSON(w, a.store.JiraIssues())
}

func (a *App) handleJiraRefresh(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Key string `json:"key"`
	}
	_ = readJSON(r, &in)
	if in.Key != "" {
		a.refreshJira(in.Key)
	} else {
		a.refreshJira()
	}
	writeJSON(w, a.store.JiraIssues())
}

func (a *App) handleJiraRemove(w http.ResponseWriter, r *http.Request) {
	a.store.removeJiraIssue(r.PathValue("key"))
	writeJSON(w, map[string]bool{"ok": true})
}
