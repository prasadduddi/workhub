package main

import (
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMonitorProbe(t *testing.T) {
	tomcat := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/manager") {
			w.Header().Set("WWW-Authenticate", `Basic realm="Tomcat Manager Application"`)
			w.WriteHeader(401) // a login prompt: the server is up
			return
		}
		w.WriteHeader(500)
	}))
	defer tomcat.Close()
	if up, _, d := probe(MonitorCheck{Kind: "http", Target: tomcat.URL + "/manager/html"}); !up || !strings.Contains(d, "401") {
		t.Fatalf("manager behind a login should be up: %v %q", up, d)
	}
	if up, _, _ := probe(MonitorCheck{Kind: "http", Target: tomcat.URL + "/broken"}); up {
		t.Fatal("a 500 should be down")
	}
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := l.Addr().String()
	if up, _, _ := probe(MonitorCheck{Kind: "tcp", Target: addr}); !up {
		t.Fatal("open port should be up")
	}
	l.Close()
	if up, _, d := probe(MonitorCheck{Kind: "tcp", Target: addr}); up || !strings.Contains(d, "refused") {
		t.Fatalf("closed port should be down: %q", d)
	}
}

func TestMonitorSuggestAndBlock(t *testing.T) {
	s, _ := OpenStore(t.TempDir())
	s.Ingest("Tomcat manager DEV http://dev-app-01.example.com:8080/manager/html", "paste", "")
	s.Ingest("jdbc:oracle:thin:@//dev-db-01.example.com:1521/DEVDB", "paste", "")
	s.Ingest("Tomcat manager PROD https://prod-app-01.example.com:8443/manager/html", "paste", "")
	for _, e := range s.st.Entries {
		if strings.Contains(e.URL, "prod-") {
			e.Env = "PROD"
		} else {
			e.Env = "DEV"
		}
	}
	a := &App{store: s, mon: &monitor{status: map[string]*monStatus{}, kick: make(chan struct{}, 1)}}
	got := a.monitorSuggest()
	var names []string
	for _, c := range got {
		names = append(names, c.Group+":"+c.Kind+":"+c.Target)
	}
	joined := strings.Join(names, " ")
	for _, want := range []string{"Tomcat:http:http://dev-app-01.example.com:8080/manager/html", "Tomcat:tcp:dev-app-01.example.com:8080", "Oracle:tcp:dev-db-01.example.com:1521"} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing %s in %s", want, joined)
		}
	}
	var prod MonitorCheck
	for _, c := range got {
		if strings.Contains(c.Target, "prod-") {
			prod = c
		}
	}
	set := MonitorSettings{On: true, Checks: []MonitorCheck{prod}}
	if !a.monBlocked(prod, set) {
		t.Fatal("PROD must be blocked by default")
	}
	a.runChecks(set)
	if a.mon.status[prod.ID] != nil {
		t.Fatal("a blocked PROD check was run")
	}
	set.AllowProd = true
	if a.monBlocked(prod, set) {
		t.Fatal("allow_prod should allow it")
	}
}
