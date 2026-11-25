package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// A pretend Microsoft (login + Graph) for the Teams connection.
func fakeMicrosoft(t *testing.T) (*httptest.Server, *sync.Map) {
	seen := &sync.Map{}
	polls := 0
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		seen.Store(r.Method+" "+r.URL.Path, string(body))
		js := func(v any) { w.Header().Set("Content-Type", "application/json"); json.NewEncoder(w).Encode(v) }
		auth := r.Header.Get("Authorization") == "Bearer AT1"
		switch {
		case strings.HasSuffix(r.URL.Path, "/oauth2/v2.0/devicecode"):
			js(map[string]any{"device_code": "DEV", "user_code": "ABCD-EFGH", "verification_uri": "https://microsoft.com/devicelogin", "interval": 1, "expires_in": 30})
		case strings.HasSuffix(r.URL.Path, "/oauth2/v2.0/token"):
			if strings.Contains(string(body), "device_code") {
				if polls++; polls < 2 {
					js(map[string]any{"error": "authorization_pending"})
					return
				}
			}
			js(map[string]any{"access_token": "AT1", "refresh_token": "RT1", "expires_in": 3600})
		case !auth:
			w.WriteHeader(401)
		case r.URL.Path == "/v1.0/me":
			js(map[string]any{"id": "me-id", "displayName": "Prasad Test"})
		case r.Method == "POST" && r.URL.Path == "/v1.0/chats":
			js(map[string]any{"id": "chat-1"})
		case r.Method == "POST" && r.URL.Path == "/v1.0/chats/chat-1/messages":
			js(map[string]any{"id": "m-new"})
		case r.URL.Path == "/v1.0/me/chats":
			js(map[string]any{"value": []any{map[string]any{"id": "chat-1", "chatType": "oneOnOne", "members": []any{
				map[string]any{"displayName": "Prasad Test", "userId": "me-id"}, map[string]any{"displayName": "Bob Ops", "userId": "bob"}}}}})
		case r.Method == "GET" && r.URL.Path == "/v1.0/chats/chat-1/messages":
			js(map[string]any{"value": []any{
				map[string]any{"id": "m2", "messageType": "message", "createdDateTime": "2026-11-25T09:05:00Z", "from": map[string]any{"user": map[string]any{"displayName": "Bob Ops"}},
					"body": map[string]any{"contentType": "html", "content": `<p>Restarted <b>app-01</b>, see:</p><img src="https://graph.microsoft.com/v1.0/chats/chat-1/messages/m2/hostedContents/h1/$value">`}},
				map[string]any{"id": "sys", "messageType": "systemEventMessage", "body": map[string]any{"content": "joined"}},
				map[string]any{"id": "m1", "messageType": "message", "createdDateTime": "2026-11-25T09:00:00Z", "from": map[string]any{"user": map[string]any{"displayName": "Bob Ops"}},
					"body": map[string]any{"contentType": "text", "content": "deploy done"}},
			}})
		case strings.HasSuffix(r.URL.Path, "/hostedContents/h1/$value"):
			w.Write([]byte("\x89PNG teams picture"))
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	return srv, seen
}

func TestTeamsConnection(t *testing.T) {
	srv, seen := fakeMicrosoft(t)
	defer srv.Close()
	oldLogin, oldGraph, oldHTTP := teamsLogin, teamsGraph, teamsHTTP
	teamsLogin, teamsGraph, teamsHTTP = srv.URL, srv.URL+"/v1.0", srv.Client()
	// the hosted picture URLs in messages point at graph.microsoft.com: send those to the fake too
	teamsHTTP.Transport = rewriteTo(srv.URL)
	defer func() { teamsLogin, teamsGraph, teamsHTTP = oldLogin, oldGraph, oldHTTP; teamsState = &teamsAuth{} }()
	teamsState = &teamsAuth{}

	s, _ := OpenStore(t.TempDir())
	a := &App{store: s}
	call := func(h http.HandlerFunc, method, target string, body any) *httptest.ResponseRecorder {
		var rd io.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			rd = bytes.NewReader(b)
		}
		w := httptest.NewRecorder()
		h(w, httptest.NewRequest(method, target, rd))
		return w
	}

	if w := call(a.handleTeamsSignIn, "POST", "/api/teams/signin", nil); w.Code != 400 {
		t.Fatal("sign-in without tenant/client must be refused")
	}
	call(a.handleTeamsConfig, "PUT", "/api/teams/config", map[string]string{"tenant": "contoso", "client_id": "app-1"})
	w := call(a.handleTeamsSignIn, "POST", "/api/teams/signin", nil)
	if !strings.Contains(w.Body.String(), "ABCD-EFGH") {
		t.Fatalf("device code: %s", w.Body.String())
	}
	deadline := time.Now().Add(8 * time.Second)
	for a.store.TeamsConfig().User == "" && time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)
	}
	st := call(a.handleTeamsStatus, "GET", "/api/teams/status", nil).Body.String()
	if !strings.Contains(st, `"signed_in":true`) || !strings.Contains(st, "Prasad Test") || strings.Contains(st, "RT1") {
		t.Fatalf("status (signed in, the token not shown): %s", st)
	}

	// send a thread message with a picture to Bob
	wi := s.SaveWorkItem(WorkItem{Title: "x"})
	at, _ := s.storeAttachment("shot.png", []byte("\x89PNG local picture"))
	at.Image, at.Mime = true, "image/png"
	s.AddWorkFile(wi.ID, at)
	p, _ := s.AddPost(wi.ID, Post{Kind: "note", HTML: `<p>Look at this</p><img src="/api/props/files/` + at.ID + `">`})
	w = call(a.handleTeamsSend, "POST", "/api/teams/send", map[string]any{"thread": wi.ID, "post": p.ID, "to": []string{"bob@example.com"}})
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"pictures":1`) {
		t.Fatalf("send: %d %s", w.Code, w.Body.String())
	}
	chatReq, _ := seen.Load("POST /v1.0/chats")
	msgReq, _ := seen.Load("POST /v1.0/chats/chat-1/messages")
	if !strings.Contains(chatReq.(string), "oneOnOne") || !strings.Contains(chatReq.(string), "bob@example.com") || !strings.Contains(chatReq.(string), "me-id") {
		t.Fatalf("chat: %s", chatReq)
	}
	if !strings.Contains(msgReq.(string), "Look at this") || !strings.Contains(msgReq.(string), "hostedContents/1/$value") || !strings.Contains(msgReq.(string), "contentBytes") {
		t.Fatalf("message: %s", msgReq)
	}
	// two people: a group chat
	call(a.handleTeamsSend, "POST", "/api/teams/send", map[string]any{"thread": wi.ID, "post": p.ID, "to": []string{"bob@example.com", "ann@example.com"}})
	if chatReq, _ = seen.Load("POST /v1.0/chats"); !strings.Contains(chatReq.(string), `"group"`) {
		t.Fatalf("group chat: %s", chatReq)
	}

	// bring messages in: chats, then the two real messages (oldest first), picture stored
	if c := call(a.handleTeamsChats, "GET", "/api/teams/chats", nil).Body.String(); !strings.Contains(c, `"name":"Bob Ops"`) {
		t.Fatalf("chats: %s", c)
	}
	n0 := len(func() []*Post { w, _ := s.GetWorkItem(wi.ID); return w.Posts }())
	w = call(a.handleTeamsImport, "POST", "/api/teams/import", map[string]any{"thread": wi.ID, "chat": "chat-1", "name": "Bob Ops", "ids": []string{"m1", "m2"}})
	if !strings.Contains(w.Body.String(), `"added":2`) {
		t.Fatalf("import: %s", w.Body.String())
	}
	got, _ := s.GetWorkItem(wi.ID)
	posts := got.Posts[n0:]
	if !strings.Contains(posts[0].HTML, "deploy done") || !strings.Contains(posts[1].HTML, "Restarted <b>app-01</b>") || posts[1].From != "Teams" {
		t.Fatalf("imported: %+v", posts)
	}
	if !strings.Contains(posts[1].HTML, "/api/props/files/") || strings.Contains(posts[1].HTML, "graph.microsoft.com") {
		t.Fatalf("the Teams picture wasn't kept: %s", posts[1].HTML)
	}

	call(a.handleTeamsSignOut, "POST", "/api/teams/signout", nil)
	if s.TeamsConfig().Refresh != "" {
		t.Fatal("sign out kept the token")
	}
}

// rewriteTo sends every request to the fake server (Graph URLs in message bodies included).
type rewriteTo string

func (r rewriteTo) RoundTrip(req *http.Request) (*http.Response, error) {
	u := *req.URL
	base, _ := http.NewRequest("GET", string(r), nil)
	u.Scheme, u.Host = base.URL.Scheme, base.URL.Host
	req2 := req.Clone(req.Context())
	req2.URL = &u
	req2.Host = u.Host
	return http.DefaultTransport.RoundTrip(req2)
}
