package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// Object browser for the SQL page's tree: schema → object types → objects →
// columns / indexes / constraints / triggers. Each level is loaded on demand.

type dbNode struct {
	Level  string `json:"level"` // schemas, schema, type, obj, cols, idx, cons, trg, leaf
	Schema string `json:"schema,omitempty"`
	Type   string `json:"type,omitempty"`
	Name   string `json:"name,omitempty"`
	Label  string `json:"label"`
	Detail string `json:"detail,omitempty"`
	Leaf   bool   `json:"leaf,omitempty"`
	Bad    bool   `json:"bad,omitempty"` // invalid object
	Open   bool   `json:"open,omitempty"`
}

// Object types shown per schema, in display order.
var oraTypes = []string{"TABLE", "VIEW", "MATERIALIZED VIEW", "INDEX", "SEQUENCE", "SYNONYM", "PROCEDURE", "FUNCTION", "PACKAGE", "TRIGGER", "TYPE"}
var pgTypes = []string{"TABLE", "VIEW", "MATERIALIZED VIEW", "INDEX", "SEQUENCE", "FUNCTION", "PROCEDURE", "TRIGGER", "TYPE"}

var typeLabels = map[string]string{"TABLE": "Tables", "VIEW": "Views", "MATERIALIZED VIEW": "Materialized views", "INDEX": "Indexes",
	"SEQUENCE": "Sequences", "SYNONYM": "Synonyms", "PROCEDURE": "Procedures", "FUNCTION": "Functions", "PACKAGE": "Packages",
	"TRIGGER": "Triggers", "TYPE": "Types"}

func hasChildren(t string) bool { return t == "TABLE" || t == "VIEW" || t == "MATERIALIZED VIEW" }

