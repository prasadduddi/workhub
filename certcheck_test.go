package main

import (
	"strings"
	"testing"
	"time"
)

func TestCertExpiry(t *testing.T) {
	if tlsTarget(MonitorCheck{Kind: "http", Target: "https://app.example.com/x"}) != "app.example.com:443" ||
		tlsTarget(MonitorCheck{Kind: "http", Target: "http://app.example.com:8080/"}) != "" ||
		tlsTarget(MonitorCheck{Kind: "tcp", Target: "db.example.com:2484"}) != "db.example.com:2484" ||
		tlsTarget(MonitorCheck{Kind: "tcp", Target: "db.example.com:1521"}) != "" {
		t.Fatal("which checks have a certificate")
	}
	s, _ := OpenStore(t.TempDir())
	a := &App{store: s}
	notices.Lock()
	notices.list, notices.n = nil, 0
	notices.Unlock()
	certs.Lock()
	certs.m, certs.told = map[string]*certInfo{}, map[string]bool{}
	certs.Unlock()
	expires := time.Now().Add(10*24*time.Hour + time.Hour)
	old := readCert
	readCert = func(string) (*certInfo, error) {
		return &certInfo{Expires: expires, Subject: "app.example.com", Issuer: "Acme CA"}, nil
	}
	defer func() { readCert = old }()
	c := MonitorCheck{ID: "c1", Name: "Payments console", Kind: "http", Target: "https://app.example.com/console"}
	a.checkCert(c)
	a.checkCert(c) // read again only after 6 h; told once
	certs.Lock()
	certs.m["c1"].At = time.Now().Add(-7 * time.Hour)
	certs.Unlock()
	a.checkCert(c) // read again: same certificate and step: not told again
	notices.Lock()
	defer notices.Unlock()
	if len(notices.list) != 1 || !strings.Contains(notices.list[0].Title, "expires in 10 days — Payments console") {
		t.Fatalf("notices: %+v", notices.list)
	}
	if ci := certOf("c1"); ci == nil || ci.Issuer != "Acme CA" {
		t.Fatal("the page doesn't get the certificate")
	}
}
