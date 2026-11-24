package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

func TestParseForwards(t *testing.T) {
	f, err := parseForwards("1522:dbhost:1521, L8443:app01.corp.local:443\n 5433 : pg01 : 5432")
	if err != nil || len(f) != 3 || f[0] != (forward{1522, "dbhost", 1521}) || f[1].Host != "app01.corp.local" || f[2].Local != 5433 {
		t.Fatalf("%+v %v", f, err)
	}
	if _, err := parseForwards("1522:dbhost"); err == nil {
		t.Fatal("bad spec accepted")
	}
	e := Entry{Host: "localhost", Port: 1522, Protocol: "oracle"}
	if msg := explainRefused(e, errors.New("dial tcp 127.0.0.1:1522: connect: connection refused")).Error(); !strings.Contains(msg, "Tunnels: 1522:") {
		t.Fatalf("no advice: %s", msg)
	}
}

// A real SSH server (in-process) forwards tunnel traffic to an echo
// "database"; bytes sent to the local port come back through the tunnel.
func TestTunnelEndToEnd(t *testing.T) {
	if sshOff {
		t.Skip("SSH is switched off (sshswitch.go)")
	}
	echo, _ := net.Listen("tcp", "127.0.0.1:0")
	defer echo.Close()
	go func() {
		for {
			c, err := echo.Accept()
			if err != nil {
				return
			}
			go io.Copy(c, c)
		}
	}()
	_, hostKey, _ := ed25519.GenerateKey(rand.Reader)
	signer, _ := ssh.NewSignerFromKey(hostKey)
	cfg := &ssh.ServerConfig{PasswordCallback: func(c ssh.ConnMetadata, p []byte) (*ssh.Permissions, error) {
		if c.User() == "u" && string(p) == "pw" {
			return nil, nil
		}
		return nil, errors.New("denied")
	}}
	cfg.AddHostKey(signer)
	sshLn, _ := net.Listen("tcp", "127.0.0.1:0")
	defer sshLn.Close()
	go func() {
		for {
			nc, err := sshLn.Accept()
			if err != nil {
				return
			}
			go func() {
				_, chans, reqs, err := ssh.NewServerConn(nc, cfg)
				if err != nil {
					return
				}
				go ssh.DiscardRequests(reqs)
				for nch := range chans {
					if nch.ChannelType() != "direct-tcpip" {
						nch.Reject(ssh.UnknownChannelType, "no")
						continue
					}
					var req struct {
						Host  string
						Port  uint32
						Orig  string
						OPort uint32
					}
					ssh.Unmarshal(nch.ExtraData(), &req)
					target, err := net.Dial("tcp", net.JoinHostPort(req.Host, strconv.Itoa(int(req.Port))))
					if err != nil {
						nch.Reject(ssh.ConnectionFailed, err.Error())
						continue
					}
					ch, creqs, _ := nch.Accept()
					go ssh.DiscardRequests(creqs)
					go func() { io.Copy(ch, target); ch.Close() }()
					go func() { io.Copy(target, ch); target.Close() }()
				}
			}()
		}
	}()
	store, _ := OpenStore(t.TempDir())
	a := &App{store: store, dataDir: t.TempDir(), tunnels: &tunnelManager{}}
	sshPortNum := sshLn.Addr().(*net.TCPAddr).Port
	echoPort := echo.Addr().(*net.TCPAddr).Port
	free, _ := net.Listen("tcp", "127.0.0.1:0")
	localPort := free.Addr().(*net.TCPAddr).Port
	free.Close()
	jump, _ := store.SaveEntry(EntryInput{Name: "jump", Host: "127.0.0.1", Port: sshPortNum, Protocol: "ssh", Username: "u", Password: ptr("pw"),
		Extra: map[string]string{"tunnels": fmt.Sprintf("%d:127.0.0.1:%d", localPort, echoPort)}})
	_ = jump
	// What a database at localhost:<localPort> triggers:
	if via, err := a.tunnelFor(localPort); err != nil || via != "jump" {
		t.Fatalf("tunnelFor: %q %v", via, err)
	}
	c, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", localPort))
	if err != nil {
		t.Fatal(err)
	}
	c.Write([]byte("select 1 from dual"))
	buf := make([]byte, 64)
	c.SetReadDeadline(time.Now().Add(5 * time.Second))
	n, _ := c.Read(buf)
	if string(buf[:n]) != "select 1 from dual" {
		t.Fatalf("through the tunnel got %q", buf[:n])
	}
	c.Close()
	if via, _ := a.tunnelFor(localPort); via != "" {
		t.Fatal("a running tunnel should be reused, not started twice")
	}

	// Switched off: running tunnel stops, settings stay, nothing auto-starts.
	req := httptest.NewRequest("POST", "/api/tunnels/"+jump.ID+"/enabled", strings.NewReader(`{"on":false}`))
	req.SetPathValue("id", jump.ID)
	a.handleTunnelsEnabled(httptest.NewRecorder(), req)
	if e, _ := store.Entry(jump.ID); e.Extra["tunnels"] == "" || !tunnelsOff(e) {
		t.Fatalf("settings lost or not off: %v", e.Extra)
	}
	if a.tunnels.servesPort(localPort) {
		t.Fatal("tunnel still running after switching off")
	}
	if via, _ := a.tunnelFor(localPort); via != "" || a.tunnels.servesPort(localPort) {
		t.Fatal("switched-off tunnel was started")
	}
	if _, err := a.startTunnels(must(store.Entry(jump.ID))); err == nil {
		t.Fatal("manual start should explain tunnels are off")
	}
	req = httptest.NewRequest("POST", "/", strings.NewReader(`{"on":true}`))
	req.SetPathValue("id", jump.ID)
	a.handleTunnelsEnabled(httptest.NewRecorder(), req)
	if via, err := a.tunnelFor(localPort); via != "jump" || err != nil {
		t.Fatalf("switched back on: %q %v", via, err)
	}
}

