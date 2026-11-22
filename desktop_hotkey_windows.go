//go:build windows && desktop

package main

// Ctrl+Alt+W anywhere in Windows brings the WorkHub window to the front with
// the search box ready (a system-wide hotkey, like a launcher).

import (
	"log"
	"syscall"

	webview2 "github.com/jchv/go-webview2"
)

var (
	pRegisterHotKey  = user32.NewProc("RegisterHotKey")
	pIsIconic        = user32.NewProc("IsIconic")
	mainOrigProc     uintptr
	mainHotkeyTarget webview2.WebView
	mainProcCallback = syscall.NewCallback(func(hwnd, msg, wp, lp uintptr) uintptr {
		if msg == 0x0312 && wp == 1 { // WM_HOTKEY
			if ic, _, _ := pIsIconic.Call(hwnd); ic != 0 {
				pShowWindow.Call(hwnd, 9) // SW_RESTORE
			} else {
				pShowWindow.Call(hwnd, 5) // SW_SHOW
			}
			pSetForegroundWin.Call(hwnd)
			if mainHotkeyTarget != nil {
				mainHotkeyTarget.Eval("window.whHotkey && window.whHotkey()")
			}
			return 0
		}
		r, _, _ := pCallWindowProc.Call(mainOrigProc, hwnd, msg, wp, lp)
		return r
	})
)

func registerHotkey(w webview2.WebView, hwnd uintptr) {
	mainHotkeyTarget = w
	mainOrigProc, _, _ = pSetWindowLongPtr.Call(hwnd, ^uintptr(3) /* GWLP_WNDPROC */, mainProcCallback)
	const modAlt, modControl, modNoRepeat = 0x1, 0x2, 0x4000
	if ok, _, err := pRegisterHotKey.Call(hwnd, 1, modControl|modAlt|modNoRepeat, 'W'); ok == 0 {
		log.Println("hotkey Ctrl+Alt+W not available (another program uses it):", err)
	}
}
