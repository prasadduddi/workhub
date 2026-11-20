package main

import "testing"

func TestMailRules(t *testing.T) {
	rules := []MailRule{{Match: "*@vendor.com", Project: "Vendor"}, {Match: "bob@client.com"}, {Match: "Infra Team"}}
	for _, c := range []struct {
		name, addr string
		want       string
		ok         bool
	}{
		{"Ann", "ann@vendor.com", "*@vendor.com", true},
		{"Ann", "ann@sub.vendor.com.evil.org", "", false},
		{"Bob", "BOB@client.com", "bob@client.com", true},
		{"Bobby", "bobby@client.com", "", false},
		{"Corp Infra Team", "noreply@corp.com", "Infra Team", true},
		{"Someone", "x@other.com", "", false},
	} {
		r, ok := matchRule(rules, c.name, c.addr)
		if ok != c.ok || r.Match != c.want {
			t.Errorf("%s <%s>: got %q %v", c.name, c.addr, r.Match, ok)
		}
	}
}

// A mail from a watched sender is filed into the rule's project; one with no
// connection details is dropped unless "keep all" is on.
func TestMailIngest(t *testing.T) {
	s, _ := OpenStore(t.TempDir())
	m := mailItem{From: "Ann", Address: "ann@vendor.com", Subject: "UAT access", Body: "host: uat-db01.vendor.local\nuser: app\npassword: pw"}
	clip, entries := s.Ingest(mailText(m), "outlook", "Vendor")
	if clip == nil || len(entries) != 1 || entries[0].Project != "Vendor" || clip.Source != "outlook" {
		t.Fatalf("clip=%v entries=%v", clip, entries)
	}
	if c, _ := s.Ingest(mailText(mailItem{Subject: "lunch?", Body: "pizza at 1"}), "outlook", ""); c != nil {
		t.Fatal("mail with no details should be dropped")
	}
	if c, _ := s.Ingest(mailText(mailItem{Subject: "lunch?", Body: "pizza at 1"}), "outlook-all", ""); c == nil || c.Source != "outlook" {
		t.Fatal("keep-all mail should be kept as an outlook clip")
	}
}
