package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReferenceFolders(t *testing.T) {
	dir := t.TempDir()
	st, _ := OpenStore(dir)
	// Something in the old Properties page first.
	n, _ := st.SavePropNode(PropNode{Name: "Payments"})
	c, _ := st.SavePropNode(PropNode{Name: "UAT", ParentID: n.ID, Text: "restart order: api then batch"})
	st.AddAttachment(c.ID, "app.properties", []byte("db.url=jdbc:oracle:thin:@h:1521/S\n"))
	a := &App{store: st, dataDir: dir}
	h := http.NewServeMux()
	h.HandleFunc("GET /api/ref", a.handleRefTree)
	h.HandleFunc("POST /api/ref/folder", a.handleRefFolder)
	h.HandleFunc("GET /api/ref/file", a.handleRefRead)
	h.HandleFunc("PUT /api/ref/file", a.handleRefWrite)
	h.HandleFunc("POST /api/ref/move", a.handleRefMove)
	h.HandleFunc("DELETE /api/ref/file", a.handleRefDelete)
	h.HandleFunc("GET /api/ref/history", a.handleRefHistory)
	do := func(method, url, body string) (int, string) {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(method, url, strings.NewReader(body)))
		return rec.Code, rec.Body.String()
	}
	_, tree := do("GET", "/api/ref", "")
	for _, want := range []string{`"JSON"`, `"YAML"`, `"Properties"`, `From Properties/Payments/UAT/app.properties`, `From Properties/Payments/UAT/Instructions.txt`} {
		if !strings.Contains(tree, want) {
			t.Fatalf("tree misses %s: %s", want, tree)
		}
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "reference/From Properties/Payments/UAT/app.properties")); !strings.Contains(string(b), "db.url") {
		t.Fatal("old Properties file not copied as a plain file")
	}
	if code, _ := do("POST", "/api/ref/folder", `{"path":"JSON/Schemas"}`); code != 200 {
		t.Fatal("mkdir", code)
	}
	do("PUT", "/api/ref/file?path=JSON/Schemas/order.json&new=1", `{"v":1}`)
	_, r2 := do("PUT", "/api/ref/file?path=JSON/Schemas/order.json&new=1", `{"v":2}`)
	if !strings.Contains(r2, "order (2).json") {
		t.Fatalf("upload overwrote instead of keeping both: %s", r2)
	}
	do("PUT", "/api/ref/file?path=JSON/Schemas/order.json", `{"v":3}`) // edit + save
	if _, body := do("GET", "/api/ref/file?path=JSON/Schemas/order.json", ""); body != `{"v":3}` {
		t.Fatalf("read back %q", body)
	}
	_, hist := do("GET", "/api/ref/history?path=JSON/Schemas/order.json", "")
	var vers []struct{ Name string }
	json.Unmarshal([]byte(hist), &vers)
	if len(vers) != 1 {
		t.Fatalf("old copy not kept: %s", hist)
	}
	if _, old := do("GET", "/api/ref/history?path=JSON/Schemas/order.json&v="+vers[0].Name, ""); old != `{"v":1}` {
		t.Fatalf("old copy content %q", old)
	}
	if code, _ := do("POST", "/api/ref/move", `{"from":"JSON/Schemas","to":"JSON/Schemas/x"}`); code != 400 {
		t.Fatal("moved a folder into itself")
	}
	if code, _ := do("POST", "/api/ref/move", `{"from":"JSON/Schemas/order (2).json","to":"YAML/order2.json"}`); code != 200 {
		t.Fatal("move failed")
	}
	do("DELETE", "/api/ref/file?path=YAML/order2.json", "")
	if _, err := os.Stat(filepath.Join(dir, "reference/YAML/order2.json")); err == nil {
		t.Fatal("not deleted")
	}
	kept, _ := filepath.Glob(filepath.Join(dir, "reference-deleted/*/YAML/order2.json"))
	if len(kept) != 1 {
		t.Fatal("deleted file was not kept")
	}
	for _, bad := range []string{"../outside.txt", "JSON/../../x", `C:\Windows\x`, "a/b:c"} {
		code, _ := do("PUT", "/api/ref/file?path="+strings.ReplaceAll(bad, " ", "%20"), "x")
		if _, err := os.Stat(filepath.Join(dir, "outside.txt")); err == nil {
			t.Fatalf("%q escaped the reference folder", bad)
		}
		_ = code
	}
	// A second start must not copy Properties again.
	a.ensureReference()
	if m, _ := filepath.Glob(filepath.Join(dir, "reference/From Properties/Payments/UAT/app (2).properties")); len(m) != 0 {
		t.Fatal("Properties copied twice")
	}
}

