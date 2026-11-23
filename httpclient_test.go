package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHTTPSend(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/bin" {
			w.Write([]byte{0x89, 'P', 'N', 'G', 0, 1, 2})
			return
		}
		b, _ := io.ReadAll(r.Body)
		w.Header().Set("X-Seen-Auth", r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(map[string]string{"method": r.Method, "ct": r.Header.Get("Content-Type"), "body": string(b), "trace": r.Header.Get("X-Trace")})
	}))
	defer srv.Close()
	st, _ := OpenStore(t.TempDir())
	a := &App{store: st}
	send := func(in sendInput) (sendResult, int) {
		b, _ := json.Marshal(in)
		w := httptest.NewRecorder()
		a.handleHTTPSend(w, httptest.NewRequest("POST", "/api/http/send", strings.NewReader(string(b))))
		var out sendResult
		json.Unmarshal(w.Body.Bytes(), &out)
		return out, w.Code
	}
	out, code := send(sendInput{Method: "post", URL: srv.URL + "/pay", BodyType: "json", Body: `{"id":1}`,
		Auth: HTTPAuth{Type: "bearer", Token: "tok123"}, Headers: []KV{{K: "X-Trace", V: "abc", On: true}, {K: "X-Off", V: "no", On: false}}})
	if code != 200 || out.Status != 201 || out.Headers["X-Seen-Auth"] != "Bearer tok123" {
		t.Fatalf("send: %d %+v", code, out)
	}
	var echo map[string]string
	json.Unmarshal([]byte(out.Body), &echo)
	if echo["method"] != "POST" || echo["ct"] != "application/json" || echo["body"] != `{"id":1}` || echo["trace"] != "abc" {
		t.Fatalf("echo: %v", echo)
	}
	if bin, _ := send(sendInput{URL: srv.URL + "/bin"}); !bin.Base64 {
		t.Fatal("a binary body should come back as base64")
	}
	if _, code := send(sendInput{URL: "file:///etc/passwd"}); code != 400 {
		t.Fatal("only http(s) may be sent")
	}
	h := st.HTTPData()["history"].([]HTTPHist)
	if len(h) != 2 || h[1].Status != 201 || h[1].Method != "POST" {
		t.Fatalf("history: %+v", h)
	}
}

// A "localhost" environment is there from the start, and only made once.
func TestLocalhostEnv(t *testing.T) {
	st, _ := OpenStore(t.TempDir())
	envs := st.HTTPData()["envs"].([]HTTPEnv)
	if len(envs) != 1 || envs[0].Name != "localhost" || envs[0].Vars[0].V != "http://localhost:8080" {
		t.Fatalf("envs: %+v", envs)
	}
	st.DeleteHTTPEnv(envs[0].ID)
	if n := len(st.HTTPData()["envs"].([]HTTPEnv)); n != 0 {
		t.Fatal("a deleted localhost must not come back")
	}
}
