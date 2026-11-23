// WorkHub: a portable, no-install, no-admin workbench that collects work
// information (hosts, ports, URLs, credentials) from the clipboard and offers
// SSH terminals, SFTP transfers and notes from one local browser UI.
package main

import (
	"crypto/rand"
	"crypto/subtle"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"hash/fnv"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

//go:embed static
var staticFS embed.FS

const defaultPort = 47821

type App struct {
	store       *Store
	dataDir     string
	workspace   string
	recoveryErr string
	addr        string
	token       string
	sftp        *sftpManager
	dbs         *dbManager
	tunnels     *tunnelManager
	mail        mailStatus
	mailNow     chan struct{}
	jobs        *jobList

	lock     lockState
	lockPath string // set when -data is given, so a test or demo folder has its own PIN

	khMu     sync.Mutex
	backupMu sync.Mutex
	backedUp map[string]bool
}

func main() {
	port := flag.Int("port", defaultPort, "port to listen on (always bound to 127.0.0.1)")
	dataDir := flag.String("data", "", `data folder (default: %LOCALAPPDATA%\WorkHub\data, or the folder chosen in the app)`)
	noBrowser := flag.Bool("no-browser", false, "do not open the browser on start")
	workspace := flag.String("workspace", "", "separate workspace name, e.g. ClientB (own data, key and port)")
	flag.Parse()

	ws := strings.TrimSpace(*workspace)
	if ws != "" && !regexp.MustCompile(`^[A-Za-z0-9 _.-]{1,40}$`).MatchString(ws) {
		fatal("workspace name %q: use letters, digits, space, _ . - (max 40)", ws)
	}
	dir := *dataDir
	if dir == "" {
		dir = chosenDataDir(ws)
	}
	if ws != "" && *port == defaultPort {
		h := fnv.New32a()
		h.Write([]byte(strings.ToLower(ws)))
		*port = defaultPort + 1 + int(h.Sum32()%500) // stable per workspace
	}
	_, statErr := os.Stat(filepath.Join(dir, "workhub.dat"))
	firstRun := statErr != nil

	ln, err := listen(*port, dir)
	if err != nil {
		fatal("%v", err)
	}
	if ln == nil { // already running; its window was opened
		return
	}

	app := &App{
		dataDir:   dir,
		workspace: ws,
		addr:      ln.Addr().String(),
		token:     randomHex(16),
		sftp:      newSFTPManager(),
		dbs:       newDBManager(),
		tunnels:   &tunnelManager{},
		mailNow:   make(chan struct{}, 1),
		jobs:      &jobList{},
		backedUp:  map[string]bool{},
	}
	url := fmt.Sprintf("http://%s/?t=%s", app.addr, app.token)

	_ = os.WriteFile(filepath.Join(dir, "session.token"), []byte(app.token), 0o600)
	if *dataDir != "" {
		app.lockPath = filepath.Join(dir, "pin-lock.json")
	}
	sw := &switchHandler{}

	// boot runs once the data is open (straight away, or after the gate).
	var bootOnce sync.Once
	boot := func(store *Store) {
		bootOnce.Do(func() {
			app.store = store
			if firstRun {
				name := ws
				if name == "" {
					name, _ = os.Hostname()
				}
				st := store.Settings()
				st.Workspace = name
				store.SetSettings(st)
				// Old-version folders only ever belong to the default workspace; named
				// workspaces start empty so clients' data never mixes.
				if *dataDir == "" && ws == "" && dir == defaultDataDir() {
					importOldFolders(store, dir)
				}
			}
			if _, ok := app.lockConf(); ok && !hasMaster(dir) {
				app.setLocked(true) // a PIN is set: start locked (the master password already asked)
			}
			go app.watchClipboard()
			go app.syncBrowserBookmarks()
			go app.mailWatcher()
			go app.jiraWatcher()
			go app.jiraKeepAlive()
			go app.tunnelKeeper()
			go app.backupWatcher()
			go func() { time.Sleep(15 * time.Second); cleanOldExe() }()
			sw.set(app.routes())
		})
	}
	// Don't just exit when the data can't be opened (the console window would
	// vanish): show a page where the user can pick another data folder.
	showRecovery := func(err error) {
		fmt.Println("WorkHub cannot open its data:", err)
		fmt.Println("  Open:  ", url, " to choose another data folder.")
		app.recoveryErr = err.Error()
		sw.set(app.recoveryRoutes())
	}

	if !app.accessOK() || hasMaster(dir) {
		fmt.Println("WorkHub is waiting for its password in the window.")
		sw.set(app.gateRoutes(func(key []byte) error {
			store, err := OpenStoreKey(dir, key)
			if err != nil {
				return err
			}
			boot(store)
			return nil
		}))
	} else if store, err := OpenStore(dir); err != nil {
		showRecovery(err)
	} else {
		boot(store)
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt)
	go func() {
		<-sig
		app.shutdown()
	}()

	fmt.Println("WorkHub", version, "is running.")
	fmt.Println("  Open:  ", url)
	fmt.Println("  Data:  ", dir)
	fmt.Println("Close this window (or use Quit in the app) to stop.")
	srv := &http.Server{Handler: sw}
	if isDesktop {
		// Desktop version: own window; closing it stops WorkHub. Without
		// WebView2 it carries on in the browser like the web version.
		go func() { fatal("%v", srv.Serve(ln)) }()
		if runDesktop(url, app.openLink) {
			app.shutdown()
		}
		openBrowser(url)
		select {}
	}
	if !*noBrowser {
		openBrowser(url)
	}
	fatal("%v", srv.Serve(ln))
}

// fatal prints the error and waits a little so it can be read before a
// double-clicked console window closes.
func fatal(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "WorkHub error: "+format+"\n", args...)
	if isDesktop {
		desktopMessage("WorkHub", fmt.Sprintf(format, args...))
		os.Exit(1)
	}
	time.Sleep(15 * time.Second)
	os.Exit(1)
}

