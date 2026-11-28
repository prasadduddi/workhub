package main

// "Open in Terminal" on macOS: PuTTY is Windows-only, so on a Mac a saved SSH
// connection opens in the Mac's own Terminal app running the built-in ssh.
// ssh can't be given a password on its command line, so the page copies it
// and the user pastes it (⌘V) when ssh asks.

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

// sshArgs: ssh -p port -l user [-i key] [-L …] host (the same details PuTTY gets).
func sshArgs(e Entry) []string {
	port := e.Port
	if port == 0 || (e.Protocol != "" && e.Protocol != "ssh" && e.Protocol != "sftp" && e.Protocol != "scp") {
		port = 22
	}
	args := []string{"ssh", "-p", strconv.Itoa(port)}
	if e.Username != "" {
		args = append(args, "-l", e.Username)
	}
	if e.KeyFile != "" && !strings.EqualFold(filepath.Ext(e.KeyFile), ".ppk") { // ssh can't read PuTTY's key format
		args = append(args, "-i", e.KeyFile)
	}
	if e.Extra["tunnels_off"] != "1" {
		fw, _ := parseForwards(e.Extra["tunnels"])
		for _, f := range fw {
			args = append(args, "-L", fmt.Sprintf("%d:%s:%d", f.Local, f.Host, f.Port))
		}
	}
	return append(args, e.Host)
}

// terminalScript is a .command file Terminal runs: it deletes itself first
// (it holds no password, but needn't stay around), then becomes ssh.
func terminalScript(args []string) string {
	q := make([]string, len(args))
	for i, a := range args {
		q[i] = shQuote(a)
	}
	return "#!/bin/sh\nrm -f \"$0\"; rmdir \"$(dirname \"$0\")\" 2>/dev/null\nclear\nexec " + strings.Join(q, " ") + "\n"
}

// startProgram is swapped by tests so nothing really opens.
var startProgram = func(c *exec.Cmd) error {
	if err := c.Start(); err != nil {
		return err
	}
	go c.Wait()
	return nil
}

// openInMacTerminal opens Terminal with ssh to e. A .command file is used
// (not AppleScript) so macOS doesn't ask for permission to control Terminal.
func openInMacTerminal(e Entry) error {
	if runtime.GOOS != "darwin" && !testMacTerminal {
		return errors.New("Terminal is only on macOS — use PuTTY on Windows")
	}
	if e.Host == "" {
		return errors.New("this connection has no host")
	}
	dir, err := os.MkdirTemp("", "workhub-ssh-")
	if err != nil {
		return err
	}
	p := filepath.Join(dir, "ssh-"+safeFileName(orDefault(e.Name, e.Host))+".command")
	if err := os.WriteFile(p, []byte(terminalScript(sshArgs(e))), 0o700); err != nil {
		return err
	}
	return startProgram(exec.Command("open", "-a", "Terminal", p))
}

var testMacTerminal = false // tests run the macOS path on any system

// safeFileName keeps letters, digits, dot, dash and underscore.
func safeFileName(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r < 128 && (r == '.' || r == '-' || r == '_' || r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z') {
			b.WriteRune(r)
		} else {
			b.WriteByte('_')
		}
	}
	if b.Len() > 40 {
		return b.String()[:40]
	}
	return b.String()
}
