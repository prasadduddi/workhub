package main

import "testing"

func TestFindBrowser(t *testing.T) {
	if findBrowser("netscape") != "" {
		t.Fatal("unknown browsers must not be found")
	}
	t.Logf("chrome: %q, edge: %q", findBrowser("chrome"), findBrowser("edge"))
}
