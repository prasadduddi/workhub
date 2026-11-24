package main

// Monitor: is each server answering? Tomcat manager / host-manager pages are
// fetched over HTTP (any answer below 500, including a login prompt, means
// it is up); Tomcat ports (8080, 8443, 8005 admin) and Oracle listeners
// (1521) are checked by connecting to the port. Nothing logs in, nothing is
// changed. PROD, UAT and DR servers are never checked unless "allow_prod" is
// switched on. Checks run every Interval seconds while monitoring is on.

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type MonitorCheck struct {
	ID      string `json:"id"`
	EntryID string `json:"entry_id,omitempty"`
	Name    string `json:"name"`
	Kind    string `json:"kind"`   // http or tcp
	Target  string `json:"target"` // URL, or host:port
	Group   string `json:"group"`  // Tomcat, Oracle, Custom
	Host    string `json:"host"`
	Env     string `json:"env,omitempty"`
}

type MonitorSettings struct {
	On        bool           `json:"on"`
	Interval  int            `json:"interval"`             // seconds; 60 by default
	AllowProd bool           `json:"allow_prod,omitempty"` // also PROD / UAT / DR
	Checks    []MonitorCheck `json:"checks"`
}

type monStatus struct {
	Up     *bool     `json:"up"` // nil: not checked yet
	Ms     int       `json:"ms"`
	Detail string    `json:"detail"`
	At     time.Time `json:"at,omitzero"`
	Since  time.Time `json:"since,omitzero"` // up or down since
	Hist   []bool    `json:"hist"`           // last results, oldest first
}

type monitor struct {
	mu     sync.Mutex
	status map[string]*monStatus
	kick   chan struct{}
}

var monBlockedEnvs = map[string]bool{"PROD": true, "UAT": true, "DR": true}

// monEnv: the environment now (from the connection, as it may have changed).
func (a *App) monEnv(c MonitorCheck) string {
	if c.EntryID != "" {
		if e, ok := a.store.Entry(c.EntryID); ok {
			return e.Env
		}
	}
	return c.Env
}

func (a *App) monBlocked(c MonitorCheck, s MonitorSettings) bool {
	return !s.AllowProd && monBlockedEnvs[strings.ToUpper(a.monEnv(c))]
}

var monHTTP = &http.Client{
	Timeout: 6 * time.Second,
	Transport: &http.Transport{
		Proxy:           nil,                                   // internal servers: straight there
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, // internal self-signed certificates; nothing is sent
	},
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

// probe runs one check: up, how long it took, and what it saw.
func probe(c MonitorCheck) (bool, time.Duration, string) {
	start := time.Now()
	switch c.Kind {
	case "http":
		resp, err := monHTTP.Get(c.Target)
		took := time.Since(start)
		if err != nil {
			return false, took, shortNetErr(err)
		}
		resp.Body.Close()
		note := resp.Status
		if resp.StatusCode == 401 || resp.StatusCode == 403 {
			note += " — answering (login needed)"
		}
		return resp.StatusCode < 500, took, note
	default:
		conn, err := net.DialTimeout("tcp", c.Target, 4*time.Second)
		took := time.Since(start)
		if err != nil {
			return false, took, shortNetErr(err)
		}
		conn.Close()
		return true, took, "port open"
	}
}

func shortNetErr(err error) string {
	var ne net.Error
	s := err.Error()
	switch {
	case errors.As(err, &ne) && ne.Timeout():
		return "no answer (timed out)"
	case strings.Contains(s, "refused"):
		return "connection refused — nothing listening"
	case strings.Contains(s, "no such host"):
		return "unknown host name"
	}
	if i := strings.LastIndex(s, ": "); i > 0 {
		return s[i+2:]
	}
	return s
}

// monitorLoop checks everything every Interval while monitoring is on.
func (a *App) monitorLoop() {
	for {
		s := a.store.Settings().Monitor
		if s.On {
			a.runChecks(s)
		}
		wait := time.Duration(max(s.Interval, 15)) * time.Second
		if s.Interval == 0 {
			wait = time.Minute
		}
		select {
		case <-time.After(wait):
		case <-a.mon.kick:
		}
	}
}

func (a *App) runChecks(s MonitorSettings) {
	var wg sync.WaitGroup
	sem := make(chan struct{}, 8)
	for _, c := range s.Checks {
		if a.monBlocked(c, s) {
			continue
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(c MonitorCheck) {
			defer func() { <-sem; wg.Done() }()
			up, took, detail := probe(c)
			a.mon.mu.Lock()
			st := a.mon.status[c.ID]
			if st == nil {
				st = &monStatus{}
				a.mon.status[c.ID] = st
			}
			if st.Up == nil || *st.Up != up {
				st.Since = time.Now()
			}
			st.Up, st.Ms, st.Detail, st.At = &up, int(took.Milliseconds()), detail, time.Now()
			st.Hist = append(st.Hist, up)
			if len(st.Hist) > 60 {
				st.Hist = st.Hist[len(st.Hist)-60:]
			}
			a.mon.mu.Unlock()
		}(c)
	}
	wg.Wait()
}

// ---- suggestions from saved connections ----

var reTomcatPath = regexp.MustCompile(`(?i)/(host-)?manager(/|$)`)

func (a *App) monitorSuggest() []MonitorCheck {
	var out []MonitorCheck
	seen := map[string]bool{}
	add := func(c MonitorCheck) {
		if seen[c.Kind+c.Target] {
			return
		}
		seen[c.Kind+c.Target] = true
		c.ID = randomHex(6)
		out = append(out, c)
	}
	for _, e := range a.store.Entries() {
		if e.Hidden {
			continue
		}
		low := strings.ToLower(e.URL + " " + e.Name)
		if u, err := url.Parse(e.URL); err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Hostname() != "" {
			port := u.Port()
			if port == "" {
				port = map[string]string{"http": "80", "https": "443"}[u.Scheme]
			}
			tomcat := reTomcatPath.MatchString(u.Path) || strings.Contains(low, "tomcat")
			if tomcat || port == "8080" || port == "8443" {
				name := "Tomcat"
				if m := reTomcatPath.FindStringSubmatch(u.Path); m != nil {
					name = map[bool]string{true: "Tomcat host-manager (admin)", false: "Tomcat manager"}[m[1] != ""]
					add(MonitorCheck{EntryID: e.ID, Name: name, Kind: "http", Target: e.URL, Group: "Tomcat", Host: u.Hostname(), Env: e.Env})
				}
				add(MonitorCheck{EntryID: e.ID, Name: "Tomcat port " + port, Kind: "tcp", Target: net.JoinHostPort(u.Hostname(), port), Group: "Tomcat", Host: u.Hostname(), Env: e.Env})
			}
		}
		if e.Host != "" && e.Port == 8005 {
			add(MonitorCheck{EntryID: e.ID, Name: "Tomcat admin (shutdown) port 8005", Kind: "tcp", Target: net.JoinHostPort(e.Host, "8005"), Group: "Tomcat", Host: e.Host, Env: e.Env})
		}
		if isOracle(e) {
			port := e.Port
			if port == 0 {
				port = 1521
			}
			host := e.Host
			if host == "" {
				host, port = oracleHostPort(e.URL)
			}
			if host != "" {
				add(MonitorCheck{EntryID: e.ID, Name: "Oracle listener " + strconv.Itoa(port), Kind: "tcp", Target: net.JoinHostPort(host, strconv.Itoa(port)), Group: "Oracle", Host: host, Env: e.Env})
			}
		}
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].Host < out[j].Host || out[i].Host == out[j].Host && out[i].Name < out[j].Name
	})
	return out
}

