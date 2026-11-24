package main

// Import connections from DBeaver, PuTTY, FileZilla and SQL Developer.
// READ-ONLY: their files and settings are only read, never changed. Found on
// this PC automatically, or from a file you pick (e.g. copied from another PC).
// Connections you already have (same host, port and user) are not duplicated:
// only what is missing (password, service name, environment…) is filled in.

import (
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

type ImportConn struct {
	Source   string            `json:"source"` // dbeaver, putty, filezilla, sqldeveloper
	Folder   string            `json:"folder,omitempty"`
	Name     string            `json:"name"`
	Host     string            `json:"host"`
	Port     int               `json:"port,omitempty"`
	Protocol string            `json:"protocol,omitempty"`
	Username string            `json:"username,omitempty"`
	Password string            `json:"password,omitempty"`
	KeyFile  string            `json:"key_file,omitempty"`
	Env      string            `json:"env,omitempty"`
	Extra    map[string]string `json:"extra,omitempty"`
	Exists   bool              `json:"exists,omitempty"` // already in WorkHub
}

var sourceLabel_ = map[string]string{"dbeaver": "DBeaver", "putty": "PuTTY", "filezilla": "FileZilla", "sqldeveloper": "SQL Developer"}

// ---------------- DBeaver ----------------

// DBeaver keeps passwords in credentials-config.json, AES-encrypted with the
// key every DBeaver install uses (it is not a per-user secret).
var dbeaverKey, _ = hex.DecodeString("babb4a9f774ab853c96c2d653dfe544a")

func dbeaverCredentials(b []byte) map[string][2]string {
	out := map[string][2]string{}
	if len(b) < 32 || len(b)%aes.BlockSize != 0 {
		return out
	}
	blk, err := aes.NewCipher(dbeaverKey)
	if err != nil {
		return out
	}
	iv, data := b[:16], append([]byte(nil), b[16:]...)
	cipher.NewCBCDecrypter(blk, iv).CryptBlocks(data, data)
	if n := int(data[len(data)-1]); n > 0 && n <= aes.BlockSize && n <= len(data) {
		data = data[:len(data)-n]
	}
	var m map[string]map[string]map[string]string
	if json.Unmarshal(data, &m) != nil {
		return out
	}
	for id, v := range m {
		c := v["#connection"]
		out[id] = [2]string{c["user"], c["password"]}
	}
	return out
}

func parseDBeaver(b []byte, creds map[string][2]string) ([]ImportConn, error) {
	var ds struct {
		Folders     map[string]struct{ Parent string } `json:"folders"`
		Connections map[string]struct {
			Provider string `json:"provider"`
			Name     string `json:"name"`
			Folder   string `json:"folder"`
			Config   struct {
				Host     string            `json:"host"`
				Port     string            `json:"port"`
				Database string            `json:"database"`
				URL      string            `json:"url"`
				Type     string            `json:"type"`
				User     string            `json:"user"`
				Password string            `json:"password"`
				Provider map[string]string `json:"provider-properties"`
			} `json:"configuration"`
		} `json:"connections"`
	}
	if err := json.Unmarshal(b, &ds); err != nil || ds.Connections == nil {
		return nil, errors.New("not a DBeaver data-sources.json")
	}
	var out []ImportConn
	for id, c := range ds.Connections {
		port, _ := strconv.Atoi(c.Config.Port)
		ic := ImportConn{Source: "dbeaver", Folder: c.Folder, Name: c.Name, Host: c.Config.Host, Port: port, Username: c.Config.User, Password: c.Config.Password, Extra: map[string]string{}}
		switch strings.ToLower(c.Provider) {
		case "oracle":
			ic.Protocol = "oracle"
			key := "service"
			if strings.EqualFold(c.Config.Provider["@dbeaver-sid-service@"], "SID") {
				key = "sid"
			}
			if c.Config.Database != "" {
				ic.Extra[key] = c.Config.Database
			}
		case "postgresql", "postgres":
			ic.Protocol = "postgres"
			if c.Config.Database != "" {
				ic.Extra["database"] = c.Config.Database
			}
		default:
			ic.Protocol = strings.ToLower(c.Provider)
			if c.Config.Database != "" {
				ic.Extra["database"] = c.Config.Database
			}
		}
		if ic.Host == "" && c.Config.URL != "" { // URL-only connections
			ic.Host, ic.Port = hostFromJDBC(c.Config.URL)
		}
		if cr, ok := creds[id]; ok {
			ic.Username, ic.Password = orDefault(cr[0], ic.Username), orDefault(cr[1], ic.Password)
		}
		ic.Env = map[string]string{"prod": "PROD", "test": "TEST", "dev": "DEV"}[strings.ToLower(c.Config.Type)]
		out = append(out, ic)
	}
	return out, nil
}

var reJDBCHost = regexp.MustCompile(`@(?://)?([A-Za-z0-9.\-]+):(\d+)|//([A-Za-z0-9.\-]+):(\d+)`)

func hostFromJDBC(u string) (string, int) {
	m := reJDBCHost.FindStringSubmatch(u)
	if m == nil {
		return "", 0
	}
	h, p := orDefault(m[1], m[3]), orDefault(m[2], m[4])
	n, _ := strconv.Atoi(p)
	return h, n
}

// ---------------- PuTTY ----------------

// puttySession turns one PuTTY session's values into a connection.
func puttySession(name string, v map[string]string) (ImportConn, bool) {
	host := v["HostName"]
	if host == "" || strings.EqualFold(name, "Default Settings") {
		return ImportConn{}, false
	}
	user := v["UserName"]
	if u, h, ok := strings.Cut(host, "@"); ok { // "user@host" in the host box
		user, host = orDefault(user, u), h
	}
	port, _ := strconv.Atoi(v["PortNumber"])
	proto := strings.ToLower(orDefault(v["Protocol"], "ssh"))
	ic := ImportConn{Source: "putty", Name: name, Host: host, Port: port, Protocol: proto, Username: user, KeyFile: v["PublicKeyFile"], Extra: map[string]string{}}
	if ic.Protocol == "ssh" && ic.Port == 22 {
		ic.Port = 0
	}
	// PortForwardings "L1522=dbhost:1521,L8080=web:80" → WorkHub tunnels "1522:dbhost:1521,…"
	var fw []string
	for _, f := range strings.Split(v["PortForwardings"], ",") {
		f = strings.TrimSpace(f)
		if len(f) < 3 || (f[0] != 'L' && !strings.HasPrefix(f, "4L") && !strings.HasPrefix(f, "6L")) {
			continue
		}
		f = strings.TrimLeft(f, "46L")
		if lp, tgt, ok := strings.Cut(f, "="); ok {
			fw = append(fw, lp+":"+tgt)
		}
	}
	if len(fw) > 0 {
		ic.Extra["tunnels"] = strings.Join(fw, ",")
	}
	if i := strings.LastIndex(name, "/"); i > 0 { // session managers save "Folder/Name"
		ic.Folder, ic.Name = name[:i], name[i+1:]
	}
	return ic, true
}

var reRegKey = regexp.MustCompile(`(?i)^\[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\(.+)\]$`)
var reRegVal = regexp.MustCompile(`^"([^"]+)"=(?:"((?:[^"\\]|\\.)*)"|dword:([0-9a-fA-F]{8}))$`)

// parsePuttyReg reads a .reg export of PuTTY's sessions.
func parsePuttyReg(b []byte) ([]ImportConn, error) {
	text := string(b)
	if len(b) >= 2 && b[0] == 0xff && b[1] == 0xfe { // regedit writes UTF-16
		u := make([]rune, 0, len(b)/2)
		for i := 2; i+1 < len(b); i += 2 {
			u = append(u, rune(uint16(b[i])|uint16(b[i+1])<<8))
		}
		text = string(u)
	}
	sessions := map[string]map[string]string{}
	var order []string
	cur := ""
	for _, l := range strings.Split(strings.ReplaceAll(text, "\r", ""), "\n") {
		l = strings.TrimSpace(l)
		if m := reRegKey.FindStringSubmatch(l); m != nil {
			cur, _ = url.PathUnescape(m[1])
			if _, ok := sessions[cur]; !ok {
				sessions[cur] = map[string]string{}
				order = append(order, cur)
			}
			continue
		}
		if strings.HasPrefix(l, "[") {
			cur = ""
			continue
		}
		if m := reRegVal.FindStringSubmatch(l); m != nil && cur != "" {
			v := strings.NewReplacer(`\\`, `\`, `\"`, `"`).Replace(m[2])
			if m[3] != "" {
				n, _ := strconv.ParseUint(m[3], 16, 32)
				v = strconv.FormatUint(n, 10)
			}
			sessions[cur][m[1]] = v
		}
	}
	if len(order) == 0 {
		return nil, errors.New("no PuTTY sessions in this .reg file")
	}
	var out []ImportConn
	for _, n := range order {
		if ic, ok := puttySession(n, sessions[n]); ok {
			out = append(out, ic)
		}
	}
	return out, nil
}

// ---------------- FileZilla ----------------

type fzServer struct {
	Host     string `xml:"Host"`
	Port     int    `xml:"Port"`
	Protocol int    `xml:"Protocol"`
	User     string `xml:"User"`
	Pass     struct {
		Encoding string `xml:"encoding,attr"`
		Value    string `xml:",chardata"`
	} `xml:"Pass"`
	Name      string `xml:"Name"`
	RemoteDir string `xml:"RemoteDir"`
}

type fzFolder struct {
	Name    string     `xml:",chardata"`
	Folders []fzFolder `xml:"Folder"`
	Servers []fzServer `xml:"Server"`
}

func parseFileZilla(b []byte) ([]ImportConn, error) {
	var doc struct {
		Servers fzFolder `xml:"Servers"`
	}
	if err := xml.Unmarshal(b, &doc); err != nil {
		return nil, errors.New("not a FileZilla sitemanager.xml")
	}
	var out []ImportConn
	var walk func(f fzFolder, path string)
	walk = func(f fzFolder, path string) {
		for _, s := range f.Servers {
			if s.Host == "" {
				continue
			}
			pass := s.Pass.Value
			if s.Pass.Encoding == "base64" {
				if d, err := base64.StdEncoding.DecodeString(strings.TrimSpace(pass)); err == nil {
					pass = string(d)
				}
			}
			proto := map[int]string{0: "ftp", 1: "sftp", 3: "ftps", 4: "ftps", 6: "ftp"}[s.Protocol]
			ic := ImportConn{Source: "filezilla", Folder: path, Name: strings.TrimSpace(s.Name), Host: s.Host, Port: s.Port, Protocol: orDefault(proto, "ftp"), Username: s.User, Password: pass, Extra: map[string]string{}}
			if (ic.Protocol == "sftp" && ic.Port == 22) || (ic.Protocol == "ftp" && ic.Port == 21) {
				ic.Port = 0
			}
			if dir := fzRemoteDir(s.RemoteDir); dir != "" {
				ic.Extra["start_dir"] = dir
			}
			out = append(out, ic)
		}
		for _, sub := range f.Folders {
			name := strings.TrimSpace(firstLine(sub.Name))
			p := name
			if path != "" {
				p = path + "/" + name
			}
			walk(sub, p)
		}
	}
	walk(doc.Servers, "")
	if len(out) == 0 {
		return nil, errors.New("no sites in this sitemanager.xml")
	}
	return out, nil
}

func firstLine(s string) string { l, _, _ := strings.Cut(strings.TrimSpace(s), "\n"); return l }

// FileZilla's RemoteDir: "1 0 4 home 3 ops" → /home/ops
func fzRemoteDir(s string) string {
	f := strings.Fields(s)
	if len(f) < 3 {
		return ""
	}
	var parts []string
	for i := 2; i+1 < len(f); i += 2 {
		parts = append(parts, f[i+1])
	}
	if len(parts) == 0 {
		return ""
	}
	return "/" + strings.Join(parts, "/")
}

// ---------------- SQL Developer ----------------

func parseSQLDeveloper(b []byte) ([]ImportConn, error) {
	var js struct {
		Connections []struct {
			Name string            `json:"name"`
			Type string            `json:"type"`
			Info map[string]string `json:"info"`
		} `json:"connections"`
	}
	var out []ImportConn
	add := func(name string, info map[string]string) {
		host := info["hostname"]
		port, _ := strconv.Atoi(info["port"])
		if host == "" && info["customUrl"] != "" {
			host, port = hostFromJDBC(info["customUrl"])
		}
		if host == "" {
			return
		}
		ic := ImportConn{Source: "sqldeveloper", Name: name, Host: host, Port: port, Protocol: "oracle", Username: info["user"], Extra: map[string]string{}}
		if v := info["serviceName"]; v != "" {
			ic.Extra["service"] = v
		} else if v := info["sid"]; v != "" {
			ic.Extra["sid"] = v
		}
		out = append(out, ic)
	}
	if json.Unmarshal(b, &js) == nil && js.Connections != nil {
		for _, c := range js.Connections {
			add(c.Name, c.Info)
		}
		return out, nil
	}
	var x struct {
		Refs []struct {
			Name  string `xml:"name,attr"`
			Addrs []struct {
				Type     string `xml:"addrType,attr"`
				Contents string `xml:"Contents"`
			} `xml:"RefAddresses>StringRefAddr"`
		} `xml:"Reference"`
	}
	if err := xml.Unmarshal(b, &x); err != nil || len(x.Refs) == 0 {
		return nil, errors.New("not a SQL Developer connections file")
	}
	for _, r := range x.Refs {
		info := map[string]string{}
		for _, a := range r.Addrs {
			info[a.Type] = a.Contents
		}
		add(r.Name, info)
	}
	return out, nil
}

// ---------------- finding them on this PC ----------------

type importSource struct {
	Source string `json:"source"`
	Label  string `json:"label"`
	Path   string `json:"path"`
	Count  int    `json:"count"`
	Error  string `json:"error,omitempty"`
}

func appDataDirs() []string {
	var out []string
	if d := os.Getenv("APPDATA"); d != "" {
		out = append(out, d)
	}
	if h, err := os.UserHomeDir(); err == nil {
		out = append(out, filepath.Join(h, "Library"), filepath.Join(h, ".config"), h)
	}
	return out
}

func findImportFiles() map[string][]string {
	found := map[string][]string{}
	glob := func(src string, pats ...string) {
		for _, base := range appDataDirs() {
			for _, p := range pats {
				m, _ := filepath.Glob(filepath.Join(base, p))
				found[src] = append(found[src], m...)
			}
		}
	}
	glob("dbeaver", "DBeaverData/workspace6/*/.dbeaver/data-sources*.json")
	glob("filezilla", "FileZilla/sitemanager.xml", "filezilla/sitemanager.xml")
	glob("sqldeveloper", "SQL Developer/system*/o.jdeveloper.db.connection*/connections.json", "SQL Developer/system*/o.jdeveloper.db.connection*/connections.xml",
		".sqldeveloper/system*/o.jdeveloper.db.connection*/connections.json", ".sqldeveloper/system*/o.jdeveloper.db.connection*/connections.xml")
	for k, v := range found {
		sort.Strings(v)
		found[k] = dedupStrings(v)
	}
	return found
}

// dedupStrings drops paths that are the same file (Windows and macOS ignore
// upper/lower case, so FileZilla/filezilla can both match one file).
func dedupStrings(in []string) []string {
	var out []string
	var seen []os.FileInfo
next:
	for _, s := range in {
		st, err := os.Stat(s)
		if err != nil {
			continue
		}
		for _, x := range seen {
			if os.SameFile(x, st) {
				continue next
			}
		}
		seen = append(seen, st)
		out = append(out, s)
	}
	return out
}

// readImport parses one source: a file path (or, for PuTTY, the registry).
func readImport(source, path string, content []byte) ([]ImportConn, error) {
	var b []byte
	if content != nil {
		b = content
	} else if !(source == "putty" && path == "") {
		var err error
		if b, err = os.ReadFile(path); err != nil {
			return nil, err
		}
	}
	switch source {
	case "dbeaver":
		creds := map[string][2]string{}
		if path != "" {
			if cb, err := os.ReadFile(filepath.Join(filepath.Dir(path), "credentials-config.json")); err == nil {
				creds = dbeaverCredentials(cb)
			}
		}
		return parseDBeaver(b, creds)
	case "putty":
		if b == nil {
			return readPuttyRegistry()
		}
		return parsePuttyReg(b)
	case "filezilla":
		return parseFileZilla(b)
	case "sqldeveloper":
		return parseSQLDeveloper(b)
	}
	return nil, errors.New("unknown source")
}

// guessSource tells a picked file's kind from its name and contents.
func guessSource(name string, b []byte) string {
	n, t := strings.ToLower(name), string(b[:min(len(b), 4000)])
	switch {
	case strings.HasSuffix(n, ".reg") || strings.Contains(t, "SimonTatham") || (len(b) > 2 && b[0] == 0xff):
		return "putty"
	case strings.Contains(t, "<FileZilla"):
		return "filezilla"
	case strings.Contains(t, `"connections"`) && strings.Contains(t, `"provider"`):
		return "dbeaver"
	case strings.Contains(t, `"connections"`) || strings.Contains(t, "<References"):
		return "sqldeveloper"
	}
	return ""
}

// ---------------- HTTP ----------------

func (a *App) markExisting(list []ImportConn) []ImportConn {
	have := map[string]bool{}
	for _, e := range a.store.Entries() {
		have[entryKey(e.Host, e.Port, e.Username, "")] = true
	}
	for i := range list {
		list[i].Exists = have[entryKey(list[i].Host, list[i].Port, list[i].Username, "")]
	}
	return list
}

func (a *App) handleImportScan(w http.ResponseWriter, r *http.Request) {
	out := []importSource{}
	if list, err := readPuttyRegistry(); err == nil && len(list) > 0 {
		out = append(out, importSource{Source: "putty", Label: "PuTTY", Path: "", Count: len(list)})
	}
	for src, paths := range findImportFiles() {
		for _, p := range paths {
			list, err := readImport(src, p, nil)
			s := importSource{Source: src, Label: sourceLabel_[src], Path: p, Count: len(list)}
			if err != nil {
				s.Error = err.Error()
			}
			out = append(out, s)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Label < out[j].Label })
	writeJSON(w, out)
}

func (a *App) handleImportRead(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Source  string `json:"source"`
		Path    string `json:"path"`
		Name    string `json:"name"`
		Content string `json:"content"` // base64 of a picked file
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	var content []byte
	if in.Content != "" {
		b, err := base64.StdEncoding.DecodeString(in.Content)
		if err != nil {
			writeErr(w, 400, err)
			return
		}
		content = b
		if in.Source == "" {
			in.Source = guessSource(in.Name, b)
		}
		if in.Source == "" {
			writeErr(w, 400, errors.New("not a DBeaver, PuTTY (.reg), FileZilla or SQL Developer file"))
			return
		}
	}
	list, err := readImport(in.Source, in.Path, content)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	writeJSON(w, map[string]any{"source": in.Source, "items": a.markExisting(list)})
}

// handleImportApply adds the chosen connections; existing ones only get what they lack.
func (a *App) handleImportApply(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Items []ImportConn `json:"items"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	byKey := map[string]EntryView{}
	for _, e := range a.store.Entries() {
		byKey[entryKey(e.Host, e.Port, e.Username, "")] = e
	}
	added, updated := 0, 0
	for _, c := range in.Items {
		if c.Host == "" {
			continue
		}
		project := "Imported from " + sourceLabel_[c.Source]
		if c.Folder != "" {
			project = c.Folder
		}
		if c.Env == "" {
			c.Env = inferEnv(c.Name + " " + c.Host + " " + c.Folder)
		}
		if e, ok := byKey[entryKey(c.Host, c.Port, c.Username, "")]; ok { // fill in what is missing
			in := EntryInput{ID: e.ID, Project: e.Project, Name: e.Name, Host: e.Host, Port: e.Port, Protocol: orDefault(e.Protocol, c.Protocol), URL: e.URL, Username: e.Username,
				KeyFile: orDefault(e.KeyFile, c.KeyFile), Env: orDefault(e.Env, c.Env), Tags: e.Tags, Extra: map[string]string{}, Notes: e.Notes, Favorite: e.Favorite}
			for k, v := range e.Extra {
				in.Extra[k] = v
			}
			changed := in.Protocol != e.Protocol || in.KeyFile != e.KeyFile || in.Env != e.Env
			for k, v := range c.Extra {
				if in.Extra[k] == "" && v != "" {
					in.Extra[k], changed = v, true
				}
			}
			if e.Password == "" && c.Password != "" {
				p := c.Password
				in.Password, changed = &p, true
			}
			if changed {
				if _, err := a.store.SaveEntry(in); err == nil {
					updated++
				}
			}
			continue
		}
		p := c.Password
		ein := EntryInput{Project: project, Name: c.Name, Host: c.Host, Port: c.Port, Protocol: c.Protocol, Username: c.Username, KeyFile: c.KeyFile, Env: c.Env,
			Tags: []string{strings.ToLower(sourceLabel_[c.Source])}, Extra: c.Extra}
		if p != "" {
			ein.Password = &p
		}
		if v, err := a.store.SaveEntry(ein); err == nil {
			added++
			byKey[entryKey(v.Host, v.Port, v.Username, "")] = v
		}
	}
	writeJSON(w, map[string]int{"added": added, "updated": updated})
}
