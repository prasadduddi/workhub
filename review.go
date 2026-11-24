package main

// Code review of a pull request (Bitbucket Server / Data Center, GitLab):
// WorkHub finds your local clone of the repository (Git page), fetches just
// the pull request with your normal git login into refs/workhub/… (your
// branches and files are not touched; nothing is sent to Bitbucket or
// GitLab), and checks the lines it adds: secrets and passwords, merge
// markers, SQL that changes every row, debug output, empty catch blocks,
// hard-coded addresses, TODOs, skipped tests, big or key files — and whether
// tests changed with the code. Everything runs on this PC.

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

type prRef struct {
	Web    string `json:"web"`
	Host   string `json:"host"`
	Kind   string `json:"kind"` // bitbucket, gitlab
	Repo   string `json:"repo"` // project/repo (lower case)
	Number int    `json:"number"`
}

var (
	reBBSPR    = regexp.MustCompile(`(?i)^/(?:projects|users)/([^/]+)/repos/([^/]+)/pull-requests/(\d+)`)
	reGitLabMR = regexp.MustCompile(`(?i)^/(.+?)/-/merge_requests/(\d+)`)
)

func parsePR(s string) (*prRef, error) {
	u, err := url.Parse(strings.TrimSpace(s))
	if err != nil || u.Host == "" {
		return nil, errors.New("paste the pull request's web address, e.g. https://bitbucket.example.com/projects/PAY/repos/refunds/pull-requests/123")
	}
	p := strings.TrimSuffix(u.Path, "/")
	if m := reBBSPR.FindStringSubmatch(p); m != nil {
		n, _ := strconv.Atoi(m[3])
		owner := m[1]
		if strings.HasPrefix(strings.ToLower(p), "/users/") {
			owner = "~" + owner
		}
		return &prRef{Web: s, Host: strings.ToLower(u.Hostname()), Kind: "bitbucket", Repo: strings.ToLower(owner + "/" + m[2]), Number: n}, nil
	}
	if m := reGitLabMR.FindStringSubmatch(p); m != nil {
		n, _ := strconv.Atoi(m[2])
		return &prRef{Web: s, Host: strings.ToLower(u.Hostname()), Kind: "gitlab", Repo: strings.ToLower(m[1]), Number: n}, nil
	}
	return nil, errors.New("that isn't a Bitbucket pull request (…/projects/X/repos/Y/pull-requests/N) or a GitLab merge request (…/group/repo/-/merge_requests/N)")
}

// remoteRepo turns a clone address into host and project/repo, e.g.
// https://bitbucket.example.com/scm/pay/refunds.git and
// ssh://git@bitbucket.example.com:7999/pay/refunds.git → pay/refunds.
func remoteRepo(remote string) (host, repo string) {
	r := strings.TrimSpace(remote)
	if !strings.Contains(r, "://") { // git@host:group/repo.git
		if at := strings.Index(r, "@"); at >= 0 {
			r = r[at+1:]
		}
		if i := strings.Index(r, ":"); i > 0 {
			return strings.ToLower(r[:i]), strings.ToLower(strings.TrimSuffix(strings.Trim(r[i+1:], "/"), ".git"))
		}
		return "", ""
	}
	u, err := url.Parse(r)
	if err != nil {
		return "", ""
	}
	p := strings.TrimSuffix(strings.Trim(u.Path, "/"), ".git")
	p = strings.TrimPrefix(p, "scm/") // Bitbucket Server http clone path
	return strings.ToLower(u.Hostname()), strings.ToLower(p)
}

type gitRunner struct {
	exe, dir string
	ctx      context.Context
}

func (g gitRunner) run(args ...string) (string, error) {
	cmd := exec.CommandContext(g.ctx, g.exe, args...)
	cmd.Dir = g.dir
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "LC_ALL=C")
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		return out.String(), fmt.Errorf("git %s: %s", args[0], strings.TrimSpace(errb.String()+" "+err.Error()))
	}
	return out.String(), nil
}

