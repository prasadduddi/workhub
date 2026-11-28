package main

// A pretend PostgreSQL server for the demo workspace (see demolab.go). It
// speaks the PostgreSQL wire protocol (simple queries) and runs the SQL on a
// built-in SQLite file in the demo folder, so typed SQL really works —
// SELECT, joins, UPDATE, COMMIT / ROLLBACK. The catalog questions WorkHub's SQL
// page asks (schemas, tables, columns, indexes, DDL) are answered here from
// SQLite's own description of the tables. 127.0.0.1 only; made-up data.

import (
	"context"
	"database/sql"
	"fmt"
	"math/rand"
	"net"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgproto3"
	_ "modernc.org/sqlite"
)

// demoDBUser: who may sign in, and whether they may change data.
type demoDBUser struct {
	pass     string
	readOnly bool
}

var demoDBUsers = map[string]demoDBUser{
	"pay_app": {"Pay#App26", false}, // UAT application user
	"pay_ro":  {"PayRO#26", true},   // PROD read-only support user
}

const demoDBName = "payments"

// openDemoDB opens (and the first time fills) the SQLite file behind the pretend server.
func openDemoDB(path string) (*sql.DB, error) {
	fresh := !fileExists(path)
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)")
	if err != nil {
		return nil, err
	}
	if fresh {
		if err := seedDemoDB(db); err != nil {
			db.Close()
			os.Remove(path)
			return nil, err
		}
	}
	return db, nil
}

