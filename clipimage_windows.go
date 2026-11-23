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
	pGetClipboardOwner  = user32.NewProc("GetClipboardOwner")
)

const cfDIB = 8

// "PNG": what Snipping Tool, browsers and Office put on the clipboard next to
// the bitmap — already a PNG file, so nothing to convert.
var cfPNG = func() uintptr {
	name, _ := syscall.UTF16PtrFromString("PNG")
	r, _, _ := pRegisterClipboardFormat.Call(uintptr(unsafe.Pointer(name)))
	return r
}()

// These look at the clipboard without opening it, so they never block anyone.
func clipHas(format uintptr) bool {
	if format == 0 {
		return false
	}
	r, _, _ := pIsClipboardFormatAvailable.Call(format)
	return r != 0
}
func clipHasImage() bool { return clipHas(cfPNG) || clipHas(cfDIB) }
func clipHasText() bool  { return clipHas(cfUnicodeText) }
func clipExcluded() bool { return clipHas(excludeFormat) }

// grabClipboardImage copies the picture off the clipboard. The clipboard is
// open only while the bytes are copied (converting happens afterwards); busy
// means another program has it open right now — try again later, don't wait.
func grabClipboardImage() (data []byte, isPNG, busy bool) {
	if r, _, _ := pOpenClipboard.Call(0); r == 0 {
		return nil, false, true
	}
	defer pCloseClipboard.Call()
	for _, f := range []uintptr{cfPNG, cfDIB} {
		if f == 0 || !clipHas(f) {
			continue
		}
		if b := copyGlobal(f); len(b) > 0 {
			return b, f == cfPNG && len(b) > 8 && string(b[1:4]) == "PNG", false
		}
	}
	return nil, false, false
}

// copyGlobal copies one clipboard format's bytes (the clipboard must be open).
func copyGlobal(format uintptr) []byte {
	h, _, _ := pGetClipboardData.Call(format)
	if h == 0 {
		return nil
	}
	size, _, _ := pGlobalSize.Call(h)
	if size == 0 || size > 200<<20 {
		return nil
	}
	p, _, _ := pGlobalLock.Call(h)
	if p == 0 {
		return nil
	}
	b := make([]byte, size)
	copy(b, unsafe.Slice((*byte)(unsafe.Pointer(p)), size))
	pGlobalUnlock.Call(h)
	return b
}

// clipboardOwnerExe: the program that put the current content on the clipboard.
func clipboardOwnerExe() string {
	hwnd, _, _ := pGetClipboardOwner.Call()
	if hwnd == 0 {
		return ""
	}
	exe, _ := windowExe(hwnd)
	return exe
}

// windowExe returns a window's program file and title.
func windowExe(hwnd uintptr) (exe, title string) {
	buf := make([]uint16, 512)
	n, _, _ := pGetWindowText.Call(hwnd, uintptr(unsafe.Pointer(&buf[0])), 512)
	title = syscall.UTF16ToString(buf[:n])
	var pid uint32
	pGetWindowThreadPID.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
	if ph, _, _ := pOpenProcess.Call(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, 0, uintptr(pid)); ph != 0 {
		name := make([]uint16, 1024)
		size := uint32(len(name))
		if ok, _, _ := pQueryFullImageName.Call(ph, 0, uintptr(unsafe.Pointer(&name[0])), uintptr(unsafe.Pointer(&size))); ok != 0 {
			exe = syscall.UTF16ToString(name[:size])
		}
		pCloseHandle.Call(ph)
	}
	return exe, title
}

// foregroundSource names the window in front ("Outlook — RE: Release plan"),
// where whatever was just copied came from.
func foregroundSource() string {
	hwnd, _, _ := pGetForegroundWindow.Call()
	if hwnd == 0 {
		return ""
	}
	return sourceLabel(windowExe(hwnd))
}