// findClone: the local repository (from the Git page) whose remote is this PR's.
func (a *App) findClone(pr *prRef, exe string, ctx context.Context) (dir, remote string) {
	var byName []string
	for _, dir := range a.store.Settings().Repos {
		// the remotes as configured (git remote -v would show them after url.*.insteadOf rewriting)
		out, err := gitRunner{exe, dir, ctx}.run("config", "--get-regexp", `^remote\..*\.url$`)
		if err != nil {
			continue
		}
		for _, line := range strings.Split(out, "\n") {
			f := strings.Fields(line)
			if len(f) < 2 {
				continue
			}
			f[0] = strings.TrimSuffix(strings.TrimPrefix(f[0], "remote."), ".url")
			h, r := remoteRepo(f[1])
			if r == pr.Repo && (h == pr.Host || h == "") {
				return dir, f[0]
			}
			if path.Base(r) == path.Base(pr.Repo) {
				byName = append(byName, dir+"\x00"+f[0])
			}
		}
	}
	if len(byName) == 1 { // e.g. cloned through a different host name
		d, r, _ := strings.Cut(byName[0], "\x00")
		return d, r
	}
	return "", ""
}

// ---- the checks ----

type reviewRule struct {
	ID, Severity, Title, Why string
	re                       *regexp.Regexp
	files                    *regexp.Regexp // only these files (nil: all)
}

var reviewRules = []reviewRule{
	{"secret", "high", "Password or secret in the code", "Secrets in git stay in its history for good — use the vault / environment / config outside the repo, and change this one.",
		regexp.MustCompile(`(?i)\b(pass(word|wd)?|pwd|secret|api[_-]?key|access[_-]?key|token|client[_-]?secret)\b\s*[:=]\s*["']?[^\s"'$<{][^\s"']{3,}`), nil},
	{"privkey", "high", "Private key in the code", "Private keys must never be committed.", regexp.MustCompile(`-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----`), nil},
	{"awskey", "high", "Cloud access key", "Looks like an AWS access key id.", regexp.MustCompile(`\bAKIA[0-9A-Z]{16}\b`), nil},
	{"jdbcpw", "high", "Database address with a password", "A connection string with the password in it.", regexp.MustCompile(`(?i)jdbc:[a-z]+:.*(password|pwd)=[^;&\s]+`), nil},
	{"conflict", "high", "Merge conflict marker", "Left over from a merge — the file won't build or will behave oddly.", regexp.MustCompile(`^(<{7}|={7}|>{7})( |$)`), nil},
	{"sqlall", "high", "SQL that changes every row", "DELETE / UPDATE without WHERE (or TRUNCATE / DROP) — check this is meant.",
		regexp.MustCompile(`(?i)\b(delete\s+from\s+[\w."]+\s*(;|$|["'])|truncate\s+table\b|drop\s+(table|user|schema)\b|update\s+[\w."]+\s+set\s+[^;]*?(;|$))`), nil},
	{"emptycatch", "medium", "Error swallowed", "An empty catch hides failures — log it or handle it.", regexp.MustCompile(`catch\s*\([^)]*\)\s*\{\s*\}|except[^:]*:\s*pass\b`), nil},
	{"debug", "medium", "Debug output", "Use the logger instead of printing to the console.",
		regexp.MustCompile(`\b(System\.(out|err)\.print(ln)?|printStackTrace\(\)|console\.(log|debug)\(|debugger;)`), nil},
	{"logpw", "high", "Password written to the log", "Logs are read by many people and kept for long.", regexp.MustCompile(`(?i)\b(log|logger|LOG)\.\w+\(.*\b(password|passwd|pwd|secret)\b`), nil},
	{"ip", "medium", "Hard-coded IP address", "Put addresses in configuration, so each environment can differ.", regexp.MustCompile(`\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b`), nil},
	{"sleep", "low", "Fixed wait", "Thread.sleep / sleep() makes code slow and flaky — wait for the condition instead.", regexp.MustCompile(`\bThread\.sleep\(|\btime\.sleep\(`), nil},
	{"skiptest", "medium", "Test switched off", "A skipped test hides a problem.", regexp.MustCompile(`@Ignore\b|@Disabled\b|\b(it|describe|test)\.(skip|only)\(|@pytest\.mark\.skip`), nil},
	{"todo", "low", "TODO / FIXME left in", "Make sure there is a ticket for it.", regexp.MustCompile(`\b(TODO|FIXME|XXX|HACK)\b`), nil},
}

