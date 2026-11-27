package main

// 📡 Capture traffic on a server (right-click a server): tcpdump runs there
// over SSH and writes a pcap to its output; WorkHub reads it as it arrives,
// lists the packets Wireshark-style and keeps the file for "Save .pcap" (open
// it in Wireshark). sudo: with the server's saved password when it has one
// (sudo -S), else sudo -n; none for root. WorkHub's own SSH connection is
// left out by default.

import (
	"bufio"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

const (
	pcapKeep    = 5000      // packets kept for the list (the file has them all)
	pcapMaxFile = 200 << 20 // the .pcap stops growing here
	pcapShow    = 512       // bytes of each packet kept for the hex view
)

type pcapPkt struct {
	N     int     `json:"n"`
	T     float64 `json:"t"` // seconds since the first packet
	Src   string  `json:"src"`
	Dst   string  `json:"dst"`
	Proto string  `json:"proto"`
	Len   int     `json:"len"`
	Info  string  `json:"info"`
	Data  []byte  `json:"data,omitempty"` // only when asked for one packet
}

type pcapSess struct {
	ID, Entry, Host, Filter, Iface string
	Started                        time.Time
	mu                             sync.Mutex
	pkts                           []pcapPkt
	data                           map[int][]byte
	total                          int
	bytes                          int64
	running, truncated             bool
	info                           string
	errs                           []string
	file                           string
	maxPkts                        int
	stopWhy                        string
	client                         *ssh.Client
	sess                           *ssh.Session
	t0                             float64
}

var pcaps = struct {
	sync.Mutex
	m map[string]*pcapSess
}{m: map[string]*pcapSess{}}

var ifaceRe = regexp.MustCompile(`^[A-Za-z0-9_.:@-]{1,32}$`)

// captureCommand: the shell command run on the server (and whether the password goes to sudo -S).
func captureCommand(user, iface, filter string, hideSSH bool, sshPort, snap int, sudo, hasPassword bool) (string, bool) {
	iface = orDefault(strings.TrimSpace(iface), "any")
	var parts []string
	if f := strings.TrimSpace(filter); f != "" {
		parts = append(parts, "("+f+")")
	}
	if hideSSH {
		parts = append(parts, fmt.Sprintf("not port %d", sshPort))
	}
	args := fmt.Sprintf(`-i %s -U -n -s %d -w -`, shQuote(iface), snap)
	if len(parts) > 0 {
		args += " " + shQuote(strings.Join(parts, " and "))
	}
	find := `T=$(command -v tcpdump 2>/dev/null || ls /usr/sbin/tcpdump /sbin/tcpdump /usr/bin/tcpdump 2>/dev/null | head -1); ` +
		`[ -z "$T" ] && { echo "tcpdump is not installed on this server" >&2; exit 127; }; `
	switch {
	case !sudo || user == "root":
		return find + `exec "$T" ` + args, false
	case hasPassword:
		return find + `exec sudo -S -p '' "$T" ` + args, true
	}
	return find + `exec sudo -n "$T" ` + args, false
}

// explainCaptureErr turns tcpdump / sudo messages into advice.
func explainCaptureErr(line string) (string, bool) {
	l := strings.ToLower(line)
	switch {
	case strings.Contains(l, "listening on"):
		return "", false
	case strings.Contains(l, "a password is required"), strings.Contains(l, "a terminal is required"):
		return "sudo needs a password: save this server's password in WorkHub (Edit…), or untick “use sudo” if your user may capture", true
	case strings.Contains(l, "incorrect password"), strings.Contains(l, "sorry, try again"):
		return "sudo refused the saved password", true
	case strings.Contains(l, "not in the sudoers"), strings.Contains(l, "not allowed to execute"):
		return "your user may not run tcpdump with sudo on this server — ask the server team, or use a user that may", true
	case strings.Contains(l, "not installed"):
		return "tcpdump is not installed on this server", true
	case strings.Contains(l, "permission denied"), strings.Contains(l, "operation not permitted"), strings.Contains(l, "socket: operation"):
		return "no permission to capture — tick “use sudo”", true
	case strings.Contains(l, "syntax error"), strings.Contains(l, "can't parse filter"), strings.Contains(l, "illegal"):
		return "the filter isn't valid tcpdump syntax: " + line, true
	case strings.Contains(l, "no such device"), strings.Contains(l, "doesn't exist"):
		return "that interface doesn't exist on the server — try “any”", true
	}
	return line, strings.HasPrefix(l, "tcpdump:") || strings.Contains(l, "error")
}

func (a *App) handlePcapStart(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Entry    string `json:"entry"`
		Iface    string `json:"iface"`
		Filter   string `json:"filter"`
		HideSSH  bool   `json:"hide_ssh"`
		Sudo     bool   `json:"sudo"`
		Snap     int    `json:"snap"`
		MaxPkts  int    `json:"max_packets"` // stop after this many packets (0 = no limit)
		MaxMins  int    `json:"max_minutes"` // stop after this many minutes (0 = no limit)
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	e, ok := a.store.Entry(in.Entry)
	if !ok {
		writeErr(w, 404, errors.New("server not found"))
		return
	}
	iface := orDefault(strings.TrimSpace(in.Iface), "any")
	if !ifaceRe.MatchString(iface) {
		writeErr(w, 400, errors.New("the interface name isn't valid (e.g. any, eth0, ens192)"))
		return
	}
	if strings.ContainsAny(in.Filter, "\n\r`$;|&<>") {
		writeErr(w, 400, errors.New("the filter may only contain tcpdump words (e.g. port 1521 and host 10.0.0.31)"))
		return
	}
	snap := in.Snap
	if snap <= 0 || snap > 65535 {
		snap = 65535 // whole packets
	}
	client, err := a.dialSSH(e, in.Username, in.Password)
	a.store.SetStatus(e.ID, err)
	if err != nil {
		writeErr(w, 502, err)
		return
	}
	user := orDefault(in.Username, e.Username)
	pass := orDefault(in.Password, e.Password)
	cmd, sendPw := captureCommand(user, iface, in.Filter, in.HideSSH, sshPort(e), snap, in.Sudo, pass != "")
	sess, err := client.NewSession()
	if err != nil {
		client.Close()
		writeErr(w, 502, err)
		return
	}
	stdout, _ := sess.StdoutPipe()
	stderr, _ := sess.StderrPipe()
	stdin, _ := sess.StdinPipe()
	if err := sess.Start(cmd); err != nil {
		client.Close()
		writeErr(w, 502, err)
		return
	}
	if sendPw {
		_, _ = io.WriteString(stdin, pass+"\n")
	}
	a.prodLog(e, "capture", user, "Captured traffic on "+iface+orDefault(map[bool]string{true: " — " + in.Filter}[in.Filter != ""], ""), "") // 🛡
	f, _ := os.CreateTemp("", "workhub-capture-*.pcap")
	ps := &pcapSess{ID: randomHex(6), Entry: e.ID, Host: e.Host, Filter: in.Filter, Iface: iface, Started: time.Now(), running: true, client: client, sess: sess,
		data: map[int][]byte{}, info: "starting tcpdump on " + e.Host + "…", maxPkts: max(in.MaxPkts, 0)}
	if in.MaxMins > 0 { // stop by itself after N minutes
		time.AfterFunc(time.Duration(in.MaxMins)*time.Minute, func() { ps.stopNow("stopped after " + strconv.Itoa(in.MaxMins) + " min") })
	}
	if f != nil {
		ps.file = f.Name()
	}
	pcaps.Lock()
	pcaps.m[ps.ID] = ps
	pcaps.Unlock()
	go func() { // tcpdump's messages
		sc := bufio.NewScanner(stderr)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if line == "" {
				continue
			}
			msg, isErr := explainCaptureErr(line)
			ps.mu.Lock()
			if strings.Contains(strings.ToLower(line), "listening on") {
				ps.info = "capturing on " + e.Host + " (" + line + ")"
			} else if isErr && len(ps.errs) < 20 {
				ps.errs = append(ps.errs, msg)
				noteErr("Capture", errors.New(msg))
			}
			ps.mu.Unlock()
		}
	}()
	go ps.read(stdout, f)
	writeJSON(w, map[string]string{"id": ps.ID})
}

