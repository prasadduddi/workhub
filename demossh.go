package main

// Pretend SSH / SFTP servers for the demo workspace (see demolab.go). They
// listen on 127.0.0.1 only and never run a real shell: commands go to a small
// pretend shell (demoshell.go) and every file lives in the demo folder of the
// workspace, so a demo login can't reach anything else on this PC.

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"encoding/pem"
	"fmt"
	"io"
	"net"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

// demoHost is one pretend server.
type demoHost struct {
	key, name, user, pass string
	root                  string // the jail on disk: the server's "/"
	homeDir               string // "" = /home/<user>
	lab                   *demoLab

	mu   sync.Mutex
	dirs map[int]string // pretend shell PID → its folder (the terminal follows it)
	pid  int
}

func (h *demoHost) home() string {
	if h.homeDir != "" {
		return h.homeDir
	}
	return "/home/" + h.user
}

// demoHostKey: one host key per demo workspace, kept in its demo folder.
func demoHostKey(p string) (ssh.Signer, error) {
	if b, err := os.ReadFile(p); err == nil {
		if s, err := ssh.ParsePrivateKey(b); err == nil {
			return s, nil
		}
	}
	_, k, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	blk, err := ssh.MarshalPrivateKey(k, "")
	if err != nil {
		return nil, err
	}
	_ = os.MkdirAll(filepath.Dir(p), 0o700)
	if err := os.WriteFile(p, pem.EncodeToMemory(blk), 0o600); err != nil {
		return nil, err
	}
	return ssh.NewSignerFromKey(k)
}

func (h *demoHost) serve(ln net.Listener, signer ssh.Signer) {
	cfg := &ssh.ServerConfig{
		PasswordCallback: func(c ssh.ConnMetadata, p []byte) (*ssh.Permissions, error) {
			if c.User() == h.user && string(p) == h.pass {
				return nil, nil
			}
			time.Sleep(300 * time.Millisecond)
			return nil, fmt.Errorf("wrong user or password")
		},
		ServerVersion: "SSH-2.0-OpenSSH_8.7",
		BannerCallback: func(ssh.ConnMetadata) string {
			return "Acme Bank demo server — made-up data for demos.\n"
		},
	}
	cfg.AddHostKey(signer)
	for {
		nc, err := ln.Accept()
		if err != nil {
			return
		}
		go h.conn(nc, cfg)
	}
}

func (h *demoHost) conn(nc net.Conn, cfg *ssh.ServerConfig) {
	defer nc.Close()
	_, chans, reqs, err := ssh.NewServerConn(nc, cfg)
	if err != nil {
		return
	}
	go ssh.DiscardRequests(reqs)
	for nch := range chans {
		switch nch.ChannelType() {
		case "session":
			ch, creqs, err := nch.Accept()
			if err == nil {
				go h.session(ch, creqs)
			}
		case "direct-tcpip": // tunnels (-L): only to the demo database, never onwards
			var req struct {
				Host  string
				Port  uint32
				Orig  string
				OPort uint32
			}
			_ = ssh.Unmarshal(nch.ExtraData(), &req)
			to := h.lab.tunnelTarget(req.Host, int(req.Port))
			if to == "" {
				nch.Reject(ssh.Prohibited, "the demo servers only forward to the demo database")
				continue
			}
			t, err := net.DialTimeout("tcp", to, 5*time.Second)
			if err != nil {
				nch.Reject(ssh.ConnectionFailed, err.Error())
				continue
			}
			ch, creqs, err := nch.Accept()
			if err != nil {
				t.Close()
				continue
			}
			go ssh.DiscardRequests(creqs)
			go func() { io.Copy(ch, t); ch.Close() }()
			go func() { io.Copy(t, ch); t.Close() }()
		default:
			nch.Reject(ssh.UnknownChannelType, "not supported")
		}
	}
}

var reProcCwd = regexp.MustCompile(`/proc/(\d+)/cwd`)

