package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
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
}