func (ps *pcapSess) read(out io.Reader, f *os.File) {
	defer func() {
		if f != nil {
			f.Close()
		}
		ps.mu.Lock()
		ps.running = false
		ps.mu.Unlock()
		ps.sess.Close()
		ps.client.Close()
	}()
	pr, err := newPcapReader(out)
	if err != nil {
		ps.mu.Lock()
		if len(ps.errs) == 0 && err != io.EOF {
			ps.errs = append(ps.errs, err.Error())
		}
		ps.mu.Unlock()
		return
	}
	if f != nil {
		_, _ = f.Write(pr.Header)
	}
	for {
		rec, err := pr.Next()
		if err != nil {
			return
		}
		src, dst, proto, info := decodePacket(pr.LinkType, rec.Data)
		t := float64(rec.Sec) + float64(rec.Frac)/1e6
		ps.mu.Lock()
		if ps.total == 0 {
			ps.t0 = t
		}
		ps.total++
		n := ps.total
		ps.pkts = append(ps.pkts, pcapPkt{N: n, T: t - ps.t0, Src: src, Dst: dst, Proto: proto, Len: rec.OrigLen, Info: info})
		ps.data[n] = rec.Data[:min(len(rec.Data), pcapShow)]
		if len(ps.pkts) > pcapKeep {
			delete(ps.data, ps.pkts[0].N)
			ps.pkts = ps.pkts[1:]
		}
		if f != nil && ps.bytes+int64(len(rec.Raw)) <= pcapMaxFile {
			_, _ = f.Write(rec.Raw)
			ps.bytes += int64(len(rec.Raw))
		} else if f != nil {
			ps.truncated = true
		}
		full := ps.maxPkts > 0 && ps.total >= ps.maxPkts
		ps.mu.Unlock()
		if full {
			ps.stopNow("stopped after " + strconv.Itoa(ps.maxPkts) + " packets")
			return
		}
	}
}