func (a *App) handleDBTree(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	s, err := a.dbs.get(q.Get("sid"))
	if err != nil {
		writeErr(w, 410, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	nodes, err := s.treeChildren(ctx, q.Get("level"), q.Get("schema"), q.Get("type"), q.Get("name"))
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	if nodes == nil {
		nodes = []dbNode{}
	}
	writeJSON(w, nodes)
}

func (s *dbSess) rows(ctx context.Context, query string, args ...any) ([][]string, error) {
	rs, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rs.Close()
	cols, _ := rs.Columns()
	var out [][]string
	for rs.Next() && len(out) < 5000 {
		vals := make([]sql.NullString, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rs.Scan(ptrs...); err != nil {
			return nil, err
		}
		row := make([]string, len(cols))
		for i, v := range vals {
			row[i] = v.String
		}
		out = append(out, row)
	}
	return out, rs.Err()
}

func (s *dbSess) currentSchema(ctx context.Context) string {
	var cur string
	if s.kind == "oracle" {
		_ = s.db.QueryRowContext(ctx, "SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA') FROM dual").Scan(&cur)
	} else {
		_ = s.db.QueryRowContext(ctx, "SELECT current_schema()").Scan(&cur)
	}
	return cur
}

func (s *dbSess) treeChildren(ctx context.Context, level, schema, typ, name string) ([]dbNode, error) {
	ora := s.kind == "oracle"
	switch level {
	case "", "root":
		cur := s.currentSchema(ctx)
		return []dbNode{
			{Level: "schema", Schema: cur, Label: cur, Detail: "your schema", Open: true},
			{Level: "schemas", Label: "Other schemas"},
		}, nil

	case "schemas":
		cur := s.currentSchema(ctx)
		var rows [][]string
		var err error
		if ora {
			rows, err = s.rows(ctx, `SELECT username FROM all_users ORDER BY username`)
		} else {
			rows, err = s.rows(ctx, `SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\_%' AND nspname <> 'information_schema' ORDER BY nspname`)
		}
		var out []dbNode
		for _, r := range rows {
			if r[0] != cur {
				out = append(out, dbNode{Level: "schema", Schema: r[0], Label: r[0]})
			}
		}
		return out, err

	case "schema":
		counts := map[string]string{}
		var rows [][]string
		var err error
		if ora {
			rows, err = s.rows(ctx, `SELECT object_type, COUNT(*) FROM all_objects WHERE owner = :1 GROUP BY object_type`, schema)
		} else {
			rows, err = s.rows(ctx, pgCountsSQL, schema)
		}
		if err != nil {
			return nil, err
		}
		for _, r := range rows {
			counts[r[0]] = r[1]
		}
		types := pgTypes
		if ora {
			types = oraTypes
		}
		var out []dbNode
		for _, t := range types {
			if c := counts[t]; c != "" && c != "0" {
				out = append(out, dbNode{Level: "type", Schema: schema, Type: t, Label: typeLabels[t], Detail: c})
			}
		}
		if len(out) == 0 {
			out = append(out, dbNode{Level: "leaf", Label: "(no objects you can see)", Leaf: true})
		}
		return out, nil

	case "type":
		var rows [][]string
		var err error
		if ora {
			rows, err = s.rows(ctx, `SELECT object_name, status FROM all_objects WHERE owner = :1 AND object_type = :2 ORDER BY object_name`, schema, typ)
		} else {
			rows, err = s.rows(ctx, pgObjectsSQL(typ), schema)
		}
		var out []dbNode
		for _, r := range rows {
			n := dbNode{Level: "obj", Schema: schema, Type: typ, Name: r[0], Label: r[0], Leaf: !hasChildren(typ)}
			if len(r) > 1 {
				if ora && r[1] == "INVALID" {
					n.Bad, n.Detail = true, "invalid"
				} else if !ora {
					n.Detail = r[1]
				}
			}
			out = append(out, n)
		}
		return out, err

	case "obj":
		out := []dbNode{{Level: "cols", Schema: schema, Type: typ, Name: name, Label: "Columns"}}
		if typ != "VIEW" {
			out = append(out, dbNode{Level: "idx", Schema: schema, Type: typ, Name: name, Label: "Indexes"})
		}
		if typ == "TABLE" {
			out = append(out, dbNode{Level: "cons", Schema: schema, Type: typ, Name: name, Label: "Constraints"},
				dbNode{Level: "trg", Schema: schema, Type: typ, Name: name, Label: "Triggers"})
		}
		return out, nil

	case "cols", "idx", "cons", "trg":
		rows, err := s.rows(ctx, s.detailSQL(level), schema, name)
		var out []dbNode
		for _, r := range rows {
			n := dbNode{Level: "leaf", Schema: schema, Name: r[0], Label: r[0], Detail: r[1], Leaf: true}
			if level == "cols" {
				n.Type = "COLUMN"
				if r[2] == "N" {
					n.Detail += " not null"
				}
			}
			out = append(out, n)
		}
		if len(out) == 0 && err == nil {
			out = []dbNode{{Level: "leaf", Label: "(none)", Leaf: true}}
		}
		return out, err
	}
	return nil, errors.New("unknown tree level")
}

func (s *dbSess) detailSQL(level string) string {
	if s.kind == "oracle" {
		return map[string]string{
			"cols": `SELECT column_name,
				data_type || CASE WHEN data_type IN ('VARCHAR2','NVARCHAR2','CHAR','NCHAR','RAW') THEN '(' || data_length || ')'
				                  WHEN data_type = 'NUMBER' AND data_precision IS NOT NULL THEN '(' || data_precision || ',' || data_scale || ')' END,
				nullable FROM all_tab_columns WHERE owner = :1 AND table_name = :2 ORDER BY column_id`,
			"idx": `SELECT i.index_name, LOWER(i.uniqueness) || ' (' ||
				(SELECT LISTAGG(c.column_name, ', ') WITHIN GROUP (ORDER BY c.column_position) FROM all_ind_columns c
				  WHERE c.index_owner = i.owner AND c.index_name = i.index_name) || ')'
				FROM all_indexes i WHERE i.table_owner = :1 AND i.table_name = :2 ORDER BY i.index_name`,
			"cons": `SELECT c.constraint_name,
				DECODE(c.constraint_type, 'P', 'primary key', 'U', 'unique', 'R', 'foreign key', 'C', 'check') || ' (' ||
				(SELECT LISTAGG(cc.column_name, ', ') WITHIN GROUP (ORDER BY cc.position) FROM all_cons_columns cc
				  WHERE cc.owner = c.owner AND cc.constraint_name = c.constraint_name) || ')' ||
				CASE WHEN c.r_constraint_name IS NOT NULL THEN ' → ' || c.r_constraint_name END
				FROM all_constraints c WHERE c.owner = :1 AND c.table_name = :2
				 AND (c.constraint_type IN ('P','U','R') OR (c.constraint_type = 'C' AND c.generated = 'USER NAME'))
				ORDER BY DECODE(c.constraint_type, 'P', 1, 'U', 2, 'R', 3, 4), c.constraint_name`,
			"trg": `SELECT trigger_name, LOWER(trigger_type || ' ' || triggering_event) || DECODE(status, 'DISABLED', ' (disabled)', '')
				FROM all_triggers WHERE table_owner = :1 AND table_name = :2 ORDER BY trigger_name`,
		}[level]
	}
	return map[string]string{
		"cols": `SELECT column_name, data_type || COALESCE('(' || character_maximum_length || ')', ''), CASE is_nullable WHEN 'YES' THEN 'Y' ELSE 'N' END
			FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
		"idx": `SELECT i.relname, CASE WHEN ix.indisprimary THEN 'primary ' WHEN ix.indisunique THEN 'unique ' ELSE '' END ||
			regexp_replace(pg_get_indexdef(ix.indexrelid), '^.* USING ', '')
			FROM pg_index ix JOIN pg_class t ON t.oid = ix.indrelid JOIN pg_class i ON i.oid = ix.indexrelid
			JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = $1 AND t.relname = $2 ORDER BY i.relname`,
		"cons": `SELECT c.conname, pg_get_constraintdef(c.oid) FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
			JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = $1 AND t.relname = $2
			ORDER BY CASE c.contype WHEN 'p' THEN 1 WHEN 'u' THEN 2 WHEN 'f' THEN 3 ELSE 4 END, c.conname`,
		"trg": `SELECT t.tgname, regexp_replace(pg_get_triggerdef(t.oid), '^CREATE (CONSTRAINT )?TRIGGER \S+ ', '')
			FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
			WHERE NOT t.tgisinternal AND n.nspname = $1 AND c.relname = $2 ORDER BY t.tgname`,
	}[level]
}

const pgCountsSQL = `
SELECT 'TABLE', count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ('r','p')
UNION ALL SELECT 'VIEW', count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'v'
UNION ALL SELECT 'MATERIALIZED VIEW', count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'm'
UNION ALL SELECT 'INDEX', count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ('i','I')
UNION ALL SELECT 'SEQUENCE', count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'S'
UNION ALL SELECT 'FUNCTION', count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.prokind IN ('f','a','w')
UNION ALL SELECT 'PROCEDURE', count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.prokind = 'p'
UNION ALL SELECT 'TRIGGER', count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND NOT t.tgisinternal
UNION ALL SELECT 'TYPE', count(*) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1 AND t.typtype IN ('c','e','d')
  AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind <> 'c')`

// pgObjectsSQL lists one kind of object: name, detail.
func pgObjectsSQL(typ string) string {
	rel := func(kinds string) string {
		return `SELECT c.relname, '' FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN (` + kinds + `) ORDER BY c.relname`
	}
	switch typ {
	case "TABLE":
		return rel(`'r','p'`)
	case "VIEW":
		return rel(`'v'`)
	case "MATERIALIZED VIEW":
		return rel(`'m'`)
	case "SEQUENCE":
		return rel(`'S'`)
	case "INDEX":
		return `SELECT i.relname, 'on ' || t.relname FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid JOIN pg_class t ON t.oid = ix.indrelid
			JOIN pg_namespace n ON n.oid = i.relnamespace WHERE n.nspname = $1 ORDER BY i.relname`
	case "FUNCTION", "PROCEDURE":
		kinds := `'f','a','w'`
		if typ == "PROCEDURE" {
			kinds = `'p'`
		}
		return `SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', '' FROM pg_proc p
			JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.prokind IN (` + kinds + `) ORDER BY 1`
	case "TRIGGER":
		return `SELECT t.tgname, 'on ' || c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
			JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND NOT t.tgisinternal ORDER BY t.tgname`
	case "TYPE":
		return `SELECT t.typname, CASE t.typtype WHEN 'e' THEN 'enum' WHEN 'd' THEN 'domain' ELSE 'composite' END FROM pg_type t
			JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1 AND t.typtype IN ('c','e','d')
			AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind <> 'c') ORDER BY 1`
	}
	return `SELECT '' WHERE false AND $1 = ''`
}

// handleDBDDL returns the source/DDL of one object.
func (a *App) handleDBDDL(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	s, err := a.dbs.get(q.Get("sid"))
	if err != nil {
		writeErr(w, 410, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	var text string
	if s.kind == "oracle" {
		text, err = s.oracleDDL(ctx, q.Get("schema"), q.Get("type"), q.Get("name"))
	} else {
		text, err = s.pgDDL(ctx, q.Get("schema"), q.Get("type"), q.Get("name"))
	}
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	writeJSON(w, map[string]string{"ddl": strings.TrimSpace(text)})
}

func (s *dbSess) oracleDDL(ctx context.Context, schema, typ, name string) (string, error) {
	var ddl sql.NullString
	err := s.db.QueryRowContext(ctx, `SELECT DBMS_METADATA.GET_DDL(:1, :2, :3) FROM dual`, strings.ReplaceAll(typ, " ", "_"), name, schema).Scan(&ddl)
	if err == nil && ddl.String != "" {
		return ddl.String, nil
	}
	// No DBMS_METADATA rights for that schema: rebuild code objects from ALL_SOURCE.
	rows, err2 := s.rows(ctx, `SELECT text FROM all_source WHERE owner = :1 AND name = :2 AND type IN (:3, :4) ORDER BY type, line`, schema, name, typ, typ+" BODY")
	if err2 == nil && len(rows) > 0 {
		var b strings.Builder
		b.WriteString("CREATE OR REPLACE ")
		for i, r := range rows {
			if i > 0 && strings.HasPrefix(strings.ToUpper(strings.TrimSpace(r[0])), "PACKAGE BODY") {
				b.WriteString("/\n\nCREATE OR REPLACE ")
			}
			b.WriteString(r[0])
		}
		b.WriteString("\n/")
		return b.String(), nil
	}
	if err != nil {
		return "", err
	}
	return "", errors.New("no source available")
}

func (s *dbSess) pgDDL(ctx context.Context, schema, typ, name string) (string, error) {
	one := func(query string, args ...any) (string, error) {
		var v sql.NullString
		err := s.db.QueryRowContext(ctx, query, args...).Scan(&v)
		return v.String, err
	}
	qname := `quote_ident($1) || '.' || quote_ident($2)`
	switch typ {
	case "VIEW":
		return one(`SELECT 'CREATE OR REPLACE VIEW ' || `+qname+` || E' AS\n' || pg_get_viewdef(to_regclass(`+qname+`), true)`, schema, name)
	case "MATERIALIZED VIEW":
		return one(`SELECT 'CREATE MATERIALIZED VIEW ' || `+qname+` || E' AS\n' || pg_get_viewdef(to_regclass(`+qname+`), true)`, schema, name)
	case "FUNCTION", "PROCEDURE":
		return one(`SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
			WHERE n.nspname = $1 AND p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' = $2`, schema, name)
	case "TRIGGER":
		return one(`SELECT pg_get_triggerdef(t.oid, true) || ';' FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
			JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND t.tgname = $2`, schema, name)
	case "INDEX":
		return one(`SELECT pg_get_indexdef(to_regclass(`+qname+`)) || ';'`, schema, name)
	case "SEQUENCE":
		return one(`SELECT 'CREATE SEQUENCE ' || `+qname+` || ' START ' || start_value || ' INCREMENT ' || increment_by || ';'
			FROM pg_sequences WHERE schemaname = $1 AND sequencename = $2`, schema, name)
	case "TABLE":
		cols, err := s.rows(ctx, `SELECT quote_ident(a.attname) || ' ' || format_type(a.atttypid, a.atttypmod) ||
				CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END ||
				COALESCE(' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid), '')
			FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
			WHERE a.attrelid = to_regclass(`+qname+`) AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, schema, name)
		if err != nil {
			return "", err
		}
		cons, _ := s.rows(ctx, `SELECT 'CONSTRAINT ' || quote_ident(conname) || ' ' || pg_get_constraintdef(oid) FROM pg_constraint
			WHERE conrelid = to_regclass(`+qname+`) ORDER BY contype DESC, conname`, schema, name)
		idx, _ := s.rows(ctx, `SELECT pg_get_indexdef(indexrelid) || ';' FROM pg_index WHERE indrelid = to_regclass(`+qname+`) AND NOT indisprimary`, schema, name)
		var parts []string
		for _, c := range append(cols, cons...) {
			parts = append(parts, "    "+c[0])
		}
		out := fmt.Sprintf("CREATE TABLE %s.%s (\n%s\n);", schema, name, strings.Join(parts, ",\n"))
		for _, i := range idx {
			out += "\n" + i[0]
		}
		return out, nil
	}
	return "", fmt.Errorf("no DDL for %s", strings.ToLower(typ))
}
