package main

import (
	"encoding/json"
	"testing"
)

// A brand-new workspace must send empty lists, not null, to the browser.
func TestEmptyListsAreNotNull(t *testing.T) {
	s, _ := OpenStore(t.TempDir())
	for name, v := range map[string]any{"entries": s.Entries(), "clips": s.Clips(10), "notes": s.Notes(), "recent": s.Recent()} {
		if b, _ := json.Marshal(v); string(b) != "[]" {
			t.Errorf("%s = %s, want []", name, b)
		}
	}
}
