//go:build windows

package main

import (
	"errors"
	"os"
	"os/exec"
	"runtime"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"
)

var (
	user32   = syscall.NewLazyDLL("user32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
	crypt32  = syscall.NewLazyDLL("crypt32.dll")

	pOpenClipboard              = user32.NewProc("OpenClipboard")
	pCloseClipboard             = user32.NewProc("CloseClipboard")
	pGetClipboardData           = user32.NewProc("GetClipboardData")
	pIsClipboardFormatAvailable = user32.NewProc("IsClipboardFormatAvailable")
	pGetClipboardSequenceNumber = user32.NewProc("GetClipboardSequenceNumber")
	pRegisterClipboardFormat    = user32.NewProc("RegisterClipboardFormatW")
	pGlobalLock                 = kernel32.NewProc("GlobalLock")
	pGlobalUnlock               = kernel32.NewProc("GlobalUnlock")
	pLocalFree                  = kernel32.NewProc("LocalFree")
	pCryptProtectData           = crypt32.NewProc("CryptProtectData")
	pCryptUnprotectData         = crypt32.NewProc("CryptUnprotectData")

	shell32              = syscall.NewLazyDLL("shell32.dll")
	ole32                = syscall.NewLazyDLL("ole32.dll")
	pSHBrowseForFolder   = shell32.NewProc("SHBrowseForFolderW")
	pSHGetPathFromIDList = shell32.NewProc("SHGetPathFromIDListW")
	pCoInitializeEx      = ole32.NewProc("CoInitializeEx")
	pCoUninitialize      = ole32.NewProc("CoUninitialize")
	pCoTaskMemFree       = ole32.NewProc("CoTaskMemFree")
	pSendMessage         = user32.NewProc("SendMessageW")
	pGetForegroundWindow = user32.NewProc("GetForegroundWindow")
)

const cfUnicodeText = 13

// Password managers (KeePass, 1Password, ...) tag secrets with this format to
// ask clipboard monitors to leave them alone.
var excludeFormat = func() uintptr {
	name, _ := syscall.UTF16PtrFromString("ExcludeClipboardContentFromMonitorProcessing")
	r, _, _ := pRegisterClipboardFormat.Call(uintptr(unsafe.Pointer(name)))
	return r
}()

func clipboardSeq() uint32 {
	r, _, _ := pGetClipboardSequenceNumber.Call()
	return uint32(r)
}

func readClipboard() (string, error) {
	if r, _, _ := pIsClipboardFormatAvailable.Call(cfUnicodeText); r == 0 {
		return "", nil
	}
	if excludeFormat != 0 {
		if r, _, _ := pIsClipboardFormatAvailable.Call(excludeFormat); r != 0 {
			return "", nil
		}
	}
	opened := false
	for i := 0; i < 10 && !opened; i++ {
		if r, _, _ := pOpenClipboard.Call(0); r != 0 {
			opened = true
		} else {
			time.Sleep(30 * time.Millisecond)
		}
	}
	if !opened {
		return "", errors.New("clipboard busy")
	}
	defer pCloseClipboard.Call()
	h, _, _ := pGetClipboardData.Call(cfUnicodeText)
	if h == 0 {
		return "", errors.New("no clipboard text")
	}
	p, _, _ := pGlobalLock.Call(h)
	if p == 0 {
		return "", errors.New("cannot lock clipboard")
	}
	defer pGlobalUnlock.Call(h)
	var buf []uint16
	for i := uintptr(0); len(buf) < 1<<20; i += 2 {
		c := *(*uint16)(unsafe.Pointer(p + i))
		if c == 0 {
			break
		}
		buf = append(buf, c)
	}
	return string(utf16.Decode(buf)), nil
}

type dataBlob struct {
	cbData uint32
	pbData *byte
}

const cryptprotectUIForbidden = 0x1

// protectKey encrypts the data key with DPAPI for the current Windows user.
func protectKey(b []byte) ([]byte, error) {
	in := dataBlob{cbData: uint32(len(b)), pbData: &b[0]}
	var out dataBlob
	r, _, err := pCryptProtectData.Call(uintptr(unsafe.Pointer(&in)), 0, 0, 0, 0, cryptprotectUIForbidden, uintptr(unsafe.Pointer(&out)))
	if r == 0 {
		return nil, err
	}
	defer pLocalFree.Call(uintptr(unsafe.Pointer(out.pbData)))
	return append([]byte(nil), unsafe.Slice(out.pbData, out.cbData)...), nil
}

func unprotectKey(b []byte) ([]byte, error) {
	if len(b) == 0 {
		return nil, errors.New("empty key file")
	}
	in := dataBlob{cbData: uint32(len(b)), pbData: &b[0]}
	var out dataBlob
	r, _, err := pCryptUnprotectData.Call(uintptr(unsafe.Pointer(&in)), 0, 0, 0, 0, cryptprotectUIForbidden, uintptr(unsafe.Pointer(&out)))
	if r == 0 {
		return nil, err
	}
	defer pLocalFree.Call(uintptr(unsafe.Pointer(out.pbData)))
	return append([]byte(nil), unsafe.Slice(out.pbData, out.cbData)...), nil
}

func openBrowser(url string) {
	_ = exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
}

// localRoots lists drive letters for the file browser's top level.
func localRoots() []string {
	var out []string
	for c := 'A'; c <= 'Z'; c++ {
		d := string(c) + `:\`
		if _, err := os.Stat(d); err == nil {
			out = append(out, d)
		}
	}
	return out
}

type browseInfo struct {
	hwndOwner      uintptr
	pidlRoot       uintptr
	pszDisplayName *uint16
	lpszTitle      *uint16
	ulFlags        uint32
	lpfn           uintptr
	lParam         uintptr
	iImage         int32
}

const (
	bifReturnOnlyFSDirs = 0x0001
	bifEditBox          = 0x0010
	bifNewDialogStyle   = 0x0040
	bffmInitialized     = 1
	bffmSetSelectionW   = 0x0467
)

// browseCallback preselects the start folder when the dialog opens.
// Created once: Windows callbacks made by syscall.NewCallback are never freed.
var browseCallback = syscall.NewCallback(func(hwnd, msg, lp, data uintptr) uintptr {
	if msg == bffmInitialized && data != 0 {
		pSendMessage.Call(hwnd, bffmSetSelectionW, 1, data)
	}
	return 0
})

// pickFolder shows the Windows "Browse for Folder" dialog. ok is false if
// the user cancelled.
func pickFolder(start string) (path string, ok bool, err error) {
	done := make(chan struct{})
	go func() {
		defer close(done)
		runtime.LockOSThread() // COM and the dialog need one fixed thread
		defer runtime.UnlockOSThread()
		pCoInitializeEx.Call(0, 2) // COINIT_APARTMENTTHREADED
		defer pCoUninitialize.Call()

		title, _ := syscall.UTF16PtrFromString("Choose a folder")
		var startPtr *uint16
		if start != "" {
			startPtr, _ = syscall.UTF16PtrFromString(start)
		}
		display := make([]uint16, syscall.MAX_PATH)
		owner, _, _ := pGetForegroundWindow.Call()
		bi := browseInfo{
			hwndOwner:      owner,
			pszDisplayName: &display[0],
			lpszTitle:      title,
			ulFlags:        bifReturnOnlyFSDirs | bifNewDialogStyle | bifEditBox,
			lpfn:           browseCallback,
			lParam:         uintptr(unsafe.Pointer(startPtr)),
		}
		pidl, _, _ := pSHBrowseForFolder.Call(uintptr(unsafe.Pointer(&bi)))
		runtime.KeepAlive(startPtr)
		if pidl == 0 {
			return
		}
		defer pCoTaskMemFree.Call(pidl)
		buf := make([]uint16, 1024)
		if r, _, _ := pSHGetPathFromIDList.Call(pidl, uintptr(unsafe.Pointer(&buf[0]))); r == 0 {
			err = errors.New("that location is not a normal folder")
			return
		}
		path, ok = syscall.UTF16ToString(buf), true
	}()
	<-done
	return
}

type openFileName struct {
	lStructSize       uint32
	hwndOwner         uintptr
	hInstance         uintptr
	lpstrFilter       *uint16
	lpstrCustomFilter *uint16
	nMaxCustFilter    uint32
	nFilterIndex      uint32
	lpstrFile         *uint16
	nMaxFile          uint32
	lpstrFileTitle    *uint16
	nMaxFileTitle     uint32
	lpstrInitialDir   *uint16
	lpstrTitle        *uint16
	flags             uint32
	nFileOffset       uint16
	nFileExtension    uint16
	lpstrDefExt       *uint16
	lCustData         uintptr
	lpfnHook          uintptr
	lpTemplateName    *uint16
	pvReserved        uintptr
	dwReserved        uint32
	flagsEx           uint32
}

// pickFile shows the Windows "Open" dialog. ok is false if cancelled.
func pickFile(startDir string) (path string, ok bool, err error) {
	done := make(chan struct{})
	go func() {
		defer close(done)
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		pCoInitializeEx.Call(0, 2)
		defer pCoUninitialize.Call()
		// Filter pairs are NUL-separated and end with a double NUL.
		filter := utf16.Encode([]rune("All files\x00*.*\x00Text and logs\x00*.txt;*.log;*.out\x00Scripts and SQL\x00*.sql;*.sh;*.ps1;*.bat;*.cmd;*.py\x00Config\x00*.properties;*.conf;*.cfg;*.ini;*.xml;*.yml;*.yaml;*.json\x00\x00"))
		buf := make([]uint16, 4096)
		title, _ := syscall.UTF16PtrFromString("Open file")
		var dir *uint16
		if startDir != "" {
			dir, _ = syscall.UTF16PtrFromString(startDir)
		}
		owner, _, _ := pGetForegroundWindow.Call()
		ofn := openFileName{hwndOwner: owner, lpstrFilter: &filter[0], nFilterIndex: 1, lpstrFile: &buf[0], nMaxFile: uint32(len(buf)),
			lpstrInitialDir: dir, lpstrTitle: title, flags: 0x1000 | 0x800 | 0x80000 | 0x8} // FILEMUSTEXIST|PATHMUSTEXIST|EXPLORER|NOCHANGEDIR
		ofn.lStructSize = uint32(unsafe.Sizeof(ofn))
		r, _, _ := pGetOpenFileName.Call(uintptr(unsafe.Pointer(&ofn)))
		runtime.KeepAlive(filter)
		runtime.KeepAlive(dir)
		if r == 0 {
			return // cancelled
		}
		path, ok = syscall.UTF16ToString(buf), true
	}()
	<-done
	return
}

var (
	comdlg32         = syscall.NewLazyDLL("comdlg32.dll")
	pGetOpenFileName = comdlg32.NewProc("GetOpenFileNameW")
)
