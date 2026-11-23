package main

import (
	"bytes"
	"encoding/binary"
	"image/png"
	"testing"
)

// a 2×2 bitmap as Windows puts it on the clipboard (bottom row first)
func testDIB(bpp int, topDown bool) []byte {
	var b bytes.Buffer
	h := int32(2)
	if topDown {
		h = -2
	}
	stride := (2*bpp/8 + 3) &^ 3
	binary.Write(&b, binary.LittleEndian, struct {
		Size          uint32
		W, H          int32
		Planes, Bits  uint16
		Comp, ImgSize uint32
		XPM, YPM      int32
		Used, Imp     uint32
	}{40, 2, h, 1, uint16(bpp), 0, uint32(stride * 2), 0, 0, 0, 0})
	// rows: red, green (as stored); pixels are B,G,R(,A)
	for _, px := range [][]byte{{0, 0, 255}, {0, 255, 0}} {
		row := make([]byte, stride)
		for x := 0; x < 2; x++ {
			copy(row[x*bpp/8:], px)
		}
		b.Write(row)
	}
	return b.Bytes()
}

func TestDIBToPNG(t *testing.T) {
	for _, c := range []struct {
		bpp     int
		topDown bool
	}{{24, false}, {32, false}, {32, true}} {
		out, err := dibToPNG(testDIB(c.bpp, c.topDown))
		if err != nil {
			t.Fatal(err)
		}
		img, err := png.Decode(bytes.NewReader(out))
		if err != nil {
			t.Fatal(err)
		}
		top, bottom := img.At(0, 0), img.At(0, 1)
		r, g, _, a := top.RGBA()
		wantTopRed := !c.topDown // bottom-up: the first stored row (red) is the bottom one
		if (r > 0) == wantTopRed || a>>8 != 255 {
			t.Errorf("%d-bit topDown=%v: top=%v bottom=%v", c.bpp, c.topDown, top, bottom)
		}
		_ = g
	}
	if _, err := dibToPNG([]byte("short")); err == nil {
		t.Error("garbage accepted")
	}
}

func TestSourceLabel(t *testing.T) {
	for exe, want := range map[string]string{
		`C:\Program Files\Microsoft Office\root\Office16\OUTLOOK.EXE|RE: Release plan - Outlook`: "Outlook — RE: Release plan",
		`C:\Program Files\Google\Chrome\Application\chrome.exe|Jenkins - Google Chrome`:          "Chrome — Jenkins",
		`C:\Tools\putty.exe|PuTTY`: "PuTTY",
		`C:\Users\x\AppData\Local\Programs\WorkHub\WorkHub-Desktop.exe|WorkHub`: "",
	} {
		var e, title string
		for i := range exe {
			if exe[i] == '|' {
				e, title = exe[:i], exe[i+1:]
			}
		}
		if got := sourceLabel(e, title); got != want {
			t.Errorf("sourceLabel(%q, %q) = %q, want %q", e, title, got, want)
		}
	}
}
