package main

// The pretend shell of the demo servers (demossh.go): enough of bash to show
// WorkHub — ls, cd, cat, tail -f, grep, pipes, df, ps, systemctl, running a
// script — over the made-up files in the demo folder. It runs nothing on this
// PC: every command is written here in Go.

import (
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/crypto/ssh"
)

type demoShell struct {
	h      *demoHost
	w      io.Writer
	in     chan []byte // what the user types (one reader goroutine)
	inEOF  bool
	buf    []byte // typed but not used yet
	tty    bool
	cols   int
	cwd    string
	oldpwd string
	pid    int
	hist   []string
	vars   map[string]string
	quit   bool
	exitCd int
}

type demoReadWriter interface {
	io.Reader
	io.Writer
}

func newDemoShell(h *demoHost, rw demoReadWriter, tty bool, dir string) *demoShell {
	sh := &demoShell{h: h, w: rw, tty: tty, cols: 120, cwd: dir, oldpwd: dir, in: make(chan []byte, 16),
		vars: map[string]string{"HOME": h.home(), "USER": h.user, "LOGNAME": h.user, "SHELL": "/bin/bash", "HOSTNAME": h.name,
			"PATH": "/usr/local/bin:/usr/bin:/bin:/opt/" + h.key + "/bin", "LANG": "en_GB.UTF-8", "TERM": "xterm-256color"}}
	go func() {
		b := make([]byte, 4096)
		for {
			n, err := rw.Read(b)
			if n > 0 {
				sh.in <- append([]byte(nil), b[:n]...)
			}
			if err != nil {
				close(sh.in)
				return
			}
		}
	}()
	return sh
}

func (sh *demoShell) out(s string) {
	if sh.tty {
		s = strings.ReplaceAll(strings.ReplaceAll(s, "\r\n", "\n"), "\n", "\r\n")
	}
	_, _ = io.WriteString(sh.w, s)
}

func (sh *demoShell) prompt() string {
	d := sh.cwd
	if d == sh.h.home() {
		d = "~"
	} else if strings.HasPrefix(d, sh.h.home()+"/") {
		d = "~" + strings.TrimPrefix(d, sh.h.home())
	}
	return fmt.Sprintf("\x1b[32m%s@%s\x1b[0m:\x1b[34m%s\x1b[0m$ ", sh.h.user, sh.h.name, d)
}

// interactive is the login shell: prompt, read a line, run it.
func (sh *demoShell) interactive(reqs <-chan *ssh.Request, marker bool) int {
	sh.h.mu.Lock()
	if sh.h.dirs == nil {
		sh.h.dirs = map[int]string{}
	}
	sh.h.pid++
	sh.pid = 4200 + sh.h.pid
	sh.h.dirs[sh.pid] = sh.cwd
	sh.h.mu.Unlock()
	defer func() { sh.h.mu.Lock(); delete(sh.h.dirs, sh.pid); sh.h.mu.Unlock() }()
	go func() {
		for r := range reqs {
			if r.Type == "window-change" && len(r.Payload) >= 4 {
				sh.cols = max(int(uint32(r.Payload[0])<<24|uint32(r.Payload[1])<<16|uint32(r.Payload[2])<<8|uint32(r.Payload[3])), 20)
			}
			if r.WantReply {
				r.Reply(r.Type == "window-change" || r.Type == "env", nil)
			}
		}
	}()
	if marker {
		_, _ = fmt.Fprintf(sh.w, "\x1b]7777;%d\x07", sh.pid)
	}
	sh.out(fmt.Sprintf("Last login: %s from 10.0.0.15\n%s — Acme Bank %s demo server (made-up data)\n",
		time.Now().Add(-26*time.Hour).Format("Mon Jan _2 15:04:05 2006"), sh.h.name, strings.ToUpper(sh.h.lab.envOf(sh.h.key))))
	for !sh.quit {
		sh.out(sh.prompt())
		line, ok := sh.readLine()
		if !ok {
			return 0
		}
		if strings.TrimSpace(line) != "" {
			sh.hist = append(sh.hist, line)
		}
		sh.run(line)
		sh.h.mu.Lock()
		sh.h.dirs[sh.pid] = sh.cwd
		sh.h.mu.Unlock()
	}
	return sh.exitCd
}

// next returns the next typed byte (false: the session ended).
func (sh *demoShell) next() (byte, bool) {
	for len(sh.buf) == 0 {
		b, ok := <-sh.in
		if !ok {
			sh.inEOF = true
			return 0, false
		}
		sh.buf = b
	}
	c := sh.buf[0]
	sh.buf = sh.buf[1:]
	return c, true
}

// interrupted: Ctrl+C (or q) typed while a command runs; false when nothing came.
func (sh *demoShell) interrupted(wait time.Duration, q bool) bool {
	deadline := time.After(wait)
	for {
		if len(sh.buf) > 0 {
			c := sh.buf[0]
			sh.buf = sh.buf[1:]
			if c == 3 || (q && c == 'q') {
				return true
			}
			continue
		}
		select {
		case b, ok := <-sh.in:
			if !ok {
				sh.inEOF = true
				return true
			}
			sh.buf = b
		case <-deadline:
			return false
		}
	}
}

