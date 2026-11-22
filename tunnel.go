package main

// SSH tunnels (PuTTY "Connection > SSH > Tunnels", local forwards): an SSH
// connection's Extra["tunnels"] lists forwards like "1522:dbhost:1521,
// 8443:app01:443". They start with that server's PuTTY session, on demand
// ("Start tunnels"), or automatically when a database at localhost:<port>
// needs one.

import (
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

type forward struct {
	Local int    `json:"local"`
	Host  string `json:"host"`
	Port  int    `json:"port"`
}

func (f forward) String() string {
	return fmt.Sprintf("localhost:%d → %s:%d", f.Local, f.Host, f.Port)
}

// parseForwards reads "1522:dbhost:1521, L8443:app01:443" (an optional L
// prefix and spaces are accepted, as typed in PuTTY).
func parseForwards(spec string) ([]forward, error) {
	var out []forward
	for _, part := range strings.FieldsFunc(spec, func(r rune) bool { return r == ',' || r == ';' || r == '\n' }) {
		p := strings.TrimPrefix(strings.TrimPrefix(strings.TrimSpace(part), "L"), "l")
		if p == "" {
			continue
		}
		bits := strings.Split(p, ":")
		if len(bits) != 3 {
			return nil, fmt.Errorf("tunnel %q: use localport:host:port, e.g. 1522:dbhost:1521", part)
		}
		lp, err1 := strconv.Atoi(strings.TrimSpace(bits[0]))
		rp, err2 := strconv.Atoi(strings.TrimSpace(bits[2]))
		if err1 != nil || err2 != nil || lp <= 0 || lp > 65535 || rp <= 0 || rp > 65535 {
			return nil, fmt.Errorf("tunnel %q: ports must be numbers", part)
		}
		out = append(out, forward{lp, strings.TrimSpace(bits[1]), rp})
	}
	return out, nil
}

type tunnelSet struct {
	entryID   string
	name      string
	client    *ssh.Client
	ownClient bool // started on its own (not by a PuTTY session)
	listeners []net.Listener
	forwards  []forward
	mu        sync.Mutex
	closed    bool
}

// startForwards listens on 127.0.0.1:<local> for each forward and sends the
// traffic through the SSH client.
func startForwards(client *ssh.Client, fws []forward) (*tunnelSet, []error) {
	ts := &tunnelSet{client: client}
	var errs []error
	for _, f := range fws {
		ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", f.Local))
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: local port %d is already in use (another PuTTY tunnel?)", f, f.Local))
			continue
		}
		ts.listeners = append(ts.listeners, ln)
		ts.forwards = append(ts.forwards, f)
		go func(ln net.Listener, f forward) {
			for {
				local, err := ln.Accept()
				if err != nil {
					return
				}
				go func() {
					defer local.Close()
					remote, err := client.Dial("tcp", net.JoinHostPort(f.Host, strconv.Itoa(f.Port)))
					if err != nil {
						return
					}
					defer remote.Close()
					done := make(chan struct{}, 2)
					go func() { io.Copy(remote, local); done <- struct{}{} }()
					go func() { io.Copy(local, remote); done <- struct{}{} }()
					<-done
				}()
			}
		}(ln, f)
	}
	return ts, errs
}

func (t *tunnelSet) close() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return
	}
	t.closed = true
	for _, ln := range t.listeners {
		ln.Close()
	}
	if t.ownClient {
		t.client.Close()
	}
}

type tunnelManager struct {
	mu   sync.Mutex
	sets []*tunnelSet
}

func (m *tunnelManager) add(t *tunnelSet) { m.mu.Lock(); m.sets = append(m.sets, t); m.mu.Unlock() }

func (m *tunnelManager) remove(t *tunnelSet) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i, x := range m.sets {
		if x == t {
			m.sets = append(m.sets[:i], m.sets[i+1:]...)
			return
		}
	}
}

func (m *tunnelManager) byEntry(id string) *tunnelSet {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, t := range m.sets {
		if t.entryID == id && !t.closed {
			return t
		}
	}
	return nil
}

func (m *tunnelManager) servesPort(port int) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, t := range m.sets {
		for _, f := range t.forwards {
			if f.Local == port && !t.closed {
				return true
			}
		}
	}
	return false
}

