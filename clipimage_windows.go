package main

import (
	"syscall"
	"unsafe"
)

var (
	pGlobalSize         = kernel32.NewProc("GlobalSize")
	pGetWindowText      = user32.NewProc("GetWindowTextW")
	pGetWindowThreadPID = user32.NewProc("GetWindowThreadProcessId")
	pOpenProcess        = kernel32.NewProc("OpenProcess")
	pCloseHandle        = kernel32.NewProc("CloseHandle")
	pQueryFullImageName = kernel32.NewProc("QueryFullProcessImageNameW")
)

const cfDIB = 8

// readClipboardImage returns a copied picture as PNG (only when there is no
// text on the clipboard, i.e. a screenshot rather than copied cells/text).
func readClipboardImage() ([]byte, bool) {
	if r, _, _ := pIsClipboardFormatAvailable.Call(cfDIB); r == 0 {
		return nil, false
	}
	if r, _, _ := pIsClipboardFormatAvailable.Call(cfUnicodeText); r != 0 {
		return nil, false
	}
	if r, _, _ := pOpenClipboard.Call(0); r == 0 {
		return nil, false
	}
	defer pCloseClipboard.Call()
	h, _, _ := pGetClipboardData.Call(cfDIB)
	if h == 0 {
		return nil, false
	}
	size, _, _ := pGlobalSize.Call(h)
	p, _, _ := pGlobalLock.Call(h)
	if p == 0 || size == 0 || size > 200<<20 {
		return nil, false
	}
	b := make([]byte, size)
	copy(b, unsafe.Slice((*byte)(unsafe.Pointer(p)), size))
	pGlobalUnlock.Call(h)
	out, err := dibToPNG(b)
	return out, err == nil
}

// foregroundSource names the window in front ("Outlook — RE: Release plan"),
// where whatever was just copied came from.
func foregroundSource() string {
	hwnd, _, _ := pGetForegroundWindow.Call()
	if hwnd == 0 {
		return ""
	}
	buf := make([]uint16, 512)
	n, _, _ := pGetWindowText.Call(hwnd, uintptr(unsafe.Pointer(&buf[0])), 512)
	title := syscall.UTF16ToString(buf[:n])
	var pid uint32
	pGetWindowThreadPID.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
	exe := ""
	if ph, _, _ := pOpenProcess.Call(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, 0, uintptr(pid)); ph != 0 {
		name := make([]uint16, 1024)
		size := uint32(len(name))
		if ok, _, _ := pQueryFullImageName.Call(ph, 0, uintptr(unsafe.Pointer(&name[0])), uintptr(unsafe.Pointer(&size))); ok != 0 {
			exe = syscall.UTF16ToString(name[:size])
		}
		pCloseHandle.Call(ph)
	}
	return sourceLabel(exe, title)
}
