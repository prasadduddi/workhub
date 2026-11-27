//go:build windows

package main

// The clipboard's formatted (HTML) content — what Teams, Outlook and browsers
// put there next to the plain text — read natively, so the page never has to
// ask the browser for it (no Allow / Block box).

import (
	"errors"
	"syscall"
	"unsafe"
)

var (
	pGlobalSizeHTML = kernel32.NewProc("GlobalSize")
	cfHTML          = func() uintptr {
		name, _ := syscall.UTF16PtrFromString("HTML Format")
		r, _, _ := pRegisterClipboardFormat.Call(uintptr(unsafe.Pointer(name)))
		return r
	}()
)

func readClipboardHTML() (string, error) {
	if cfHTML == 0 {
		return "", nil
	}
	if r, _, _ := pIsClipboardFormatAvailable.Call(cfHTML); r == 0 {
		return "", nil
	}
	if r, _, _ := pOpenClipboard.Call(0); r == 0 {
		return "", errors.New("clipboard busy")
	}
	defer pCloseClipboard.Call()
	h, _, _ := pGetClipboardData.Call(cfHTML)
	if h == 0 {
		return "", nil
	}
	size, _, _ := pGlobalSizeHTML.Call(h)
	p, _, _ := pGlobalLock.Call(h)
	if p == 0 {
		return "", errors.New("cannot lock clipboard")
	}
	defer pGlobalUnlock.Call(h)
	if size > 8<<20 {
		size = 8 << 20
	}
	raw := make([]byte, size)
	copy(raw, unsafe.Slice((*byte)(unsafe.Pointer(p)), size))
	return cfHTMLFragment(raw), nil
}