func (sh *demoShell) readLine() (string, bool) {
	var line []rune
	hi := len(sh.hist)
	redraw := func() { sh.out("\r\x1b[K" + sh.prompt() + string(line)) }
	for {
		c, ok := sh.next()
		if !ok {
			return "", false
		}
		switch {
		case c == '\r' || c == '\n':
			if c == '\r' && len(sh.buf) > 0 && sh.buf[0] == '\n' {
				sh.buf = sh.buf[1:]
			}
			sh.out("\n")
			return string(line), true
		case c == 3: // Ctrl+C
			sh.out("^C\n")
			return "", true
		case c == 4: // Ctrl+D
			if len(line) == 0 {
				sh.out("logout\n")
				return "", false
			}
		case c == 0x7f || c == 8:
			if len(line) > 0 {
				line = line[:len(line)-1]
				sh.out("\b \b")
			}
		case c == 0x15: // Ctrl+U
			line = nil
			redraw()
		case c == 0x0c: // Ctrl+L
			sh.out("\x1b[H\x1b[2J")
			redraw()
		case c == '\t':
			line = []rune(sh.complete(string(line)))
			redraw()
		case c == 0x1b: // arrows: history; the rest is ignored
			b1, _ := sh.next()
			if b1 != '[' && b1 != 'O' {
				continue
			}
			var fin byte
			for {
				b, ok := sh.next()
				if !ok || (b >= 0x40 && b <= 0x7e) {
					fin = b
					break
				}
			}
			switch fin {
			case 'A':
				if hi > 0 {
					hi--
					line = []rune(sh.hist[hi])
					redraw()
				}
			case 'B':
				if hi < len(sh.hist) {
					hi++
					line = nil
					if hi < len(sh.hist) {
						line = []rune(sh.hist[hi])
					}
					redraw()
				}
			}
		case c >= 0x20:
			b := []byte{c}
			for !utf8.FullRune(b) && len(b) < 4 { // a multi-byte character
				n, ok := sh.next()
				if !ok {
					break
				}
				b = append(b, n)
			}
			r, _ := utf8.DecodeRune(b)
			line = append(line, r)
			sh.out(string(r))
		}
	}
}

// complete finishes the last word with a file name when only one fits.
func (sh *demoShell) complete(line string) string {
	i := strings.LastIndexAny(line, " \t") + 1
	word := line[i:]
	dir, base := path.Split(word)
	ents, err := os.ReadDir(sh.h.real(sh.abs(orDefault(dir, "."))))
	if err != nil {
		return line
	}
	var hits []string
	for _, e := range ents {
		if strings.HasPrefix(e.Name(), base) {
			n := e.Name()
			if e.IsDir() {
				n += "/"
			}
			hits = append(hits, n)
		}
	}
	if len(hits) != 1 {
		return line
	}
	return line[:i] + dir + hits[0]
}

func (sh *demoShell) abs(p string) string {
	switch {
	case p == "~":
		p = sh.h.home()
	case strings.HasPrefix(p, "~/"):
		p = sh.h.home() + p[1:]
	case !strings.HasPrefix(p, "/"):
		p = sh.cwd + "/" + p
	}
	return path.Clean(p)
}

// --- parsing ---

// splitList splits a line at ; && || outside quotes: parts and the operator before each.
func splitList(line string) (parts, ops []string) {
	var cur strings.Builder
	q := byte(0)
	op := ";"
	for i := 0; i < len(line); i++ {
		c := line[i]
		switch {
		case q != 0:
			if c == q {
				q = 0
			} else if c == '\\' && q == '"' && i+1 < len(line) {
				cur.WriteByte(c)
				i++
				c = line[i]
			}
		case c == '\'' || c == '"':
			q = c
		case c == '\\' && i+1 < len(line):
			cur.WriteByte(c)
			i++
			c = line[i]
		case c == ';', c == '&' && i+1 < len(line) && line[i+1] == '&', c == '|' && i+1 < len(line) && line[i+1] == '|':
			parts, ops = append(parts, cur.String()), append(ops, op)
			cur.Reset()
			op = ";"
			if c != ';' {
				op = line[i : i+2]
				i++
			}
			continue
		}
		cur.WriteByte(c)
	}
	return append(parts, cur.String()), append(ops, op)
}

// splitPipe splits at | outside quotes.
func splitPipe(s string) []string {
	var out []string
	var cur strings.Builder
	q := byte(0)
	for i := 0; i < len(s); i++ {
		c := s[i]
		if q != 0 {
			if c == q {
				q = 0
			}
		} else if c == '\'' || c == '"' {
			q = c
		} else if c == '|' {
			out = append(out, cur.String())
			cur.Reset()
			continue
		}
		cur.WriteByte(c)
	}
	return append(out, cur.String())
}

// words splits into words with quotes, backslashes, $VAR and ~.
func (sh *demoShell) words(s string) []string {
	var out []string
	var cur strings.Builder
	in, q := false, byte(0)
	expand := func(i int) int { // $NAME at s[i]; returns the last index used
		if i+1 < len(s) && s[i+1] == '$' {
			cur.WriteString(strconv.Itoa(sh.pid + 4000))
			return i + 1
		}
		if i+1 < len(s) && s[i+1] == '?' {
			cur.WriteString(strconv.Itoa(sh.exitCd))
			return i + 1
		}
		j, brace := i+1, false
		if j < len(s) && s[j] == '{' {
			brace, j = true, j+1
		}
		k := j
		for k < len(s) && (s[k] == '_' || s[k] >= 'A' && s[k] <= 'Z' || s[k] >= 'a' && s[k] <= 'z' || s[k] >= '0' && s[k] <= '9') {
			k++
		}
		if k == j {
			cur.WriteByte('$')
			return i
		}
		name := s[j:k]
		if name == "PWD" {
			cur.WriteString(sh.cwd)
		} else {
			cur.WriteString(sh.vars[name])
		}
		if brace && k < len(s) && s[k] == '}' {
			k++
		}
		return k - 1
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case q == '\'':
			if c == '\'' {
				q = 0
			} else {
				cur.WriteByte(c)
			}
		case q == '"':
			switch {
			case c == '"':
				q = 0
			case c == '\\' && i+1 < len(s) && strings.IndexByte(`"\$`, s[i+1]) >= 0:
				i++
				cur.WriteByte(s[i])
			case c == '$':
				i = expand(i)
			default:
				cur.WriteByte(c)
			}
		case c == '\'' || c == '"':
			q, in = c, true
		case c == '\\' && i+1 < len(s):
			i++
			cur.WriteByte(s[i])
			in = true
		case c == ' ' || c == '\t':
			if in {
				out = append(out, cur.String())
				cur.Reset()
				in = false
			}
		case c == '$':
			i, in = expand(i), true
		case c == '~' && !in && (i+1 == len(s) || s[i+1] == '/' || s[i+1] == ' '):
			cur.WriteString(sh.h.home())
			in = true
		default:
			cur.WriteByte(c)
			in = true
		}
	}
	if in {
		out = append(out, cur.String())
	}
	return out
}

