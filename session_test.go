package main

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// Open tabs stay signed in across restarts, browser restarts and localhost.
func TestSessionSurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	k1, k2 := browserKey(dir), browserKey(dir)
	if k1 == "" || k1 != k2 {
		t.Fatalf("the key changed between starts: %q %q", k1, k2)
	}
	if st, err := os.Stat(filepath.Join(dir, "browser.key")); err != nil || runtime.GOOS != "windows" && st.Mode().Perm()&0o077 != 0 { // Windows: no Unix permissions
		t.Fatalf("browser.key must be private: %v %v", st, err)
	}
	if browserKey(t.TempDir()) == k1 {
		t.Fatal("another data folder got the same key")
	}

	a := &App{addr: "127.0.0.1:47123", token: k1, dataDir: dir}
	ok := a.guard(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) }))
	do := func(host, target string, cookie *http.Cookie) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", target, nil)
		r.Host = host
		if cookie != nil {
			r.AddCookie(cookie)
		}
		w := httptest.NewRecorder()
		ok.ServeHTTP(w, r)
		return w
	}

	// the launch link: a cookie that outlives the browser session
	w := do(a.addr, "/?t="+k1, nil)
	var c *http.Cookie
	for _, x := range w.Result().Cookies() {
		if x.Name == a.cookieName() {
			c = x
		}
	}
	if c == nil || c.MaxAge < 300*24*3600 || !c.HttpOnly || c.SameSite != http.SameSiteStrictMode {
		t.Fatalf("cookie: %+v", c)
	}
	// "after a restart": a new App with the same data folder accepts the same cookie
	b := &App{addr: a.addr, token: browserKey(dir), dataDir: dir}
	r := httptest.NewRequest("GET", "/api/version", nil)
	r.Host = b.addr
	r.AddCookie(&http.Cookie{Name: b.cookieName(), Value: c.Value})
	rw := httptest.NewRecorder()
	b.guard(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) })).ServeHTTP(rw, r)
	if rw.Body.String() != "ok" {
		t.Fatalf("after a restart the tab was signed out: %d %s", rw.Code, rw.Body.String())
	}

	// localhost: sent to 127.0.0.1, where the cookie is
	w = do("localhost:47123", "/?x=1", nil)
	if w.Code != http.StatusFound || w.Header().Get("Location") != "http://127.0.0.1:47123/?x=1" {
		t.Fatalf("localhost: %d %s", w.Code, w.Header().Get("Location"))
	}

	// no cookie (another browser, cookies cleared): a clear page, not a dead end
	w = do(a.addr, "/", nil)
	if w.Code != http.StatusUnauthorized || !strings.Contains(w.Body.String(), "Open WorkHub from its icon") {
		t.Fatalf("signed out: %d %s", w.Code, w.Body.String())
	}
	// a wrong key still gets nothing
	if w := do(a.addr, "/api/version", &http.Cookie{Name: a.cookieName(), Value: strings.Repeat("0", 32)}); w.Code != http.StatusUnauthorized {
		t.Fatalf("a wrong cookie got in: %d", w.Code)
	}
	// the key stays out of backups
	if !backupSkip("browser.key", fakeFile("browser.key")) {
		t.Fatal("browser.key would go into backups")
	}
}

type fakeFile string

func (f fakeFile) Name() string               { return string(f) }
func (f fakeFile) IsDir() bool                { return false }
func (f fakeFile) Type() fs.FileMode          { return 0 }
func (f fakeFile) Info() (fs.FileInfo, error) { return nil, nil }
