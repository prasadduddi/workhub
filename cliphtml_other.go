//go:build !windows

package main

import (
	"encoding/hex"
	"os/exec"
	"runtime"
	"strings"
)

// readClipboardHTML: the clipboard's HTML on a Mac (osascript); nothing elsewhere.
func readClipboardHTML() (string, error) {
	if runtime.GOOS != "darwin" {
		return "", nil
	}
	out, err := exec.Command("osascript", "-e", "try", "-e", "the clipboard as «class HTML»", "-e", "end try").Output()
	if err != nil {
		return "", nil
	}
	s := strings.TrimSpace(string(out)) // «data HTML3C6D6574…»
	if i := strings.Index(s, "«data HTML"); i >= 0 {
		b, err := hex.DecodeString(strings.TrimSuffix(s[i+len("«data HTML"):], "»"))
		if err == nil {
			return string(b), nil
		}
	}
	return "", nil
}
