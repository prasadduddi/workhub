package main

// "Open in…": opens a saved connection in the real PuTTY, DBeaver or SQL
// Developer. Their locations are found automatically (running copy, App Paths,
// usual install and unzip folders) or set by the user; the choice is shared by
// all workspaces and kept next to the default data folder.

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

type extTool struct {
	Key, Name, Exe string
	Rel            []string // usual places under the base folders
	Mac            string   // the program inside its macOS app, under /Applications ("" = none on a Mac)
}

var extTools = []extTool{
	{"putty", "PuTTY", "putty.exe", []string{`PuTTY\putty.exe`, `putty\putty.exe`}, ""}, // a Mac uses Terminal (macterm.go)
	{"dbeaver", "DBeaver", "dbeaver.exe", []string{`DBeaver\dbeaver.exe`, `dbeaver\dbeaver.exe`}, "DBeaver.app/Contents/MacOS/dbeaver"},
	{"filezilla", "FileZilla", "filezilla.exe", []string{`FileZilla FTP Client\filezilla.exe`, `FileZilla\filezilla.exe`}, "FileZilla.app/Contents/MacOS/filezilla"},
	{"sqldev", "SQL Developer", "sqldeveloper.exe", []string{`sqldeveloper\sqldeveloper.exe`}, "SQLDeveloper.app/Contents/MacOS/sqldeveloper.sh"},
}

func extToolByKey(k string) (extTool, bool) {
	for _, t := range extTools {
		if t.Key == k {
			return t, true
		}
	}
	return extTool{}, false
}

func toolsFile() string {
	return filepath.Join(filepath.Dir(defaultDataDir()), "external-programs.json")
}

func toolPaths() map[string]string {
	m := map[string]string{}
	if b, err := os.ReadFile(toolsFile()); err == nil {
		_ = json.Unmarshal(b, &m)
	}
	return m
}

