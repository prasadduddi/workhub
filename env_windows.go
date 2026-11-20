//go:build windows

package main

import (
	"os"
	"strings"

	"golang.org/x/sys/windows/registry"
)

// shellEnv is WorkHub's environment with PATH re-read from Windows' settings
// (system + user, like a newly opened cmd window), so tools installed after
// WorkHub started are found.
func shellEnv() []string {
	read := func(root registry.Key, path string) string {
		k, err := registry.OpenKey(root, path, registry.QUERY_VALUE)
		if err != nil {
			return ""
		}
		defer k.Close()
		v, _, err := k.GetStringValue("Path")
		if err != nil {
			return ""
		}
		if x, err := registry.ExpandString(v); err == nil {
			v = x
		}
		return v
	}
	sys := read(registry.LOCAL_MACHINE, `SYSTEM\CurrentControlSet\Control\Session Manager\Environment`)
	user := read(registry.CURRENT_USER, `Environment`)
	path := strings.Trim(sys+";"+user, ";")
	env := os.Environ()
	if path == "" {
		return env
	}
	out := env[:0:0]
	for _, kv := range env {
		if !strings.HasPrefix(strings.ToUpper(kv), "PATH=") {
			out = append(out, kv)
		}
	}
	return append(out, "PATH="+path)
}
