//go:build !windows

package main

func readClipboardImage() ([]byte, bool) { return nil, false }
func foregroundSource() string           { return "" }
