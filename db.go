package main

import (
	"context"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/stdlib"
	go_ora "github.com/sijms/go-ora/v2"
)

// dbSess is one open database connection from the SQL page. Statements run
// one at a time on a dedicated connection so session state (ALTER SESSION,
// SET search_path, open transactions) behaves like SQL Developer or psql.
type dbSess struct {
	mu    sync.Mutex // serialises statements
	kind  string     // "oracle" or "postgres"
	db    *sql.DB
	conn  *sql.Conn
	tx    *sql.Tx
	entry Entry

	cmu    sync.Mutex
	cancel context.CancelFunc

	omu    sync.Mutex
	output []string // PostgreSQL notices (RAISE NOTICE) for the running statement
}

func (s *dbSess) addOutput(line string) {
	s.omu.Lock()
	defer s.omu.Unlock()
	if len(s.output) < 10000 {
		s.output = append(s.output, line)
	}
}

func (s *dbSess) takeOutput() []string {
	s.omu.Lock()
	defer s.omu.Unlock()
	out := s.output
	s.output = nil
	return out
}

// oracleOutput reads what PL/SQL printed with DBMS_OUTPUT.PUT_LINE.
func (s *dbSess) oracleOutput(ctx context.Context, q queryer) []string {
	var lines []string
	for len(lines) < 10000 {
		var line string
		var status int
		_, err := q.ExecContext(ctx, "BEGIN DBMS_OUTPUT.GET_LINE(:1, :2); END;",
			go_ora.Out{Dest: &line, Size: 32767}, go_ora.Out{Dest: &status})
		if err != nil || status != 0 {
			break
		}
		lines = append(lines, line)
	}
	return lines
}

type dbManager struct {
	mu sync.Mutex
	m  map[string]*dbSess
}

func newDBManager() *dbManager { return &dbManager{m: map[string]*dbSess{}} }

func (m *dbManager) get(id string) (*dbSess, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s := m.m[id]; s != nil {
		return s, nil
	}
	return nil, errors.New("database session closed; reconnect")
}

func dbKind(e Entry) string {
	switch e.Protocol {
	case "oracle":
		return "oracle"
	case "postgres", "postgresql":
		return "postgres"
	}
	switch e.Port {
	case 1521, 1522:
		return "oracle"
	case 5432:
		return "postgres"
	}
	return ""
}

// dbName finds the Oracle service/SID or PostgreSQL database for an entry.
func dbName(e Entry) (name string, isSID bool) {
	for _, k := range []string{"service", "service_name", "database", "db_name", "dbname"} {
		if v := e.Extra[k]; v != "" {
			return v, false
		}
	}
	if v := e.Extra["sid"]; v != "" {
		return v, true
	}
	if e.URL != "" && !strings.HasPrefix(strings.ToLower(e.URL), "jdbc:oracle") {
		raw := strings.TrimPrefix(e.URL, "jdbc:")
		if u, err := url.Parse(raw); err == nil {
			if p := strings.Trim(u.Path, "/"); p != "" {
				return p, false
			}
		}
	}
	return "", false
}

func dbDSN(e Entry, user, pass, database string) (driver, dsn string, err error) {
	name, isSID := dbName(e)
	if database != "" {
		name, isSID = database, false
	}
	switch dbKind(e) {
	case "oracle":
		port := e.Port
		if port == 0 {
			port = 1521
		}
		if name == "" {
			return "", "", errors.New("Oracle service name is needed")
		}
		opts := map[string]string{}
		if isSID {
			opts["SID"] = name
			name = ""
		}
		return "oracle", go_ora.BuildUrl(e.Host, port, name, user, pass, opts), nil
	case "postgres":
		port := e.Port
		if port == 0 {
			port = 5432
		}
		u := url.URL{Scheme: "postgres", User: url.UserPassword(user, pass), Host: net.JoinHostPort(e.Host, strconv.Itoa(port)), Path: "/" + orDefault(name, "postgres")}
		q := url.Values{}
		q.Set("sslmode", orDefault(e.Extra["sslmode"], "prefer"))
		q.Set("application_name", "WorkHub")
		q.Set("connect_timeout", "15")
		u.RawQuery = q.Encode()
		return "pgx", u.String(), nil
	}
	return "", "", errors.New("set the connection Type to oracle or postgres")
}

