package main

import (
	"crypto/tls"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

var linkClient = &http.Client{
	Timeout:   12 * time.Second,
	Transport: &http.Transport{Proxy: http.ProxyFromEnvironment, TLSHandshakeTimeout: 8 * time.Second},
	// Don't follow redirects: any answer from the server means it is up.
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

// checkLink reports whether a web link answers. Any HTTP response (even 401
// or 404) counts as reachable; only network/TLS failures count as down.
func checkLink(u string) error {
	resp, err := linkClient.Head(u)
	if err == nil && resp.StatusCode == http.StatusMethodNotAllowed {
		resp.Body.Close()
		resp, err = linkClient.Get(u)
	}
	if err != nil {
		var certErr *tls.CertificateVerificationError
		if errors.As(err, &certErr) {
			return fmt.Errorf("reachable, but its certificate is not trusted: %v", err)
		}
		return err
	}
	resp.Body.Close()
	if resp.StatusCode >= 500 {
		return fmt.Errorf("server error %s", resp.Status)
	}
	return nil
}

// handleCheckLinks checks every web link (or the given ones) in the
// background, a few at a time; results show up as status dots.
func (a *App) handleCheckLinks(w http.ResponseWriter, r *http.Request) {
	var in struct {
		IDs []string `json:"ids"`
	}
	_ = readJSON(r, &in)
	want := map[string]bool{}
	for _, id := range in.IDs {
		want[id] = true
	}
	var todo []EntryView
	for _, e := range a.store.Entries() {
		if (len(want) == 0 || want[e.ID]) && (strings.HasPrefix(e.URL, "http://") || strings.HasPrefix(e.URL, "https://")) {
			todo = append(todo, e)
		}
	}
	go func() {
		sem := make(chan struct{}, 6)
		var wg sync.WaitGroup
		for _, e := range todo {
			wg.Add(1)
			sem <- struct{}{}
			go func(id, u string) {
				defer func() { <-sem; wg.Done() }()
				a.store.SetStatus(id, checkLink(u))
			}(e.ID, e.URL)
		}
		wg.Wait()
	}()
	writeJSON(w, map[string]int{"checking": len(todo)})
}
