package main

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSessionLog(t *testing.T) {
	a := &App{dataDir: t.TempDir()}
	lg, err := a.openSessionLog("srv-01.example.com", "ops")
	if err != nil {
		t.Fatal(err)
	}
	lg.Write([]byte("\x1b[32mops@srv-01\x1b[0m:~$ df -h\r\n"))
	lg.Write([]byte("Filesystem  Size\r\n/dev/sda1   40G\r\nops@srv-01:~$ tail -f app.lg\bog"))
	lg.Close()
	b, _ := os.ReadFile(filepath.Join(a.sessionLogDir(), "srv-01.example.com", time.Now().Format("2006-01-02")+".log"))
	got := string(b)
	for _, want := range []string{"ops@srv-01.example.com  connected", "ops@srv-01:~$ df -h\n", "/dev/sda1   40G\n", "tail -f app.log\n", "disconnected"} {
		if !strings.Contains(got, want) {
			t.Errorf("log missing %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "\x1b") || strings.Contains(got, "\r") {
		t.Errorf("escape codes left in the log: %q", got)
	}
	w := httptest.NewRecorder()
	a.handleSessionLogs(w, httptest.NewRequest("GET", "/api/sessionlogs?q=DF+-h", nil))
	var out struct{ Hits []logHit }
	json.Unmarshal(w.Body.Bytes(), &out)
	if len(out.Hits) != 1 || out.Hits[0].Host != "srv-01.example.com" || !strings.Contains(out.Hits[0].Text, "df -h") || out.Hits[0].Time == "" {
		t.Fatalf("search: %+v", out.Hits)
	}
}
