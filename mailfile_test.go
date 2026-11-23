package main

import (
	"bytes"
	"encoding/binary"
	"strings"
	"testing"
	"time"
	"unicode/utf16"
)

func u16(s string) []byte {
	var b bytes.Buffer
	for _, c := range utf16.Encode([]rune(s)) {
		binary.Write(&b, binary.LittleEndian, c)
	}
	return b.Bytes()
}

// buildCFB writes a compound file the way Outlook does: small streams in the
// mini stream. items: "path" → data; paths with "/" make storages.
func buildCFB(items map[string][]byte, order []string) []byte {
	const sec, mini = 512, 64
	type ent struct {
		name                string
		kind                byte
		child, right, start uint32
		size                uint32
	}
	ents := []ent{{name: "Root Entry", kind: 5, child: 0xFFFFFFFF, right: 0xFFFFFFFF}}
	storages := map[string]int{"": 0}
	var ms []byte
	var minifat []uint32
	link := func(parent, idx int) { // chain siblings through "right"
		if ents[parent].child == 0xFFFFFFFF {
			ents[parent].child = uint32(idx)
			return
		}
		i := int(ents[parent].child)
		for ents[i].right != 0xFFFFFFFF {
			i = int(ents[i].right)
		}
		ents[i].right = uint32(idx)
	}
	for _, p := range order {
		dir, name := "", p
		if i := strings.LastIndex(p, "/"); i >= 0 {
			dir, name = p[:i], p[i+1:]
		}
		if _, ok := storages[dir]; !ok {
			ents = append(ents, ent{name: dir, kind: 1, child: 0xFFFFFFFF, right: 0xFFFFFFFF})
			storages[dir] = len(ents) - 1
			link(0, len(ents)-1)
		}
		data := items[p]
		start := uint32(len(ms) / mini)
		n := (len(data) + mini - 1) / mini
		for k := 0; k < n; k++ {
			if k == n-1 {
				minifat = append(minifat, cfbEnd)
			} else {
				minifat = append(minifat, start+uint32(k)+1)
			}
		}
		pad := make([]byte, n*mini)
		copy(pad, data)
		ms = append(ms, pad...)
		ents = append(ents, ent{name: name, kind: 2, child: 0xFFFFFFFF, right: 0xFFFFFFFF, start: start, size: uint32(len(data))})
		link(storages[dir], len(ents)-1)
	}
	// sectors: [FAT][dir...][minifat...][ministream...]
	secs := func(n int) int { return (n + sec - 1) / sec }
	dirBytes := len(ents) * 128
	nDir, nMF, nMS := secs(dirBytes), secs(len(minifat)*4), secs(len(ms))
	fat := []uint32{0xFFFFFFFD} // sector 0 holds the FAT
	chain := func(first, n int) {
		for k := 0; k < n; k++ {
			if k == n-1 {
				fat = append(fat, cfbEnd)
			} else {
				fat = append(fat, uint32(first+k+1))
			}
		}
	}
	dirStart, mfStart, msStart := 1, 1+nDir, 1+nDir+nMF
	chain(dirStart, nDir)
	chain(mfStart, nMF)
	chain(msStart, nMS)
	ents[0].start, ents[0].size = uint32(msStart), uint32(len(ms))
	var out bytes.Buffer
	h := make([]byte, 512)
	copy(h, []byte{0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1})
	le := binary.LittleEndian
	le.PutUint16(h[0x1A:], 3)
	le.PutUint16(h[0x1C:], 0xFFFE)
	le.PutUint16(h[0x1E:], 9)
	le.PutUint16(h[0x20:], 6)
	le.PutUint32(h[0x2C:], 1)
	le.PutUint32(h[0x30:], uint32(dirStart))
	le.PutUint32(h[0x38:], 4096)
	le.PutUint32(h[0x3C:], uint32(mfStart))
	le.PutUint32(h[0x40:], uint32(nMF))
	le.PutUint32(h[0x44:], cfbEnd)
	for i := 0; i < 109; i++ {
		le.PutUint32(h[0x4C+i*4:], 0xFFFFFFFF)
	}
	le.PutUint32(h[0x4C:], 0)
	out.Write(h)
	block := func(b []byte, n int) { p := make([]byte, n*sec); copy(p, b); out.Write(p) }
	fb := make([]byte, sec)
	for i := range fb {
		fb[i] = 0xFF
	}
	for i, v := range fat {
		le.PutUint32(fb[i*4:], v)
	}
	out.Write(fb)
	var db bytes.Buffer
	for _, e := range ents {
		d := make([]byte, 128)
		nm := u16(e.name)
		copy(d, nm)
		le.PutUint16(d[64:], uint16(len(nm)+2))
		d[66] = e.kind
		le.PutUint32(d[68:], 0xFFFFFFFF)
		le.PutUint32(d[72:], e.right)
		le.PutUint32(d[76:], e.child)
		le.PutUint32(d[116:], e.start)
		le.PutUint32(d[120:], e.size)
		db.Write(d)
	}
	block(db.Bytes(), nDir)
	var mb bytes.Buffer
	for _, v := range minifat {
		binary.Write(&mb, le, v)
	}
	block(mb.Bytes(), nMF)
	block(ms, nMS)
	return out.Bytes()
}

