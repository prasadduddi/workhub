package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	embeddedpostgres "github.com/fergusstrange/embedded-postgres"
)

// TestPostgresQueryWindow runs the SQL page's API against a real, temporary
// PostgreSQL server. Skipped with -short (it downloads PostgreSQL once).
func TestPostgresQueryWindow(t *testing.T) {
	if testing.Short() {
		t.Skip("needs a temporary PostgreSQL server")
	}
	pg := embeddedpostgres.NewDatabase(embeddedpostgres.DefaultConfig().
		Port(54329).Username("tester").Password("pw").Database("app").
		RuntimePath(t.TempDir()).CachePath(os.TempDir() + "/workhub-pg-cache"))
	if err := pg.Start(); err != nil {
		t.Fatal(err)
	}
	defer pg.Stop()

	store, _ := OpenStore(t.TempDir())
	a := &App{store: store, dbs: newDBManager()}
	v, _ := store.SaveEntry(EntryInput{Name: "pg", Host: "127.0.0.1", Port: 54329, Protocol: "postgres", Username: "tester", Password: ptr("pw"),
		Extra: map[string]string{"database": "app"}})

	call := func(h http.HandlerFunc, method, url string, body any) (int, map[string]any) {
		b, _ := json.Marshal(body)
		rec := httptest.NewRecorder()
		h(rec, httptest.NewRequest(method, url, bytes.NewReader(b)))
		var out map[string]any
		json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out
	}
	code, open := call(a.handleDBOpen, "POST", "/api/db/open", map[string]any{"id": v.ID})
	if code != 200 {
		t.Fatalf("open: %d %v", code, open)
	}
	sid := open["sid"].(string)
	run := func(sql string, auto bool) map[string]any {
		code, r := call(a.handleDBExec, "POST", "/api/db/exec", map[string]any{"sid": sid, "sql": sql, "auto_commit": auto})
		if code != 200 {
			t.Fatalf("%s: %v", sql, r)
		}
		return r
	}
	if e, _ := store.Entry(v.ID); e.Status != "ok" {
		t.Fatalf("status after connect = %q", e.Status)
	}

	run("create table t (id int primary key, name text, created timestamp default now())", true)
	if r := run("insert into t (id, name) values (1, 'a'), (2, 'b')", false); r["affected"].(float64) != 2 || r["in_tx"] != true {
		t.Fatalf("insert in tx: %v", r)
	}
	if r := run("select * from t order by id", false); r["row_count"].(float64) != 2 {
		t.Fatalf("select inside tx: %v", r)
	}
	call(a.handleDBTx, "POST", "/api/db/tx", map[string]any{"sid": sid, "action": "rollback"})
	if r := run("select count(*) from t", false); r["rows"].([]any)[0].([]any)[0] != "0" {
		t.Fatalf("after rollback: %v", r)
	}
	run("insert into t (id, name) values (3, 'c')", true)
	if r := run("select name from t", false); r["row_count"].(float64) != 1 {
		t.Fatalf("auto-commit insert: %v", r)
	}
	r := run("DO $$ BEGIN RAISE NOTICE 'hello from plpgsql'; END $$", true)
	if out, _ := json.Marshal(r["output"]); !strings.Contains(string(out), "hello from plpgsql") {
		t.Fatalf("notice not captured: %v", r)
	}
	if r := run("insert into t (id) values (4) returning id", true); r["row_count"].(float64) != 1 {
		t.Fatalf("returning: %v", r)
	}

	// Stop cancels a long query.
	go func() {
		time.Sleep(500 * time.Millisecond)
		call(a.handleDBCancel, "POST", "/api/db/cancel", map[string]any{"sid": sid})
	}()
	if code, r := call(a.handleDBExec, "POST", "/api/db/exec", map[string]any{"sid": sid, "sql": "select pg_sleep(20)", "auto_commit": true}); code == 200 || !strings.Contains(r["error"].(string), "cancel") {
		t.Fatalf("cancel: %d %v", code, r)
	}

	rec := httptest.NewRecorder()
	a.handleDBObjects(rec, httptest.NewRequest("GET", "/api/db/objects?sid="+sid, nil))
	if !strings.Contains(rec.Body.String(), `"name":"t"`) {
		t.Fatalf("objects: %s", rec.Body.String())
	}
	rec = httptest.NewRecorder()
	a.handleDBColumns(rec, httptest.NewRequest("GET", "/api/db/columns?sid="+sid+"&schema=public&table=t", nil))
	if !strings.Contains(rec.Body.String(), `"name":"created"`) {
		t.Fatalf("columns: %s", rec.Body.String())
	}
	call(a.handleDBClose, "POST", "/api/db/close", map[string]any{"sid": sid})
}

func ptr(s string) *string { return &s }
