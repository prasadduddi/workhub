package main

// Writes a work item as a Word document (.docx) from its HTML: headings,
// bold/italic/underline, lists, checkboxes, tables, hyperlinks and embedded
// screenshots. Plain Office Open XML, no external tools.

import (
	"archive/zip"
	"bytes"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"golang.org/x/net/html"
)

type docxWriter struct {
	body   *strings.Builder // swapped while a table cell is written
	rels   []string         // extra relationships (hyperlinks, images)
	media  map[string][]byte
	nextID int
	store  *Store
}

type runStyle struct{ b, i, u, s, code, link, mark, sup, sub bool }

func xmlEsc(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;").Replace(s)
}

func (d *docxWriter) rel(kind, target string, external bool) string {
	d.nextID++
	id := fmt.Sprintf("rId%d", 100+d.nextID)
	mode := ""
	if external {
		mode = ` TargetMode="External"`
	}
	d.rels = append(d.rels, fmt.Sprintf(`<Relationship Id="%s" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/%s" Target="%s"%s/>`, id, kind, xmlEsc(target), mode))
	return id
}

func (d *docxWriter) run(text string, st runStyle) string {
	if text == "" {
		return ""
	}
	var p strings.Builder
	if st.b {
		p.WriteString("<w:b/>")
	}
	if st.i {
		p.WriteString("<w:i/>")
	}
	if st.u || st.link {
		p.WriteString(`<w:u w:val="single"/>`)
	}
	if st.s {
		p.WriteString("<w:strike/>")
	}
	if st.link {
		p.WriteString(`<w:color w:val="0563C1"/>`)
	}
	if st.code {
		p.WriteString(`<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>`)
	}
	if st.mark {
		p.WriteString(`<w:highlight w:val="yellow"/>`)
	}
	if st.sup || st.sub {
		p.WriteString(`<w:vertAlign w:val="` + map[bool]string{true: "superscript", false: "subscript"}[st.sup] + `"/>`)
	}
	return fmt.Sprintf(`<w:r><w:rPr>%s</w:rPr><w:t xml:space="preserve">%s</w:t></w:r>`, p.String(), xmlEsc(text))
}

// image returns a run containing the picture, scaled to fit the page.
func (d *docxWriter) image(src string) string {
	m := regexp.MustCompile(`^/api/props/files/([0-9a-f]+)$`).FindStringSubmatch(src)
	if m == nil || d.store == nil {
		return ""
	}
	at, data, err := d.store.ReadAttachment(m[1])
	if err != nil {
		return ""
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return d.run("[image: "+at.Name+"]", runStyle{i: true})
	}
	name := fmt.Sprintf("image%d.%s", len(d.media)+1, map[string]string{"jpeg": "jpg"}[format]+map[bool]string{true: format}[format != "jpeg"])
	d.media[name] = data
	rid := d.rel("image", "media/"+name, false)
	const emuPerPx, maxW = 9525, 6 * 914400 // 6 inches wide at most
	w, h := int64(cfg.Width)*emuPerPx, int64(cfg.Height)*emuPerPx
	if w > maxW {
		h = h * maxW / w
		w = maxW
	}
	n := len(d.media)
	return fmt.Sprintf(`<w:r><w:drawing><wp:inline><wp:extent cx="%d" cy="%d"/><wp:docPr id="%d" name="Picture %d"/>`+
		`<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">`+
		`<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="%d" name="%s"/><pic:cNvPicPr/></pic:nvPicPr>`+
		`<pic:blipFill><a:blip r:embed="%s"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`+
		`<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="%d" cy="%d"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>`+
		`</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`, w, h, n, n, n, xmlEsc(at.Name), rid, w, h)
}

