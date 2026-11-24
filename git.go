package main

import (
	"context"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	git "github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/object"
	"github.com/go-git/go-git/v5/plumbing/storer"
)

// Git browsing is done with go-git, so it works without Git installed.
// Fetch uses the installed git (if any) so the user's usual credentials apply.

func openRepo(p string) (*git.Repository, error) {
	if p == "" {
		return nil, errors.New("no repository chosen")
	}
	return git.PlainOpenWithOptions(p, &git.PlainOpenOptions{DetectDotGit: true})
}

type gitCommit struct {
	Hash    string    `json:"hash"`
	Short   string    `json:"short"`
	Author  string    `json:"author"`
	Email   string    `json:"email"`
	Date    time.Time `json:"date"`
	Subject string    `json:"subject"`
	Body    string    `json:"body,omitempty"`
	Parents []string  `json:"parents"`
	Refs    []string  `json:"refs,omitempty"`
}

func toCommit(c *object.Commit, refs map[plumbing.Hash][]string) gitCommit {
	subject, body, _ := strings.Cut(strings.TrimSpace(c.Message), "\n")
	gc := gitCommit{Hash: c.Hash.String(), Short: c.Hash.String()[:8], Author: c.Author.Name, Email: c.Author.Email,
		Date: c.Author.When, Subject: subject, Body: strings.TrimSpace(body), Refs: refs[c.Hash], Parents: []string{}}
	for _, p := range c.ParentHashes {
		gc.Parents = append(gc.Parents, p.String())
	}
	return gc
}

func refNames(repo *git.Repository) map[plumbing.Hash][]string {
	out := map[plumbing.Hash][]string{}
	iter, err := repo.References()
	if err != nil {
		return out
	}
	_ = iter.ForEach(func(r *plumbing.Reference) error {
		n := r.Name()
		if r.Type() != plumbing.HashReference || n == plumbing.HEAD || strings.HasSuffix(n.String(), "/HEAD") {
			return nil
		}
		h := r.Hash()
		if n.IsTag() {
			if t, err := repo.TagObject(h); err == nil {
				h = t.Target
			}
		}
		out[h] = append(out[h], n.Short())
		return nil
	})
	return out
}

func (a *App) handleGitInfo(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("path")
	repo, err := openRepo(p)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	type branch struct {
		Name    string    `json:"name"`
		Remote  bool      `json:"remote"`
		Current bool      `json:"current"`
		Hash    string    `json:"hash"`
		Date    time.Time `json:"date"`
		Subject string    `json:"subject"`
		Author  string    `json:"author"`
	}
	info := map[string]any{}
	head, err := repo.Head()
	current := ""
	if err == nil {
		if head.Name().IsBranch() {
			current = head.Name().Short()
		} else {
			current = "(detached " + head.Hash().String()[:8] + ")"
		}
	}
	info["current"] = current
	var branches []branch
	iter, _ := repo.References()
	if iter != nil {
		_ = iter.ForEach(func(ref *plumbing.Reference) error {
			n := ref.Name()
			if !(n.IsBranch() || n.IsRemote()) || strings.HasSuffix(n.String(), "/HEAD") || ref.Type() != plumbing.HashReference {
				return nil
			}
			b := branch{Name: n.Short(), Remote: n.IsRemote(), Current: n.IsBranch() && n.Short() == current, Hash: ref.Hash().String()}
			if c, err := repo.CommitObject(ref.Hash()); err == nil {
				b.Date, b.Author = c.Author.When, c.Author.Name
				b.Subject, _, _ = strings.Cut(strings.TrimSpace(c.Message), "\n")
			}
			branches = append(branches, b)
			return nil
		})
	}
	sort.Slice(branches, func(i, j int) bool {
		if branches[i].Remote != branches[j].Remote {
			return !branches[i].Remote
		}
		return branches[i].Date.After(branches[j].Date)
	})
	if branches == nil {
		branches = []branch{}
	}
	info["branches"] = branches
	var remotes []map[string]string
	if rs, err := repo.Remotes(); err == nil {
		for _, rm := range rs {
			remotes = append(remotes, map[string]string{"name": rm.Config().Name, "url": strings.Join(rm.Config().URLs, " ")})
		}
	}
	info["remotes"] = remotes
	if wt, err := repo.Worktree(); err == nil {
		info["root"] = wt.Filesystem.Root()
	}
	_, gitErr := exec.LookPath("git")
	info["has_git"] = gitErr == nil
	writeJSON(w, info)
}

func (a *App) handleGitLog(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	repo, err := openRepo(q.Get("path"))
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 || limit > 2000 {
		limit = 300
	}
	var from plumbing.Hash
	if ref := q.Get("ref"); ref != "" {
		h, err := repo.ResolveRevision(plumbing.Revision(ref))
		if err != nil {
			writeErr(w, 400, err)
			return
		}
		from = *h
	} else {
		head, err := repo.Head()
		if err != nil {
			writeJSON(w, []gitCommit{}) // empty repository
			return
		}
		from = head.Hash()
	}
	opts := &git.LogOptions{From: from, Order: git.LogOrderCommitterTime}
	if f := q.Get("file"); f != "" {
		opts.FileName = &f
	}
	iter, err := repo.Log(opts)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	refs := refNames(repo)
	text := strings.ToLower(q.Get("q"))
	out := []gitCommit{}
	_ = iter.ForEach(func(c *object.Commit) error {
		if text != "" && !strings.Contains(strings.ToLower(c.Message+" "+c.Author.Name+" "+c.Hash.String()), text) {
			return nil
		}
		out = append(out, toCommit(c, refs))
		if len(out) >= limit {
			return storer.ErrStop
		}
		return nil
	})
	writeJSON(w, out)
}

