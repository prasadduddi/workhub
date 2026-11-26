//go:build windows

package main

// The folder chooser on Windows: the Explorer-style dialog (IFileOpenDialog
// with "pick folders") — the same window as Open file, with the address bar,
// Quick access and search — opening in the given folder. Falls back to the
// older "Browse for Folder" tree if it can't be started.

import (
	"errors"
	"runtime"
	"syscall"
	"unsafe"
)

type comGUID struct {
	Data1        uint32
	Data2, Data3 uint16
	Data4        [8]byte
}

var (
	clsidFileOpenDialog = comGUID{0xDC1C5A9C, 0xE88A, 0x4DDE, [8]byte{0xA5, 0xA1, 0x60, 0xF8, 0x2A, 0x20, 0xAE, 0xF7}}
	iidIFileOpenDialog  = comGUID{0xD57C7288, 0xD4AD, 0x4768, [8]byte{0xBE, 0x02, 0x9D, 0x96, 0x95, 0x32, 0xD9, 0x60}}
	iidIShellItem       = comGUID{0x43826D1E, 0xE718, 0x42EE, [8]byte{0xBC, 0x55, 0xA1, 0xE2, 0x61, 0xC3, 0x7B, 0xFE}}

	pCoCreateInstance            = ole32.NewProc("CoCreateInstance")
	pSHCreateItemFromParsingName = shell32.NewProc("SHCreateItemFromParsingName")
)

const (
	clsctxInprocServer = 0x1
	fosPickFolders     = 0x20
	fosForceFileSystem = 0x40
	fosPathMustExist   = 0x800
	sigdnFileSysPath   = 0x80058000
	hrCancelled        = 0x800704C7 // HRESULT_FROM_WIN32(ERROR_CANCELLED)
)

// comCall calls method i of a COM object's table.
func comCall(obj uintptr, i int, args ...uintptr) uintptr {
	vtbl := *(*uintptr)(unsafe.Pointer(obj))
	fn := *(*uintptr)(unsafe.Pointer(vtbl + uintptr(i)*unsafe.Sizeof(uintptr(0))))
	r, _, _ := syscall.SyscallN(fn, append([]uintptr{obj}, args...)...)
	return r
}

// IFileDialog methods (after IUnknown 0-2 and IModalWindow.Show 3)
const (
	mShow       = 3
	mSetOptions = 9
	mGetOptions = 10
	mSetFolder  = 12
	mSetTitle   = 17
	mGetResult  = 20
	mRelease    = 2
	mDisplay    = 5 // IShellItem.GetDisplayName
)

func pickFolder(start string) (path string, ok bool, err error) {
	done := make(chan struct{})
	tryOld := false
	go func() {
		defer close(done)
		runtime.LockOSThread() // COM and the dialog need one fixed thread
		defer runtime.UnlockOSThread()
		pCoInitializeEx.Call(0, 2) // COINIT_APARTMENTTHREADED
		defer pCoUninitialize.Call()

		var dlg uintptr
		if hr, _, _ := pCoCreateInstance.Call(uintptr(unsafe.Pointer(&clsidFileOpenDialog)), 0, clsctxInprocServer,
			uintptr(unsafe.Pointer(&iidIFileOpenDialog)), uintptr(unsafe.Pointer(&dlg))); hr != 0 || dlg == 0 {
			tryOld = true
			return
		}
		defer comCall(dlg, mRelease)
		var opts uint32
		comCall(dlg, mGetOptions, uintptr(unsafe.Pointer(&opts)))
		comCall(dlg, mSetOptions, uintptr(opts|fosPickFolders|fosForceFileSystem|fosPathMustExist))
		title, _ := syscall.UTF16PtrFromString("Choose a folder")
		comCall(dlg, mSetTitle, uintptr(unsafe.Pointer(title)))
		if start != "" { // open in this folder
			if sp, e := syscall.UTF16PtrFromString(start); e == nil {
				var item uintptr
				if hr, _, _ := pSHCreateItemFromParsingName.Call(uintptr(unsafe.Pointer(sp)), 0, uintptr(unsafe.Pointer(&iidIShellItem)), uintptr(unsafe.Pointer(&item))); hr == 0 && item != 0 {
					comCall(dlg, mSetFolder, item)
					comCall(item, mRelease)
				}
			}
		}
		owner, _, _ := pGetForegroundWindow.Call()
		hr := comCall(dlg, mShow, owner)
		if uint32(hr) == hrCancelled {
			return // cancelled: ok stays false
		}
		if hr != 0 {
			tryOld = true
			return
		}
		var res uintptr
		if comCall(dlg, mGetResult, uintptr(unsafe.Pointer(&res))) != 0 || res == 0 {
			err = errors.New("couldn't read the chosen folder")
			return
		}
		defer comCall(res, mRelease)
		var name *uint16
		if comCall(res, mDisplay, sigdnFileSysPath, uintptr(unsafe.Pointer(&name))) != 0 || name == nil {
			err = errors.New("that location is not a normal folder")
			return
		}
		defer pCoTaskMemFree.Call(uintptr(unsafe.Pointer(name)))
		path, ok = utf16PtrToString(name), true
	}()
	<-done
	if tryOld {
		return pickFolderOld(start)
	}
	return
}

// utf16PtrToString reads a NUL-terminated UTF-16 string.
func utf16PtrToString(p *uint16) string {
	var buf []uint16
	for ptr := unsafe.Pointer(p); ; ptr = unsafe.Add(ptr, 2) {
		c := *(*uint16)(ptr)
		if c == 0 {
			break
		}
		buf = append(buf, c)
	}
	return syscall.UTF16ToString(buf)
}
