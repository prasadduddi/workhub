package main

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"io"
	"strings"
	"testing"
)

// A document shaped like Word's own output, with the things that go wrong
// most often when a document is read into a thread.
func TestDocxFormatKept(t *testing.T) { richDocxCheck(t, false) }

// The thread's Word copy keeps it too: written out and read back in.
func TestDocxFormatSurvivesWordCopy(t *testing.T) { richDocxCheck(t, true) }

func richDocxCheck(t *testing.T, roundTrip bool) {
	const W = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:v="urn:schemas-microsoft-com:vml"`
	p := func(inner string) string { return `<w:p>` + inner + `</w:p>` }
	r := func(props, text string) string {
		return `<w:r>` + map[bool]string{true: `<w:rPr>` + props + `</w:rPr>`, false: ""}[props != ""] + `<w:t xml:space="preserve">` + text + `</w:t></w:r>`
	}
	num := func(id, lvl, text string) string {
		return p(`<w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="` + lvl + `"/><w:numId w:val="` + id + `"/></w:numPr></w:pPr>` + r("", text))
	}
	style := func(st, text string) string { return p(`<w:pPr><w:pStyle w:val="` + st + `"/></w:pPr>` + r("", text)) }
	cell := func(props, inner string) string {
		return `<w:tc>` + map[bool]string{true: `<w:tcPr>` + props + `</w:tcPr>`, false: ""}[props != ""] + inner + `</w:tc>`
	}
	pic := func(rid string) string {
		return `<w:r><w:drawing><a:graphic><a:graphicData><a:blip r:embed="` + rid + `"/></a:graphicData></a:graphic></w:drawing></w:r>`
	}
	body := style("Title", "Cutover runbook") +
		p(`<w:pPr><w:pStyle w:val="Heading1"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>`+r("", "Prepare")) +
		num("1", "0", "Stop the batch") + num("1", "1", "Check the queue is empty") + num("1", "1", "Note the last run id") + num("1", "0", "Deploy") +
		num("2", "0", "a bullet") + num("2", "0", "another bullet") +
		p(r("", "Plain text with ")+r(`<w:rStyle w:val="Strong"/>`, "strong")+r("", ", ")+r(`<w:highlight w:val="yellow"/>`, "highlighted")+r("", ", H")+r(`<w:vertAlign w:val="subscript"/>`, "2")+r("", "O, x")+r(`<w:vertAlign w:val="superscript"/>`, "2")+r("", " and ")+r(`<w:i w:val="0"/>`, "not italic")) +
		// a link Word stored as a field (what pasting a URL usually gives)
		p(r("", "See ")+`<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> HYPERLINK "https://wiki.example.com/runbook?a=1&amp;b=2" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>`+r(`<w:rStyle w:val="Hyperlink"/>`, "the wiki")+`<w:r><w:fldChar w:fldCharType="end"/></w:r>`+r("", " first.")) +
		// a text box inside a paragraph, with Word's older (VML) copy of it
		p(r("", "Before the box. ")+`<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wps:txbx><w:txbxContent>`+p(r("", "Inside the box"))+`</w:txbxContent></wps:txbx></w:drawing></mc:Choice><mc:Fallback><w:pict><v:textbox><w:txbxContent>`+p(r("", "Inside the box"))+`</w:txbxContent></v:textbox></w:pict></mc:Fallback></mc:AlternateContent></w:r>`+r("", "After the box.")) +
		style("HTMLPreformatted", "systemctl stop pay-batch") + style("HTMLPreformatted", "  tail -f /app/logs/batch.log") +
		`<w:tbl>` +
		`<w:tr>` + cell(`<w:gridSpan w:val="2"/>`, p(r(`<w:b/>`, "Servers"))) + cell("", p(r("", "Owner"))) + `</w:tr>` +
		`<w:tr>` + cell(`<w:vMerge w:val="restart"/>`, p(r("", "PROD"))) + cell("", p(r("", "app-01"))) + cell("", num("2", "0", "ops")+num("2", "0", "dba")) + `</w:tr>` +
		`<w:tr>` + cell(`<w:vMerge/>`, p("")) + cell("", p(r("", "app-02"))) + cell("", p(r("", "before inner"))+`<w:tbl><w:tr>`+cell("", p(r("", "inner")))+`</w:tr></w:tbl>`+p(r("", "after inner"))) + `</w:tr>` +
		`</w:tbl>` +
		p(pic("rIdImg")) + p(pic("rIdImg")) + p(pic("rIdEmf")) +
		p(`<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="0"/></w:numPr></w:pPr>`+r("", "numbering switched off"))
	doc := `<?xml version="1.0"?><w:document ` + W + `><w:body>` + body + `</w:body></w:document>`
	numbering := `<?xml version="1.0"?><w:numbering ` + W + `>
<w:abstractNum w:abstractNumId="10"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="lowerLetter"/></w:lvl></w:abstractNum>
<w:abstractNum w:abstractNumId="20"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="10"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="20"/></w:num></w:numbering>`
	rels := `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdImg" Type="image" Target="media/image1.png"/><Relationship Id="rIdEmf" Type="image" Target="media/image2.emf"/></Relationships>`
	var buf bytes.Buffer
	z := zip.NewWriter(&buf)
	for n, c := range map[string]string{"word/document.xml": doc, "word/numbering.xml": numbering, "word/_rels/document.xml.rels": rels,
		"word/media/image1.png": "\x89PNG fake", "word/media/image2.emf": "emf"} {
		f, _ := z.Create(n)
		f.Write([]byte(c))
	}
	z.Close()

	s, _ := OpenStore(t.TempDir())
	w := s.SaveWorkItem(WorkItem{Title: "CHG-1"})
	post, err := s.ImportDocxInto(w.ID, "Cutover.docx", buf.Bytes(), func(a Attachment) string { return "http://x/api/props/files/" + a.ID })
	if err != nil {
		t.Fatal(err)
	}
	h := post.HTML
	if roundTrip {
		got, _ := s.GetWorkItem(w.ID)
		b, err := buildDocx(s, got)
		if err != nil {
			t.Fatal(err)
		}
		zr, _ := zip.NewReader(bytes.NewReader(b), int64(len(b)))
		for _, f := range zr.File {
			if f.Name == "word/document.xml" {
				rc, _ := f.Open()
				dec := xml.NewDecoder(rc)
				for {
					if _, err := dec.Token(); err == io.EOF {
						break
					} else if err != nil {
						t.Fatalf("the Word copy is not well-formed XML: %v", err)
					}
				}
				rc.Close()
			}
		}
		back, err := s.ImportDocx("copy.docx", b)
		if err != nil {
			t.Fatal(err)
		}
		h = ""
		for _, p := range back.Posts {
			h += p.HTML
		}
		for _, want := range []string{
			"<ol><li>Stop the batch<ol><li>Check the queue is empty</li><li>Note the last run id</li></ol></li><li>Deploy</li></ol>",
			"<mark>highlighted</mark>", "H<sub>2</sub>O", "x<sup>2</sup>",
			`<td colspan="2"><b>Servers</b></td><td>Owner</td>`,
			`<td rowspan="2">PROD</td><td>app-01</td><td><ul><li>ops</li><li>dba</li></ul></td>`,
			`<td>app-02</td><td>before inner<br><table><tr><td>inner</td></tr></table><br>after inner</td>`,
			`<a href="https://wiki.example.com/runbook?a=1&amp;b=2">the wiki</a>`,
		} {
			if !strings.Contains(h, want) {
				t.Errorf("lost in the Word copy: %q", want)
			}
		}
		if strings.Count(h, "<td>inner</td>") != 1 {
			t.Error("the inner table was written twice")
		}
		if t.Failed() {
			t.Log(h)
		}
		return
	}
	for _, want := range []string{
		"<p>📄 <b>Cutover runbook</b></p>",
		"<h1>Prepare</h1>", // a numbered heading stays a heading
		"<ol><li>Stop the batch<ol><li>Check the queue is empty</li><li>Note the last run id</li></ol></li><li>Deploy</li></ol>",
		"<ul><li>a bullet</li><li>another bullet</li></ul>",
		"<b>strong</b>", "<mark>highlighted</mark>", "H<sub>2</sub>O", "x<sup>2</sup>", " and not italic",
		`See <a href="https://wiki.example.com/runbook?a=1&amp;b=2">the wiki</a> first.`,
		"<pre>systemctl stop pay-batch\n  tail -f /app/logs/batch.log</pre>",
		`<td colspan="2"><b>Servers</b></td><td>Owner</td>`,
		`<td rowspan="2">PROD</td><td>app-01</td><td><ul><li>ops</li><li>dba</li></ul></td>`,
		`<tr><td>app-02</td><td>before inner<br><table><tr><td>inner</td></tr></table><br>after inner</td></tr>`,
		"[picture: image2.emf]",
		"<p>numbering switched off</p>",
	} {
		if !strings.Contains(h, want) {
			t.Errorf("missing %q", want)
		}
	}
	if n := strings.Count(h, "Inside the box"); n != 1 {
		t.Errorf("text box text %d times, want once", n)
	}
	if !strings.Contains(h, "<p>Before the box. After the box.</p>") {
		t.Error("the paragraph around the text box was broken")
	}
	if n := strings.Count(h, "<img "); n != 2 {
		t.Errorf("want the PNG shown twice (one stored copy), got %d pictures", n)
	}
	got, _ := s.GetWorkItem(w.ID)
	if len(got.Files) != 3 { // png once, emf, the document itself
		t.Errorf("want 3 files on the thread, got %d", len(got.Files))
	}
	if t.Failed() {
		t.Log(h)
	}
}