// inline renders the children of n as runs.
func (d *docxWriter) inline(n *html.Node, st runStyle) string {
	var out strings.Builder
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		switch c.Type {
		case html.TextNode:
			out.WriteString(d.run(strings.ReplaceAll(c.Data, " ", " "), st))
		case html.ElementNode:
			s := st
			switch c.Data {
			case "b", "strong":
				s.b = true
			case "i", "em":
				s.i = true
			case "u":
				s.u = true
			case "s", "strike":
				s.s = true
			case "code":
				s.code = true
			case "mark":
				s.mark = true
			case "sup":
				s.sup = true
			case "sub":
				s.sub = true
			case "ul", "ol", "table": // written as blocks of their own (lists in lists, tables in cells)
				continue
			case "br":
				out.WriteString("<w:r><w:br/></w:r>")
				continue
			case "img":
				out.WriteString(d.image(attr(c, "src")))
				continue
			case "input":
				box := "☐ "
				if hasAttr(c, "checked") {
					box = "☑ "
				}
				out.WriteString(d.run(box, st))
				continue
			case "a":
				href := attr(c, "href")
				if strings.HasPrefix(href, "http") || strings.HasPrefix(href, "mailto:") {
					s.link = true
					out.WriteString(fmt.Sprintf(`<w:hyperlink r:id="%s">%s</w:hyperlink>`, d.rel("hyperlink", href, true), d.inline(c, s)))
					continue
				}
			}
			out.WriteString(d.inline(c, s))
		}
	}
	return out.String()
}

func (d *docxWriter) para(style, runs string) {
	ppr := ""
	if style != "" {
		ppr = fmt.Sprintf(`<w:pPr><w:pStyle w:val="%s"/></w:pPr>`, style)
	}
	d.body.WriteString("<w:p>" + ppr + runs + "</w:p>")
}

var blockTags = map[string]bool{"p": true, "div": true, "h1": true, "h2": true, "h3": true, "h4": true, "ul": true, "ol": true, "table": true, "pre": true, "blockquote": true, "hr": true}

// blocks renders block-level content; loose inline content becomes paragraphs.
func (d *docxWriter) blocks(n *html.Node) {
	var pending []*html.Node
	flush := func() {
		isBr := func(c *html.Node) bool { return c.Type == html.ElementNode && c.Data == "br" }
		for len(pending) > 0 && isBr(pending[0]) { // a break next to a list or table: the paragraph already breaks
			n.RemoveChild(pending[0])
			pending = pending[1:]
		}
		for len(pending) > 0 && isBr(pending[len(pending)-1]) {
			n.RemoveChild(pending[len(pending)-1])
			pending = pending[:len(pending)-1]
		}
		if len(pending) == 0 {
			return
		}
		wrap := &html.Node{Type: html.ElementNode, Data: "p"}
		for _, c := range pending {
			n.RemoveChild(c)
			wrap.AppendChild(c)
		}
		pending = nil
		if runs := d.inline(wrap, runStyle{}); runs != "" {
			d.para("", runs)
		}
	}
	for c := n.FirstChild; c != nil; {
		next := c.NextSibling
		if c.Type == html.ElementNode && blockTags[c.Data] {
			flush()
			d.block(c)
		} else {
			pending = append(pending, c)
		}
		c = next
	}
	flush()
}

func (d *docxWriter) block(c *html.Node) {
	switch c.Data {
	case "h1", "h2", "h3", "h4":
		d.para("Heading"+c.Data[1:], d.inline(c, runStyle{}))
	case "ul", "ol":
		d.list(c, 0)
	case "pre":
		for _, line := range strings.Split(textOf(c), "\n") {
			d.para("Code", d.run(line, runStyle{code: true}))
		}
	case "blockquote":
		d.para("Quote", d.inline(c, runStyle{i: true}))
	case "hr":
		d.para("", `<w:r><w:t>────────────────────────────</w:t></w:r>`)
	case "table":
		d.table(c)
	default: // p, div
		hasBlock := false
		for k := c.FirstChild; k != nil; k = k.NextSibling {
			if k.Type == html.ElementNode && blockTags[k.Data] {
				hasBlock = true
			}
		}
		if hasBlock {
			d.blocks(c)
		} else {
			d.para("", d.inline(c, runStyle{}))
		}
	}
}

// list writes a list, its nested lists indented one level further.
func (d *docxWriter) list(c *html.Node, lvl int) {
	i := 0
	for li := c.FirstChild; li != nil; li = li.NextSibling {
		if li.Type != html.ElementNode || li.Data != "li" {
			continue
		}
		i++
		mark := "•\t"
		if c.Data == "ol" {
			mark = fmt.Sprintf("%d.\t", i)
		}
		left := 720 * (lvl + 1)
		d.body.WriteString(fmt.Sprintf(`<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:ind w:left="%d" w:hanging="360"/></w:pPr>%s</w:p>`, left, d.run(mark, runStyle{})+d.inline(li, runStyle{})))
		for k := li.FirstChild; k != nil; k = k.NextSibling {
			if k.Type == html.ElementNode && (k.Data == "ul" || k.Data == "ol") {
				d.list(k, lvl+1)
			}
		}
	}
}

