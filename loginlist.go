package main

// Several logins for one server, pasted together, become one connection per
// user (named host-user). Understood layouts:
//
//	ssh deploy@srv-07 pass Dep#1          (one login per line; "pass" with or without ":")
//	ssh oracle@srv-07 password: Ora#3
//
//	Server: srv-07.uat.acme.local         (a server, then user/password lines)
//	user: deploy   password: Dep#1
//	user: appuser  password: App#2
//
//	srv-07.uat.acme.local                 (a server, then "user / password" or
//	deploy / Dep#1                         "user/password" lines; blank lines
//	appuser/App#2                          between them are fine)
//
//	Host            User     Password     (a table, e.g. from an email; the
//	srv-07...       deploy   Dep#1         Host column may be left out under a
//	srv-07...       appuser  App#2         server line)

import (
	"regexp"
	"strconv"
	"strings"
)

var (
	reCredKV    = regexp.MustCompile(`(?i)\b(?:user(?:name)?|login|uid)\s*[:=]?\s*([^\s,;|:=]+)[\s,;|]+(?:password|passwd|pass|pwd|pw)\s*[:=]?\s*(\S+)`)
	reCredSlash = regexp.MustCompile(`^\s*([A-Za-z0-9._\\-]+)\s+/\s+(\S+)\s*$`)
	reCredTight = regexp.MustCompile(`^\s*([A-Za-z0-9._\\-]+)/([^\s/]+)\s*$`) // user/password (no further "/", so not a path)
	reLinePass  = regexp.MustCompile(`(?i)\b(?:password|passwd|pass|pwd|pw)\s*[:=]?\s+(\S+)|\b(?:password|passwd|pass|pwd|pw)\s*[:=]\s*(\S+)`)
	reCols      = regexp.MustCompile(`\t+|\s{2,}|\s*\|\s*`)
)

// parseLoginList recognises a block that lists several logins; ok=false
// leaves the block to the general parser.
func parseLoginList(block string) ([]Finding, bool) {
	lines := nonEmptyLines(block)
	if len(lines) < 2 {
		return nil, false
	}
	if out, ok := loginTable(lines); ok {
		return out, true
	}

	// 1) one "user@host … pass X" per line
	var perLine []Finding
	for _, l := range lines {
		m := reUserAt.FindStringSubmatch(l)
		if m == nil || strings.Contains(l, "://") {
			perLine = nil
			break
		}
		f := Finding{Host: m[2], Username: m[1], Protocol: "ssh"}
		f.Port, _ = strconv.Atoi(m[3])
		if p := reLinePass.FindStringSubmatch(l[strings.Index(l, m[0])+len(m[0]):]); p != nil {
			f.Password = orDefault(p[1], p[2])
		}
		perLine = append(perLine, f)
	}
	if len(perLine) >= 2 && withPasswords(perLine) > 0 {
		return perLine, true
	}

	// 2) and 3): a server line, then credential lines
	host, port, creds := "", 0, []Finding{}
	for _, l := range lines {
		if m := reCredKV.FindStringSubmatch(l); m != nil {
			creds = append(creds, Finding{Username: m[1], Password: m[2]})
			continue
		}
		if m := credSlash(l); m != nil {
			creds = append(creds, Finding{Username: m[1], Password: m[2]})
			continue
		}
		if host == "" {
			if h, p := serverOf(l); h != "" {
				host, port = h, p
				continue
			}
		}
	}
	if host == "" || len(creds) < 2 {
		return nil, false
	}
	for i := range creds {
		creds[i].Host, creds[i].Port, creds[i].Protocol = host, port, "ssh"
	}
	return creds, true
}

// credSlash matches "user / password" or "user/password" (not "host / x").
func credSlash(l string) []string {
	m := reCredSlash.FindStringSubmatch(l)
	if m == nil {
		m = reCredTight.FindStringSubmatch(l)
	}
	if m == nil || strings.Contains(m[1], ".") {
		return nil
	}
	return m
}

// isCredLine: a line that is only a login (for joining blocks).
func isCredLine(l string) bool { return reCredKV.MatchString(l) || credSlash(l) != nil }