func (a *App) handleDBOpen(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ID       string `json:"id"`
		Username string `json:"username"`
		Password string `json:"password"`
		Database string `json:"database"`
		Save     bool   `json:"save"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	e, ok := a.store.Entry(in.ID)
	if !ok {
		writeErr(w, 404, errors.New("entry not found"))
		return
	}
	user, pass := orDefault(in.Username, e.Username), orDefault(in.Password, e.Password)
	driver, dsn, err := dbDSN(e, user, pass, in.Database)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	s := &dbSess{kind: dbKind(e), entry: e}
	var db *sql.DB
	if driver == "pgx" {
		cfg, perr := pgx.ParseConfig(dsn)
		if perr != nil {
			writeErr(w, 400, perr)
			return
		}
		cfg.OnNotice = func(_ *pgconn.PgConn, n *pgconn.Notice) { s.addOutput(n.Severity + ": " + n.Message) }
		db = stdlib.OpenDB(*cfg)
	} else if db, err = sql.Open(driver, dsn); err != nil {
		writeErr(w, 400, err)
		return
	}
	db.SetMaxOpenConns(3) // the query connection plus table browsing
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	conn, err := db.Conn(ctx)
	if err == nil {
		err = conn.PingContext(ctx)
	}
	a.store.SetStatus(e.ID, err)
	if err != nil {
		db.Close()
		writeErr(w, 502, err)
		return
	}
	if in.Save {
		a.store.SetCredentials(e.ID, in.Username, in.Password)
	}
	if in.Database != "" {
		key := "database"
		if dbKind(e) == "oracle" {
			key = "service"
		}
		a.store.SetExtra(e.ID, key, in.Database)
	}
	a.store.Touch(e.ID)

	s.db, s.conn = db, conn
	if s.kind == "oracle" {
		_, _ = conn.ExecContext(ctx, "BEGIN DBMS_OUTPUT.ENABLE(NULL); END;")
	}
	info := map[string]string{"kind": s.kind}
	var who, ver string
	if s.kind == "oracle" {
		_ = conn.QueryRowContext(ctx, "SELECT USER || ' @ ' || SYS_CONTEXT('USERENV','DB_NAME') FROM dual").Scan(&who)
		_ = conn.QueryRowContext(ctx, "SELECT banner FROM v$version WHERE ROWNUM = 1").Scan(&ver)
	} else {
		_ = conn.QueryRowContext(ctx, "SELECT current_user || ' @ ' || current_database()").Scan(&who)
		_ = conn.QueryRowContext(ctx, "SHOW server_version").Scan(&ver)
		ver = "PostgreSQL " + ver
	}
	info["user"], info["version"] = who, ver
	sid := randomHex(8)
	a.dbs.mu.Lock()
	a.dbs.m[sid] = s
	a.dbs.mu.Unlock()
	info["sid"] = sid
	writeJSON(w, info)
}

func (a *App) handleDBClose(w http.ResponseWriter, r *http.Request) {
	var in struct {
		SID string `json:"sid"`
	}
	_ = readJSON(r, &in)
	a.dbs.mu.Lock()
	s := a.dbs.m[in.SID]
	delete(a.dbs.m, in.SID)
	a.dbs.mu.Unlock()
	if s != nil {
		s.stop()
		go func() {
			s.mu.Lock()
			defer s.mu.Unlock()
			if s.tx != nil {
				_ = s.tx.Rollback() // closing a tab never commits
			}
			s.conn.Close()
			s.db.Close()
		}()
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *dbSess) stop() {
	s.cmu.Lock()
	defer s.cmu.Unlock()
	if s.cancel != nil {
		s.cancel()
	}
}

func (a *App) handleDBCancel(w http.ResponseWriter, r *http.Request) {
	var in struct {
		SID string `json:"sid"`
	}
	_ = readJSON(r, &in)
	if s, err := a.dbs.get(in.SID); err == nil {
		s.stop()
	}
	writeJSON(w, map[string]bool{"ok": true})
}

var (
	reQueryStart = regexp.MustCompile(`(?is)^\s*(\(\s*)*(select|with|show|explain|values|table|desc|describe)\b`)
	reReturning  = regexp.MustCompile(`(?i)\breturning\b`)
	rePLSQL      = regexp.MustCompile(`(?is)^\s*(declare|begin|create\s+(or\s+replace\s+)?(editionable\s+|noneditionable\s+)?(procedure|function|package|trigger|type))\b`)
	reTxCmd      = regexp.MustCompile(`(?i)^\s*(commit|rollback)\s*(work)?\s*;?\s*$`)
)

type execResult struct {
	Columns   []string `json:"columns,omitempty"`
	Types     []string `json:"types,omitempty"`
	Rows      [][]any  `json:"rows,omitempty"`
	RowCount  int      `json:"row_count"`
	Truncated bool     `json:"truncated,omitempty"`
	Affected  int64    `json:"affected"`
	Message   string   `json:"message,omitempty"`
	ElapsedMS int64    `json:"elapsed_ms"`
	Output    []string `json:"output,omitempty"` // DBMS_OUTPUT / RAISE NOTICE
	InTx      bool     `json:"in_tx"`
}

type queryer interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// handleDBExec runs one statement. With auto-commit off, the first data
// change opens a transaction that stays open until Commit/Rollback.
func (a *App) handleDBExec(w http.ResponseWriter, r *http.Request) {
	var in struct {
		SID        string `json:"sid"`
		SQL        string `json:"sql"`
		MaxRows    int    `json:"max_rows"`
		AutoCommit bool   `json:"auto_commit"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	s, err := a.dbs.get(in.SID)
	if err != nil {
		writeErr(w, 410, err)
		return
	}
	stmt := strings.TrimSpace(in.SQL)
	head := stripLeadingComments(stmt) // what kind of statement it is
	if s.kind == "oracle" {
		if rePLSQL.MatchString(head) {
			stmt = strings.TrimSpace(strings.TrimSuffix(stmt, "/"))
		} else {
			stmt = strings.TrimRight(stmt, "; \t\r\n")
		}
	}
	if stmt == "" {
		writeErr(w, 400, errors.New("nothing to run"))
		return
	}
	maxRows := in.MaxRows
	if maxRows <= 0 {
		maxRows = 1000
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	s.cmu.Lock()
	s.cancel = cancel
	s.cmu.Unlock()
	defer cancel()

	start := time.Now()
	res := execResult{}
	s.takeOutput()
	var q queryer = s.conn
	done := func() {
		res.ElapsedMS = time.Since(start).Milliseconds()
		res.InTx = s.tx != nil
		res.Output = s.takeOutput()
		if s.kind == "oracle" {
			res.Output = append(res.Output, s.oracleOutput(context.Background(), q)...)
		}
		writeJSON(w, res)
	}
	fail := func(err error) {
		if errors.Is(ctx.Err(), context.Canceled) {
			err = errors.New("cancelled")
		}
		msg := err.Error()
		if s.kind == "postgres" && s.tx != nil && strings.Contains(msg, "SQLSTATE") {
			msg += " (the open transaction is now failed: press Rollback)"
		}
		writeErr(w, 400, errors.New(msg))
	}

	if m := reTxCmd.FindStringSubmatch(head); m != nil && s.tx != nil {
		if strings.EqualFold(m[1], "commit") {
			err = s.tx.Commit()
			res.Message = "Committed"
		} else {
			err = s.tx.Rollback()
			res.Message = "Rolled back"
		}
		s.tx = nil
		if err != nil {
			fail(err)
			return
		}
		done()
		return
	}

	isQuery := reQueryStart.MatchString(head) || (s.kind == "postgres" && reReturning.MatchString(head))
	if !in.AutoCommit && s.tx == nil && !isQuery && !rePLSQL.MatchString(head) && reTxCmd.FindString(head) == "" {
		// A transaction must outlive this request, so it gets its own context.
		if s.tx, err = s.conn.BeginTx(context.Background(), nil); err != nil {
			fail(err)
			return
		}
	}
	if s.tx != nil {
		q = s.tx
	}

	if !isQuery {
		r, err := q.ExecContext(ctx, stmt)
		if err != nil {
			fail(err)
			return
		}
		res.Affected, _ = r.RowsAffected()
		res.Message = fmt.Sprintf("%d row(s) affected", res.Affected)
		if rePLSQL.MatchString(head) {
			res.Message = "PL/SQL procedure successfully completed"
			if !regexp.MustCompile(`(?i)^\s*(declare|begin)\b`).MatchString(head) {
				res.Message = "Created / replaced"
			}
		} else if !regexp.MustCompile(`(?i)^\s*(insert|update|delete|merge)\b`).MatchString(head) {
			res.Message = "Done"
		}
		done()
		return
	}

	rows, err := q.QueryContext(ctx, stmt)
	if err != nil {
		fail(err)
		return
	}
	defer rows.Close()
	res.Columns, _ = rows.Columns()
	if cts, err := rows.ColumnTypes(); err == nil {
		for _, ct := range cts {
			res.Types = append(res.Types, ct.DatabaseTypeName())
		}
	}
	n := len(res.Columns)
	vals := make([]any, n)
	ptrs := make([]any, n)
	for i := range vals {
		ptrs[i] = &vals[i]
	}
	res.Rows = [][]any{}
	for rows.Next() {
		if len(res.Rows) >= maxRows {
			res.Truncated = true
			break
		}
		if err := rows.Scan(ptrs...); err != nil {
			fail(err)
			return
		}
		row := make([]any, n)
		for i, v := range vals {
			row[i] = cellValue(v)
		}
		res.Rows = append(res.Rows, row)
	}
	if err := rows.Err(); err != nil && !res.Truncated {
		fail(err)
		return
	}
	res.RowCount = len(res.Rows)
	done()
}

// stripLeadingComments drops leading "--" and "/* */" comments so the
// statement type can be recognised.
func stripLeadingComments(s string) string {
	for {
		s = strings.TrimSpace(s)
		switch {
		case strings.HasPrefix(s, "--"):
			if i := strings.IndexByte(s, '\n'); i >= 0 {
				s = s[i+1:]
			} else {
				return ""
			}
		case strings.HasPrefix(s, "/*"):
			if i := strings.Index(s, "*/"); i >= 0 {
				s = s[i+2:]
			} else {
				return ""
			}
		default:
			return s
		}
	}
}

// cellValue turns driver values into JSON-friendly text (numbers as text so
// large NUMBER/numeric values keep their precision).
func cellValue(v any) any {
	switch x := v.(type) {
	case nil:
		return nil
	case []byte:
		if utf8.Valid(x) {
			return string(x)
		}
		if len(x) > 256 {
			return "0x" + strings.ToUpper(hex.EncodeToString(x[:256])) + "…"
		}
		return "0x" + strings.ToUpper(hex.EncodeToString(x))
	case time.Time:
		if x.Nanosecond() != 0 {
			return x.Format("2006-01-02 15:04:05.000")
		}
		return x.Format("2006-01-02 15:04:05")
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case float32:
		return strconv.FormatFloat(float64(x), 'f', -1, 32)
	case string:
		return x
	default:
		return fmt.Sprint(x)
	}
}

func (a *App) handleDBTx(w http.ResponseWriter, r *http.Request) {
	var in struct {
		SID    string `json:"sid"`
		Action string `json:"action"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	s, err := a.dbs.get(in.SID)
	if err != nil {
		writeErr(w, 410, err)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.tx == nil {
		writeJSON(w, map[string]any{"message": "Nothing to " + in.Action, "in_tx": false})
		return
	}
	if in.Action == "commit" {
		err = s.tx.Commit()
	} else {
		err = s.tx.Rollback()
	}
	s.tx = nil
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	msg := "Committed"
	if in.Action != "commit" {
		msg = "Rolled back"
	}
	writeJSON(w, map[string]any{"message": msg, "in_tx": false})
}

// handleDBObjects lists tables and views: the user's own, or any matching
// the filter.
func (a *App) handleDBObjects(w http.ResponseWriter, r *http.Request) {
	s, err := a.dbs.get(r.URL.Query().Get("sid"))
	if err != nil {
		writeErr(w, 410, err)
		return
	}
	f := strings.TrimSpace(r.URL.Query().Get("filter"))
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	var rows *sql.Rows
	if s.kind == "oracle" {
		if f == "" {
			rows, err = s.db.QueryContext(ctx, `SELECT owner, object_name, object_type FROM all_objects
				WHERE owner = USER AND object_type IN ('TABLE','VIEW','MATERIALIZED VIEW') ORDER BY object_type, object_name`)
		} else {
			rows, err = s.db.QueryContext(ctx, `SELECT * FROM (SELECT owner, object_name, object_type FROM all_objects
				WHERE object_type IN ('TABLE','VIEW','MATERIALIZED VIEW','SYNONYM') AND object_name LIKE :1
				ORDER BY CASE WHEN owner = USER THEN 0 ELSE 1 END, owner, object_name) WHERE ROWNUM <= 500`, "%"+strings.ToUpper(f)+"%")
		}
	} else {
		rows, err = s.db.QueryContext(ctx, `SELECT table_schema, table_name, table_type FROM information_schema.tables
			WHERE table_schema NOT IN ('pg_catalog','information_schema') AND ($1 = '' OR table_name ILIKE '%' || $1 || '%')
			ORDER BY CASE WHEN table_schema = current_schema() THEN 0 ELSE 1 END, table_schema, table_name LIMIT 500`, f)
	}
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	defer rows.Close()
	type obj struct {
		Schema string `json:"schema"`
		Name   string `json:"name"`
		Type   string `json:"type"`
	}
	out := []obj{}
	for rows.Next() {
		var o obj
		if rows.Scan(&o.Schema, &o.Name, &o.Type) == nil {
			out = append(out, o)
		}
	}
	writeJSON(w, out)
}

func (a *App) handleDBColumns(w http.ResponseWriter, r *http.Request) {
	s, err := a.dbs.get(r.URL.Query().Get("sid"))
	if err != nil {
		writeErr(w, 410, err)
		return
	}
	schema, table := r.URL.Query().Get("schema"), r.URL.Query().Get("table")
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	var rows *sql.Rows
	if s.kind == "oracle" {
		rows, err = s.db.QueryContext(ctx, `SELECT column_name,
			data_type || CASE WHEN data_type IN ('VARCHAR2','NVARCHAR2','CHAR','NCHAR','RAW') THEN '(' || data_length || ')'
			                  WHEN data_type = 'NUMBER' AND data_precision IS NOT NULL THEN '(' || data_precision || ',' || data_scale || ')' END,
			nullable FROM all_tab_columns WHERE owner = :1 AND table_name = :2 ORDER BY column_id`, schema, table)
	} else {
		rows, err = s.db.QueryContext(ctx, `SELECT column_name,
			data_type || COALESCE('(' || character_maximum_length || ')', ''), CASE is_nullable WHEN 'YES' THEN 'Y' ELSE 'N' END
			FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`, schema, table)
	}
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	defer rows.Close()
	type col struct {
		Name     string `json:"name"`
		Type     string `json:"type"`
		Nullable string `json:"nullable"`
	}
	out := []col{}
	for rows.Next() {
		var c col
		var typ sql.NullString
		if rows.Scan(&c.Name, &typ, &c.Nullable) == nil {
			c.Type = typ.String
			out = append(out, c)
		}
	}
	writeJSON(w, out)
}
