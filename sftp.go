package main

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

type sftpSess struct {
	fs    remoteFS
	entry Entry
}

type sftpManager struct {
	mu sync.Mutex
	m  map[string]*sftpSess
}

func newSFTPManager() *sftpManager { return &sftpManager{m: map[string]*sftpSess{}} }

func (m *sftpManager) get(id string) (*sftpSess, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.m[id]
	if s == nil {
		return nil, errors.New("file session closed; reconnect")
	}
	return s, nil
}

type fileInfo struct {
	Name  string    `json:"name"`
	Dir   bool      `json:"dir"`
	Size  int64     `json:"size"`
	Mtime time.Time `json:"mtime"`
	Mode  string    `json:"mode"`
}

func sortListing(list []fileInfo) {
	sort.Slice(list, func(i, j int) bool {
		if list[i].Dir != list[j].Dir {
			return list[i].Dir
		}
		return list[i].Name < list[j].Name
	})
}

func (a *App) handleSFTPOpen(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ID       string `json:"id"`
		Username string `json:"username"`
		Password string `json:"password"`
		Save     bool   `json:"save"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	e, ok := a.store.Entry(in.ID)
	if !ok {
		writeErr(w, 404, errors.New("entry not found"))
		return
	}
	rfs, err := a.openRemote(e, in.Username, in.Password)
	a.store.SetStatus(e.ID, err)
	if err != nil {
		writeErr(w, 502, err)
		return
	}
	if in.Save {
		a.store.SetCredentials(e.ID, in.Username, in.Password)
	}
	a.store.Touch(e.ID)
	home := rfs.Home()
	if e.LastDir != "" {
		if isDir, _, err := rfs.Stat(e.LastDir); err == nil && isDir {
			home = e.LastDir
		}
	}
	sid := randomHex(8)
	a.sftp.mu.Lock()
	a.sftp.m[sid] = &sftpSess{fs: rfs, entry: e}
	a.sftp.mu.Unlock()
	proto := "sftp"
	if isFTP(e) {
		proto = orDefault(e.Protocol, "ftp")
	}
	writeJSON(w, map[string]string{"sid": sid, "home": home, "protocol": proto})
}

func (a *App) handleSFTPClose(w http.ResponseWriter, r *http.Request) {
	var in struct {
		SID string `json:"sid"`
	}
	_ = readJSON(r, &in)
	a.sftp.mu.Lock()
	if s := a.sftp.m[in.SID]; s != nil {
		go s.fs.Close() // FTP may be mid-transfer; don't block the request
		delete(a.sftp.m, in.SID)
	}
	a.sftp.mu.Unlock()
	writeJSON(w, map[string]bool{"ok": true})
}

func (a *App) handleSFTPList(w http.ResponseWriter, r *http.Request) {
	s, err := a.sftp.get(r.URL.Query().Get("sid"))
	if err != nil {
		writeErr(w, 410, err)
		return
	}
	p := path.Clean(orDefault(r.URL.Query().Get("path"), "/"))
	list, err := s.fs.ReadDir(p)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	if list == nil {
		list = []fileInfo{}
	}
	sortListing(list)
	a.store.SetLastDir(s.entry.ID, p)
	writeJSON(w, map[string]any{"path": p, "parent": path.Dir(p), "entries": list})
}

func (a *App) handleSFTPDownload(w http.ResponseWriter, r *http.Request) {
	s, err := a.sftp.get(r.URL.Query().Get("sid"))
	if err != nil {
		writeErr(w, 410, err)
		return
	}
	p := r.URL.Query().Get("path")
	f, err := s.fs.Open(p)
	if err != nil {
		writeErr(w, 404, err)
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", path.Base(p)))
	_, _ = io.Copy(w, f)
}

// handleSFTPUpload takes files dropped onto the remote pane in the browser.
func (a *App) handleSFTPUpload(w http.ResponseWriter, r *http.Request) {
	s, err := a.sftp.get(r.URL.Query().Get("sid"))
	if err != nil {
		writeErr(w, 410, err)
		return
	}
	dir := r.URL.Query().Get("dir")
	mr, err := r.MultipartReader()
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	n := 0
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			writeErr(w, 400, err)
			return
		}
		if part.FileName() == "" {
			continue
		}
		dst, err := s.fs.Create(path.Join(dir, path.Base(filepath.ToSlash(part.FileName()))))
		if err != nil {
			writeErr(w, 500, err)
			return
		}
		_, err = io.Copy(dst, part)
		if cerr := dst.Close(); err == nil {
			err = cerr
		}
		if err != nil {
			writeErr(w, 500, err)
			return
		}
		n++
	}
	writeJSON(w, map[string]int{"uploaded": n})
}

func (a *App) handleSFTPOp(w http.ResponseWriter, r *http.Request) {
	var in struct {
		SID  string `json:"sid"`
		Op   string `json:"op"`
		Path string `json:"path"`
		To   string `json:"to"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	s, err := a.sftp.get(in.SID)
	if err != nil {
		writeErr(w, 410, err)
		return
	}
	switch in.Op {
	case "mkdir":
		err = s.fs.MkdirAll(in.Path)
	case "rename":
		err = s.fs.Rename(in.Path, in.To)
	case "delete":
		err = s.fs.RemoveAll(in.Path)
	default:
		err = errors.New("unknown operation")
	}
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

// ---- background transfers between this PC and the server ----

type job struct {
	ID      string    `json:"id"`
	Name    string    `json:"name"`
	Dir     string    `json:"dir"` // upload / download
	Host    string    `json:"host"`
	Local   string    `json:"local"`
	Remote  string    `json:"remote"`
	Total   int64     `json:"total"`
	Done    int64     `json:"done"`
	Status  string    `json:"status"` // running / done / failed / cancelled
	Error   string    `json:"error,omitempty"`
	Started time.Time `json:"started"`
	Ended   time.Time `json:"ended,omitzero"`
	sid     string    // the FTP/SFTP session it used (for Retry)
	entryID string
	cancel  int32
}

var errCancelled = errors.New("cancelled")

type jobList struct {
	mu   sync.Mutex
	list []*job
}

func (j *jobList) add(name, dir string) *job {
	j.mu.Lock()
	defer j.mu.Unlock()
	jb := &job{ID: randomHex(6), Name: name, Dir: dir, Status: "running", Started: time.Now()}
	j.list = append(j.list, jb)
	if len(j.list) > 50 {
		j.list = j.list[len(j.list)-50:]
	}
	return jb
}

func (j *jobList) snapshot() []job {
	j.mu.Lock()
	defer j.mu.Unlock()
	out := make([]job, 0, len(j.list))
	for i := len(j.list) - 1; i >= 0; i-- {
		jb := *j.list[i]
		jb.Done = atomic.LoadInt64(&j.list[i].Done)
		out = append(out, jb)
	}
	return out
}

func (j *jobList) finish(jb *job, err error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	jb.Ended = time.Now()
	switch {
	case errors.Is(err, errCancelled):
		jb.Status = "cancelled"
	case err != nil:
		jb.Status, jb.Error = "failed", err.Error()
	default:
		jb.Status = "done"
	}
}

func (j *jobList) find(id string) *job {
	j.mu.Lock()
	defer j.mu.Unlock()
	for _, jb := range j.list {
		if jb.ID == id {
			return jb
		}
	}
	return nil
}

// clear forgets finished transfers (running ones stay).
func (j *jobList) clear() {
	j.mu.Lock()
	defer j.mu.Unlock()
	keep := j.list[:0]
	for _, jb := range j.list {
		if jb.Status == "running" {
			keep = append(keep, jb)
		}
	}
	j.list = keep
}

type progressWriter struct {
	w  io.Writer
	jb *job
}

func (p progressWriter) Write(b []byte) (int, error) {
	if atomic.LoadInt32(&p.jb.cancel) != 0 {
		return 0, errCancelled
	}
	n, err := p.w.Write(b)
	atomic.AddInt64(&p.jb.Done, int64(n))
	return n, err
}

func (a *App) handleJobCancel(w http.ResponseWriter, r *http.Request) {
	jb := a.jobs.find(r.PathValue("id"))
	if jb == nil {
		writeErr(w, 404, errors.New("transfer not found"))
		return
	}
	atomic.StoreInt32(&jb.cancel, 1)
	writeJSON(w, map[string]bool{"ok": true})
}

func (a *App) handleJobsClear(w http.ResponseWriter, r *http.Request) {
	a.jobs.clear()
	writeJSON(w, map[string]bool{"ok": true})
}

// handleJobRetry starts a failed or cancelled transfer again, on its own
// session if that is still open, otherwise on the session given (the server
// you are connected to now, if it is the same one).
func (a *App) handleJobRetry(w http.ResponseWriter, r *http.Request) {
	var in struct{ SID string }
	_ = readJSON(r, &in)
	old := a.jobs.find(r.PathValue("id"))
	if old == nil {
		writeErr(w, 404, errors.New("transfer not found"))
		return
	}
	sid := old.sid
	if s, err := a.sftp.get(sid); err != nil || s == nil {
		if s2, err := a.sftp.get(in.SID); err == nil && s2.entry.ID == old.entryID {
			sid = in.SID
		} else {
			writeErr(w, 410, fmt.Errorf("connect to %s again, then press Retry", old.Host))
			return
		}
	}
	kind := map[string]string{"upload": "put", "download": "get"}[old.Dir]
	jb, err := a.startTransfer(sid, kind, old.Local, old.Remote)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	writeJSON(w, map[string]string{"id": jb.ID})
}

func (a *App) handleJobs(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, a.jobs.snapshot())
}

