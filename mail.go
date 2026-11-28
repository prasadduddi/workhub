package main

import (
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Outlook monitoring: every few minutes, new mail from chosen senders is read
// from classic Outlook (Windows) and run through the same extraction as the
// clipboard. Mail is only read, never changed.

type MailRule struct {
	Match   string `json:"match"`   // bob@x.com, *@vendor.com, or part of a sender name
	Project string `json:"project"` // where findings are filed ("" = capture project)
}

type MailSettings struct {
	Enabled  bool       `json:"enabled"`
	Rules    []MailRule `json:"rules"`
	Folder   string     `json:"folder"`   // "" = Inbox; e.g. "Inbox/Vendors"
	Minutes  int        `json:"minutes"`  // check interval
	KeepAll  bool       `json:"keep_all"` // keep matching mails with no findings too
	Lookback int        `json:"lookback"` // days to look back on the first check
}

type mailItem struct {
	ID       string
	From     string // display name
	Address  string // SMTP address
	Subject  string
	Received time.Time
	Body     string
}

// matchRule returns the first rule matching the sender, if any.
func matchRule(rules []MailRule, name, addr string) (MailRule, bool) {
	n, a := strings.ToLower(name), strings.ToLower(addr)
	for _, r := range rules {
		m := strings.ToLower(strings.TrimSpace(r.Match))
		switch {
		case m == "":
		case strings.HasPrefix(m, "*@"):
			if strings.HasSuffix(a, m[1:]) {
				return r, true
			}
		case strings.HasPrefix(m, "@"):
			if strings.HasSuffix(a, m) {
				return r, true
			}
		case strings.Contains(m, "@"):
			if a == m {
				return r, true
			}
		default:
			if strings.Contains(n, m) || strings.Contains(a, m) {
				return r, true
			}
		}
	}
	return MailRule{}, false
}

func mailText(m mailItem) string {
	body := strings.ReplaceAll(m.Body, "\r\n", "\n")
	if len(body) > 30000 {
		body = body[:30000] + "\n…"
	}
	return fmt.Sprintf("From: %s <%s>\nSubject: %s\nReceived: %s\n\n%s", m.From, m.Address, m.Subject, m.Received.Format("2006-01-02 15:04"), body)
}

type mailStatus struct {
	mu        sync.Mutex
	LastCheck time.Time    `json:"last_check"`
	LastError string       `json:"last_error"`
	Matched   int          `json:"matched"`  // matching mails in the last check
	Captured  int          `json:"captured"` // total captured since start
	Running   bool         `json:"running"`
	Newest    *mailSummary // newest mail in the folder at the last check
	LastMatch *mailSummary // most recent mail from a watched sender
}

type mailSummary struct {
	From     string    `json:"from"`
	Address  string    `json:"address"`
	Subject  string    `json:"subject"`
	Received time.Time `json:"received"`
	Captured bool      `json:"captured,omitempty"`
}

func summary(m *mailItem) *mailSummary {
	if m == nil {
		return nil
	}
	return &mailSummary{From: m.From, Address: m.Address, Subject: m.Subject, Received: m.Received}
}

func (a *App) mailWatcher() {
	for {
		ms := a.store.Settings().Mail
		every := time.Duration(max(ms.Minutes, 1)) * time.Minute
		if ms.Enabled && len(ms.Rules) > 0 {
			a.checkMail()
		}
		select {
		case <-a.mailNow:
		case <-time.After(every):
		}
	}
}

func (a *App) checkMail() {
	a.mail.mu.Lock()
	if a.mail.Running {
		a.mail.mu.Unlock()
		return
	}
	a.mail.Running = true
	a.mail.mu.Unlock()

	ms := a.store.Settings().Mail
	since := a.store.MailSince()
	if since.IsZero() {
		since = time.Now().AddDate(0, 0, -max(ms.Lookback, 1))
	}
	started := time.Now()
	var items []mailItem
	var top *mailItem
	var err error
	if l := a.demo.Load(); l != nil { // a demo workspace: its pretend mailbox instead of Outlook
		items, top, err = l.fetchMail(since)
	} else {
		items, top, err = fetchMail(ms.Folder, since)
	}
	matched, captured := 0, 0
	newest := since
	var lastMatch *mailSummary
	if err == nil {
		for _, m := range items {
			if m.Received.After(newest) {
				newest = m.Received
			}
			rule, ok := matchRule(ms.Rules, m.From, m.Address)
			if !ok || a.store.MailSeen(m.ID) {
				continue
			}
			matched++
			src := "outlook"
			if ms.KeepAll {
				src = "outlook-all"
			}
			clip, _ := a.store.Ingest(mailText(m), src, rule.Project)
			if clip != nil {
				captured++
			}
			if lastMatch == nil || m.Received.After(lastMatch.Received) {
				lastMatch = summary(&m)
				lastMatch.Captured = clip != nil
			}
			a.store.MarkMailSeen(m.ID)
		}
		a.store.SetMailSince(newest)
	}
	a.mail.mu.Lock()
	a.mail.Running = false
	a.mail.LastCheck = started
	a.mail.Matched = matched
	a.mail.Captured += captured
	a.mail.LastError = ""
	if err != nil {
		a.mail.LastError = err.Error()
	} else {
		a.mail.Newest = summary(top)
		if lastMatch != nil {
			a.mail.LastMatch = lastMatch
		}
	}
	a.mail.mu.Unlock()
}

func (a *App) handleMailStatus(w http.ResponseWriter, r *http.Request) {
	a.mail.mu.Lock()
	defer a.mail.mu.Unlock()
	writeJSON(w, map[string]any{"last_check": a.mail.LastCheck, "last_error": a.mail.LastError, "matched": a.mail.Matched,
		"captured": a.mail.Captured, "running": a.mail.Running, "supported": mailSupported || a.demo.Load() != nil,
		"newest": a.mail.Newest, "last_match": a.mail.LastMatch, "folder": orDefault(a.store.Settings().Mail.Folder, "Inbox")})
}

func (a *App) handleMailCheck(w http.ResponseWriter, r *http.Request) {
	select {
	case a.mailNow <- struct{}{}:
	default:
	}
	writeJSON(w, map[string]bool{"ok": true})
}
