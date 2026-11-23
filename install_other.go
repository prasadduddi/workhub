//go:build !windows

package main

import (
	"errors"
	"os"
	"path/filepath"
)

func makeShortcut(lnk, target, args, workDir string) error {
	return errors.New("shortcuts are made on Windows")
}

func desktopDir() string { h, _ := os.UserHomeDir(); return filepath.Join(h, "Desktop") }