var (
	reTestFile = regexp.MustCompile(`(?i)(^|/)(test|tests|__tests__|spec)/|(_test\.go|Test\.java|Tests\.java|IT\.java|\.test\.[jt]sx?|\.spec\.[jt]sx?|_test\.py|test_[^/]+\.py)$`)
	reCodeFile = regexp.MustCompile(`(?i)\.(java|kt|go|py|js|ts|jsx|tsx|cs|scala|groovy|sql|plsql|pkb|pks)$`)
	reKeyFile  = regexp.MustCompile(`(?i)(^|/)(\.env(\..*)?|id_rsa|id_dsa|[^/]+\.(pem|key|p12|pfx|jks|keystore))$`)
	// a secret read from somewhere else, or a placeholder: fine
	reSecretOK = regexp.MustCompile(`(?i)(\$\{|%\(|getenv|System\.getProperty|process\.env|os\.environ|vault|placeholder|changeme|\*{3,}|<[a-z_-]+>)`)
	reRenamed  = regexp.MustCompile(`\{[^}]* => ([^}]*)\}`)
)

// ipNoise: version numbers (1.2.3.4 in a pom) and local / documentation addresses.
func ipNoise(line, ip string) bool {
	if strings.HasPrefix(ip, "127.") || strings.HasPrefix(ip, "0.") || strings.HasPrefix(ip, "255.") || strings.HasPrefix(ip, "192.0.2.") || strings.HasPrefix(ip, "198.51.100.") || strings.HasPrefix(ip, "203.0.113.") {
		return true
	}
	l := strings.ToLower(line)
	return strings.Contains(l, "version") || strings.Contains(l, "<version") || strings.Contains(l, "oid")
}

type reviewFinding struct {
	Rule     string `json:"rule"`
	Severity string `json:"severity"`
	Title    string `json:"title"`
	Why      string `json:"why"`
	File     string `json:"file"`
	Line     int    `json:"line"`
	Text     string `json:"text"`
}

type reviewFile struct {
	Path    string `json:"path"`
	Added   int    `json:"added"`
	Deleted int    `json:"deleted"`
	Binary  bool   `json:"binary,omitempty"`
}

type reviewResult struct {
	PR       prRef           `json:"pr"`
	RepoDir  string          `json:"repo_dir"`
	Base     string          `json:"base"`
	Head     string          `json:"head"`
	Target   string          `json:"target"`
	Commits  []string        `json:"commits"`
	Files    []reviewFile    `json:"files"`
	Findings []reviewFinding `json:"findings"`
	Jira     string          `json:"jira,omitempty"`
}

var reHunk = regexp.MustCompile(`^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@`)

