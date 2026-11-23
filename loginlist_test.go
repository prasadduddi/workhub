package main

import (
	"fmt"
	"strings"
	"testing"
)

func TestLoginLists(t *testing.T) {
	want := "deploy@srv-07.test.example.com=Dep#1 appuser@srv-07.test.example.com=App#2 oracle@srv-07.test.example.com=Ora#3"
	for name, text := range map[string]string{
		"ssh lines, pass without colon": "ssh deploy@srv-07.test.example.com pass Dep#1\nssh appuser@srv-07.test.example.com pass App#2\nssh oracle@srv-07.test.example.com password: Ora#3",
		"server then user/password":     "Server: srv-07.test.example.com\nuser: deploy  password: Dep#1\nuser: appuser password: App#2\nusername oracle pwd Ora#3",
		"server then user / password":   "srv-07.test.example.com\ndeploy / Dep#1\nappuser / App#2\noracle / Ora#3",
		"user/password, blank lines":    "srv-07.test.example.com\n\ndeploy/Dep#1\n\nappuser/App#2\n\noracle/Ora#3\n",
		"table with host column":        "Host                      User     Password\nsrv-07.test.example.com   deploy   Dep#1\nsrv-07.test.example.com   appuser  App#2\nsrv-07.test.example.com   oracle   Ora#3",
		"table under a server line":     "Logins for srv-07.test.example.com\nUser | Password\ndeploy | Dep#1\nappuser | App#2\noracle | Ora#3",
	} {
		var got []string
		for _, f := range Parse(text) {
			got = append(got, fmt.Sprintf("%s@%s=%s", f.Username, f.Host, f.Password))
		}
		if strings.Join(got, " ") != want {
			t.Errorf("%s:\n got  %v\n want %s", name, got, want)
		}
	}
}

// Each user becomes its own connection, named host-user, ready for SSH and FTP.
func TestLoginListEntries(t *testing.T) {
	s, _ := OpenStore(t.TempDir())
	_, es := s.Ingest("srv-07.test.example.com\ndeploy / Dep#1\nappuser / App#2", "paste", "")
	if len(es) != 2 || es[0].Name != "srv-07.test.example.com-deploy" || es[1].Name != "srv-07.test.example.com-appuser" ||
		es[0].Password != "Dep#1" || es[1].Password != "App#2" || es[0].Protocol != "ssh" {
		t.Fatalf("entries: %+v", es)
	}
}

// An upper-case server name, user/password with no spaces and blank lines in
// between (as copied from an email).
func TestLoginListTightSlash(t *testing.T) {
	text := "SRV-DEV09-LNX-APP-02.corp.example.com\nalpha/Fake#11\n\nbravo/Fake#22\n\ncharlie/Fake#33\n"
	var got []string
	for _, f := range Parse(text) {
		got = append(got, f.Username+"="+f.Password+"@"+strings.ToLower(f.Host))
	}
	want := "alpha=Fake#11@srv-dev09-lnx-app-02.corp.example.com bravo=Fake#22@srv-dev09-lnx-app-02.corp.example.com charlie=Fake#33@srv-dev09-lnx-app-02.corp.example.com"
	if strings.Join(got, " ") != want {
		t.Fatalf("got  %v\nwant %s", got, want)
	}
	// a folder path is not a login
	if fs := Parse("srv-07.test.example.com\nopt/app/logs\nvar/tmp"); len(fs) > 1 || len(fs) == 1 && fs[0].Username != "" {
		t.Fatalf("paths read as logins: %+v", fs)
	}
}
