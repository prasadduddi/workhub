package main

// Updates: WorkHub asks GitHub for the latest release (at start-up, at most
// every few hours, and from "Check for updates") and, when you agree, replaces
// its own exe with the new one and restarts. Your data is in another folder
// and is not touched. Only the public release page is read; nothing is sent.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

const releasesAPI = "https://api.github.com/repos/prasadduddi/workhub/releases/latest"
const releasesPage = "https://github.com/prasadduddi/workhub/releases/latest"

type releaseInfo struct {
	Tag       string    `json:"tag_name"`
	Name      string    `json:"name"`
	Notes     string    `json:"body"`
	URL       string    `json:"html_url"`
	Published time.Time `json:"published_at"`
	Assets    []struct {
		Name string `json:"name"`
		URL  string `json:"browser_download_url"`
		Size int64  `json:"size"`
	} `json:"assets"`
}

var (
	updMu      sync.Mutex
	updCache   *releaseInfo
	updChecked time.Time
	updateURL  = releasesAPI // tests point this at a local server
	updPending string        // a version already installed, waiting for the next start
)

var updClient = &http.Client{Timeout: 60 * time.Second, Transport: &http.Transport{Proxy: http.ProxyFromEnvironment}}

func latestRelease(force bool) (*releaseInfo, error) {
	updMu.Lock()
	defer updMu.Unlock()
	if !force && updCache != nil && time.Since(updChecked) < 50*time.Minute { // checked hourly
		return updCache, nil
	}
	req, _ := http.NewRequest("GET", updateURL, nil)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "WorkHub/"+version)
	resp, err := updClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("couldn't reach GitHub (%v) — a company proxy may block it; open the releases page in your browser instead", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("GitHub answered %s", resp.Status)
	}
	var r releaseInfo
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil {
		return nil, err
	}
	updCache, updChecked = &r, time.Now()
	return &r, nil
}

var (
	reVer   = regexp.MustCompile(`^v(\d+)\.(\d+)(?:\.(\d+))?`)
	reStamp = regexp.MustCompile(`(\d{4}-\d{2}-\d{2}-\d{4})`)
)

func verParts(s string) []int {
	m := reVer.FindStringSubmatch(s)
	if m == nil {
		return nil
	}
	out := []int{}
	for _, p := range m[1:] {
		n, _ := strconv.Atoi(p)
		out = append(out, n)
	}
	return out
}

// isNewer: a release tag above our version, or, for builds without a version
// number (dated local builds), a release published more than an hour after
// this build. "dev" (run from source) never asks.
func isNewer(tag string, published time.Time, cur string) bool {
	if cur == "dev" || tag == "" {
		return false
	}
	if a, b := verParts(tag), verParts(cur); a != nil && b != nil {
		for i := range a {
			if a[i] != b[i] {
				return a[i] > b[i]
			}
		}
		return false
	}
	if m := reStamp.FindString(cur); m != "" {
		if built, err := time.ParseInLocation("2006-01-02-1504", m, time.Local); err == nil {
			return published.After(built.Add(time.Hour))
		}
	}
	return false
}

// exeName is the file to replace: WorkHub-web.exe or WorkHub-Desktop.exe.
func exeName() string {
	if isDesktop {
		return "WorkHub-Desktop.exe"
	}
	return "WorkHub-web.exe"
}

func (a *App) handleUpdateCheck(w http.ResponseWriter, r *http.Request) {
	rel, err := latestRelease(r.URL.Query().Get("force") == "1")
	if err != nil {
		writeJSON(w, map[string]any{"current": version, "error": err.Error(), "page": releasesPage})
		return
	}
	out := map[string]any{"current": version, "latest": rel.Tag, "name": rel.Name, "notes": rel.Notes,
		"published": rel.Published, "page": orDefault(rel.URL, releasesPage), "newer": isNewer(rel.Tag, rel.Published, version),
		"can_apply": runtime.GOOS == "windows", "pending": updPending, "downloaded": stagedTag(rel.Tag)}
	for _, as := range rel.Assets {
		if strings.EqualFold(as.Name, exeName()) {
			out["size"] = as.Size
		}
	}
	writeJSON(w, out)
}

// handleUpdateApply downloads the new exe next to the running one and swaps
// them (Windows lets a running exe be renamed, not overwritten). It then
// restarts, or with ?later=1 keeps running: the new version starts next time.
func (a *App) handleUpdateApply(w http.ResponseWriter, r *http.Request) {
	later := r.URL.Query().Get("later") == "1"
	if runtime.GOOS != "windows" {
		writeErr(w, 400, errors.New("automatic updating works on Windows — download the new version from the releases page"))
		return
	}
	rel, err := latestRelease(false)
	if err != nil {
		writeErr(w, 502, err)
		return
	}
	dl := ""
	for _, as := range rel.Assets {
		if strings.EqualFold(as.Name, exeName()) {
			dl = as.URL
		}
	}
	if dl == "" {
		writeErr(w, 404, fmt.Errorf("the release %s has no %s", rel.Tag, exeName()))
		return
	}
	exe, err := os.Executable()
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	if exe, err = filepath.EvalSymlinks(exe); err != nil {
		writeErr(w, 500, err)
		return
	}
	newPath, oldPath := exe+".new", exe+".old"
	if stagedTag(rel.Tag) != "" && os.Rename(exe+".next", newPath) == nil { // downloaded in the background already
		_ = os.Remove(exe + ".next.ver")
	} else if err := download(dl, newPath); err != nil {
		os.Remove(newPath)
		writeErr(w, 502, fmt.Errorf("download failed (%v) — get it from the releases page instead", err))
		return
	}
	_ = os.Remove(oldPath)
	if err := os.Rename(exe, oldPath); err != nil {
		os.Remove(newPath)
		writeErr(w, 500, fmt.Errorf("can't replace %s: %v", filepath.Base(exe), err))
		return
	}
	if err := os.Rename(newPath, exe); err != nil {
		_ = os.Rename(oldPath, exe) // put the old one back
		writeErr(w, 500, err)
		return
	}
	if later {
		updPending = rel.Tag
		writeJSON(w, map[string]string{"ok": "next-start", "version": rel.Tag})
		return
	}
	writeJSON(w, map[string]string{"ok": "restarting", "version": rel.Tag})
	a.restartAs(exe)
}