func (h *demoHost) session(ch ssh.Channel, reqs <-chan *ssh.Request) {
	defer ch.Close()
	tty := false
	cols := 120
	exit := func(code int) {
		_, _ = ch.SendRequest("exit-status", false, ssh.Marshal(struct{ C uint32 }{uint32(code)}))
	}
	for req := range reqs {
		switch req.Type {
		case "pty-req":
			var r struct {
				Term          string
				Cols, Rows    uint32
				Width, Height uint32
				Modes         string
			}
			_ = ssh.Unmarshal(req.Payload, &r)
			tty, cols = true, max(int(r.Cols), 20)
			req.Reply(true, nil)
		case "env", "window-change":
			if req.WantReply {
				req.Reply(true, nil)
			}
		case "shell":
			req.Reply(true, nil)
			sh := newDemoShell(h, ch, tty, h.home())
			sh.cols = cols
			exit(sh.interactive(reqs, false))
			return
		case "exec":
			var r struct{ Cmd string }
			_ = ssh.Unmarshal(req.Payload, &r)
			req.Reply(true, nil)
			exit(h.exec(ch, reqs, r.Cmd, tty, cols))
			return
		case "subsystem":
			var r struct{ Name string }
			_ = ssh.Unmarshal(req.Payload, &r)
			if r.Name != "sftp" {
				req.Reply(false, nil)
				continue
			}
			req.Reply(true, nil)
			srv := sftp.NewRequestServer(ch, h.sftpHandlers(), sftp.WithStartDirectory(h.home()))
			_ = srv.Serve()
			srv.Close()
			return
		default:
			if req.WantReply {
				req.Reply(false, nil)
			}
		}
	}
}

// exec runs one command line: WorkHub's own helpers (terminal start-up, folder
// tracking, log viewer, capture) and anything typed in "Run on several servers".
func (h *demoHost) exec(ch ssh.Channel, reqs <-chan *ssh.Request, cmd string, tty bool, cols int) int {
	switch {
	case strings.Contains(cmd, `exec "$SHELL"`): // WorkHub's terminal: cd to the last folder, report the PID, then the shell
		dir := h.home()
		if m := regexp.MustCompile(`^cd '((?:[^']|'\\'')*)'`).FindStringSubmatch(cmd); m != nil {
			if p := strings.ReplaceAll(m[1], `'\''`, "'"); h.isDir(p) {
				dir = p
			}
		}
		sh := newDemoShell(h, ch, tty, dir)
		sh.cols = cols
		return sh.interactive(reqs, true)
	case reProcCwd.MatchString(cmd): // the terminal asking where the shell is now
		var pid int
		fmt.Sscan(reProcCwd.FindStringSubmatch(cmd)[1], &pid)
		h.mu.Lock()
		d, ok := h.dirs[pid]
		h.mu.Unlock()
		if !ok {
			return 1
		}
		fmt.Fprintln(ch, d)
		return 0
	case strings.Contains(cmd, "tcpdump"):
		if strings.Contains(cmd, "sudo -S") { // the password arrives on stdin: read and forget it
			go io.Copy(io.Discard, ch)
		}
		demoTcpdump(ch, cmd)
		return 0
	case strings.Contains(cmd, "-mmin -4320"): // the log viewer: recent log files as "epoch size path"
		dir := "/"
		if m := regexp.MustCompile(`^find '((?:[^']|'\\'')*)'`).FindStringSubmatch(cmd); m != nil {
			dir = strings.ReplaceAll(m[1], `'\''`, "'")
		}
		h.findLogs(ch, dir)
		return 0
	}
	sh := newDemoShell(h, ch, tty, h.home())
	sh.cols = cols
	return sh.run(cmd)
}

// --- files: the server's "/" is the demo folder ---

// real maps a server path to the file in the demo folder (never outside it).
func (h *demoHost) real(p string) string {
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	return filepath.Join(h.root, filepath.FromSlash(path.Clean(p)))
}

func (h *demoHost) isDir(p string) bool {
	fi, err := os.Stat(h.real(p))
	return err == nil && fi.IsDir()
}