func must(e Entry, _ bool) Entry { return e }

func TestParseSSHTunnelCommand(t *testing.T) {
	for _, c := range []struct {
		in, host, user, tunnels string
		port                    int
	}{
		{"ssh -N -L1522:198.51.100.15:1521 jdoe@192.0.2.10", "192.0.2.10", "jdoe", "1522:198.51.100.15:1521", 22},
		{"ssh -N -L 1522:dbhost:1521 jumpbox", "jumpbox", "", "1522:dbhost:1521", 22},
		{"C:\\> ssh.exe -fN -L 5433:pg01.corp.local:5432 -L 127.0.0.1:1522:ora01:1521 -p 2222 -i C:\\keys\\id_rsa -l ops jump.corp.local", "jump.corp.local", "ops", "5433:pg01.corp.local:5432, 1522:ora01:1521", 2222},
	} {
		fs := Parse(c.in)
		var got *Finding
		for i := range fs {
			if fs[i].Extra["tunnels"] != "" {
				got = &fs[i]
			}
		}
		if got == nil || got.Host != c.host || got.Username != c.user || got.Port != c.port || got.Extra["tunnels"] != c.tunnels || got.Protocol != "ssh" {
			t.Fatalf("%q → %+v (all: %+v)", c.in, got, fs)
		}
		if len(fs) != 1 {
			t.Fatalf("%q: the tunnel target should not become its own connection: %+v", c.in, fs)
		}
	}
	if s := mergeTunnelSpecs("1522:a:1521, 8443:w:443", "1522:b:1521, 5433:p:5432"); s != "1522:b:1521, 8443:w:443, 5433:p:5432" {
		t.Fatal(s)
	}
	// Pasting it creates the jump server with the tunnel, ready to use.
	st, _ := OpenStore(t.TempDir())
	_, touched := st.Ingest("ssh -N -L1522:198.51.100.15:1521 jdoe@192.0.2.10", "paste", "General")
	if len(touched) != 1 || touched[0].Extra["tunnels"] != "1522:198.51.100.15:1521" || touched[0].Username != "jdoe" {
		t.Fatalf("%+v", touched)
	}
}

// A tunnel you started yourself (ssh -L / PuTTY) on the port is used as is.
func TestTunnelForUsesExistingPort(t *testing.T) {
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port
	st, _ := OpenStore(t.TempDir())
	st.SaveEntry(EntryInput{Name: "jump", Host: "jump.invalid", Protocol: "ssh", Username: "u",
		Extra: map[string]string{"tunnels": fmt.Sprintf("%d:db:1521", port)}})
	a := &App{store: st, dataDir: t.TempDir(), tunnels: &tunnelManager{}}
	if via, err := a.tunnelFor(port); err != nil || via != "" {
		t.Fatalf("should use the running tunnel, got %q %v", via, err)
	}
}

