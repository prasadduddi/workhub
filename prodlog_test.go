package main

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestProdLog(t *testing.T) {
	s, _ := OpenStore(t.TempDir())
	a := &App{store: s}
	prod := Entry{Name: "Payments DB", Host: "db-prod.example.com", Env: "PROD", Username: "ops"}
	a.prodLog(Entry{Name: "UAT", Host: "uat.example.com", Env: "UAT"}, "sql", "", "delete from t", "")
	a.prodLog(prod, "sql", "", "ALTER USER app IDENTIFIED BY Secret#1", "auto-commit")
	a.prodLog(prod, "commit", "", "Committed", "")
	// a terminal: typed lines, with editing; nothing after a password prompt
	var lines []string
	rec := &lineRecorder{onLine: func(l string, pasted bool) {
		if pasted {
			l = "P:" + l
		}
		lines = append(lines, l)
	}}
	rec.output([]byte("ops@app01:~$ "))
	for _, c := range "df -hx\x7f\r" { // typed key by key
		rec.input(string(c))
	}
	rec.output([]byte("Filesystem ...\r\nops@app01:~$ "))
	rec.input("sudo systemctl restart pay\r")
	rec.output([]byte("[sudo] password for ops: "))
	rec.input("Hunter2\r")
	rec.output([]byte("\r\nops@app01:~$ "))
	rec.input("echo x\x1b[A\x03")
	rec.input("\x1b[200~uptime\rwho\r\x1b[201~") // a paste of two lines
	if strings.Join(lines, "|") != "df -h|P:sudo systemctl restart pay|P:uptime|P:who" {
		t.Fatalf("typed lines: %q", lines)
	}
	evs := s.ProdEvents("", 0)
	if len(evs) != 2 || evs[0].Kind != "commit" || !strings.Contains(evs[1].What, "IDENTIFIED BY <hidden>") || strings.Contains(evs[1].What, "Secret#1") {
		t.Fatalf("events: %+v", evs)
	}
	if len(s.ProdEvents("alter payments", 0)) != 1 || len(s.ProdEvents("nothing-like-this", 0)) != 0 {
		t.Fatal("search")
	}
	rr := httptest.NewRecorder()
	a.handleProdLog(rr, httptest.NewRequest("GET", "/api/prodlog?format=csv", nil))
	if body := rr.Body.String(); !strings.Contains(body, "Command / statement") || !strings.Contains(body, "db-prod.example.com") {
		t.Fatalf("csv: %s", body)
	}
}
