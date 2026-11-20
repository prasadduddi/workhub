package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

// openLink opens a web link from the desktop version in the user's chosen
// browser (Settings.LinkBrowser: "chrome" by default, "edge" or "default"),
// as a new tab. Falls back to the default browser if that one isn't found.
func (a *App) openLink(url string) {
	choice := "chrome"
	if a.store != nil {
		choice = orDefault(a.store.Settings().LinkBrowser, "chrome")
	}
	if choice != "default" {
		if exe := findBrowser(choice); exe != "" {
			if runtime.GOOS == "darwin" {
				if exec.Command("open", "-a", exe, url).Start() == nil {
					return
				}
			} else if exec.Command(exe, url).Start() == nil {
				// Only the URL, no --new-window or profile flags: an already
				// running Chrome/Edge takes it over and opens a new tab in its
				// last active window instead of starting another instance.
				return
			}
		}
	}
	openBrowser(url)
}

func findBrowser(name string) string {
	switch runtime.GOOS {
	case "windows":
		var rel []string
		switch name {
		case "chrome":
			rel = []string{`Google\Chrome\Application\chrome.exe`}
		case "edge":
			rel = []string{`Microsoft\Edge\Application\msedge.exe`}
		default:
			return ""
		}
		// Per-user installs (no admin) live under LOCALAPPDATA.
		for _, base := range []string{os.Getenv("LOCALAPPDATA"), os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)")} {
			for _, r := range rel {
				if p := filepath.Join(base, r); base != "" && fileExists(p) {
					return p
				}
			}
		}
		if p := registryAppPath(map[string]string{"chrome": "chrome.exe", "edge": "msedge.exe"}[name]); p != "" {
			return p
		}
	case "darwin":
		app := map[string]string{"chrome": "Google Chrome", "edge": "Microsoft Edge"}[name]
		if app != "" && (fileExists("/Applications/"+app+".app") || fileExists(filepath.Join(os.Getenv("HOME"), "Applications", app+".app"))) {
			return app
		}
	default:
		for _, n := range map[string][]string{"chrome": {"google-chrome", "chromium"}, "edge": {"microsoft-edge"}}[name] {
			if p, err := exec.LookPath(n); err == nil {
				return p
			}
		}
	}
	return ""
}