// seedDemoDB creates made-up payments data: merchants, payments, refunds,
// settlements and batch runs, dated around today.
func seedDemoDB(db *sql.DB) error {
	ddl := []string{
		`CREATE TABLE merchants (id integer PRIMARY KEY, name varchar(60) NOT NULL, tier varchar(1) NOT NULL, country varchar(2) NOT NULL,
			daily_refund_limit numeric(12,2) NOT NULL, onboarded date NOT NULL, active boolean NOT NULL DEFAULT 1)`,
		`CREATE TABLE payments (id bigint PRIMARY KEY, merchant_id integer NOT NULL REFERENCES merchants(id), amount numeric(12,2) NOT NULL,
			currency varchar(3) NOT NULL, status varchar(20) NOT NULL, channel varchar(10) NOT NULL, reference varchar(40) NOT NULL,
			created_at timestamp NOT NULL, error_code varchar(20))`,
		`CREATE TABLE refunds (id bigint PRIMARY KEY, payment_id bigint NOT NULL REFERENCES payments(id), amount numeric(12,2) NOT NULL,
			status varchar(20) NOT NULL, reason varchar(80), requested_at timestamp NOT NULL, approved_by varchar(30))`,
		`CREATE TABLE settlements (id integer PRIMARY KEY, batch_date date NOT NULL, merchant_id integer NOT NULL REFERENCES merchants(id),
			payments_count integer NOT NULL, total numeric(14,2) NOT NULL, status varchar(20) NOT NULL)`,
		`CREATE TABLE batch_runs (id integer PRIMARY KEY, job varchar(30) NOT NULL, started_at timestamp NOT NULL, finished_at timestamp,
			status varchar(20) NOT NULL, rows_processed integer NOT NULL DEFAULT 0, message varchar(200))`,
		`CREATE INDEX idx_payments_merchant ON payments (merchant_id, created_at)`,
		`CREATE INDEX idx_payments_status ON payments (status)`,
		`CREATE UNIQUE INDEX idx_payments_reference ON payments (reference)`,
		`CREATE INDEX idx_refunds_payment ON refunds (payment_id)`,
		`CREATE VIEW v_daily_volume AS SELECT date(created_at) AS day, currency, count(*) AS payments, sum(amount) AS total
			FROM payments WHERE status = 'SETTLED' GROUP BY date(created_at), currency`,
		`CREATE VIEW v_failed_payments AS SELECT p.id, m.name AS merchant, p.amount, p.currency, p.error_code, p.created_at
			FROM payments p JOIN merchants m ON m.id = p.merchant_id WHERE p.status = 'FAILED'`,
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, q := range ddl {
		if _, err := tx.Exec(q); err != nil {
			return fmt.Errorf("%v: %s", err, q)
		}
	}
	r := rand.New(rand.NewSource(2026))
	names := []string{"Northwind Books", "Blue Harbour Cafe", "Contoso Travel", "Fabrikam Sports", "Tailspin Toys", "Litware Software",
		"Adventure Works Cycles", "Wide World Importers", "Proseware Garden", "Lucerne Publishing", "Margie's Travel", "Alpine Ski House",
		"Coho Winery", "Trey Research", "Woodgrove Pharmacy", "Fourth Coffee", "Humongous Insurance", "Relecloud Media"}
	limits := map[string]float64{"A": 5000, "B": 2500, "C": 1000}
	now := time.Now().Truncate(time.Second)
	for i, n := range names {
		tier := []string{"A", "B", "C"}[i%3]
		_, err := tx.Exec(`INSERT INTO merchants VALUES (?,?,?,?,?,?,?)`, 100+i, n, tier, []string{"GB", "DE", "FR", "NL", "IE"}[i%5], limits[tier],
			now.AddDate(0, -3-i*2, -i).Format("2006-01-02"), i != 7)
		if err != nil {
			return err
		}
	}
	statuses := []string{"SETTLED", "SETTLED", "SETTLED", "SETTLED", "SETTLED", "SETTLED", "AUTHORISED", "PENDING", "FAILED", "REFUNDED"}
	errs := []string{"TIMEOUT", "INSUFFICIENT_FUNDS", "ORA-00060", "CARD_EXPIRED", "TPP_UNAVAILABLE"}
	for i := 0; i < 2400; i++ {
		st := statuses[r.Intn(len(statuses))]
		at := now.Add(-time.Duration(r.Intn(30*24*60)) * time.Minute)
		var ec any
		if st == "FAILED" {
			ec = errs[r.Intn(len(errs))]
		}
		amt := float64(r.Intn(90000)+500) / 100
		_, err := tx.Exec(`INSERT INTO payments VALUES (?,?,?,?,?,?,?,?,?)`, 700000+i, 100+r.Intn(len(names)), amt,
			[]string{"GBP", "EUR", "EUR", "USD"}[r.Intn(4)], st, []string{"CARD", "CARD", "OPEN_BANK", "SEPA"}[r.Intn(4)],
			fmt.Sprintf("PAY-%s-%06d", at.Format("20060102"), i), at.Format("2006-01-02 15:04:05"), ec)
		if err != nil {
			return err
		}
		if st == "REFUNDED" || (st == "SETTLED" && r.Intn(25) == 0) {
			rs := []string{"APPROVED", "APPROVED", "PENDING_APPROVAL", "REJECTED"}[r.Intn(4)]
			var by any
			if rs == "APPROVED" {
				by = []string{"a.khan", "j.smith", "m.rossi"}[r.Intn(3)]
			}
			_, err := tx.Exec(`INSERT INTO refunds VALUES (?,?,?,?,?,?,?)`, 900000+i, 700000+i, amt, rs,
				[]string{"Customer request", "Duplicate payment", "Goods not received", "Over the daily limit"}[r.Intn(4)],
				at.Add(time.Duration(r.Intn(48))*time.Hour).Format("2006-01-02 15:04:05"), by)
			if err != nil {
				return err
			}
		}
	}
	id := 1
	for d := 14; d >= 1; d-- {
		day := now.AddDate(0, 0, -d)
		for m := range names {
			st := "SETTLED"
			if d == 1 && m%6 == 0 {
				st = "PENDING"
			}
			if _, err := tx.Exec(`INSERT INTO settlements VALUES (?,?,?,?,?,?)`, id, day.Format("2006-01-02"), 100+m, 3+r.Intn(40),
				float64(r.Intn(4000000))/100, st); err != nil {
				return err
			}
			id++
		}
		start := time.Date(day.Year(), day.Month(), day.Day(), 1, 0, 0, 0, time.Local)
		for j, job := range []string{"EOD_SETTLEMENT", "REFUND_RETRY", "STATEMENTS"} {
			st, msg := "COMPLETED", "OK"
			if job == "REFUND_RETRY" && d%5 == 0 {
				st, msg = "FAILED", "ORA-00060: deadlock detected while waiting for resource"
			}
			s := start.Add(time.Duration(j*40) * time.Minute)
			if _, err := tx.Exec(`INSERT INTO batch_runs (job, started_at, finished_at, status, rows_processed, message) VALUES (?,?,?,?,?,?)`,
				job, s.Format("2006-01-02 15:04:05"), s.Add(time.Duration(5+r.Intn(30))*time.Minute).Format("2006-01-02 15:04:05"), st, r.Intn(5000), msg); err != nil {
				return err
			}
		}
	}
	return tx.Commit()
}

func (l *demoLab) servePG(ln net.Listener) {
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		go l.pgConn(c)
	}
}

type pgSess struct {
	l        *demoLab
	be       *pgproto3.Backend
	conn     *sql.Conn
	user     string
	readOnly bool
	tx       byte // 'I' idle, 'T' in a transaction
}

