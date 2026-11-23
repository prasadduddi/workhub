package main

import (
	"strings"
	"testing"
)

func TestParseSamples(t *testing.T) {
	cases := []struct {
		name, text string
		want       []Finding
	}{
		{"kv block", "Server: app-prod-01.corp.local\nPort: 8443\nUser: svc_app\nPassword: S3cr3t!x", []Finding{{Host: "app-prod-01.corp.local", Port: 8443, Username: "svc_app", Password: "S3cr3t!x", Protocol: "https"}}},
		{"url + creds", "Login at https://jenkins.uat.example.com/login\nusername: admin\npwd = p@ss:w0rd", []Finding{{Host: "jenkins.uat.example.com", URL: "https://jenkins.uat.example.com/login", Protocol: "https", Username: "admin", Password: "p@ss:w0rd"}}},
		{"inventory", "192.0.2.5 user=root pass=abc123\n192.0.2.6:2222 user=deploy pass=xyz", []Finding{{Host: "192.0.2.5", Username: "root", Password: "abc123"}, {Host: "192.0.2.6", Port: 2222, Username: "deploy", Password: "xyz", Protocol: ""}}},
		{"ssh cmd", "ssh -p 2201 oracle@dbsrv01", []Finding{{Host: "dbsrv01", Port: 2201, Username: "oracle", Protocol: "ssh"}}},
		{"jdbc", "jdbc:oracle:thin:@//ora-dev.corp.com:1521/ORCLPDB", []Finding{{Host: "ora-dev.corp.com", Port: 1521, Protocol: "oracle", URL: "jdbc:oracle:thin:@//ora-dev.corp.com:1521/ORCLPDB", Extra: map[string]string{"service": "ORCLPDB"}}}},
		{"db with database name", "app DB: db1-uat.corp.example.com, database: appdb1, username/password: app_user", []Finding{{Host: "db1-uat.corp.example.com", Protocol: "oracle", Username: "app_user", Password: "app_user", Extra: map[string]string{"database": "appdb1"}}}},
		{"postgres word", "Postgres host: pg1.corp.example.com\nuser/pwd: rpt/S3cret", []Finding{{Host: "pg1.corp.example.com", Protocol: "postgres", Username: "rpt", Password: "S3cret"}}},
		{"noise", "see config.yaml and README.md, e.g. run main.py", nil},
		{"email address is not a server", "Hi, mail ann.lee@vendor.com or bob@corp.co.uk for access", nil},
		{"email plus real host", "From: Ann <ann@vendor.com>\nServer: db01.vendor.local", []Finding{{Host: "db01.vendor.local"}}},
	}
	for _, c := range cases {
		got := Parse(c.text)
		if len(got) != len(c.want) {
			t.Errorf("%s: got %d findings %+v, want %d", c.name, len(got), got, len(c.want))
			continue
		}
		for i := range got {
			g, w := got[i], c.want[i]
			if g.Host != w.Host || g.Port != w.Port || g.Username != w.Username || g.Password != w.Password || g.URL != w.URL || g.Protocol != w.Protocol {
				t.Errorf("%s[%d]: got %+v\n want %+v", c.name, i, g, w)
			}
		}
	}
}

func TestJDBC(t *testing.T) {
	cases := []struct {
		text                       string
		host, user, pass, key, val string
		port                       int
		proto                      string
	}{
		{"jdbc:oracle:thin:@//ora-uat.corp.local:1521/PAYUAT", "ora-uat.corp.local", "", "", "service", "PAYUAT", 1521, "oracle"},
		{"jdbc:oracle:thin:scott/tiger@dbhost01:1522:ORCL", "dbhost01", "scott", "tiger", "sid", "ORCL", 1522, "oracle"},
		{"jdbc:oracle:thin:app/s3cret@(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=ora-prod-scan)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=PAYPRD)))", "ora-prod-scan", "app", "s3cret", "service", "PAYPRD", 1521, "oracle"},
		{"jdbc:postgresql://pg-dev01:5432/orders?user=app&password=pw1&currentSchema=sales", "pg-dev01", "app", "pw1", "database", "orders", 5432, "postgresql"},
		{"spring.datasource.url=jdbc:postgresql://pg-uat.corp.local/billing", "pg-uat.corp.local", "", "", "database", "billing", 5432, "postgresql"},
	}
	for _, c := range cases {
		got := Parse(c.text)
		if len(got) != 1 {
			t.Errorf("%s: %d findings %+v", c.text, len(got), got)
			continue
		}
		f := got[0]
		if f.Host != c.host || f.Port != c.port || f.Username != c.user || f.Password != c.pass || f.Protocol != c.proto || f.Extra[c.key] != c.val {
			t.Errorf("%s:\n got %+v", c.text, f)
		}
		if strings.Contains(f.URL, "password") {
			t.Errorf("password kept in URL: %s", f.URL)
		}
	}
	// Captured from the clipboard it becomes a ready SQL connection.
	s, _ := OpenStore(t.TempDir())
	_, es := s.Ingest("jdbc:oracle:thin:scott/tiger@dbhost01:1522:ORCL", "clipboard", "")
	e, _ := s.Entry(es[0].ID)
	if dbKind(e) != "oracle" || e.Name != "dbhost01-scott / ORCL" {
		t.Fatalf("entry %+v", e)
	}
	if name, sid := dbName(e); name != "ORCL" || !sid {
		t.Fatalf("dbName = %q sid=%v", name, sid)
	}
	if _, dsn, err := dbDSN(e, e.Username, e.Password, ""); err != nil || !strings.Contains(dsn, "SID=ORCL") {
		t.Fatalf("dsn %q %v", dsn, err)
	}
}
