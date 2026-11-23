package main

import (
	"testing"
	"time"
)

func TestShotToolNames(t *testing.T) {
	for exe, want := range map[string]bool{
		`C:\Program Files\WindowsApps\Microsoft.ScreenSketch_11\SnippingTool\SnippingTool.exe`: true,
		`C:\Windows\SystemApps\ScreenClippingHost.exe`:                                         true,
		`C:\Program Files\Microsoft Office\root\Office16\EXCEL.EXE`:                            false,
		"": false,
	} {
		if got := isShotTool(exe); got != want {
			t.Errorf("isShotTool(%q) = %v, want %v", exe, got, want)
		}
	}
}

// One snip reaches WorkHub twice (clipboard picture + saved file): posted once.
// Two snips a minute apart are both posted.
func TestShotPairing(t *testing.T) {
	var l shotLog
	t0 := time.Now()
	if l.seen(false, t0) {
		t.Fatal("first clipboard snip should be posted")
	}
	if !l.seen(true, t0.Add(2*time.Second)) {
		t.Fatal("its saved file should be skipped")
	}
	if l.seen(true, t0.Add(4*time.Second)) {
		t.Fatal("a second file is a new snip")
	}
	if !l.seen(false, t0.Add(5*time.Second)) {
		t.Fatal("the second snip's clipboard copy should be skipped")
	}
	if l.seen(false, t0.Add(time.Minute)) || l.seen(true, t0.Add(2*time.Minute)) {
		t.Fatal("snips far apart are separate")
	}
}