// --- running ---

// run runs a command line and returns its exit code.
func (sh *demoShell) run(line string) int {
	parts, ops := splitList(line)
	code := 0
	for i, p := range parts {
		if strings.TrimSpace(p) == "" || sh.quit {
			continue
		}
		if (ops[i] == "&&" && code != 0) || (ops[i] == "||" && code == 0) {
			continue
		}
		code = sh.pipeline(p)
		sh.exitCd = code
	}
	return code
}

func (sh *demoShell) pipeline(p string) int {
	stages := splitPipe(p)
	input, code := "", 0
	for i, st := range stages {
		args := sh.words(st)
		// redirections: > file, >> file, 2>&1, 2>/dev/null, < file
		var outFile string
		appendOut := false
		var clean []string
		for j := 0; j < len(args); j++ {
			a := args[j]
			switch {
			case a == "2>&1" || a == "2>/dev/null" || a == "&>/dev/null" || a == ">/dev/null":
				if a != "2>&1" && a != "2>/dev/null" {
					outFile = "/dev/null"
				}
			case (a == ">" || a == ">>") && j+1 < len(args):
				outFile, appendOut = args[j+1], a == ">>"
				j++
			case strings.HasPrefix(a, ">>") && len(a) > 2:
				outFile, appendOut = a[2:], true
			case strings.HasPrefix(a, ">") && len(a) > 1:
				outFile = a[1:]
			case a == "<" && j+1 < len(args):
				b, _ := os.ReadFile(sh.h.real(sh.abs(args[j+1])))
				input = string(b)
				j++
			default:
				clean = append(clean, a)
			}
		}
		if len(clean) == 0 {
			continue
		}
		last := i == len(stages)-1
		if last && outFile == "" && len(stages) == 1 && sh.streaming(clean) {
			return sh.stream(clean)
		}
		var out string
		out, code = sh.command(clean, input)
		if outFile != "" {
			if outFile != "/dev/null" {
				fl := os.O_WRONLY | os.O_CREATE | os.O_TRUNC
				if appendOut {
					fl = os.O_WRONLY | os.O_CREATE | os.O_APPEND
				}
				if f, err := os.OpenFile(sh.h.real(sh.abs(outFile)), fl, 0o644); err == nil {
					f.WriteString(out)
					f.Close()
				} else {
					sh.out("bash: " + outFile + ": No such file or directory\n")
				}
			}
			out = ""
		}
		if last {
			sh.out(out)
		}
		input = out
	}
	return code
}

// streaming commands keep running until Ctrl+C: tail -f, ping, top, watch, sleep.
func (sh *demoShell) streaming(a []string) bool {
	switch a[0] {
	case "tail":
		for _, x := range a[1:] {
			if x == "-f" || x == "-F" || strings.HasPrefix(x, "--follow") {
				return true
			}
		}
	case "ping":
		return !strings.Contains(strings.Join(a, " "), "-c")
	case "top", "htop":
		return !strings.Contains(strings.Join(a, " "), "-b")
	case "sleep":
		return true
	case "sudo":
		return len(a) > 1 && sh.streaming(a[1:])
	}
	return false
}

func (sh *demoShell) stream(a []string) int {
	if a[0] == "sudo" {
		a = a[1:]
	}
	switch a[0] {
	case "sleep":
		d, _ := strconv.ParseFloat(strings.TrimSuffix(a[min(1, len(a)-1)], "s"), 64)
		if sh.interrupted(time.Duration(min(d, 30)*float64(time.Second)), false) {
			sh.out("^C\n")
			return 130
		}
		return 0
	case "ping":
		host := a[len(a)-1]
		sh.out(fmt.Sprintf("PING %s (10.0.0.31) 56(84) bytes of data.\n", host))
		for i := 1; ; i++ {
			sh.out(fmt.Sprintf("64 bytes from %s (10.0.0.31): icmp_seq=%d ttl=64 time=0.%d ms\n", host, i, 300+i*37%600))
			if sh.interrupted(time.Second, false) {
				sh.out(fmt.Sprintf("^C\n--- %s ping statistics ---\n%d packets transmitted, %d received, 0%% packet loss\n", host, i, i))
				return 0
			}
		}
	case "top", "htop":
		for {
			sh.out("\x1b[H\x1b[2J" + sh.topText())
			if sh.interrupted(2*time.Second, true) {
				sh.out("\n")
				return 0
			}
		}
	}
	// tail -f: the last lines, then whatever is added to the file
	n, files := 10, []string{}
	for i := 1; i < len(a); i++ {
		switch x := a[i]; {
		case x == "-n" && i+1 < len(a):
			n, _ = strconv.Atoi(strings.TrimPrefix(a[i+1], "+"))
			i++
		case strings.HasPrefix(x, "-n"):
			n, _ = strconv.Atoi(x[2:])
		case x == "--":
		case strings.HasPrefix(x, "-") && x != "-":
		default:
			files = append(files, x)
		}
	}
	if len(files) == 0 {
		sh.out("tail: no file given\n")
		return 1
	}
	p := sh.h.real(sh.abs(files[0]))
	b, err := os.ReadFile(p)
	if err != nil {
		sh.out(fmt.Sprintf("tail: cannot open '%s' for reading: No such file or directory\n", files[0]))
		return 1
	}
	sh.out(lastLines(string(b), n))
	off := int64(len(b))
	for {
		if sh.interrupted(700*time.Millisecond, false) {
			if sh.inEOF {
				return 0
			}
			sh.out("^C\n")
			return 130
		}
		fi, err := os.Stat(p)
		if err != nil {
			continue
		}
		if fi.Size() < off { // the file was rotated / cut
			off = 0
		}
		if fi.Size() > off {
			f, err := os.Open(p)
			if err != nil {
				continue
			}
			chunk := make([]byte, fi.Size()-off)
			n, _ := f.ReadAt(chunk, off)
			f.Close()
			off += int64(n)
			sh.out(string(chunk[:n]))
		}
	}
}