func (l *demoLab) pgConn(c net.Conn) {
	defer c.Close()
	be := pgproto3.NewBackend(c, c)
	var start *pgproto3.StartupMessage
	for start == nil {
		m, err := be.ReceiveStartupMessage()
		if err != nil {
			return
		}
		switch m := m.(type) {
		case *pgproto3.SSLRequest, *pgproto3.GSSEncRequest:
			if _, err := c.Write([]byte("N")); err != nil { // no TLS on a local demo
				return
			}
		case *pgproto3.StartupMessage:
			start = m
		case *pgproto3.CancelRequest:
			return
		}
	}
	user, db := start.Parameters["user"], orDefault(start.Parameters["database"], start.Parameters["user"])
	fail := func(code, msg string) {
		be.Send(&pgproto3.ErrorResponse{Severity: "FATAL", Code: code, Message: msg})
		be.Flush()
	}
	be.Send(&pgproto3.AuthenticationCleartextPassword{})
	if err := be.Flush(); err != nil {
		return
	}
	if err := be.SetAuthType(pgproto3.AuthTypeCleartextPassword); err != nil {
		return
	}
	m, err := be.Receive()
	if err != nil {
		return
	}
	pw, _ := m.(*pgproto3.PasswordMessage)
	u, ok := demoDBUsers[user]
	if !ok || pw == nil || pw.Password != u.pass {
		time.Sleep(300 * time.Millisecond)
		fail("28P01", fmt.Sprintf("password authentication failed for user \"%s\"", user))
		return
	}
	if db != demoDBName {
		fail("3D000", fmt.Sprintf("database \"%s\" does not exist (the demo database is \"%s\")", db, demoDBName))
		return
	}
	conn, err := l.db.Conn(context.Background())
	if err != nil {
		fail("57P03", err.Error())
		return
	}
	defer conn.Close()
	s := &pgSess{l: l, be: be, conn: conn, user: user, readOnly: u.readOnly, tx: 'I'}
	be.Send(&pgproto3.AuthenticationOk{})
	for k, v := range map[string]string{"server_version": "16.4", "server_encoding": "UTF8", "client_encoding": "UTF8", "DateStyle": "ISO, MDY",
		"integer_datetimes": "on", "standard_conforming_strings": "on", "TimeZone": "UTC", "application_name": start.Parameters["application_name"]} {
		be.Send(&pgproto3.ParameterStatus{Name: k, Value: v})
	}
	be.Send(&pgproto3.BackendKeyData{ProcessID: uint32(4000 + rand.Intn(5000)), SecretKey: []byte{byte(rand.Intn(256)), byte(rand.Intn(256)), byte(rand.Intn(256)), byte(rand.Intn(256))}})
	be.Send(&pgproto3.ReadyForQuery{TxStatus: 'I'})
	if be.Flush() != nil {
		return
	}
	for {
		m, err := be.Receive()
		if err != nil {
			return
		}
		switch m := m.(type) {
		case *pgproto3.Query:
			s.query(m.String)
			be.Send(&pgproto3.ReadyForQuery{TxStatus: s.tx})
		case *pgproto3.Terminate:
			if s.tx == 'T' {
				_, _ = conn.ExecContext(context.Background(), "ROLLBACK")
			}
			return
		case *pgproto3.Sync:
			be.Send(&pgproto3.ReadyForQuery{TxStatus: s.tx})
		case *pgproto3.Parse, *pgproto3.Bind, *pgproto3.Describe, *pgproto3.Execute:
			be.Send(&pgproto3.ErrorResponse{Severity: "ERROR", Code: "0A000", Message: "the demo database answers simple queries only"})
		}
		if be.Flush() != nil {
			return
		}
	}
}

// splitSQL splits a script at ; outside quotes and comments.
func splitSQL(q string) []string {
	var out []string
	var cur strings.Builder
	quote := byte(0)
	for i := 0; i < len(q); i++ {
		c := q[i]
		switch {
		case quote != 0:
			if c == quote {
				quote = 0
			}
		case c == '\'' || c == '"':
			quote = c
		case c == '-' && i+1 < len(q) && q[i+1] == '-':
			for i < len(q) && q[i] != '\n' {
				cur.WriteByte(q[i])
				i++
			}
			if i < len(q) {
				cur.WriteByte('\n')
			}
			continue
		case c == ';':
			out = append(out, cur.String())
			cur.Reset()
			continue
		}
		cur.WriteByte(c)
	}
	return append(out, cur.String())
}

var reSQLComment = regexp.MustCompile(`(?m)--[^\n]*$`)

func (s *pgSess) query(q string) {
	any := false
	for _, st := range splitSQL(q) {
		if strings.TrimSpace(reSQLComment.ReplaceAllString(st, "")) == "" {
			continue
		}
		any = true
		if !s.statement(strings.TrimSpace(st)) {
			return // an error ends the rest of the script, as in PostgreSQL
		}
	}
	if !any {
		s.be.Send(&pgproto3.EmptyQueryResponse{})
	}
}

func (s *pgSess) fail(code, msg string) bool {
	s.be.Send(&pgproto3.ErrorResponse{Severity: "ERROR", Code: code, Message: msg})
	return false
}

// result sends a result set (all columns as text).
func (s *pgSess) result(cols []string, rows [][]string, tag string) bool {
	return s.typedResult(cols, nil, rows, tag)
}