// handleSFTPTransfer copies a file or folder between a local path and the
// server ("put" = upload, "get" = download) in the background.
func (a *App) handleSFTPTransfer(w http.ResponseWriter, r *http.Request) {
	var in struct {
		SID    string `json:"sid"`
		Dir    string `json:"dir"`
		Local  string `json:"local"`
		Remote string `json:"remote"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	jb, err := a.startTransfer(in.SID, in.Dir, in.Local, in.Remote)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	writeJSON(w, map[string]string{"id": jb.ID})
}

func (a *App) startTransfer(sid, kind, local, remote string) (*job, error) {
	s, err := a.sftp.get(sid)
	if err != nil {
		return nil, err
	}
	var jb *job
	switch kind {
	case "put":
		jb = a.jobs.add(filepath.Base(local), "upload")
	case "get":
		jb = a.jobs.add(path.Base(remote), "download")
	default:
		return nil, errors.New("dir must be put or get")
	}
	a.jobs.mu.Lock()
	jb.Host, jb.Local, jb.Remote, jb.sid, jb.entryID = s.entry.Host, local, remote, sid, s.entry.ID
	a.jobs.mu.Unlock()
	go func() {
		if kind == "put" {
			a.jobs.finish(jb, putPath(s.fs, local, remote, jb))
		} else {
			a.jobs.finish(jb, getPath(s.fs, remote, local, jb))
		}
	}()
	return jb, nil
}

func putPath(c remoteFS, local, remote string, jb *job) error {
	st, err := os.Stat(local)
	if err != nil {
		return err
	}
	if st.IsDir() {
		if err := c.MkdirAll(remote); err != nil {
			return err
		}
		children, err := os.ReadDir(local)
		if err != nil {
			return err
		}
		for _, ch := range children {
			if err := putPath(c, filepath.Join(local, ch.Name()), path.Join(remote, ch.Name()), jb); err != nil {
				return err
			}
		}
		return nil
	}
	atomic.AddInt64(&jb.Total, st.Size())
	src, err := os.Open(local)
	if err != nil {
		return err
	}
	defer src.Close()
	dst, err := c.Create(remote)
	if err != nil {
		return err
	}
	if _, err := io.Copy(progressWriter{dst, jb}, src); err != nil {
		dst.Close()
		return err
	}
	return dst.Close()
}

func getPath(c remoteFS, remote, local string, jb *job) error {
	isDir, size, err := c.Stat(remote)
	if err != nil {
		return err
	}
	if isDir {
		if err := os.MkdirAll(local, 0o755); err != nil {
			return err
		}
		children, err := c.ReadDir(remote)
		if err != nil {
			return err
		}
		for _, ch := range children {
			if err := getPath(c, path.Join(remote, ch.Name), filepath.Join(local, ch.Name), jb); err != nil {
				return err
			}
		}
		return nil
	}
	atomic.AddInt64(&jb.Total, size)
	src, err := c.Open(remote)
	if err != nil {
		return err
	}
	defer src.Close()
	dst, err := os.Create(local)
	if err != nil {
		return err
	}
	if _, err := io.Copy(progressWriter{dst, jb}, src); err != nil {
		dst.Close()
		return err
	}
	return dst.Close()
}

// ---- local file browser ----

func (a *App) handleLocalList(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("path")
	if p == "" {
		p = a.store.LocalDir()
		if st, err := os.Stat(p); p == "" || err != nil || !st.IsDir() {
			p, _ = os.UserHomeDir()
		}
	}
	if p == "::roots" {
		var list []fileInfo
		for _, d := range localRoots() {
			list = append(list, fileInfo{Name: d, Dir: true})
		}
		writeJSON(w, map[string]any{"path": "", "parent": "::roots", "entries": list, "roots": true})
		return
	}
	p = filepath.Clean(p)
	dirents, err := os.ReadDir(p)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	list := make([]fileInfo, 0, len(dirents))
	for _, d := range dirents {
		fi, err := d.Info()
		if err != nil {
			continue
		}
		isDir := d.IsDir()
		if fi.Mode()&fs.ModeSymlink != 0 {
			if st, err := os.Stat(filepath.Join(p, d.Name())); err == nil {
				isDir = st.IsDir()
			}
		}
		list = append(list, fileInfo{Name: d.Name(), Dir: isDir, Size: fi.Size(), Mtime: fi.ModTime()})
	}
	sortListing(list)
	a.store.SetLocalDir(p)
	parent := filepath.Dir(p)
	if parent == p { // at a drive root
		parent = "::roots"
	}
	writeJSON(w, map[string]any{"path": p, "parent": parent, "entries": list, "sep": string(filepath.Separator)})
}

// handleLocalPlaces lists shortcuts for the This PC pane.
func (a *App) handleLocalPlaces(w http.ResponseWriter, r *http.Request) {
	type place struct {
		Name string `json:"name"`
		Path string `json:"path"`
	}
	var out []place
	home, _ := os.UserHomeDir()
	add := func(name, p string) {
		if st, err := os.Stat(p); err == nil && st.IsDir() {
			out = append(out, place{name, p})
		}
	}
	add("Home", home)
	for _, d := range []string{"Desktop", "Documents", "Downloads"} {
		add(d, filepath.Join(home, d))
	}
	if od := os.Getenv("OneDrive"); od != "" {
		add("OneDrive", od)
	} else {
		add("OneDrive", filepath.Join(home, "OneDrive"))
	}
	for _, d := range localRoots() {
		add(d, d)
	}
	writeJSON(w, out)
}

func (a *App) handleLocalMkdir(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Path string `json:"path"`
	}
	if err := readJSON(r, &in); err != nil || in.Path == "" {
		writeErr(w, 400, errors.New("path required"))
		return
	}
	if err := os.MkdirAll(in.Path, 0o755); err != nil {
		writeErr(w, 400, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}