func lastLines(s string, n int) string {
	if n <= 0 {
		return ""
	}
	lines := strings.SplitAfter(s, "\n")
	if lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "")
}

func firstLines(s string, n int) string {
	lines := strings.SplitAfter(s, "\n")
	if len(lines) > n {
		lines = lines[:n]
	}
	return strings.Join(lines, "")
}

// flags splits -abc style options from the other arguments.
func flags(a []string) (map[byte]bool, []string) {
	f := map[byte]bool{}
	var rest []string
	for _, x := range a {
		if len(x) > 1 && x[0] == '-' && x[1] != '-' && !isNumber(x[1:]) {
			for i := 1; i < len(x); i++ {
				f[x[i]] = true
			}
		} else if !strings.HasPrefix(x, "--") {
			rest = append(rest, x)
		}
	}
	return f, rest
}

func isNumber(s string) bool { _, err := strconv.Atoi(s); return err == nil }

// read returns the text of the named files, or stdin when there are none.
func (sh *demoShell) read(name string, files []string, stdin string) (string, string, int) {
	if len(files) == 0 {
		return stdin, "", 0
	}
	var b strings.Builder
	var errs string
	code := 0
	for _, f := range files {
		p := sh.h.real(sh.abs(f))
		if fi, err := os.Stat(p); err == nil && fi.IsDir() {
			errs += fmt.Sprintf("%s: %s: Is a directory\n", name, f)
			code = 1
			continue
		}
		d, err := os.ReadFile(p)
		if err != nil {
			errs += fmt.Sprintf("%s: %s: No such file or directory\n", name, f)
			code = 1
			continue
		}
		b.Write(d)
	}
	return b.String(), errs, code
}

func (sh *demoShell) topText() string {
	now := time.Now().Format("15:04:05")
	return fmt.Sprintf(`top - %s up 41 days,  3:12,  1 user,  load average: 0.42, 0.51, 0.47
Tasks: 187 total,   1 running, 186 sleeping,   0 stopped,   0 zombie
%%Cpu(s):  6.1 us,  1.9 sy,  0.0 ni, 91.6 id,  0.3 wa,  0.0 hi,  0.1 si,  0.0 st
MiB Mem :  15876.4 total,   2104.7 free,   9311.2 used,   4460.5 buff/cache
MiB Swap:   4096.0 total,   4096.0 free,      0.0 used.   6212.8 avail Mem

    PID USER      PR  NI    VIRT    RES    SHR S  %%CPU  %%MEM     TIME+ COMMAND
   2231 %-8s  20   0 8421336   2.1g  31244 S   %d.3  13.6 812:44.18 java
   1187 root      20   0  241212  12004   9012 S   0.7   0.1  21:05.33 sshd
   1402 root      20   0  395120  20512  14876 S   0.3   0.1   9:41.02 node_exporter
   4201 %-8s  20   0   12420   5120   3412 R   0.3   0.0   0:00.04 top
      1 root      20   0  171640  13280   8960 S   0.0   0.1   3:12.77 systemd
`, now, sh.h.user, 3+time.Now().Second()%9, sh.h.user)
}

