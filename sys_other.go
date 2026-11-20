//go:build !windows

package main

import (
	"errors"
	"os/exec"
	"runtime"
	"strings"
)

func clipboardSeq() uint32 { return 0 }

func readClipboard() (string, error) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("pbpaste")
	default:
		if _, err := exec.LookPath("xclip"); err == nil {
			cmd = exec.Command("xclip", "-o", "-selection", "clipboard")
		} else if _, err := exec.LookPath("xsel"); err == nil {
			cmd = exec.Command("xsel", "-ob")
		} else {
			return "", errors.New("no clipboard tool (install xclip)")
		}
	}
	out, err := cmd.Output()
	return string(out), err
}

// Outside Windows there is no DPAPI; the key file relies on 0600 permissions.
func protectKey(b []byte) ([]byte, error)   { return b, nil }
func unprotectKey(b []byte) ([]byte, error) { return b, nil }

func openBrowser(url string) {
	if runtime.GOOS == "darwin" {
		_ = exec.Command("open", url).Start()
	} else {
		_ = exec.Command("xdg-open", url).Start()
	}
}

func localRoots() []string { return []string{"/"} }

func pickFolder(start string) (string, bool, error) {
	if runtime.GOOS != "darwin" {
		return "", false, errors.New("folder picker not available here; type the path")
	}
	script := `POSIX path of (choose folder with prompt "Choose a folder")`
	if start != "" {
		script = `POSIX path of (choose folder with prompt "Choose a folder" default location (POSIX file "` + strings.ReplaceAll(start, `"`, ``) + `"))`
	}
	out, err := exec.Command("osascript", "-e", script).Output()
	if err != nil {
		return "", false, nil // cancelled
	}
	return strings.TrimRight(strings.TrimSpace(string(out)), "/"), true, nil
}

func pickFile(startDir string) (string, bool, error) {
	if runtime.GOOS != "darwin" {
		return "", false, errors.New("file picker not available here; type the path")
	}
	script := `POSIX path of (choose file with prompt "Open file")`
	if startDir != "" {
		script = `POSIX path of (choose file with prompt "Open file" default location (POSIX file "` + strings.ReplaceAll(startDir, `"`, ``) + `"))`
	}
	out, err := exec.Command("osascript", "-e", script).Output()
	if err != nil {
		return "", false, nil // cancelled
	}
	return strings.TrimSpace(string(out)), true, nil
}