// listen binds the port. If WorkHub with the same data folder is already
// running it opens that window instead and returns a nil listener. After a
// restart it waits briefly for the previous process to release the port.
func listen(port int, dir string) (net.Listener, error) {
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	for i := 0; ; i++ {
		ln, err := net.Listen("tcp", addr)
		if err == nil {
			return ln, nil
		}
		if url, ok := existingInstance(dir, port); ok {
			// An older WorkHub left running would otherwise keep showing its
			// old screens: ask it to close and take over.
			if running := instanceVersion(dir, port); running != version && version != "dev" {
				fmt.Printf("Closing the running WorkHub %s to start %s…\n", orDefault(running, "(older)"), version)
				if stopInstance(dir, port) {
					for j := 0; j < 40; j++ {
						time.Sleep(250 * time.Millisecond)
						if ln, err := net.Listen("tcp", addr); err == nil {
							return ln, nil
						}
					}
				}
			}
			fmt.Println("WorkHub is already running:", url)
			if !isDesktop || !runDesktop(url, (&App{}).openLink) { // desktop: a window onto the running WorkHub
				openBrowser(url)
			}
			return nil, nil
		}
		if os.Getenv("WORKHUB_RESTART") == "" || i >= 20 {
			break
		}
		time.Sleep(250 * time.Millisecond)
	}
	return net.Listen("tcp", "127.0.0.1:0")
}

// version is set at build time (-ldflags "-X main.version=...").
var version = "dev"

// defaultDataDir is one fixed per-user folder, so every copy and version of
// copy of WorkHub (whatever folder it runs from) sees the same data.
func defaultDataDir() string {
	if d := os.Getenv("LOCALAPPDATA"); d != "" {
		return filepath.Join(d, "WorkHub", "data")
	}
	if d, err := os.UserConfigDir(); err == nil {
		return filepath.Join(d, "WorkHub", "data")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".workhub")
}

// findOldFolders looks for "workhub-data" folders left by versions that kept
// data next to the exe.
func findOldFolders() []string {
	home, _ := os.UserHomeDir()
	exe, _ := os.Executable()
	roots := []struct {
		dir   string
		depth int
	}{{filepath.Dir(filepath.Dir(exe)), 3}, {home, 1}}
	for _, d := range []string{"Downloads", "Documents", "Desktop"} {
		roots = append(roots, struct {
			dir   string
			depth int
		}{filepath.Join(home, d), 4})
	}
	if od := os.Getenv("OneDrive"); od != "" {
		roots = append(roots, struct {
			dir   string
			depth int
		}{od, 4})
	}
	seen := map[string]bool{}
	var out []string
	for _, r := range roots {
		base := strings.Count(filepath.Clean(r.dir), string(filepath.Separator))
		_ = filepath.WalkDir(r.dir, func(p string, d fs.DirEntry, err error) error {
			if err != nil || !d.IsDir() {
				return nil
			}
			if strings.Count(p, string(filepath.Separator))-base > r.depth || (p != r.dir && strings.HasPrefix(d.Name(), ".")) || d.Name() == "AppData" || d.Name() == "node_modules" {
				return filepath.SkipDir
			}
			if d.Name() == "workhub-data" {
				if _, err := os.Stat(filepath.Join(p, "workhub.dat")); err == nil && !seen[p] {
					seen[p] = true
					out = append(out, p)
				}
				return filepath.SkipDir
			}
			return nil
		})
	}
	return out
}

