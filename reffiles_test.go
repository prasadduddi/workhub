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