func (s *pgSess) typedResult(cols []string, oids []uint32, rows [][]string, tag string) bool {
	fields := make([]pgproto3.FieldDescription, len(cols))
	for i, c := range cols {
		oid := uint32(25)
		if oids != nil {
			oid = oids[i]
		}
		fields[i] = pgproto3.FieldDescription{Name: []byte(c), DataTypeOID: oid, DataTypeSize: -1, TypeModifier: -1}
	}
	s.be.Send(&pgproto3.RowDescription{Fields: fields})
	for _, r := range rows {
		vals := make([][]byte, len(r))
		for i, v := range r {
			if v != "\x00NULL" {
				vals[i] = []byte(v)
			}
		}
		s.be.Send(&pgproto3.DataRow{Values: vals})
	}
	if tag == "" {
		tag = fmt.Sprintf("SELECT %d", len(rows))
	}
	s.be.Send(&pgproto3.CommandComplete{CommandTag: []byte(tag)})
	return true
}

func (s *pgSess) done(tag string) bool {
	s.be.Send(&pgproto3.CommandComplete{CommandTag: []byte(tag)})
	return true
}

var (
	reFirstWord  = regexp.MustCompile(`^\s*\(?\s*([A-Za-z]+)`)
	rePublic     = regexp.MustCompile(`(?i)(^|[\s,(])"?public"?\.`)
	reCast       = regexp.MustCompile(`::\s*"?[A-Za-z_][A-Za-z_ ]*"?(\(\d+(,\s*\d+)?\))?(\[\])?`)
	reILike      = regexp.MustCompile(`(?i)\bilike\b`)
	reFetchFirst = regexp.MustCompile(`(?i)\bfetch\s+(first|next)\s+(\d+)\s+rows?\s+only\b`)
	reNowFn      = regexp.MustCompile(`(?i)\bnow\(\)`)
	reInterval   = regexp.MustCompile(`(?i)(current_date|current_timestamp|date\('now'\)|datetime\('now'\))\s*([-+])\s*interval\s+'(\d+)\s+(day|days|hour|hours|minute|minutes|month|months)'`)
	reLiteral    = regexp.MustCompile(`'((?:[^']|'')*)'`)
)

// toSQLite adapts common PostgreSQL spellings to SQLite.
func toSQLite(q string) string {
	q = rePublic.ReplaceAllString(q, "$1")
	q = reCast.ReplaceAllString(q, "")
	q = reILike.ReplaceAllString(q, "LIKE")
	q = reFetchFirst.ReplaceAllString(q, "LIMIT $2")
	q = reInterval.ReplaceAllStringFunc(q, func(m string) string {
		p := reInterval.FindStringSubmatch(m)
		unit := strings.TrimSuffix(strings.ToLower(p[4]), "s")
		return fmt.Sprintf("datetime('now', '%s%s %s')", p[2], p[3], unit+"s")
	})
	q = reNowFn.ReplaceAllString(q, "datetime('now')")
	q = regexp.MustCompile(`(?i)\bcurrent_date\b`).ReplaceAllString(q, "date('now')")
	q = regexp.MustCompile(`(?i)\btrue\b`).ReplaceAllString(q, "1")
	q = regexp.MustCompile(`(?i)\bfalse\b`).ReplaceAllString(q, "0")
	return q
}

