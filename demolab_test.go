package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jlaffaye/ftp"
	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

// startTestLab: a demo workspace with its pretend servers, in a temp folder.
func startTestLab(t *testing.T) (*App, *demoLab) {
	t.Helper()
	dir := t.TempDir()
	store, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	seedSample(store)
	a := &App{store: store, dataDir: dir, dbs: newDBManager(), sftp: newSFTPManager(), mailNow: make(chan struct{}, 1)}
	a.startDemoLab()
	l := a.demo.Load()
	if l == nil {
		t.Fatal("the demo lab didn't start")
	}
	t.Cleanup(func() { a.demo.Store(nil); time.Sleep(50 * time.Millisecond); l.db.Close() })
	return a, l
}

func demoSSH(t *testing.T, l *demoLab, key string) *ssh.Client {
	t.Helper()
	h := l.hosts[key]
	c, err := ssh.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", l.port(key)), &ssh.ClientConfig{User: h.user, Auth: []ssh.AuthMethod{ssh.Password(h.pass)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), Timeout: 5 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

func TestDemoLabSSH(t *testing.T) {
	_, l := startTestLab(t)
	c := demoSSH(t, l, "app1")
	run := func(cmd string) string {
		s, err := c.NewSession()
		if err != nil {
			t.Fatal(err)
		}
		defer s.Close()
		out, _ := s.CombinedOutput(cmd)
		return string(out)
	}
	if got := run("hostname && whoami"); got != "pay-app-01\ndeploy\n" {
		t.Fatalf("hostname: %q", got)
	}
	if got := run("cd /opt/payments/logs; grep -c ERROR application.log"); strings.TrimSpace(got) == "0" || strings.Contains(got, "No such") {
		t.Fatalf("grep: %q", got)
	}
	if got := run("ls /opt/payments | sort -r | head -n 1"); got != "releases\n" {
		t.Fatalf("pipe: %q", got)
	}
	if got := run("echo hello > /tmp/x.txt && cat /tmp/x.txt"); got != "hello\n" {
		t.Fatalf("redirect: %q", got)
	}
	// nothing outside the demo folder: .. stops at the server's "/"
	if got := run("cat ../../../../../../../../etc/os-release"); !strings.Contains(got, "Red Hat") {
		t.Fatalf("jail: %q", got)
	}
	if got := run("ls /Users /home/deploy/../../../.."); strings.Contains(got, "prasad") || strings.Contains(got, "Library") {
		t.Fatalf("escaped the demo folder: %q", got)
	}
	if got := run("rm -rf /"); !strings.Contains(got, "refusing") {
		t.Fatalf("rm -rf /: %q", got)
	}
	if got := run("nosuchcmd"); !strings.Contains(got, "command not found") {
		t.Fatalf("unknown: %q", got)
	}
	// WorkHub's terminal start-up: PID marker, then a shell that follows cd
	s, _ := c.NewSession()
	_ = s.RequestPty("xterm", 40, 120, ssh.TerminalModes{})
	in, _ := s.StdinPipe()
	var out bytes.Buffer
	s.Stdout = &out
	if err := s.Start(`cd '/opt/batch' 2>/dev/null; printf '\033]7777;%s\007' $$; exec "$SHELL" -l`); err != nil {
		t.Fatal(err)
	}
	io.WriteString(in, "cd /opt/payments/logs\rpwd\r")
	time.Sleep(300 * time.Millisecond)
	m := pidMarker.FindSubmatch(out.Bytes())
	if m == nil || !strings.Contains(out.String(), "/opt/payments/logs") {
		t.Fatalf("terminal: %q", out.String())
	}
	if got := run("readlink /proc/" + string(m[1]) + "/cwd 2>/dev/null || pwdx " + string(m[1])); got != "/opt/payments/logs\n" {
		t.Fatalf("folder tracking: %q", got)
	}
	io.WriteString(in, "exit\r")
	s.Wait()
	// tunnels go only to the demo database
	if _, err := c.Dial("tcp", "10.0.0.1:22"); err == nil {
		t.Fatal("a tunnel to another host was allowed")
	}
	if conn, err := c.Dial("tcp", "db-01.uat.acme.example.com:5432"); err != nil {
		t.Fatalf("tunnel to the demo DB: %v", err)
	} else {
		conn.Close()
	}
}

func TestDemoLabSFTPJail(t *testing.T) {
	_, l := startTestLab(t)
	sc, err := sftp.NewClient(demoSSH(t, l, "partner"))
	if err != nil {
		t.Fatal(err)
	}
	defer sc.Close()
	if wd, _ := sc.Getwd(); wd != "/" {
		t.Fatalf("home %q", wd)
	}
	ls, err := sc.ReadDir("/../../..")
	if err != nil || len(ls) == 0 || ls[0].Name() != "README.txt" && ls[0].Name() != "inbound" {
		t.Fatalf("ls /../..: %v %v", ls, err)
	}
	f, err := sc.Create("/outbound/report.csv")
	if err != nil {
		t.Fatal(err)
	}
	f.Write([]byte("a,b\n"))
	f.Close()
	if b, _ := os.ReadFile(filepath.Join(l.hosts["partner"].root, "outbound", "report.csv")); string(b) != "a,b\n" {
		t.Fatalf("upload landed in %q", b)
	}
	if err := sc.Symlink("/etc/passwd", "/inbound/x"); err == nil {
		t.Fatal("symlinks must be refused")
	}
}

func TestDemoLabFTP(t *testing.T) {
	_, l := startTestLab(t)
	c, err := ftp.Dial(fmt.Sprintf("127.0.0.1:%d", l.port("ftp")), ftp.DialWithTimeout(5*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Quit()
	if err := c.Login("ftpuser", "wrong"); err == nil {
		t.Fatal("a wrong password logged in")
	}
	if err := c.Login("ftpuser", "Ftp#2026"); err != nil {
		t.Fatal(err)
	}
	list, err := c.List("/reports")
	if err != nil || len(list) != 3 {
		t.Fatalf("list: %v %v", list, err)
	}
	if err := c.Stor("/upload/hello.txt", strings.NewReader("hi")); err != nil {
		t.Fatal(err)
	}
	r, err := c.Retr("/upload/hello.txt")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(r)
	r.Close()
	if string(b) != "hi" {
		t.Fatalf("retr %q", b)
	}
	if _, err := c.Retr("/../../../../etc/passwd"); err == nil {
		t.Fatal("read outside the FTP folder")
	}
}

func TestDemoLabPostgres(t *testing.T) {
	_, l := startTestLab(t)
	connect := func(user, pass string) (*pgx.Conn, error) {
		cfg, _ := pgx.ParseConfig(fmt.Sprintf("postgres://%s:%s@127.0.0.1:%d/payments?sslmode=disable", user, pass, l.port("pg")))
		cfg.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
		return pgx.ConnectConfig(context.Background(), cfg)
	}
	if _, err := connect("pay_app", "nope"); err == nil || !strings.Contains(err.Error(), "password authentication failed") {
		t.Fatalf("wrong password: %v", err)
	}
	c, err := connect("pay_app", "Pay#App26")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close(context.Background())
	ctx := context.Background()
	var n int64
	if err := c.QueryRow(ctx, "SELECT count(*) FROM public.payments WHERE status = $1", "FAILED").Scan(&n); err != nil || n == 0 {
		t.Fatalf("count: %d %v", n, err)
	}
	var lim float64
	if err := c.QueryRow(ctx, "SELECT daily_refund_limit FROM merchants WHERE tier ILIKE 'a' LIMIT 1").Scan(&lim); err != nil || lim != 5000 {
		t.Fatalf("numeric: %v %v", lim, err)
	}
	tx, _ := c.Begin(ctx)
	tx.Exec(ctx, "UPDATE merchants SET daily_refund_limit = 1 WHERE tier = 'A'")
	tx.Rollback(ctx)
	if c.QueryRow(ctx, "SELECT daily_refund_limit FROM merchants WHERE tier = 'A' LIMIT 1").Scan(&lim); lim != 5000 {
		t.Fatalf("rollback kept the change: %v", lim)
	}
	if _, err := c.Exec(ctx, "SELECT * FROM nosuch"); err == nil || !strings.Contains(err.Error(), `relation "nosuch" does not exist`) {
		t.Fatalf("missing table: %v", err)
	}
	ro, err := connect("pay_ro", "PayRO#26")
	if err != nil {
		t.Fatal(err)
	}
	defer ro.Close(ctx)
	if _, err := ro.Exec(ctx, "DELETE FROM payments"); err == nil || !strings.Contains(err.Error(), "read-only") {
		t.Fatalf("read-only user changed data: %v", err)
	}
}

func TestDemoLabJiraMailMonitor(t *testing.T) {
	a, l := startTestLab(t)
	req, _ := http.NewRequest("GET", fmt.Sprintf("http://127.0.0.1:%d/rest/api/2/issue/PAY-301", l.port("jira")), nil)
	req.Header.Set("Authorization", "Bearer "+demoJiraToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var iss struct {
		Fields struct{ Summary string } `json:"fields"`
	}
	json.NewDecoder(resp.Body).Decode(&iss)
	resp.Body.Close()
	if iss.Fields.Summary != "Refund limits per merchant" {
		t.Fatalf("jira: %+v", iss)
	}
	if !strings.HasSuffix(a.store.JiraConfig().BaseURL, fmt.Sprint(l.port("jira"))) {
		t.Fatalf("jira not pointed at the demo: %s", a.store.JiraConfig().BaseURL)
	}
	a.checkMail()
	if a.mail.Captured == 0 || a.mail.LastError != "" {
		t.Fatalf("mail: captured %d, error %q", a.mail.Captured, a.mail.LastError)
	}
	if got := l.meetings(time.Now(), time.Now().AddDate(0, 0, 7)); len(got) < 5 {
		t.Fatalf("meetings: %d", len(got))
	}
	n := 0
	for _, c := range a.store.Settings().Monitor.Checks {
		if strings.HasPrefix(c.ID, "demo-") {
			n++
		}
	}
	if n < 5 {
		t.Fatalf("monitor checks: %d", n)
	}
	// every demo connection points at a running pretend server
	for _, e := range a.store.Entries() {
		if role := a.store.Settings().Demo.Roles[e.ID]; role != "" && !strings.HasPrefix(role, "url:") && role != "pg-tunnel" {
			base, _, _ := strings.Cut(role, "#")
			if e.Port != l.port(base) {
				t.Fatalf("%s: port %d, server on %d", e.Name, e.Port, l.port(base))
			}
		}
	}
	// a normal workspace starts nothing
	b := &App{store: func() *Store { s, _ := OpenStore(t.TempDir()); return s }(), dataDir: t.TempDir()}
	b.startDemoLab()
	if b.demo.Load() != nil {
		t.Fatal("a normal workspace started the demo lab")
	}
}
