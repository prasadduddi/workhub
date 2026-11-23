package main

// "Install for easy access" (⚙ Settings): copies WorkHub into the user's own
// programs folder (%LOCALAPPDATA%\Programs\WorkHub — no admin, out of the way
// of Downloads clean-ups and accidental deletes), adds it to the Start menu
// and, if wanted, to the Desktop and to start with Windows, then restarts
// from there and removes the old copy. The data folder is not touched.

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

func installDir() string { return filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "WorkHub") }
func startMenuDir() string {
	return filepath.Join(os.Getenv("APPDATA"), "Microsoft", "Windows", "Start Menu", "Programs")
}

// shortcutName: "WorkHub", or "WorkHub - ClientB" for a named workspace.
func (a *App) shortcutName() string {
	if a.workspace != "" {
		return "WorkHub - " + a.workspace + ".lnk"
	}
	return "WorkHub.lnk"
}

func (a *App) shortcutPaths() map[string]string {
	return map[string]string{
		"start_menu": filepath.Join(startMenuDir(), a.shortcutName()),
		"startup":    filepath.Join(startMenuDir(), "Startup", a.shortcutName()),
		"desktop":    filepath.Join(desktopDir(), a.shortcutName()),
	}
}

func currentExe() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	if p, err := filepath.EvalSymlinks(exe); err == nil {
		exe = p
	}
	return exe
}

func samePath(a, b string) bool {
	return strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
}

func (a *App) handleInstallGet(w http.ResponseWriter, r *http.Request) {
	exe := currentExe()
	out := map[string]any{"supported": runtime.GOOS == "windows", "exe": exe, "target": installDir(),
		"installed": samePath(filepath.Dir(exe), installDir())}
	for k, p := range a.shortcutPaths() {
		out[k] = fileExists(p)
	}
	writeJSON(w, out)
}

// handleInstall copies the exe (and its twin, web/desktop) into installDir,
// creates or removes the shortcuts, and restarts from there if it moved.
func (a *App) handleInstall(w http.ResponseWriter, r *http.Request) {
	if runtime.GOOS != "windows" {
		writeErr(w, 400, errors.New("installing works on Windows"))
		return
	}
	var in struct {
		Desktop, Startup, RemoveOld bool
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	exe := currentExe()
	if exe == "" {
		writeErr(w, 500, errors.New("can't tell where WorkHub is running from"))
		return
	}
	dir, target := installDir(), filepath.Join(installDir(), filepath.Base(exe))
	moved := !samePath(filepath.Dir(exe), dir)
	if moved {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			writeErr(w, 500, err)
			return
		}
		names := map[string]bool{filepath.Base(exe): true, "WorkHub-web.exe": true, "WorkHub-Desktop.exe": true} // its twin too, if beside it
		for name := range names {
			src, dst := filepath.Join(filepath.Dir(exe), name), filepath.Join(dir, name)
			if !fileExists(src) {
				continue
			}
			if err := copyFile(src, dst+".new"); err != nil {
				writeErr(w, 500, fmt.Errorf("can't copy %s: %v", name, err))
				return
			}
			_ = os.Remove(dst + ".old")
			if fileExists(dst) {
				_ = os.Rename(dst, dst+".old") // an older copy that may be running: renaming is allowed
			}
			if err := os.Rename(dst+".new", dst); err != nil {
				writeErr(w, 500, err)
				return
			}
		}
	}
	args := ""
	if a.workspace != "" {
		args = fmt.Sprintf("-workspace %q", a.workspace)
	}
	sc := a.shortcutPaths()
	want := map[string]bool{"start_menu": true, "desktop": in.Desktop, "startup": in.Startup}
	for k, p := range sc {
		if want[k] {
			if err := makeShortcut(p, target, args, dir); err != nil {
				writeErr(w, 500, fmt.Errorf("couldn't make the %s shortcut: %v", strings.ReplaceAll(k, "_", " "), err))
				return
			}
		} else {
			_ = os.Remove(p)
		}
	}
	writeJSON(w, map[string]any{"target": target, "moved": moved})
	if moved {
		if in.RemoveOld {
			os.Setenv("WORKHUB_REMOVE_OLD", exe)
		}
		a.restartAs(target)
	}
}

// removeOldCopy deletes the exe WorkHub was installed from, once that copy
// has stopped (called at start-up after "Install for easy access").
func removeOldCopy() {
	old := os.Getenv("WORKHUB_REMOVE_OLD")
	if old == "" || samePath(old, currentExe()) {
		return
	}
	os.Unsetenv("WORKHUB_REMOVE_OLD")
	go func() {
		for i := 0; i < 20; i++ {
			time.Sleep(time.Second)
			if err := os.Remove(old); err == nil || errors.Is(err, os.ErrNotExist) {
				return
			}
		}
	}()
}
