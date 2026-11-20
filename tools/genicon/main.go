// genicon draws the WorkHub icon and writes:
//
//	rsrc_windows_amd64.syso  icon (resource ID 1) + version info, linked into
//	                         both Windows builds automatically by "go build"
//	static/icon.png          the same icon for the browser tab
//
// Run from the project root after changing the design:  go run ./tools/genicon
package main

import (
	"image"
	"image/color"
	"image/png"
	"log"
	"math"
	"os"

	"github.com/tc-hib/winres"
	"github.com/tc-hib/winres/version"
)

// draw renders the icon at size px with 4x supersampling: a blue rounded
// tile with a white "W", as in the app's sidebar.
func draw(size int) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, size, size))
	const ss = 4
	s := float64(size)
	r := 0.22 * s // corner radius
	w := [][2]float64{{0.20, 0.28}, {0.345, 0.74}, {0.50, 0.40}, {0.655, 0.74}, {0.80, 0.28}}
	stroke := 0.105 * s / 2
	segDist := func(px, py float64) float64 {
		best := math.MaxFloat64
		for i := 0; i < len(w)-1; i++ {
			ax, ay, bx, by := w[i][0]*s, w[i][1]*s, w[i+1][0]*s, w[i+1][1]*s
			dx, dy := bx-ax, by-ay
			t := math.Max(0, math.Min(1, ((px-ax)*dx+(py-ay)*dy)/(dx*dx+dy*dy)))
			best = math.Min(best, math.Hypot(px-(ax+t*dx), py-(ay+t*dy)))
		}
		return best
	}
	inTile := func(px, py float64) bool {
		cx := math.Max(r, math.Min(s-r, px))
		cy := math.Max(r, math.Min(s-r, py))
		return math.Hypot(px-cx, py-cy) <= r
	}
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			var tile, white float64
			for sy := 0; sy < ss; sy++ {
				for sx := 0; sx < ss; sx++ {
					px, py := float64(x)+(float64(sx)+0.5)/ss, float64(y)+(float64(sy)+0.5)/ss
					if inTile(px, py) {
						tile++
						if segDist(px, py) <= stroke {
							white++
						}
					}
				}
			}
			n := float64(ss * ss)
			if tile == 0 {
				continue
			}
			// Blue with a slight top-to-bottom gradient, white "W" on top.
			g := float64(y) / s
			br, bg, bb := 58-18*g, 125-30*g, 235-25*g
			f := white / tile
			img.SetNRGBA(x, y, color.NRGBA{
				R: uint8(br*(1-f) + 255*f), G: uint8(bg*(1-f) + 255*f), B: uint8(bb*(1-f) + 255*f),
				A: uint8(255 * tile / n),
			})
		}
	}
	return img
}

func main() {
	var imgs []image.Image
	for _, sz := range []int{16, 20, 24, 32, 40, 48, 64, 96, 128, 256} {
		imgs = append(imgs, draw(sz))
	}
	ico, err := winres.NewIconFromImages(imgs)
	if err != nil {
		log.Fatal(err)
	}
	rs := winres.ResourceSet{}
	// ID 1: Explorer uses the first icon for the .exe, and the desktop window
	// loads icon 1 for its title bar and taskbar button.
	if err := rs.SetIcon(winres.ID(1), ico); err != nil {
		log.Fatal(err)
	}
	vi := version.Info{}
	vi.SetFileVersion("1.0.0.0")
	vi.SetProductVersion("1.0.0.0")
	for k, v := range map[string]string{
		version.ProductName: "WorkHub", version.FileDescription: "WorkHub", version.InternalName: "WorkHub",
		version.OriginalFilename: "WorkHub", version.CompanyName: "WorkHub", version.LegalCopyright: "WorkHub",
	} {
		_ = vi.Set(0, k, v)
	}
	rs.SetVersionInfo(vi)
	out, err := os.Create("rsrc_windows_amd64.syso")
	if err != nil {
		log.Fatal(err)
	}
	if err := rs.WriteObject(out, winres.ArchAMD64); err != nil {
		log.Fatal(err)
	}
	out.Close()

	f, err := os.Create("static/icon.png")
	if err != nil {
		log.Fatal(err)
	}
	if err := png.Encode(f, draw(64)); err != nil {
		log.Fatal(err)
	}
	f.Close()
	log.Println("wrote rsrc_windows_amd64.syso and static/icon.png")
}