func (h *demoHost) findLogs(w io.Writer, dir string) {
	type lf struct {
		at   int64
		size int64
		p    string
	}
	var out []lf
	_ = filepath.Walk(h.real(dir), func(p string, fi os.FileInfo, err error) error {
		if err != nil || fi.IsDir() {
			return nil
		}
		n := fi.Name()
		if strings.HasSuffix(n, ".log") || strings.HasSuffix(n, ".out") || strings.HasSuffix(n, ".err") || n == "messages" || strings.HasPrefix(n, "catalina.") {
			rel, _ := filepath.Rel(h.root, p)
			out = append(out, lf{fi.ModTime().Unix(), fi.Size(), "/" + filepath.ToSlash(rel)})
		}
		return nil
	})
	for i := range out { // newest first
		for j := i + 1; j < len(out); j++ {
			if out[j].at > out[i].at {
				out[i], out[j] = out[j], out[i]
			}
		}
	}
	for _, f := range out {
		fmt.Fprintf(w, "%d %d %s\n", f.at, f.size, f.p)
	}
}

// sftpHandlers serve the demo folder over SFTP (jailed: every path is cleaned
// and joined under the demo folder).
func (h *demoHost) sftpHandlers() sftp.Handlers {
	fs := demoFS{h}
	return sftp.Handlers{FileGet: fs, FilePut: fs, FileCmd: fs, FileList: fs}
}

type demoFS struct{ h *demoHost }

func (f demoFS) Fileread(r *sftp.Request) (io.ReaderAt, error) {
	return os.Open(f.h.real(r.Filepath))
}

func (f demoFS) Filewrite(r *sftp.Request) (io.WriterAt, error) {
	fl := os.O_RDWR | os.O_CREATE
	if r.Pflags().Trunc {
		fl |= os.O_TRUNC
	}
	return os.OpenFile(f.h.real(r.Filepath), fl, 0o644)
}

func (f demoFS) Filecmd(r *sftp.Request) error {
	p := f.h.real(r.Filepath)
	switch r.Method {
	case "Setstat":
		if r.AttrFlags().Size {
			return os.Truncate(p, int64(r.Attributes().Size))
		}
		return nil
	case "Rename", "PosixRename":
		return os.Rename(p, f.h.real(r.Target))
	case "Rmdir", "Remove":
		if p == f.h.root {
			return os.ErrPermission
		}
		return os.Remove(p)
	case "Mkdir":
		return os.Mkdir(p, 0o755)
	case "Symlink", "Link":
		return os.ErrPermission // links could point outside the demo folder
	}
	return sftp.ErrSSHFxOpUnsupported
}

type demoLister []os.FileInfo

func (l demoLister) ListAt(out []os.FileInfo, off int64) (int, error) {
	if off >= int64(len(l)) {
		return 0, io.EOF
	}
	n := copy(out, l[off:])
	if n < len(out) {
		return n, io.EOF
	}
	return n, nil
}

// demoInfo shows files as owned by the demo user.
type demoInfo struct {
	os.FileInfo
	name string
}

func (i demoInfo) Name() string { return i.name }

func (f demoFS) Filelist(r *sftp.Request) (sftp.ListerAt, error) {
	p := f.h.real(r.Filepath)
	switch r.Method {
	case "List":
		ents, err := os.ReadDir(p)
		if err != nil {
			return nil, err
		}
		var out demoLister
		for _, e := range ents {
			if fi, err := e.Info(); err == nil && fi.Mode()&os.ModeSymlink == 0 {
				out = append(out, fi)
			}
		}
		return out, nil
	case "Stat", "Lstat":
		fi, err := os.Stat(p)
		if err != nil {
			return nil, err
		}
		return demoLister{demoInfo{fi, path.Base(path.Clean("/" + r.Filepath))}}, nil
	case "Readlink":
		return nil, os.ErrInvalid
	}
	return nil, sftp.ErrSSHFxOpUnsupported
}

