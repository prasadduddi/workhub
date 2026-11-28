package main

// The demo lab: pretend servers that run inside WorkHub while a demo
// workspace (File → New workspace → sample data) is open, so every feature can
// be shown on any PC — SSH and SFTP servers (demossh.go, demoshell.go), an FTP
// server (demoftp.go), a PostgreSQL database (demopg.go), Jira and Confluence
// (demojira.go), a payments API with an HTTPS endpoint whose certificate is
// about to expire, and a mailbox that receives emails for the email check.
// Everything listens on 127.0.0.1 only, holds made-up data and lives in the
// workspace's own folder. Other workspaces never start it.

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"database/sql"
	"encoding/json"
	"fmt"
	"math/big"
	mrand "math/rand"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// DemoSettings marks a demo workspace: which saved items belong to which
// pretend server (entry id → role), so their ports can be set at each start.
type DemoSettings struct {
	Roles map[string]string `json:"roles"`
}

type demoLab struct {
	a     *App
	dir   string
	db    *sql.DB
	hosts map[string]*demoHost

	mu    sync.Mutex
	ports map[string]int
	inbox []mailItem
	sent  int // emails delivered so far (a new one every few minutes)
}

// Preferred ports (any free one is used when taken, e.g. by a second demo workspace).
var demoPorts = map[string]int{"app1": 47201, "app2": 47202, "batch": 47203, "prod": 47204, "partner": 47205, "ftp": 47206,
	"pg": 47207, "jira": 47208, "api": 47209, "apitls": 47210}

type demoHostDef struct{ key, name, user, pass, env, kind, home string }

var demoHostDefs = []demoHostDef{
	{"app1", "pay-app-01", "deploy", "Demo#2026", "DEV", "app", ""},
	{"app2", "pay-app-02", "deploy", "Demo#2026", "DEV", "app", ""},
	{"batch", "pay-batch-01", "batch", "Batch#2026", "DEV", "batch", ""},
	{"prod", "pay-app-01p", "support", "Supp#2026", "PROD", "app", ""},
	{"partner", "partner-drop", "acme_drop", "Drop#2026", "", "partner", "/"},
	{"ftp", "legacy-ftp", "ftpuser", "Ftp#2026", "", "ftp", "/"},
}

func (l *demoLab) port(role string) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.ports[role]
}

func (l *demoLab) envOf(key string) string {
	for _, d := range demoHostDefs {
		if d.key == key {
			return orDefault(d.env, "partner")
		}
	}
	return ""
}

func (l *demoLab) appName(key string) string {
	if key == "batch" {
		return "pay-batch"
	}
	return "pay-api"
}

func (l *demoLab) mainLog(key string) string {
	if key == "batch" {
		return "/opt/batch/logs/batch.log"
	}
	return "/opt/payments/logs/application.log"
}

// logLine adds one line to a server's main log (the log viewer and tail -f show it).
func (l *demoLab) logLine(key, level, msg string) {
	h := l.hosts[key]
	if h == nil {
		return
	}
	p := h.real(l.mainLog(key))
	if fi, err := os.Stat(p); err == nil && fi.Size() > 2<<20 { // keep it small: cut to the last half
		if b, err := os.ReadFile(p); err == nil {
			_ = os.WriteFile(p, b[len(b)/2:], 0o644)
		}
	}
	f, err := os.OpenFile(p, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o644)
	if err != nil {
		return
	}
	fmt.Fprintf(f, "%s %s [%s] %s\n", time.Now().Format("2006-01-02 15:04:05,000"), level, []string{"http-nio-8443-exec-3", "pool-2-thread-1", "main"}[mrand.Intn(3)], msg)
	f.Close()
}

// tunnelTarget: where a tunnel through a demo server may go (only the demo database).
func (l *demoLab) tunnelTarget(host string, port int) string {
	pg := l.port("pg")
	if port == 5432 || port == pg {
		return fmt.Sprintf("127.0.0.1:%d", pg)
	}
	return ""
}

// isDemoDB: the pretend database answers simple queries only.
func (l *demoLab) isDemoDB(e Entry) bool {
	if d := l.a.store.Settings().Demo; d != nil && strings.HasPrefix(d.Roles[e.ID], "pg") {
		return true
	}
	return isLocalHost(e.Host) && dbPort(e) == l.port("pg")
}

