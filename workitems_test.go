package main

import (
	"archive/zip"
	"encoding/xml"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWorkItems(t *testing.T) {
	dir := t.TempDir()
	s, _ := OpenStore(dir)
	w := s.SaveWorkItem(WorkItem{Title: "PAY-123 refund limits", Tags: []string{"payments"}})
	if w.Status != "todo" {
		t.Fatalf("default status %q", w.Status)
	}
	note, _ := s.AddBlock(w.ID, Block{Kind: "text", Text: "Raised with DBA"})
	link, _ := s.AddBlock(w.ID, Block{Kind: "link", URL: "https://corp.atlassian.net/browse/PAY-123"})
	at, err := s.storeAttachment("screen.png", []byte("\x89PNG\r\n\x1a\n...."))
	if err != nil {
		t.Fatal(err)
	}
	s.AddBlock(w.ID, Block{Kind: "image", File: &at})
	if _, data, err := s.ReadAttachment(at.ID); err != nil || len(data) == 0 {
		t.Fatalf("work item file not readable: %v", err)
	}
	txt := "Raised with DBA, waiting"
	s.UpdateBlock(w.ID, note.ID, &txt, nil, "down")
	got, _ := s.GetWorkItem(w.ID)
	if got.Blocks[0].ID != link.ID || got.Blocks[1].Text != txt {
		t.Fatalf("edit/move failed: %+v", got.Blocks)
	}
	s.DeleteWorkItem(w.ID)
	if _, err := os.Stat(filepath.Join(dir, "attachments", at.ID)); !os.IsNotExist(err) {
		t.Fatal("screenshot file left behind after deleting the work item")
	}
}

func TestWorkDoc(t *testing.T) {
	s, _ := OpenStore(t.TempDir())
	w := s.SaveWorkItem(WorkItem{Title: "INC-9"})
	at, _ := s.storeAttachment("shot.png", []byte("\x89PNG\r\n\x1a\n...."))
	if err := s.AddWorkFile(w.ID, at); err != nil {
		t.Fatal(err)
	}
	doc := `<h1>Outage</h1><p>See <a href="https://corp.atlassian.net/browse/INC-9">INC-9</a></p><img src="/api/props/files/` + at.ID + `">`
	if err := s.SetWorkDoc(w.ID, doc); err != nil {
		t.Fatal(err)
	}
	if _, data, err := s.ReadAttachment(at.ID); err != nil || len(data) == 0 {
		t.Fatal("image in document not readable")
	}
	got, _ := s.GetWorkItem(w.ID)
	if got.Doc != doc || len(got.Blocks) != 0 {
		t.Fatal("document not saved")
	}
}

func TestWorkDocx(t *testing.T) {
	dir := t.TempDir()
	s, _ := OpenStore(dir)
	w := s.SaveWorkItem(WorkItem{Title: "INC/77: login <outage>", Status: "doing", Tags: []string{"auth"}})
	png := []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x02\x00\x00\x00\x02\x08\x02\x00\x00\x00\xfd\xd4\x9a\x73\x00\x00\x00\x00IEND\xaeB`\x82")
	at, _ := s.storeAttachment("shot.png", png)
	s.AddWorkFile(w.ID, at)
	s.SetWorkDoc(w.ID, `<h1>Timeline</h1><p>Seen at <b>09:10</b>, see <a href="https://corp.atlassian.net/browse/INC-77">INC-77</a></p>`+
		`<ul><li>first</li><li>second</li></ul><p><input type="checkbox" checked> DBA informed</p><table><tr><th>host</th><td>app01</td></tr></table><p><img src="/api/props/files/`+at.ID+`"></p>`)
	name, err := s.writeWorkDocx(w.ID)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Dir(name) != filepath.Join(dir, "work-items") || strings.ContainsAny(filepath.Base(name), `/:<>`) {
		t.Fatalf("bad file name %q", name)
	}
	zr, err := zip.OpenReader(name)
	if err != nil {
		t.Fatal("not a valid .docx (zip):", err)
	}
	defer zr.Close()
	var doc, rels string
	media := 0
	for _, f := range zr.File {
		rc, _ := f.Open()
		b, _ := io.ReadAll(rc)
		rc.Close()
		switch {
		case f.Name == "word/document.xml":
			doc = string(b)
			if err := xml.Unmarshal(b, new(struct{})); err != nil {
				t.Fatal("document.xml is not well-formed:", err)
			}
		case f.Name == "word/_rels/document.xml.rels":
			rels = string(b)
		case strings.HasPrefix(f.Name, "word/media/"):
			media++
		}
	}
	for _, want := range []string{`w:val="Heading1"`, "Timeline", "<w:b/>", "w:hyperlink", "•", "☑", "<w:tbl>", "app01", "<w:drawing>", "INC/77: login &lt;outage&gt;"} {
		if !strings.Contains(doc, want) {
			t.Errorf("document.xml lacks %q", want)
		}
	}
	if !strings.Contains(rels, "https://corp.atlassian.net/browse/INC-77") || media != 1 {
		t.Errorf("link relationship or image missing (media=%d)", media)
	}
	// Renaming replaces the old file; deleting removes it.
	s.SaveWorkItem(WorkItem{ID: w.ID, Title: "INC-77 renamed"})
	s.writeWorkDocx(w.ID)
	files, _ := filepath.Glob(filepath.Join(dir, "work-items", "*.docx"))
	if len(files) != 1 || !strings.Contains(files[0], "INC-77 renamed") {
		t.Fatalf("after rename: %v", files)
	}
	s.removeWorkDocx(w.ID)
	if files, _ := filepath.Glob(filepath.Join(dir, "work-items", "*.docx")); len(files) != 0 {
		t.Fatal("docx left after delete")
	}
}
