package main

import (
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// Finding is one connection target (and its credentials) found in text.
type Finding struct {
	Host     string            `json:"host,omitempty"`
	Port     int               `json:"port,omitempty"`
	Protocol string            `json:"protocol,omitempty"`
	URL      string            `json:"url,omitempty"`
	Username string            `json:"username,omitempty"`
	Password string            `json:"password,omitempty"`
	Extra    map[string]string `json:"extra,omitempty"`
}

var (
	reURL        = regexp.MustCompile(`(?i)\b(?:https?|ftps?|sftp|ssh|ldaps?|jdbc:[a-z0-9]+(?::[a-z0-9]+)*|mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqps?|smb|rdp|wss?)://[^\s"'<>\x60]+`)
	reOracleJDBC = regexp.MustCompile(`(?i)jdbc:oracle:thin:(?:([^/@\s]+)/([^@\s]+))?@(?://)?([A-Za-z0-9.\-]+):(\d{1,5})([/:])([A-Za-z0-9_.$\-]+)`)
	// Oracle TNS form: jdbc:oracle:thin:[user/pass]@(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=h)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=s)))
	reOracleTNS = regexp.MustCompile(`(?is)jdbc:oracle:thin:(?:([^/@\s]+)/([^@\s]+))?@\s*(\(\s*DESCRIPTION.*?\)\s*\)\s*\))`)
	reTNSPart   = regexp.MustCompile(`(?i)\(\s*(HOST|PORT|SERVICE_NAME|SID)\s*=\s*([^)\s]+)\s*\)`)
	// ssh tunnel commands: ssh -N -L1522:192.0.2.3:1521 user@jumphost
	reSSHCmd   = regexp.MustCompile(`(?im)(?:^|[\s;&|"'/\\])ssh(?:\.exe)?[ \t]+[^\n]*?-[A-Za-z]*L[ \t]*\S+[^\n]*`)
	reUserAt   = regexp.MustCompile(`\b([A-Za-z0-9._\-\\]+)@([A-Za-z0-9](?:[A-Za-z0-9\-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9\-]+)*)(?::(\d{1,5}))?\b`)
	rePortFlag = regexp.MustCompile(`\s-[pP]\s*(\d{1,5})\b`)
	reUNC      = regexp.MustCompile(`\\\\([A-Za-z0-9.\-]+)\\[^\s]+`)
	reIPv4     = regexp.MustCompile(`\b((?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3})(?::(\d{1,5}))?\b`)
	reFQDN     = regexp.MustCompile(`\b((?:[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63})(?::(\d{1,5}))?\b`)

	reKVHost = regexp.MustCompile(`(?i)\b(?:host\s?name|host|server\s?name|server|ip\s?address|ip|address|endpoint|machine|node)\s*[:=]\s*([^\s,;)("'<>]+)`)
	reKVPort = regexp.MustCompile(`(?i)\bport\s*(?:no\.?|number|#)?\s*[:=]?\s*(\d{1,5})\b`)
	reKVUser = regexp.MustCompile(`(?i)\b(?:user\s?name|user\s?id|user|login\s?id|login|uid|account|usr)\s*[:=]\s*([^\s,;)("'<>]+)`)
	reKVPass = regexp.MustCompile(`(?i)\b(?:pass\s?word|passwd|pass\s?phrase|pwd|pass|pw|secret)\s*[:=]\s*(\S+)`)
	reKVDB   = regexp.MustCompile(`(?i)\b(service[_ ]?name|sid|database|db\s?name|schema)\s*[:=]\s*([^\s,;)("'<>]+)`)
)

// Common file extensions that would otherwise look like host names.
var notTLD = map[string]bool{
	"txt": true, "log": true, "java": true, "py": true, "sh": true, "md": true, "js": true, "ts": true,
	"cs": true, "rb": true, "pl": true, "ps": true, "so": true, "gz": true, "xz": true, "bz": true,
	"db": true, "mk": true, "json": true, "xml": true, "html": true, "htm": true, "css": true,
	"yml": true, "yaml": true, "csv": true, "zip": true, "exe": true, "jar": true, "war": true,
	"sql": true, "conf": true, "cfg": true, "ini": true, "png": true, "jpg": true, "gif": true,
	"pdf": true, "doc": true, "docx": true, "xls": true, "xlsx": true, "ppt": true, "pptx": true,
	"bat": true, "cmd": true, "ps1": true, "dll": true, "class": true, "properties": true, "go": true,
	"tar": true, "tgz": true, "rpm": true, "deb": true, "msi": true, "pem": true, "crt": true, "key": true,
	"cer": true, "pfx": true, "jks": true, "env": true, "lock": true, "bak": true, "tmp": true, "out": true,
}

// Generic TLDs plus common internal suffixes; any 2-letter label counts as a ccTLD.
var knownTLD = map[string]bool{
	"com": true, "net": true, "org": true, "edu": true, "gov": true, "mil": true, "int": true, "info": true,
	"biz": true, "io": true, "app": true, "dev": true, "cloud": true, "local": true, "lan": true,
	"internal": true, "intra": true, "intranet": true, "corp": true, "home": true, "priv": true,
	"private": true, "prod": true, "test": true, "site": true, "online": true, "tech": true, "aws": true,
	"azure": true, "global": true, "group": true, "bank": true, "localdomain": true, "example": true,
}

var defaultPorts = map[string]int{
	"http": 80, "https": 443, "ssh": 22, "sftp": 22, "ftp": 21, "ftps": 990, "ldap": 389, "ldaps": 636,
	"postgres": 5432, "postgresql": 5432, "mysql": 3306, "redis": 6379, "mongodb": 27017,
	"amqp": 5672, "amqps": 5671, "smb": 445, "rdp": 3389, "oracle": 1521, "sqlserver": 1433, "ws": 80, "wss": 443,
}

var portProtocols = map[int]string{
	22: "ssh", 21: "ftp", 23: "telnet", 80: "http", 443: "https", 8080: "http", 8443: "https",
	3389: "rdp", 1521: "oracle", 1522: "oracle", 5432: "postgres", 3306: "mysql", 1433: "sqlserver",
	6379: "redis", 27017: "mongodb", 389: "ldap", 636: "ldaps", 445: "smb", 5672: "amqp", 9092: "kafka",
	9200: "elasticsearch", 2181: "zookeeper", 25: "smtp", 587: "smtp", 53: "dns",
}

// dbKindByPort guesses the database from the usual port ranges, so a host and
// port are enough: Oracle listeners use 1521–1529 (2483/2484 with TCPS),
// PostgreSQL 5432–5439 and 6432 (PgBouncer).
func dbKindByPort(port int) string {
	switch {
	case port >= 1521 && port <= 1529, port == 2483, port == 2484:
		return "oracle"
	case port >= 5432 && port <= 5439, port == 6432:
		return "postgres"
	}
	return ""
}

func Parse(text string) []Finding {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	var out []Finding
	for _, block := range splitBlocks(text) {
		lines := nonEmptyLines(block)
		if perLine(lines) {
			for _, l := range lines {
				out = append(out, parseChunk(l)...)
			}
		} else {
			out = append(out, parseChunk(block)...)
		}
	}
	return dedupe(out)
}

func splitBlocks(text string) []string {
	var blocks []string
	var cur []string
	for _, l := range strings.Split(text, "\n") {
		if strings.TrimSpace(l) == "" {
			if len(cur) > 0 {
				blocks = append(blocks, strings.Join(cur, "\n"))
				cur = nil
			}
			continue
		}
		cur = append(cur, l)
	}
	if len(cur) > 0 {
		blocks = append(blocks, strings.Join(cur, "\n"))
	}
	return blocks
}

func nonEmptyLines(block string) []string {
	var out []string
	for _, l := range strings.Split(block, "\n") {
		if strings.TrimSpace(l) != "" {
			out = append(out, l)
		}
	}
	return out
}

// perLine decides whether a block is a list (one target per line, e.g. a
// server inventory) rather than one record spread over several lines.
func perLine(lines []string) bool {
	if len(lines) < 2 {
		return false
	}
	withTarget := 0
	for _, l := range lines {
		hasTarget := len(parseTargetsOnly(l)) > 0
		if hasTarget {
			withTarget++
		}
		if reKVHost.MatchString(l) {
			return false
		}
		if !hasTarget && (reKVUser.MatchString(l) || reKVPass.MatchString(l) || reKVPort.MatchString(l) || reKVDB.MatchString(l)) {
			return false // credentials on their own line belong to the record
		}
	}
	return withTarget >= 2
}

func parseTargetsOnly(s string) []Finding {
	var out []Finding
	for _, f := range parseChunk(s) {
		if f.Host != "" || f.URL != "" {
			out = append(out, f)
		}
	}
	return out
}

// blank overwrites a span with spaces so later patterns don't match it again.
func blank(s string, start, end int) string {
	return s[:start] + strings.Repeat(" ", end-start) + s[end:]
}

func parseChunk(s string) []Finding {
	masked := s
	var targets []Finding

	for _, m := range reSSHCmd.FindAllStringIndex(masked, -1) {
		if f, ok := fromSSHTunnel(s[m[0]:m[1]]); ok {
			targets = append(targets, f)
			masked = blank(masked, m[0], m[1])
		}
	}
	for _, m := range reOracleTNS.FindAllStringSubmatchIndex(masked, -1) {
		f := Finding{Protocol: "oracle", URL: s[m[0]:m[1]], Extra: map[string]string{}}
		if m[2] >= 0 {
			f.Username, f.Password = s[m[2]:m[3]], s[m[4]:m[5]]
		}
		for _, p := range reTNSPart.FindAllStringSubmatch(s[m[6]:m[7]], -1) {
			switch strings.ToUpper(p[1]) {
			case "HOST":
				if f.Host == "" {
					f.Host = p[2]
				}
			case "PORT":
				if f.Port == 0 {
					f.Port, _ = strconv.Atoi(p[2])
				}
			case "SERVICE_NAME":
				f.Extra["service"] = p[2]
			case "SID":
				f.Extra["sid"] = p[2]
			}
		}
		if f.Host != "" {
			targets = append(targets, f)
		}
		masked = blank(masked, m[0], m[1])
	}
	for _, m := range reOracleJDBC.FindAllStringSubmatchIndex(masked, -1) {
		g := func(i int) string {
			if m[2*i] < 0 {
				return ""
			}
			return s[m[2*i]:m[2*i+1]]
		}
		port, _ := strconv.Atoi(g(4))
		extra := map[string]string{"service": g(6)}
		if g(5) == ":" { // host:port:SID is the older SID form
			extra = map[string]string{"sid": g(6)}
		}
		targets = append(targets, Finding{
			Host: g(3), Port: port, Protocol: "oracle", URL: s[m[0]:m[1]],
			Username: g(1), Password: g(2), Extra: extra,
		})
		masked = blank(masked, m[0], m[1])
	}

	for _, m := range reURL.FindAllStringIndex(masked, -1) {
		raw := strings.TrimRight(masked[m[0]:m[1]], ".,;:)]}")
		if f, ok := fromURL(raw); ok {
			targets = append(targets, f)
		}
		masked = blank(masked, m[0], m[0]+len(raw))
	}

	kv := map[string]string{}
	extra := map[string]string{}
	take := func(field string, re *regexp.Regexp, group int) {
		if m := re.FindStringSubmatchIndex(masked); m != nil {
			kv[field] = strings.TrimRight(masked[m[2*group]:m[2*group+1]], ".,;")
			masked = blank(masked, m[0], m[1])
		}
	}
	take("pass", reKVPass, 1)
	take("user", reKVUser, 1)
	take("host", reKVHost, 1)
	take("port", reKVPort, 1)
	for _, m := range reKVDB.FindAllStringSubmatchIndex(masked, -1) {
		key := strings.ToLower(strings.ReplaceAll(masked[m[2]:m[3]], " ", "_"))
		extra[key] = masked[m[4]:m[5]]
		masked = blank(masked, m[0], m[1])
	}

	for _, m := range reUserAt.FindAllStringSubmatchIndex(masked, -1) {
		user, host := masked[m[2]:m[3]], masked[m[4]:m[5]]
		if !looksLikeLogin(s, host) {
			// An e-mail address: hide it so its domain isn't taken for a server.
			masked = blank(masked, m[0], m[1])
			continue
		}
		f := Finding{Host: host, Username: user, Protocol: "ssh"}
		if m[6] >= 0 {
			f.Port, _ = strconv.Atoi(masked[m[6]:m[7]])
		} else if pm := rePortFlag.FindStringSubmatch(s); pm != nil {
			f.Port, _ = strconv.Atoi(pm[1])
		}
		targets = append(targets, f)
		masked = blank(masked, m[0], m[1])
	}

	for _, m := range reUNC.FindAllStringSubmatchIndex(masked, -1) {
		targets = append(targets, Finding{Host: masked[m[2]:m[3]], Protocol: "smb", URL: masked[m[0]:m[1]]})
		masked = blank(masked, m[0], m[1])
	}

	for _, m := range reIPv4.FindAllStringSubmatchIndex(masked, -1) {
		ip := masked[m[2]:m[3]]
		if strings.HasPrefix(ip, "255.") || ip == "0.0.0.0" {
			continue
		}
		f := Finding{Host: ip}
		if m[4] >= 0 {
			f.Port, _ = strconv.Atoi(masked[m[4]:m[5]])
		}
		targets = append(targets, f)
		masked = blank(masked, m[0], m[1])
	}

	for _, m := range reFQDN.FindAllStringSubmatchIndex(masked, -1) {
		host := masked[m[2]:m[3]]
		if !plausibleHost(host) {
			continue
		}
		f := Finding{Host: host}
		if m[4] >= 0 {
			f.Port, _ = strconv.Atoi(masked[m[4]:m[5]])
		}
		targets = append(targets, f)
		masked = blank(masked, m[0], m[1])
	}

	port, _ := strconv.Atoi(kv["port"])
	if h, p, ok := strings.Cut(kv["host"], ":"); ok && port == 0 && !strings.Contains(kv["host"], "://") {
		if n, err := strconv.Atoi(p); err == nil {
			kv["host"], port = h, n
		}
	}
	if kv["host"] != "" {
		main := Finding{Host: kv["host"], Port: port, Username: kv["user"], Password: kv["pass"]}
		// "Host: https://x" style values were already parsed as URLs.
		if f, ok := fromURL(kv["host"]); ok && strings.Contains(kv["host"], "://") {
			f.Username, f.Password = orDefault(f.Username, kv["user"]), orDefault(f.Password, kv["pass"])
			main = f
		}
		targets = append([]Finding{main}, targets...)
	} else if len(targets) > 0 {
		t := &targets[0]
		if t.Username == "" {
			t.Username = kv["user"]
		}
		if t.Password == "" {
			t.Password = kv["pass"]
		}
		if t.Port == 0 && len(targets) == 1 {
			t.Port = port
		}
	} else if kv["user"] != "" || kv["pass"] != "" {
		targets = append(targets, Finding{Username: kv["user"], Password: kv["pass"]})
	}

	if len(extra) > 0 && len(targets) > 0 {
		if targets[0].Extra == nil {
			targets[0].Extra = map[string]string{}
		}
		for k, v := range extra {
			targets[0].Extra[k] = v
		}
	}
	for i := range targets {
		t := &targets[i]
		if t.Protocol == "" && t.Port != 0 {
			t.Protocol = orDefault(portProtocols[t.Port], dbKindByPort(t.Port))
		}
	}
	return targets
}

// fromSSHTunnel reads "ssh -N -L1522:192.0.2.3:1521 [-p 2222] user@jump" into
// an SSH connection to the jump server with Tunnels filled in (as PuTTY's
// Connection > SSH > Tunnels would hold them).
func fromSSHTunnel(cmd string) (Finding, bool) {
	toks := strings.Fields(strings.NewReplacer(`"`, " ", "'", " ").Replace(cmd))
	i := 0
	for i < len(toks) && !regexp.MustCompile(`(?i)(^|[/\\])ssh(\.exe)?$`).MatchString(toks[i]) {
		i++
	}
	f := Finding{Protocol: "ssh", Extra: map[string]string{}}
	var fws []string
	const withArg = "BbcDEeFIiJLlmOopQRSWw"
	for i++; i < len(toks); i++ {
		t := toks[i]
		if !strings.HasPrefix(t, "-") || len(t) < 2 {
			if f.Host != "" {
				break // the rest is a remote command
			}
			d := strings.TrimPrefix(t, "ssh://")
			if at := strings.LastIndex(d, "@"); at >= 0 {
				f.Username, d = d[:at], d[at+1:]
			}
			if h, p, ok := strings.Cut(d, ":"); ok && strings.HasPrefix(t, "ssh://") {
				d = h
				f.Port, _ = strconv.Atoi(p)
			}
			f.Host = d
			continue
		}
		for j := 1; j < len(t); j++ {
			c := t[j]
			if !strings.ContainsRune(withArg, rune(c)) {
				continue // -N, -f, -v, -T, -4 …
			}
			val := t[j+1:]
			if val == "" && i+1 < len(toks) {
				i++
				val = toks[i]
			}
			switch c {
			case 'L':
				parts := strings.Split(val, ":")
				if len(parts) >= 3 {
					parts = parts[len(parts)-3:] // drop a bind address
					fws = append(fws, strings.Join(parts, ":"))
				}
			case 'p':
				f.Port, _ = strconv.Atoi(val)
			case 'l':
				f.Username = val
			case 'i':
				f.Extra["key_file"] = val
			}
			break
		}
	}
	// Inside an ssh command any IP, short name or FQDN is a real server.
	if len(fws) == 0 || !regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9.\-]*[A-Za-z0-9])?$`).MatchString(f.Host) {
		return Finding{}, false
	}
	if f.Port == 0 {
		f.Port = 22
	}
	f.Extra["tunnels"] = strings.Join(fws, ", ")
	return f, true
}

func fromURL(raw string) (Finding, bool) {
	s := raw
	if strings.HasPrefix(strings.ToLower(s), "jdbc:") {
		s = s[5:]
	}
	var extra map[string]string
	if i := strings.Index(s, ";"); i >= 0 { // jdbc:sqlserver://h:1433;databaseName=x
		extra = map[string]string{}
		for _, kv := range strings.Split(s[i+1:], ";") {
			if k, v, ok := strings.Cut(kv, "="); ok {
				extra[k] = v
			}
		}
		s = s[:i]
	}
	u, err := url.Parse(s)
	if err != nil || u.Hostname() == "" {
		return Finding{}, false
	}
	scheme := strings.ToLower(u.Scheme)
	f := Finding{Host: u.Hostname(), Protocol: scheme, URL: raw, Extra: extra}
	if p := u.Port(); p != "" {
		f.Port, _ = strconv.Atoi(p)
	}
	if u.User != nil {
		f.Username = u.User.Username()
		f.Password, _ = u.User.Password()
		// Keep credentials out of the stored URL.
		u.User = nil
		f.URL = u.String()
	}
	if q := u.Query(); scheme != "http" && scheme != "https" && (q.Has("user") || q.Has("password")) {
		f.Username = orDefault(f.Username, q.Get("user"))
		f.Password = orDefault(f.Password, q.Get("password"))
		q.Del("password") // never keep a password inside the stored URL
		u.RawQuery = q.Encode()
		f.URL = u.String()
		if strings.HasPrefix(strings.ToLower(raw), "jdbc:") {
			f.URL = "jdbc:" + f.URL
		}
	}
	if db := strings.Trim(u.Path, "/"); db != "" && (scheme == "postgresql" || scheme == "postgres" || scheme == "mysql" || scheme == "sqlserver") {
		if f.Extra == nil {
			f.Extra = map[string]string{}
		}
		f.Extra["database"] = db
	}
	if f.Port == 0 && scheme != "http" && scheme != "https" {
		f.Port = defaultPorts[scheme]
	}
	return f, true
}

// looksLikeLogin tells user@server logins apart from e-mail addresses.
func looksLikeLogin(context, host string) bool {
	lc := strings.ToLower(context)
	for _, kw := range []string{"ssh ", "sftp ", "scp ", "putty", "rsync ", "login", "connect"} {
		if strings.Contains(lc, kw) {
			return true
		}
	}
	if reIPv4.MatchString(host) || !strings.Contains(host, ".") {
		return true
	}
	first := strings.SplitN(host, ".", 2)[0]
	return strings.ContainsAny(first, "0123456789")
}

func plausibleHost(host string) bool {
	labels := strings.Split(host, ".")
	tld := strings.ToLower(labels[len(labels)-1])
	if notTLD[tld] {
		return false
	}
	return len(tld) == 2 || knownTLD[tld]
}

func dedupe(in []Finding) []Finding {
	seen := map[string]int{}
	var out []Finding
	for _, f := range in {
		k := entryKey(f.Host, f.Port, f.Username, f.URL)
		if i, ok := seen[k]; ok {
			if out[i].Password == "" {
				out[i].Password = f.Password
			}
			continue
		}
		seen[k] = len(out)
		out = append(out, f)
	}
	return out
}