func listenDemo(pref int) (net.Listener, error) {
	if ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", pref)); err == nil {
		return ln, nil
	}
	return net.Listen("tcp", "127.0.0.1:0")
}

// startDemoLab starts the pretend servers of a demo workspace.
func (a *App) startDemoLab() {
	if a.store.Settings().Demo == nil {
		return
	}
	l := &demoLab{a: a, dir: filepath.Join(a.dataDir, "demolab"), hosts: map[string]*demoHost{}, ports: map[string]int{}}
	if err := os.MkdirAll(l.dir, 0o700); err != nil {
		fmt.Println("demo lab:", err)
		return
	}
	signer, err := demoHostKey(filepath.Join(l.dir, "host_key"))
	if err != nil {
		fmt.Println("demo lab:", err)
		return
	}
	listen := func(role string) net.Listener {
		ln, err := listenDemo(demoPorts[role])
		if err != nil {
			fmt.Println("demo lab:", role, err)
			return nil
		}
		l.mu.Lock()
		l.ports[role] = ln.Addr().(*net.TCPAddr).Port
		l.mu.Unlock()
		return ln
	}
	for _, d := range demoHostDefs {
		h := &demoHost{key: d.key, name: d.name, user: d.user, pass: d.pass, root: filepath.Join(l.dir, d.name), lab: l}
		if d.home != "" {
			h.homeDir = d.home
		}
		l.hosts[d.key] = h
		seedDemoFiles(h, d.kind)
		ln := listen(d.key)
		if ln == nil {
			continue
		}
		if d.kind == "ftp" {
			go (&demoFTP{h}).serve(ln)
		} else {
			go h.serve(ln, signer)
		}
	}
	if l.db, err = openDemoDB(filepath.Join(l.dir, "payments.db")); err != nil {
		fmt.Println("demo lab: database:", err)
	} else if ln := listen("pg"); ln != nil {
		go l.servePG(ln)
	}
	if ln := listen("jira"); ln != nil {
		go http.Serve(ln, l.jiraHandler())
	}
	if ln := listen("api"); ln != nil {
		go http.Serve(ln, l.apiHandler())
	}
	if ln := listen("apitls"); ln != nil {
		if cert, err := demoCert(); err == nil {
			go http.Serve(tls.NewListener(ln, &tls.Config{Certificates: []tls.Certificate{cert}}), l.apiHandler())
		}
	}
	l.fillInbox()
	a.demo.Store(l)
	l.repoint()
	fmt.Printf("Demo lab: pretend servers on 127.0.0.1 (ports %v)\n", l.ports)
	go l.liveLogs()
	if len(a.store.JiraIssues()) == 0 { // first start: the Jira page shows tracked issues and my completed work
		go func() {
			a.refreshJira("PAY-301", "PAY-310", "INC-118", "OPS-77", "PAY-200", "PAY-201", "CM-512")
			_, _ = a.addMine()
		}()
	}
}

// repoint sets the demo workspace's connections, Jira, Confluence, monitors and
// API environment to this run's ports.
func (l *demoLab) repoint() {
	s := l.a.store
	st := s.Settings()
	if st.Demo == nil {
		return
	}
	jira := fmt.Sprintf("http://127.0.0.1:%d", l.port("jira"))
	s.mu.Lock()
	for _, e := range s.st.Entries {
		role := st.Demo.Roles[e.ID]
		switch {
		case role == "":
		case strings.HasPrefix(role, "url:"): // url:<server>:<path>
			srv, p, _ := strings.Cut(strings.TrimPrefix(role, "url:"), ":")
			scheme := "http"
			if srv == "apitls" {
				scheme = "https"
			}
			e.URL = fmt.Sprintf("%s://127.0.0.1:%d%s", scheme, l.ports[srv], p)
		case role == "pg-tunnel": // reached through the jump server's tunnel: its port stays
		default:
			base, _, _ := strings.Cut(role, "#")
			if p := l.ports[base]; p != 0 {
				e.Host, e.Port = "127.0.0.1", p
			}
		}
	}
	for _, env := range s.st.HTTPEnvs {
		if env.Name == demoAPIEnv {
			for i := range env.Vars {
				switch env.Vars[i].K {
				case "base_url":
					env.Vars[i].V = fmt.Sprintf("http://127.0.0.1:%d", l.ports["api"])
				case "jira":
					env.Vars[i].V = jira
				}
			}
		}
	}
	s.st.Jira.BaseURL = jira
	var keep []MonitorCheck
	for _, c := range s.st.Settings.Monitor.Checks {
		if !strings.HasPrefix(c.ID, "demo-") {
			keep = append(keep, c)
		}
	}
	s.st.Settings.Monitor.Checks = append(keep, l.monitorChecks()...)
	s.changed()
	s.mu.Unlock()
}

