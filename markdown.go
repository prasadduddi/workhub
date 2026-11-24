package main

// Markdown export of a task thread: saved beside its Word copy in
// <data>/work-items as "<title> (<id>).md", with screenshots and files in a
// "<title> (<id>) files" folder next to it, or returned as text for the
// clipboard (pasting into Jira, Confluence, Teams or Git).

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

var mdFileSrc = regexp.MustCompile(`^/api/props/files/([0-9a-f]+)`)

type mdWriter struct {
	store  *Store
	assets string            // folder name images are saved under ("" = clipboard: names only)
	files  map[string]string // attachment id → file name used
}

// file names an attachment for the export (unique, safe for Windows).
func (m *mdWriter) file(id string) string {
	if n, ok := m.files[id]; ok {
		return n
	}
	at, _, err := m.store.ReadAttachment(id)
	name := strings.TrimSpace(badFileChars.ReplaceAllString(at.Name, " "))
	if err != nil || name == "" {
		name = "file-" + id[:6]
	}
	base, ext := strings.TrimSuffix(name, filepath.Ext(name)), filepath.Ext(name)
	for i := 2; ; i++ {
		used := false
		for _, v := range m.files {
			used = used || strings.EqualFold(v, name)
		}
		if !used {
			break
		}
		name = fmt.Sprintf("%s-%d%s", base, i, ext)
	}
	m.files[id] = name
	return name
}

func (m *mdWriter) link(id string) string {
	n := m.file(id)
	if m.assets == "" {
		return n
	}
	return strings.ReplaceAll(m.assets+"/"+n, " ", "%20")
}

// fromHTML converts a post's (sanitised) HTML to Markdown.
func (m *mdWriter) fromHTML(src string) string {
	nodes, err := html.ParseFragment(strings.NewReader(src), &html.Node{Type: html.ElementNode, Data: "body", DataAtom: atom.Body})
	if err != nil {
		return src
	}
	var b strings.Builder
	for _, n := range nodes {
		m.block(&b, n, "")
	}
	out := regexp.MustCompile(`\n{3,}`).ReplaceAllString(b.String(), "\n\n")
	out = strings.NewReplacer("[x]  ", "[x] ", "[ ]  ", "[ ] ").Replace(out) // a checkbox followed by its text's own space
	return strings.TrimSpace(out)
}

func (m *mdWriter) block(b *strings.Builder, n *html.Node, indent string) {
	if n.Type == html.TextNode {
		if t := strings.TrimSpace(n.Data); t != "" {
			b.WriteString(indent + collapseSpace(n.Data) + "\n\n")
		}
		return
	}
	if n.Type != html.ElementNode {
		return
	}
	switch n.Data {
	case "p", "div":
		if t := strings.TrimSpace(m.inline(n)); t != "" {
			b.WriteString(indent + t + "\n\n")
		}
	case "h1", "h2", "h3", "h4":
		level := map[string]string{"h1": "###", "h2": "####", "h3": "#####", "h4": "######"}[n.Data] // under the post's heading
		b.WriteString(level + " " + strings.TrimSpace(m.inline(n)) + "\n\n")
	case "ul", "ol":
		i := 1
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			if c.Type != html.ElementNode || c.Data != "li" {
				continue
			}
			mark := "- "
			if n.Data == "ol" {
				mark = fmt.Sprintf("%d. ", i)
				i++
			}
			var text strings.Builder
			var nested []*html.Node
			for g := c.FirstChild; g != nil; g = g.NextSibling {
				if g.Type == html.ElementNode && (g.Data == "ul" || g.Data == "ol") {
					nested = append(nested, g)
				} else {
					text.WriteString(m.inlineNode(g))
				}
			}
			b.WriteString(indent + mark + strings.TrimSpace(text.String()) + "\n")
			for _, g := range nested {
				m.block(b, g, indent+"   ")
			}
		}
		b.WriteString("\n")
	case "pre":
		b.WriteString("```\n" + strings.TrimRight(mdText(n), "\n") + "\n```\n\n")
	case "blockquote":
		var inner strings.Builder
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			m.block(&inner, c, "")
		}
		for _, l := range strings.Split(strings.TrimSpace(inner.String()), "\n") {
			b.WriteString(indent + "> " + l + "\n")
		}
		b.WriteString("\n")
	case "hr":
		b.WriteString("---\n\n")
	case "table":
		m.table(b, n)
	case "img", "a", "b", "strong", "i", "em", "u", "s", "strike", "code", "span", "br", "input", "mark", "sub", "sup":
		if t := strings.TrimSpace(m.inlineNode(n)); t != "" {
			b.WriteString(indent + t + "\n\n")
		}
	default:
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			m.block(b, c, indent)
		}
	}
}

