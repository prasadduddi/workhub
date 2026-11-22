package main

import (
	"archive/zip"
	"bytes"
	"strings"
	"testing"
)

func TestThreads(t *testing.T) {
	s, _ := OpenStore(t.TempDir())
	// An older work item with a document becomes a thread whose first post is that document.
	old := s.SaveWorkItem(WorkItem{Title: "PAY-1 release"})
	_ = s.SetWorkDoc(old.ID, "<p>Steps agreed with ops</p>")
	s.mu.Lock()
	s.migrateThreads()
	s.mu.Unlock()
	w, _ := s.GetWorkItem(old.ID)
	if len(w.Posts) != 1 || !strings.Contains(w.Posts[0].HTML, "Steps agreed") {
		t.Fatalf("document not carried over: %+v", w.Posts)
	}

	p, err := s.AddPost(old.ID, Post{Kind: "note", HTML: "<p>Deployed to UAT</p>"})
	if err != nil {
		t.Fatal(err)
	}
	h := "<p>Deployed to UAT at 10:00</p>"
	if err := s.EditPost(old.ID, p.ID, &h, nil); err != nil {
		t.Fatal(err)
	}
	// Captures go to the active thread; its Word copy hides saved passwords.
	s.mu.Lock()
	s.st.Settings.ActiveThread = old.ID
	s.mu.Unlock()
	s.Ingest("ssh deploy@app-01.uat.example.com password: S3cret-99", "paste", "")
	w, _ = s.GetWorkItem(old.ID)
	if len(w.Posts) != 3 || w.Posts[2].Kind != "capture" {
		t.Fatalf("capture not added to the active thread: %d posts", len(w.Posts))
	}
	doc := s.threadHTML(w)
	if !strings.Contains(doc, "Deployed to UAT at 10:00") || !strings.Contains(doc, "app-01.uat.example.com") {
		t.Fatalf("thread document incomplete: %s", doc)
	}
	if strings.Contains(doc, "S3cret-99") {
		t.Fatal("saved password shown in the Word copy")
	}
	if err := s.DeletePost(old.ID, p.ID); err != nil {
		t.Fatal(err)
	}
	if w, _ = s.GetWorkItem(old.ID); len(w.Posts) != 2 {
		t.Fatalf("delete: %d posts", len(w.Posts))
	}
}

func TestThreadRepliesAndPins(t *testing.T) {
	s, _ := OpenStore(t.TempDir())
	w := s.SaveWorkItem(WorkItem{Title: "CM-9"})
	top, _ := s.AddPost(w.ID, Post{Kind: "note", HTML: "<p>Plan</p>"})
	r1, err := s.AddPost(w.ID, Post{Kind: "note", HTML: "<p>Agreed</p>", Parent: top.ID})
	if err != nil || r1.Parent != top.ID {
		t.Fatalf("reply: %v %+v", err, r1)
	}
	r2, _ := s.AddPost(w.ID, Post{Kind: "note", HTML: "<p>Me too</p>", Parent: r1.ID})
	if r2.Parent != top.ID {
		t.Fatal("a reply to a reply should answer the original post")
	}
	if _, err := s.AddPost(w.ID, Post{Kind: "note", Parent: "nope"}); err == nil {
		t.Fatal("reply to a missing post accepted")
	}
	pin := true
	if err := s.EditPost(w.ID, top.ID, nil, &pin); err != nil {
		t.Fatal(err)
	}
	got, _ := s.GetWorkItem(w.ID)
	if !got.Posts[0].Pinned || got.Posts[0].HTML != "<p>Plan</p>" {
		t.Fatalf("pin changed the text or didn't stick: %+v", got.Posts[0])
	}
	doc := s.threadHTML(got)
	if !strings.Contains(doc, "📌") || !strings.Contains(doc, "↳ reply") {
		t.Fatalf("Word copy lacks pin/replies: %s", doc)
	}
	if err := s.DeletePost(w.ID, top.ID); err != nil {
		t.Fatal(err)
	}
	if got, _ = s.GetWorkItem(w.ID); len(got.Posts) != 0 {
		t.Fatalf("replies left behind: %d", len(got.Posts))
	}
}

