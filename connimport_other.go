//go:build !windows

package main

import "errors"

func readPuttyRegistry() ([]ImportConn, error) {
	return nil, errors.New("PuTTY sessions are read from the Windows registry")
}
