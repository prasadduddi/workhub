package main

import (
	"os"
	"path/filepath"
	"strings"
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
	// Stored encrypted on disk.
	raw, _ := os.ReadFile(filepath.Join(dir, "attachments", f.ID))
	if strings.Contains(string(raw), "db.url") {
		t.Fatal("attachment stored in plain text")
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
