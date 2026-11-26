package main

import (
	"net/http/httptest"
	"strings"
	"testing"
)

// "Check for new versions automatically" off: the page's quiet check doesn't contact GitHub.
func TestUpdateCheckOff(t *testing.T) {
	s, _ := OpenStore(t.TempDir())
	st := s.Settings()
	st.NoUpdateCheck = true
	s.SetSettings(st)
	a := &App{store: s}
	old := updateURL
	updateURL = "http://127.0.0.1:1/never-called" // a request here would fail loudly
	defer func() { updateURL = old }()
	w := httptest.NewRecorder()
	a.handleUpdateCheck(w, httptest.NewRequest("GET", "/api/update", nil))
	if !strings.Contains(w.Body.String(), `"off":true`) || strings.Contains(w.Body.String(), "error") {
		t.Fatalf("automatic check should be off: %s", w.Body.String())
	}
}
