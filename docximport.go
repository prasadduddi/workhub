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

// ImportDocx creates a thread from a Word document.
func (s *Store) ImportDocx(name string, data []byte) (WorkItem, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return WorkItem{}, errors.New(name + ": not a Word document (.docx) — older .doc files must be saved as .docx in Word first")
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
		return WorkItem{}, errors.New(name + ": no document inside (is it a Word file?)")
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
	image := func(rid string) string {
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
		return fmt.Sprintf(`<img src="/api/props/files/%s" alt="%s">`, at.ID, html.EscapeString(at.Name))
	}

	title, status, parts := parseDocx(doc, rels, image)
	title = strings.TrimSpace(orDefault(title, orDefault(core.Title, strings.TrimSuffix(path.Base(strings.ReplaceAll(name, `\`, "/")), path.Ext(name)))))
	when := time.Now()
	if t, err := time.Parse(time.RFC3339, core.Modified); err == nil {
		when = t
	}

	w := s.SaveWorkItem(WorkItem{Title: title, Status: orDefault(status, "todo")})
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

// parseDocx turns document.xml into HTML paragraphs.
func parseDocx(doc []byte, rels map[string]docxRel, image func(string) string) (title, status string, parts []docxPart) {
	dec := xml.NewDecoder(bytes.NewReader(doc))
	var (
		para, run   strings.Builder
		style       string
		numbered    bool
		b, i, u, st bool
		inRun, inT  bool
		link        []string // open hyperlink targets
		list        strings.Builder
		table       []*strings.Builder // table HTML being built (nested tables)
		inCell      int
		cellParas   []string
		plainOfPara strings.Builder
		runAllBold  = true
		runCount    int
	)
	emit := func(h string) {
		if len(table) > 0 {
			cellParas = append(cellParas, h)
			return
		}
		parts = append(parts, docxPart{html: h})
	}
	flushList := func() {
		if list.Len() > 0 {
			emit("<ul>" + list.String() + "</ul>")
			list.Reset()
		}
	}
	endRun := func() {
		t := run.String()
		run.Reset()
		if t == "" {
			return
		}
		runCount++
		runAllBold = runAllBold && b
		if st {
			t = "<s>" + t + "</s>"
		}
		if u {
			t = "<u>" + t + "</u>"
		}
		if i {
			t = "<i>" + t + "</i>"
		}
		if b {
			t = "<b>" + t + "</b>"
		}
		para.WriteString(t)
	}
	for {
		tok, err := dec.Token()
		if err != nil {
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
			switch t.Name.Local {
			case "p":
				para.Reset()
				plainOfPara.Reset()
				style, numbered, runAllBold, runCount = "", false, true, 0
			case "pStyle":
				style = strings.ToLower(attr("val"))
			case "numPr":
				numbered = true
			case "r":
				inRun, b, i, u, st = true, false, false, false, false
			case "b":
				if inRun {
					b = on()
				}
			case "i":
				if inRun {
					i = on()
				}
			case "u":
				if inRun {
					u = on()
				}
			case "strike":
				if inRun {
					st = on()
				}
			case "t":
				inT = true
			case "br":
				if attr("type") != "page" {
					run.WriteString("<br>")
				}
			case "tab":
				if inRun {
					run.WriteString(" ")
				}
			case "hyperlink":
				endRun()
				target := ""
				if r, ok := rels[attr("id")]; ok && r.Mode == "External" {
					target = r.Target
				}
				link = append(link, target)
				para.WriteString("\x00LINK\x00")
			case "blip":
				if img := image(attr("embed")); img != "" {
					run.WriteString(img)
				}
			case "imagedata":
				if img := image(attr("id")); img != "" {
					run.WriteString(img)
				}
			case "tbl":
				flushList()
				table = append(table, &strings.Builder{})
				table[len(table)-1].WriteString("<table>")
			case "tr":
				if len(table) > 0 {
					table[len(table)-1].WriteString("<tr>")
				}
			case "tc":
				inCell++
				cellParas = nil
			}
		case xml.CharData:
			if inT {
				s := html.EscapeString(string(t))
				run.WriteString(s)
				plainOfPara.WriteString(string(t))
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "t":
				inT = false
			case "r":
				endRun()
				inRun = false
			case "hyperlink":
				endRun()
				if n := len(link); n > 0 {
					target := link[n-1]
					link = link[:n-1]
					full := para.String()
					k := strings.LastIndex(full, "\x00LINK\x00")
					if k >= 0 {
						inner := full[k+len("\x00LINK\x00"):]
						para.Reset()
						para.WriteString(full[:k])
						if strings.HasPrefix(target, "http://") || strings.HasPrefix(target, "https://") || strings.HasPrefix(target, "mailto:") {
							para.WriteString(`<a href="` + html.EscapeString(target) + `">` + inner + "</a>")
						} else {
							para.WriteString(inner)
						}
					}
				}
			case "p":
				h := strings.TrimSpace(para.String())
				plain := strings.TrimSpace(plainOfPara.String())
				switch {
				case style == "title" && title == "" && len(table) == 0:
					title = plain
					continue
				case style == "subtitle" && strings.HasPrefix(plain, "Status:") && len(table) == 0:
					st := strings.TrimSpace(strings.SplitN(strings.TrimPrefix(plain, "Status:"), "·", 2)[0])
					status = map[string]string{"To do": "todo", "In progress": "doing", "Blocked": "blocked", "Done": "done"}[st]
					continue
				}
				if m := docxPostHead.FindStringSubmatch(plain); m != nil && runAllBold && runCount > 0 && len(table) == 0 {
					flushList()
					parts = append(parts, docxPart{head: m[3], pinned: m[1] != "", reply: m[2] != ""})
					continue
				}
				if h == "" {
					continue
				}
				if numbered || listMark.MatchString(h) || strings.HasPrefix(style, "listparagraph") || strings.HasPrefix(style, "listbullet") || strings.HasPrefix(style, "listnumber") {
					list.WriteString("<li>" + strings.TrimSpace(listMark.ReplaceAllString(h, "")) + "</li>")
					continue
				}
				flushList()
				switch {
				case style == "title" || style == "heading1":
					emit("<h1>" + h + "</h1>")
				case style == "heading2" || style == "subtitle":
					emit("<h2>" + h + "</h2>")
				case strings.HasPrefix(style, "heading"):
					emit("<h3>" + h + "</h3>")
				default:
					emit("<p>" + h + "</p>")
				}
			case "tc":
				inCell--
				if len(table) > 0 {
					table[len(table)-1].WriteString("<td>" + strings.Join(stripP(cellParas), "<br>") + "</td>")
				}
				cellParas = nil
			case "tr":
				if len(table) > 0 {
					table[len(table)-1].WriteString("</tr>")
				}
			case "tbl":
				if n := len(table); n > 0 {
					h := table[n-1].String() + "</table>"
					table = table[:n-1]
					emit(h)
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
