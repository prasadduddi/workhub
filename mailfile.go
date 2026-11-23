package main

// Emails dropped on a thread: Outlook gives a .msg file (a Microsoft compound
// file), other mail programs .eml. Either becomes one message: subject,
// sender, recipients, date and text, with its attachments stored like other
// files in the thread.

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"html"
	"io"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net/http"
	"net/mail"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf16"
)

type mailFile struct {
	Subject, From, To string
	Date              time.Time
	Body              string // plain text
	Files             []mailAttachment
}

type mailAttachment struct {
	Name string
	Data []byte
}

// ---- Microsoft compound file (the container of .msg) ----

type cfbEntry struct {
	name               string
	kind               byte // 1 storage, 2 stream, 5 root
	left, right, child uint32
	start              uint32
	size               uint64
	path               string
}

type cfb struct {
	data              []byte
	secSize, miniSize int
	cutoff            uint64
	fat, miniFat      []uint32
	entries           []cfbEntry
	ministream        []byte
}

const cfbEnd = 0xFFFFFFFE

func openCFB(b []byte) (*cfb, error) {
	if len(b) < 512 || !bytes.Equal(b[:8], []byte{0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1}) {
		return nil, errors.New("not an Outlook message (.msg)")
	}
	le := binary.LittleEndian
	c := &cfb{data: b, secSize: 1 << le.Uint16(b[0x1E:]), miniSize: 1 << le.Uint16(b[0x20:]), cutoff: uint64(le.Uint32(b[0x38:]))}
	if c.secSize != 512 && c.secSize != 4096 {
		return nil, errors.New("damaged .msg file")
	}
	sector := func(n uint32) []byte {
		off := (int(n) + 1) * c.secSize
		if n >= 0xFFFFFFFA || off+c.secSize > len(b) {
			return nil
		}
		return b[off : off+c.secSize]
	}
	// FAT sectors listed in the header and the DIFAT chain
	var fatSecs []uint32
	for i := 0; i < 109; i++ {
		if s := le.Uint32(b[0x4C+i*4:]); s < 0xFFFFFFFA {
			fatSecs = append(fatSecs, s)
		}
	}
	for d, n := le.Uint32(b[0x44:]), 0; d < 0xFFFFFFFA && n < 1000; n++ {
		sec := sector(d)
		if sec == nil {
			break
		}
		for i := 0; i < c.secSize/4-1; i++ {
			if s := le.Uint32(sec[i*4:]); s < 0xFFFFFFFA {
				fatSecs = append(fatSecs, s)
			}
		}
		d = le.Uint32(sec[c.secSize-4:])
	}
	for _, s := range fatSecs {
		sec := sector(s)
		for i := 0; sec != nil && i < c.secSize/4; i++ {
			c.fat = append(c.fat, le.Uint32(sec[i*4:]))
		}
	}
	chain := func(start uint32, fat []uint32, read func(uint32) []byte, max int) []byte {
		var out []byte
		for s, n := start, 0; s < 0xFFFFFFFA && int(s) < len(fat) && n < 1<<20 && len(out) < max+c.secSize; n++ {
			sec := read(s)
			if sec == nil {
				break
			}
			out = append(out, sec...)
			s = fat[s]
		}
		return out
	}
	big := func(start uint32, size int) []byte {
		out := chain(start, c.fat, sector, size)
		if len(out) > size {
			out = out[:size]
		}
		return out
	}
	// directory
	dir := chain(le.Uint32(b[0x30:]), c.fat, sector, 1<<30)
	for i := 0; i+128 <= len(dir); i += 128 {
		e := dir[i : i+128]
		nl := int(le.Uint16(e[64:]))
		u := make([]uint16, 0, 32)
		for j := 0; j+1 < nl-2 && j < 64; j += 2 {
			u = append(u, le.Uint16(e[j:]))
		}
		c.entries = append(c.entries, cfbEntry{name: string(utf16.Decode(u)), kind: e[66], left: le.Uint32(e[68:]), right: le.Uint32(e[72:]),
			child: le.Uint32(e[76:]), start: le.Uint32(e[116:]), size: uint64(le.Uint32(e[120:]))})
	}
	if len(c.entries) == 0 || c.entries[0].kind != 5 {
		return nil, errors.New("damaged .msg file")
	}
	// mini FAT and mini stream (where streams under the cutoff live)
	mf := chain(le.Uint32(b[0x3C:]), c.fat, sector, 1<<30)
	for i := 0; i+4 <= len(mf); i += 4 {
		c.miniFat = append(c.miniFat, le.Uint32(mf[i:]))
	}
	c.ministream = big(c.entries[0].start, int(c.entries[0].size))
	// full paths ("__attach_version1.0_#00000000/__substg1.0_3707001F")
	var walk func(i uint32, parent string, depth int)
	walk = func(i uint32, parent string, depth int) {
		if i >= uint32(len(c.entries)) || depth > 64 {
			return
		}
		e := &c.entries[i]
		walk(e.left, parent, depth+1)
		e.path = strings.TrimPrefix(parent+"/"+e.name, "/")
		if e.kind == 1 {
			walk(e.child, e.path, depth+1)
		}
		walk(e.right, parent, depth+1)
	}
	walk(c.entries[0].child, "", 0)
	return c, nil
}

