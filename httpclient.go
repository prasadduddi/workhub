package main

// 🌐 API page: a small Postman. Saved requests (in folders), environments of
// {{variables}} and a history, all kept with your data (encrypted). Requests
// are sent by WorkHub itself, so browser CORS rules don't get in the way.
// Variables are filled in by the page; this side only sends.

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

type KV struct {
	K  string `json:"k"`
	V  string `json:"v"`
	On bool   `json:"on"`
}

type HTTPAuth struct {
	Type  string `json:"type,omitempty"` // "", basic, bearer, apikey
	User  string `json:"user,omitempty"`
	Pass  string `json:"pass,omitempty"`
	Token string `json:"token,omitempty"`
	Key   string `json:"key,omitempty"` // apikey: header name
}

type HTTPReq struct {
	ID       string    `json:"id"`
	Name     string    `json:"name"`
	Folder   string    `json:"folder,omitempty"`
	Method   string    `json:"method"`
	URL      string    `json:"url"`
	Headers  []KV      `json:"headers,omitempty"`
	BodyType string    `json:"body_type,omitempty"` // none, json, xml, text, form
	Body     string    `json:"body,omitempty"`
	Auth     HTTPAuth  `json:"auth"`
	Insecure bool      `json:"insecure,omitempty"`
	Updated  time.Time `json:"updated"`
}

type HTTPEnv struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Vars []KV   `json:"vars"`
}

type HTTPHist struct {
	At     time.Time `json:"at"`
	Method string    `json:"method"`
	URL    string    `json:"url"`
	Status int       `json:"status"`
	Ms     int64     `json:"ms"`
	ReqID  string    `json:"req_id,omitempty"`
	Error  string    `json:"error,omitempty"`
}

const maxHTTPHist = 100

// ensureLocalEnv adds a "localhost" environment the first time the API page
// is used. Made once: renamed or deleted, it stays that way.
func (s *Store) ensureLocalEnv() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.st.HTTPLocalEnv {
		return
	}
	s.st.HTTPLocalEnv = true
	for _, e := range s.st.HTTPEnvs {
		if strings.EqualFold(e.Name, "localhost") {
			s.changed()
			return
		}
	}
	s.st.HTTPEnvs = append([]*HTTPEnv{{ID: randomHex(8), Name: "localhost", Vars: []KV{{K: "baseUrl", V: "http://localhost:8080", On: true}, {K: "token", V: "", On: true}}}}, s.st.HTTPEnvs...)
	s.changed()
}

func (s *Store) HTTPData() map[string]any {
	s.ensureLocalEnv()
	s.mu.RLock()
	defer s.mu.RUnlock()
	reqs := make([]HTTPReq, 0, len(s.st.HTTPReqs))
	for _, r := range s.st.HTTPReqs {
		reqs = append(reqs, *r)
	}
	sort.Slice(reqs, func(i, j int) bool {
		if reqs[i].Folder != reqs[j].Folder {
			return strings.ToLower(reqs[i].Folder) < strings.ToLower(reqs[j].Folder)
		}
		return strings.ToLower(reqs[i].Name) < strings.ToLower(reqs[j].Name)
	})
	envs := make([]HTTPEnv, 0, len(s.st.HTTPEnvs))
	for _, e := range s.st.HTTPEnvs {
		envs = append(envs, *e)
	}
	return map[string]any{"requests": reqs, "envs": envs, "history": append([]HTTPHist{}, s.st.HTTPHistory...)}
}

func (s *Store) SaveHTTPReq(in HTTPReq) (HTTPReq, error) {
	in.Name, in.URL = strings.TrimSpace(in.Name), strings.TrimSpace(in.URL)
	in.Method = strings.ToUpper(orDefault(strings.TrimSpace(in.Method), "GET"))
	if in.Name == "" {
		return in, errors.New("give the request a name")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	in.Updated = time.Now()
	for _, x := range s.st.HTTPReqs {
		if x.ID == in.ID && in.ID != "" {
			*x = in
			s.changed()
			return in, nil
		}
	}
	in.ID = randomHex(8)
	s.st.HTTPReqs = append(s.st.HTTPReqs, &in)
	s.changed()
	return in, nil
}

func (s *Store) DeleteHTTPReq(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, x := range s.st.HTTPReqs {
		if x.ID == id {
			s.st.HTTPReqs = append(s.st.HTTPReqs[:i], s.st.HTTPReqs[i+1:]...)
			s.changed()
			return
		}
	}
}

func (s *Store) SaveHTTPEnv(in HTTPEnv) (HTTPEnv, error) {
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" {
		return in, errors.New("give the environment a name")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, x := range s.st.HTTPEnvs {
		if x.ID == in.ID && in.ID != "" {
			*x = in
			s.changed()
			return in, nil
		}
	}
	in.ID = randomHex(8)
	s.st.HTTPEnvs = append(s.st.HTTPEnvs, &in)
	s.changed()
	return in, nil
}

func (s *Store) DeleteHTTPEnv(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, x := range s.st.HTTPEnvs {
		if x.ID == id {
			s.st.HTTPEnvs = append(s.st.HTTPEnvs[:i], s.st.HTTPEnvs[i+1:]...)
			s.changed()
			return
		}
	}
}

func (s *Store) addHTTPHist(h HTTPHist) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.st.HTTPHistory = append([]HTTPHist{h}, s.st.HTTPHistory...)
	if len(s.st.HTTPHistory) > maxHTTPHist {
		s.st.HTTPHistory = s.st.HTTPHistory[:maxHTTPHist]
	}
	s.changed()
}

