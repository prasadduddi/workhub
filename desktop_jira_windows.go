//go:build windows && desktop

package main

// The Jira sign-in window for "Sign in with browser" (see jira_browser.go).
// It is a second WebView2 window on the same thread and profile as the main
// one. Closing it only hides it, so the session stays alive; WorkHub talks to
// Jira by running fetch() inside it.

import (
	"encoding/json"
	"errors"
	"net/url"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	webview2 "github.com/jchv/go-webview2"
)

var (
	pSetWindowLongPtr   = user32.NewProc("SetWindowLongPtrW")
	pCallWindowProc     = user32.NewProc("CallWindowProcW")
	pSetForegroundWin   = user32.NewProc("SetForegroundWindow")
	pIsWindowVisible    = user32.NewProc("IsWindowVisible")
	jiraWinOrigProc     uintptr
	jiraWinProcCallback = syscall.NewCallback(func(hwnd, msg, wp, lp uintptr) uintptr {
		if msg == 0x0010 { // WM_CLOSE: hide, keep the session
			pShowWindow.Call(hwnd, 0) // SW_HIDE
			return 0
		}
		r, _, _ := pCallWindowProc.Call(jiraWinOrigProc, hwnd, msg, wp, lp)
		return r
	})
)

type jiraReply struct {
	status int
	body   string
}

// setupJiraWindow sets the jiraWin* hooks. main is the app's window; all
// window work is done on its thread through main.Dispatch.
func setupJiraWindow(main webview2.WebView) {
	var (
		jw      webview2.WebView // only touched on the main thread
		jwHwnd  uintptr
		origin  string
		mu      sync.Mutex
		nextID  int
		waiting = map[int]chan jiraReply{}
	)
	onMain := func(f func() error) error {
		done := make(chan error, 1)
		main.Dispatch(func() { done <- f() })
		select {
		case err := <-done:
			return err
		case <-time.After(60 * time.Second):
			return errors.New("the Jira sign-in window didn't respond")
		}
	}
	create := func(u string) error {
		jw = webview2.NewWithOptions(webview2.WebViewOptions{
			AutoFocus: true,
			DataPath:  filepath.Join(filepath.Dir(defaultDataDir()), "webview2"),
			WindowOptions: webview2.WindowOptions{
				Title: "Sign in to Jira — WorkHub (close this window when you're signed in)", Width: 1000, Height: 780, Center: true, IconId: 1,
			},
		})
		if jw == nil {
			return errors.New("couldn't open the Jira sign-in window (WebView2)")
		}
		jwHwnd = uintptr(jw.Window())
		jiraWinOrigProc, _, _ = pSetWindowLongPtr.Call(jwHwnd, ^uintptr(3) /* GWLP_WNDPROC = -4 */, jiraWinProcCallback)
		_ = jw.Bind("whJiraReply", func(id, status int, body string) {
			mu.Lock()
			ch := waiting[id]
			delete(waiting, id)
			mu.Unlock()
			if ch != nil {
				ch <- jiraReply{status, body}
			}
		})
		jw.Navigate(u)
		// Creating the window runs its own message loop, which can swallow the
		// main window's wake-up; nudge it.
		main.Dispatch(func() {})
		return nil
	}

	jiraWinOpen = func(u string, show, reload bool) error {
		if p, err := url.Parse(u); err == nil && p.Host != "" {
			o := p.Scheme + "://" + p.Host
			mu.Lock()
			origin = o
			mu.Unlock()
		}
		return onMain(func() error {
			if jw == nil {
				if err := create(u); err != nil {
					return err
				}
				if !show {
					pShowWindow.Call(jwHwnd, 0) // SW_HIDE: opened at start-up to sign in quietly
				}
			} else if reload {
				jw.Navigate(u)
			}
			if show {
				pShowWindow.Call(jwHwnd, 9) // SW_RESTORE
				pSetForegroundWin.Call(jwHwnd)
			}
			return nil
		})
	}

	jiraWinHide = func() {
		_ = onMain(func() error {
			if jwHwnd != 0 {
				pShowWindow.Call(jwHwnd, 0)
			}
			return nil
		})
	}

	jiraWinShown = func() bool {
		shown := false
		_ = onMain(func() error {
			if jwHwnd != 0 {
				v, _, _ := pIsWindowVisible.Call(jwHwnd)
				shown = v != 0
			}
			return nil
		})
		return shown
	}

	jiraWinFetch = func(u string) (int, string, error) {
		mu.Lock()
		nextID++
		id, ch, o := nextID, make(chan jiraReply, 1), origin
		waiting[id] = ch
		mu.Unlock()
		defer func() { mu.Lock(); delete(waiting, id); mu.Unlock() }()
		ju, _ := json.Marshal(u)
		jo, _ := json.Marshal(o)
		// Status 0 = the window isn't on Jira (e.g. still on the login page).
		js := `(async () => { let s = 0, t = '';
  try {
    if (location.origin === ` + string(jo) + `) {
      const r = await fetch(` + string(ju) + `, { credentials: 'include', headers: { 'Accept': 'application/json', 'X-Atlassian-Token': 'no-check' } });
      s = r.redirected && new URL(r.url).origin !== location.origin ? 401 : r.status; t = await r.text();
    }
  } catch (e) { t = String(e); }
  window.whJiraReply && window.whJiraReply(` + itoa(id) + `, s, t);
})();`
		if err := onMain(func() error {
			if jw == nil {
				return errors.New("the Jira sign-in window isn't open")
			}
			jw.Eval(js)
			return nil
		}); err != nil {
			return 0, "", err
		}
		select {
		case r := <-ch:
			return r.status, r.body, nil
		case <-time.After(45 * time.Second):
			return 0, "", errors.New("Jira didn't answer in the sign-in window (45 s)")
		}
	}
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }
