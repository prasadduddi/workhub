package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPuttyArgs(t *testing.T) {
	e := Entry{Host: "jump.corp.local", Port: 2222, Protocol: "ssh", Username: "jdoe", Password: "p w", KeyFile: `C:\keys\me.ppk`,
		Extra: map[string]string{"tunnels": "1522:dbhost:1521, 8443:app01:443"}}
	got := strings.Join(puttyArgs(e), " ")
	want := `-ssh -P 2222 -l jdoe -pw p w -i C:\keys\me.ppk -L 1522:dbhost:1521 -L 8443:app01:443 jump.corp.local`
	if got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
	e.Extra["tunnels_off"], e.KeyFile = "1", "id_rsa"
	if got := strings.Join(puttyArgs(e), " "); strings.Contains(got, "-L") || strings.Contains(got, "-i") {
		t.Fatalf("tunnels off / non-PuTTY key still passed: %s", got)
	}
}

func TestDBeaverArgs(t *testing.T) {
	a, err := dbeaverArgs(Entry{Name: "pg uat", Host: "pg01", Port: 5433, Username: "rep", Password: "pw", Extra: map[string]string{"database": "payments"}})
	if err != nil || a[0] != "-con" || a[1] != "driver=postgresql|host=pg01|port=5433|database=payments|user=rep|password=pw|savePassword=true|name=pg uat|save=false|connect=true|openConsole=true" {
		t.Fatalf("postgres: %v %v", a, err)
	}
	a, _ = dbeaverArgs(Entry{Host: "ora01", Port: 1521, Username: "app", Extra: map[string]string{"service": "PAYUAT"}})
	if !strings.Contains(a[1], "driver=oracle_thin|url=jdbc:oracle:thin:@//ora01:1521/PAYUAT|user=app") {
		t.Fatalf("oracle: %v", a)
	}
	a, _ = dbeaverArgs(Entry{Host: "ora01", Port: 1521, Extra: map[string]string{"sid": "ORCL"}})
	if !strings.Contains(a[1], "url=jdbc:oracle:thin:@ora01:1521:ORCL") {
		t.Fatalf("oracle SID: %v", a)
	}
	if _, err := dbeaverArgs(Entry{Host: "pg01", Port: 5432, Password: "a|b"}); err == nil {
		t.Fatal(`"|" in password should be refused`)
	}
}

func TestFindToolSetPath(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "putty.exe")
	os.WriteFile(exe, []byte("x"), 0o700)
	t.Setenv("LOCALAPPDATA", dir) // found in a usual folder
	if got := findTool(extTools[0]); got != exe {
		t.Fatalf("found %q, want %q", got, exe)
	}
}

func TestFileZillaArgs(t *testing.T) {
	if a := filezillaArgs(Entry{Host: "app01", Port: 22, Protocol: "sftp", Username: "ops", Password: "p@ss#1", LastDir: "/var/log"}); a[0] != "sftp://ops:p%40ss%231@app01:22/var/log" {
		t.Fatalf("sftp: %v", a)
	}
	if a := filezillaArgs(Entry{Host: "ftp.partner", Port: 21, Protocol: "ftp", Username: "u"}); a[0] != "ftp://u@ftp.partner:21" {
		t.Fatalf("ftp: %v", a)
	}
}