const demoAPIEnv = "Demo — payments API"

func (l *demoLab) monitorChecks() []MonitorCheck {
	p := l.ports
	return []MonitorCheck{
		{ID: "demo-api", Name: "Payments API health", Kind: "http", Target: fmt.Sprintf("http://127.0.0.1:%d/actuator/health", p["api"]), Group: "Tomcat", Host: "pay-app-01", Env: "DEV"},
		{ID: "demo-tls", Name: "Payments API (HTTPS)", Kind: "http", Target: fmt.Sprintf("https://127.0.0.1:%d/actuator/health", p["apitls"]), Group: "Tomcat", Host: "pay-app-01", Env: "DEV"},
		{ID: "demo-ssh1", Name: "pay-app-01 SSH", Kind: "tcp", Target: fmt.Sprintf("127.0.0.1:%d", p["app1"]), Group: "Custom", Host: "pay-app-01", Env: "DEV"},
		{ID: "demo-ssh2", Name: "pay-batch-01 SSH", Kind: "tcp", Target: fmt.Sprintf("127.0.0.1:%d", p["batch"]), Group: "Custom", Host: "pay-batch-01", Env: "DEV"},
		{ID: "demo-db", Name: "Payments DB", Kind: "tcp", Target: fmt.Sprintf("127.0.0.1:%d", p["pg"]), Group: "Oracle", Host: "db-01", Env: "DEV"},
		{ID: "demo-jira", Name: "Jira", Kind: "http", Target: fmt.Sprintf("http://127.0.0.1:%d/", p["jira"]), Group: "Custom", Host: "jira", Env: "DEV"},
		{ID: "demo-down", Name: "Reporting service (stopped)", Kind: "tcp", Target: "127.0.0.1:47299", Group: "Tomcat", Host: "pay-report-01", Env: "DEV"},
	}
}

// demoCert: a self-signed certificate that expires in 12 days, so Monitor
// shows its red "days left" warning.
func demoCert() (tls.Certificate, error) {
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}
	tpl := &x509.Certificate{SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: "pay-api.uat.acme.example.com", Organization: []string{"Acme Bank (demo)"}},
		Issuer: pkix.Name{CommonName: "Acme Demo CA"}, NotBefore: time.Now().AddDate(-1, 0, 0), NotAfter: time.Now().AddDate(0, 0, 12),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames: []string{"pay-api.uat.acme.example.com", "localhost"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &k.PublicKey, k)
	if err != nil {
		return tls.Certificate{}, err
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: k}, nil
}