// statement runs one statement; false after an error.
func (s *pgSess) statement(q string) bool {
	low := strings.ToLower(q)
	verb := ""
	if m := reFirstWord.FindStringSubmatch(low); m != nil {
		verb = m[1]
	}
	if ok, handled := s.catalog(q, low); handled {
		return ok
	}
	switch verb {
	case "begin", "start":
		if _, err := s.conn.ExecContext(context.Background(), "BEGIN"); err != nil && s.tx != 'T' {
			return s.fail("25001", err.Error())
		}
		s.tx = 'T'
		return s.done("BEGIN")
	case "commit", "end":
		if s.tx == 'T' {
			if _, err := s.conn.ExecContext(context.Background(), "COMMIT"); err != nil {
				return s.fail("40001", err.Error())
			}
		}
		s.tx = 'I'
		return s.done("COMMIT")
	case "rollback", "abort":
		if s.tx == 'T' {
			_, _ = s.conn.ExecContext(context.Background(), "ROLLBACK")
		}
		s.tx = 'I'
		return s.done("ROLLBACK")
	case "set", "reset", "discard", "listen", "unlisten", "deallocate":
		return s.done(strings.ToUpper(verb))
	case "show":
		name := strings.Trim(strings.TrimSpace(low[4:]), `";`)
		v := map[string]string{"server_version": "16.4 (WorkHub demo)", "search_path": `"$user", public`, "timezone": "UTC", "transaction_isolation": "read committed",
			"client_encoding": "UTF8", "server_encoding": "UTF8", "datestyle": "ISO, MDY", "max_connections": "100", "statement_timeout": "0"}[name]
		if v == "" {
			return s.fail("42704", fmt.Sprintf("unrecognized configuration parameter \"%s\"", name))
		}
		return s.result([]string{name}, [][]string{{v}}, "SHOW")
	case "select", "with", "values", "table", "explain":
	case "insert", "update", "delete", "create", "drop", "alter", "truncate", "grant", "revoke", "merge":
		if s.readOnly {
			return s.fail("42501", fmt.Sprintf("permission denied: %s is a read-only user (the PROD support login)", s.user))
		}
	default:
		return s.fail("42601", fmt.Sprintf("syntax error at or near \"%s\" (the demo database runs SELECT, INSERT, UPDATE, DELETE, CREATE and transactions)", strings.Fields(q)[0]))
	}
	if strings.Contains(low, "pg_") || strings.Contains(low, "information_schema") {
		return s.fail("42P01", "the demo database doesn't have the PostgreSQL system catalogs — query the payments tables instead")
	}
	sq := toSQLite(q)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	switch verb {
	case "select", "with", "values", "table", "explain":
		if verb == "table" {
			sq = "SELECT * FROM " + strings.TrimSpace(sq[5:])
		}
		if verb == "explain" {
			sq = "EXPLAIN QUERY PLAN " + regexp.MustCompile(`(?i)^\s*explain\s+(analyze\s+)?`).ReplaceAllString(sq, "")
		}
		return s.selectRows(ctx, sq)
	}
	if verb == "truncate" {
		sq = regexp.MustCompile(`(?i)^\s*truncate\s+(table\s+)?`).ReplaceAllString(sq, "DELETE FROM ")
	}
	res, err := s.conn.ExecContext(ctx, sq)
	if err != nil {
		return s.fail(sqliteCode(err), sqliteMsg(err))
	}
	n, _ := res.RowsAffected()
	switch verb {
	case "insert":
		return s.done(fmt.Sprintf("INSERT 0 %d", n))
	case "update", "delete", "merge":
		return s.done(fmt.Sprintf("%s %d", strings.ToUpper(verb), n))
	case "truncate":
		return s.done("TRUNCATE TABLE")
	}
	words := strings.Fields(strings.ToUpper(q))
	if len(words) > 1 {
		return s.done(words[0] + " " + words[1])
	}
	return s.done(words[0])
}

func sqliteMsg(err error) string {
	m := err.Error()
	m = regexp.MustCompile(`^SQL logic error: |\(\d+\)$`).ReplaceAllString(m, "")
	m = strings.TrimSpace(strings.TrimPrefix(m, "sqlite: "))
	if t, ok := strings.CutPrefix(m, "no such table: "); ok {
		return fmt.Sprintf("relation \"%s\" does not exist", t)
	}
	if c, ok := strings.CutPrefix(m, "no such column: "); ok {
		return fmt.Sprintf("column \"%s\" does not exist", c)
	}
	return m
}

func sqliteCode(err error) string {
	m := err.Error()
	switch {
	case strings.Contains(m, "no such table"):
		return "42P01"
	case strings.Contains(m, "no such column"):
		return "42703"
	case strings.Contains(m, "UNIQUE constraint"):
		return "23505"
	case strings.Contains(m, "FOREIGN KEY"):
		return "23503"
	case strings.Contains(m, "NOT NULL"):
		return "23502"
	case strings.Contains(m, "syntax error"):
		return "42601"
	}
	return "XX000"
}

// selectRows runs a query and sends its rows with PostgreSQL types, so
// numbers and dates show as they would from a real server.
func (s *pgSess) selectRows(ctx context.Context, q string) bool {
	rows, err := s.conn.QueryContext(ctx, q)
	if err != nil {
		return s.fail(sqliteCode(err), sqliteMsg(err))
	}
	defer rows.Close()
	cols, _ := rows.Columns()
	cts, _ := rows.ColumnTypes()
	decl := make([]string, len(cols))
	for i, ct := range cts {
		decl[i] = strings.ToUpper(ct.DatabaseTypeName())
	}
	var raw [][]any
	for rows.Next() && len(raw) < 100000 {
		v := make([]any, len(cols))
		p := make([]any, len(cols))
		for i := range v {
			p[i] = &v[i]
		}
		if err := rows.Scan(p...); err != nil {
			return s.fail("XX000", err.Error())
		}
		raw = append(raw, v)
	}
	if err := rows.Err(); err != nil {
		return s.fail(sqliteCode(err), sqliteMsg(err))
	}
	oids := make([]uint32, len(cols))
	for i := range cols {
		oids[i] = pgOID(decl[i], raw, i)
	}
	out := make([][]string, len(raw))
	for r, v := range raw {
		out[r] = make([]string, len(cols))
		for i, x := range v {
			out[r][i] = pgText(x, oids[i])
		}
	}
	return s.typedResult(cols, oids, out, "")
}

