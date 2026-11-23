package main

// Screenshots on the clipboard (Win+Shift+S, PrtScn, Snipping Tool) arrive as
// a device-independent bitmap (CF_DIB); dibToPNG turns one into a PNG so it
// can be posted to the capture thread.

import (
	"bytes"
	"encoding/binary"
	"errors"
	"image"
	"image/color"
	"image/png"
	"strings"
)

func dibToPNG(b []byte) ([]byte, error) {
	if len(b) < 40 {
		return nil, errors.New("not a bitmap")
	}
	le := binary.LittleEndian
	hdr := int(le.Uint32(b[0:]))
	w, h := int(int32(le.Uint32(b[4:]))), int(int32(le.Uint32(b[8:])))
	bpp, comp := int(le.Uint16(b[14:])), le.Uint32(b[16:])
	topDown := h < 0
	if topDown {
		h = -h
	}
	if w <= 0 || h <= 0 || w > 20000 || h > 20000 || (bpp != 24 && bpp != 32) || (comp != 0 && comp != 3 && comp != 6) {
		return nil, errors.New("unsupported bitmap")
	}
	off := hdr
	if (comp == 3 || comp == 6) && hdr == 40 { // BI_BITFIELDS: three masks after a v1 header
		off += 12
	}
	off += int(le.Uint32(b[32:])) * 4 // colour table (rare for 24/32-bit)
	stride := (w*bpp/8 + 3) &^ 3
	if off+stride*h > len(b) {
		return nil, errors.New("bitmap is cut short")
	}
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	anyAlpha := false
	for y := 0; y < h; y++ {
		row := b[off+y*stride:]
		dy := h - 1 - y
		if topDown {
			dy = y
		}
		for x := 0; x < w; x++ {
			px := row[x*bpp/8:]
			c := color.NRGBA{px[2], px[1], px[0], 255}
			if bpp == 32 {
				c.A = px[3]
				anyAlpha = anyAlpha || px[3] != 0
			}
			img.SetNRGBA(x, dy, c)
		}
	}
	if bpp == 32 && !anyAlpha { // most 32-bit screenshots leave alpha at 0: opaque
		for i := 3; i < len(img.Pix); i += 4 {
			img.Pix[i] = 255
		}
	}
	var out bytes.Buffer
	if err := png.Encode(&out, img); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// appNames gives friendly names to the programs text is usually copied from.
var appNames = map[string]string{"outlook": "Outlook", "olk": "Outlook", "chrome": "Chrome", "msedge": "Edge", "firefox": "Firefox",
	"ms-teams": "Teams", "teams": "Teams", "winword": "Word", "excel": "Excel", "powerpnt": "PowerPoint", "onenote": "OneNote",
	"putty": "PuTTY", "filezilla": "FileZilla", "notepad++": "Notepad++", "notepad": "Notepad", "explorer": "Explorer",
	"code": "VS Code", "sqldeveloper64w": "SQL Developer", "sqldeveloper": "SQL Developer", "dbeaver": "DBeaver",
	"snippingtool": "Snipping Tool", "screensketch": "Snipping Tool", "slack": "Slack", "windowsterminal": "Terminal", "cmd": "Command Prompt", "powershell": "PowerShell"}

// sourceLabel: "Outlook — RE: Release plan" from the program file and window title.
func sourceLabel(exe, title string) string {
	base := strings.TrimSuffix(strings.ToLower(exe), ".exe")
	if i := strings.LastIndexAny(base, `\/`); i >= 0 {
		base = base[i+1:]
	}
	app := appNames[base]
	if app == "" && base != "" {
		app = strings.ToUpper(base[:1]) + base[1:]
	}
	title = strings.TrimSpace(title)
	for _, suffix := range []string{" - Outlook", " - Google Chrome", " - Microsoft Edge", " - Microsoft​ Edge", " | Microsoft Teams", " - Word", " - Excel", " - Mozilla Firefox"} {
		title = strings.TrimSuffix(title, suffix)
	}
	if len([]rune(title)) > 80 {
		title = string([]rune(title)[:80]) + "…"
	}
	switch {
	case app == "" || app == "Workhub-desktop" || app == "Workhub-web":
		return ""
	case title == "" || strings.EqualFold(title, app):
		return app
	default:
		return app + " — " + title
	}
}