// checkDiff runs the rules on the lines a unified diff adds.
func checkDiff(diff string) []reviewFinding {
	var out []reviewFinding
	file, line := "", 0
	per := map[string]int{}
	sc := bufio.NewScanner(strings.NewReader(diff))
	sc.Buffer(make([]byte, 1<<20), 8<<20)
	for sc.Scan() {
		t := sc.Text()
		switch {
		case strings.HasPrefix(t, "+++ "):
			file = strings.TrimPrefix(strings.TrimPrefix(t[4:], "b/"), "\"")
			continue
		case strings.HasPrefix(t, "@@"):
			if m := reHunk.FindStringSubmatch(t); m != nil {
				line, _ = strconv.Atoi(m[1])
			}
			continue
		case strings.HasPrefix(t, "+"):
			added := t[1:]
			for _, r := range reviewRules {
				if r.files != nil && !r.files.MatchString(file) {
					continue
				}
				m := r.re.FindString(added)
				if m == "" {
					continue
				}
				if r.ID == "ip" && ipNoise(added, m) {
					continue
				}
				if r.ID == "secret" && reSecretOK.MatchString(added) {
					continue
				}
				if per[file+r.ID] >= 5 { // enough of one kind in one file
					continue
				}
				per[file+r.ID]++
				text := strings.TrimSpace(added)
				if r.Severity == "high" && (r.ID == "secret" || r.ID == "jdbcpw" || r.ID == "awskey") {
					text = maskSecret(text)
				}
				if len(text) > 200 {
					text = text[:200] + "…"
				}
				out = append(out, reviewFinding{r.ID, r.Severity, r.Title, r.Why, file, line, text})
			}
			line++
		case strings.HasPrefix(t, " "):
			line++
		}
	}
	return out
}

var reSecretValue = regexp.MustCompile(`([:=]\s*["']?)([^\s"';&]{2})[^\s"';&]*`)

// maskSecret keeps the shape of a line but not the secret itself.
func maskSecret(s string) string {
	return reSecretValue.ReplaceAllString(s, "${1}${2}••••••")
}

func severityRank(s string) int { return map[string]int{"high": 0, "medium": 1, "low": 2}[s] }

