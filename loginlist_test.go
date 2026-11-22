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