// apiHandler: a pretend payments REST API (for the API page and Monitor).
func (l *demoLab) apiHandler() http.Handler {
	mux := http.NewServeMux()
	js := func(w http.ResponseWriter, code int, v any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(code)
		e := json.NewEncoder(w)
		e.SetIndent("", "  ")
		_ = e.Encode(v)
	}
	authOK := func(r *http.Request) bool {
		u, p, ok := r.BasicAuth()
		return r.Header.Get("Authorization") == "Bearer demo-api-key" || (ok && u == "pay_app" && p == "Pay#App26")
	}
	mux.HandleFunc("GET /actuator/health", func(w http.ResponseWriter, r *http.Request) {
		js(w, 200, map[string]any{"status": "UP", "components": map[string]any{"db": map[string]string{"status": "UP"}, "diskSpace": map[string]string{"status": "UP"}}})
	})
	mux.HandleFunc("GET /actuator/info", func(w http.ResponseWriter, r *http.Request) {
		js(w, 200, map[string]any{"app": map[string]string{"name": "pay-api", "version": "4.3.0-rc1"}, "env": "UAT"})
	})
	query := func(q string, args ...any) []map[string]any {
		out := []map[string]any{}
		if l.db == nil {
			return out
		}
		rows, err := l.db.Query(q, args...)
		if err != nil {
			return out
		}
		defer rows.Close()
		cols, _ := rows.Columns()
		for rows.Next() {
			v := make([]any, len(cols))
			p := make([]any, len(cols))
			for i := range v {
				p[i] = &v[i]
			}
			if rows.Scan(p...) == nil {
				m := map[string]any{}
				for i, c := range cols {
					if b, ok := v[i].([]byte); ok {
						v[i] = string(b)
					}
					m[c] = v[i]
				}
				out = append(out, m)
			}
		}
		return out
	}
	mux.HandleFunc("GET /api/payments", func(w http.ResponseWriter, r *http.Request) {
		if !authOK(r) {
			js(w, 401, map[string]string{"error": "unauthorized", "hint": "use Bearer demo-api-key"})
			return
		}
		status := strings.ToUpper(orDefault(r.URL.Query().Get("status"), "%"))
		limit, _ := strconv.Atoi(orDefault(r.URL.Query().Get("limit"), "20"))
		js(w, 200, query(`SELECT id, merchant_id, amount, currency, status, reference, created_at, error_code FROM payments WHERE status LIKE ? ORDER BY created_at DESC LIMIT ?`, status, min(max(limit, 1), 200)))
	})
	mux.HandleFunc("GET /api/payments/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !authOK(r) {
			js(w, 401, map[string]string{"error": "unauthorized"})
			return
		}
		res := query(`SELECT p.*, m.name AS merchant FROM payments p JOIN merchants m ON m.id = p.merchant_id WHERE p.id = ?`, r.PathValue("id"))
		if len(res) == 0 {
			js(w, 404, map[string]string{"error": "payment not found"})
			return
		}
		js(w, 200, res[0])
	})
	mux.HandleFunc("GET /api/merchants", func(w http.ResponseWriter, r *http.Request) {
		js(w, 200, query(`SELECT id, name, tier, country, daily_refund_limit, active FROM merchants ORDER BY id`))
	})
	mux.HandleFunc("POST /api/refunds", func(w http.ResponseWriter, r *http.Request) {
		if !authOK(r) {
			js(w, 401, map[string]string{"error": "unauthorized"})
			return
		}
		var in struct {
			PaymentID int64   `json:"payment_id"`
			Amount    float64 `json:"amount"`
			Reason    string  `json:"reason"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&in); err != nil || in.PaymentID == 0 || in.Amount <= 0 {
			js(w, 400, map[string]string{"error": "send {\"payment_id\": 700001, \"amount\": 12.50, \"reason\": \"…\"}"})
			return
		}
		lim := query(`SELECT m.daily_refund_limit AS lim FROM payments p JOIN merchants m ON m.id = p.merchant_id WHERE p.id = ?`, in.PaymentID)
		if len(lim) == 0 {
			js(w, 404, map[string]string{"error": "payment not found"})
			return
		}
		if f, _ := lim[0]["lim"].(float64); f > 0 && in.Amount > f {
			js(w, 422, map[string]any{"error": "REFUND_LIMIT_EXCEEDED", "limit": f, "message": "over the merchant's daily refund limit (PAY-301)"})
			return
		}
		id := 950000 + mrand.Intn(49999)
		js(w, 201, map[string]any{"refund_id": id, "payment_id": in.PaymentID, "amount": in.Amount, "status": "PENDING_APPROVAL", "created_at": time.Now().Format(time.RFC3339)})
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		js(w, 404, map[string]any{"error": "not found", "try": []string{"GET /actuator/health", "GET /api/payments?status=FAILED", "GET /api/payments/700001", "GET /api/merchants", "POST /api/refunds"}})
	})
	return mux
}

// --- the mailbox: emails from vendors and colleagues with server details ---

type demoMail struct{ from, addr, subject, body string }

var demoMails = []demoMail{
	{"Partner Operations", "ops@partner.example.com", "New SFTP account for settlement files",
		"Hello,\n\nYour new account for the settlement files is ready.\n\nHost: sftp2.partner.example.com  port 22\nuser: acme_drop2  password: Drop#2027\nFolder: /inbound\n\nRegards,\nPartner Operations"},
	{"Database team", "dba@acme.example.com", "UAT database refresh finished",
		"Hi,\n\nThe UAT payments database was refreshed from PROD (masked) last night.\n\njdbc:postgresql://db-02.uat.acme.example.com:5432/payments\nuser pay_app / Pay#App26\n\nThe old db-01 copy stays until Friday.\n\nDBA team"},
	{"Tailspin Support", "support@tailspin.example.com", "Your test environment",
		"Dear customer,\n\nYour test console is available at https://test.tailspin.example.com/console\nLogin: acme  Password: Vendor#26\n\nTailspin Support"},
	{"Change Management", "change@acme.example.com", "CM-512 approved: PROD release 4.3.0",
		"CM-512 (PROD release 4.3.0) was approved by the CAB.\nWindow: Saturday 21:00-23:30.\nServers: pay-app-01.prod.acme.example.com, pay-app-02.prod.acme.example.com\n"},
	{"Network team", "network@acme.example.com", "Firewall rule done for the batch server",
		"The rule is in place: the new batch server can now reach the payments database.\nssh batch@pay-batch-02.uat.acme.example.com to test.\n"},
	{"Partner Operations", "ops@partner.example.com", "FTP server moving",
		"Our legacy FTP server moves on the 15th:\nftp://ftp2.partner.example.com:21  user ftpuser  password Ftp#2027\n"},
}

func (l *demoLab) mail(i int, at time.Time) mailItem {
	m := demoMails[i%len(demoMails)]
	return mailItem{ID: fmt.Sprintf("demo-mail-%d", i), From: m.from, Address: m.addr, Subject: m.subject, Body: m.body, Received: at}
}

// fillInbox puts a few emails in the mailbox; a new one arrives every 3 minutes.
func (l *demoLab) fillInbox() {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	for i := 0; i < 3; i++ {
		l.inbox = append(l.inbox, l.mail(i, now.Add(-time.Duration(3-i)*47*time.Minute)))
	}
	l.sent = 3
}

func (l *demoLab) fetchMail(since time.Time) ([]mailItem, *mailItem, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	var out []mailItem
	for _, m := range l.inbox {
		if m.Received.After(since) {
			out = append(out, m)
		}
	}
	var top *mailItem
	if n := len(l.inbox); n > 0 {
		t := l.inbox[n-1]
		top = &t
	}
	return out, top, nil
}

// meetings: pretend Outlook meetings for the calendar.
func (l *demoLab) meetings(from, to time.Time) []OutlookEvent {
	var out []OutlookEvent
	for d := from; d.Before(to); d = d.AddDate(0, 0, 1) {
		at := func(h, m int) time.Time { return time.Date(d.Year(), d.Month(), d.Day(), h, m, 0, 0, time.Local) }
		switch d.Weekday() {
		case time.Saturday, time.Sunday:
			continue
		case time.Tuesday:
			out = append(out, OutlookEvent{Subject: "CAB — weekly change board", Start: at(11, 0), End: at(12, 0), Location: "Teams", Organizer: "Change Management"})
		case time.Thursday:
			out = append(out, OutlookEvent{Subject: "Incident review INC-118", Start: at(15, 0), End: at(15, 45), Location: "Room 4.12", Organizer: "Service Desk"})
		}
		out = append(out, OutlookEvent{Subject: "Payments stand-up", Start: at(9, 30), End: at(9, 45), Location: "Teams", Organizer: "Team lead"})
	}
	return out
}

// liveLogs keeps the demo servers' logs moving and delivers new emails.
func (l *demoLab) liveLogs() {
	msgs := []struct{ level, msg string }{
		{"INFO ", "c.a.pay.Api - POST /api/payments 201 %d ms"},
		{"INFO ", "c.a.pay.Api - GET /api/payments/%d 200 14 ms"},
		{"INFO ", "c.a.pay.RefundService - refund %d sent for approval"},
		{"WARN ", "c.a.pay.RateLimiter - Slow response from TPP gateway: %d ms"},
		{"ERROR", "c.a.pay.PaymentService - Payment %d failed: ORA-00060: deadlock detected while waiting for resource"},
		{"INFO ", "c.a.pay.Api - GET /actuator/health 200 2 ms"},
	}
	for i := 0; ; i++ {
		time.Sleep(4 * time.Second)
		if l.a.demo.Load() != l {
			return
		}
		m := msgs[mrand.Intn(len(msgs))]
		if m.level == "ERROR" && mrand.Intn(3) > 0 {
			m = msgs[0]
		}
		for _, k := range []string{"app1", "app2", "prod"} {
			l.logLine(k, m.level, fmt.Sprintf(m.msg, 700000+mrand.Intn(2400)))
		}
		if i%3 == 0 {
			l.logLine("batch", "INFO ", fmt.Sprintf("c.a.batch.Eod - processed %d settlement rows", 100+mrand.Intn(900)))
		}
		if i%45 == 44 { // every 3 minutes: a new email
			l.mu.Lock()
			l.inbox = append(l.inbox, l.mail(l.sent, time.Now()))
			l.sent++
			if len(l.inbox) > 50 {
				l.inbox = l.inbox[len(l.inbox)-50:]
			}
			l.mu.Unlock()
		}
	}
}

// --- the made-up files on each pretend server ---

func seedDemoFiles(h *demoHost, kind string) {
	if _, err := os.Stat(h.root); err == nil {
		return
	}
	w := func(rel, body string, mode os.FileMode) {
		p := h.real(rel)
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		_ = os.WriteFile(p, []byte(body), mode)
	}
	now := time.Now()
	logText := func(n int, step time.Duration) string {
		var b strings.Builder
		for i := 0; i < n; i++ {
			t := now.Add(time.Duration(i-n) * step).Format("2006-01-02 15:04:05,000")
			switch {
			case i%97 == 0:
				fmt.Fprintf(&b, "%s ERROR [pool-3-thread-%d] c.a.pay.PaymentService - Payment %d failed: ORA-00060: deadlock detected while waiting for resource\n\tat com.acme.pay.PaymentDao.save(PaymentDao.java:118)\n", t, i%8, 700000+i)
			case i%23 == 0:
				fmt.Fprintf(&b, "%s WARN  [http-nio-8443-exec-%d] c.a.pay.RateLimiter - Slow response from TPP gateway: %d ms\n", t, i%20, 1800+i)
			default:
				fmt.Fprintf(&b, "%s INFO  [http-nio-8443-exec-%d] c.a.pay.Api - POST /api/payments 201 %d ms\n", t, i%20, 20+i%90)
			}
		}
		return b.String()
	}
	home := h.home()
	if kind != "partner" && kind != "ftp" {
		w(home+"/.bash_history", "cd /opt/payments/logs\ntail -f application.log\ngrep ERROR application.log | tail\ndf -h\n", 0o600)
		w(home+"/notes.txt", "Restart order: batch first, then app servers. See the runbook in Confluence (OPS).\n", 0o644)
		w("/etc/hostname", h.name+"\n", 0o644)
		w("/etc/os-release", "NAME=\"Red Hat Enterprise Linux\"\nVERSION=\"9.4 (Plow)\"\nID=\"rhel\"\n", 0o644)
		w("/var/log/messages", fmt.Sprintf("%s %s systemd[1]: Started Session 42 of User %s.\n", now.Add(-time.Hour).Format("Jan _2 15:04:05"), h.name, h.user), 0o644)
		_ = os.MkdirAll(h.real("/tmp"), 0o755)
	}
	switch kind {
	case "app":
		env := strings.ToLower(orDefault(map[string]string{"prod": "prod"}[h.key], "uat"))
		w("/opt/payments/bin/restart.sh", "#!/bin/bash\n# Restarts the payments API\necho 'Stopping pay-api...'\nsleep 1\necho 'Starting pay-api 4.3.0-rc1...'\nsleep 1\necho 'pay-api is UP (http://localhost:8443/actuator/health)'\n", 0o755)
		w("/opt/payments/bin/status.sh", "#!/bin/bash\nsystemctl status pay-api\n", 0o755)
		w("/opt/payments/config/application.properties", fmt.Sprintf("server.port=8443\nspring.profiles.active=%s\nspring.datasource.url=jdbc:postgresql://db-01.%s.acme.example.com:5432/payments\nspring.datasource.username=pay_app\nrefund.limit.tierA=5000\nrefund.limit.tierB=2500\nrefund.limit.tierC=1000\ntpp.gateway.url=https://tpp-01.%s.acme.example.com/gateway\nfeature.instant-payments=true\n", env, env, env), 0o644)
		w("/opt/payments/config/logback.xml", "<configuration>\n  <appender name=\"FILE\" class=\"ch.qos.logback.core.FileAppender\">\n    <file>/opt/payments/logs/application.log</file>\n  </appender>\n  <root level=\"INFO\"><appender-ref ref=\"FILE\"/></root>\n</configuration>\n", 0o644)
		w("/opt/payments/logs/application.log", logText(400, 37*time.Second), 0o644)
		w("/opt/payments/logs/access.log", "10.0.0.15 - - ["+now.Format("02/Jan/2006:15:04:05 -0700")+"] \"GET /actuator/health HTTP/1.1\" 200 52\n", 0o644)
		w("/opt/payments/logs/gc.log", "[0.012s][info][gc] Using G1\n[41.2s][info][gc] GC(12) Pause Young (Normal) 812M->402M(4096M) 9.871ms\n", 0o644)
		w("/opt/payments/releases/pay-api-4.2.7.war", "PK demo", 0o644)
		w("/opt/payments/releases/pay-api-4.3.0-rc1.war", "PK demo", 0o644)
		w("/opt/tomcat/logs/catalina.out", logText(60, 3*time.Minute), 0o644)
	case "batch":
		w("/opt/batch/bin/start.sh", "#!/bin/bash\necho 'Starting refund batch...'\nsleep 1\necho 'Batch started (8 threads)'\n", 0o755)
		w("/opt/batch/bin/stop.sh", "#!/bin/bash\necho 'Waiting for the queue to drain...'\nsleep 1\necho 'Batch stopped'\n", 0o755)
		w("/opt/batch/bin/run_eod.sh", "#!/bin/bash\n# End-of-day settlement\necho \"Starting EOD $(date)\"\nsleep 1\necho 'Read 1,204 payments, 18 merchants'\nsleep 1\necho 'Wrote SETTLEMENT file to /opt/batch/outbound'\necho 'EOD finished OK'\n", 0o755)
		w("/opt/batch/config/batch.properties", "batch.threads=8\nbatch.window.start=01:00\nbatch.window.end=05:30\ndb.url=jdbc:postgresql://db-01.uat.acme.example.com:5432/payments\n", 0o644)
		w("/opt/batch/logs/batch.log", logText(200, 90*time.Second), 0o644)
		w("/opt/batch/logs/eod.log", "EOD "+now.AddDate(0, 0, -1).Format("2006-01-02")+" 01:00 started\nEOD 01:23 finished OK (1,204 rows)\n", 0o644)
		for d := 1; d <= 3; d++ {
			day := now.AddDate(0, 0, -d).Format("20060102")
			w("/opt/batch/inbound/SETTLEMENT_"+day+".csv", "id,merchant,amount,currency,status\n1001,Northwind Books,250.00,GBP,SETTLED\n1002,Contoso Travel,13.50,EUR,REJECTED\n1003,Tailspin Toys,999.99,EUR,SETTLED\n", 0o644)
			w("/opt/batch/outbound/REPORT_"+day+".csv", "merchant,payments,total\nNorthwind Books,41,8203.10\nContoso Travel,17,2210.00\n", 0o644)
		}
		_ = os.MkdirAll(h.real("/opt/batch/archive"), 0o755)
	case "partner":
		w("/README.txt", "Acme Bank partner drop (demo).\n/inbound  - files from the partner\n/outbound - files for the partner\n", 0o644)
		for d := 1; d <= 4; d++ {
			day := now.AddDate(0, 0, -d).Format("20060102")
			w("/inbound/SETTLEMENT_"+day+".csv", "id,amount,currency,status\n1001,250.00,GBP,SETTLED\n1002,13.50,GBP,REJECTED\n", 0o644)
		}
		w("/outbound/ACK_"+now.AddDate(0, 0, -1).Format("20060102")+".txt", "4 files received\n", 0o644)
	case "ftp":
		w("/welcome.txt", "Legacy reporting FTP (demo). Reports are in /reports, upload to /upload.\n", 0o644)
		for m := 0; m < 3; m++ {
			mon := now.AddDate(0, -m, 0).Format("2006-01")
			w("/reports/"+mon+"/merchant-volumes-"+mon+".csv", "merchant,payments,total\nNorthwind Books,1204,240812.50\nContoso Travel,511,98210.00\n", 0o644)
			w("/reports/"+mon+"/refunds-"+mon+".csv", "refund_id,payment_id,amount,status\n900012,700012,25.00,APPROVED\n", 0o644)
		}
		_ = os.MkdirAll(h.real("/upload"), 0o755)
	}
}
