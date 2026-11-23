package main

import (
	"encoding/base64"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unicode/utf16"
)

func psQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

// makeShortcut writes a .lnk with Windows' own shortcut maker (PowerShell,
// no admin needed), with WorkHub's icon.
func makeShortcut(lnk, target, args, workDir string) error {
	if err := os.MkdirAll(filepath.Dir(lnk), 0o755); err != nil {
		return err
	}
	script := "$s = (New-Object -ComObject WScript.Shell).CreateShortcut(" + psQuote(lnk) + "); " +
		"$s.TargetPath = " + psQuote(target) + "; $s.Arguments = " + psQuote(args) + "; " +
		"$s.WorkingDirectory = " + psQuote(workDir) + "; $s.IconLocation = " + psQuote(target+",0") + "; " +
		"$s.Description = 'WorkHub'; $s.Save()"
	u := utf16.Encode([]rune(script))
	b := make([]byte, len(u)*2)
	for i, c := range u {
		b[2*i], b[2*i+1] = byte(c), byte(c>>8)
	}
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", base64.StdEncoding.EncodeToString(b))
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
	if out, err := cmd.CombinedOutput(); err != nil {
		return &shortcutErr{err, strings.TrimSpace(string(out))}
	}
	return nil
}

type shortcutErr struct {
	err error
	out string
}

func (e *shortcutErr) Error() string {
	if e.out != "" {
		return e.out
	}
	return e.err.Error()
}

// desktopDir is the user's Desktop (OneDrive may have moved it there).
func desktopDir() string {
	if od := os.Getenv("OneDrive"); od != "" {
		if st, err := os.Stat(filepath.Join(od, "Desktop")); err == nil && st.IsDir() {
			return filepath.Join(od, "Desktop")
		}
	}
	return filepath.Join(os.Getenv("USERPROFILE"), "Desktop")
}