func importOldFolders(store *Store, dir string) {
	for _, old := range findOldFolders() {
		st, err := readDataFolder(old)
		if err != nil {
			fmt.Printf("  Could not import %s: %v\n", old, err)
			continue
		}
		e, n := store.Merge(st)
		fmt.Printf("  Imported %d connections and %d notes from %s\n", e, n, old)
		_ = copyDir(filepath.Join(old, "backups"), filepath.Join(dir, "backups"))
		if kh, err := os.ReadFile(filepath.Join(old, "known_hosts")); err == nil {
			f, err := os.OpenFile(filepath.Join(dir, "known_hosts"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
			if err == nil {
				f.Write(kh)
				f.Close()
			}
		}
	}
	store.Flush()
}

func copyDir(src, dst string) error {
	ents, err := os.ReadDir(src)
	if err != nil {
		return err
	}
	_ = os.MkdirAll(dst, 0o700)
	for _, e := range ents {
		if !e.IsDir() {
			_ = copyFile(filepath.Join(src, e.Name()), filepath.Join(dst, e.Name()))
		}
	}
	return nil
}

func (a *App) shutdown() {
	if a.store != nil { // nil while the password page or the recovery page is shown
		a.store.Flush()
	}
	_ = os.Remove(filepath.Join(a.dataDir, "session.token"))
	os.Exit(0)
}

// instanceCall talks to the WorkHub already running on port with its saved
// session token (cookie names: "wh<port>" from v1.1, "wh" in v1.0).
func instanceCall(dir string, port int, method, path string) (*http.Response, error) {
	tok, err := os.ReadFile(filepath.Join(dir, "session.token"))
	if err != nil {
		return nil, err
	}
	t := strings.TrimSpace(string(tok))
	req, _ := http.NewRequest(method, fmt.Sprintf("http://127.0.0.1:%d%s", port, path), nil)
	req.Header.Set("Cookie", fmt.Sprintf("wh%d=%s; wh=%s", port, t, t))
	return (&http.Client{Timeout: 3 * time.Second}).Do(req)
}

// instanceVersion returns the running WorkHub's version ("" if unknown/old).
func instanceVersion(dir string, port int) string {
	resp, err := instanceCall(dir, port, "GET", "/api/version")
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	var v struct {
		AppVersion string `json:"app_version"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&v)
	return v.AppVersion
}

// stopInstance asks the running WorkHub to save and quit.
func stopInstance(dir string, port int) bool {
	resp, err := instanceCall(dir, port, "POST", "/api/quit")
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

func existingInstance(dir string, port int) (string, bool) {
	tok, err := os.ReadFile(filepath.Join(dir, "session.token"))
	if err != nil {
		return "", false
	}
	c := http.Client{Timeout: 2 * time.Second}
	resp, err := c.Get(fmt.Sprintf("http://127.0.0.1:%d/api/ping", port))
	if err != nil {
		return "", false
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if string(b) != pingReply(dir) { // a different workspace is on that port
		return "", false
	}
	return fmt.Sprintf("http://127.0.0.1:%d/?t=%s", port, strings.TrimSpace(string(tok))), true
}

// pingReply identifies the instance by its data folder so a second
// workspace never attaches to another workspace's window.
func pingReply(dir string) string {
	abs, _ := filepath.Abs(dir)
	h := fnv.New64a()
	h.Write([]byte(strings.ToLower(abs)))
	return fmt.Sprintf("workhub %x", h.Sum64())
}

// cookieName includes the port: browsers share cookies across ports, and each
// workspace has its own session token.
func (a *App) cookieName() string {
	_, port, _ := net.SplitHostPort(a.addr)
	return "wh" + port
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// guard keeps other local programs and web pages away from the API: the Host
// header must be our loopback address (blocks DNS rebinding) and requests must
// carry the session cookie handed out via the one-time launch URL.
func (a *App) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, port, _ := net.SplitHostPort(a.addr)
		if r.Host != a.addr && r.Host != "localhost:"+port {
			http.Error(w, "forbidden host", http.StatusForbidden)
			return
		}
		if r.URL.Path == "/api/ping" {
			w.Write([]byte(pingReply(a.dataDir)))
			return
		}
		if t := r.URL.Query().Get("t"); t != "" && subtle.ConstantTimeCompare([]byte(t), []byte(a.token)) == 1 {
			http.SetCookie(w, &http.Cookie{Name: a.cookieName(), Value: a.token, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode})
			http.Redirect(w, r, "/", http.StatusFound)
			return
		}
		c, err := r.Cookie(a.cookieName())
		if err != nil || subtle.ConstantTimeCompare([]byte(c.Value), []byte(a.token)) != 1 {
			w.WriteHeader(http.StatusUnauthorized)
			w.Write([]byte("Session expired. Start WorkHub again to open a fresh window."))
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		if a.isLocked() && !a.lockAllowed(r.URL.Path) {
			writeErr(w, http.StatusLocked, errors.New("WorkHub is locked"))
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (a *App) routes() http.Handler {
	mux := http.NewServeMux()
	static, _ := fs.Sub(staticFS, "static")
	mux.Handle("GET /", http.FileServerFS(static))

	mux.HandleFunc("GET /api/version", a.handleVersion)
	mux.HandleFunc("POST /api/import", a.handleImport)
	mux.HandleFunc("POST /api/datadir/pick", a.handleDataDirPick)
	mux.HandleFunc("POST /api/datadir/set", a.handleDataDirSet)
	mux.HandleFunc("POST /api/quit", a.handleQuit)
	mux.HandleFunc("GET /api/settings", a.handleGetSettings)
	mux.HandleFunc("PUT /api/settings", a.handlePutSettings)

	mux.HandleFunc("GET /api/entries", a.handleListEntries)
	mux.HandleFunc("POST /api/entries", a.handleSaveEntry)
	mux.HandleFunc("DELETE /api/entries/{id}", a.handleDeleteEntry)
	mux.HandleFunc("GET /api/entries/{id}/secret", a.handleSecret)
	mux.HandleFunc("POST /api/projects/rename", a.handleRenameProject)
	mux.HandleFunc("POST /api/entries/{id}/opened", a.handleOpened)
	mux.HandleFunc("POST /api/entries/{id}/hide", a.handleHide)
	mux.HandleFunc("POST /api/entries/bulk", a.handleBulk)
	mux.HandleFunc("POST /api/bookmarks/sync", a.handleSyncBookmarks)

	mux.HandleFunc("POST /api/ingest", a.handleIngest)
	mux.HandleFunc("POST /api/parse", a.handleParse)
	mux.HandleFunc("GET /api/clips", a.handleListClips)
	mux.HandleFunc("DELETE /api/clips/{id}", a.handleDeleteClip)

	mux.HandleFunc("GET /api/notes", a.handleListNotes)
	mux.HandleFunc("POST /api/notes", a.handleSaveNote)
	mux.HandleFunc("DELETE /api/notes/{id}", a.handleDeleteNote)
	mux.HandleFunc("GET /api/file", a.handleReadFile)
	mux.HandleFunc("PUT /api/file", a.handleWriteFile)
	mux.HandleFunc("POST /api/file", a.handleWriteFile) // sendBeacon on tab close
	mux.HandleFunc("GET /api/recent", a.handleRecent)

	mux.HandleFunc("GET /ws/term", a.handleTerm)
	mux.HandleFunc("GET /ws/local", a.handleLocalTerm)
	mux.HandleFunc("GET /api/local/shells", a.handleLocalShells)
	mux.HandleFunc("GET /api/git/info", a.handleGitInfo)
	mux.HandleFunc("GET /api/git/log", a.handleGitLog)
	mux.HandleFunc("GET /api/git/commit", a.handleGitCommit)
	mux.HandleFunc("GET /api/git/status", a.handleGitStatus)
	mux.HandleFunc("POST /api/git/fetch", a.handleGitFetch)
	mux.HandleFunc("GET /api/git/find", a.handleGitFind)

	mux.HandleFunc("POST /api/sftp/open", a.handleSFTPOpen)
	mux.HandleFunc("POST /api/sftp/close", a.handleSFTPClose)
	mux.HandleFunc("GET /api/sftp/ls", a.handleSFTPList)
	mux.HandleFunc("GET /api/sftp/download", a.handleSFTPDownload)
	mux.HandleFunc("POST /api/sftp/upload", a.handleSFTPUpload)
	mux.HandleFunc("POST /api/sftp/op", a.handleSFTPOp)
	mux.HandleFunc("POST /api/sftp/transfer", a.handleSFTPTransfer)
	mux.HandleFunc("GET /api/jobs", a.handleJobs)
	mux.HandleFunc("GET /api/local/ls", a.handleLocalList)
	mux.HandleFunc("POST /api/local/mkdir", a.handleLocalMkdir)
	mux.HandleFunc("POST /api/local/pick", a.handleLocalPick)
	mux.HandleFunc("POST /api/local/pickfile", a.handlePickFile)
	mux.HandleFunc("GET /api/local/places", a.handleLocalPlaces)
	mux.HandleFunc("POST /api/links/check", a.handleCheckLinks)
	mux.HandleFunc("POST /api/test", a.handleTestConnection)
	mux.HandleFunc("GET /api/jira/config", a.handleJiraConfigGet)
	mux.HandleFunc("PUT /api/jira/config", a.handleJiraConfigPut)
	mux.HandleFunc("GET /api/jira", a.handleJiraList)
	mux.HandleFunc("POST /api/jira", a.handleJiraAdd)
	mux.HandleFunc("POST /api/jira/refresh", a.handleJiraRefresh)
	mux.HandleFunc("POST /api/jira/mine", a.handleJiraMine)
	mux.HandleFunc("GET /api/jira/browser", a.handleJiraBrowserStatus)
	mux.HandleFunc("POST /api/jira/browser", a.handleJiraBrowserOpen)
	mux.HandleFunc("DELETE /api/jira/{key}", a.handleJiraRemove)
	mux.HandleFunc("GET /api/tunnels", a.handleTunnelsList)
	mux.HandleFunc("POST /api/tunnels/{id}/start", a.handleTunnelsStart)
	mux.HandleFunc("POST /api/tunnels/{id}/stop", a.handleTunnelsStop)
	mux.HandleFunc("POST /api/tunnels/{id}/enabled", a.handleTunnelsEnabled)
	mux.HandleFunc("GET /api/mail/status", a.handleMailStatus)
	mux.HandleFunc("POST /api/mail/check", a.handleMailCheck)
	mux.HandleFunc("POST /api/db/open", a.handleDBOpen)
	mux.HandleFunc("POST /api/db/close", a.handleDBClose)
	mux.HandleFunc("POST /api/db/exec", a.handleDBExec)
	mux.HandleFunc("POST /api/db/cancel", a.handleDBCancel)
	mux.HandleFunc("POST /api/db/tx", a.handleDBTx)
	mux.HandleFunc("GET /api/db/objects", a.handleDBObjects)
	mux.HandleFunc("GET /api/db/columns", a.handleDBColumns)
	mux.HandleFunc("GET /api/db/tree", a.handleDBTree)
	mux.HandleFunc("GET /api/work", a.handleWorkList)
	mux.HandleFunc("POST /api/work", a.handleWorkSave)
	mux.HandleFunc("POST /api/work/import", a.handleWorkImport)
	mux.HandleFunc("GET /api/work/{id}", a.handleWorkGet)
	mux.HandleFunc("DELETE /api/work/{id}", a.handleWorkDelete)
	mux.HandleFunc("POST /api/work/{id}/blocks", a.handleWorkAdd)
	mux.HandleFunc("PUT /api/work/{id}/doc", a.handleWorkDoc)
	mux.HandleFunc("POST /api/work/{id}/doc", a.handleWorkDoc) // sendBeacon on tab close
	mux.HandleFunc("POST /api/work/{id}/files", a.handleWorkFile)
	mux.HandleFunc("POST /api/work/{id}/word", a.handleWorkWord)
	mux.HandleFunc("POST /api/work/{id}/markdown", a.handleWorkMarkdown)
	mux.HandleFunc("PUT /api/work/{id}/blocks/{bid}", a.handleWorkBlock)
	mux.HandleFunc("DELETE /api/work/{id}/blocks/{bid}", a.handleWorkBlockDelete)
	mux.HandleFunc("POST /api/work/{id}/posts", a.handlePostAdd)
	mux.HandleFunc("PUT /api/work/{id}/posts/{pid}", a.handlePostEdit)
	mux.HandleFunc("DELETE /api/work/{id}/posts/{pid}", a.handlePostDelete)
	mux.HandleFunc("GET /api/backups", a.handleBackupsList)
	mux.HandleFunc("POST /api/backups", a.handleBackupNow)
	mux.HandleFunc("POST /api/backups/reveal", a.handleBackupReveal)
	mux.HandleFunc("GET /api/external", a.handleExternalList)
	mux.HandleFunc("POST /api/external/paths", a.handleExternalPaths)
	mux.HandleFunc("POST /api/external/open", a.handleExternalOpen)
	mux.HandleFunc("GET /api/events", a.handleEventsList)
	mux.HandleFunc("POST /api/events", a.handleEventSave)
	mux.HandleFunc("DELETE /api/events/{id}", a.handleEventDelete)
	mux.HandleFunc("GET /api/calendar/outlook", a.handleOutlookEvents)
	mux.HandleFunc("GET /api/update", a.handleUpdateCheck)
	mux.HandleFunc("POST /api/update", a.handleUpdateApply)
	mux.HandleFunc("POST /api/update/restart", a.handleUpdateRestart)
	mux.HandleFunc("GET /api/master", a.handleMasterGet)
	mux.HandleFunc("POST /api/master", a.handleMasterSet)
	mux.HandleFunc("POST /api/master/remove", a.handleMasterRemove)
	mux.HandleFunc("GET /api/profile", a.handleProfileGet)
	mux.HandleFunc("PUT /api/profile", a.handleProfilePut)
	mux.HandleFunc("GET /api/lock", a.handleLockStatus)
	mux.HandleFunc("POST /api/lock", a.handleLockNow)
	mux.HandleFunc("POST /api/lock/unlock", a.handleUnlock)
	mux.HandleFunc("POST /api/lock/set", a.handleLockSet)
	mux.HandleFunc("POST /api/lock/recover", a.handleLockRecover)
	mux.HandleFunc("POST /api/lock/email", a.handleLockEmail)
	mux.HandleFunc("GET /api/lock/reminders", a.handleLockReminders)
	mux.HandleFunc("GET /api/tips", a.handleTipsGet)
	mux.HandleFunc("POST /api/tips", a.handleTipsHide)
	mux.HandleFunc("GET /api/ref", a.handleRefTree)
	mux.HandleFunc("POST /api/ref/folder", a.handleRefFolder)
	mux.HandleFunc("POST /api/ref/link", a.handleRefLink)
	mux.HandleFunc("GET /api/ref/file", a.handleRefRead)
	mux.HandleFunc("PUT /api/ref/file", a.handleRefWrite)
	mux.HandleFunc("POST /api/ref/move", a.handleRefMove)
	mux.HandleFunc("DELETE /api/ref/file", a.handleRefDelete)
	mux.HandleFunc("POST /api/ref/reveal", a.handleRefReveal)
	mux.HandleFunc("POST /api/ref/open", a.handleRefOpen)
	mux.HandleFunc("GET /api/ref/search", a.handleRefSearch)
	mux.HandleFunc("GET /api/ref/history", a.handleRefHistory)
	mux.HandleFunc("GET /api/props", a.handlePropsList)
	mux.HandleFunc("POST /api/props", a.handlePropsSave)
	mux.HandleFunc("DELETE /api/props/{id}", a.handlePropsDelete)
	mux.HandleFunc("POST /api/props/{id}/files", a.handlePropsUpload)
	mux.HandleFunc("GET /api/props/files/{aid}", a.handlePropsFile)
	mux.HandleFunc("PUT /api/props/files/{aid}", a.handlePropsFileSave)
	mux.HandleFunc("DELETE /api/props/files/{aid}", a.handlePropsFileDelete)
	mux.HandleFunc("GET /api/props/search", a.handlePropsSearch)
	mux.HandleFunc("GET /api/db/ddl", a.handleDBDDL)

	return a.guard(mux)
}
