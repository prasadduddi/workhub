package main

import (
	"archive/zip"
	"bytes"
	"strings"
	"testing"
	"time"
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
	h := w.Posts[0].HTML // one heading: one post
	for _, want := range []string{"<h1>Release steps</h1>", "<b>EOD batch</b>", `<a href="https://wiki.example.com/runbook">runbook</a>`, "<ul><li>stop app</li><li>deploy</li></ul>", "<table><tr><td>Server</td><td>Owner</td></tr></table>"} {
		if !strings.Contains(h, want) {
			t.Errorf("missing %s in %s", want, h)
		}
	}
	if _, err := s.ImportDocx("old.doc", []byte("not a zip")); err == nil {
		t.Error("a .doc file should be refused with a hint")
	}
}

func TestImportDocxSplitsAtHeadings(t *testing.T) {
	s, _ := OpenStore(t.TempDir())
	const W = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`
	p := func(style, text string) string {
		ps := ""
		if style != "" {
			ps = `<w:pPr><w:pStyle w:val="` + style + `"/></w:pPr>`
		}
		return `<w:p>` + ps + `<w:r><w:t>` + text + `</w:t></w:r></w:p>`
	}
	doc := `<?xml version="1.0"?><w:document ` + W + `><w:body>` +
		p("", "Intro before any heading") +
		p("Heading1", "Prepare") + p("", "stop batch") + p("Heading2", "Checks") + p("", "disk ok") +
		p("Heading1", "Deploy") + p("", "run job 412") +
		`</w:body></w:document>`
	var buf bytes.Buffer
	z := zip.NewWriter(&buf)
	f, _ := z.Create("word/document.xml")
	f.Write([]byte(doc))
	z.Close()
	w, err := s.ImportDocx("Runbook.docx", buf.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if len(w.Posts) != 3 {
		for _, x := range w.Posts {
			t.Log(x.HTML)
		}
		t.Fatalf("want intro + 2 sections (split at Heading 1), got %d posts", len(w.Posts))
	}
	if !strings.Contains(w.Posts[0].HTML, "Intro") || !strings.HasPrefix(w.Posts[1].HTML, "<h1>Prepare</h1>") ||
		!strings.Contains(w.Posts[1].HTML, "<h2>Checks</h2>") || !strings.HasPrefix(w.Posts[2].HTML, "<h1>Deploy</h1>") {
		t.Fatalf("sections wrong: %q | %q | %q", w.Posts[0].HTML, w.Posts[1].HTML, w.Posts[2].HTML)
	}
}

func TestThreadJiraLink(t *testing.T) {
	s, _ := OpenStore(t.TempDir())
	w := s.SaveWorkItem(WorkItem{Title: "Refunds", Jira: "https://acme.atlassian.net/browse/pay-123"})
	if w.Jira != "PAY-123" {
		t.Fatalf("link: %q", w.Jira)
	}
	w = s.SaveWorkItem(WorkItem{ID: w.ID, Title: "Refunds", Jira: ""})
	if w.Jira != "" {
		t.Fatal("unlink failed")
	}
	w = s.SaveWorkItem(WorkItem{ID: w.ID, Title: "Refunds", Jira: "CM-456"})
	got, _ := s.GetWorkItem(w.ID)
	b, _ := buildDocx(s, got)
	imp, err := s.ImportDocx("x.docx", b)
	if err != nil || imp.Jira != "CM-456" {
		t.Fatalf("Jira key lost in the Word round trip: %v %q", err, imp.Jira)
	}
	if md, _ := s.threadMarkdown(got, ""); !strings.Contains(md, "Jira: CM-456") {
		t.Fatal("Markdown lacks the Jira key")
	}
}

// With no thread chosen, captures go to the General thread; "off" stops them.
func TestGeneralThreadByDefault(t *testing.T) {
	s, _ := OpenStore(t.TempDir())
	s.Ingest("ssh ops@srv-01.example.com", "clipboard", "")
	var gen *WorkItem
	for _, w := range s.st.WorkItems {
		if w.General {
			gen = w
		}
	}
	if gen == nil || gen.Title != "General" || len(gen.Posts) != 1 || gen.Posts[0].Kind != "capture" {
		t.Fatalf("general thread: %+v", gen)
	}
	other := s.SaveWorkItem(WorkItem{Title: "CM-1 release"})
	st := s.Settings()
	st.ActiveThread = other.ID
	s.SetSettings(st)
	s.Ingest("ssh ops@srv-02.example.com", "clipboard", "")
	if o, _ := s.GetWorkItem(other.ID); len(o.Posts) != 1 || len(gen.Posts) != 1 {
		t.Fatalf("chosen thread should get it: other=%d general=%d", len(o.Posts), len(gen.Posts))
	}
	st.ActiveThread = "off"
	s.SetSettings(st)
	s.Ingest("ssh ops@srv-03.example.com", "clipboard", "")
	if o, _ := s.GetWorkItem(other.ID); len(o.Posts) != 1 || len(gen.Posts) != 1 {
		t.Fatal("off: no thread should get captures")
	}
	st.ActiveThread = ""
	s.SetSettings(st)
	_ = s.ArchiveWork(gen.ID, true)
	s.Ingest("ssh ops@srv-04.example.com", "clipboard", "")
	if len(gen.Posts) != 1 {
		t.Fatal("archived General still captured")
	}
}

func TestSlackThreadEngine(t *testing.T) {
	s, _ := OpenStore(t.TempDir())
	w := s.SaveWorkItem(WorkItem{Title: "PAY-123 refund limits", Jira: "PAY-123"})
	p, _ := s.AddPost(w.ID, Post{Kind: "note", HTML: "<p>first</p>"})
	if got, _ := s.GetWorkItem(w.ID); got.unread() != 1 {
		t.Fatalf("unread = %d, want 1", got.unread())
	}
	s.MarkRead(w.ID)
	if got, _ := s.GetWorkItem(w.ID); got.unread() != 0 {
		t.Fatal("still unread after reading")
	}
	r := []string{"✅", "👀"}
	saved, when := true, time.Now().Add(time.Hour)
	if err := s.PatchPost(w.ID, p.ID, PostPatch{Reactions: &r, Saved: &saved, RemindAt: &when}); err != nil {
		t.Fatal(err)
	}
	if got := s.MarkedPosts(false); len(got) != 1 || got[0].Title != w.Title || len(got[0].Post.Reactions) != 2 {
		t.Fatalf("saved: %+v", got)
	}
	if got := s.MarkedPosts(true); len(got) != 1 {
		t.Fatalf("reminders: %+v", got)
	}
	_ = s.StarWork(w.ID, true)
	if got, _ := s.GetWorkItem(w.ID); !got.Starred {
		t.Fatal("not starred")
	}
	// a capture mentioning PAY-123 goes to its thread, not General
	s.IngestFrom("deploy for PAY-123 on srv-09.example.com", "clipboard", "Outlook — RE: release", "")
	got, _ := s.GetWorkItem(w.ID)
	last := got.Posts[len(got.Posts)-1]
	if last.Kind != "capture" || last.From != "Outlook — RE: release" {
		t.Fatalf("routed capture: %+v", last)
	}
	// a screenshot goes to the capture thread as a picture
	png := []byte("\x89PNG\r\n\x1a\n0000")
	gen, err := s.CaptureImage(png, "Snipping Tool")
	if err != nil || gen == nil || !gen.General || !strings.Contains(gen.Posts[len(gen.Posts)-1].HTML, "<img") {
		t.Fatalf("screenshot: %v %+v", err, gen)
	}
}

// Move takes a message, its replies and its pictures to another thread;
// copy leaves the original. Deleting the first thread keeps the moved picture.
func TestMoveCopyPost(t *testing.T) {
	s, _ := OpenStore(t.TempDir())
	a := s.SaveWorkItem(WorkItem{Title: "PAY-1"})
	b := s.SaveWorkItem(WorkItem{Title: "PAY-2"})
	if err := s.AddWorkFile(a.ID, Attachment{ID: "abc123", Name: "shot.png"}); err != nil {
		t.Fatal(err)
	}
	top, _ := s.AddPost(a.ID, Post{Kind: "note", HTML: `<p>see <img src="/api/props/files/abc123"></p>`})
	reply, _ := s.AddPost(a.ID, Post{Kind: "note", HTML: "<p>ok</p>", Parent: top.ID})
	other, _ := s.AddPost(a.ID, Post{Kind: "note", HTML: "<p>stays</p>"})

	c, err := s.MovePost(a.ID, top.ID, b.ID, true)
	if err != nil || c.ID == top.ID || !strings.Contains(c.Via, "Copied from “PAY-1”") {
		t.Fatalf("copy: %+v %v", c, err)
	}
	if n := len(s.workItem(a.ID).Posts); n != 3 {
		t.Fatalf("copy must leave the original: %d posts", n)
	}
	m, err := s.MovePost(a.ID, top.ID, b.ID, false)
	if err != nil || m.ID != top.ID || !strings.Contains(m.Via, "Moved from") {
		t.Fatalf("move: %+v %v", m, err)
	}
	src, dst := s.workItem(a.ID), s.workItem(b.ID)
	if len(src.Posts) != 1 || src.Posts[0].ID != other.ID {
		t.Fatalf("source after move: %+v", src.Posts)
	}
	if len(dst.Posts) != 4 { // copy + its reply, moved + its reply
		t.Fatalf("target has %d posts", len(dst.Posts))
	}
	for _, p := range dst.Posts {
		if p.ID == reply.ID && p.Parent != top.ID {
			t.Fatal("the moved reply must stay under its message")
		}
	}
	if !hasFile(dst.Files, "abc123") {
		t.Fatal("the picture must go along")
	}
	s.DeleteWorkItem(a.ID)
	if s.workAttachment("abc123") == nil {
		t.Fatal("the moved picture must survive deleting the old thread")
	}
	if _, err := s.MovePost(b.ID, m.ID, b.ID, false); err == nil {
		t.Fatal("moving into the same thread should be refused")
	}
}

// A Word document dropped on an open thread becomes one message in it, its
// formatting kept and the document attached.
func TestImportDocxIntoThread(t *testing.T) {
	s, _ := OpenStore(t.TempDir())
	const W = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`
	doc := `<?xml version="1.0"?><w:document ` + W + `><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Prepare</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Run the </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>EOD batch</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>stop app</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Deploy</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Server</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Owner</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
</w:body></w:document>`
	var buf bytes.Buffer
	z := zip.NewWriter(&buf)
	f, _ := z.Create("word/document.xml")
	f.Write([]byte(doc))
	z.Close()
	w := s.SaveWorkItem(WorkItem{Title: "CHG-9 release"})
	s.AddPost(w.ID, Post{Kind: "note", HTML: "<p>before</p>"})
	link := func(a Attachment) string { return "http://x/api/props/files/" + a.ID }
	p, err := s.ImportDocxInto(w.ID, `C:\docs\Release plan.docx`, buf.Bytes(), link)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := s.GetWorkItem(w.ID)
	if len(got.Posts) != 2 || p.From != "Word" {
		t.Fatalf("want the document as one added message, got %d posts, from %q", len(got.Posts), p.From)
	}
	for _, want := range []string{"<p>📄 <b>Release plan</b></p>", "<h1>Prepare</h1>", "<b>EOD batch</b>", "<ul><li>stop app</li></ul>", "<h1>Deploy</h1>", "<table><tr><td>Server</td><td>Owner</td></tr></table>", `>Release plan.docx</a>`} {
		if !strings.Contains(p.HTML, want) {
			t.Errorf("missing %s in %s", want, p.HTML)
		}
	}
	if strings.Index(p.HTML, "Prepare") > strings.Index(p.HTML, "Deploy") {
		t.Error("document order lost")
	}
	if _, err := s.ImportDocxInto(w.ID, "old.doc", []byte("not a zip"), link); err == nil {
		t.Error("a .doc file should be refused with a hint")
	}
	if _, err := s.ImportDocxInto("nope", "x.docx", buf.Bytes(), link); err == nil {
		t.Error("unknown thread accepted")
	}
}

// A clipboard capture can be edited: its text changes, it stays a capture.
func TestEditCaptureText(t *testing.T) {
	s, _ := OpenStore(t.TempDir())
	w := s.SaveWorkItem(WorkItem{Title: "x"})
	p, err := s.AddPost(w.ID, Post{Kind: "capture", Text: "host srv-01 pasword: Secret123"})
	if err != nil {
		t.Fatal(err)
	}
	txt := "host srv-01 password: Secret123"
	if err := s.PatchPost(w.ID, p.ID, PostPatch{Text: &txt}); err != nil {
		t.Fatal(err)
	}
	got, _ := s.GetWorkItem(w.ID)
	for _, q := range got.Posts {
		if q.ID == p.ID && (q.Text != txt || q.Kind != "capture" || q.HTML != "" || q.Edited.IsZero()) {
			t.Fatalf("edited capture: %+v", q)
		}
	}
}