func (m *mdWriter) inline(n *html.Node) string {
	var b strings.Builder
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		b.WriteString(m.inlineNode(c))
	}
	return b.String()
}

func (m *mdWriter) inlineNode(n *html.Node) string {
	if n.Type == html.TextNode {
		return collapseSpace(n.Data)
	}
	if n.Type != html.ElementNode {
		return ""
	}
	attr := func(k string) string {
		for _, a := range n.Attr {
			if a.Key == k {
				return a.Val
			}
		}
		return ""
	}
	wrap := func(mark string) string {
		t := strings.TrimSpace(m.inline(n))
		if t == "" {
			return ""
		}
		return mark + t + mark
	}
	switch n.Data {
	case "b", "strong":
		return wrap("**")
	case "i", "em":
		return wrap("*")
	case "s", "strike":
		return wrap("~~")
	case "code":
		return "`" + mdText(n) + "`"
	case "br":
		return "  \n"
	case "a":
		t, h := strings.TrimSpace(m.inline(n)), attr("href")
		if sub := mdFileSrc.FindStringSubmatch(h); sub != nil { // an attached file
			return "[" + orDefault(t, m.file(sub[1])) + "](" + m.link(sub[1]) + ")"
		}
		if h == "" || t == h {
			return orDefault(h, t)
		}
		return "[" + t + "](" + h + ")"
	case "img":
		if sub := mdFileSrc.FindStringSubmatch(attr("src")); sub != nil {
			return "![" + orDefault(attr("alt"), "screenshot") + "](" + m.link(sub[1]) + ")"
		}
		return ""
	case "input":
		for _, a := range n.Attr {
			if a.Key == "checked" {
				return "[x] "
			}
		}
		return "[ ] "
	case "ul", "ol", "p", "div", "pre", "table", "blockquote":
		var b strings.Builder
		m.block(&b, n, "")
		return strings.TrimSpace(b.String())
	}
	return m.inline(n)
}

func (m *mdWriter) table(b *strings.Builder, n *html.Node) {
	var rows [][]string
	type carry struct{ rows, cols int }
	down := map[int]carry{} // column → rows still covered by a merged cell above
	pad := func(row []string, col *int) []string {
		for {
			c, ok := down[*col]
			if !ok {
				return row
			}
			for k := 0; k < c.cols; k++ {
				row = append(row, "")
			}
			if c.rows--; c.rows <= 0 {
				delete(down, *col)
			} else {
				down[*col] = c
			}
			*col += c.cols
		}
	}
	span := func(c *html.Node, k string) int {
		v := 1
		fmt.Sscan(attr(c, k), &v)
		return min(max(v, 1), 63)
	}
	var walk func(*html.Node)
	walk = func(x *html.Node) {
		if x.Type == html.ElementNode && x.Data == "tr" {
			var cells []string
			col := 0
			for c := x.FirstChild; c != nil; c = c.NextSibling {
				if c.Type == html.ElementNode && (c.Data == "td" || c.Data == "th") {
					cells = pad(cells, &col)
					cols, rs := span(c, "colspan"), span(c, "rowspan")
					cells = append(cells, m.cell(c))
					for k := 1; k < cols; k++ { // a merged cell: its other columns left empty
						cells = append(cells, "")
					}
					if rs > 1 {
						down[col] = carry{rs - 1, cols}
					}
					col += cols
				}
			}
			cells = pad(cells, &col)
			rows = append(rows, cells)
			return
		}
		for c := x.FirstChild; c != nil; c = c.NextSibling {
			if c.Type == html.ElementNode && c.Data == "table" { // a table in a cell is part of that cell
				continue
			}
			walk(c)
		}
	}
	walk(n)
	if len(rows) == 0 {
		return
	}
	cols := 0
	for _, r := range rows {
		cols = max(cols, len(r))
	}
	for i, r := range rows {
		for len(r) < cols {
			r = append(r, "")
		}
		b.WriteString("| " + strings.Join(r, " | ") + " |\n")
		if i == 0 {
			b.WriteString("|" + strings.Repeat(" --- |", cols) + "\n")
		}
	}
	b.WriteString("\n")
}

