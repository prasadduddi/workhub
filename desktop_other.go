//go:build !(windows && desktop)

package main

// Web version: WorkHub opens in the browser (see desktop_windows.go).

const isDesktop = false

func runDesktop(url string, openLink func(string)) bool { return false }
func desktopMessage(title, msg string)                  {}
