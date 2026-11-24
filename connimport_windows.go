package main

import (
	"errors"
	"net/url"
	"strconv"

	"golang.org/x/sys/windows/registry"
)

// readPuttyRegistry reads PuTTY's saved sessions (read-only access).
func readPuttyRegistry() ([]ImportConn, error) {
	k, err := registry.OpenKey(registry.CURRENT_USER, `Software\SimonTatham\PuTTY\Sessions`, registry.ENUMERATE_SUB_KEYS|registry.QUERY_VALUE)
	if err != nil {
		return nil, errors.New("no PuTTY sessions on this PC")
	}
	defer k.Close()
	names, err := k.ReadSubKeyNames(-1)
	if err != nil {
		return nil, err
	}
	var out []ImportConn
	for _, raw := range names {
		sk, err := registry.OpenKey(k, raw, registry.QUERY_VALUE)
		if err != nil {
			continue
		}
		v := map[string]string{}
		for _, n := range []string{"HostName", "UserName", "Protocol", "PublicKeyFile", "PortForwardings"} {
			if s, _, err := sk.GetStringValue(n); err == nil {
				v[n] = s
			}
		}
		if p, _, err := sk.GetIntegerValue("PortNumber"); err == nil {
			v["PortNumber"] = strconv.FormatUint(p, 10)
		}
		sk.Close()
		name, _ := url.PathUnescape(raw)
		if ic, ok := puttySession(name, v); ok {
			out = append(out, ic)
		}
	}
	return out, nil
}