// pgOID picks a PostgreSQL type from the column's declared type, or from its values.
func pgOID(decl string, rows [][]any, i int) uint32 {
	switch {
	case strings.Contains(decl, "BOOL"):
		return 16
	case strings.Contains(decl, "BIGINT"):
		return 20
	case strings.Contains(decl, "INT"):
		return 23
	case strings.Contains(decl, "NUMERIC") || strings.Contains(decl, "DECIMAL"):
		return 1700
	case strings.Contains(decl, "REAL") || strings.Contains(decl, "DOUBLE") || strings.Contains(decl, "FLOAT"):
		return 701
	case strings.Contains(decl, "TIMESTAMP") || strings.Contains(decl, "DATETIME"):
		return 1114
	case decl == "DATE":
		return 1082
	case decl != "":
		return 25
	}
	for _, r := range rows { // an expression: look at the values
		switch r[i].(type) {
		case int64:
			return 20
		case float64:
			return 701
		case nil:
			continue
		}
		return 25
	}
	return 25
}

func pgText(x any, oid uint32) string {
	switch v := x.(type) {
	case nil:
		return "\x00NULL"
	case int64:
		if oid == 16 {
			if v != 0 {
				return "t"
			}
			return "f"
		}
		if oid == 1700 {
			return strconv.FormatInt(v, 10) + ".00"
		}
		return strconv.FormatInt(v, 10)
	case float64:
		if oid == 1700 {
			return strconv.FormatFloat(v, 'f', 2, 64)
		}
		if oid == 20 || oid == 23 {
			return strconv.FormatInt(int64(v), 10)
		}
		return strconv.FormatFloat(v, 'f', -1, 64)
	case bool:
		if v {
			return "t"
		}
		return "f"
	case time.Time:
		if oid == 1082 {
			return v.Format("2006-01-02")
		}
		return v.Format("2006-01-02 15:04:05")
	case []byte:
		return string(v)
	case string:
		if oid == 1114 || oid == 1082 { // stored as text: keep PostgreSQL's look
			if t, err := time.Parse(time.RFC3339, v); err == nil {
				return pgText(t, oid)
			}
		}
		return v
	}
	return fmt.Sprint(x)
}

// --- the catalog: what WorkHub's SQL page asks about the database ---

type demoCol struct {
	name, typ string
	notNull   bool
	dflt      string
	pk        bool
}

func (s *pgSess) names(kind string) []string {
	rows, err := s.conn.QueryContext(context.Background(), `SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name`, kind)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var n string
		if rows.Scan(&n) == nil {
			out = append(out, n)
		}
	}
	return out
}

func (s *pgSess) columns(table string) []demoCol {
	rows, err := s.conn.QueryContext(context.Background(), `SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?)`, table)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []demoCol
	for rows.Next() {
		var c demoCol
		var d sql.NullString
		var nn, pk int
		if rows.Scan(&c.name, &c.typ, &nn, &d, &pk) == nil {
			c.notNull, c.dflt, c.pk = nn == 1 || pk > 0, d.String, pk > 0
			c.typ = strings.ToLower(orDefault(c.typ, "text"))
			if c.typ == "integer" && c.pk {
				c.typ = "integer"
			}
			out = append(out, c)
		}
	}
	return out
}

type demoIndex struct {
	name, table, def string
	primary, unique  bool
}

func (s *pgSess) indexes(table string) []demoIndex {
	var out []demoIndex
	tables := []string{table}
	if table == "" {
		tables = s.names("table")
	}
	for _, t := range tables {
		var pk []string
		for _, c := range s.columns(t) {
			if c.pk {
				pk = append(pk, c.name)
			}
		}
		if len(pk) > 0 {
			out = append(out, demoIndex{t + "_pkey", t, fmt.Sprintf("CREATE UNIQUE INDEX %s_pkey ON public.%s USING btree (%s)", t, t, strings.Join(pk, ", ")), true, true})
		}
		rows, err := s.conn.QueryContext(context.Background(), `SELECT name, "unique", origin FROM pragma_index_list(?)`, t)
		if err != nil {
			continue
		}
		var list []demoIndex
		for rows.Next() {
			var n, origin string
			var u int
			if rows.Scan(&n, &u, &origin) == nil && origin == "c" {
				list = append(list, demoIndex{name: n, table: t, unique: u == 1})
			}
		}
		rows.Close()
		for _, ix := range list {
			var cols []string
			if r2, err := s.conn.QueryContext(context.Background(), `SELECT name FROM pragma_index_info(?) ORDER BY seqno`, ix.name); err == nil {
				for r2.Next() {
					var c string
					if r2.Scan(&c) == nil {
						cols = append(cols, c)
					}
				}
				r2.Close()
			}
			u := ""
			if ix.unique {
				u = "UNIQUE "
			}
			ix.def = fmt.Sprintf("CREATE %sINDEX %s ON public.%s USING btree (%s)", u, ix.name, t, strings.Join(cols, ", "))
			out = append(out, ix)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].name < out[j].name })
	return out
}

