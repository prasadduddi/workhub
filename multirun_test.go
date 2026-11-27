package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestMultiRun(t *testing.T) {
	s, _ := OpenStore(t.TempDir())
	a := &App{store: s}
	uat, _ := s.SaveEntry(EntryInput{Name: "app-uat", Host: "app-uat.example.com", Env: "UAT", Protocol: "ssh"})
	prod, _ := s.SaveEntry(EntryInput{Name: "app-prod", Host: "app-prod.example.com", Env: "PROD", Protocol: "ssh"})
	down, _ := s.SaveEntry(EntryInput{Name: "app-down", Host: "app-down.example.com", Protocol: "ssh"})
	old := runOnServer
	runOnServer = func(_ *App, e Entry, cmd string, _ time.Duration) (string, int, error) {
		if e.Name == "app-down" {
			return "", -1, errors.New("connection refused")
		}
		return e.Name + ": " + cmd + " ok\n", 0, nil
	}
	defer func() { runOnServer = old }()
	post := func(body map[string]any) *httptest.ResponseRecorder {
		b, _ := json.Marshal(body)
		rr := httptest.NewRecorder()
		a.handleMultiRun(rr, httptest.NewRequest("POST", "/api/multirun", bytes.NewReader(b)))
		return rr
	}
	if rr := post(map[string]any{"ids": []string{uat.ID, prod.ID}, "command": "df -h"}); rr.Code != 403 {
		t.Fatalf("PROD without asking: %d", rr.Code)
	}
	rr := post(map[string]any{"ids": []string{uat.ID, prod.ID, down.ID}, "command": "df -h", "prod_ok": true})
	var out struct{ Results []runResult }
	json.Unmarshal(rr.Body.Bytes(), &out)
	if rr.Code != 200 || len(out.Results) != 3 || out.Results[0].Output != "app-uat: df -h ok\n" || out.Results[1].Name != "app-prod" || out.Results[2].Err != "connection refused" {
		t.Fatalf("%d %+v", rr.Code, out.Results)
	}
	evs := s.ProdEvents("", 0)
	if len(evs) != 1 || evs[0].Kind != "run" || evs[0].What != "df -h" || !strings.Contains(evs[0].Note, "exit 0") {
		t.Fatalf("PROD log: %+v", evs)
	}
	var lb limitedBuf
	lb.Write(bytes.Repeat([]byte("x"), runMaxOutput+10))
	if !strings.Contains(lb.String(), "only the first 256 KB") {
		t.Fatal("output limit")
	}
}