func pcapGet(id string) *pcapSess {
	pcaps.Lock()
	defer pcaps.Unlock()
	return pcaps.m[id]
}

// handlePcapPoll: GET /api/pcap/{id}?since=N — the packets after N (and one packet's bytes with ?pkt=N).
func (a *App) handlePcapPoll(w http.ResponseWriter, r *http.Request) {
	ps := pcapGet(r.PathValue("id"))
	if ps == nil {
		writeErr(w, 404, errors.New("capture not found"))
		return
	}
	ps.mu.Lock()
	defer ps.mu.Unlock()
	if n, err := strconv.Atoi(r.URL.Query().Get("pkt")); err == nil {
		for _, p := range ps.pkts {
			if p.N == n {
				p.Data = ps.data[n]
				writeJSON(w, p)
				return
			}
		}
		writeErr(w, 404, errors.New("that packet is no longer kept (only the last 5000) — it's in the .pcap"))
		return
	}
	since, _ := strconv.Atoi(r.URL.Query().Get("since"))
	out := []pcapPkt{}
	for _, p := range ps.pkts {
		if p.N > since {
			out = append(out, p)
		}
	}
	if len(out) > 2000 {
		out = out[len(out)-2000:]
	}
	writeJSON(w, map[string]any{"packets": out, "total": ps.total, "running": ps.running, "info": ps.info, "errors": ps.errs, "stopped": ps.stopWhy,
		"bytes": ps.bytes, "truncated": ps.truncated, "host": ps.Host, "filter": ps.Filter, "iface": ps.Iface, "started": ps.Started})
}