// findTool: the location the user set, else a running copy, else the usual
// folders (per-user installs and unzipped portable copies need no admin).
func findTool(t extTool) string {
	if p := toolPaths()[t.Key]; p != "" && fileExists(p) {
		return p
	}
	if p := macApp(t); p != "" {
		return p
	}
	if p := runningExe(t.Exe); p != "" {
		return p
	}
	if p := registryAppPath(t.Exe); p != "" {
		return p
	}
	if p, err := exec.LookPath(t.Exe); err == nil {
		return p
	}
	var bases []string
	if l := os.Getenv("LOCALAPPDATA"); l != "" {
		bases = append(bases, l, filepath.Join(l, "Programs"))
	}
	bases = append(bases, os.Getenv("ProgramW6432"), os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)"))
	if home := os.Getenv("USERPROFILE"); home != "" {
		for _, d := range []string{"", "Downloads", "Desktop", "Documents", "Tools"} {
			bases = append(bases, filepath.Join(home, d))
		}
	}
	if runtime.GOOS == "windows" {
		bases = append(bases, `C:\Tools`, `C:\`)
	}
	for _, base := range bases {
		if base == "" {
			continue
		}
		cands := []string{filepath.Join(base, t.Exe)}
		for _, r := range t.Rel {
			cands = append(cands, filepath.Join(base, r))
			// unzipped with the version in the folder name, e.g. sqldeveloper-23.1\sqldeveloper\…
			if m, _ := filepath.Glob(filepath.Join(base, "*", r)); len(m) > 0 {
				cands = append(cands, m...)
			}
		}
		if m, _ := filepath.Glob(filepath.Join(base, "*", t.Exe)); len(m) > 0 {
			cands = append(cands, m...)
		}
		for _, c := range cands {
			if fileExists(c) {
				return c
			}
		}
	}
	return ""
}

// macApp: on a Mac, the program inside its app in /Applications or ~/Applications.
func macApp(t extTool) string {
	if runtime.GOOS != "darwin" || t.Mac == "" {
		return ""
	}
	home, _ := os.UserHomeDir()
	for _, d := range []string{macAppsDir, filepath.Join(home, "Applications")} {
		if p := filepath.Join(d, t.Mac); fileExists(p) {
			return p
		}
	}
	return ""
}

var macAppsDir = "/Applications" // tests point it elsewhere

// puttyArgs: putty.exe -ssh -P port -l user -pw pass [-i key.ppk] [-L …] host
func puttyArgs(e Entry) []string {
	port := e.Port
	if port == 0 || (e.Protocol != "" && e.Protocol != "ssh" && e.Protocol != "sftp" && e.Protocol != "scp") {
		port = 22
	}
	args := []string{"-ssh", "-P", strconv.Itoa(port)}
	if e.Username != "" {
		args = append(args, "-l", e.Username)
	}
	if e.Password != "" {
		args = append(args, "-pw", e.Password)
	}
	if strings.EqualFold(filepath.Ext(e.KeyFile), ".ppk") { // PuTTY reads only its own key format
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

// filezillaArgs: filezilla.exe sftp://user:pass@host:port (FileZilla connects
// to a URL given on its command line).
func filezillaArgs(e Entry) []string {
	scheme, port := "sftp", e.Port
	switch e.Protocol {
	case "ftp", "ftps":
		scheme = e.Protocol
	default:
		if port == 0 || (e.Protocol != "" && e.Protocol != "ssh" && e.Protocol != "sftp" && e.Protocol != "scp") {
			port = 22
		}
	}
	u := &url.URL{Scheme: scheme, Host: e.Host}
	if port != 0 {
		u.Host = fmt.Sprintf("%s:%d", e.Host, port)
	}
	if e.Username != "" {
		u.User = url.UserPassword(e.Username, e.Password)
		if e.Password == "" {
			u.User = url.User(e.Username)
		}
	}
	if e.LastDir != "" {
		u.Path = e.LastDir
	}
	return []string{u.String()}
}

// dbeaverArgs: dbeaver.exe -con "driver=…|host=…|…|connect=true" (DBeaver's
// command line; a running DBeaver opens it in the same window).
func dbeaverArgs(e Entry) ([]string, error) {
	db, sid := dbName(e)
	port := dbPort(e)
	parts := []string{}
	switch dbKind(e) {
	case "postgres":
		parts = append(parts, "driver=postgresql", "host="+e.Host, "port="+strconv.Itoa(port))
		if db != "" {
			parts = append(parts, "database="+db)
		}
	case "oracle":
		url := fmt.Sprintf("jdbc:oracle:thin:@//%s:%d/%s", e.Host, port, db)
		if sid {
			url = fmt.Sprintf("jdbc:oracle:thin:@%s:%d:%s", e.Host, port, db)
		}
		parts = append(parts, "driver=oracle_thin", "url="+url)
	default:
		return nil, errors.New("not a database connection")
	}
	if strings.Contains(e.Username+e.Password, "|") {
		return nil, errors.New(`DBeaver can't take a user or password containing "|" on its command line — copy it and connect by hand`)
	}
	if e.Username != "" {
		parts = append(parts, "user="+e.Username)
	}
	if e.Password != "" {
		parts = append(parts, "password="+e.Password, "savePassword=true")
	}
	name := strings.ReplaceAll(orDefault(e.Name, e.Host), "|", "/")
	parts = append(parts, "name="+name, "save=false", "connect=true", "openConsole=true")
	return []string{"-con", strings.Join(parts, "|")}, nil
}

func (a *App) handleExternalList(w http.ResponseWriter, r *http.Request) {
	saved := toolPaths()
	out := []map[string]string{}
	for _, t := range extTools {
		exe := t.Exe
		if runtime.GOOS == "darwin" {
			if t.Mac == "" {
				continue // PuTTY: a Mac opens Terminal instead
			}
			exe = strings.SplitN(t.Mac, "/", 2)[0]
		}
		out = append(out, map[string]string{"key": t.Key, "name": t.Name, "exe": exe, "set": saved[t.Key], "found": findTool(t)})
	}
	writeJSON(w, out)
}

func (a *App) handleExternalPaths(w http.ResponseWriter, r *http.Request) {
	var in map[string]string
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	m := toolPaths()
	for k, v := range in {
		if _, ok := extToolByKey(k); !ok {
			continue
		}
		v = strings.Trim(strings.TrimSpace(expandWinEnv(v)), `"`)
		if v != "" && !fileExists(v) {
			writeErr(w, 400, fmt.Errorf("%s: no such file", v))
			return
		}
		if v == "" {
			delete(m, k)
		} else {
			m[k] = v
		}
	}
	b, _ := json.MarshalIndent(m, "", "  ")
	_ = os.MkdirAll(filepath.Dir(toolsFile()), 0o700)
	if err := os.WriteFile(toolsFile(), b, 0o600); err != nil {
		writeErr(w, 500, err)
		return
	}
	a.handleExternalList(w, r)
}

func (a *App) handleExternalOpen(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ID   string `json:"id"`
		Tool string `json:"tool"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	e, ok := a.store.Entry(in.ID)
	if ok && in.Tool == "terminal" { // macOS: Terminal + ssh instead of PuTTY
		if err := openInMacTerminal(e); err != nil {
			writeErr(w, 500, err)
			return
		}
		a.store.Touch(e.ID)
		writeJSON(w, map[string]string{"program": "Terminal"})
		return
	}
	t, ok2 := extToolByKey(in.Tool)
	if !ok || !ok2 {
		writeErr(w, 404, errors.New("not found"))
		return
	}
	exe := findTool(t)
	if exe == "" {
		where := t.Exe
		if runtime.GOOS == "darwin" && t.Mac != "" {
			where = strings.SplitN(t.Mac, "/", 2)[0] + " (install it in Applications)"
		}
		writeErr(w, 404, fmt.Errorf("%s wasn't found on this computer — set where %s is with “Program locations…”", t.Name, where))
		return
	}
	var args []string
	note := ""
	switch t.Key {
	case "putty":
		args = puttyArgs(e)
	case "filezilla":
		args = filezillaArgs(e)
	case "dbeaver", "sqldev":
		if dbKind(e) == "" {
			writeErr(w, 400, errors.New("not a database connection"))
			return
		}
		if via, err := a.tunnelFor(dbPort(e)); err != nil { // localhost:1522 → start the jump server's tunnel first
			writeErr(w, 502, err)
			return
		} else if via != "" {
			note = "Tunnel started via " + via + ". "
		}
		if t.Key == "dbeaver" {
			var err error
			if args, err = dbeaverArgs(e); err != nil {
				writeErr(w, 400, err)
				return
			}
		} else {
			note += "SQL Developer can't be told to connect when it starts: the password is copied — use New Connection with the details shown."
		}
	}
	cmd := exec.Command(exe, args...)
	cmd.Dir = filepath.Dir(exe) // SQL Developer looks for its files next to the exe
	if err := cmd.Start(); err != nil {
		writeErr(w, 500, startErr(t.Name, err))
		return
	}
	go cmd.Wait()
	a.store.Touch(e.ID)
	writeJSON(w, map[string]string{"program": t.Name, "path": exe, "note": note})
}

// startErr says in plain words why a program didn't start: a Mac app built for
// Apple Silicon can't run on an Intel Mac (and the other way round).
func startErr(name string, err error) error {
	if strings.Contains(err.Error(), "bad CPU type") {
		return fmt.Errorf("%s is installed for a different kind of Mac (Apple Silicon or Intel) — download the version for this Mac (%s) and install it again", name, macKind())
	}
	return err
}

func macKind() string {
	if runtime.GOARCH == "arm64" {
		return "Apple Silicon"
	}
	return "Intel"
}