func TestThreadMarkdown(t *testing.T) {
	s, _ := OpenStore(t.TempDir())
	at, _ := s.storeAttachment("screen shot.png", []byte("\x89PNG\r\n\x1a\nfake"))
	w := s.SaveWorkItem(WorkItem{Title: "CM-12 / release"})
	_ = s.AddWorkFile(w.ID, at)
	top, _ := s.AddPost(w.ID, Post{Kind: "note", HTML: `<h1>Plan</h1><p>Deploy <b>pay-api</b> via <a href="https://ci.example.com/job/1">job 1</a></p><ul><li>stop batch</li><li><input type="checkbox" checked> backup</li></ul><p><img src="/api/props/files/` + at.ID + `" alt="queue"></p>`, Pinned: true})
	_, _ = s.AddPost(w.ID, Post{Kind: "note", HTML: "<p>Done at 10</p>", Parent: top.ID})
	s.Ingest("ssh ops@db-02.test.example.com password: Pw-7777x", "paste", "")
	s.mu.Lock()
	s.st.Settings.ActiveThread = ""
	s.mu.Unlock()
	_, _ = s.AddPost(w.ID, Post{Kind: "capture", Text: "user ops password Pw-7777x"})
	got, _ := s.GetWorkItem(w.ID)
	md, files := s.threadMarkdown(got, "CM-12 files")
	for _, want := range []string{"# CM-12 / release", "## 📌 Pinned", "### Plan", "**pay-api**", "[job 1](https://ci.example.com/job/1)", "- stop batch", "[x] backup",
		"![queue](CM-12%20files/screen%20shot.png)", "> **↳", "> Done at 10", "```"} {
		if !strings.Contains(md, want) {
			t.Errorf("markdown lacks %q:\n%s", want, md)
		}
	}
	if strings.Contains(md, "Pw-7777x") {
		t.Error("saved password in the Markdown")
	}
	if files[at.ID] != "screen shot.png" {
		t.Errorf("files: %v", files)
	}
}

func TestImportDocxRoundTrip(t *testing.T) {
	s, _ := OpenStore(t.TempDir())
	png := []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82")
	at, _ := s.storeAttachment("queue.png", png)
	w := s.SaveWorkItem(WorkItem{Title: "OPS-5 disk alert", Status: "blocked"})
	_ = s.AddWorkFile(w.ID, at)
	top, _ := s.AddPost(w.ID, Post{Kind: "note", HTML: `<p>Disk at <b>91%</b></p><p><img src="/api/props/files/` + at.ID + `" alt="queue"></p>`, Pinned: true})
	_, _ = s.AddPost(w.ID, Post{Kind: "note", HTML: "<p>Cleaned /tmp</p>", Parent: top.ID})
	_, _ = s.AddPost(w.ID, Post{Kind: "note", HTML: "<ul><li>check again tomorrow</li></ul>"})
	got, _ := s.GetWorkItem(w.ID)
	b, err := buildDocx(s, got)
	if err != nil {
		t.Fatal(err)
	}
	imp, err := s.ImportDocx("OPS-5 disk alert (abc123).docx", b)
	if err != nil {
		t.Fatal(err)
	}
	if imp.Title != "OPS-5 disk alert" || imp.Status != "blocked" {
		t.Fatalf("title/status: %q %q", imp.Title, imp.Status)
	}
	if len(imp.Posts) != 3 {
		t.Fatalf("posts: %d", len(imp.Posts))
	}
	p0, p1, p2 := imp.Posts[0], imp.Posts[1], imp.Posts[2]
	if !p0.Pinned || !strings.Contains(p0.HTML, "<b>91%</b>") || !strings.Contains(p0.HTML, "<img") {
		t.Errorf("first post: %+v", p0)
	}
	if p1.Parent != p0.ID || !strings.Contains(p1.HTML, "Cleaned /tmp") {
		t.Errorf("reply: %+v", p1)
	}
	if !strings.Contains(p2.HTML, "<li>check again tomorrow</li>") {
		t.Errorf("list: %+v", p2)
	}
}

func TestImportPlainDocx(t *testing.T) {
	s, _ := OpenStore(t.TempDir())
	const W = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`
	doc := `<?xml version="1.0"?><w:document ` + W + `><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Release steps</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Run the </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>EOD batch</w:t></w:r><w:r><w:t xml:space="preserve"> first, see </w:t></w:r><w:hyperlink r:id="rId9"><w:r><w:t>runbook</w:t></w:r></w:hyperlink></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>stop app</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>deploy</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Server</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Owner</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
</w:body></w:document>`
	rels := `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="hyperlink" Target="https://wiki.example.com/runbook" TargetMode="External"/></Relationships>`
	var buf bytes.Buffer
	z := zip.NewWriter(&buf)
	for n, c := range map[string]string{"word/document.xml": doc, "word/_rels/document.xml.rels": rels} {
		f, _ := z.Create(n)
		f.Write([]byte(c))
	}
	z.Close()
	w, err := s.ImportDocx(`C:\docs\Payments release.docx`, buf.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if w.Title != "Payments release" || len(w.Posts) != 1 {
		t.Fatalf("title %q posts %d", w.Title, len(w.Posts))
	}
	h := w.Posts[0].HTML
	for _, want := range []string{"<h1>Release steps</h1>", "<b>EOD batch</b>", `<a href="https://wiki.example.com/runbook">runbook</a>`, "<ul><li>stop app</li><li>deploy</li></ul>", "<table><tr><td>Server</td><td>Owner</td></tr></table>"} {
		if !strings.Contains(h, want) {
			t.Errorf("missing %s in %s", want, h)
		}
	}
	if _, err := s.ImportDocx("old.doc", []byte("not a zip")); err == nil {
		t.Error("a .doc file should be refused with a hint")
	}
}
