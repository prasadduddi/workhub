// demolab runs pretend Unix servers on this computer for trying WorkHub
// without a real environment: SSH (a real shell, in a sandbox folder per
// server) and SFTP, on 127.0.0.1 only.
//
//	go run ./tools/demolab -dir /tmp/demolab
//
// Servers (password login):
//
//	127.0.0.1:2222  acme-app-01   deploy / Demo#2026
//	127.0.0.1:2223  acme-bat-01   batch  / Batch#2026
//
// Not secure and not for real use: it is a local demo.
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"encoding/pem"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	pty "github.com/aymanbagabas/go-pty"
	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

type host struct {
	name, user, pass string
	port             int
}

var hosts = []host{
	{"acme-app-01", "deploy", "Demo#2026", 2222},
	{"acme-bat-01", "batch", "Batch#2026", 2223},
}

func main() {
	dir := flag.String("dir", filepath.Join(os.TempDir(), "demolab"), "folder for the pretend servers' files")
	flag.Parse()
	signer := hostKey(filepath.Join(*dir, "host_key"))
	for _, h := range hosts {
		root := filepath.Join(*dir, h.name)
		seed(root, h)
		cfg := &ssh.ServerConfig{PasswordCallback: func(c ssh.ConnMetadata, p []byte) (*ssh.Permissions, error) {
			if c.User() == h.user && string(p) == h.pass {
				return nil, nil
			}
			time.Sleep(300 * time.Millisecond)
			return nil, fmt.Errorf("denied")
		}}
		cfg.AddHostKey(signer)
		ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", h.port))
		if err != nil {
			log.Fatal(err)
		}
		log.Printf("%-12s ssh/sftp on 127.0.0.1:%d  user %s / %s  files in %s", h.name, h.port, h.user, h.pass, root)
		go serve(ln, cfg, h, root)
	}
	select {}
}

func hostKey(p string) ssh.Signer {
	if b, err := os.ReadFile(p); err == nil {
		if s, err := ssh.ParsePrivateKey(b); err == nil {
			return s
		}
	}
	_, k, _ := ed25519.GenerateKey(rand.Reader)
	blk, _ := ssh.MarshalPrivateKey(k, "")
	_ = os.MkdirAll(filepath.Dir(p), 0o700)
	_ = os.WriteFile(p, pem.EncodeToMemory(blk), 0o600)
	s, _ := ssh.NewSignerFromKey(k)
	return s
}

func serve(ln net.Listener, cfg *ssh.ServerConfig, h host, root string) {
	for {
		nc, err := ln.Accept()
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
				switch nch.ChannelType() {
				case "session":
					ch, creqs, err := nch.Accept()
					if err == nil {
						go session(ch, creqs, h, root)
					}
				case "direct-tcpip": // tunnels (-L): forward on to the target
					var req struct {
						Host  string
						Port  uint32
						Orig  string
						OPort uint32
					}
					_ = ssh.Unmarshal(nch.ExtraData(), &req)
					t, err := net.DialTimeout("tcp", net.JoinHostPort(req.Host, fmt.Sprint(req.Port)), 5*time.Second)
					if err != nil {
						nch.Reject(ssh.ConnectionFailed, err.Error())
						continue
					}
					ch, creqs, _ := nch.Accept()
					go ssh.DiscardRequests(creqs)
					go func() { io.Copy(ch, t); ch.Close() }()
					go func() { io.Copy(t, ch); t.Close() }()
				default:
					nch.Reject(ssh.UnknownChannelType, "not supported")
				}
			}
		}()
	}
}

func session(ch ssh.Channel, reqs <-chan *ssh.Request, h host, root string) {
	defer ch.Close()
	var p pty.Pty
	cols, rows := 120, 32
	env := []string{"HOME=" + root, "USER=" + h.user, "LOGNAME=" + h.user, "TERM=xterm-256color", "LANG=en_US.UTF-8",
		"PATH=/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
		`PS1=\[\e[32m\]` + h.user + "@" + h.name + `\[\e[0m\]:\[\e[34m\]\w\[\e[0m\]$ `, "BASH_SILENCE_DEPRECATION_WARNING=1"}
	run := func(args []string) {
		if p != nil {
			c := p.Command(args[0], args[1:]...)
			c.Env, c.Dir = env, root
			if err := c.Start(); err != nil {
				fmt.Fprintf(ch, "%v\r\n", err)
				return
			}
			go io.Copy(p, ch)
			go io.Copy(ch, p)
			_ = c.Wait()
			time.Sleep(100 * time.Millisecond)
		} else {
			c := exec.Command(args[0], args[1:]...)
			c.Env, c.Dir = env, root
			c.Stdin, c.Stdout, c.Stderr = ch, ch, ch.Stderr()
			_ = c.Run()
		}
		_, _ = ch.SendRequest("exit-status", false, ssh.Marshal(struct{ C uint32 }{0}))
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
			cols, rows = int(r.Cols), int(r.Rows)
			if p == nil {
				p, _ = pty.New()
			}
			if p != nil {
				_ = p.Resize(max(cols, 20), max(rows, 5))
			}
			req.Reply(true, nil)
		case "window-change":
			if len(req.Payload) >= 8 && p != nil {
				_ = p.Resize(int(binary.BigEndian.Uint32(req.Payload)), int(binary.BigEndian.Uint32(req.Payload[4:])))
			}
		case "env":
			req.Reply(true, nil)
		case "shell":
			req.Reply(true, nil)
			fmt.Fprintf(ch, "Welcome to %s (Acme Bank UAT demo server)\r\nLast login: %s from 10.0.0.15\r\n", h.name, time.Now().Add(-26*time.Hour).Format("Mon Jan 2 15:04:05 2006"))
			run([]string{"/bin/bash", "--noprofile", "--norc", "-i"})
			return
		case "exec":
			var r struct{ Cmd string }
			_ = ssh.Unmarshal(req.Payload, &r)
			req.Reply(true, nil)
			if strings.Contains(r.Cmd, "tcpdump") { // 📡 Capture traffic: a pretend tcpdump
				fakeTcpdump(ch, r.Cmd)
				_, _ = ch.SendRequest("exit-status", false, ssh.Marshal(struct{ C uint32 }{0}))
				return
			}
			run([]string{"/bin/bash", "-c", r.Cmd})
			return
		case "subsystem":
			var r struct{ Name string }
			_ = ssh.Unmarshal(req.Payload, &r)
			if r.Name != "sftp" {
				req.Reply(false, nil)
				continue
			}
			req.Reply(true, nil)
			srv, err := sftp.NewServer(ch, sftp.WithServerWorkingDirectory(root))
			if err == nil {
				_ = srv.Serve()
			}
			return
		default:
			req.Reply(false, nil)
		}
	}
}