func isOracle(e EntryView) bool {
	return strings.EqualFold(e.Protocol, "oracle") || strings.HasPrefix(strings.ToLower(e.URL), "jdbc:oracle") || (e.Port == 1521 && e.Host != "")
}

var reJDBCOracle = regexp.MustCompile(`(?i)@(?://)?([A-Za-z0-9.\-]+):(\d+)`)

func oracleHostPort(u string) (string, int) {
	if m := reJDBCOracle.FindStringSubmatch(u); m != nil {
		p, _ := strconv.Atoi(m[2])
		return m[1], p
	}
	return "", 0
}

// ---- HTTP ----

func (a *App) handleMonitorGet(w http.ResponseWriter, r *http.Request) {
	s := a.store.Settings().Monitor
	if s.Interval == 0 {
		s.Interval = 60
	}
	type row struct {
		MonitorCheck
		monStatus
		Blocked bool `json:"blocked"`
	}
	rows := []row{}
	a.mon.mu.Lock()
	for _, c := range s.Checks {
		x := row{MonitorCheck: c, Blocked: a.monBlocked(c, s)}
		x.Env = a.monEnv(c)
		if st := a.mon.status[c.ID]; st != nil {
			x.monStatus = *st
			x.Hist = append([]bool(nil), st.Hist...)
		}
		rows = append(rows, x)
	}
	a.mon.mu.Unlock()
	writeJSON(w, map[string]any{"on": s.On, "interval": s.Interval, "allow_prod": s.AllowProd, "checks": rows})
}

func (a *App) handleMonitorSave(w http.ResponseWriter, r *http.Request) {
	var in MonitorSettings
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	for i, c := range in.Checks {
		c.Target = strings.TrimSpace(c.Target)
		if c.Kind != "http" && c.Kind != "tcp" {
			writeErr(w, 400, fmt.Errorf("%s: kind must be http or tcp", c.Name))
			return
		}
		if c.Kind == "http" {
			if u, err := url.Parse(c.Target); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
				writeErr(w, 400, fmt.Errorf("%q is not a web address", c.Target))
				return
			}
		} else if _, _, err := net.SplitHostPort(c.Target); err != nil {
			writeErr(w, 400, fmt.Errorf("%q: give host:port, e.g. db01.example.com:1521", c.Target))
			return
		}
		if c.ID == "" {
			c.ID = randomHex(6)
		}
		in.Checks[i] = c
	}
	st := a.store.Settings()
	st.Monitor = in
	a.store.SetSettings(st)
	a.kickMonitor()
	a.handleMonitorGet(w, r)
}

func (a *App) handleMonitorRun(w http.ResponseWriter, r *http.Request) {
	s := a.store.Settings().Monitor
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	done := make(chan struct{})
	go func() { a.runChecks(s); close(done) }()
	select {
	case <-done:
	case <-ctx.Done():
	}
	a.handleMonitorGet(w, r)
}

func (a *App) handleMonitorSuggest(w http.ResponseWriter, r *http.Request) {
	s := a.store.Settings().Monitor
	have := map[string]bool{}
	for _, c := range s.Checks {
		have[c.Kind+c.Target] = true
	}
	type sug struct {
		MonitorCheck
		Blocked bool `json:"blocked"`
	}
	out := []sug{}
	for _, c := range a.monitorSuggest() {
		if !have[c.Kind+c.Target] {
			out = append(out, sug{c, a.monBlocked(c, s)})
		}
	}
	writeJSON(w, out)
}

func (a *App) kickMonitor() {
	select {
	case a.mon.kick <- struct{}{}:
	default:
	}
}