// startTunnels opens an SSH connection for entry e just for its tunnels.
func (a *App) startTunnels(e Entry) (*tunnelSet, error) {
	if t := a.tunnels.byEntry(e.ID); t != nil {
		return t, nil
	}
	if tunnelsOff(e) {
		return nil, fmt.Errorf("tunnels are switched off for %s (Edit → tick Use tunnels)", e.Name)
	}
	fws, err := parseForwards(e.Extra["tunnels"])
	if err != nil {
		return nil, err
	}
	if len(fws) == 0 {
		return nil, fmt.Errorf("%s has no tunnels set up (Edit → Tunnels)", e.Name)
	}
	client, err := a.dialSSH(e, "", "")
	a.store.SetStatus(e.ID, err)
	if err != nil {
		return nil, fmt.Errorf("tunnel server %s: %w", e.Name, err)
	}
	ts, errs := startForwards(client, fws)
	ts.entryID, ts.name, ts.ownClient = e.ID, e.Name, true
	if len(ts.listeners) == 0 {
		client.Close()
		return nil, errors.Join(errs...)
	}
	a.tunnels.add(ts)
	go func() { // drop the tunnels if the SSH connection dies
		_ = client.Wait()
		ts.close()
		a.tunnels.remove(ts)
	}()
	return ts, errors.Join(errs...)
}

// tunnelFor starts the tunnels of whichever SSH connection forwards the given
// local port, if any and not already running. Used before connecting to a
// database at localhost:<port>.
func (a *App) tunnelFor(port int) (string, error) {
	if a.tunnels.servesPort(port) || portOpen(port) { // ours, or one you started (ssh -L, PuTTY)
		return "", nil
	}
	for _, v := range a.store.Entries() {
		if v.Extra["tunnels_off"] == "1" {
			continue
		}
		fws, _ := parseForwards(v.Extra["tunnels"])
		for _, f := range fws {
			if f.Local == port {
				e, _ := a.store.Entry(v.ID)
				if _, err := a.startTunnels(e); err != nil {
					return v.Name, err
				}
				return v.Name, nil
			}
		}
	}
	return "", nil
}

// mergeTunnelSpecs joins two "lport:host:port, …" lists; a new forward for
// the same local port replaces the old one.
func mergeTunnelSpecs(old, add string) string {
	byLocal, order := map[int]string{}, []int{}
	for _, spec := range []string{old, add} {
		fws, _ := parseForwards(spec)
		for _, f := range fws {
			if _, seen := byLocal[f.Local]; !seen {
				order = append(order, f.Local)
			}
			byLocal[f.Local] = fmt.Sprintf("%d:%s:%d", f.Local, f.Host, f.Port)
		}
	}
	out := make([]string, 0, len(order))
	for _, l := range order {
		out = append(out, byLocal[l])
	}
	return strings.Join(out, ", ")
}

// tunnelsAuto: started when WorkHub starts and kept running.
func tunnelsAuto(e Entry) bool {
	return e.Extra["tunnels_auto"] == "1" && !tunnelsOff(e) && e.Extra["tunnels"] != ""
}

// loginRefused: an error that retrying won't fix (wrong password/key), so
// the keeper stops instead of locking the account.
func loginRefused(err error) bool {
	m := strings.ToLower(err.Error())
	for _, s := range []string{"unable to authenticate", "permission denied", "no supported methods", "no username", "key file", "auth"} {
		if strings.Contains(m, s) {
			return true
		}
	}
	return false
}

var keeperTick = 15 * time.Second

// tunnelKeeper starts "start when WorkHub starts" tunnels and restarts them
// when the SSH connection drops: network errors are retried with a growing
// pause (30 s … 10 min); a refused login waits until the connection is edited.
func (a *App) tunnelKeeper() {
	type state struct {
		next    time.Time
		wait    time.Duration
		stopped time.Time // entry's Updated when the login was refused
	}
	st := map[string]*state{}
	for {
		for _, v := range a.store.Entries() {
			e, ok := a.store.Entry(v.ID)
			if !ok || !tunnelsAuto(e) || a.tunnels.byEntry(e.ID) != nil {
				continue
			}
			s := st[e.ID]
			if s == nil {
				s = &state{wait: 30 * time.Second}
				st[e.ID] = s
			}
			if !s.stopped.IsZero() && s.stopped.Equal(e.Updated) || time.Now().Before(s.next) {
				continue
			}
			s.stopped = time.Time{}
			fws, _ := parseForwards(e.Extra["tunnels"])
			allBusy := len(fws) > 0
			for _, f := range fws {
				allBusy = allBusy && portOpen(f.Local)
			}
			if allBusy { // your own ssh -L / PuTTY already provides them
				continue
			}
			if _, err := a.startTunnels(e); err != nil && a.tunnels.byEntry(e.ID) == nil {
				log.Printf("tunnels %s: %v", e.Name, err)
				if loginRefused(err) {
					s.stopped = e.Updated
				} else {
					s.next, s.wait = time.Now().Add(s.wait), min(s.wait*2, 10*time.Minute)
				}
				continue
			}
			s.wait = 30 * time.Second
		}
		time.Sleep(keeperTick)
	}
}