// testSSHServer: password-only SSH server forwarding direct-tcpip; counts
// login attempts and can drop every connection.
func testSSHServer(t *testing.T, pass string) (port int, attempts *int32, dropAll func()) {
	_, hostKey, _ := ed25519.GenerateKey(rand.Reader)
	signer, _ := ssh.NewSignerFromKey(hostKey)
	var n int32
	var mu sync.Mutex
	var conns []net.Conn
	cfg := &ssh.ServerConfig{PasswordCallback: func(c ssh.ConnMetadata, p []byte) (*ssh.Permissions, error) {
		atomic.AddInt32(&n, 1)
		if string(p) == pass {
			return nil, nil
		}
		return nil, errors.New("denied")
	}}
	cfg.AddHostKey(signer)
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			nc, err := ln.Accept()
			if err != nil {
				return
			}
			mu.Lock()
			conns = append(conns, nc)
			mu.Unlock()
			go func() {
				_, chans, reqs, err := ssh.NewServerConn(nc, cfg)
				if err != nil {
					return
				}
				go ssh.DiscardRequests(reqs)
				for nch := range chans {
					var req struct {
						Host  string
						Port  uint32
						Orig  string
						OPort uint32
					}
					ssh.Unmarshal(nch.ExtraData(), &req)
					target, err := net.Dial("tcp", net.JoinHostPort(req.Host, strconv.Itoa(int(req.Port))))
					if err != nil {
						nch.Reject(ssh.ConnectionFailed, err.Error())
						continue
					}
					ch, creqs, _ := nch.Accept()
					go ssh.DiscardRequests(creqs)
					go func() { io.Copy(ch, target); ch.Close() }()
					go func() { io.Copy(target, ch); target.Close() }()
				}
			}()
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port, &n, func() {
		mu.Lock()
		for _, c := range conns {
			c.Close()
		}
		conns = nil
		mu.Unlock()
	}
}

func freePort() int {
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func waitFor(t *testing.T, what string, cond func() bool) {
	for i := 0; i < 100; i++ {
		if cond() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("timed out: " + what)
}

func TestTunnelKeeper(t *testing.T) {
	if sshOff {
		t.Skip("SSH is switched off (sshswitch.go)")
	}
	keeperTick = 50 * time.Millisecond
	db, _ := net.Listen("tcp", "127.0.0.1:0") // the "database"
	defer db.Close()
	go func() {
		for {
			c, err := db.Accept()
			if err != nil {
				return
			}
			c.Write([]byte("ORACLE"))
			c.Close()
		}
	}()
	sshPort, attempts, dropAll := testSSHServer(t, "pw")
	st, _ := OpenStore(t.TempDir())
	a := &App{store: st, dataDir: t.TempDir(), tunnels: &tunnelManager{}}
	good, bad := freePort(), freePort()
	st.SaveEntry(EntryInput{Name: "jump", Host: "127.0.0.1", Port: sshPort, Protocol: "ssh", Username: "u", Password: ptr("pw"),
		Extra: map[string]string{"tunnels": fmt.Sprintf("%d:127.0.0.1:%d", good, db.Addr().(*net.TCPAddr).Port), "tunnels_auto": "1"}})
	st.SaveEntry(EntryInput{Name: "jump-wrong-pw", Host: "127.0.0.1", Port: sshPort, Protocol: "ssh", Username: "u", Password: ptr("WRONG"),
		Extra: map[string]string{"tunnels": fmt.Sprintf("%d:127.0.0.1:1", bad), "tunnels_auto": "1"}})
	go a.tunnelKeeper()
	read := func() string {
		c, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", good))
		if err != nil {
			return ""
		}
		defer c.Close()
		c.SetReadDeadline(time.Now().Add(2 * time.Second))
		b := make([]byte, 6)
		n, _ := io.ReadFull(c, b)
		return string(b[:n])
	}
	waitFor(t, "tunnel started by itself", func() bool { return read() == "ORACLE" })
	dropAll() // network blip
	waitFor(t, "tunnel back after the connection dropped", func() bool { return a.tunnels.servesPort(good) && read() == "ORACLE" })
	before := atomic.LoadInt32(attempts)
	time.Sleep(600 * time.Millisecond)
	if extra := atomic.LoadInt32(attempts) - before; extra > 0 {
		t.Fatalf("kept trying the wrong password (%d more logins)", extra)
	}
	if a.tunnels.servesPort(bad) {
		t.Fatal("wrong password but tunnel running?")
	}
}