func (d *docxWriter) table(t *html.Node) {
	var rows []*html.Node
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			if c.Type == html.ElementNode && c.Data == "tr" {
				rows = append(rows, c)
			} else if c.Type == html.ElementNode && c.Data != "table" { // a table in a cell is written inside that cell
				walk(c)
			}
		}
	}
	walk(t)
	span := func(c *html.Node, k string) int {
		n := 1
		fmt.Sscan(attr(c, k), &n)
		return min(max(n, 1), 63)
	}
	cont := func(cols int) string { // the lower part of a cell merged downwards
		gs := ""
		if cols > 1 {
			gs = fmt.Sprintf(`<w:gridSpan w:val="%d"/>`, cols)
		}
		return `<w:tc><w:tcPr>` + gs + `<w:vMerge/></w:tcPr><w:p/></w:tc>`
	}
	type merge struct{ rows, cols int }
	down := map[int]merge{} // column → rows still covered by a cell above
	d.body.WriteString(`<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr>`)
	for _, r := range rows {
		d.body.WriteString("<w:tr>")
		col := 0
		fill := func(upTo int) { // continuation cells for merges from above, up to a column
			for {
				m, ok := down[col]
				if !ok || (upTo >= 0 && col >= upTo) {
					return
				}
				d.body.WriteString(cont(m.cols))
				if m.rows--; m.rows <= 0 {
					delete(down, col)
				} else {
					down[col] = m
				}
				col += m.cols
			}
		}
		for c := r.FirstChild; c != nil; c = c.NextSibling {
			if c.Type != html.ElementNode || (c.Data != "td" && c.Data != "th") {
				continue
			}
			fill(-1)
			cols, rs := span(c, "colspan"), span(c, "rowspan")
			pr := `<w:tcW w:w="0" w:type="auto"/>`
			if cols > 1 {
				pr += fmt.Sprintf(`<w:gridSpan w:val="%d"/>`, cols)
			}
			if rs > 1 {
				pr += `<w:vMerge w:val="restart"/>`
				down[col] = merge{rs - 1, cols}
			}
			// the cell's own paragraphs, lists and tables
			outer := d.body
			d.body = &strings.Builder{}
			if c.Data == "th" {
				d.para("", d.inline(c, runStyle{b: true}))
			} else {
				d.blocks(c)
			}
			inner := d.body.String()
			d.body = outer
			if !strings.HasSuffix(inner, "</w:p>") && !strings.HasSuffix(inner, "<w:p/>") {
				inner += "<w:p/>" // a cell ends with a paragraph
			}
			d.body.WriteString(`<w:tc><w:tcPr>` + pr + `</w:tcPr>` + inner + `</w:tc>`)
			col += cols
		}
		for len(down) > 0 { // merges below the end of this row
			next := -1
			for k := range down {
				if k >= col && (next < 0 || k < next) {
					next = k
				}
			}
			if next < 0 {
				break
			}
			col = next
			fill(-1)
		}
		d.body.WriteString("</w:tr>")
	}
	d.body.WriteString("</w:tbl><w:p/>")
}

func attr(n *html.Node, k string) string {
	for _, a := range n.Attr {
		if a.Key == k {
			return a.Val
		}
	}
	return ""
}

func hasAttr(n *html.Node, k string) bool {
	for _, a := range n.Attr {
		if a.Key == k {
			return true
		}
	}
	return false
}

func textOf(n *html.Node) string {
	if n.Type == html.TextNode {
		return n.Data
	}
	var b strings.Builder
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if c.Type == html.ElementNode && c.Data == "br" {
			b.WriteString("\n")
		}
		b.WriteString(textOf(c))
	}
	return b.String()
}

