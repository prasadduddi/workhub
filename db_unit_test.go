package main

import "testing"

func TestStatementKinds(t *testing.T) {
	for _, c := range []struct {
		sql          string
		query, plsql bool
	}{
		{"-- note; here\nselect 2 from dual", true, false},
		{"/* x */ WITH a AS (select 1 from dual) select * from a", true, false},
		{"update t set a = 1", false, false},
		{"BEGIN\n null;\nEND;", false, true},
		{"create or replace package body p as end;", false, true},
		{"(select 1) union (select 2)", true, false},
	} {
		h := stripLeadingComments(c.sql)
		if reQueryStart.MatchString(h) != c.query || rePLSQL.MatchString(h) != c.plsql {
			t.Errorf("%q: query=%v plsql=%v", c.sql, reQueryStart.MatchString(h), rePLSQL.MatchString(h))
		}
	}
	if dbKind(Entry{Port: 1521}) != "oracle" || dbKind(Entry{Protocol: "postgresql"}) != "postgres" {
		t.Error("dbKind")
	}
	_, dsn, err := dbDSN(Entry{Host: "db1", Protocol: "postgres", Extra: map[string]string{"database": "app"}}, "u", "p@ss:w/rd", "")
	if err != nil || dsn != "postgres://u:p%40ss%3Aw%2Frd@db1:5432/app?application_name=WorkHub&connect_timeout=15&sslmode=prefer" {
		t.Errorf("pg dsn %q %v", dsn, err)
	}
	if _, _, err := dbDSN(Entry{Host: "ora1", Protocol: "oracle"}, "u", "p", ""); err == nil {
		t.Error("oracle without service should ask for it")
	}
	if name, sid := dbName(Entry{URL: "jdbc:oracle:thin:@//h:1521/X", Extra: map[string]string{"service": "ORCLPDB"}}); name != "ORCLPDB" || sid {
		t.Errorf("dbName = %q %v", name, sid)
	}
}