// Links only to web pages and mail; nothing in a document can add script.
func TestDocxImportIsSafe(t *testing.T) {
	const W = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`
	doc := `<?xml version="1.0"?><w:document ` + W + `><w:body>
<w:p><w:hyperlink r:id="rJs"><w:r><w:t>click</w:t></w:r></w:hyperlink></w:p>
<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> HYPERLINK "javascript:alert(1)" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>field</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>
<w:p><w:r><w:t>&lt;script&gt;alert(1)&lt;/script&gt; "quoted" &amp; done</w:t></w:r></w:p>
</w:body></w:document>`
	rels := `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rJs" Type="hyperlink" Target="javascript:alert(1)" TargetMode="External"/></Relationships>`
	var buf bytes.Buffer
	z := zip.NewWriter(&buf)
	for n, c := range map[string]string{"word/document.xml": doc, "word/_rels/document.xml.rels": rels} {
		f, _ := z.Create(n)
		f.Write([]byte(c))
	}
	z.Close()
	s, _ := OpenStore(t.TempDir())
	w := s.SaveWorkItem(WorkItem{Title: "x"})
	p, err := s.ImportDocxInto(w.ID, "x.docx", buf.Bytes(), func(a Attachment) string { return "http://x/" + a.ID })
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(p.HTML, "javascript:") || strings.Contains(p.HTML, "<script") {
		t.Fatalf("unsafe HTML: %s", p.HTML)
	}
	for _, want := range []string{"<p>click</p>", "<p>field</p>", "&lt;script&gt;"} {
		if !strings.Contains(p.HTML, want) {
			t.Errorf("missing %q in %s", want, p.HTML)
		}
	}
}