// cell renders a table cell on one line (Markdown tables can't break lines):
// lines, list items and the rows of a table inside it are joined with <br>.
func (m *mdWriter) cell(c *html.Node) string {
	var lines []string
	cur := ""
	esc := func(s string) string { return strings.ReplaceAll(s, "|", "\\|") }
	end := func() {
		if t := strings.TrimSpace(cur); t != "" {
			lines = append(lines, t)
		}
		cur = ""
	}
	var each func(*html.Node)
	each = func(n *html.Node) {
		for k := n.FirstChild; k != nil; k = k.NextSibling {
			switch {
			case k.Type == html.ElementNode && k.Data == "br":
				end()
			case k.Type == html.ElementNode && (k.Data == "ul" || k.Data == "ol"):
				end()
				i := 0
				for li := k.FirstChild; li != nil; li = li.NextSibling {
					if li.Type == html.ElementNode && li.Data == "li" {
						i++
						mark := "• "
						if k.Data == "ol" {
							mark = fmt.Sprintf("%d. ", i)
						}
						lines = append(lines, mark+esc(collapseSpace(strings.TrimSpace(mdText(li)))))
					}
				}
			case k.Type == html.ElementNode && k.Data == "table":
				end()
				var tr func(*html.Node)
				tr = func(x *html.Node) {
					for y := x.FirstChild; y != nil; y = y.NextSibling {
						if y.Type == html.ElementNode && y.Data == "tr" {
							var cs []string
							for td := y.FirstChild; td != nil; td = td.NextSibling {
								if td.Type == html.ElementNode && (td.Data == "td" || td.Data == "th") {
									cs = append(cs, esc(collapseSpace(strings.TrimSpace(mdText(td)))))
								}
							}
							lines = append(lines, strings.Join(cs, " / "))
						} else if y.Type == html.ElementNode {
							tr(y)
						}
					}
				}
				tr(k)
			case k.Type == html.ElementNode && (k.Data == "p" || k.Data == "div" || k.Data == "pre"):
				end()
				each(k)
				end()
			default:
				cur += esc(strings.ReplaceAll(m.inlineNode(k), "\n", " "))
			}
		}
	}
	each(c)
	end()
	return strings.Join(lines, "<br>")
}

func mdText(n *html.Node) string {
	if n.Type == html.TextNode {
		return n.Data
	}
	var b strings.Builder
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if c.Type == html.ElementNode && c.Data == "br" {
			b.WriteString("\n")
			continue
		}
		b.WriteString(mdText(c))
	}
	return b.String()
}

var spaceRun = regexp.MustCompile(`\s+`)

func collapseSpace(s string) string { return spaceRun.ReplaceAllString(s, " ") }