func (s *pgSess) constraints(table string) [][]string {
	var out [][]string
	var pk []string
	for _, c := range s.columns(table) {
		if c.pk {
			pk = append(pk, c.name)
		}
	}
	if len(pk) > 0 {
		out = append(out, []string{table + "_pkey", "PRIMARY KEY (" + strings.Join(pk, ", ") + ")"})
	}
	for _, ix := range s.indexes(table) {
		if ix.unique && !ix.primary {
			cols := ix.def[strings.Index(ix.def, "(")+1 : len(ix.def)-1]
			out = append(out, []string{ix.name, "UNIQUE (" + cols + ")"})
		}
	}
	rows, err := s.conn.QueryContext(context.Background(), `SELECT "table", "from", "to" FROM pragma_foreign_key_list(?)`, table)
	if err == nil {
		for rows.Next() {
			var t, from string
			var to sql.NullString
			if rows.Scan(&t, &from, &to) == nil {
				out = append(out, []string{fmt.Sprintf("%s_%s_fkey", table, from), fmt.Sprintf("FOREIGN KEY (%s) REFERENCES %s(%s)", from, t, orDefault(to.String, "id"))})
			}
		}
		rows.Close()
	}
	return out
}

func (s *pgSess) viewSQL(name string) string {
	var q string
	_ = s.conn.QueryRowContext(context.Background(), `SELECT sql FROM sqlite_master WHERE type = 'view' AND name = ?`, name).Scan(&q)
	if i := strings.Index(strings.ToUpper(q), " AS "); i >= 0 {
		q = strings.TrimSpace(q[i+4:])
	}
	return regexp.MustCompile(`\s+`).ReplaceAllString(q, " ")
}

func literals(q string) []string {
	var out []string
	for _, m := range reLiteral.FindAllStringSubmatch(q, -1) {
		out = append(out, strings.ReplaceAll(m[1], "''", "'"))
	}
	return out
}

// pgType: the PostgreSQL spelling of a declared type, and its length.
func pgType(t string) (string, string) {
	base, n, _ := strings.Cut(t, "(")
	n = strings.TrimSuffix(n, ")")
	switch base {
	case "varchar":
		return "character varying", n
	case "timestamp":
		return "timestamp without time zone", ""
	}
	if n != "" && base == "numeric" {
		return "numeric", ""
	}
	return base, ""
}