// Lists typed by hand (number or bullet, tab, text; levels by indenting) and
// headings made by hand (big text), as Pages, TextEdit or older documents have.
func TestDocxHandMadeListsAndHeadings(t *testing.T) {
	const W = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`
	para := func(indent, sz, bold, text string) string {
		ppr := ""
		if indent != "" {
			ppr = `<w:pPr><w:ind w:left="` + indent + `" w:hanging="360"/></w:pPr>`
		}
		rpr := `<w:rPr>` + map[bool]string{true: "<w:b/>", false: ""}[bold != ""] + `<w:sz w:val="` + sz + `"/></w:rPr>`
		return `<w:p>` + ppr + `<w:r>` + rpr + `<w:t xml:space="preserve">` + strings.ReplaceAll(text, "|", `</w:t><w:tab/><w:t xml:space="preserve">`) + `</w:t></w:r></w:p>`
	}
	doc := func(body string) []byte {
		var buf bytes.Buffer
		z := zip.NewWriter(&buf)
		f, _ := z.Create("word/document.xml")
		f.Write([]byte(`<?xml version="1.0"?><w:document ` + W + `><w:body>` + body + `</w:body></w:document>`))
		z.Close()
		return buf.Bytes()
	}
	s, _ := OpenStore(t.TempDir())
	w := s.SaveWorkItem(WorkItem{Title: "x"})
	imp := func(b []byte) string {
		p, err := s.ImportDocxInto(w.ID, "x.docx", b, func(a Attachment) string { return "http://x/" + a.ID })
		if err != nil {
			t.Fatal(err)
		}
		return p.HTML
	}
	h := imp(doc(para("", "48", "b", "Cutover") + para("", "24", "", "Body text one.") + para("", "24", "", "Body text two.") +
		para("720", "24", "", "|1|Freeze") + para("1440", "24", "", "|a)|stop scheduler") + para("720", "24", "", "|2|Deploy") +
		para("720", "24", "", "|•|bullet") + para("", "36", "b", "Notes") + para("", "24", "", "1 apple is not a list")))
	for _, want := range []string{"<h1>Cutover</h1>", "<ol><li>Freeze<ol><li>stop scheduler</li></ol></li><li>Deploy</li></ol><ul><li>bullet</li></ul>",
		"<h2>Notes</h2>", "<p>1 apple is not a list</p>"} {
		if !strings.Contains(h, want) {
			t.Errorf("missing %q in %s", want, h)
		}
	}
	// all text at 14 pt: short lines are not headings
	h = imp(doc(para("", "28", "", "Short line") + para("", "28", "", "Another short line") + para("", "28", "", "Third")))
	if strings.Contains(h, "<h") {
		t.Errorf("body text taken for headings: %s", h)
	}
}

// Embedded objects: MathType equations (WMF previews) and other OLE objects.
func TestDocxEmbeddedObjects(t *testing.T) {
	const W = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"`
	obj := func(rid, prog string) string {
		return `<w:r><w:object><v:shape><v:imagedata r:id="` + rid + `"/></v:shape><o:OLEObject ProgID="` + prog + `" r:id="rOle"/></w:object></w:r>`
	}
	doc := `<?xml version="1.0"?><w:document ` + W + `><w:body>
<w:p><w:r><w:t xml:space="preserve">Area is </w:t></w:r>` + obj("rWmf", "Equation.DSMT4") + `<w:r><w:t xml:space="preserve"> square metres.</w:t></w:r></w:p>
<w:p>` + obj("rWmf2", "Excel.Sheet.12") + `</w:p>
<w:p>` + obj("rPng", "Visio.Drawing.15") + `</w:p>
</w:body></w:document>`
	rels := `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rWmf" Type="image" Target="media/image1.wmf"/><Relationship Id="rWmf2" Type="image" Target="media/image2.wmf"/><Relationship Id="rPng" Type="image" Target="media/image3.png"/></Relationships>`
	var buf bytes.Buffer
	z := zip.NewWriter(&buf)
	for n, c := range map[string]string{"word/document.xml": doc, "word/_rels/document.xml.rels": rels, "word/media/image1.wmf": "w", "word/media/image2.wmf": "w", "word/media/image3.png": "p"} {
		f, _ := z.Create(n)
		f.Write([]byte(c))
	}
	z.Close()
	s, _ := OpenStore(t.TempDir())
	w := s.SaveWorkItem(WorkItem{Title: "x"})
	p, err := s.ImportDocxInto(w.ID, "x.docx", buf.Bytes(), func(a Attachment) string { return "http://x/" + a.ID })
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"<p>Area is <i>[equation]</i> square metres.</p>", "[embedded Excel sheet — open the Word document to see it]", `<img src="/api/props/files/`} {
		if !strings.Contains(p.HTML, want) {
			t.Errorf("missing %q in %s", want, p.HTML)
		}
	}
	if got, _ := s.GetWorkItem(w.ID); len(got.Files) != 2 { // the PNG preview and the document; no WMF previews
		t.Errorf("want 2 files, got %d", len(got.Files))
	}
}