// sendInput is a request with its variables already filled in.
type sendInput struct {
	ReqID    string   `json:"req_id"`
	Method   string   `json:"method"`
	URL      string   `json:"url"`
	Headers  []KV     `json:"headers"`
	BodyType string   `json:"body_type"`
	Body     string   `json:"body"`
	Auth     HTTPAuth `json:"auth"`
	Insecure bool     `json:"insecure"`
	Timeout  int      `json:"timeout"` // seconds
}

type sendResult struct {
	Status     int               `json:"status"`
	StatusText string            `json:"status_text"`
	Headers    map[string]string `json:"headers"`
	Body       string            `json:"body"`
	Base64     bool              `json:"base64,omitempty"` // a binary body
	Truncated  bool              `json:"truncated,omitempty"`
	Size       int64             `json:"size"`
	Ms         int64             `json:"ms"`
	URL        string            `json:"url"` // after redirects
}

const maxHTTPBody = 10 << 20

var contentTypes = map[string]string{"json": "application/json", "xml": "application/xml", "text": "text/plain", "form": "application/x-www-form-urlencoded"}

// buildHTTPRequest turns the page's request into an http.Request.
func buildHTTPRequest(ctx context.Context, in sendInput) (*http.Request, error) {
	u := strings.TrimSpace(in.URL)
	if u == "" {
		return nil, errors.New("type a URL")
	}
	if !strings.Contains(u, "://") {
		u = "https://" + u
	}
	if !strings.HasPrefix(strings.ToLower(u), "http://") && !strings.HasPrefix(strings.ToLower(u), "https://") {
		return nil, errors.New("only http:// and https:// addresses")
	}
	var body io.Reader
	method := strings.ToUpper(orDefault(in.Method, "GET"))
	if in.BodyType != "" && in.BodyType != "none" && method != "GET" && method != "HEAD" {
		body = strings.NewReader(in.Body)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "WorkHub/"+version)
	if ct := contentTypes[in.BodyType]; ct != "" && body != nil {
		req.Header.Set("Content-Type", ct)
	}
	switch in.Auth.Type {
	case "basic":
		req.SetBasicAuth(in.Auth.User, in.Auth.Pass)
	case "bearer":
		req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(in.Auth.Token))
	case "apikey":
		req.Header.Set(orDefault(strings.TrimSpace(in.Auth.Key), "X-API-Key"), in.Auth.Token)
	}
	for _, h := range in.Headers { // your own headers win
		if h.On && strings.TrimSpace(h.K) != "" {
			req.Header.Set(strings.TrimSpace(h.K), h.V)
		}
	}
	return req, nil
}

func (a *App) handleHTTPSend(w http.ResponseWriter, r *http.Request) {
	var in sendInput
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	timeout := time.Duration(min(max(in.Timeout, 1), 600)) * time.Second
	if in.Timeout == 0 {
		timeout = 60 * time.Second
	}
	ctx, cancel := context.WithTimeout(r.Context(), timeout) // the page's Cancel ends it too
	defer cancel()
	req, err := buildHTTPRequest(ctx, in)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	tr := &http.Transport{Proxy: http.ProxyFromEnvironment, TLSClientConfig: &tls.Config{InsecureSkipVerify: in.Insecure}} // Insecure: only when ticked, for test servers
	client := &http.Client{Transport: tr}
	start := time.Now()
	resp, err := client.Do(req)
	hist := HTTPHist{At: start, Method: req.Method, URL: req.URL.Redacted(), ReqID: in.ReqID}
	if err != nil {
		hist.Error, hist.Ms = err.Error(), time.Since(start).Milliseconds()
		a.store.addHTTPHist(hist)
		writeErr(w, 502, err)
		return
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxHTTPBody+1))
	ms := time.Since(start).Milliseconds()
	out := sendResult{Status: resp.StatusCode, StatusText: http.StatusText(resp.StatusCode), Headers: map[string]string{}, Ms: ms, Size: int64(len(b)), URL: resp.Request.URL.Redacted()}
	if len(b) > maxHTTPBody {
		b, out.Truncated = b[:maxHTTPBody], true
	}
	for k, v := range resp.Header {
		out.Headers[k] = strings.Join(v, ", ")
	}
	if utf8.Valid(b) && !bytes.ContainsRune(b, 0) {
		out.Body = string(b)
	} else {
		out.Body, out.Base64 = base64.StdEncoding.EncodeToString(b), true
	}
	if err != nil {
		hist.Error = err.Error()
	}
	hist.Status, hist.Ms = resp.StatusCode, ms
	a.store.addHTTPHist(hist)
	writeJSON(w, out)
}

func (a *App) handleHTTPData(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, a.store.HTTPData())
}

func (a *App) handleHTTPSaveReq(w http.ResponseWriter, r *http.Request) {
	var in HTTPReq
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	out, err := a.store.SaveHTTPReq(in)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	writeJSON(w, out)
}

func (a *App) handleHTTPDeleteReq(w http.ResponseWriter, r *http.Request) {
	a.store.DeleteHTTPReq(r.PathValue("id"))
	writeJSON(w, map[string]bool{"ok": true})
}

func (a *App) handleHTTPSaveEnv(w http.ResponseWriter, r *http.Request) {
	var in HTTPEnv
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	out, err := a.store.SaveHTTPEnv(in)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	writeJSON(w, out)
}

func (a *App) handleHTTPDeleteEnv(w http.ResponseWriter, r *http.Request) {
	a.store.DeleteHTTPEnv(r.PathValue("id"))
	writeJSON(w, map[string]bool{"ok": true})
}
