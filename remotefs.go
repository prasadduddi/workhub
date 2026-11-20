package main

import (
	"crypto/tls"
	"errors"
	"io"
	"io/fs"
	"net"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jlaffaye/ftp"
	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

// remoteFS is what the Files page needs from a server, over SFTP or FTP.
type remoteFS interface {
	ReadDir(p string) ([]fileInfo, error)
	Stat(p string) (isDir bool, size int64, err error)
	Open(p string) (io.ReadCloser, error)
	Create(p string) (io.WriteCloser, error)
	MkdirAll(p string) error
	Rename(from, to string) error
	RemoveAll(p string) error
	Home() string
	Close() error
}

func isFTP(e Entry) bool {
	return e.Protocol == "ftp" || e.Protocol == "ftps" || (e.Protocol == "" && e.Port == 21)
}

func (a *App) openRemote(e Entry, user, pass string) (remoteFS, error) {
	if isFTP(e) {
		return dialFTP(e, user, pass)
	}
	client, err := a.dialSSH(e, user, pass)
	if err != nil {
		return nil, err
	}
	sc, err := sftp.NewClient(client)
	if err != nil {
		client.Close()
		return nil, errors.New("SFTP is not enabled on this server: " + err.Error())
	}
	return &sftpFS{ssh: client, c: sc}, nil
}

// ---- SFTP ----

type sftpFS struct {
	ssh *ssh.Client
	c   *sftp.Client
}

func (s *sftpFS) ReadDir(p string) ([]fileInfo, error) {
	infos, err := s.c.ReadDir(p)
	if err != nil {
		return nil, err
	}
	list := make([]fileInfo, 0, len(infos))
	for _, fi := range infos {
		isDir := fi.IsDir()
		if fi.Mode()&fs.ModeSymlink != 0 {
			if st, err := s.c.Stat(path.Join(p, fi.Name())); err == nil {
				isDir = st.IsDir()
			}
		}
		list = append(list, fileInfo{Name: fi.Name(), Dir: isDir, Size: fi.Size(), Mtime: fi.ModTime(), Mode: fi.Mode().String()})
	}
	return list, nil
}

func (s *sftpFS) Stat(p string) (bool, int64, error) {
	st, err := s.c.Stat(p)
	if err != nil {
		return false, 0, err
	}
	return st.IsDir(), st.Size(), nil
}

func (s *sftpFS) Open(p string) (io.ReadCloser, error)    { return s.c.Open(p) }
func (s *sftpFS) Create(p string) (io.WriteCloser, error) { return s.c.Create(p) }
func (s *sftpFS) MkdirAll(p string) error                 { return s.c.MkdirAll(p) }
func (s *sftpFS) Rename(from, to string) error            { return s.c.Rename(from, to) }

func (s *sftpFS) RemoveAll(p string) error {
	st, err := s.c.Lstat(p)
	if err != nil {
		return err
	}
	if !st.IsDir() {
		return s.c.Remove(p)
	}
	children, err := s.c.ReadDir(p)
	if err != nil {
		return err
	}
	for _, ch := range children {
		if err := s.RemoveAll(path.Join(p, ch.Name())); err != nil {
			return err
		}
	}
	return s.c.RemoveDirectory(p)
}

func (s *sftpFS) Home() string {
	h, _ := s.c.Getwd()
	return orDefault(h, "/")
}

func (s *sftpFS) Close() error {
	s.c.Close()
	return s.ssh.Close()
}

// ---- FTP / FTPS ----

// ftpFS serialises commands because an FTP control connection handles one
// command (or transfer) at a time; listing waits while a transfer runs.
type ftpFS struct {
	mu   sync.Mutex
	c    *ftp.ServerConn
	home string
}

func dialFTP(e Entry, user, pass string) (*ftpFS, error) {
	user, pass = orDefault(user, e.Username), orDefault(pass, e.Password)
	if user == "" {
		user, pass = "anonymous", orDefault(pass, "anonymous@")
	}
	port := e.Port
	if port == 0 || port == 22 {
		port = 21
	}
	opts := []ftp.DialOption{ftp.DialWithTimeout(15 * time.Second)}
	if e.Protocol == "ftps" {
		opts = append(opts, ftp.DialWithExplicitTLS(&tls.Config{ServerName: e.Host}))
	}
	c, err := ftp.Dial(net.JoinHostPort(e.Host, strconv.Itoa(port)), opts...)
	if err != nil {
		return nil, err
	}
	if err := c.Login(user, pass); err != nil {
		c.Quit()
		return nil, err
	}
	home, _ := c.CurrentDir()
	f := &ftpFS{c: c, home: orDefault(home, "/")}
	go func() { // keep the control connection from timing out
		for range time.Tick(60 * time.Second) {
			f.mu.Lock()
			err := c.NoOp()
			f.mu.Unlock()
			if err != nil {
				return
			}
		}
	}()
	return f, nil
}

func (f *ftpFS) ReadDir(p string) ([]fileInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	entries, err := f.c.List(p)
	if err != nil {
		return nil, err
	}
	var list []fileInfo
	for _, e := range entries {
		if e.Name == "." || e.Name == ".." {
			continue
		}
		list = append(list, fileInfo{Name: e.Name, Dir: e.Type == ftp.EntryTypeFolder, Size: int64(e.Size), Mtime: e.Time})
	}
	return list, nil
}

func (f *ftpFS) Stat(p string) (bool, int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if size, err := f.c.FileSize(p); err == nil {
		return false, size, nil
	}
	// Not a file: check it is a folder we can enter.
	cur, _ := f.c.CurrentDir()
	if err := f.c.ChangeDir(p); err != nil {
		return false, 0, err
	}
	_ = f.c.ChangeDir(cur)
	return true, 0, nil
}

type lockedReader struct {
	*ftp.Response
	unlock func()
}

func (r lockedReader) Close() error {
	err := r.Response.Close()
	r.unlock()
	return err
}

func (f *ftpFS) Open(p string) (io.ReadCloser, error) {
	f.mu.Lock()
	r, err := f.c.Retr(p)
	if err != nil {
		f.mu.Unlock()
		return nil, err
	}
	return lockedReader{r, f.mu.Unlock}, nil
}

type ftpWriter struct {
	pw   *io.PipeWriter
	done chan error
}

func (w ftpWriter) Write(b []byte) (int, error) { return w.pw.Write(b) }
func (w ftpWriter) Close() error {
	w.pw.Close()
	return <-w.done
}

func (f *ftpFS) Create(p string) (io.WriteCloser, error) {
	pr, pw := io.Pipe()
	done := make(chan error, 1)
	f.mu.Lock()
	go func() {
		err := f.c.Stor(p, pr)
		pr.CloseWithError(err)
		f.mu.Unlock()
		done <- err
	}()
	return ftpWriter{pw, done}, nil
}

func (f *ftpFS) MkdirAll(p string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	cur := ""
	for _, part := range strings.Split(strings.Trim(p, "/"), "/") {
		cur += "/" + part
		_ = f.c.MakeDir(cur) // fails harmlessly if it already exists
	}
	return nil
}

func (f *ftpFS) Rename(from, to string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.c.Rename(from, to)
}

func (f *ftpFS) RemoveAll(p string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.c.Delete(p); err == nil {
		return nil
	}
	return f.c.RemoveDirRecur(p)
}

func (f *ftpFS) Home() string { return f.home }

func (f *ftpFS) Close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.c.Quit()
}