// Markdown export of a document in a thread: nested lists, merged cells,
// lists and tables inside cells stay one table row per row.
func TestMarkdownOfDocumentTables(t *testing.T) {
	s, _ := OpenStore(t.TempDir())
	w := s.SaveWorkItem(WorkItem{Title: "x"})
	s.AddPost(w.ID, Post{Kind: "note", HTML: `<ol><li>Stop<ol><li>Check</li></ol></li><li>Deploy</li></ol>` +
		`<table><tr><td colspan="2"><b>Servers</b></td><td>Owner</td></tr><tr><td rowspan="2">PROD</td><td>app-01</td><td><ul><li>ops</li><li>dba</li></ul></td></tr>` +
		`<tr><td>app-02</td><td>before<br><table><tr><td>in</td><td>ner</td></tr></table><br>a|b</td></tr></table>`})
	got, _ := s.GetWorkItem(w.ID)
	md, _ := s.threadMarkdown(got, "")
	for _, want := range []string{"1. Stop\n   1. Check", "| **Servers** |  | Owner |", "| PROD | app-01 | • ops<br>• dba |", `|  | app-02 | before<br>in / ner<br>a\|b |`} {
		if !strings.Contains(md, want) {
			t.Errorf("missing %q in:\n%s", want, md)
		}
	}
}

