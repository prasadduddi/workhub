package main

// A pretend FTP server for the demo workspace (see demolab.go): plain FTP with
// passive data connections, on 127.0.0.1 only. Its "/" is a folder in the
// demo folder (made-up partner files); nothing else on this PC is reachable.

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"os"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"
)

type demoFTP struct {
	h *demoHost // the jail (h.real) and the login
}

func (f *demoFTP) serve(ln net.Listener) {
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		go f.conn(c)
	}
}

type ftpSess struct {
	f       *demoFTP
	c       net.Conn
	w       *bufio.Writer
	cwd     string
	user    string
	authed  bool
	pasv    net.Listener
	rest    int64
	renFrom string
}

func (s *ftpSess) reply(code int, msg string) {
	fmt.Fprintf(s.w, "%d %s\r\n", code, msg)
	s.w.Flush()
}

func (f *demoFTP) conn(c net.Conn) {
	defer c.Close()
	s := &ftpSess{f: f, c: c, w: bufio.NewWriter(c), cwd: "/"}
	defer func() {
		if s.pasv != nil {
			s.pasv.Close()
		}
	}()
	s.reply(220, "Acme Bank partner FTP (WorkHub demo server, made-up files)")
	r := bufio.NewReader(c)
	for {
		_ = c.SetReadDeadline(time.Now().Add(10 * time.Minute))
		line, err := r.ReadString('\n')
		if err != nil {
			return
		}
		line = strings.TrimRight(line, "\r\n")
		cmd, arg, _ := strings.Cut(line, " ")
		cmd = strings.ToUpper(cmd)
		if !s.authed && cmd != "USER" && cmd != "PASS" && cmd != "QUIT" && cmd != "FEAT" && cmd != "SYST" && cmd != "OPTS" && cmd != "AUTH" {
			s.reply(530, "Please log in with USER and PASS.")
			continue
		}
		if s.command(cmd, arg) {
			return
		}
	}
}

func (s *ftpSess) abs(p string) string {
	if p == "" {
		return s.cwd
	}
	if !strings.HasPrefix(p, "/") {
		p = s.cwd + "/" + p
	}
	return path.Clean(p)
}

// data waits for the client on the passive port.
func (s *ftpSess) data() (net.Conn, error) {
	if s.pasv == nil {
		return nil, fmt.Errorf("no passive port")
	}
	_ = s.pasv.(*net.TCPListener).SetDeadline(time.Now().Add(15 * time.Second))
	c, err := s.pasv.Accept()
	s.pasv.Close()
	s.pasv = nil
	return c, err
}

func ftpList(fi os.FileInfo, owner string) string {
	when := fi.ModTime().Format("Jan _2 15:04")
	if time.Since(fi.ModTime()) > 180*24*time.Hour {
		when = fi.ModTime().Format("Jan _2  2006")
	}
	return fmt.Sprintf("%s 1 %-8s %-8s %10d %s %s", demoMode(fi), owner, owner, fi.Size(), when, fi.Name())
}

