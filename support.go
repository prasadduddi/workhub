package main

// 📋 Help → Copy a support report: what's needed to find out why something
// fails on the user's own systems — version, which features are on, counts, and
// the last errors of each feature — with addresses, hosts, IPs, emails and
// secrets taken out, so it can be pasted anywhere.

import (
	"fmt"
	"net/http"
	"os"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

type featErr struct {
	At  time.Time
	Msg string
}

var featErrs = struct {
	sync.Mutex
	m map[string][]featErr
}{m: map[string][]featErr{}}

var (
	reURLs    = regexp.MustCompile(`(?i)\b(?:https?|wss?|jdbc:[a-z]+(?::[a-z]+)*|ldaps?|sftp|ssh)://[^\s"'<>)]+|jdbc:oracle:thin:@[^\s"'<>]+`)
	reEmails  = regexp.MustCompile(`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`)
	reIPv4s   = regexp.MustCompile(`\b\d{1,3}(?:\.\d{1,3}){3}\b`)
	reSecret  = regexp.MustCompile(`(?i)\b(?:sk-ant-[\w-]+|bearer\s+[\w.~+/=-]+|token[=:]\s*[\w.~+/=-]+|password[=:]\s*\S+|t=[0-9a-f]{16,})`)
	reHosts   = regexp.MustCompile(`\b(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b`)
	reWinPath = regexp.MustCompile(`(?i)[a-z]:\\users\\[^\\\s]+`)
	reNixPath = regexp.MustCompile(`/(?:Users|home)/[^/\s]+`)
)

// scrub: an error message without addresses, hosts, IPs, emails, secrets or user folders.
func scrub(s string) string {
	s = reSecret.ReplaceAllString(s, "<secret>")
	s = reURLs.ReplaceAllString(s, "<address>")
	s = reEmails.ReplaceAllString(s, "<email>")
	s = reIPv4s.ReplaceAllString(s, "<ip>")
	s = reWinPath.ReplaceAllString(s, `C:\Users\<you>`)
	s = reNixPath.ReplaceAllString(s, "/Users/<you>")
	s = reHosts.ReplaceAllStringFunc(s, func(h string) string {
		if strings.EqualFold(h, "e.g") || strings.EqualFold(h, "i.e") {
			return h
		}
		return "<host>"
	})
	if len(s) > 300 {
		s = s[:300] + "…"
	}
	return s
}

// noteErr remembers a feature's failure (the last 5 per feature) for the support report.
func noteErr(feature string, err error) {
	if err == nil {
		return
	}
	m := err.Error()
	if strings.Contains(m, "(404)") || strings.HasPrefix(m, "not found") {
		return // a missing item, not a fault
	}
	featErrs.Lock()
	defer featErrs.Unlock()
	l := append(featErrs.m[feature], featErr{time.Now(), scrub(m)})
	if len(l) > 5 {
		l = l[len(l)-5:]
	}
	featErrs.m[feature] = l
}

func onOff(b bool) string {
	if b {
		return "on"
	}
	return "off"
}

func (a *App) supportReport() string {
	var b strings.Builder
	w := func(f string, args ...any) { fmt.Fprintf(&b, f+"\n", args...) }
	st := a.store.Settings()
	w("WorkHub support report — %s", time.Now().Format("2006-01-02 15:04"))
	w("(no passwords, tokens, addresses, host names, IPs or emails — they are replaced by <…>)")
	w("")
	kind := "web"
	if isDesktop {
		kind = "Desktop"
	}
	w("Version:        %s (%s, %s/%s)", version, kind, runtime.GOOS, runtime.GOARCH)
	ws := "Default"
	if a.workspace != "" {
		ws = "a named workspace"
	}
	w("Workspace:      %s%s", ws, map[bool]string{true: " (own data folder)", false: ""}[a.ownData])
	w("Data:           %d connections · %d threads · %d notes", len(a.store.Entries()), len(a.store.WorkItems()), len(a.store.Notes()))
	w("")
	w("Switches")
	w("  Clipboard capture:          %s · screenshots: %s", onOff(st.Watch), onOff(!st.NoShots))
	w("  Browser bookmarks import:   %s", onOff(!st.NoBrowserSync))
	w("  Automatic update checks:    %s · background downloads: %s", onOff(!st.NoUpdateCheck), onOff(!st.NoUpdateFetch))
	w("  SSH keys window:            %s", onOff(!a.sshKeysOff()))
	w("")
	w("Connections")
	j := a.store.JiraConfig()
	w("  Jira:        %s", map[bool]string{true: "set up (" + orDefault(j.Mode, "cloud") + ")", false: "not set up"}[j.BaseURL != ""])
	c := a.store.ConfluenceConfig()
	cm := orDefault(c.Mode, "jira")
	w("  Confluence:  %s", map[bool]string{true: "set up (" + cm + ")", false: "not set up"}[c.BaseURL != "" || cm == "jira" && j.BaseURL != ""])
	ci := a.store.ConfIndexConfig()
	if ci.On {
		cidx.mu.RLock()
		w("  Local copy:  on · %d spaces · %d pages · synced %s · every %d min", len(ci.Spaces), len(cidx.Pages), ago(cidx.LastSync), int(ci.every()/time.Minute))
		cidx.mu.RUnlock()
	} else {
		w("  Local copy:  off")
	}
	ask := a.store.AskConfig()
	w("  AI answers:  %s%s", onOff(ask.AI), map[bool]string{true: " (key saved)", false: ""}[ask.Key != ""])
	tm := a.store.TeamsConfig()
	w("  Teams:       %s", map[bool]string{true: "signed in", false: map[bool]string{true: "set up, not signed in", false: "no-setup mode"}[tm.ClientID != ""]}[tm.Refresh != ""])
	w("")
	w("Recent errors (newest last)")
	featErrs.Lock()
	var feats []string
	for f := range featErrs.m {
		feats = append(feats, f)
	}
	sort.Strings(feats)
	if len(feats) == 0 {
		w("  none since WorkHub started")
	}
	for _, f := range feats {
		for _, e := range featErrs.m[f] {
			w("  %s  %-11s %s", e.At.Format("15:04"), f+":", e.Msg)
		}
	}
	featErrs.Unlock()
	if host, _ := os.Hostname(); host != "" {
		return strings.ReplaceAll(b.String(), host, "<pc>")
	}
	return b.String()
}

func (a *App) handleSupportReport(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]string{"report": a.supportReport()})
}
