package main

import (
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func encryptDBeaver(t *testing.T, plain []byte) []byte {
	blk, _ := aes.NewCipher(dbeaverKey)
	pad := aes.BlockSize - len(plain)%aes.BlockSize
	data := append(append([]byte{}, plain...), []byte(strings.Repeat(string(rune(pad)), pad))...)
	iv := []byte("0123456789abcdef")
	out := make([]byte, len(data))
	cipher.NewCBCEncrypter(blk, iv).CryptBlocks(out, data)
	return append(iv, out...)
}

func TestImportDBeaver(t *testing.T) {
	dir := t.TempDir()
	ds := `{"folders":{"AWS - UAT01":{}},"connections":{
	  "oracle_thin-1":{"provider":"oracle","name":"UAT01C - chopin","folder":"AWS - UAT01","configuration":{"host":"db-uat01.example.com","port":"1521","database":"PAYUAT","type":"test","provider-properties":{"@dbeaver-sid-service@":"SERVICE"}}},
	  "postgres-2":{"provider":"postgresql","name":"LOCAL - Postgres DB","configuration":{"host":"localhost","port":"5432","database":"pay","type":"dev","user":"app"}}}}`
	os.WriteFile(filepath.Join(dir, "data-sources.json"), []byte(ds), 0o600)
	os.WriteFile(filepath.Join(dir, "credentials-config.json"), encryptDBeaver(t, []byte(`{"oracle_thin-1":{"#connection":{"user":"chopin","password":"Demo#1"}}}`)), 0o600)
	list, err := readImport("dbeaver", filepath.Join(dir, "data-sources.json"), nil)
	if err != nil || len(list) != 2 {
		t.Fatalf("%v %+v", err, list)
	}
	var ora ImportConn
	for _, c := range list {
		if c.Protocol == "oracle" {
			ora = c
		}
	}
	if ora.Host != "db-uat01.example.com" || ora.Port != 1521 || ora.Extra["service"] != "PAYUAT" || ora.Username != "chopin" || ora.Password != "Demo#1" || ora.Env != "TEST" || ora.Folder != "AWS - UAT01" {
		t.Fatalf("oracle: %+v", ora)
	}
}

func TestImportPuttyReg(t *testing.T) {
	reg := "Windows Registry Editor Version 5.00\r\n\r\n[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\Default%20Settings]\r\n\"HostName\"=\"\"\r\n\r\n" +
		"[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\UAT%2Fbatch%20server]\r\n\"HostName\"=\"ops@acme-bat-01.uat.example.com\"\r\n\"PortNumber\"=dword:00000016\r\n\"Protocol\"=\"ssh\"\r\n" +
		"\"PortForwardings\"=\"L1522=db.example.com:1521,R9000=x:9000\"\r\n\"PublicKeyFile\"=\"C:\\\\keys\\\\ops.ppk\"\r\n"
	list, err := parsePuttyReg([]byte(reg))
	if err != nil || len(list) != 1 {
		t.Fatalf("%v %+v", err, list)
	}
	c := list[0]
	if c.Host != "acme-bat-01.uat.example.com" || c.Username != "ops" || c.Port != 0 || c.Folder != "UAT" || c.Name != "batch server" || c.Extra["tunnels"] != "1522:db.example.com:1521" || c.KeyFile != `C:\keys\ops.ppk` {
		t.Fatalf("putty: %+v", c)
	}
}

func TestImportFileZillaAndSQLDev(t *testing.T) {
	fz := `<?xml version="1.0"?><FileZilla3><Servers><Folder expanded="1">UAT
	  <Server><Host>ftp.example.com</Host><Port>22</Port><Protocol>1</Protocol><User>batch</User><Pass encoding="base64">` + base64.StdEncoding.EncodeToString([]byte("S3cret")) + `</Pass><Name>Batch SFTP</Name><RemoteDir>1 0 4 home 5 batch</RemoteDir></Server>
	</Folder></Servers></FileZilla3>`
	list, err := parseFileZilla([]byte(fz))
	if err != nil || len(list) != 1 || list[0].Protocol != "sftp" || list[0].Password != "S3cret" || list[0].Folder != "UAT" || list[0].Extra["start_dir"] != "/home/batch" {
		t.Fatalf("filezilla: %v %+v", err, list)
	}
	js := `{"connections":[{"name":"PAYUAT","type":"jdbc","info":{"hostname":"ora-uat.example.com","port":"1521","serviceName":"PAYUAT","user":"pay_app"}}]}`
	l2, err := parseSQLDeveloper([]byte(js))
	if err != nil || len(l2) != 1 || l2[0].Extra["service"] != "PAYUAT" || l2[0].Username != "pay_app" {
		t.Fatalf("sqldev json: %v %+v", err, l2)
	}
	x := `<References><Reference name="PAYPRD"><RefAddresses><StringRefAddr addrType="hostname"><Contents>ora-prd.example.com</Contents></StringRefAddr><StringRefAddr addrType="port"><Contents>1521</Contents></StringRefAddr><StringRefAddr addrType="sid"><Contents>PRD</Contents></StringRefAddr></RefAddresses></Reference></References>`
	l3, err := parseSQLDeveloper([]byte(x))
	if err != nil || len(l3) != 1 || l3[0].Extra["sid"] != "PRD" {
		t.Fatalf("sqldev xml: %v %+v", err, l3)
	}
	if guessSource("sitemanager.xml", []byte(fz)) != "filezilla" || guessSource("connections.json", []byte(js)) != "sqldeveloper" {
		t.Fatal("guessSource")
	}
}

// Importing twice adds nothing new; an existing connection only gets what it lacked.
func TestImportApplyNoDuplicates(t *testing.T) {
	st, _ := OpenStore(t.TempDir())
	a := &App{store: st}
	st.SaveEntry(EntryInput{Project: "Mine", Name: "ora uat", Host: "ora-uat.example.com", Port: 1521, Protocol: "oracle", Username: "pay_app"})
	items := []ImportConn{
		{Source: "sqldeveloper", Name: "PAYUAT", Host: "ora-uat.example.com", Port: 1521, Protocol: "oracle", Username: "pay_app", Password: "pw", Extra: map[string]string{"service": "PAYUAT"}},
		{Source: "filezilla", Name: "Batch", Host: "ftp.example.com", Protocol: "sftp", Username: "batch", Folder: "UAT"},
	}
	apply := func() map[string]int {
		b, _ := json.Marshal(map[string]any{"items": items})
		w := httptest.NewRecorder()
		a.handleImportApply(w, httptest.NewRequest("POST", "/", strings.NewReader(string(b))))
		var out map[string]int
		json.Unmarshal(w.Body.Bytes(), &out)
		return out
	}
	if r := apply(); r["added"] != 1 || r["updated"] != 1 {
		t.Fatalf("first: %v", r)
	}
	if r := apply(); r["added"] != 0 || r["updated"] != 0 {
		t.Fatalf("second import must change nothing: %v", r)
	}
	for _, e := range st.Entries() {
		if e.Host == "ora-uat.example.com" && (e.Extra["service"] != "PAYUAT" || e.Password != "pw" || e.Project != "Mine") {
			t.Fatalf("existing entry not filled in: %+v", e)
		}
		if e.Host == "ftp.example.com" && (e.Project != "UAT" || e.Env != "UAT") {
			t.Fatalf("new entry: %+v", e)
		}
	}
}