func (a *App) handlePcapStop(w http.ResponseWriter, r *http.Request) {
	ps := pcapGet(r.PathValue("id"))
	if ps == nil {
		writeErr(w, 404, errors.New("capture not found"))
		return
	}
	_ = ps.sess.Signal(ssh.SIGINT)
	ps.sess.Close()
	ps.client.Close()
	writeJSON(w, map[string]bool{"ok": true})
}

// handlePcapFile downloads the capture as a .pcap (open it in Wireshark).
func (a *App) handlePcapFile(w http.ResponseWriter, r *http.Request) {
	ps := pcapGet(r.PathValue("id"))
	if ps == nil || ps.file == "" {
		writeErr(w, 404, errors.New("capture not found"))
		return
	}
	name := fmt.Sprintf("%s-%s.pcap", regexp.MustCompile(`[^A-Za-z0-9.-]+`).ReplaceAllString(ps.Host, "_"), ps.Started.Format("2006-01-02-1504"))
	w.Header().Set("Content-Type", "application/vnd.tcpdump.pcap")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", name))
	http.ServeFile(w, r, ps.file)
}

// handlePcapClose stops a capture and removes its file.
func (a *App) handlePcapClose(w http.ResponseWriter, r *http.Request) {
	pcaps.Lock()
	ps := pcaps.m[r.PathValue("id")]
	delete(pcaps.m, r.PathValue("id"))
	pcaps.Unlock()
	if ps != nil {
		ps.sess.Close()
		ps.client.Close()
		if ps.file != "" {
			go func() { time.Sleep(2 * time.Second); _ = os.Remove(ps.file) }()
		}
	}
	writeJSON(w, map[string]bool{"ok": true})
}

// stopNow ends tcpdump on the server (the packets so far are kept).
func (ps *pcapSess) stopNow(why string) {
	ps.mu.Lock()
	if ps.stopWhy == "" {
		ps.stopWhy = why
	}
	ps.mu.Unlock()
	_ = ps.sess.Signal(ssh.SIGINT)
	ps.sess.Close()
	ps.client.Close()
}

// handlePcapToThread: POST /api/pcap/{id}/thread {thread} — the .pcap as a file in a thread, with a summary message.
func (a *App) handlePcapToThread(w http.ResponseWriter, r *http.Request) {
	ps := pcapGet(r.PathValue("id"))
	var in struct {
		Thread string `json:"thread"`
	}
	if err := readJSON(r, &in); err != nil || ps == nil || in.Thread == "" {
		writeErr(w, 400, errors.New("pick a thread"))
		return
	}
	data, err := os.ReadFile(ps.file)
	if err != nil {
		writeErr(w, 404, errors.New("the capture file is gone"))
		return
	}
	if len(data) > maxAttachment {
		writeErr(w, 400, fmt.Errorf("the capture is %d MB — threads take files up to 50 MB; use ⬇ Save .pcap instead", len(data)>>20))
		return
	}
	name := fmt.Sprintf("%s-%s.pcap", regexp.MustCompile(`[^A-Za-z0-9.-]+`).ReplaceAllString(ps.Host, "_"), ps.Started.Format("2006-01-02-1504"))
	at, err := a.store.storeAttachment(name, data)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	if err := a.store.AddWorkFile(in.Thread, at); err != nil {
		writeErr(w, 404, err)
		return
	}
	ps.mu.Lock()
	total, filter, iface := ps.total, ps.Filter, ps.Iface
	ps.mu.Unlock()
	html := fmt.Sprintf(`<p>📡 Capture on <b>%s</b> (%s%s) — %d packets, %s</p><p>📎 <a href="/api/props/files/%s?download=1">%s</a></p>`,
		html.EscapeString(ps.Host), html.EscapeString(iface), map[bool]string{true: ", " + html.EscapeString(filter), false: ""}[filter != ""], total, fmt.Sprintf("%.1f KB", float64(len(data))/1024), at.ID, html.EscapeString(name))
	p, err := a.store.AddPost(in.Thread, Post{Kind: "note", HTML: html})
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, map[string]any{"post": p.ID, "file": at.ID})
}