// reviewPR does the whole review.
func (a *App) reviewPR(ctx context.Context, prURL, target string) (*reviewResult, error) {
	pr, err := parsePR(prURL)
	if err != nil {
		return nil, err
	}
	exe, err := exec.LookPath("git")
	if err != nil {
		return nil, errors.New("Git is not installed on this PC — the review fetches the pull request with git")
	}
	dir, remote := a.findClone(pr, exe, ctx)
	if dir == "" {
		return nil, fmt.Errorf("no local copy of %s — add it on the Git page (+ or Find), then try again", pr.Repo)
	}
	g := gitRunner{exe, dir, ctx}
	n := strconv.Itoa(pr.Number)
	local := "refs/workhub/pr/" + n
	var head, base string
	switch pr.Kind {
	case "bitbucket":
		// "from" is the PR's branch; "merge" is it merged into the target (when it merges cleanly)
		if _, err := g.run("fetch", "--no-tags", remote, "+refs/pull-requests/"+n+"/from:"+local+"/from", "+refs/pull-requests/"+n+"/merge:"+local+"/merge"); err == nil && target == "" {
			head, base = local+"/merge", local+"/merge^1"
		} else if _, err := g.run("fetch", "--no-tags", remote, "+refs/pull-requests/"+n+"/from:"+local+"/from"); err != nil {
			return nil, fmt.Errorf("couldn't fetch pull request %d from %s (%v)", pr.Number, remote, err)
		} else {
			head = local + "/from"
		}
	case "gitlab":
		if _, err := g.run("fetch", "--no-tags", remote, "+refs/merge-requests/"+n+"/head:"+local+"/head"); err != nil {
			return nil, fmt.Errorf("couldn't fetch merge request %d from %s (%v)", pr.Number, remote, err)
		}
		head = local + "/head"
	}
	if base == "" { // compare with the target branch (given, or the remote's default)
		t := target
		if t == "" {
			if s, err := g.run("symbolic-ref", "--short", "refs/remotes/"+remote+"/HEAD"); err == nil {
				t = strings.TrimSpace(s)
			}
			for _, b := range []string{"develop", "main", "master"} {
				if t != "" {
					break
				}
				if _, err := g.run("rev-parse", "--verify", "-q", remote+"/"+b); err == nil {
					t = remote + "/" + b
				}
			}
		} else if !strings.Contains(t, "/") {
			_, _ = g.run("fetch", "--no-tags", remote, t)
			t = remote + "/" + t
		}
		if t == "" {
			return nil, errors.New("couldn't tell the target branch — type it (e.g. develop)")
		}
		mb, err := g.run("merge-base", t, head)
		if err != nil {
			return nil, fmt.Errorf("couldn't compare with %s: %v", t, err)
		}
		base, target = strings.TrimSpace(mb), t
	}
	res := &reviewResult{PR: *pr, RepoDir: dir, Target: target}
	short := func(rev string) string { s, _ := g.run("rev-parse", "--short", rev); return strings.TrimSpace(s) } // one at a time: --short takes one
	res.Base, res.Head = short(base), short(head)
	if s, err := g.run("log", "--no-merges", "--format=%h %s", base+".."+head); err == nil {
		for _, l := range strings.Split(strings.TrimSpace(s), "\n") {
			if l != "" && len(res.Commits) < 100 {
				res.Commits = append(res.Commits, l)
			}
		}
	}
	if keys := jiraKeysIn(strings.Join(res.Commits, " ")); len(keys) > 0 {
		res.Jira = keys[0]
	}
	stat, err := g.run("diff", "--numstat", "-M", base, head)
	if err != nil {
		return nil, err
	}
	for _, l := range strings.Split(strings.TrimSpace(stat), "\n") {
		f := strings.SplitN(l, "\t", 3)
		if len(f) < 3 {
			continue
		}
		rf := reviewFile{Path: f[2]}
		if f[0] == "-" {
			rf.Binary = true
		} else {
			rf.Added, _ = strconv.Atoi(f[0])
			rf.Deleted, _ = strconv.Atoi(f[1])
		}
		if strings.Contains(rf.Path, " => ") { // renamed: keep the new name
			rf.Path = strings.Trim(reRenamed.ReplaceAllString(rf.Path, "$1"), " ")
		}
		res.Files = append(res.Files, rf)
	}
	diff, err := g.run("diff", "--no-color", "--unified=0", "-M", base, head)
	if err != nil {
		return nil, err
	}
	res.Findings = checkDiff(diff)
	// whole-PR checks
	code, tests := 0, 0
	for _, f := range res.Files {
		switch {
		case reKeyFile.MatchString(f.Path):
			res.Findings = append(res.Findings, reviewFinding{"keyfile", "high", "Key or environment file added", "Files like .env, .pem, .jks hold secrets — keep them out of the repository.", f.Path, 0, ""})
		case f.Binary:
			res.Findings = append(res.Findings, reviewFinding{"binary", "low", "Binary file", "Binary files can't be reviewed line by line — is it meant to be in git?", f.Path, 0, ""})
		case f.Added > 1500:
			res.Findings = append(res.Findings, reviewFinding{"big", "low", "Very large change in one file", fmt.Sprintf("%d lines added — generated? Worth splitting?", f.Added), f.Path, 0, ""})
		}
		if reTestFile.MatchString(f.Path) {
			tests++
		} else if reCodeFile.MatchString(f.Path) {
			code++
		}
	}
	if code > 0 && tests == 0 {
		res.Findings = append(res.Findings, reviewFinding{"notests", "medium", "No tests changed", fmt.Sprintf("%d code file(s) changed but no test file — are the changes covered?", code), "", 0, ""})
	}
	sort.SliceStable(res.Findings, func(i, j int) bool {
		a, b := res.Findings[i], res.Findings[j]
		return severityRank(a.Severity) < severityRank(b.Severity) || severityRank(a.Severity) == severityRank(b.Severity) && a.File < b.File
	})
	return res, nil
}

func (a *App) handleReview(w http.ResponseWriter, r *http.Request) {
	var in struct{ URL, Target string }
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 4*time.Minute)
	defer cancel()
	res, err := a.reviewPR(ctx, in.URL, strings.TrimSpace(in.Target))
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	writeJSON(w, res)
}
