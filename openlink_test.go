package main

import (
	"runtime"
	"strings"
	"testing"
)

func TestFindBrowser(t *testing.T) {
	if findBrowser("netscape") != "" {
		t.Fatal("unknown browsers must not be found")
	}
	t.Logf("chrome: %q, edge: %q", findBrowser("chrome"), findBrowser("edge"))
}

func TestBrowserCmd(t *testing.T) {
	tab, win := browserCmd("chrome.exe", "https://x", false), browserCmd("chrome.exe", "https://x", true)
	if runtime.GOOS == "darwin" {
		if win[len(win)-2] != "--new-window" || tab[len(tab)-1] != "https://x" {
			t.Fatal(tab, win)
		}
		return
	}
	if strings.Join(tab, " ") != "chrome.exe -- https://x" || strings.Join(win, " ") != "chrome.exe --new-window -- https://x" {
		t.Fatal(tab, win)
	}
}