// joinLoginBlocks puts a server line and the login lines under it back into
// one block when blank lines separate them:
//
//	srv-07.uat.acme.local
//
//	deploy/Dep#1
//
//	appuser/App#2
func joinLoginBlocks(blocks []string) []string {
	var out []string
	for i := 0; i < len(blocks); i++ {
		b := blocks[i]
		lines := nonEmptyLines(b)
		last, _ := serverOf(lines[len(lines)-1])
		first, _ := serverOf(lines[0])
		// the block ends with a server line, or is a server line and its first logins
		if last != "" || first != "" && allCredLines(strings.Join(lines[1:], "\n")) {
			for i+1 < len(blocks) && allCredLines(blocks[i+1]) {
				b += "\n" + blocks[i+1]
				i++
			}
		}
		out = append(out, b)
	}
	return out
}

func allCredLines(block string) bool {
	for _, l := range nonEmptyLines(block) {
		if !isCredLine(l) {
			return false
		}
	}
	return true
}

// serverOf finds a server named on a line ("Server: x", "x", "host x:2222").
func serverOf(line string) (string, int) {
	for _, f := range parseChunk(line) {
		if f.Host != "" && f.URL == "" && f.Username == "" {
			return f.Host, f.Port
		}
	}
	t := strings.TrimSpace(line)
	if i := strings.IndexAny(t, ":="); i > 0 && regexp.MustCompile(`(?i)^(server|host|hostname|machine|box)\s*$`).MatchString(t[:i]) {
		t = strings.TrimSpace(t[i+1:])
	}
	if h, p, ok := strings.Cut(t, ":"); ok {
		if n, err := strconv.Atoi(p); err == nil && plausibleHost(h) {
			return h, n
		}
	}
	if !strings.ContainsAny(t, " \t/@") && plausibleHost(t) && strings.Contains(t, ".") {
		return t, 0
	}
	return "", 0
}

// loginTable reads a table whose header names user and password columns (and
// usually host / port); rows without a host use a server named above it.
func loginTable(lines []string) ([]Finding, bool) {
	hi := -1
	var cols []string
	for i, l := range lines {
		c := reCols.Split(strings.TrimSpace(l), -1)
		lower := strings.ToLower(strings.Join(c, "|"))
		if len(c) >= 2 && regexp.MustCompile(`\b(user|username|login)\b`).MatchString(lower) && regexp.MustCompile(`\b(password|passwd|pass|pwd)\b`).MatchString(lower) {
			hi, cols = i, c
			break
		}
	}
	if hi < 0 {
		return nil, false
	}
	idx := map[string]int{"host": -1, "user": -1, "pass": -1, "port": -1}
	for i, c := range cols {
		switch strings.ToLower(strings.TrimSpace(c)) {
		case "host", "hostname", "server", "machine", "ip", "address":
			idx["host"] = i
		case "user", "username", "login", "user name", "account":
			idx["user"] = i
		case "password", "passwd", "pass", "pwd":
			idx["pass"] = i
		case "port":
			idx["port"] = i
		}
	}
	if idx["user"] < 0 || idx["pass"] < 0 {
		return nil, false
	}
	host, port := "", 0
	for _, l := range lines[:hi] {
		if h, p := serverOf(l); h != "" {
			host, port = h, p
		}
	}
	var out []Finding
	for _, l := range lines[hi+1:] {
		c := reCols.Split(strings.TrimSpace(l), -1)
		if len(c) <= idx["user"] || len(c) <= idx["pass"] || strings.Trim(l, "-=+| \t") == "" {
			continue
		}
		f := Finding{Host: host, Port: port, Username: c[idx["user"]], Password: c[idx["pass"]], Protocol: "ssh"}
		if idx["host"] >= 0 && idx["host"] < len(c) {
			if h, p := serverOf(c[idx["host"]]); h != "" {
				f.Host, f.Port = h, p
			}
		}
		if idx["port"] >= 0 && idx["port"] < len(c) {
			if n, err := strconv.Atoi(c[idx["port"]]); err == nil {
				f.Port = n
			}
		}
		if f.Host != "" && f.Username != "" {
			out = append(out, f)
		}
	}
	return out, len(out) > 0
}

func withPasswords(fs []Finding) int {
	n := 0
	for _, f := range fs {
		if f.Password != "" {
			n++
		}
	}
	return n
}