// demoTcpdump writes a live pcap (Ethernet): app ↔ database, HTTP, DNS, ping —
// "port 1521" / "port 5432" keep only that database's packets.
func demoTcpdump(ch ssh.Channel, cmd string) {
	fmt.Fprintln(ch.Stderr(), "tcpdump: listening on any, link-type EN10MB (Ethernet), snapshot length 65535 bytes")
	dbPort := 1521
	if strings.Contains(cmd, "5432") {
		dbPort = 5432
	}
	onlyDB := strings.Contains(cmd, "port 1521") || strings.Contains(cmd, "port 5432")
	le := binary.LittleEndian
	hdr := make([]byte, 24)
	copy(hdr, []byte{0xd4, 0xc3, 0xb2, 0xa1})
	le.PutUint16(hdr[4:6], 2)
	le.PutUint16(hdr[6:8], 4)
	le.PutUint32(hdr[16:20], 65535)
	le.PutUint32(hdr[20:24], 1)
	if _, err := ch.Write(hdr); err != nil {
		return
	}
	ip4 := func(a, b, c, d byte) []byte { return []byte{a, b, c, d} }
	app, db, web, dns := ip4(10, 0, 0, 21), ip4(10, 0, 0, 31), ip4(10, 0, 0, 15), ip4(10, 0, 0, 2)
	ipv4 := func(proto byte, src, dst, body []byte) []byte {
		h := make([]byte, 34) // Ethernet + IPv4
		binary.BigEndian.PutUint16(h[12:14], 0x0800)
		h[14], h[23] = 0x45, proto
		binary.BigEndian.PutUint16(h[16:18], uint16(20+len(body)))
		h[22] = 64
		copy(h[26:30], src)
		copy(h[30:34], dst)
		return append(h, body...)
	}
	tcp := func(sp, dp int, seq uint32, flags byte, payload string) []byte {
		b := make([]byte, 20)
		binary.BigEndian.PutUint16(b[0:2], uint16(sp))
		binary.BigEndian.PutUint16(b[2:4], uint16(dp))
		binary.BigEndian.PutUint32(b[4:8], seq)
		binary.BigEndian.PutUint32(b[8:12], seq+7)
		b[12], b[13] = 5<<4, flags
		return append(b, payload...)
	}
	udp := func(sp, dp int, payload []byte) []byte {
		b := make([]byte, 8)
		binary.BigEndian.PutUint16(b[0:2], uint16(sp))
		binary.BigEndian.PutUint16(b[2:4], uint16(dp))
		binary.BigEndian.PutUint16(b[4:6], uint16(8+len(payload)))
		return append(b, payload...)
	}
	dnsQ := func(name string) []byte {
		m := []byte{0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0}
		for _, l := range strings.Split(name, ".") {
			m = append(m, byte(len(l)))
			m = append(m, l...)
		}
		return append(m, 0, 0, 1, 0, 1)
	}
	for i := 0; ; i++ {
		seq := uint32(1000 + i*100)
		pkts := [][]byte{
			ipv4(6, app, db, tcp(52344, dbPort, seq, 0x18, "\x00\x3a\x00\x00\x06\x00\x00\x00SELECT status FROM refunds WHERE id = :1")),
			ipv4(6, db, app, tcp(dbPort, 52344, seq+1, 0x18, "\x00\x40\x00\x00\x06\x00\x00\x00APPROVED")),
		}
		if !onlyDB {
			pkts = append(pkts,
				ipv4(6, web, app, tcp(51000+i%50, 8080, seq, 0x18, fmt.Sprintf("GET /api/payments/%d HTTP/1.1\r\nHost: app-01\r\n\r\n", 4700+i))),
				ipv4(6, app, web, tcp(8080, 51000+i%50, seq, 0x18, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{}")),
				ipv4(17, app, dns, udp(40000+i, 53, dnsQ("db-01.uat.acme.example.com"))),
			)
			if i%4 == 0 {
				pkts = append(pkts, ipv4(1, app, db, []byte{8, 0, 0, 0, 0, 1, 0, byte(i)}))
			}
		}
		now := time.Now()
		for _, p := range pkts {
			r := make([]byte, 16)
			le.PutUint32(r[0:4], uint32(now.Unix()))
			le.PutUint32(r[4:8], uint32(now.Nanosecond()/1000))
			le.PutUint32(r[8:12], uint32(len(p)))
			le.PutUint32(r[12:16], uint32(len(p)))
			if _, err := ch.Write(append(r, p...)); err != nil {
				return // WorkHub stopped the capture
			}
		}
		time.Sleep(250 * time.Millisecond)
	}
}