func TestReferenceLinks(t *testing.T) {
	dir, outside := t.TempDir(), t.TempDir()
	os.MkdirAll(filepath.Join(outside, "configs", "uat"), 0o700)
	os.WriteFile(filepath.Join(outside, "configs", "uat", "app.properties"), []byte("a=1\n"), 0o600)
	os.MkdirAll(filepath.Join(outside, "configs", ".git"), 0o700)
	os.WriteFile(filepath.Join(outside, "notes.yaml"), []byte("k: v\n"), 0o600)
	st, _ := OpenStore(dir)
	a := &App{store: st, dataDir: dir}
	h := http.NewServeMux()
	for pat, fn := range map[string]http.HandlerFunc{
		"GET /api/ref": a.handleRefTree, "POST /api/ref/link": a.handleRefLink, "POST /api/ref/folder": a.handleRefFolder,
		"GET /api/ref/file": a.handleRefRead, "PUT /api/ref/file": a.handleRefWrite, "POST /api/ref/move": a.handleRefMove,
		"DELETE /api/ref/file": a.handleRefDelete, "GET /api/ref/search": a.handleRefSearch, "GET /api/ref/history": a.handleRefHistory,
	} {
		h.HandleFunc(pat, fn)
	}
	do := func(method, url, body string) (int, string) {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(method, url, strings.NewReader(body)))
		return rec.Code, rec.Body.String()
	}
	js := func(v string) string { b, _ := json.Marshal(v); return string(b) }
	if code, body := do("POST", "/api/ref/link", `{"dir":"Properties","target":`+js(filepath.Join(outside, "configs"))+`}`); code != 200 {
		t.Fatal(code, body)
	}
	if code, body := do("POST", "/api/ref/link", `{"dir":"","name":"Notes","target":`+js(filepath.Join(outside, "notes.yaml"))+`}`); code != 200 {
		t.Fatal(code, body)
	}
	if code, _ := do("POST", "/api/ref/link", `{"dir":"","target":"relative/path"}`); code != 400 {
		t.Fatal("relative path accepted")
	}
	_, tree := do("GET", "/api/ref", "")
	for _, want := range []string{`"path":"Properties/configs","dir":true`, `"path":"Properties/configs/uat/app.properties"`, `"path":"Notes","dir":false`} {
		if !strings.Contains(tree, want) {
			t.Fatalf("missing %s in %s", want, tree)
		}
	}
	if strings.Contains(tree, ".git") || strings.Contains(tree, ".whlink") {
		t.Fatalf("tree shows internals: %s", tree)
	}
	if _, body := do("GET", "/api/ref/file?path=Properties/configs/uat/app.properties", ""); body != "a=1\n" {
		t.Fatalf("read linked: %q", body)
	}
	// Edit in place (old copy kept), but no new files, moves or deletes inside.
	if code, _ := do("PUT", "/api/ref/file?path=Properties/configs/uat/app.properties", "a=2\n"); code != 200 {
		t.Fatal("edit linked file", code)
	}
	if b, _ := os.ReadFile(filepath.Join(outside, "configs", "uat", "app.properties")); string(b) != "a=2\n" {
		t.Fatal("real file not edited")
	}
	if _, hist := do("GET", "/api/ref/history?path=Properties/configs/uat/app.properties", ""); !strings.Contains(hist, `"name"`) {
		t.Fatal("no older copy for linked file")
	}
	if _, body := do("GET", "/api/ref/search?q=a=2", ""); !strings.Contains(body, "app.properties") {
		t.Fatalf("search misses linked content: %s", body)
	}
	for _, c := range [][3]string{
		{"PUT", "/api/ref/file?new=1&path=Properties/configs/new.txt", "x"},
		{"POST", "/api/ref/folder", `{"path":"Properties/configs/sub"}`},
		{"DELETE", "/api/ref/file?path=Properties/configs/uat/app.properties", ""},
		{"POST", "/api/ref/move", `{"from":"Properties/configs/uat","to":"YAML/uat"}`},
	} {
		if code, _ := do(c[0], c[1], c[2]); code == 200 {
			t.Fatalf("%v was allowed inside a linked folder", c)
		}
	}
	// Renaming and removing the link touch only the link.
	if code, body := do("POST", "/api/ref/move", `{"from":"Properties/configs","to":"YAML/UAT configs"}`); code != 200 {
		t.Fatal(code, body)
	}
	if code, _ := do("DELETE", "/api/ref/file?path=YAML/UAT%20configs", ""); code != 200 {
		t.Fatal("remove link")
	}
	if _, err := os.Stat(filepath.Join(outside, "configs", "uat", "app.properties")); err != nil {
		t.Fatal("removing the link deleted the real files!")
	}
	// A link whose target is gone shows as missing instead of failing.
	os.Remove(filepath.Join(outside, "notes.yaml"))
	if _, tree := do("GET", "/api/ref", ""); !strings.Contains(tree, `"missing":true`) {
		t.Fatalf("missing target not flagged: %s", tree)
	}
}
