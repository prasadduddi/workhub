package main

import "testing"

// Windows' "HTML Format": a header with byte offsets, then the page; only the copied part is wanted.
func TestCFHTMLFragment(t *testing.T) {
	body := "<html><body><!--StartFragment--><p><b>Bob</b>: restarted app-01</p><!--EndFragment--></body></html>"
	frag := "<p><b>Bob</b>: restarted app-01</p>"
	head := "Version:0.9\r\nStartHTML:0000000105\r\nEndHTML:0000000000\r\nStartFragment:0000000000\r\nEndFragment:0000000000\r\n"
	start := len(head) + len("<html><body><!--StartFragment-->")
	end := start + len(frag)
	head = "Version:0.9\r\nStartHTML:0000000105\r\nEndHTML:0000000000\r\nStartFragment:" + pad10(start) + "\r\nEndFragment:" + pad10(end) + "\r\n"
	if got := cfHTMLFragment([]byte(head + body + "\x00")); got != frag {
		t.Fatalf("fragment: %q", got)
	}
	if got := cfHTMLFragment([]byte("junk <html><p>x</p></html>")); got != "<html><p>x</p></html>" {
		t.Fatalf("no header: %q", got)
	}
}

func pad10(n int) string {
	s := itoaPort(n)
	for len(s) < 10 {
		s = "0" + s
	}
	return s
}
