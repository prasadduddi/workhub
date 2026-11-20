//go:build windows && desktop

package main

// Desktop version: the same app in its own window (Microsoft Edge WebView2,
// part of Windows 10/11) instead of a browser tab. Built with -tags desktop.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
	"unsafe"

	webview2 "github.com/jchv/go-webview2"
)

const isDesktop = true

// The window must be created and run on the main OS thread.
func init() { runtime.LockOSThread() }

var (
	pMessageBox     = user32.NewProc("MessageBoxW")
	pGetWindowRect  = user32.NewProc("GetWindowRect")
	pSetWindowPos   = user32.NewProc("SetWindowPos")
	pIsZoomed       = user32.NewProc("IsZoomed")
	pShowWindow     = user32.NewProc("ShowWindow")
	pMonitorFromWin = user32.NewProc("MonitorFromWindow")
)

type winRect struct{ Left, Top, Right, Bottom int32 }

type savedWindow struct {
	X, Y, W, H int32
	Maximized  bool
}

func windowFile() string { return filepath.Join(filepath.Dir(defaultDataDir()), "window.json") }

// runDesktop shows url in a native window and returns when it is closed.
// It returns false if WebView2 is not available (the caller then falls back
// to the browser).
func runDesktop(url string, openLink func(string)) bool {
	w := webview2.NewWithOptions(webview2.WebViewOptions{
		AutoFocus: true,
		DataPath:  filepath.Join(filepath.Dir(defaultDataDir()), "webview2"),
		WindowOptions: webview2.WindowOptions{
			Title: "WorkHub", Width: 1440, Height: 900, Center: true, IconId: 1,
		},
	})
	if w == nil {
		return false
	}
	defer w.Destroy()
	hwnd := uintptr(w.Window())
	restoreWindow(hwnd)
	// Web links open in the normal browser, not inside WorkHub.
	_ = w.Bind("whOpenExternal", func(u string) error { openLink(u); return nil })
	// The page reports its title ("WorkHub — <workspace>") for the taskbar.
	_ = w.Bind("whSetTitle", func(t string) error { w.Dispatch(func() { w.SetTitle(t) }); return nil })
	w.Init(`window.WH_DESKTOP = true;`)
	w.Navigate(url)
	w.Run()
	saveWindow(hwnd)
	return true
}

func restoreWindow(hwnd uintptr) {
	b, err := os.ReadFile(windowFile())
	if err != nil {
		return
	}
	var s savedWindow
	if json.Unmarshal(b, &s) != nil || s.W < 400 || s.H < 300 {
		return
	}
	const swpNoZOrder = 0x0004
	pSetWindowPos.Call(hwnd, 0, uintptr(s.X), uintptr(s.Y), uintptr(s.W), uintptr(s.H), swpNoZOrder)
	// If the saved spot is off every screen (monitor unplugged), recentre.
	if m, _, _ := pMonitorFromWin.Call(hwnd, 0); m == 0 { // MONITOR_DEFAULTTONULL
		pSetWindowPos.Call(hwnd, 0, 100, 100, uintptr(s.W), uintptr(s.H), swpNoZOrder)
	}
	if s.Maximized {
		pShowWindow.Call(hwnd, 3) // SW_MAXIMIZE
	}
}

func saveWindow(hwnd uintptr) {
	var r winRect
	if ok, _, _ := pGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&r))); ok == 0 {
		return
	}
	z, _, _ := pIsZoomed.Call(hwnd)
	s := savedWindow{X: r.Left, Y: r.Top, W: r.Right - r.Left, H: r.Bottom - r.Top, Maximized: z != 0}
	if s.Maximized { // keep the previous normal size
		if b, err := os.ReadFile(windowFile()); err == nil {
			var old savedWindow
			if json.Unmarshal(b, &old) == nil {
				s.X, s.Y, s.W, s.H = old.X, old.Y, old.W, old.H
			}
		}
	}
	b, _ := json.Marshal(s)
	_ = os.WriteFile(windowFile(), b, 0o600)
}

// desktopMessage shows an error in a message box (there is no console).
func desktopMessage(title, msg string) {
	t, _ := syscall.UTF16PtrFromString(title)
	m, _ := syscall.UTF16PtrFromString(msg)
	pMessageBox.Call(0, uintptr(unsafe.Pointer(m)), uintptr(unsafe.Pointer(t)), 0x10) // MB_ICONERROR
}
