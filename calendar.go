package main

// Calendar: your own events (saved per workspace, with reminders and repeats)
// plus, on Windows, your classic Outlook meetings shown read-only.

import (
	"errors"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"
)

type Event struct {
	ID     string    `json:"id"`
	Title  string    `json:"title"`
	Date   string    `json:"date"`            // YYYY-MM-DD (first day for repeats)
	Start  string    `json:"start,omitempty"` // HH:MM; empty = all day
	End    string    `json:"end,omitempty"`
	Notes  string    `json:"notes,omitempty"`
	Remind int       `json:"remind"`           // minutes before; -1 = no reminder
	Repeat string    `json:"repeat,omitempty"` // "", daily, weekdays, weekly, monthly
	Until  string    `json:"until,omitempty"`  // last day of a repeat (YYYY-MM-DD)
	Link   string    `json:"link,omitempty"`   // optional URL (Jira, Teams…)
	Color  string    `json:"color,omitempty"`
	Skip   []string  `json:"skip,omitempty"` // repeat days removed one by one
	Update time.Time `json:"updated"`
}

// OutlookEvent is a meeting read from Outlook (never changed by WorkHub).
type OutlookEvent struct {
	Subject   string    `json:"subject"`
	Start     time.Time `json:"start"`
	End       time.Time `json:"end"`
	Location  string    `json:"location,omitempty"`
	Organizer string    `json:"organizer,omitempty"`
	AllDay    bool      `json:"all_day,omitempty"`
}

var (
	reDay  = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	reTime = regexp.MustCompile(`^([01]\d|2[0-3]):[0-5]\d$`)
)

func (s *Store) Events() []Event {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Event, 0, len(s.st.Events))
	for _, e := range s.st.Events {
		out = append(out, *e)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Date+out[i].Start < out[j].Date+out[j].Start })
	return out
}

func (s *Store) SaveEvent(e Event) (Event, error) {
	e.Title = strings.TrimSpace(e.Title)
	if e.Title == "" {
		return e, errors.New("give the event a title")
	}
	if !reDay.MatchString(e.Date) {
		return e, errors.New("pick a date")
	}
	if (e.Start != "" && !reTime.MatchString(e.Start)) || (e.End != "" && !reTime.MatchString(e.End)) {
		return e, errors.New("times are HH:MM, e.g. 09:30")
	}
	if e.Until != "" && !reDay.MatchString(e.Until) {
		e.Until = ""
	}
	switch e.Repeat {
	case "", "daily", "weekdays", "weekly", "monthly":
	default:
		e.Repeat = ""
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	e.Update = time.Now()
	for _, x := range s.st.Events {
		if e.ID != "" && x.ID == e.ID {
			*x = e
			s.changed()
			return e, nil
		}
	}
	e.ID = randomHex(8)
	s.st.Events = append(s.st.Events, &e)
	s.changed()
	return e, nil
}

// DeleteEvent removes an event, or with day set only that day of a repeat.
func (s *Store) DeleteEvent(id, day string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, x := range s.st.Events {
		if x.ID != id {
			continue
		}
		if day != "" && x.Repeat != "" {
			x.Skip = append(x.Skip, day)
		} else {
			s.st.Events = append(s.st.Events[:i], s.st.Events[i+1:]...)
		}
		s.changed()
		return
	}
}

func (a *App) handleEventsList(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, a.store.Events())
}

func (a *App) handleEventSave(w http.ResponseWriter, r *http.Request) {
	var e Event
	if err := readJSON(r, &e); err != nil {
		writeErr(w, 400, err)
		return
	}
	saved, err := a.store.SaveEvent(e)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	writeJSON(w, saved)
}

func (a *App) handleEventDelete(w http.ResponseWriter, r *http.Request) {
	a.store.DeleteEvent(r.PathValue("id"), r.URL.Query().Get("day"))
	writeJSON(w, map[string]bool{"ok": true})
}

// handleOutlookEvents: meetings between from and to (YYYY-MM-DD).
func (a *App) handleOutlookEvents(w http.ResponseWriter, r *http.Request) {
	from, err1 := time.ParseInLocation("2006-01-02", r.URL.Query().Get("from"), time.Local)
	to, err2 := time.ParseInLocation("2006-01-02", r.URL.Query().Get("to"), time.Local)
	if err1 != nil || err2 != nil || to.Before(from) || to.Sub(from) > 100*24*time.Hour {
		writeErr(w, 400, errors.New("from/to: YYYY-MM-DD, at most 100 days"))
		return
	}
	list, err := outlookEvents(from, to.Add(24*time.Hour))
	if err != nil {
		writeJSON(w, map[string]any{"events": []OutlookEvent{}, "error": err.Error()})
		return
	}
	writeJSON(w, map[string]any{"events": list})
}
