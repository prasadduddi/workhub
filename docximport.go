package main

// Import Word documents (.docx) as task threads. Headings, bold/italic,
// lists, links, tables and pictures are kept; pictures go into the encrypted
// file store. A document WorkHub exported itself (dated paragraphs) is split
// back into its posts; any other document gets one post per heading.

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type docxRel struct{ Target, Mode string }

// a bullet or number typed into the text ("•\t", "1.\t"), as WorkHub's own Word copies have
var listMark = regexp.MustCompile(`^(?:[•◦▪‣·\-]|\d+[.)])[\t  ]+`)

// exported thread: "📌 ↳ reply · Mon 2 Jan 2006 15:04" paragraphs start posts
var docxPostHead = regexp.MustCompile(`^(📌 )?(↳ reply · )?(\w{3} \d{1,2} \w{3} \d{4} \d{2}:\d{2})$`)

type docxPart struct {
	html   string
	head   string // a post heading's date text (exported threads)
	pinned bool
	reply  bool
}

// docxContent is a Word document read into HTML parts, its pictures already
// in the encrypted file store.
type docxContent struct {
	title, status, jira string
	when                time.Time
	parts               []docxPart
	stored              []Attachment
}

// readDocx reads a .docx: its text as HTML (headings, bold/italic/underline,
// lists, links, tables) and its pictures, stored as attachments.
func (s *Store) readDocx(name string, data []byte) (*docxContent, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, errors.New(name + ": not a Word document (.docx) — older .doc files must be saved as .docx in Word first")
	}
	files := map[string]*zip.File{}
	for _, f := range zr.File {
		files[f.Name] = f
	}
	read := func(n string) []byte {
		f := files[n]
		if f == nil {
			return nil
		}
		rc, err := f.Open()
		if err != nil {
			return nil
		}
		defer rc.Close()
		b, _ := io.ReadAll(io.LimitReader(rc, 64<<20))
		return b
	}
	doc := read("word/document.xml")
	if doc == nil {
		return nil, errors.New(name + ": no document inside (is it a Word file?)")
	}
	rels := map[string]docxRel{}
	var rx struct {
		R []struct {
			ID     string `xml:"Id,attr"`
			Target string `xml:"Target,attr"`
			Mode   string `xml:"TargetMode,attr"`
		} `xml:"Relationship"`
	}
	if xml.Unmarshal(read("word/_rels/document.xml.rels"), &rx) == nil {
		for _, r := range rx.R {
			rels[r.ID] = docxRel{r.Target, r.Mode}
		}
	}
	var core struct {
		Title    string `xml:"title"`
		Modified string `xml:"modified"`
	}
	_ = xml.Unmarshal(read("docProps/core.xml"), &core)

	var stored []Attachment
	pictures := map[string]string{} // one stored copy of a picture used twice
	image := func(rid string) string {
		if h, ok := pictures[rid]; ok {
			return h
		}
		rel, ok := rels[rid]
		if !ok || rel.Mode == "External" {
			return ""
		}
		p := path.Clean(path.Join("word", rel.Target))
		b := read(p)
		if b == nil {
			return ""
		}
		at, err := s.storeAttachment(path.Base(p), b)
		if err != nil {
			return ""
		}
		stored = append(stored, at)
		h := fmt.Sprintf(`<img src="/api/props/files/%s" alt="%s">`, at.ID, html.EscapeString(at.Name))
		if !webPictures[strings.ToLower(path.Ext(p))] { // EMF/WMF/TIFF: a browser can't show it; it is in the thread's files
			h = "[picture: " + html.EscapeString(at.Name) + "]"
		}
		pictures[rid] = h
		return h
	}

	title, status, jira, parts, damaged := parseDocx(doc, rels, parseNumbering(read("word/numbering.xml")), image)
	if damaged != nil {
		if len(parts) == 0 {
			for _, at := range stored { // pictures read before the damage: nothing will show them
				_ = removeFile(s.attachDir(), at.ID)
			}
			return nil, fmt.Errorf("%s: the document looks damaged and couldn't be read (%v) — open it in Word, save it again and retry", name, damaged)
		}
		parts = append(parts, docxPart{html: "<p><i>[The rest of this document couldn't be read — it looks damaged. Open the attached copy in Word.]</i></p>"})
	}
	title = strings.TrimSpace(orDefault(title, orDefault(core.Title, strings.TrimSuffix(path.Base(strings.ReplaceAll(name, `\`, "/")), path.Ext(name)))))
	when := time.Now()
	if t, err := time.Parse(time.RFC3339, core.Modified); err == nil {
		when = t
	}
	return &docxContent{title, status, jira, when, parts, stored}, nil
}

// ImportDocx creates a thread from a Word document.
func (s *Store) ImportDocx(name string, data []byte) (WorkItem, error) {
	d, err := s.readDocx(name, data)
	if err != nil {
		return WorkItem{}, err
	}
	title, status, jira, when, parts, stored := d.title, d.status, d.jira, d.when, d.parts, d.stored

	w := s.SaveWorkItem(WorkItem{Title: title, Status: orDefault(status, "todo"), Jira: orDefault(jira, jiraKeyOf(title))})
	for _, at := range stored {
		_ = s.AddWorkFile(w.ID, at)
	}
	// Exported threads: one post per dated heading. Other documents: one post
	// per heading, at the highest heading level the document uses.
	exported := false
	for _, p := range parts {
		exported = exported || p.head != ""
	}
	if !exported {
		split := ""
		for _, h := range []string{"<h1>", "<h2>", "<h3>"} {
			for _, p := range parts {
				if split == "" && strings.HasPrefix(p.html, h) {
					split = h
				}
			}
		}
		if split != "" {
			for i := range parts {
				if strings.HasPrefix(parts[i].html, split) {
					parts[i].head = "section"
				}
			}
			// the heading starts the post: give it its own part after the marker
			var out []docxPart
			for _, p := range parts {
				if p.head == "section" {
					out = append(out, docxPart{head: "section"}, docxPart{html: p.html})
				} else {
					out = append(out, p)
				}
			}
			parts = out
		}
	}
	var posts []Post
	var lastTop string
	for _, p := range parts {
		if p.head == "section" {
			posts = append(posts, Post{Kind: "note", At: when})
			continue
		}
		if p.head != "" {
			at, err := time.ParseInLocation("Mon 2 Jan 2006 15:04", p.head, time.Local)
			if err != nil {
				at = when
			}
			posts = append(posts, Post{Kind: "note", At: at, Pinned: p.pinned, Parent: map[bool]string{true: "reply"}[p.reply]})
			continue
		}
		if len(posts) == 0 {
			posts = append(posts, Post{Kind: "note", At: when})
		}
		posts[len(posts)-1].HTML += p.html
	}
	for _, p := range posts {
		if strings.TrimSpace(tagRe.ReplaceAllString(p.HTML, "")) == "" && !strings.Contains(p.HTML, "<img") {
			continue
		}
		if p.Parent == "reply" {
			p.Parent = lastTop
		}
		added, err := s.AddPost(w.ID, p)
		if err != nil {
			continue
		}
		if added.Parent == "" {
			lastTop = added.ID
		}
	}
	got, _ := s.GetWorkItem(w.ID)
	return got, nil
}

// ImportDocxInto adds a Word document's contents to an existing thread as
// one message, formatting and pictures kept, with the document itself
// attached (fileLink makes the link to an attachment).
func (s *Store) ImportDocxInto(id, name string, data []byte, fileLink func(Attachment) string) (Post, error) {
	if _, ok := s.GetWorkItem(id); !ok {
		return Post{}, errors.New("thread not found")
	}
	d, err := s.readDocx(name, data)
	if err != nil {
		return Post{}, err
	}
	base := path.Base(strings.ReplaceAll(name, `\`, "/"))
	var b strings.Builder
	b.WriteString("<p>📄 <b>" + html.EscapeString(orDefault(d.title, strings.TrimSuffix(base, path.Ext(base)))) + "</b></p>")
	for _, p := range d.parts {
		if p.head != "" { // a post heading of a thread WorkHub exported: keep it as a line
			b.WriteString("<p><i>" + html.EscapeString(map[bool]string{true: "↳ reply · "}[p.reply]+p.head) + "</i></p>")
			continue
		}
		b.WriteString(p.html)
	}
	for _, at := range d.stored {
		_ = s.AddWorkFile(id, at)
	}
	if at, err := s.storeAttachment(base, data); err == nil {
		_ = s.AddWorkFile(id, at)
		b.WriteString(`<p>📎 <a href="` + html.EscapeString(fileLink(at)) + `">` + html.EscapeString(at.Name) + `</a></p>`)
	}
	return s.AddPost(id, Post{Kind: "note", HTML: b.String(), From: "Word"})
}

// docxNumbering tells, per list (numId) and level, whether Word numbers it
// (1. 2. 3., a. b. c., i. ii.) or puts bullets — from word/numbering.xml.
type docxNumbering map[string]map[int]bool

func parseNumbering(b []byte) docxNumbering {
	var x struct {
		Abstract []struct {
			ID  string `xml:"abstractNumId,attr"`
			Lvl []struct {
				Ilvl int `xml:"ilvl,attr"`
				Fmt  struct {
					Val string `xml:"val,attr"`
				} `xml:"numFmt"`
			} `xml:"lvl"`
		} `xml:"abstractNum"`
		Num []struct {
			ID       string `xml:"numId,attr"`
			Abstract struct {
				Val string `xml:"val,attr"`
			} `xml:"abstractNumId"`
			Override []struct {
				Ilvl int `xml:"ilvl,attr"`
				Lvl  struct {
					Fmt struct {
						Val string `xml:"val,attr"`
					} `xml:"numFmt"`
				} `xml:"lvl"`
			} `xml:"lvlOverride"`
		} `xml:"num"`
	}
	out := docxNumbering{}
	if xml.Unmarshal(b, &x) != nil {
		return out
	}
	ordered := func(f string) bool { return f != "" && f != "bullet" && f != "none" }
	abs := map[string]map[int]bool{}
	for _, a := range x.Abstract {
		m := map[int]bool{}
		for _, l := range a.Lvl {
			m[l.Ilvl] = ordered(l.Fmt.Val)
		}
		abs[a.ID] = m
	}
	for _, n := range x.Num {
		m := map[int]bool{}
		for k, v := range abs[n.Abstract.Val] {
			m[k] = v
		}
		for _, o := range n.Override {
			if o.Lvl.Fmt.Val != "" {
				m[o.Ilvl] = ordered(o.Lvl.Fmt.Val)
			}
		}
		out[n.ID] = m
	}
	return out
}

type docxListItem struct {
	lvl     int
	ordered bool
	html    string
}

// docxListHTML nests list items by their level: <ol>/<ul> as Word numbers them.
func docxListHTML(items []docxListItem) string {
	var b strings.Builder
	var open []bool // ordered, per open level
	tag := func(o bool) string { return map[bool]string{true: "ol", false: "ul"}[o] }
	closeTop := func() {
		b.WriteString("</li></" + tag(open[len(open)-1]) + ">")
		open = open[:len(open)-1]
	}
	for _, it := range items {
		lvl := min(max(it.lvl, 0), 8)
		for len(open) > lvl+1 {
			closeTop()
		}
		if len(open) == lvl+1 {
			if open[lvl] != it.ordered { // a bullet list straight after a numbered one
				closeTop()
			} else {
				b.WriteString("</li>")
			}
		}
		for len(open) < lvl+1 {
			if len(open) > 0 && len(open) < lvl { // skipped a level: give it an item to sit in
				b.WriteString("<" + tag(it.ordered) + "><li>")
				open = append(open, it.ordered)
				continue
			}
			b.WriteString("<" + tag(it.ordered) + ">")
			open = append(open, it.ordered)
		}
		b.WriteString("<li>" + it.html)
	}
	for len(open) > 0 {
		closeTop()
	}
	return b.String()
}

type docxCell struct {
	html   string
	span   int    // columns (gridSpan)
	vmerge string // "restart", "continue" or ""
}

type docxTable struct {
	rows  [][]docxCell
	paras []string // the current cell's paragraphs
	span  int
	vm    string
}

// html draws the table; vertically merged cells become one cell with rowspan.
func (t *docxTable) html() string {
	var b strings.Builder
	b.WriteString("<table>")
	for r, row := range t.rows {
		b.WriteString("<tr>")
		col := 0
		for _, c := range row {
			span := max(c.span, 1)
			if c.vmerge == "continue" {
				col += span
				continue
			}
			attrs := ""
			if span > 1 {
				attrs += fmt.Sprintf(` colspan="%d"`, span)
			}
			if c.vmerge == "restart" {
				n := 1
				for _, below := range t.rows[r+1:] {
					if bc := cellAtCol(below, col); bc == nil || bc.vmerge != "continue" {
						break
					}
					n++
				}
				if n > 1 {
					attrs += fmt.Sprintf(` rowspan="%d"`, n)
				}
			}
			b.WriteString("<td" + attrs + ">" + c.html + "</td>")
			col += span
		}
		b.WriteString("</tr>")
	}
	b.WriteString("</table>")
	return b.String()
}

func cellAtCol(row []docxCell, col int) *docxCell {
	at := 0
	for i := range row {
		if at == col {
			return &row[i]
		}
		at += max(row[i].span, 1)
		if at > col {
			return nil
		}
	}
	return nil
}

var (
	fieldLink  = regexp.MustCompile(`(?i)^\s*HYPERLINK\s+"([^"]+)"`)
	preStyle   = regexp.MustCompile(`^(htmlpreformatted|code|codeblock|sourcecode|plaintext|macrotext)$`)
	linkPrefix = regexp.MustCompile(`(?i)^(https?://|mailto:)`)
	linkMarker = "\x00LINK\x00"
	// "1<tab>", "a)<tab>", "•<tab>" typed at the start of a paragraph (the tab is what makes it a list)
	runSize       = regexp.MustCompile(`<w:sz w:val="(\d+)"`)
	typedListMark = regexp.MustCompile(`^\t?\s*(\d{1,3}[.)]?|[a-z][.)]|[•◦▪‣·∙○■□➢➤✓\-–o§])\t`)
	typedListHTML = regexp.MustCompile(`^\s*(\d{1,3}[.)]?|[a-z][.)]|[•◦▪‣·∙○■□➢➤✓\-–o§])\s+`)
	webPictures   = map[string]bool{".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".bmp": true, ".webp": true, ".svg": true}
)

// oleKind names an embedded object by its program ("Excel.Sheet.12" → Excel sheet).
func oleKind(prog string) string {
	p := strings.ToLower(prog)
	for _, k := range [][2]string{{"excel", "Excel sheet"}, {"word", "Word document"}, {"powerpoint", "PowerPoint slides"}, {"visio", "Visio drawing"},
		{"acroexch", "PDF"}, {"package", "file"}, {"outlook", "Outlook item"}} {
		if strings.Contains(p, k[0]) {
			return k[1]
		}
	}
	if prog == "" {
		return "object"
	}
	return prog
}

// parseDocx turns document.xml into HTML paragraphs: headings, bold, italic,
// underline, strike, highlight, super/subscript, numbered and bulleted lists
// (nested), links (also Word's link fields), tables (merged cells, lists and
// tables inside cells), code blocks, text boxes and pictures. Colours and
// fonts are not kept (messages show text in the app's own style).
func parseDocx(doc []byte, rels map[string]docxRel, numbering docxNumbering, image func(string) string) (title, status, jira string, parts []docxPart, damaged error) {
	dec := xml.NewDecoder(bytes.NewReader(doc))
	// the usual text size: hand-made headings are bigger than that
	bodySz, sizes := 24, map[string]int{}
	for _, m := range runSize.FindAllSubmatch(doc, -1) {
		sizes[string(m[1])]++
	}
	most := 0
	for v, n := range sizes {
		if sz, err := strconv.Atoi(v); err == nil && (n > most || n == most && sz < bodySz) {
			bodySz, most = sz, n
		}
	}
	type paraState struct {
		para, run, plain                 strings.Builder
		style, numID                     string
		ilvl                             int
		numbered, runAllBold             bool
		runCount                         int
		indent                           int // left indent (twentieths of a point)
		runSz, minSz                     int // font size in half-points: this run, the smallest so far (-1: unknown)
		inRun                            bool
		b, i, u, st, mark, sup, sub, cde bool
	}
	type field struct {
		instr   strings.Builder
		linked  bool
		started bool
	}
	var (
		cur     = &paraState{runAllBold: true}
		saved   []*paraState // paragraphs a text box interrupted
		inT     bool
		inInstr bool
		links   []string // open hyperlink targets
		fields  []*field
		list    []docxListItem
		pre     []string
		tables  []*docxTable
		// an embedded object (equation, spreadsheet…): its picture is often a
		// WMF preview a browser can't show
		inObject        bool
		objProg, objImg string
	)
	webPicture := func(rid string) bool {
		r, ok := rels[rid]
		return ok && webPictures[strings.ToLower(path.Ext(r.Target))]
	}
	emit := func(h string) {
		if n := len(tables); n > 0 {
			tables[n-1].paras = append(tables[n-1].paras, h)
			return
		}
		parts = append(parts, docxPart{html: h})
	}
	flushPre := func() {
		if len(pre) > 0 {
			emit("<pre>" + strings.Join(pre, "\n") + "</pre>")
			pre = nil
		}
	}
	flushList := func() {
		flushPre()
		if len(list) > 0 {
			h := docxListHTML(list)
			list = nil
			emit(h)
		}
	}
	endRun := func() {
		c := cur
		t := c.run.String()
		c.run.Reset()
		if t == "" {
			return
		}
		c.runCount++
		c.runAllBold = c.runAllBold && c.b
		if c.runSz == 0 || c.minSz < 0 {
			c.minSz = -1
		} else if c.minSz == 0 || c.runSz < c.minSz {
			c.minSz = c.runSz
		}
		for _, w := range []struct {
			on  bool
			tag string
		}{{c.cde, "code"}, {c.sub, "sub"}, {c.sup, "sup"}, {c.st, "s"}, {c.u && len(links) == 0, "u"}, {c.i, "i"}, {c.mark, "mark"}, {c.b, "b"}} { // links are underlined anyway
			if w.on {
				t = "<" + w.tag + ">" + t + "</" + w.tag + ">"
			}
		}
		c.para.WriteString(t)
	}
	openLink := func(target string) {
		endRun()
		links = append(links, target)
		cur.para.WriteString(linkMarker)
	}
	closeLink := func() {
		endRun()
		n := len(links)
		if n == 0 {
			return
		}
		target := links[n-1]
		links = links[:n-1]
		full := cur.para.String()
		k := strings.LastIndex(full, linkMarker)
		if k < 0 {
			return
		}
		inner := full[k+len(linkMarker):]
		cur.para.Reset()
		cur.para.WriteString(full[:k])
		if linkPrefix.MatchString(target) && strings.TrimSpace(inner) != "" {
			cur.para.WriteString(`<a href="` + html.EscapeString(target) + `">` + inner + "</a>")
		} else {
			cur.para.WriteString(inner)
		}
	}
	for {
		tok, err := dec.Token()
		if err != nil {
			if err != io.EOF {
				damaged = err
			}
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			attr := func(local string) string {
				for _, a := range t.Attr {
					if a.Name.Local == local {
						return a.Value
					}
				}
				return ""
			}
			on := func() bool { v := attr("val"); return v == "" || (v != "0" && v != "false" && v != "none") }
			c := cur
			switch t.Name.Local {
			case "Fallback": // the older copy of a shape or text box: the Choice part has it already
				_ = dec.Skip()
			case "txbxContent": // a text box: its paragraphs come out on their own
				endRun()
				saved = append(saved, cur)
				cur = &paraState{runAllBold: true}
			case "p":
				c.para.Reset()
				c.plain.Reset()
				c.style, c.numID, c.ilvl, c.numbered, c.runAllBold, c.runCount, c.indent, c.minSz = "", "", 0, false, true, 0, 0, 0
			case "pStyle":
				c.style = strings.ToLower(attr("val"))
			case "numPr":
				c.numbered = true
			case "ilvl":
				if n, err := strconv.Atoi(attr("val")); err == nil {
					c.ilvl = n
				}
			case "numId":
				c.numID = attr("val")
			case "r":
				c.inRun, c.b, c.i, c.u, c.st, c.mark, c.sup, c.sub, c.cde, c.runSz = true, false, false, false, false, false, false, false, false, 0
			case "sz":
				if c.inRun {
					c.runSz, _ = strconv.Atoi(attr("val"))
				}
			case "ind":
				if !c.inRun {
					v := attr("left")
					if v == "" {
						v = attr("start")
					}
					c.indent, _ = strconv.Atoi(v)
				}
			case "rStyle":
				if c.inRun {
					st := strings.ToLower(attr("val"))
					c.b = c.b || strings.Contains(st, "strong")
					c.i = c.i || strings.Contains(st, "emphasis")
					c.cde = c.cde || strings.Contains(st, "code")
				}
			case "b":
				if c.inRun {
					c.b = on()
				}
			case "i":
				if c.inRun {
					c.i = on()
				}
			case "u":
				if c.inRun {
					c.u = on()
				}
			case "strike", "dstrike":
				if c.inRun {
					c.st = on()
				}
			case "highlight":
				if c.inRun {
					c.mark = on()
				}
			case "vertAlign":
				if c.inRun {
					c.sup, c.sub = attr("val") == "superscript", attr("val") == "subscript"
				}
			case "t":
				inT = true
			case "instrText":
				inInstr = true
			case "br", "cr":
				if attr("type") != "page" && attr("type") != "column" {
					c.run.WriteString("<br>")
				}
			case "tab":
				if c.inRun {
					c.run.WriteString(" ")
					c.plain.WriteString("\t")
				}
			case "noBreakHyphen":
				c.run.WriteString("-")
				c.plain.WriteString("-")
			case "hyperlink":
				target := ""
				if r, ok := rels[attr("id")]; ok && r.Mode == "External" {
					target = r.Target
				}
				openLink(target)
			case "fldSimple": // a field in one element, e.g. HYPERLINK "https://…"
				target := ""
				if m := fieldLink.FindStringSubmatch(attr("instr")); m != nil {
					target = m[1]
				}
				openLink(target)
			case "fldChar":
				switch attr("fldCharType") {
				case "begin":
					fields = append(fields, &field{})
				case "separate":
					if n := len(fields); n > 0 {
						f := fields[n-1]
						if m := fieldLink.FindStringSubmatch(f.instr.String()); m != nil {
							f.linked, f.started = true, true
							openLink(m[1])
						}
					}
				case "end":
					if n := len(fields); n > 0 {
						if fields[n-1].started {
							closeLink()
						}
						fields = fields[:n-1]
					}
				}
			case "blip":
				if img := image(attr("embed")); img != "" {
					c.run.WriteString(img)
				}
			case "object":
				inObject, objProg, objImg = true, "", ""
			case "OLEObject":
				objProg = attr("ProgID")
			case "imagedata":
				if inObject { // shown when the object ends, if a browser can show it
					if webPicture(attr("id")) {
						objImg = image(attr("id"))
					}
				} else if img := image(attr("id")); img != "" {
					c.run.WriteString(img)
				}
			case "tbl":
				flushList()
				tables = append(tables, &docxTable{})
			case "tr":
				if n := len(tables); n > 0 {
					tables[n-1].rows = append(tables[n-1].rows, nil)
				}
			case "tc":
				if n := len(tables); n > 0 {
					tables[n-1].paras, tables[n-1].span, tables[n-1].vm = nil, 1, ""
				}
			case "gridSpan":
				if n := len(tables); n > 0 {
					if v, err := strconv.Atoi(attr("val")); err == nil && v > 1 {
						tables[n-1].span = v
					}
				}
			case "vMerge":
				if n := len(tables); n > 0 {
					tables[n-1].vm = map[bool]string{true: "restart", false: "continue"}[attr("val") == "restart"]
				}
			}
		case xml.CharData:
			if inT {
				cur.run.WriteString(html.EscapeString(string(t)))
				cur.plain.WriteString(string(t))
			} else if inInstr && len(fields) > 0 {
				fields[len(fields)-1].instr.Write(t)
			}
		case xml.EndElement:
			c := cur
			switch t.Name.Local {
			case "t":
				inT = false
			case "instrText":
				inInstr = false
			case "r":
				endRun()
				c.inRun = false
			case "hyperlink", "fldSimple":
				closeLink()
			case "object":
				inObject = false
				switch {
				case objImg != "":
					c.run.WriteString(objImg)
				case strings.HasPrefix(objProg, "Equation"):
					c.run.WriteString("<i>[equation]</i>")
				default:
					c.run.WriteString("[embedded " + html.EscapeString(oleKind(objProg)) + " — open the Word document to see it]")
				}
			case "txbxContent":
				flushList()
				if n := len(saved); n > 0 {
					cur = saved[n-1]
					saved = saved[:n-1]
				}
			case "p":
				h := strings.TrimSpace(c.para.String())
				plain := strings.TrimSpace(c.plain.String())
				switch {
				case c.style == "title" && title == "" && len(tables) == 0 && len(saved) == 0:
					title = plain
					continue
				case c.style == "subtitle" && strings.HasPrefix(plain, "Status:") && len(tables) == 0:
					st := strings.TrimSpace(strings.SplitN(strings.TrimPrefix(plain, "Status:"), "·", 2)[0])
					status = map[string]string{"To do": "todo", "In progress": "doing", "Blocked": "blocked", "Done": "done"}[st]
					if k := strings.SplitN(plain, "Jira:", 2); len(k) == 2 {
						jira = jiraKeyOf(k[1])
					}
					continue
				}
				if m := docxPostHead.FindStringSubmatch(plain); m != nil && c.runAllBold && c.runCount > 0 && len(tables) == 0 {
					flushList()
					parts = append(parts, docxPart{head: m[3], pinned: m[1] != "", reply: m[2] != ""})
					continue
				}
				if preStyle.MatchString(c.style) { // code: kept as typed, lines together
					if len(list) > 0 {
						flushList()
					}
					pre = append(pre, html.EscapeString(strings.TrimRight(c.plain.String(), " \t")))
					continue
				}
				if h == "" {
					continue
				}
				heading := c.style == "title" || c.style == "subtitle" || strings.HasPrefix(c.style, "heading")
				isList := c.numbered && c.numID != "0" && !heading // a numbered heading stays a heading
				if m := typedListMark.FindStringSubmatch(c.plain.String()); m != nil && !isList && !heading {
					// numbers or bullets typed in front of the text, levels shown by indenting
					flushPre()
					first := m[1][0]
					list = append(list, docxListItem{lvl: max(0, c.indent/720-1), ordered: first >= '0' && first <= '9' || (len(m[1]) == 2 && first >= 'a'),
						html: strings.TrimSpace(typedListHTML.ReplaceAllString(h, ""))})
					continue
				}
				if isList || (!heading && listMark.MatchString(h)) || strings.HasPrefix(c.style, "listparagraph") || strings.HasPrefix(c.style, "listbullet") || strings.HasPrefix(c.style, "listnumber") {
					flushPre()
					ordered := strings.HasPrefix(c.style, "listnumber")
					if isList {
						ordered = numbering[c.numID][c.ilvl]
					} else if m := listMark.FindString(h); m != "" {
						ordered = m[0] >= '0' && m[0] <= '9'
					}
					list = append(list, docxListItem{lvl: c.ilvl, ordered: ordered, html: strings.TrimSpace(listMark.ReplaceAllString(h, ""))})
					continue
				}
				flushList()
				if c.style == "" && c.minSz >= 28 && c.minSz >= bodySz+4 && len(plain) <= 150 && !strings.Contains(h, "<img") {
					// a heading made by hand: large text (14 pt and up) on its own line
					inner := h
					if strings.Count(h, "<b>") == 1 && strings.HasPrefix(h, "<b>") && strings.HasSuffix(h, "</b>") {
						inner = h[3 : len(h)-4]
					}
					switch {
					case c.minSz >= 40:
						emit("<h1>" + inner + "</h1>")
					case c.minSz >= 32:
						emit("<h2>" + inner + "</h2>")
					default:
						emit("<h3>" + inner + "</h3>")
					}
					continue
				}
				switch {
				case c.style == "title" || c.style == "heading1":
					emit("<h1>" + h + "</h1>")
				case c.style == "heading2" || c.style == "subtitle":
					emit("<h2>" + h + "</h2>")
				case c.style == "heading3":
					emit("<h3>" + h + "</h3>")
				case strings.HasPrefix(c.style, "heading"):
					emit("<h4>" + h + "</h4>")
				case c.style == "quote" || c.style == "intensequote":
					emit("<blockquote>" + h + "</blockquote>")
				default:
					emit("<p>" + h + "</p>")
				}
			case "tc":
				flushList() // a list or code at the end of the cell stays in it
				if n := len(tables); n > 0 {
					tb := tables[n-1]
					if r := len(tb.rows); r > 0 {
						tb.rows[r-1] = append(tb.rows[r-1], docxCell{html: strings.Join(stripP(tb.paras), "<br>"), span: tb.span, vmerge: tb.vm})
					}
					tb.paras = nil
				}
			case "tbl":
				flushList()
				if n := len(tables); n > 0 {
					h := tables[n-1].html()
					tables = tables[:n-1]
					emit(h) // into the cell around it, for a table inside a table
				}
			case "body":
				flushList()
			}
		}
	}
	flushList()
	return
}

// stripP drops the <p> wrapper of paragraphs inside a table cell.
func stripP(ps []string) []string {
	out := make([]string, 0, len(ps))
	for _, p := range ps {
		out = append(out, strings.TrimSuffix(strings.TrimPrefix(p, "<p>"), "</p>"))
	}
	return out
}

// handleWorkImport: multipart .docx files → one thread each.
func (a *App) handleWorkImport(w http.ResponseWriter, r *http.Request) {
	mr, err := r.MultipartReader()
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	var made []WorkItem
	var problems []string
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			writeErr(w, 400, err)
			return
		}
		if part.FileName() == "" {
			continue
		}
		data, err := io.ReadAll(io.LimitReader(part, 100<<20))
		if err != nil {
			problems = append(problems, part.FileName()+": "+err.Error())
			continue
		}
		wi, err := a.store.ImportDocx(part.FileName(), data)
		if err != nil {
			problems = append(problems, err.Error())
			continue
		}
		_, _ = a.store.writeWorkDocx(wi.ID)
		made = append(made, wi)
	}
	writeJSON(w, map[string]any{"threads": made, "problems": problems})
}

// handleWorkDocxInto: multipart .docx files → one message each in the thread.
func (a *App) handleWorkDocxInto(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := r.ParseMultipartForm(64 << 20); err != nil {
		writeErr(w, 400, err)
		return
	}
	link := func(at Attachment) string {
		return fmt.Sprintf("http://%s/api/props/files/%s?download=1", a.addr, at.ID)
	}
	var posted []Post
	var problems []string
	for _, fh := range r.MultipartForm.File["file"] {
		f, err := fh.Open()
		if err != nil {
			problems = append(problems, fh.Filename+": "+err.Error())
			continue
		}
		data, err := io.ReadAll(io.LimitReader(f, maxAttachment+1))
		f.Close()
		if err != nil || len(data) > maxAttachment {
			problems = append(problems, fh.Filename+": too large (50 MB at most)")
			continue
		}
		p, err := a.store.ImportDocxInto(id, fh.Filename, data, link)
		if err != nil {
			problems = append(problems, err.Error())
			continue
		}
		posted = append(posted, p)
	}
	if len(posted) > 0 {
		a.store.MarkRead(id)
		_, _ = a.store.writeWorkDocx(id)
	}
	writeJSON(w, map[string]any{"posts": posted, "problems": problems})
}