const maxPatch = 600 << 10

// handleGitCommit returns a commit's changed files and its diff.
func (a *App) handleGitCommit(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	repo, err := openRepo(q.Get("path"))
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	c, err := repo.CommitObject(plumbing.NewHash(q.Get("hash")))
	if err != nil {
		writeErr(w, 404, err)
		return
	}
	type file struct {
		Path   string `json:"path"`
		Status string `json:"status"`
		Adds   int    `json:"adds"`
		Dels   int    `json:"dels"`
	}
	res := map[string]any{"commit": toCommit(c, refNames(repo))}
	var parent *object.Commit
	if c.NumParents() > 0 {
		parent, _ = c.Parent(0)
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	var patch *object.Patch
	if parent != nil {
		patch, err = parent.PatchContext(ctx, c)
	} else {
		var tree *object.Tree
		if tree, err = c.Tree(); err == nil {
			var changes object.Changes
			if changes, err = object.DiffTreeWithOptions(ctx, nil, tree, nil); err == nil {
				patch, err = changes.PatchContext(ctx)
			}
		}
	}
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	files := []file{}
	for _, st := range patch.Stats() {
		files = append(files, file{Path: st.Name, Adds: st.Addition, Dels: st.Deletion})
	}
	for i, fp := range patch.FilePatches() {
		if i >= len(files) {
			break
		}
		from, to := fp.Files()
		switch {
		case from == nil:
			files[i].Status = "A"
		case to == nil:
			files[i].Status = "D"
		case from.Path() != to.Path():
			files[i].Status = "R"
		default:
			files[i].Status = "M"
		}
	}
	res["files"] = files
	text := patch.String()
	if len(text) > maxPatch {
		text = text[:maxPatch] + "\n… diff truncated (too large to show)"
	}
	res["patch"] = text
	writeJSON(w, res)
}

// handleGitStatus lists uncommitted changes in the working folder.
func (a *App) handleGitStatus(w http.ResponseWriter, r *http.Request) {
	repo, err := openRepo(r.URL.Query().Get("path"))
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	wt, err := repo.Worktree()
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	st, err := wt.Status()
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	type change struct {
		Path     string `json:"path"`
		Staged   string `json:"staged"`
		Worktree string `json:"worktree"`
	}
	out := []change{}
	for p, s := range st {
		if s.Staging == git.Unmodified && s.Worktree == git.Unmodified {
			continue
		}
		out = append(out, change{p, string(s.Staging), string(s.Worktree)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	writeJSON(w, out)
}

// handleGitFetch runs "git fetch --all --prune" with the installed git.
func (a *App) handleGitFetch(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Path string `json:"path"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, 400, err)
		return
	}
	gitPath, err := exec.LookPath("git")
	if err != nil {
		writeErr(w, 400, errors.New("Git is not installed on this PC, so Fetch is not available (browsing still works)"))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, gitPath, "fetch", "--all", "--prune")
	cmd.Dir = in.Path
	cmd.Env = gitEnv()
	out, err := cmd.CombinedOutput()
	if err != nil {
		writeErr(w, 400, errors.New(gitSSHHint(strings.TrimSpace(string(out))+" "+err.Error())))
		return
	}
	writeJSON(w, map[string]string{"output": strings.TrimSpace(string(out))})
}

// handleGitFind looks for repositories in the usual places.
func (a *App) handleGitFind(w http.ResponseWriter, r *http.Request) {
	home, _ := os.UserHomeDir()
	roots := []string{home}
	for _, d := range []string{"source", "repos", "git", "src", "code", "projects", "dev", "work", "workspace", "Documents", "Desktop", "IdeaProjects", "PycharmProjects", "eclipse-workspace"} {
		roots = append(roots, filepath.Join(home, d))
	}
	if runtime.GOOS == "windows" {
		for _, d := range []string{`C:\dev`, `C:\git`, `C:\src`, `C:\repos`, `C:\work`, `D:\`, `D:\git`, `D:\dev`} {
			roots = append(roots, d)
		}
	}
	seen := map[string]bool{}
	found := []string{}
	deadline := time.Now().Add(8 * time.Second)
	for _, root := range roots {
		base := strings.Count(filepath.Clean(root), string(filepath.Separator))
		maxDepth := 4
		if root == home {
			maxDepth = 2
		}
		_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
			if err != nil || !d.IsDir() || time.Now().After(deadline) {
				if time.Now().After(deadline) {
					return filepath.SkipAll
				}
				return nil
			}
			name := d.Name()
			if name == ".git" {
				repo := filepath.Dir(p)
				if !seen[repo] {
					seen[repo] = true
					found = append(found, repo)
				}
				return filepath.SkipDir
			}
			if strings.Count(p, string(filepath.Separator))-base >= maxDepth || (p != root && strings.HasPrefix(name, ".")) ||
				name == "node_modules" || name == "AppData" || name == "Library" || name == "target" || name == "build" || name == "venv" {
				return filepath.SkipDir
			}
			return nil
		})
	}
	sort.Strings(found)
	writeJSON(w, found)
}
