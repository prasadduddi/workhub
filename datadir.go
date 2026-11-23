package main

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// The chosen data folder is remembered in a small pointer file in the fixed
// per-user folder, one per workspace.
func pointerFile(ws string) string {
	base := filepath.Dir(defaultDataDir())
	if ws == "" {
		return filepath.Join(base, "data-location.txt")
	}
	return filepath.Join(base, "workspaces", ws+".location.txt")
}

func chosenDataDir(ws string) string {
	if b, err := os.ReadFile(pointerFile(ws)); err == nil {
		if p := strings.TrimSpace(string(b)); p != "" {
			return p
		}
	}
	if ws != "" {
		return filepath.Join(filepath.Dir(defaultDataDir()), "workspaces", ws)
	}
	return defaultDataDir()
}

func setPointer(ws, dir string) error {
	p := pointerFile(ws)
	if dir == "" {
		err := os.Remove(p)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	return os.WriteFile(p, []byte(dir), 0o600)
}

// resolveDataFolder accepts either a workhub-data folder or a folder that
// contains one.
func resolveDataFolder(p string) (dir string, hasData bool) {
	if fileExists(filepath.Join(p, "workhub.dat")) {
		return p, true
	}
	if sub := filepath.Join(p, "workhub-data"); fileExists(filepath.Join(sub, "workhub.dat")) {
		return sub, true
	}
	return p, false
}

// restart starts a fresh copy of WorkHub (which picks up the new data
// folder and opens a new browser tab) and exits this one.
func (a *App) restart() {
	if a.store != nil {
		a.store.Flush()
	}
	_ = os.Remove(filepath.Join(a.dataDir, "session.token"))
	exe, err := os.Executable()
	if err == nil {
		cmd := exec.Command(exe, os.Args[1:]...)
		cmd.Env = append(os.Environ(), "WORKHUB_RESTART=1")
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		err = cmd.Start()
	}
	if err != nil {
		fmt.Println("Restart failed, please start WorkHub again:", err)
	}
	os.Exit(0)
}

func (a *App) handleDataDirPick(w http.ResponseWriter, r *http.Request) {
	start := ""
	if a.store != nil { // nil on the recovery page
		start = a.store.LocalDir()
	}
	p, ok, err := pickFolder(start)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	if !ok {
		writeJSON(w, map[string]any{"cancelled": true})
		return
	}
	dir, has := resolveDataFolder(p)
	writeJSON(w, map[string]any{"path": dir, "has_data": has, "current": filepath.Clean(dir) == filepath.Clean(a.dataDir)})
}

// handleDataDirSet switches to another data folder. mode "use" opens the
// data already there; "copy" copies the current data there first; "default"
// goes back to the standard location.
func (a *App) handleDataDirSet(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Path string `json:"path"`
		Mode string `json:"mode"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	target := ""
	switch in.Mode {
	case "default":
	case "use", "copy":
		if in.Path == "" {
			writeErr(w, 400, errors.New("no folder chosen"))
			return
		}
		target = filepath.Clean(in.Path)
		if err := os.MkdirAll(target, 0o700); err != nil {
			writeErr(w, 400, err)
			return
		}
		if in.Mode == "copy" {
			if fileExists(filepath.Join(target, "workhub.dat")) {
				writeErr(w, 400, errors.New("that folder already has WorkHub data; choose \"use\" or an empty folder"))
				return
			}
			if err := a.copyDataTo(target); err != nil {
				writeErr(w, 500, err)
				return
			}
		}
	default:
		writeErr(w, 400, errors.New("unknown mode"))
		return
	}
	if err := setPointer(a.workspace, target); err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
	go func() {
		time.Sleep(300 * time.Millisecond)
		a.restart()
	}()
}

func (a *App) copyDataTo(target string) error {
	if a.store != nil {
		a.store.Flush()
	}
	for _, f := range []string{"workhub.dat", "key.bin", "key.master", "known_hosts"} {
		src := filepath.Join(a.dataDir, f)
		if !fileExists(src) {
			continue
		}
		if err := copyFile(src, filepath.Join(target, f)); err != nil {
			return err
		}
	}
	_ = copyDir(filepath.Join(a.dataDir, "backups"), filepath.Join(target, "backups"))
	return nil
}

// recoveryRoutes serve a small page when the data cannot be opened.
func (a *App) recoveryRoutes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprintf(w, recoveryPage, htmlEscape(a.recoveryErr), htmlEscape(a.dataDir))
	})
	mux.HandleFunc("POST /api/datadir/pick", a.handleDataDirPick)
	mux.HandleFunc("POST /api/datadir/set", a.handleDataDirSet)
	return a.guard(mux)
}

func htmlEscape(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;").Replace(s)
}

const recoveryPage = `<!doctype html><html><head><meta charset="utf-8"><title>WorkHub - data problem</title>
<style>body{font:15px/1.5 "Segoe UI",system-ui,sans-serif;max-width:640px;margin:60px auto;padding:0 16px;color:#1d2330;background:#f4f5f7}
.box{background:#fff;border:1px solid #dde1e6;border-radius:12px;padding:20px 24px}code{background:#eef0f3;padding:2px 6px;border-radius:4px;word-break:break-all}
button{font:inherit;padding:8px 14px;border-radius:8px;border:1px solid #2f6fde;background:#2f6fde;color:#fff;cursor:pointer;margin:6px 6px 0 0}
button.alt{background:#fff;color:#2f6fde}#msg{color:#c93535;margin-top:10px}</style></head><body><div class="box">
<h2>WorkHub can't open its data</h2>
<p><b>Problem:</b> %s</p><p><b>Data folder:</b> <code>%s</code></p>
<p>Your data has not been changed or deleted. Choose the folder that holds your <code>workhub-data</code>
(for example where an older copy of WorkHub was), or go back to the standard location.</p>
<button id="pick">Choose data folder…</button><button class="alt" id="def">Use standard location</button>
<div id="msg"></div></div>
<script>
const msg = t => document.getElementById('msg').textContent = t;
async function post(u, b) { const r = await fetch(u, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(b||{})}); const d = await r.json(); if (!r.ok) throw new Error(d.error); return d; }
function done() { document.body.innerHTML = '<div class="box"><h2>Restarting WorkHub…</h2><p>A new tab opens in a few seconds. You can close this one.</p></div>'; }
document.getElementById('pick').onclick = async () => {
  msg('Choose the folder in the window that opened (it may be behind the browser)…');
  try { const r = await post('/api/datadir/pick'); if (r.cancelled) return msg('');
    if (!r.has_data && !confirm('No WorkHub data in ' + r.path + '. Start an empty workspace there?')) return msg('');
    await post('/api/datadir/set', {path: r.path, mode: 'use'}); done(); } catch (e) { msg(e.message); }
};
document.getElementById('def').onclick = async () => { try { await post('/api/datadir/set', {mode: 'default'}); done(); } catch (e) { msg(e.message); } };
</script></body></html>`