// seed creates believable files the first time.
func seed(root string, h host) {
	if _, err := os.Stat(root); err == nil {
		return
	}
	w := func(rel, body string) {
		p := filepath.Join(root, rel)
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		_ = os.WriteFile(p, []byte(body), 0o644)
	}
	now := time.Now()
	var log strings.Builder
	for i := 0; i < 400; i++ {
		t := now.Add(time.Duration(i-400) * 37 * time.Second).Format("2006-01-02 15:04:05,000")
		switch {
		case i%97 == 0:
			fmt.Fprintf(&log, "%s ERROR [pool-3-thread-%d] c.a.pay.PaymentService - Payment %d failed: ORA-00060: deadlock detected while waiting for resource\n\tat com.acme.pay.PaymentDao.save(PaymentDao.java:118)\n", t, i%8, 700000+i)
		case i%23 == 0:
			fmt.Fprintf(&log, "%s WARN  [http-nio-8443-exec-%d] c.a.pay.RateLimiter - Slow response from TPP gateway: %d ms\n", t, i%20, 1800+i)
		default:
			fmt.Fprintf(&log, "%s INFO  [http-nio-8443-exec-%d] c.a.pay.Api - POST /api/payments 201 %d ms\n", t, i%20, 20+i%90)
		}
	}
	if strings.Contains(h.name, "bat") {
		w("batch/config/batch.properties", "batch.threads=8\nbatch.window.start=01:00\nbatch.window.end=05:30\ndb.url=jdbc:oracle:thin:@acme-ora-uat01.acme.local:1521/PAYUAT\n")
		w("batch/scripts/run_eod.sh", "#!/bin/bash\n# End-of-day settlement\nset -euo pipefail\ncd \"$(dirname \"$0\")/..\"\necho \"Starting EOD $(date)\"\njava -jar lib/acme-batch.jar --job=eod --date=\"${1:-today}\"\n")
		w("batch/logs/eod.log", log.String())
		w("batch/inbound/SETTLEMENT_20261121.csv", "id,amount,currency,status\n1001,250.00,GBP,SETTLED\n1002,13.50,GBP,REJECTED\n1003,999.99,EUR,SETTLED\n")
		w("batch/outbound/.keep", "")
	} else {
		w("app/config/application.properties", "server.port=8443\nspring.datasource.url=jdbc:oracle:thin:@acme-ora-uat01.acme.local:1521/PAYUAT\nspring.datasource.username=pay_app\ntpp.gateway.url=https://acme-tpp-01.uat.acme.local/gateway\nfeature.instant-payments=true\n")
		w("app/config/logback.xml", "<configuration>\n  <root level=\"INFO\"><appender-ref ref=\"FILE\"/></root>\n</configuration>\n")
		w("app/logs/application.log", log.String())
		w("app/logs/gc.log", "[0.012s][info][gc] Using G1\n")
		w("app/releases/pay-api-4.2.0.war", "PK demo")
		w("app/releases/pay-api-4.2.1.war", "PK demo")
		w("app/bin/restart.sh", "#!/bin/bash\necho 'Stopping pay-api…'; sleep 1; echo 'Starting pay-api 4.2.1… OK'\n")
		_ = os.Chmod(filepath.Join(root, "app/bin/restart.sh"), 0o755)
	}
	w(".bash_history", "cd app/logs\ntail -f application.log\n")
}

// fakeTcpdump writes a live pcap (Ethernet): app ↔ Oracle 1521, HTTP, DNS, ping — "port 1521" keeps only Oracle.
func fakeTcpdump(ch ssh.Channel, cmd string) {
	fmt.Fprintln(ch.Stderr(), "tcpdump: listening on any, link-type EN10MB (Ethernet), snapshot length 65535 bytes")
	onlyTNS := strings.Contains(cmd, "port 1521")
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
			ipv4(6, app, db, tcp(52344, 1521, seq, 0x18, "\x00\x3a\x00\x00\x06\x00\x00\x00SELECT status FROM refunds WHERE id = :1")),
			ipv4(6, db, app, tcp(1521, 52344, seq+1, 0x18, "\x00\x40\x00\x00\x06\x00\x00\x00APPROVED")),
		}
		if !onlyTNS {
			pkts = append(pkts,
				ipv4(6, web, app, tcp(51000+i%50, 8080, seq, 0x18, fmt.Sprintf("GET /api/payments/%d HTTP/1.1\r\nHost: acme-app-01\r\n\r\n", 4700+i))),
				ipv4(6, app, web, tcp(8080, 51000+i%50, seq, 0x18, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{}")),
				ipv4(17, app, dns, udp(40000+i, 53, dnsQ("acme-ora-uat01.acme.local"))),
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
