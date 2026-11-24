package main

// SSH switches.
//
// The 🔑 My SSH keys window — the only part of WorkHub that looks in ~/.ssh
// (WorkHub's own SSH uses only a key file set on a connection, and keeps its
// known_hosts in its own data folder) — is off unless "Show my SSH keys" is
// ticked in Settings → Security (Settings.SSHKeys); off, ~/.ssh isn't read and
// its menu items are hidden.
//
// sshOff (off): when true WorkHub uses no SSH at all: no SSH terminals, SFTP,
// tunnels, log tailing, remote compare or SSH logins in tests, and git
// (fetch, pull request reviews) runs with SSH blocked, so it never starts ssh,
// which would read ~/.ssh and could add to ~/.ssh/known_hosts.

import (
	"errors"
	"os"
	"strings"
)

const sshOff = false

var errSSHOff = errors.New("SSH is switched off in this version of WorkHub")

// gitEnv is the environment for running git: no prompts and, while SSH is
// off, no ssh ("false" is a shell built-in, so it also works in Git for
// Windows; GIT_SSH_COMMAND wins over GIT_SSH and core.sshCommand).
func gitEnv(extra ...string) []string {
	env := append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	if sshOff {
		env = append(env, "GIT_SSH_COMMAND=false")
	}
	return append(env, extra...)
}

// gitSSHHint explains a failed fetch from an SSH remote while SSH is off.
func gitSSHHint(out string) string {
	if sshOff && (strings.Contains(out, "Could not read from remote") || strings.Contains(out, "unable to fork") || strings.Contains(out, "ssh:")) {
		return out + " — SSH is switched off in WorkHub, so git can't use git@… / ssh:// remotes here; use an https:// remote."
	}
	return out
}

// sshKeysOff: the SSH keys window may not read ~/.ssh (not ticked in Settings, or all SSH off).
func (a *App) sshKeysOff() bool { return sshOff || a.store == nil || !a.store.Settings().SSHKeys }