// tunnelsOff: the forwards stay saved but are not started ("Use tunnels"
// unticked), e.g. when PuTTY itself provides them.
func tunnelsOff(e Entry) bool { return e.Extra["tunnels_off"] == "1" }

// portOpen: something on this PC already listens on 127.0.0.1:port.
func portOpen(port int) bool {
	c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 300*time.Millisecond)
	if err != nil {
		return false
	}
	c.Close()
	return true
}

func isLocalHost(h string) bool {
	h = strings.ToLower(strings.TrimSpace(h))
	return h == "localhost" || h == "127.0.0.1" || h == "::1"
}

// explainRefused turns "connection refused" on localhost into advice.
func explainRefused(e Entry, err error) error {
	if err == nil || !isLocalHost(e.Host) || !strings.Contains(strings.ToLower(err.Error()), "refused") {
		return err
	}
	port := e.Port
	if port == 0 {
		port = map[string]int{"oracle": 1521, "postgres": 5432}[dbKind(e)]
	}
	return fmt.Errorf("nothing is listening on localhost:%d on this PC. If you normally reach this database through a PuTTY tunnel, "+
		"edit the SSH server you tunnel through and add Tunnels: %d:<database host>:<database port> — WorkHub then starts it automatically (%v)", port, port, err)
}

// ---- HTTP ----

func (a *App) handleTunnelsList(w http.ResponseWriter, r *http.Request) {
	type row struct {
		EntryID  string   `json:"entry_id"`
		Name     string   `json:"name"`
		Forwards []string `json:"forwards"`
	}
	out := []row{}
	a.tunnels.mu.Lock()
	for _, t := range a.tunnels.sets {
		if t.closed {
			continue
		}
		var f []string
		for _, x := range t.forwards {
			f = append(f, x.String())
		}
		out = append(out, row{t.entryID, t.name, f})
	}
	a.tunnels.mu.Unlock()
	writeJSON(w, out)
}

func (a *App) handleTunnelsStart(w http.ResponseWriter, r *http.Request) {
	e, ok := a.store.Entry(r.PathValue("id"))
	if !ok {
		writeErr(w, 404, errors.New("connection not found"))
		return
	}
	ts, err := a.startTunnels(e)
	if ts == nil {
		writeErr(w, 400, err)
		return
	}
	var f []string
	for _, x := range ts.forwards {
		f = append(f, x.String())
	}
	res := map[string]any{"forwards": f}
	if err != nil {
		res["warning"] = err.Error()
	}
	writeJSON(w, res)
}

// handleTunnelsEnabled switches an SSH connection's tunnels on or off; the
// forwards themselves stay saved. Switching off stops running ones.
func (a *App) handleTunnelsEnabled(w http.ResponseWriter, r *http.Request) {
	var in struct {
		On   bool  `json:"on"`
		Auto *bool `json:"auto"` // optional: start when WorkHub starts
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	id := r.PathValue("id")
	if in.Auto != nil {
		v := ""
		if *in.Auto {
			v = "1"
		}
		a.store.SetExtra(id, "tunnels_auto", v)
	}
	if _, ok := a.store.Entry(id); !ok {
		writeErr(w, 404, errors.New("connection not found"))
		return
	}
	if in.On {
		a.store.SetExtra(id, "tunnels_off", "")
	} else {
		a.store.SetExtra(id, "tunnels_off", "1")
		if t := a.tunnels.byEntry(id); t != nil {
			t.close()
			a.tunnels.remove(t)
		}
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (a *App) handleTunnelsStop(w http.ResponseWriter, r *http.Request) {
	if t := a.tunnels.byEntry(r.PathValue("id")); t != nil {
		t.close()
		a.tunnels.remove(t)
	}
	writeJSON(w, map[string]bool{"ok": true})
}
