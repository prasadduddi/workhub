package main

import (
	"archive/zip"
	"bytes"
	"testing"
)

func TestSearchThreadFiles(t *testing.T) {
	s, _ := OpenStore(t.TempDir())
	w := s.SaveWorkItem(WorkItem{Title: "PAY-205 refund limits"})
	add := func(name string, data []byte) Attachment {
		a, err := s.storeAttachment(name, data)
		if err != nil {
			t.Fatal(err)
		}
		s.AddWorkFile(w.ID, a)
		return a
	}
	logf := add("batch-run.log", []byte("start\nORA-00060 deadlock detected while waiting\nend"))
	var buf bytes.Buffer
	z := zip.NewWriter(&buf)
	f, _ := z.Create("word/document.xml")
	f.Write([]byte(`<w:document><w:body><w:p><w:r><w:t>Cutover on srv-77 at 22:00</w:t></w:r></w:p></w:body></w:document>`))
	z.Close()
	doc := add("Release plan.docx", buf.Bytes())
	s.AddPost(w.ID, Post{Kind: "note", HTML: `<p><a href="/api/props/files/` + doc.ID + `">Release plan.docx</a></p>`})

	ids := func(q ...string) (out []string) {
		for _, h := range s.SearchThreadFiles(q) {
			out = append(out, h.ID)
		}
		return
	}
	if got := ids("batch-run"); len(got) != 1 || got[0] != logf.ID {
		t.Fatalf("by name: %v", got)
	}
	if got := s.SearchThreadFiles([]string{"deadlock"}); len(got) != 1 || got[0].Snip == "" || got[0].Thread != w.ID {
		t.Fatalf("by text in a log: %+v", got)
	}
	got := s.SearchThreadFiles([]string{"srv-77", "cutover"})
	if len(got) != 1 || got[0].ID != doc.ID || got[0].Post == "" || got[0].Title != w.Title {
		t.Fatalf("by text in a Word document, with its message: %+v", got)
	}
	if got := ids("pay-205", "plan"); len(got) != 1 || got[0] != doc.ID {
		t.Fatalf("thread name + file name: %v", got)
	}
	if got := ids("pay-205"); len(got) != 0 {
		t.Fatalf("a thread's name alone should not list its files: %v", got)
	}
	if got := ids("nothing-like-this"); len(got) != 0 {
		t.Fatalf("no match expected: %v", got)
	}
}