// catalog answers WorkHub's own catalog questions (handled = true).
func (s *pgSess) catalog(q, low string) (ok, handled bool) {
	lit := literals(q)
	tableArg := func() string { // schema, table → the table
		if len(lit) >= 2 {
			return lit[len(lit)-1]
		}
		return ""
	}
	one := func(col, v string) (bool, bool) { return s.result([]string{col}, [][]string{{v}}, ""), true }
	none := func(cols ...string) (bool, bool) { return s.result(cols, nil, ""), true }
	switch {
	case strings.Contains(low, "current_user || ' @ ' || current_database()"):
		return one("?column?", s.user+" @ "+demoDBName)
	case regexp.MustCompile(`^select\s+(current_database|current_user|session_user|current_schema|version)\b(\(\))?\s*;?$`).MatchString(low):
		fn := regexp.MustCompile(`^select\s+(\w+)`).FindStringSubmatch(low)[1]
		return one(fn, map[string]string{"current_database": demoDBName, "current_user": s.user, "session_user": s.user, "current_schema": "public",
			"version": "PostgreSQL 16.4 (WorkHub demo — made-up data) on x86_64-pc-linux-gnu"}[fn])
	case strings.Contains(low, "from pg_namespace where nspname not like"):
		return s.result([]string{"nspname"}, [][]string{{"public"}}, ""), true
	case strings.Contains(low, "union all select 'view', count(*)"):
		if len(lit) == 0 || !strings.Contains(q, "'public'") {
			return none("?column?", "count")
		}
		t, v, ix := s.names("table"), s.names("view"), s.indexes("")
		rows := [][]string{{"TABLE", strconv.Itoa(len(t))}, {"VIEW", strconv.Itoa(len(v))}, {"MATERIALIZED VIEW", "0"}, {"INDEX", strconv.Itoa(len(ix))},
			{"SEQUENCE", "0"}, {"FUNCTION", "0"}, {"PROCEDURE", "0"}, {"TRIGGER", "0"}, {"TYPE", "0"}}
		return s.result([]string{"?column?", "count"}, rows, ""), true
	case strings.Contains(low, "from information_schema.tables"):
		f := ""
		if m := regexp.MustCompile(`\(\s*'((?:[^']|'')*)'\s*=\s*''`).FindStringSubmatch(q); m != nil {
			f = strings.ToLower(strings.ReplaceAll(m[1], "''", "'"))
		}
		var rows [][]string
		for _, kind := range []string{"table", "view"} {
			for _, n := range s.names(kind) {
				if f == "" || strings.Contains(strings.ToLower(n), f) {
					rows = append(rows, []string{"public", n, map[string]string{"table": "BASE TABLE", "view": "VIEW"}[kind]})
				}
			}
		}
		sort.Slice(rows, func(i, j int) bool { return rows[i][1] < rows[j][1] })
		return s.result([]string{"table_schema", "table_name", "table_type"}, rows, ""), true
	case strings.Contains(low, "from information_schema.columns"):
		var rows [][]string
		if len(lit) >= 2 && lit[len(lit)-2] == "public" {
			for _, c := range s.columns(tableArg()) {
				typ, n := pgType(c.typ)
				if n != "" {
					typ += "(" + n + ")"
				}
				nl := "Y"
				if c.notNull {
					nl = "N"
				}
				rows = append(rows, []string{c.name, typ, nl})
			}
		}
		return s.result([]string{"column_name", "?column?", "case"}, rows, ""), true
	case strings.Contains(low, "pg_get_indexdef(ix.indexrelid)"): // indexes of one table
		var rows [][]string
		for _, ix := range s.indexes(tableArg()) {
			kind := ""
			if ix.primary {
				kind = "primary "
			} else if ix.unique {
				kind = "unique "
			}
			rows = append(rows, []string{ix.name, kind + regexp.MustCompile(`^.* USING `).ReplaceAllString(ix.def, "")})
		}
		return s.result([]string{"relname", "?column?"}, rows, ""), true
	case strings.Contains(low, "from pg_constraint c join pg_class t"):
		return s.result([]string{"conname", "pg_get_constraintdef"}, s.constraints(tableArg()), ""), true
	case strings.Contains(low, "from pg_trigger"), strings.Contains(low, "from pg_proc"), strings.Contains(low, "from pg_type"),
		strings.Contains(low, "from pg_sequences"), strings.Contains(low, "select '' where false"):
		return none("name", "detail")
	case strings.Contains(low, "from pg_index ix join pg_class i on i.oid = ix.indexrelid"): // every index of the schema
		var rows [][]string
		for _, ix := range s.indexes("") {
			rows = append(rows, []string{ix.name, "on " + ix.table})
		}
		return s.result([]string{"relname", "?column?"}, rows, ""), true
	case strings.Contains(low, "from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname"):
		var rows [][]string
		kind := map[bool]string{true: "table", false: "view"}[strings.Contains(low, "('r','p')")]
		if strings.Contains(low, "('r','p')") || strings.Contains(low, "('v')") {
			for _, n := range s.names(kind) {
				rows = append(rows, []string{n, ""})
			}
		}
		return s.result([]string{"relname", "?column?"}, rows, ""), true
	case strings.Contains(low, "create or replace view"):
		if len(lit) < 2 {
			return none("?column?")
		}
		return one("?column?", fmt.Sprintf("CREATE OR REPLACE VIEW public.%s AS\n%s", lit[len(lit)-1], s.viewSQL(lit[len(lit)-1])))
	case strings.Contains(low, "create materialized view"):
		return none("?column?")
	case strings.Contains(low, "pg_get_indexdef(to_regclass("):
		name := ""
		if len(lit) > 0 {
			name = lit[len(lit)-1]
		}
		for _, ix := range s.indexes("") {
			if ix.name == name {
				return one("?column?", ix.def+";")
			}
		}
		return none("?column?")
	case strings.Contains(low, "from pg_attribute a"): // CREATE TABLE: the columns
		var rows [][]string
		for _, c := range s.columns(tableArg()) {
			typ, n := pgType(c.typ)
			if n != "" {
				typ += "(" + n + ")"
			} else if strings.HasPrefix(c.typ, "numeric(") {
				typ = c.typ
			}
			line := c.name + " " + typ
			if c.notNull {
				line += " NOT NULL"
			}
			if c.dflt != "" {
				line += " DEFAULT " + c.dflt
			}
			rows = append(rows, []string{line})
		}
		return s.result([]string{"?column?"}, rows, ""), true
	case strings.Contains(low, "from pg_constraint") && strings.Contains(low, "conrelid = to_regclass"):
		var rows [][]string
		for _, c := range s.constraints(tableArg()) {
			rows = append(rows, []string{"CONSTRAINT " + c[0] + " " + c[1]})
		}
		return s.result([]string{"?column?"}, rows, ""), true
	case strings.Contains(low, "from pg_index where indrelid = to_regclass"):
		var rows [][]string
		for _, ix := range s.indexes(tableArg()) {
			if !ix.primary {
				rows = append(rows, []string{ix.def + ";"})
			}
		}
		return s.result([]string{"?column?"}, rows, ""), true
	}
	return false, false
}
