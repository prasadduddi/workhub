package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestParsePR(t *testing.T) {
	for in, want := range map[string]string{
		"https://bitbucket.example.com/projects/PAY/repos/refunds/pull-requests/123/overview": "bitbucket pay/refunds 123",
		"https://bitbucket.example.com/users/jdoe/repos/tools/pull-requests/7":                "bitbucket ~jdoe/tools 7",
		"https://gitlab.example.com/payments/team/refunds/-/merge_requests/42":                "gitlab payments/team/refunds 42",
	} {
		pr, err := parsePR(in)
		if err != nil {
			t.Fatalf("%s: %v", in, err)
		}
		if got := pr.Kind + " " + pr.Repo + " " + strconv.Itoa(pr.Number); got != want {
			t.Errorf("%s → %s, want %s", in, got, want)
		}
	}
	if _, err := parsePR("https://example.com/whatever"); err == nil {
		t.Error("a non-PR address was accepted")
	}
	for remote, want := range map[string]string{
		"https://bitbucket.example.com/scm/pay/refunds.git":    "bitbucket.example.com pay/refunds",
		"ssh://git@bitbucket.example.com:7999/pay/refunds.git": "bitbucket.example.com pay/refunds",
		"git@gitlab.example.com:payments/team/refunds.git":     "gitlab.example.com payments/team/refunds",
		"https://gitlab.example.com/payments/team/refunds.git": "gitlab.example.com payments/team/refunds",
	} {
		h, r := remoteRepo(remote)
		if h+" "+r != want {
			t.Errorf("%s → %s %s", remote, h, r)
		}
	}
}

func itoa(n int) string {
	return strings.TrimSpace(strings.Repeat(" ", 0) + string(rune('0'+n/100%10)) + string(rune('0'+n/10%10)) + string(rune('0'+n%10)))
}

func gitT(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=Test", "GIT_AUTHOR_EMAIL=test@example.com", "GIT_COMMITTER_NAME=Test", "GIT_COMMITTER_EMAIL=test@example.com", "GIT_CONFIG_GLOBAL=/dev/null")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %s", args, out)
	}
	return strings.TrimSpace(string(out))
}

func TestReviewPR(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	root := t.TempDir()
	server, work, clone := filepath.Join(root, "server.git"), filepath.Join(root, "work"), filepath.Join(root, "clone")
	gitT(t, root, "init", "-q", "--bare", "-b", "develop", server)
	gitT(t, root, "init", "-q", "-b", "develop", work)
	os.WriteFile(filepath.Join(work, "Refunds.java"), []byte("class Refunds {\n  int limit = 5000;\n}\n"), 0o644)
	gitT(t, work, "add", ".")
	gitT(t, work, "commit", "-qm", "start")
	gitT(t, work, "push", "-q", server, "develop")
	gitT(t, work, "checkout", "-qb", "feature/PAY-201")
	os.WriteFile(filepath.Join(work, "Refunds.java"), []byte("class Refunds {\n  int limit = 10000;\n  String password = \"Fake#Pass1\";\n  void purge() { run(\"DELETE FROM refunds\"); }\n  void go() { try { x(); } catch (Exception e) {} System.out.println(\"debug\"); }\n  String host = \"10.20.30.40\"; // TODO move to config\n}\n"), 0o644)
	os.WriteFile(filepath.Join(work, ".env"), []byte("X=1\n"), 0o644)
	gitT(t, work, "add", ".")
	gitT(t, work, "commit", "-qm", "PAY-201 raise refund limit")
	gitT(t, work, "push", "-q", server, "HEAD:refs/pull-requests/1/from", "HEAD:refs/merge-requests/2/head")
	gitT(t, work, "checkout", "-q", "develop")
	gitT(t, work, "merge", "-q", "--no-ff", "-m", "merge", "feature/PAY-201")
	gitT(t, work, "push", "-q", server, "HEAD:refs/pull-requests/1/merge")
	// your clone: remotes look like the real servers; git is told to fetch them from the folder
	gitT(t, root, "clone", "-q", server, clone)
	gitT(t, clone, "remote", "set-url", "origin", "https://bitbucket.example.com/scm/pay/refunds.git")
	gitT(t, clone, "remote", "add", "lab", "git@gitlab.example.com:payments/team/refunds.git")
	gitT(t, clone, "config", "url."+server+".insteadOf", "https://bitbucket.example.com/scm/pay/refunds.git")
	gitT(t, clone, "config", "--add", "url."+server+".insteadOf", "git@gitlab.example.com:payments/team/refunds.git")
	gitT(t, clone, "fetch", "-q", "lab")
	t.Setenv("GIT_CONFIG_GLOBAL", "/dev/null")

	s, _ := OpenStore(t.TempDir())
	st := s.Settings()
	st.Repos = []string{clone}
	s.SetSettings(st)
	a := &App{store: s}
	branchBefore := gitT(t, clone, "rev-parse", "HEAD")

	for _, u := range []string{"https://bitbucket.example.com/projects/PAY/repos/refunds/pull-requests/1", "https://gitlab.example.com/payments/team/refunds/-/merge_requests/2"} {
		res, err := a.reviewPR(context.Background(), u, "")
		if err != nil {
			t.Fatalf("%s: %v", u, err)
		}
		var rules []string
		for _, f := range res.Findings {
			rules = append(rules, f.Rule)
			if f.Rule == "secret" && strings.Contains(f.Text, "Fake#Pass1") {
				t.Errorf("the secret is shown in the review: %q", f.Text)
			}
		}
		got := strings.Join(rules, " ")
		for _, want := range []string{"secret", "keyfile", "sqlall", "emptycatch", "debug", "ip", "todo", "notests"} {
			if !strings.Contains(got, want) {
				t.Errorf("%s: missing %s in %s", u, want, got)
			}
		}
		if len(res.Files) != 2 || res.Jira != "PAY-201" || len(res.Commits) != 1 || len(res.Base) < 7 || len(res.Head) < 7 {
			t.Errorf("%s: files %+v jira %q commits %v", u, res.Files, res.Jira, res.Commits)
		}
	}
	if gitT(t, clone, "rev-parse", "HEAD") != branchBefore || gitT(t, clone, "status", "--porcelain") != "" {
		t.Fatal("the review changed the clone's branch or files")
	}
}