// buildDocx turns a work item into .docx bytes.
func buildDocx(s *Store, w WorkItem) ([]byte, error) {
	d := &docxWriter{body: &strings.Builder{}, media: map[string][]byte{}, store: s}
	d.para("Title", d.run(w.Title, runStyle{}))
	meta := "Status: " + map[string]string{"todo": "To do", "doing": "In progress", "blocked": "Blocked", "done": "Done"}[w.Status]
	if len(w.Tags) > 0 {
		meta += "   ·   Tags: " + strings.Join(w.Tags, ", ")
	}
	if w.Jira != "" {
		meta += "   ·   Jira: " + w.Jira
	}
	meta += "   ·   Updated: " + w.Updated.Format("2006-01-02 15:04")
	d.para("Subtitle", d.run(meta, runStyle{}))
	root, err := html.Parse(strings.NewReader("<html><body>" + s.threadHTML(w) + "</body></html>"))
	if err != nil {
		return nil, err
	}
	var body *html.Node
	var find func(*html.Node)
	find = func(n *html.Node) {
		if n.Type == html.ElementNode && n.Data == "body" {
			body = n
			return
		}
		for c := n.FirstChild; c != nil && body == nil; c = c.NextSibling {
			find(c)
		}
	}
	find(root)
	if body != nil {
		d.blocks(body)
	}

	var buf bytes.Buffer
	z := zip.NewWriter(&buf)
	add := func(name, content string) {
		f, _ := z.Create(name)
		f.Write([]byte(content))
	}
	types := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
		`<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
		`<Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/>` +
		`<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
		`<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
		`<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`
	add("[Content_Types].xml", types)
	add("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`+
		`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>`+
		`<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`)
	add("docProps/core.xml", fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`+
		`<dc:title>%s</dc:title><dc:creator>WorkHub</dc:creator><dcterms:modified xsi:type="dcterms:W3CDTF">%s</dcterms:modified></cp:coreProperties>`, xmlEsc(w.Title), time.Now().UTC().Format(time.RFC3339)))
	add("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`+
		`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`+strings.Join(d.rels, "")+`</Relationships>`)
	add("word/styles.xml", docxStyles)
	add("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" `+
		`xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">`+
		`<w:body>`+d.body.String()+`<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`)
	for name, data := range d.media {
		f, _ := z.Create("word/media/" + name)
		f.Write(data)
	}
	if err := z.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

const docxStyles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
	`<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
	`<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>` +
	`<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="48"/><w:b/></w:rPr></w:style>` +
	`<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:rPr><w:color w:val="666666"/><w:sz w:val="20"/></w:rPr></w:style>` +
	`<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/><w:color w:val="2F5496"/></w:rPr></w:style>` +
	`<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="200"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/><w:color w:val="2F5496"/></w:rPr></w:style>` +
	`<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>` +
	`<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:i/></w:rPr></w:style>` +
	`<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs><w:spacing w:after="40"/><w:ind w:left="720" w:hanging="360"/></w:pPr></w:style>` +
	`<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="567"/></w:pPr><w:rPr><w:color w:val="555555"/></w:rPr></w:style>` +
	`<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/><w:shd w:val="clear" w:fill="F2F2F2"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="20"/></w:rPr></w:style>` +
	`<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr></w:style>` +
	`</w:styles>`

// ---- files under <data>/work-items ----

func (s *Store) workDocxDir() string { return filepath.Join(filepath.Dir(s.path), "work-items") }

var badFileChars = regexp.MustCompile(`[<>:"/\\|?*\x00-\x1f]+`)

func workDocxName(w WorkItem) string {
	t := strings.TrimSpace(badFileChars.ReplaceAllString(w.Title, " "))
	if len(t) > 80 {
		t = t[:80]
	}
	return fmt.Sprintf("%s (%s).docx", orDefault(t, "Work item"), w.ID[:6])
}

// writeWorkDocx (re)writes the .docx copy of a work item, removing the old
// file if the title changed.
func (s *Store) writeWorkDocx(id string) (string, error) {
	w, ok := s.GetWorkItem(id)
	if !ok {
		return "", fmt.Errorf("work item not found")
	}
	dir := s.workDocxDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	name := filepath.Join(dir, workDocxName(w))
	if old, _ := filepath.Glob(filepath.Join(dir, "* ("+w.ID[:6]+").docx")); len(old) > 0 {
		for _, o := range old {
			if o != name {
				_ = os.Remove(o)
			}
		}
	}
	b, err := buildDocx(s, w)
	if err != nil {
		return "", err
	}
	tmp := name + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, name); err != nil {
		// Word may have the file open (locked): keep the copy beside it.
		_ = os.Remove(tmp)
		return name, fmt.Errorf("close the document in Word to update it: %w", err)
	}
	return name, nil
}

func (s *Store) removeWorkDocx(id string) {
	if len(id) < 6 {
		return
	}
	old, _ := filepath.Glob(filepath.Join(s.workDocxDir(), "* ("+id[:6]+").docx"))
	for _, o := range old {
		_ = os.Remove(o)
	}
}