func (c *cfb) stream(path string) []byte {
	for _, e := range c.entries {
		if e.kind != 2 || !strings.EqualFold(e.path, path) {
			continue
		}
		size := int(e.size)
		var out []byte
		if e.size < c.cutoff {
			for s, n := e.start, 0; s < 0xFFFFFFFA && int(s) < len(c.miniFat) && len(out) < size && n < 1<<20; n++ {
				off := int(s) * c.miniSize
				if off+c.miniSize > len(c.ministream) {
					break
				}
				out = append(out, c.ministream[off:off+c.miniSize]...)
				s = c.miniFat[s]
			}
		} else {
			for s, n := e.start, 0; s < 0xFFFFFFFA && int(s) < len(c.fat) && len(out) < size && n < 1<<20; n++ {
				off := (int(s) + 1) * c.secSize
				if off+c.secSize > len(c.data) {
					break
				}
				out = append(out, c.data[off:off+c.secSize]...)
				s = c.fat[s]
			}
		}
		if len(out) > size {
			out = out[:size]
		}
		return out
	}
	return nil
}

func utf16le(b []byte) string {
	u := make([]uint16, len(b)/2)
	for i := range u {
		u[i] = binary.LittleEndian.Uint16(b[i*2:])
	}
	return strings.TrimRight(string(utf16.Decode(u)), "\x00")
}

// prop reads a string property of the message (or of an attachment storage).
func (c *cfb) prop(prefix, id string) string {
	if b := c.stream(prefix + "__substg1.0_" + id + "001F"); b != nil {
		return utf16le(b)
	}
	return strings.TrimRight(string(c.stream(prefix+"__substg1.0_"+id+"001E")), "\x00")
}

var reTagged = regexp.MustCompile(`(?s)<[^>]*>`)

func parseMSG(b []byte) (*mailFile, error) {
	c, err := openCFB(b)
	if err != nil {
		return nil, err
	}
	m := &mailFile{Subject: c.prop("", "0037"), To: c.prop("", "0E04"), Body: c.prop("", "1000")}
	name, addr := c.prop("", "0C1A"), c.prop("", "5D01")
	if addr == "" {
		if a := c.prop("", "0C1F"); strings.Contains(a, "@") {
			addr = a
		}
	}
	m.From = strings.TrimSpace(name + map[bool]string{true: " <" + addr + ">", false: ""}[addr != ""])
	if m.Body == "" { // HTML only: keep the text
		if h := c.stream("__substg1.0_10130102"); h != nil {
			m.Body = html.UnescapeString(reTagged.ReplaceAllString(string(h), " "))
		}
	}
	// the date: client-submit (0x0039) or delivery (0x0E06) time in the property table
	if p := c.stream("__properties_version1.0"); len(p) > 32 {
		for i := 32; i+16 <= len(p); i += 16 {
			tag := binary.LittleEndian.Uint32(p[i:])
			if id := tag >> 16; (id == 0x0039 || id == 0x0E06) && tag&0xFFFF == 0x0040 {
				ft := int64(binary.LittleEndian.Uint64(p[i+8:]))
				if t := time.Unix(0, (ft-116444736000000000)*100); t.Year() > 1990 && (m.Date.IsZero() || id == 0x0039) {
					m.Date = t
				}
			}
		}
	}
	for i := 0; i < 500; i++ {
		pre := fmt.Sprintf("__attach_version1.0_#%08X/", i)
		data := c.stream(pre + "__substg1.0_37010102")
		if data == nil {
			if i > 0 && c.prop(pre, "3707") == "" {
				break
			}
			continue
		}
		n := orDefault(c.prop(pre, "3707"), orDefault(c.prop(pre, "3704"), fmt.Sprintf("attachment-%d", i+1)))
		m.Files = append(m.Files, mailAttachment{n, data})
	}
	return m, nil
}

// ---- .eml (RFC 822) ----