// threadMarkdown renders the thread: title and status, pinned posts, then
// the posts by day with replies quoted under their post. Saved passwords in
// captured text are dotted out.
func (s *Store) threadMarkdown(w WorkItem, assets string) (string, map[string]string) {
	m := &mdWriter{store: s, assets: assets, files: map[string]string{}}
	s.mu.RLock()
	var pws []string
	byID := map[string]Entry{}
	for _, e := range s.st.Entries {
		byID[e.ID] = *e
		if len(e.Password) >= 3 {
			pws = append(pws, e.Password)
		}
	}
	s.mu.RUnlock()
	mask := func(t string) string {
		for _, pw := range pws {
			t = strings.ReplaceAll(t, pw, "••••••••")
		}
		return t
	}
	body := func(p *Post) string {
		switch p.Kind {
		case "capture":
			return "*captured:*\n\n```\n" + strings.TrimRight(mask(p.Text), "\n") + "\n```"
		case "entry":
			e, ok := byID[p.Ref]
			if !ok {
				return "🖥 *(connection deleted)*"
			}
			t := "🖥 **" + e.Name + "** — " + strings.Trim(e.Username+" @ "+orDefault(e.Host, e.URL), " @")
			if e.Port != 0 {
				t += fmt.Sprintf(":%d", e.Port)
			}
			if e.Env != "" {
				t += " (" + e.Env + ")"
			}
			if p.HTML != "" {
				t += "\n\n" + m.fromHTML(p.HTML)
			}
			return t
		}
		return m.fromHTML(p.HTML)
	}
	status := map[string]string{"todo": "To do", "doing": "In progress", "blocked": "Blocked", "done": "Done"}[w.Status]
	var b strings.Builder
	b.WriteString("# " + w.Title + "\n\n")
	b.WriteString("Status: **" + orDefault(status, w.Status) + "** · Updated " + w.Updated.Local().Format("2 Jan 2006 15:04"))
	if len(w.Tags) > 0 {
		b.WriteString(" · Tags: " + strings.Join(w.Tags, ", "))
	}
	if w.Jira != "" {
		b.WriteString(" · Jira: " + w.Jira)
	}
	b.WriteString("\n\n")

	replies := map[string][]*Post{}
	for _, p := range w.Posts {
		if p.Parent != "" {
			replies[p.Parent] = append(replies[p.Parent], p)
		}
	}
	var pinned []string
	for _, p := range w.Posts {
		if p.Pinned {
			first := strings.SplitN(strings.TrimSpace(body(p)), "\n", 2)[0]
			pinned = append(pinned, "- "+strings.TrimSpace(strings.TrimLeft(first, "#> "))+" *("+p.At.Local().Format("2 Jan 15:04")+")*")
		}
	}
	if len(pinned) > 0 {
		b.WriteString("## 📌 Pinned\n\n" + strings.Join(pinned, "\n") + "\n\n")
	}
	day := ""
	for _, p := range w.Posts {
		if p.Parent != "" {
			continue
		}
		if d := p.At.Local().Format("Monday 2 January 2006"); d != day {
			day = d
			b.WriteString("## " + d + "\n\n")
		}
		pin := ""
		if p.Pinned {
			pin = " 📌"
		}
		b.WriteString("**" + p.At.Local().Format("15:04") + "**" + pin + "\n\n" + body(p) + "\n\n")
		for _, r := range replies[p.ID] {
			b.WriteString("> **↳ " + r.At.Local().Format("15:04") + "**\n>\n")
			for _, l := range strings.Split(body(r), "\n") {
				b.WriteString(strings.TrimRight("> "+l, " ") + "\n")
			}
			b.WriteString("\n")
		}
	}
	return b.String(), m.files
}

// handleWorkMarkdown: ?what=copy returns the text; otherwise the .md (and its
// files) is written beside the Word copy and its folder opened.
func (a *App) handleWorkMarkdown(w http.ResponseWriter, r *http.Request) {
	wi, ok := a.store.GetWorkItem(r.PathValue("id"))
	if !ok {
		writeErr(w, 404, errors.New("thread not found"))
		return
	}
	base := strings.TrimSuffix(workDocxName(wi), ".docx")
	if r.URL.Query().Get("what") == "copy" {
		md, _ := a.store.threadMarkdown(wi, "")
		writeJSON(w, map[string]string{"markdown": md})
		return
	}
	dir := a.store.workDocxDir()
	assets := base + " files"
	md, files := a.store.threadMarkdown(wi, assets)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		writeErr(w, 500, err)
		return
	}
	if old, _ := filepath.Glob(filepath.Join(dir, "* ("+wi.ID[:6]+").md")); len(old) > 0 { // renamed thread: drop the old copy
		for _, o := range old {
			if filepath.Base(o) != base+".md" {
				_ = os.Remove(o)
				_ = os.RemoveAll(strings.TrimSuffix(o, ".md") + " files")
			}
		}
	}
	if len(files) > 0 {
		_ = os.MkdirAll(filepath.Join(dir, assets), 0o700)
		for id, name := range files {
			if _, data, err := a.store.ReadAttachment(id); err == nil {
				_ = os.WriteFile(filepath.Join(dir, assets, name), data, 0o600)
			}
		}
	}
	path := filepath.Join(dir, base+".md")
	if err := os.WriteFile(path, []byte(md), 0o600); err != nil {
		writeErr(w, 500, err)
		return
	}
	if r.URL.Query().Get("open") != "0" {
		openPath(dir)
	}
	writeJSON(w, map[string]any{"path": path, "files": len(files)})
}
