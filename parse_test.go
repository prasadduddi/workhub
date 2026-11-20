package main

import "testing"

func TestParseSamples(t *testing.T) {
	cases := []struct {
		name, text string
		want       []Finding
	}{
		{"kv block", "Server: app-prod-01.corp.local\nPort: 8443\nUser: svc_app\nPassword: S3cr3t!x", []Finding{{Host: "app-prod-01.corp.local", Port: 8443, Username: "svc_app", Password: "S3cr3t!x", Protocol: "https"}}},
		{"url + creds", "Login at https://jenkins.uat.example.com/login\nusername: admin\npwd = p@ss:w0rd", []Finding{{Host: "jenkins.uat.example.com", URL: "https://jenkins.uat.example.com/login", Protocol: "https", Username: "admin", Password: "p@ss:w0rd"}}},
		{"inventory", "10.20.1.5 user=root pass=abc123\n10.20.1.6:2222 user=deploy pass=xyz", []Finding{{Host: "10.20.1.5", Username: "root", Password: "abc123"}, {Host: "10.20.1.6", Port: 2222, Username: "deploy", Password: "xyz", Protocol: ""}}},
		{"ssh cmd", "ssh -p 2201 oracle@dbsrv01", []Finding{{Host: "dbsrv01", Port: 2201, Username: "oracle", Protocol: "ssh"}}},
		{"jdbc", "jdbc:oracle:thin:@//ora-dev.corp.com:1521/ORCLPDB", []Finding{{Host: "ora-dev.corp.com", Port: 1521, Protocol: "oracle", URL: "jdbc:oracle:thin:@//ora-dev.corp.com:1521/ORCLPDB", Extra: map[string]string{"service": "ORCLPDB"}}}},
		{"noise", "see config.yaml and README.md, e.g. run main.py", nil},
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