func parseEML(b []byte) (*mailFile, error) {
	msg, err := mail.ReadMessage(bytes.NewReader(b))
	if err != nil {
		return nil, errors.New("not an email file (.eml)")
	}
	dec := new(mime.WordDecoder)
	hdr := func(k string) string {
		v := msg.Header.Get(k)
		if d, err := dec.DecodeHeader(v); err == nil {
			return d
		}
		return v
	}
	m := &mailFile{Subject: hdr("Subject"), From: hdr("From"), To: hdr("To")}
	m.Date, _ = msg.Header.Date()
	var htmlBody string
	var walk func(ct string, body io.Reader, enc string, disp string)
	walk = func(ct string, body io.Reader, enc string, disp string) {
		mt, params, _ := mime.ParseMediaType(ct)
		if strings.HasPrefix(mt, "multipart/") {
			mr := multipart.NewReader(body, params["boundary"])
			for {
				p, err := mr.NextRawPart()
				if err != nil {
					return
				}
				walk(p.Header.Get("Content-Type"), p, p.Header.Get("Content-Transfer-Encoding"), p.Header.Get("Content-Disposition"))
			}
		}
		data, _ := io.ReadAll(decodeTransfer(body, enc))
		_, dp, _ := mime.ParseMediaType(disp)
		name := orDefault(dp["filename"], params["name"])
		switch {
		case name != "" || strings.HasPrefix(disp, "attachment"):
			if d, err := dec.DecodeHeader(name); err == nil {
				name = d
			}
			m.Files = append(m.Files, mailAttachment{orDefault(name, "attachment"), data})
		case mt == "text/plain" && m.Body == "":
			m.Body = string(data)
		case mt == "text/html" && htmlBody == "":
			htmlBody = string(data)
		}
	}
	walk(orDefault(msg.Header.Get("Content-Type"), "text/plain"), msg.Body, msg.Header.Get("Content-Transfer-Encoding"), "")
	if m.Body == "" && htmlBody != "" {
		m.Body = html.UnescapeString(reTagged.ReplaceAllString(htmlBody, " "))
	}
	return m, nil
}

// ---- the thread message ----

func (a *App) handleWorkEmail(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := r.ParseMultipartForm(64 << 20); err != nil {
		writeErr(w, 400, err)
		return
	}
	var posted []Post
	for _, fh := range r.MultipartForm.File["file"] {
		f, err := fh.Open()
		if err != nil {
			continue
		}
		b, _ := io.ReadAll(io.LimitReader(f, maxAttachment+1))
		f.Close()
		var m *mailFile
		if strings.EqualFold(filepath.Ext(fh.Filename), ".msg") {
			m, err = parseMSG(b)
		} else {
			m, err = parseEML(b)
		}
		if err != nil {
			writeErr(w, 400, fmt.Errorf("%s: %v", fh.Filename, err))
			return
		}
		var sb strings.Builder
		sb.WriteString("<p>✉ <b>" + html.EscapeString(orDefault(m.Subject, strings.TrimSuffix(fh.Filename, filepath.Ext(fh.Filename)))) + "</b><br>")
		var meta []string
		if m.From != "" {
			meta = append(meta, "From "+m.From)
		}
		if m.To != "" {
			meta = append(meta, "To "+m.To)
		}
		if !m.Date.IsZero() {
			meta = append(meta, m.Date.Local().Format("Mon 2 Jan 2006 15:04"))
		}
		sb.WriteString("<i>" + html.EscapeString(strings.Join(meta, " · ")) + "</i></p>")
		body := strings.TrimSpace(strings.ReplaceAll(m.Body, "\r\n", "\n"))
		if len(body) > 20000 {
			body = body[:20000] + "\n…"
		}
		if body != "" {
			sb.WriteString("<blockquote>" + strings.ReplaceAll(html.EscapeString(body), "\n", "<br>") + "</blockquote>")
		}
		for _, f := range m.Files {
			at, err := a.store.storeAttachment(f.Name, f.Data)
			if err != nil {
				continue
			}
			_ = a.store.AddWorkFile(id, at)
			if at.Image {
				sb.WriteString(fmt.Sprintf(`<p><img src="/api/props/files/%s" alt="%s"></p>`, at.ID, html.EscapeString(at.Name)))
			} else {
				sb.WriteString(fmt.Sprintf(`<p>📎 <a href="http://%s/api/props/files/%s?download=1">%s</a></p>`, a.addr, at.ID, html.EscapeString(at.Name)))
			}
		}
		p, err := a.store.AddPost(id, Post{Kind: "note", HTML: sb.String(), From: map[bool]string{true: "Outlook", false: "Email"}[strings.EqualFold(filepath.Ext(fh.Filename), ".msg")]})
		if err != nil {
			writeErr(w, 404, err)
			return
		}
		posted = append(posted, p)
	}
	a.store.MarkRead(id)
	_, _ = a.store.writeWorkDocx(id)
	writeJSON(w, posted)
}

func decodeTransfer(r io.Reader, enc string) io.Reader {
	switch strings.ToLower(strings.TrimSpace(enc)) {
	case "base64":
		return base64.NewDecoder(base64.StdEncoding, &lineStripper{r: r})
	case "quoted-printable":
		return quotedprintable.NewReader(r)
	}
	return r
}

// lineStripper drops the line breaks base64 bodies are wrapped with.
type lineStripper struct{ r io.Reader }

func (l *lineStripper) Read(p []byte) (int, error) {
	n, err := l.r.Read(p)
	j := 0
	for _, c := range p[:n] {
		if c != '\r' && c != '\n' && c != ' ' && c != '\t' {
			p[j] = c
			j++
		}
	}
	if j == 0 && n > 0 && err == nil {
		return l.Read(p)
	}
	return j, err
}
