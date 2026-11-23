package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestProps(t *testing.T) {
	dir := t.TempDir()
	s, _ := OpenStore(dir)
	app, _ := s.SavePropNode(PropNode{Name: "Payments", Text: "Restart order: batch, then api"})
	uat, _ := s.SavePropNode(PropNode{Name: "UAT", ParentID: app.ID})
	props := "db.url=jdbc:oracle:thin:@//ora-uat:1521/PAYUAT\ndb.user=pay_app\n"
	f, err := s.AddAttachment(uat.ID, "application.properties", []byte(props))
	if err != nil || !f.Text || f.Image {
		t.Fatalf("attach: %+v %v", f, err)
	}
	png := []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR")
	img, _ := s.AddAttachment(uat.ID, "login-screen.png", png)
	if !img.Image || img.Text {
		t.Fatalf("screenshot not recognised: %+v", img)
	}
	// Stored as it is on disk (not encrypted).
	raw, _ := os.ReadFile(filepath.Join(dir, "attachments", f.ID))
	if string(raw) != props {
		t.Fatalf("attachment on disk: %q", raw)
	}
	if _, b, _ := s.ReadAttachment(f.ID); string(b) != props {
		t.Fatalf("read back %q", b)
	}
	s.WriteAttachment(f.ID, []byte(props+"db.pool=20\n"))
	if got := s.SearchProps("db.pool"); len(got) != 1 || got[0] != uat.ID {
		t.Fatalf("search in file contents: %v", got)
	}
	if got := s.SearchProps("restart order"); len(got) != 1 || got[0] != app.ID {
		t.Fatalf("search in instructions: %v", got)
	}
	if _, err := s.SavePropNode(PropNode{ID: app.ID, Name: "Payments", ParentID: uat.ID}); err == nil {
		t.Fatal("moving a node inside its own child must fail")
	}
	if n := s.DeletePropNode(app.ID); n != 2 || len(s.PropNodes()) != 0 {
		t.Fatalf("delete removed %d", n)
	}
	if _, err := os.Stat(filepath.Join(dir, "attachments", f.ID)); !os.IsNotExist(err) {
		t.Fatal("attachment file left behind")
	}
}

func TestAttachmentsNotEncrypted(t *testing.T) {
	s, _ := OpenStore(t.TempDir())
	at, err := s.storeAttachment("notes.txt", []byte("plain words"))
	if err != nil {
		t.Fatal(err)
	}
	if raw, _ := os.ReadFile(filepath.Join(s.attachDir(), at.ID)); string(raw) != "plain words" {
		t.Fatalf("stored as %q", raw)
	}
	// a file saved encrypted by an older version still reads back
	old, _ := s.encrypt([]byte("older secret"))
	if got := s.attachmentData(old); string(got) != "older secret" {
		t.Fatalf("old file: %q", got)
	}
	// and a plain file that happens to start like an encrypted one is left alone
	odd := []byte(fileMagic + " just text")
	if got := s.attachmentData(odd); string(got) != string(odd) {
		t.Fatalf("plain file changed: %q", got)
	}
}
