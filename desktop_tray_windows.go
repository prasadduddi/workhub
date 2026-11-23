//go:build windows && desktop

package main

// Tray icon (Desktop version): closing the window hides WorkHub to the
// notification area, so clipboard capture, tunnels and transfers keep going.
// Click the icon to bring the window back; right-click for Open / Quit.
// ☰ → "Close button keeps WorkHub running" switches it off (close = quit).

import (
	"syscall"
	"unsafe"
)

var (
	pShellNotifyIcon  = shell32.NewProc("Shell_NotifyIconW")
	pLoadImage        = user32.NewProc("LoadImageW")
	pGetSystemMetrics = user32.NewProc("GetSystemMetrics")
	pCreatePopupMenu  = user32.NewProc("CreatePopupMenu")
	pAppendMenu       = user32.NewProc("AppendMenuW")
	pTrackPopupMenu   = user32.NewProc("TrackPopupMenu")
	pDestroyMenu      = user32.NewProc("DestroyMenu")
	pGetCursorPos     = user32.NewProc("GetCursorPos")
	pPostMessage      = user32.NewProc("PostMessageW")
	pRegisterWinMsg   = user32.NewProc("RegisterWindowMessageW")
	pGetModuleHandle  = kernel32.NewProc("GetModuleHandleW")

	closeToTray   = true // set by the page (☰ switch); default on
	trayQuitting  bool   // Quit from the tray menu: really close
	trayShown     bool
	trayTipShown  bool
	trayHwnd      uintptr
	taskbarReborn uintptr // "TaskbarCreated": Explorer restarted, add the icon again
)

const (
	wmTray       = 0x8000 + 1 // WM_APP+1
	nimAdd       = 0
	nimModify    = 1
	nimDelete    = 2
	nifMessage   = 0x1
	nifIcon      = 0x2
	nifTip       = 0x4
	nifInfo      = 0x10
	trayMenuOpen = 1
	trayMenuQuit = 2
)

type notifyIconData struct {
	CbSize           uint32
	HWnd             uintptr
	UID              uint32
	UFlags           uint32
	UCallbackMessage uint32
	HIcon            uintptr
	SzTip            [128]uint16
	DwState          uint32
	DwStateMask      uint32
	SzInfo           [256]uint16
	UVersion         uint32
	SzInfoTitle      [64]uint16
	DwInfoFlags      uint32
	GuidItem         [16]byte
	HBalloonIcon     uintptr
}

func trayData(flags uint32) *notifyIconData {
	d := &notifyIconData{HWnd: trayHwnd, UID: 1, UFlags: flags, UCallbackMessage: wmTray}
	d.CbSize = uint32(unsafe.Sizeof(*d))
	return d
}

func copyUTF16(dst []uint16, s string) {
	u, _ := syscall.UTF16FromString(s)
	copy(dst[:len(dst)-1], u)
}

// trayAdd puts WorkHub's icon in the notification area (once).
func trayAdd() {
	if trayShown {
		return
	}
	inst, _, _ := pGetModuleHandle.Call(0)
	cx, _, _ := pGetSystemMetrics.Call(49) // SM_CXSMICON
	cy, _, _ := pGetSystemMetrics.Call(50) // SM_CYSMICON
	icon, _, _ := pLoadImage.Call(inst, 1 /* the app icon */, 1 /* IMAGE_ICON */, cx, cy, 0)
	d := trayData(nifMessage | nifIcon | nifTip)
	d.HIcon = icon
	copyUTF16(d.SzTip[:], "WorkHub — click to open")
	if ok, _, _ := pShellNotifyIcon.Call(nimAdd, uintptr(unsafe.Pointer(d))); ok != 0 {
		trayShown = true
	}
}

// trayRemove takes the icon away (on quit).
func trayRemove() {
	if trayShown {
		pShellNotifyIcon.Call(nimDelete, uintptr(unsafe.Pointer(trayData(0))))
		trayShown = false
	}
}

// trayTip tells, the first time, that WorkHub is still running.
func trayTip() {
	if trayTipShown || !trayShown {
		return
	}
	trayTipShown = true
	d := trayData(nifInfo)
	copyUTF16(d.SzInfoTitle[:], "WorkHub is still running")
	copyUTF16(d.SzInfo[:], "Clipboard capture, tunnels and transfers carry on. Click the WorkHub icon here to open it, or right-click → Quit.")
	d.DwInfoFlags = 1 // NIIF_INFO
	pShellNotifyIcon.Call(nimModify, uintptr(unsafe.Pointer(d)))
}

func trayShowWindow(hwnd uintptr) {
	if ic, _, _ := pIsIconic.Call(hwnd); ic != 0 {
		pShowWindow.Call(hwnd, 9) // SW_RESTORE
	} else {
		pShowWindow.Call(hwnd, 5) // SW_SHOW
	}
	pSetForegroundWin.Call(hwnd)
}

func trayMenu(hwnd uintptr) {
	m, _, _ := pCreatePopupMenu.Call()
	if m == 0 {
		return
	}
	defer pDestroyMenu.Call(m)
	open, _ := syscall.UTF16PtrFromString("Open WorkHub")
	quit, _ := syscall.UTF16PtrFromString("Quit WorkHub")
	pAppendMenu.Call(m, 0, trayMenuOpen, uintptr(unsafe.Pointer(open)))
	pAppendMenu.Call(m, 0x800 /* MF_SEPARATOR */, 0, 0)
	pAppendMenu.Call(m, 0, trayMenuQuit, uintptr(unsafe.Pointer(quit)))
	var pt struct{ X, Y int32 }
	pGetCursorPos.Call(uintptr(unsafe.Pointer(&pt)))
	pSetForegroundWin.Call(hwnd) // so the menu closes when you click elsewhere
	cmd, _, _ := pTrackPopupMenu.Call(m, 0x100|0x2 /* TPM_RETURNCMD|TPM_RIGHTBUTTON */, uintptr(pt.X), uintptr(pt.Y), 0, hwnd, 0)
	pPostMessage.Call(hwnd, 0, 0, 0) // WM_NULL
	switch cmd {
	case trayMenuOpen:
		trayShowWindow(hwnd)
	case trayMenuQuit:
		trayQuitting = true
		pPostMessage.Call(hwnd, 0x0010, 0, 0) // WM_CLOSE
	}
}

// trayProc handles the main window's messages for the tray; handled=false
// passes them on.
func trayProc(hwnd, msg, wp, lp uintptr) (r uintptr, handled bool) {
	switch {
	case msg == 0x0010 && closeToTray && !trayQuitting: // WM_CLOSE: hide to the tray
		trayHwnd = hwnd
		saveWindow(hwnd)
		trayAdd()
		if trayShown {
			pShowWindow.Call(hwnd, 0) // SW_HIDE
			trayTip()
			return 0, true
		}
	case msg == wmTray:
		switch lp & 0xffff {
		case 0x202, 0x203: // WM_LBUTTONUP, WM_LBUTTONDBLCLK
			trayShowWindow(hwnd)
		case 0x205: // WM_RBUTTONUP
			trayMenu(hwnd)
		}
		return 0, true
	case taskbarReborn != 0 && msg == taskbarReborn && trayShown:
		trayShown = false
		trayAdd()
	case msg == 0x0002: // WM_DESTROY
		trayRemove()
	}
	return 0, false
}

func init() {
	name, _ := syscall.UTF16PtrFromString("TaskbarCreated")
	taskbarReborn, _, _ = pRegisterWinMsg.Call(uintptr(unsafe.Pointer(name)))
	beforeExit = append(beforeExit, trayRemove)
}