// command handles one line; true ends the session.
func (s *ftpSess) command(cmd, arg string) bool {
	h := s.f.h
	switch cmd {
	case "USER":
		s.user, s.authed = arg, false
		s.reply(331, "Password required for "+arg+".")
	case "PASS":
		if s.user == h.user && arg == h.pass {
			s.authed = true
			s.reply(230, "User "+s.user+" logged in.")
		} else {
			time.Sleep(300 * time.Millisecond)
			s.reply(530, "Login incorrect.")
		}
	case "AUTH":
		s.reply(502, "TLS is not offered by the demo server.")
	case "SYST":
		s.reply(215, "UNIX Type: L8")
	case "FEAT":
		fmt.Fprint(s.w, "211-Features:\r\n EPSV\r\n PASV\r\n SIZE\r\n MDTM\r\n REST STREAM\r\n UTF8\r\n211 End\r\n")
		s.w.Flush()
	case "OPTS", "TYPE", "MODE", "STRU", "ALLO", "CLNT":
		s.reply(200, "OK")
	case "NOOP":
		s.reply(200, "NOOP ok")
	case "PWD", "XPWD":
		s.reply(257, fmt.Sprintf("%q is the current directory", s.cwd))
	case "CWD", "XCWD":
		p := s.abs(arg)
		if !h.isDir(p) {
			s.reply(550, arg+": No such directory")
			return false
		}
		s.cwd = p
		s.reply(250, "Directory changed to "+p)
	case "CDUP", "XCUP":
		s.cwd = path.Dir(s.cwd)
		s.reply(250, "Directory changed to "+s.cwd)
	case "PASV", "EPSV":
		if s.pasv != nil {
			s.pasv.Close()
		}
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			s.reply(425, "Can't open a data connection")
			return false
		}
		s.pasv = ln
		port := ln.Addr().(*net.TCPAddr).Port
		if cmd == "EPSV" {
			s.reply(229, fmt.Sprintf("Entering Extended Passive Mode (|||%d|)", port))
		} else {
			s.reply(227, fmt.Sprintf("Entering Passive Mode (127,0,0,1,%d,%d)", port/256, port%256))
		}
	case "PORT", "EPRT":
		s.reply(502, "Use passive mode (PASV) with the demo server.")
	case "LIST", "NLST", "MLSD":
		p := s.cwd
		for _, a := range strings.Fields(arg) {
			if !strings.HasPrefix(a, "-") {
				p = s.abs(a)
			}
		}
		fi, err := os.Stat(h.real(p))
		if err != nil {
			s.reply(550, "No such file or directory")
			return false
		}
		var list []os.FileInfo
		if fi.IsDir() {
			ents, _ := os.ReadDir(h.real(p))
			for _, e := range ents {
				if i, err := e.Info(); err == nil && i.Mode()&os.ModeSymlink == 0 {
					list = append(list, i)
				}
			}
			sort.Slice(list, func(i, j int) bool { return list[i].Name() < list[j].Name() })
		} else {
			list = []os.FileInfo{fi}
		}
		s.reply(150, "Opening data connection for the file list")
		dc, err := s.data()
		if err != nil {
			s.reply(425, "Can't open a data connection")
			return false
		}
		bw := bufio.NewWriter(dc)
		for _, i := range list {
			switch cmd {
			case "NLST":
				fmt.Fprintf(bw, "%s\r\n", i.Name())
			case "MLSD":
				t := "file"
				if i.IsDir() {
					t = "dir"
				}
				fmt.Fprintf(bw, "type=%s;size=%d;modify=%s; %s\r\n", t, i.Size(), i.ModTime().UTC().Format("20060102150405"), i.Name())
			default:
				fmt.Fprintf(bw, "%s\r\n", ftpList(i, h.user))
			}
		}
		bw.Flush()
		dc.Close()
		s.reply(226, "Transfer complete")
	case "SIZE":
		fi, err := os.Stat(h.real(s.abs(arg)))
		if err != nil || fi.IsDir() {
			s.reply(550, arg+": not a plain file")
			return false
		}
		s.reply(213, strconv.FormatInt(fi.Size(), 10))
	case "MDTM":
		fi, err := os.Stat(h.real(s.abs(arg)))
		if err != nil {
			s.reply(550, arg+": No such file")
			return false
		}
		s.reply(213, fi.ModTime().UTC().Format("20060102150405"))
	case "REST":
		s.rest, _ = strconv.ParseInt(arg, 10, 64)
		s.reply(350, "Restarting at "+arg)
	case "RETR":
		f, err := os.Open(h.real(s.abs(arg)))
		if err != nil {
			s.reply(550, arg+": No such file")
			return false
		}
		defer f.Close()
		if fi, _ := f.Stat(); fi != nil && fi.IsDir() {
			s.reply(550, arg+": is a directory")
			return false
		}
		if s.rest > 0 {
			f.Seek(s.rest, io.SeekStart)
			s.rest = 0
		}
		s.reply(150, "Opening data connection for "+arg)
		dc, err := s.data()
		if err != nil {
			s.reply(425, "Can't open a data connection")
			return false
		}
		_, err = io.Copy(dc, f)
		dc.Close()
		if err != nil {
			s.reply(426, "Transfer aborted")
			return false
		}
		s.reply(226, "Transfer complete")
	case "STOR", "APPE":
		fl := os.O_WRONLY | os.O_CREATE | os.O_TRUNC
		if cmd == "APPE" {
			fl = os.O_WRONLY | os.O_CREATE | os.O_APPEND
		}
		f, err := os.OpenFile(h.real(s.abs(arg)), fl, 0o644)
		if err != nil {
			s.reply(553, arg+": can't create the file here")
			return false
		}
		s.reply(150, "Ready to receive "+arg)
		dc, err := s.data()
		if err != nil {
			f.Close()
			s.reply(425, "Can't open a data connection")
			return false
		}
		_, err = io.Copy(f, io.LimitReader(dc, 200<<20)) // a demo: 200 MB at most
		dc.Close()
		f.Close()
		if err != nil {
			s.reply(426, "Transfer aborted")
			return false
		}
		s.reply(226, "Transfer complete")
	case "DELE":
		if err := os.Remove(h.real(s.abs(arg))); err != nil {
			s.reply(550, arg+": can't delete")
			return false
		}
		s.reply(250, "Deleted "+arg)
	case "MKD", "XMKD":
		p := s.abs(arg)
		if err := os.Mkdir(h.real(p), 0o755); err != nil {
			s.reply(550, arg+": can't create the folder")
			return false
		}
		s.reply(257, fmt.Sprintf("%q created", p))
	case "RMD", "XRMD":
		p := s.abs(arg)
		if p == "/" {
			s.reply(550, "Can't remove the top folder")
			return false
		}
		if err := os.Remove(h.real(p)); err != nil {
			s.reply(550, arg+": can't remove (is it empty?)")
			return false
		}
		s.reply(250, "Removed "+arg)
	case "RNFR":
		if _, err := os.Stat(h.real(s.abs(arg))); err != nil {
			s.reply(550, arg+": No such file")
			return false
		}
		s.renFrom = s.abs(arg)
		s.reply(350, "Ready for RNTO")
	case "RNTO":
		if s.renFrom == "" {
			s.reply(503, "RNFR first")
			return false
		}
		err := os.Rename(h.real(s.renFrom), h.real(s.abs(arg)))
		s.renFrom = ""
		if err != nil {
			s.reply(550, "Rename failed")
			return false
		}
		s.reply(250, "Renamed")
	case "ABOR":
		s.reply(226, "Nothing to abort")
	case "QUIT":
		s.reply(221, "Goodbye.")
		return true
	default:
		s.reply(502, cmd+" is not supported by the demo server")
	}
	return false
}