func human(n int64) string {
	switch {
	case n >= 1<<30:
		return fmt.Sprintf("%.1fG", float64(n)/(1<<30))
	case n >= 1<<20:
		return fmt.Sprintf("%.1fM", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.1fK", float64(n)/(1<<10))
	}
	return strconv.FormatInt(n, 10)
}

func (sh *demoShell) ls(args []string) (string, int) {
	f, rest := flags(args)
	if len(rest) == 0 {
		rest = []string{"."}
	}
	var b strings.Builder
	code := 0
	for ri, target := range rest {
		p := sh.h.real(sh.abs(target))
		fi, err := os.Stat(p)
		if err != nil {
			b.WriteString(fmt.Sprintf("ls: cannot access '%s': No such file or directory\n", target))
			code = 2
			continue
		}
		var list []os.FileInfo
		if fi.IsDir() && !f['d'] {
			ents, _ := os.ReadDir(p)
			for _, e := range ents {
				if !f['a'] && !f['A'] && strings.HasPrefix(e.Name(), ".") {
					continue
				}
				if i, err := e.Info(); err == nil {
					list = append(list, i)
				}
			}
			if len(rest) > 1 {
				if ri > 0 {
					b.WriteString("\n")
				}
				b.WriteString(target + ":\n")
			}
		} else {
			list = []os.FileInfo{demoInfo{fi, target}}
		}
		sort.Slice(list, func(i, j int) bool {
			if f['t'] {
				return list[i].ModTime().After(list[j].ModTime())
			}
			if f['S'] {
				return list[i].Size() > list[j].Size()
			}
			return strings.ToLower(list[i].Name()) < strings.ToLower(list[j].Name())
		})
		if f['r'] {
			for i, j := 0, len(list)-1; i < j; i, j = i+1, j-1 {
				list[i], list[j] = list[j], list[i]
			}
		}
		name := func(i os.FileInfo) string {
			if !sh.tty {
				return i.Name()
			}
			switch {
			case i.IsDir():
				return "\x1b[01;34m" + i.Name() + "\x1b[0m"
			case i.Mode()&0o111 != 0:
				return "\x1b[01;32m" + i.Name() + "\x1b[0m"
			case strings.HasSuffix(i.Name(), ".gz") || strings.HasSuffix(i.Name(), ".war") || strings.HasSuffix(i.Name(), ".jar"):
				return "\x1b[01;31m" + i.Name() + "\x1b[0m"
			}
			return i.Name()
		}
		if f['l'] {
			var total int64
			for _, i := range list {
				total += (i.Size() + 4095) / 4096 * 4
			}
			b.WriteString(fmt.Sprintf("total %d\n", total))
			for _, i := range list {
				size := strconv.FormatInt(i.Size(), 10)
				if f['h'] {
					size = human(i.Size())
				}
				when := i.ModTime().Format("Jan _2 15:04")
				if time.Since(i.ModTime()) > 180*24*time.Hour {
					when = i.ModTime().Format("Jan _2  2006")
				}
				b.WriteString(fmt.Sprintf("%s 1 %-7s %-7s %6s %s %s\n", demoMode(i), sh.h.user, sh.h.user, size, when, name(i)))
			}
			continue
		}
		if !sh.tty || f['1'] {
			for _, i := range list {
				b.WriteString(i.Name() + "\n")
			}
			continue
		}
		width := 0
		for _, i := range list {
			width = max(width, utf8.RuneCountInString(i.Name())+2)
		}
		per := max(1, sh.cols/max(width, 1))
		for k, i := range list {
			b.WriteString(name(i) + strings.Repeat(" ", width-utf8.RuneCountInString(i.Name())))
			if (k+1)%per == 0 || k == len(list)-1 {
				b.WriteString("\n")
			}
		}
	}
	return b.String(), code
}

func demoMode(i os.FileInfo) string {
	m := []byte("-rw-r--r--")
	if i.IsDir() {
		m = []byte("drwxr-xr-x")
	} else if i.Mode()&0o111 != 0 {
		m = []byte("-rwxr-xr-x")
	}
	return string(m)
}

// command runs one simple command: its output and exit code.
func (sh *demoShell) command(a []string, stdin string) (string, int) {
	if strings.Contains(a[0], "=") && !strings.HasPrefix(a[0], "=") && len(a) == 1 { // NAME=value
		k, v, _ := strings.Cut(a[0], "=")
		sh.vars[k] = v
		return "", 0
	}
	cmd, args := a[0], a[1:]
	switch cmd {
	case "sudo":
		if len(args) == 0 {
			return "usage: sudo command\n", 1
		}
		if args[0] == "-i" || args[0] == "su" || args[0] == "-s" {
			return "Sorry, this demo server doesn't give a root shell.\n", 1
		}
		return sh.command(args, stdin)
	case "pwd":
		return sh.cwd + "\n", 0
	case "cd":
		to := sh.h.home()
		if len(args) > 0 {
			to = args[0]
		}
		if to == "-" {
			to = sh.oldpwd
		}
		p := sh.abs(to)
		if !sh.h.isDir(p) {
			return fmt.Sprintf("bash: cd: %s: No such file or directory\n", to), 1
		}
		sh.oldpwd, sh.cwd = sh.cwd, p
		return "", 0
	case "ls", "ll", "la", "dir":
		if cmd == "ll" {
			args = append([]string{"-l"}, args...)
		} else if cmd == "la" {
			args = append([]string{"-la"}, args...)
		}
		return sh.ls(args)
	case "cat", "less", "more", "view":
		_, files := flags(args)
		s, errs, code := sh.read(cmd, files, stdin)
		return s + errs, code
	case "head", "tail":
		n, files := 10, []string{}
		for i := 0; i < len(args); i++ {
			switch x := args[i]; {
			case x == "-n" && i+1 < len(args):
				n, _ = strconv.Atoi(strings.TrimPrefix(args[i+1], "+"))
				i++
			case strings.HasPrefix(x, "-n"):
				n, _ = strconv.Atoi(x[2:])
			case len(x) > 1 && x[0] == '-' && isNumber(x[1:]):
				n, _ = strconv.Atoi(x[1:])
			case strings.HasPrefix(x, "-"):
			default:
				files = append(files, x)
			}
		}
		s, errs, code := sh.read(cmd, files, stdin)
		if cmd == "head" {
			return firstLines(s, n) + errs, code
		}
		return lastLines(s, n) + errs, code
	case "grep", "egrep", "zgrep":
		f, rest := flags(args)
		if len(rest) == 0 {
			return "Usage: grep [OPTION]... PATTERNS [FILE]...\n", 2
		}
		pat := rest[0]
		if f['i'] {
			pat = "(?i)" + pat
		}
		re, err := regexp.Compile(pat)
		if err != nil {
			re = regexp.MustCompile(regexp.QuoteMeta(rest[0]))
		}
		files := rest[1:]
		if f['r'] || f['R'] {
			var all []string
			for _, d := range orList(files, ".") {
				_ = filepath.Walk(sh.h.real(sh.abs(d)), func(p string, fi os.FileInfo, err error) error {
					if err == nil && !fi.IsDir() {
						rel, _ := filepath.Rel(sh.h.real(sh.cwd), p)
						all = append(all, filepath.ToSlash(rel))
					}
					return nil
				})
			}
			files = all
		}
		var b strings.Builder
		count, found := 0, false
		grepOne := func(label, text string) {
			for i, l := range strings.Split(strings.TrimSuffix(text, "\n"), "\n") {
				if re.MatchString(l) != f['v'] {
					count++
					found = true
					if f['c'] || f['l'] {
						continue
					}
					if label != "" {
						b.WriteString(label + ":")
					}
					if f['n'] {
						b.WriteString(strconv.Itoa(i+1) + ":")
					}
					if sh.tty && !f['v'] {
						l = re.ReplaceAllStringFunc(l, func(m string) string { return "\x1b[01;31m" + m + "\x1b[0m" })
					}
					b.WriteString(l + "\n")
				}
			}
		}
		if len(files) == 0 {
			grepOne("", stdin)
		}
		for _, file := range files {
			d, err := os.ReadFile(sh.h.real(sh.abs(file)))
			if err != nil {
				if !f['s'] {
					b.WriteString(fmt.Sprintf("grep: %s: No such file or directory\n", file))
				}
				continue
			}
			before := count
			label := ""
			if len(files) > 1 {
				label = file
			}
			grepOne(label, string(d))
			if f['l'] && count > before {
				b.WriteString(file + "\n")
			}
		}
		if f['c'] {
			b.WriteString(strconv.Itoa(count) + "\n")
		}
		if !found {
			return b.String(), 1
		}
		return b.String(), 0
	case "wc":
		f, files := flags(args)
		s, errs, code := sh.read("wc", files, stdin)
		lines, wordsN, chars := strings.Count(s, "\n"), len(strings.Fields(s)), len(s)
		name := ""
		if len(files) == 1 {
			name = " " + files[0]
		}
		switch {
		case f['l']:
			return fmt.Sprintf("%d%s\n", lines, name) + errs, code
		case f['w']:
			return fmt.Sprintf("%d%s\n", wordsN, name) + errs, code
		case f['c'] || f['m']:
			return fmt.Sprintf("%d%s\n", chars, name) + errs, code
		}
		return fmt.Sprintf("%7d %7d %7d%s\n", lines, wordsN, chars, name) + errs, code
	case "sort":
		f, files := flags(args)
		s, errs, code := sh.read("sort", files, stdin)
		lines := strings.Split(strings.TrimSuffix(s, "\n"), "\n")
		if f['n'] {
			sort.SliceStable(lines, func(i, j int) bool { return leadNum(lines[i]) < leadNum(lines[j]) })
		} else {
			sort.Strings(lines)
		}
		if f['r'] {
			for i, j := 0, len(lines)-1; i < j; i, j = i+1, j-1 {
				lines[i], lines[j] = lines[j], lines[i]
			}
		}
		if len(lines) == 1 && lines[0] == "" {
			return errs, code
		}
		return strings.Join(lines, "\n") + "\n" + errs, code
	case "uniq":
		f, files := flags(args)
		s, _, _ := sh.read("uniq", files, stdin)
		var b strings.Builder
		lines := strings.Split(strings.TrimSuffix(s, "\n"), "\n")
		for i := 0; i < len(lines); {
			j := i
			for j < len(lines) && lines[j] == lines[i] {
				j++
			}
			if f['c'] {
				b.WriteString(fmt.Sprintf("%7d %s\n", j-i, lines[i]))
			} else {
				b.WriteString(lines[i] + "\n")
			}
			i = j
		}
		return b.String(), 0
	case "echo":
		nl := "\n"
		if len(args) > 0 && args[0] == "-n" {
			args, nl = args[1:], ""
		} else if len(args) > 0 && args[0] == "-e" {
			args = args[1:]
			for i := range args {
				args[i] = strings.NewReplacer(`\n`, "\n", `\t`, "\t").Replace(args[i])
			}
		}
		return strings.Join(args, " ") + nl, 0
	case "printf":
		if len(args) == 0 {
			return "", 0
		}
		s := strings.NewReplacer(`\n`, "\n", `\t`, "\t", `\033`, "\x1b", `\007`, "\a").Replace(args[0])
		vals := make([]any, len(args)-1)
		for i, v := range args[1:] {
			vals[i] = v
		}
		if len(vals) > 0 {
			s = fmt.Sprintf(strings.ReplaceAll(s, "%d", "%v"), vals...)
		}
		return s, 0
	case "whoami":
		return sh.h.user + "\n", 0
	case "id":
		return fmt.Sprintf("uid=1001(%s) gid=1001(%s) groups=1001(%s),1100(payments)\n", sh.h.user, sh.h.user, sh.h.user), 0
	case "hostname":
		return sh.h.name + "\n", 0
	case "uname":
		if len(args) > 0 && strings.Contains(args[0], "a") {
			return fmt.Sprintf("Linux %s 5.14.0-427.el9.x86_64 #1 SMP PREEMPT_DYNAMIC x86_64 x86_64 x86_64 GNU/Linux\n", sh.h.name), 0
		}
		return "Linux\n", 0
	case "date":
		return time.Now().Format("Mon Jan _2 15:04:05 MST 2006") + "\n", 0
	case "uptime":
		return time.Now().Format(" 15:04:05") + " up 41 days,  3:12,  1 user,  load average: 0.42, 0.51, 0.47\n", 0
	case "df":
		return `Filesystem                 Size  Used Avail Use% Mounted on
/dev/mapper/rhel-root       50G   21G   30G  42% /
/dev/mapper/rhel-opt       200G  143G   58G  72% /opt
/dev/mapper/rhel-var        30G   26G  4.1G  87% /var
/dev/sda1                 1014M  312M  703M  31% /boot
tmpfs                      7.8G     0  7.8G   0% /dev/shm
`, 0
	case "free":
		return `               total        used        free      shared  buff/cache   available
Mem:           15876        9311        2104         412        4460        6212
Swap:           4095           0        4095
`, 0
	case "ps":
		return fmt.Sprintf(`UID          PID    PPID  C STIME TTY          TIME CMD
root           1       0  0 Oct18 ?        00:03:12 /usr/lib/systemd/systemd
root        1187       1  0 Oct18 ?        00:21:05 /usr/sbin/sshd -D
%-8s     2231       1  6 Oct18 ?        13:32:44 java -Xmx4g -jar /opt/%s/lib/%s.jar --spring.profiles.active=uat
root        1402       1  0 Oct18 ?        00:09:41 /usr/local/bin/node_exporter
%-8s     %d    1187  0 %s pts/0    00:00:00 -bash
`, sh.h.user, sh.h.key, sh.h.lab.appName(sh.h.key), sh.h.user, sh.pid+4000, time.Now().Format("15:04")), 0
	case "top", "htop":
		return sh.topText(), 0
	case "ping":
		host := args[len(args)-1]
		return fmt.Sprintf("PING %s (10.0.0.31) 56(84) bytes of data.\n64 bytes from %s: icmp_seq=1 ttl=64 time=0.41 ms\n\n--- %s ping statistics ---\n1 packets transmitted, 1 received, 0%% packet loss\n", host, host, host), 0
	case "clear":
		return "\x1b[H\x1b[2J", 0
	case "exit", "logout":
		sh.quit = true
		if len(args) > 0 {
			sh.exitCd, _ = strconv.Atoi(args[0])
		}
		return "logout\n", sh.exitCd
	case "history":
		var b strings.Builder
		for i, h := range sh.hist {
			b.WriteString(fmt.Sprintf("%5d  %s\n", i+1, h))
		}
		return b.String(), 0
	case "env", "printenv", "export", "set":
		if cmd == "export" && len(args) > 0 {
			for _, kv := range args {
				if k, v, ok := strings.Cut(kv, "="); ok {
					sh.vars[k] = v
				}
			}
			return "", 0
		}
		keys := make([]string, 0, len(sh.vars))
		for k := range sh.vars {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		var b strings.Builder
		for _, k := range keys {
			b.WriteString(k + "=" + sh.vars[k] + "\n")
		}
		return b.String() + "PWD=" + sh.cwd + "\n", 0
	case "mkdir":
		_, rest := flags(args)
		for _, d := range rest {
			if err := os.MkdirAll(sh.h.real(sh.abs(d)), 0o755); err != nil {
				return "mkdir: cannot create directory '" + d + "'\n", 1
			}
		}
		return "", 0
	case "touch":
		for _, x := range args {
			p := sh.h.real(sh.abs(x))
			if f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY, 0o644); err == nil {
				f.Close()
				now := time.Now()
				_ = os.Chtimes(p, now, now)
			} else {
				return "touch: cannot touch '" + x + "': No such file or directory\n", 1
			}
		}
		return "", 0
	case "rm", "rmdir":
		f, rest := flags(args)
		for _, x := range rest {
			p := sh.abs(x)
			if p == "/" || p == sh.h.home() {
				return "rm: refusing to remove '" + x + "'\n", 1
			}
			var err error
			if f['r'] || f['R'] {
				err = os.RemoveAll(sh.h.real(p))
			} else {
				err = os.Remove(sh.h.real(p))
			}
			if err != nil && !f['f'] {
				return "rm: cannot remove '" + x + "': No such file or directory\n", 1
			}
		}
		return "", 0
	case "cp", "mv":
		_, rest := flags(args)
		if len(rest) < 2 {
			return cmd + ": missing file operand\n", 1
		}
		to := sh.abs(rest[len(rest)-1])
		for _, x := range rest[:len(rest)-1] {
			dst := to
			if sh.h.isDir(to) {
				dst = path.Join(to, path.Base(x))
			}
			src := sh.h.real(sh.abs(x))
			var err error
			if cmd == "mv" {
				err = os.Rename(src, sh.h.real(dst))
			} else {
				var b []byte
				if b, err = os.ReadFile(src); err == nil {
					err = os.WriteFile(sh.h.real(dst), b, 0o644)
				}
			}
			if err != nil {
				return fmt.Sprintf("%s: cannot stat '%s': No such file or directory\n", cmd, x), 1
			}
		}
		return "", 0
	case "find":
		dir, pat := ".", "*"
		if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
			dir = args[0]
		}
		for i := 0; i+1 < len(args); i++ {
			if args[i] == "-name" || args[i] == "-iname" {
				pat = args[i+1]
			}
		}
		var b strings.Builder
		base := sh.h.real(sh.abs(dir))
		_ = filepath.Walk(base, func(p string, fi os.FileInfo, err error) error {
			if err != nil {
				return nil
			}
			if ok, _ := filepath.Match(pat, fi.Name()); ok {
				rel, _ := filepath.Rel(base, p)
				b.WriteString(path.Join(dir, filepath.ToSlash(rel)) + "\n")
			}
			return nil
		})
		return b.String(), 0
	case "du":
		_, rest := flags(args)
		var b strings.Builder
		for _, d := range orList(rest, ".") {
			var n int64
			_ = filepath.Walk(sh.h.real(sh.abs(d)), func(_ string, fi os.FileInfo, err error) error {
				if err == nil {
					n += fi.Size()
				}
				return nil
			})
			b.WriteString(human(n) + "\t" + d + "\n")
		}
		return b.String(), 0
	case "sleep":
		return "", 0
	case "true", ":":
		return "", 0
	case "false":
		return "", 1
	case "which", "type", "command":
		if len(args) > 0 && args[0] == "-v" {
			args = args[1:]
		}
		if len(args) == 0 {
			return "", 1
		}
		if args[0] == "tcpdump" {
			return "/usr/sbin/tcpdump\n", 0
		}
		return "/usr/bin/" + args[0] + "\n", 0
	case "systemctl", "service":
		if cmd == "service" && len(args) >= 2 {
			args = []string{args[1], args[0]}
		}
		if len(args) < 2 {
			return "", 0
		}
		svc := strings.TrimSuffix(args[1], ".service")
		switch args[0] {
		case "status":
			return fmt.Sprintf(`● %s.service - Acme %s
     Loaded: loaded (/etc/systemd/system/%s.service; enabled; preset: disabled)
     Active: active (running) since %s; 2 days ago
   Main PID: 2231 (java)
      Tasks: 61 (limit: 98304)
     Memory: 2.1G
        CPU: 13h 32min 44.102s
     CGroup: /system.slice/%s.service
             └─2231 java -Xmx4g -jar /opt/%s/lib/%s.jar
`, svc, svc, svc, time.Now().Add(-50*time.Hour).Format("Mon 2006-01-02 15:04:05 MST"), svc, sh.h.key, svc), 0
		case "restart", "stop", "start", "reload":
			sh.h.lab.logLine(sh.h.key, "INFO ", "c.a.pay.Lifecycle - "+svc+" "+args[0]+" requested by "+sh.h.user)
			return "", 0
		}
		return "", 0
	case "journalctl":
		s, _, _ := sh.read("journalctl", []string{sh.h.lab.mainLog(sh.h.key)}, "")
		return lastLines(s, 20), 0
	case "netstat", "ss":
		return `Netid State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process
tcp   LISTEN 0      128          0.0.0.0:22         0.0.0.0:*
tcp   LISTEN 0      100          0.0.0.0:8443       0.0.0.0:*     users:(("java",pid=2231))
tcp   ESTAB  0      0          10.0.0.21:52344    10.0.0.31:1521  users:(("java",pid=2231))
`, 0
	case "java":
		return "openjdk version \"17.0.12\" 2024-07-16 LTS\nOpenJDK Runtime Environment (build 17.0.12+7-LTS)\n", 0
	case "curl", "wget":
		u := ""
		for _, x := range args {
			if strings.Contains(x, "://") || strings.HasPrefix(x, "localhost") {
				u = x
			}
		}
		if strings.Contains(u, "health") || strings.Contains(u, "localhost") {
			return `{"status":"UP","components":{"db":{"status":"UP"},"diskSpace":{"status":"UP"}}}` + "\n", 0
		}
		return "curl: (6) Could not resolve host (the demo servers have no internet)\n", 6
	case "vi", "vim", "nano", "emacs":
		return "This demo server has no editor: open the file from the FTP page (double-click it) to edit it.\n", 1
	case "bash", "sh", "source", ".":
		if len(args) == 0 {
			return "", 0
		}
		if args[0] == "-c" && len(args) > 1 {
			return sh.capture(args[1]), sh.exitCd
		}
		return sh.script(args[0])
	case "help":
		return "Demo server commands: ls cd pwd cat less head tail [-f] grep wc sort uniq find du df free ps top ping\nsystemctl status|restart <service>  mkdir touch rm cp mv echo date uptime hostname whoami history clear exit\nRun a script: ./script.sh or bash script.sh\n", 0
	}
	if strings.Contains(cmd, "/") || strings.HasSuffix(cmd, ".sh") { // ./restart.sh, bin/run_eod.sh
		return sh.script(cmd)
	}
	return fmt.Sprintf("bash: %s: command not found\n", cmd), 127
}

