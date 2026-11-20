package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

// handleTestConnection tries the connection described by the edit form
// (saved or not) and reports how it went. Nothing is saved except the status
// dot of an existing entry.
func (a *App) handleTestConnection(w http.ResponseWriter, r *http.Request) {
	var in EntryInput
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	e := Entry{ID: in.ID, Host: strings.TrimSpace(in.Host), Port: in.Port, Protocol: strings.ToLower(strings.TrimSpace(in.Protocol)),
		URL: strings.TrimSpace(in.URL), Username: strings.TrimSpace(in.Username), KeyFile: strings.TrimSpace(in.KeyFile), Extra: in.Extra}
	if in.Password != nil {
		e.Password = *in.Password
	} else if saved, ok := a.store.Entry(in.ID); ok {
		e.Password = saved.Password
	}
	start := time.Now()
	what, err := a.testEntry(e)
	ms := time.Since(start).Milliseconds()
	if in.ID != "" {
		a.store.SetStatus(in.ID, err)
	}
	if err != nil {
		writeJSON(w, map[string]any{"ok": false, "message": what + ": " + err.Error(), "ms": ms})
		return
	}
	writeJSON(w, map[string]any{"ok": true, "message": what, "ms": ms})
}

func (a *App) testEntry(e Entry) (string, error) {
	switch {
	case dbKind(e) != "" && e.Host != "":
		return a.testDB(e)
	case isFTP(e) && e.Host != "":
		f, err := dialFTP(e, "", "")
		if err != nil {
			return "FTP login", err
		}
		f.Close()
		return "FTP login OK", nil
	case e.Host != "" && (e.Protocol == "" || e.Protocol == "ssh" || e.Protocol == "sftp" || e.Protocol == "scp" || e.Port == 22) && e.URL == "":
		if e.Username == "" {
			return "SSH", errors.New("enter a username")
		}
		if e.Protocol == "sftp" {
			fs, err := a.openRemote(e, "", "")
			if err != nil {
				return "SFTP login", err
			}
			fs.Close()
			return "SFTP login OK", nil
		}
		c, err := a.dialSSH(e, "", "")
		if err != nil {
			return "SSH login", err
		}
		c.Close()
		return "SSH login OK", nil
	case strings.HasPrefix(e.URL, "http://") || strings.HasPrefix(e.URL, "https://"):
		if err := checkLink(e.URL); err != nil {
			return "Link", err
		}
		return "Link answers", nil
	case e.Host != "" && e.Port != 0:
		c, err := net.DialTimeout("tcp", net.JoinHostPort(e.Host, strconv.Itoa(e.Port)), 10*time.Second)
		if err != nil {
			return fmt.Sprintf("Port %d", e.Port), err
		}
		c.Close()
		return fmt.Sprintf("Port %d is open", e.Port), nil
	}
	return "Test", errors.New("enter a host (and port) or a URL first")
}

func (a *App) testDB(e Entry) (string, error) {
	label := map[string]string{"oracle": "Oracle", "postgres": "PostgreSQL"}[dbKind(e)]
	if isLocalHost(e.Host) {
		if via, err := a.tunnelFor(dbPort(e)); err != nil {
			return label, fmt.Errorf("tunnel through %s: %w", via, err)
		}
	}
	if e.Username == "" {
		return label, errors.New("enter a username")
	}
	driver, dsn, err := dbDSN(e, e.Username, e.Password, "")
	if err != nil {
		return label, err
	}
	var db *sql.DB
	if driver == "pgx" {
		cfg, err := pgx.ParseConfig(dsn)
		if err != nil {
			return label, err
		}
		db = stdlib.OpenDB(*cfg)
	} else if db, err = sql.Open(driver, dsn); err != nil {
		return label, err
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		return label + " login", explainRefused(e, err)
	}
	var ver string
	if dbKind(e) == "oracle" {
		_ = db.QueryRowContext(ctx, "SELECT banner FROM v$version WHERE ROWNUM = 1").Scan(&ver)
	} else {
		_ = db.QueryRowContext(ctx, "SHOW server_version").Scan(&ver)
	}
	return strings.TrimSpace(label + " login OK " + ver), nil
}