// handleUpdateRestart restarts now to finish an update installed for the next start.
func (a *App) handleUpdateRestart(w http.ResponseWriter, r *http.Request) {
	if updPending == "" {
		writeErr(w, 400, errors.New("no update is waiting"))
		return
	}
	exe, err := os.Executable()
	if err == nil {
		exe, err = filepath.EvalSymlinks(exe)
	}
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, map[string]string{"ok": "restarting", "version": updPending})
	a.restartAs(exe)
}

// restartAs saves everything and starts exe (the updated file) in our place.
func (a *App) restartAs(exe string) {
	go func() {
		time.Sleep(500 * time.Millisecond)
		if a.store != nil {
			a.store.Flush()
		}
		_ = os.Remove(filepath.Join(a.dataDir, "session.token"))
		cmd := exec.Command(exe, os.Args[1:]...)
		cmd.Env = append(os.Environ(), "WORKHUB_RESTART=1")
		if err := cmd.Start(); err != nil {
			fmt.Println("Restart failed, please start WorkHub again:", err)
		}
		os.Exit(0)
	}()
}

// download saves url to path, checking it is a Windows program.
func download(url, path string) error {
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", "WorkHub/"+version)
	resp, err := (&http.Client{Timeout: 10 * time.Minute, Transport: updClient.Transport}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("GitHub answered %s", resp.Status)
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	n, err := io.Copy(f, resp.Body)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	head := make([]byte, 2)
	if g, err := os.Open(path); err == nil {
		io.ReadFull(g, head)
		g.Close()
	}
	if n < 1<<20 || string(head) != "MZ" {
		return errors.New("the downloaded file is not a Windows program")
	}
	return nil
}

// cleanOldExe removes the copy left by the last update.
func cleanOldExe() {
	if exe, err := os.Executable(); err == nil {
		_ = os.Remove(exe + ".old")
	}
}

// ---- background download ----

var canSelfUpdate = runtime.GOOS == "windows" // tests switch it on
//
// A newer release is downloaded quietly next to the running exe
// (WorkHub-Desktop.exe.next, with its version in .next.ver) but not
// installed: nothing changes until you choose Install, which then only has to
// swap the files. Switched off with Settings → "Download updates in the background".

func stagedPaths() (bin, ver string) {
	exe, err := os.Executable()
	if err != nil {
		return "", ""
	}
	if e, err := filepath.EvalSymlinks(exe); err == nil {
		exe = e
	}
	return exe + ".next", exe + ".next.ver"
}

// stagedTag returns tag when that version is downloaded and waiting.
func stagedTag(tag string) string {
	bin, ver := stagedPaths()
	if bin == "" || tag == "" {
		return ""
	}
	b, err := os.ReadFile(ver)
	if err != nil || strings.TrimSpace(string(b)) != tag {
		return ""
	}
	if st, err := os.Stat(bin); err != nil || st.Size() < 1<<20 {
		return ""
	}
	return tag
}

// fetchUpdate downloads the latest release if it is newer and not there yet.
func (a *App) fetchUpdate() {
	if !canSelfUpdate || a.store.Settings().NoUpdateFetch {
		return
	}
	rel, err := latestRelease(false)
	if err != nil || !isNewer(rel.Tag, rel.Published, version) || rel.Tag == updPending || stagedTag(rel.Tag) != "" {
		return
	}
	dl := ""
	for _, as := range rel.Assets {
		if strings.EqualFold(as.Name, exeName()) {
			dl = as.URL
		}
	}
	bin, ver := stagedPaths()
	if dl == "" || bin == "" {
		return
	}
	_ = os.Remove(ver) // the old .next is no longer valid while the new one downloads
	part := bin + ".part"
	if err := download(dl, part); err != nil {
		os.Remove(part)
		log.Println("update download:", err)
		return
	}
	if err := os.Rename(part, bin); err != nil {
		os.Remove(part)
		return
	}
	_ = os.WriteFile(ver, []byte(rel.Tag), 0o644)
	log.Println("update", rel.Tag, "downloaded; installs when you choose")
}

// watchUpdates checks shortly after start and then every hour. A
// downloaded version that is not newer than this one (installed some other
// way) is removed.
func (a *App) watchUpdates() {
	if bin, ver := stagedPaths(); bin != "" {
		if b, err := os.ReadFile(ver); err != nil || !isNewer(strings.TrimSpace(string(b)), time.Now(), version) {
			_ = os.Remove(bin)
			_ = os.Remove(ver)
		}
	}
	time.Sleep(45 * time.Second)
	for {
		a.fetchUpdate()
		time.Sleep(time.Hour)
	}
}
