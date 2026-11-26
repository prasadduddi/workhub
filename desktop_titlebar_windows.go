//go:build windows && desktop

package main

// A light blue title bar (Windows 11), so the WorkHub window is easy to spot and
// to grab and drag. Windows 10 ignores it (there the title bar follows Windows'
// own colour settings).

import (
	"syscall"
	"unsafe"
)

var (
	dwmapi                 = syscall.NewLazyDLL("dwmapi.dll")
	pDwmSetWindowAttribute = dwmapi.NewProc("DwmSetWindowAttribute")
)

const (
	dwmwaBorderColor  = 34
	dwmwaCaptionColor = 35
	dwmwaTextColor    = 36
)

// colorRef: 0x00BBGGRR
func colorRef(r, g, b byte) uint32 { return uint32(r) | uint32(g)<<8 | uint32(b)<<16 }

func tintTitleBar(hwnd uintptr) {
	if hwnd == 0 || pDwmSetWindowAttribute.Find() != nil {
		return
	}
	set := func(attr uint32, c uint32) {
		pDwmSetWindowAttribute.Call(hwnd, uintptr(attr), uintptr(unsafe.Pointer(&c)), 4)
	}
	set(dwmwaCaptionColor, colorRef(0xDB, 0xE6, 0xF8)) // soft blue
	set(dwmwaTextColor, colorRef(0x1B, 0x2B, 0x4A))    // dark blue-grey text
	set(dwmwaBorderColor, colorRef(0x8F, 0xB0, 0xEA))  // a slightly bluer border
}
