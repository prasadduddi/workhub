//go:build !windows

package main

func clipHasImage() bool                                  { return false }
func clipHasText() bool                                   { return true }
func clipExcluded() bool                                  { return false }
func clipboardOwnerExe() string                           { return "" }
func grabClipboardImage() (data []byte, isPNG, busy bool) { return nil, false, false }
func foregroundSource() string                            { return "" }