// A damaged document is reported, not imported as an empty message.
func TestDocxDamaged(t *testing.T) {
	mk := func(docXML string) []byte {
		var buf bytes.Buffer
		z := zip.NewWriter(&buf)
		f, _ := z.Create("word/document.xml")
		f.Write([]byte(docXML))
		z.Close()
		return buf.Bytes()
	}
	const W = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`
	s, _ := OpenStore(t.TempDir())
	w := s.SaveWorkItem(WorkItem{Title: "x"})
	link := func(a Attachment) string { return "http://x/" + a.ID }
	if _, err := s.ImportDocxInto(w.ID, "bad.docx", mk(`<w:document `+W+`><w:body><w:p><w:pPr><w:pStyle w:val="/></w:pPr>`), link); err == nil || !strings.Contains(err.Error(), "damaged") {
		t.Fatalf("want a 'damaged' error, got %v", err)
	}
	p, err := s.ImportDocxInto(w.ID, "half.docx", mk(`<w:document `+W+`><w:body><w:p><w:r><w:t>first part</w:t></w:r></w:p><w:p><w:r><w:t>broken</w:r></w:p>`), link)
	if err != nil || !strings.Contains(p.HTML, "first part") || !strings.Contains(p.HTML, "couldn't be read") {
		t.Fatalf("want the readable part and a note: %v %s", err, p.HTML)
	}
	if got, _ := s.GetWorkItem(w.ID); len(got.Posts) != 1 {
		t.Fatalf("the damaged document must not add a message: %d", len(got.Posts))
	}
}
