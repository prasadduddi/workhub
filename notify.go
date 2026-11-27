package main

// 🔔 Notifications: a monitor goes down (or up again), a tracked Jira issue
// changes status, a thread reminder is due. Desktop: a Windows notification from
// WorkHub's tray icon; the page also gets them (GET /api/notifications) to show
// them — the browser version as browser notifications. Each kind can be switched
// off in ⚙ Settings → General.

import (
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

type notice struct {
	N     int       `json:"n"`
	At    time.Time `json:"at"`
	Kind  string    `json:"kind"` // monitor, jira, reminder
	Title string    `json:"title"`
	Body  string    `json:"body"`
	View  string    `json:"view,omitempty"` // the page to open
	Ref   string    `json:"ref,omitempty"`
}

var notices = struct {
	sync.Mutex
	list []notice
	n    int
}{}

// systemNotify shows a Windows notification (Desktop); nil elsewhere.
var systemNotify func(title, body string)

func (a *App) notifyOn(kind string) bool {
	st := a.store.Settings()
	switch kind {
	case "monitor":
		return !st.NoNotifyMonitor
	case "jira":
		return !st.NoNotifyJira
	case "reminder":
		return !st.NoNotifyReminder
	}
	return true
}

func (a *App) notify(kind, title, body, view, ref string) {
	if !a.notifyOn(kind) {
		return
	}
	notices.Lock()
	notices.n++
	notices.list = append(notices.list, notice{N: notices.n, At: time.Now(), Kind: kind, Title: title, Body: body, View: view, Ref: ref})
	if len(notices.list) > 50 {
		notices.list = notices.list[len(notices.list)-50:]
	}
	notices.Unlock()
	if systemNotify != nil {
		systemNotify(title, body)
	}
}

func (a *App) handleNotifications(w http.ResponseWriter, r *http.Request) {
	since, _ := strconv.Atoi(r.URL.Query().Get("since"))
	notices.Lock()
	out := []notice{}
	for _, n := range notices.list {
		if n.N > since {
			out = append(out, n)
		}
	}
	last := notices.n
	notices.Unlock()
	writeJSON(w, map[string]any{"notices": out, "last": last, "native": systemNotify != nil})
}

// reminderLoop: a thread reminder that comes due → a notification (once; not for ones due before WorkHub started).
func (a *App) reminderLoop() {
	told := map[string]bool{}
	since := time.Now()
	for {
		time.Sleep(30 * time.Second)
		now := time.Now()
		for _, p := range a.store.MarkedPosts(true) {
			at := p.Post.RemindAt
			key := p.Post.ID + at.String()
			if at.IsZero() || at.After(now) || at.Before(since) || told[key] {
				continue
			}
			told[key] = true
			text := strings.TrimSpace(p.Post.Text)
			if text == "" {
				text = strings.Join(strings.Fields(tagRe.ReplaceAllString(p.Post.HTML, " ")), " ")
			}
			if len([]rune(text)) > 120 {
				text = string([]rune(text)[:120]) + "…"
			}
			a.notify("reminder", "⏰ Reminder — "+p.Title, text, "tasks", p.Thread+"/"+p.Post.ID)
		}
		since = now.Add(-time.Minute)
	}
}