func TestParseMSG(t *testing.T) {
	when := time.Date(2026, 11, 20, 9, 30, 0, 0, time.UTC)
	props := make([]byte, 32+16)
	binary.LittleEndian.PutUint32(props[32:], 0x00390040)
	binary.LittleEndian.PutUint64(props[40:], uint64(when.UnixNano()/100+116444736000000000))
	items := map[string][]byte{
		"__substg1.0_0037001F":                                u16("RE: Release plan for PAY-123"),
		"__substg1.0_0C1A001F":                                u16("Jane Doe"),
		"__substg1.0_5D01001F":                                u16("jane.doe@example.com"),
		"__substg1.0_0E04001F":                                u16("Release Team"),
		"__substg1.0_1000001F":                                u16("Hi,\r\nDeploy on srv-07.example.com at 18:00.\r\nThanks"),
		"__properties_version1.0":                             props,
		"__attach_version1.0_#00000000/__substg1.0_3707001F": u16("runbook.txt"),
		"__attach_version1.0_#00000000/__substg1.0_37010102": []byte("step 1\nstep 2\n"),
	}
	order := []string{"__substg1.0_0037001F", "__substg1.0_0C1A001F", "__substg1.0_5D01001F", "__substg1.0_0E04001F", "__substg1.0_1000001F", "__properties_version1.0",
		"__attach_version1.0_#00000000/__substg1.0_3707001F", "__attach_version1.0_#00000000/__substg1.0_37010102"}
	m, err := parseMSG(buildCFB(items, order))
	if err != nil {
		t.Fatal(err)
	}
	if m.Subject != "RE: Release plan for PAY-123" || m.From != "Jane Doe <jane.doe@example.com>" || m.To != "Release Team" || !strings.Contains(m.Body, "srv-07.example.com") || !m.Date.Equal(when) {
		t.Fatalf("%+v", m)
	}
	if len(m.Files) != 1 || m.Files[0].Name != "runbook.txt" || string(m.Files[0].Data) != "step 1\nstep 2\n" {
		t.Fatalf("attachments: %+v", m.Files)
	}
	if _, err := parseMSG([]byte("not a msg")); err == nil {
		t.Fatal("garbage accepted")
	}
}

func TestParseEML(t *testing.T) {
	eml := "From: =?UTF-8?Q?Jane_D=C3=B6e?= <jane.doe@example.com>\r\nTo: ops@example.com\r\nSubject: Outage on srv-07\r\nDate: Fri, 20 Nov 2026 09:30:00 +0000\r\nMIME-Version: 1.0\r\n" +
		"Content-Type: multipart/mixed; boundary=XX\r\n\r\n--XX\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nDisk full on srv-07 =E2=80=94 cleaning /var/log.\r\n" +
		"--XX\r\nContent-Type: text/plain; name=\"df.txt\"\r\nContent-Disposition: attachment; filename=\"df.txt\"\r\nContent-Transfer-Encoding: base64\r\n\r\nL2Rldi9zZGExIDEwMCU=\r\n--XX--\r\n"
	m, err := parseEML([]byte(eml))
	if err != nil {
		t.Fatal(err)
	}
	if m.Subject != "Outage on srv-07" || !strings.Contains(m.From, "Jane Döe") || !strings.Contains(m.Body, "Disk full on srv-07 — cleaning") || m.Date.IsZero() {
		t.Fatalf("%+v", m)
	}
	if len(m.Files) != 1 || m.Files[0].Name != "df.txt" || string(m.Files[0].Data) != "/dev/sda1 100%" {
		t.Fatalf("attachments: %+v", m.Files)
	}
}
