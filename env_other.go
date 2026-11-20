//go:build !windows

package main

import "os"

func shellEnv() []string { return os.Environ() }