// capture runs a command line and returns what it printed.
func (sh *demoShell) capture(line string) string {
	var b strings.Builder
	w, tty := sh.w, sh.tty
	sh.w, sh.tty = &b, false
	sh.run(line)
	sh.w, sh.tty = w, tty
	return b.String()
}

// script runs a shell script from the demo files line by line.
func (sh *demoShell) script(name string) (string, int) {
	b, err := os.ReadFile(sh.h.real(sh.abs(name)))
	if err != nil {
		return "bash: " + name + ": No such file or directory\n", 127
	}
	var out strings.Builder
	code := 0
	for _, l := range strings.Split(string(b), "\n") {
		l = strings.TrimSpace(l)
		if l == "" || strings.HasPrefix(l, "#") || strings.HasPrefix(l, "set ") {
			continue
		}
		// a script's sleeps are short so the output comes as it would on a server
		if strings.HasPrefix(l, "sleep ") {
			out.WriteString("")
		}
		s := sh.capture(l)
		out.WriteString(s)
		if sh.tty { // show each step as it happens
			sh.out(out.String())
			out.Reset()
			if strings.Contains(l, "sleep") {
				time.Sleep(800 * time.Millisecond)
			}
		}
		code = sh.exitCd
	}
	return out.String(), code
}

func leadNum(s string) float64 {
	s = strings.TrimSpace(s)
	i := 0
	for i < len(s) && (s[i] >= '0' && s[i] <= '9' || s[i] == '.') {
		i++
	}
	f, _ := strconv.ParseFloat(s[:i], 64)
	return f
}

func orList(l []string, d string) []string {
	if len(l) == 0 {
		return []string{d}
	}
	return l
}
