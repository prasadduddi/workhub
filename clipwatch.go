package main

// Clipboard watcher. It must never get in the way of copy and paste in
// Windows: it only reads, waits until the program copying has finished
// (the clipboard sequence number stays the same for a moment), holds the
// clipboard open just long enough to copy the bytes out, and when another
// program has it open it simply tries again on the next tick.

import (
	"crypto/sha256"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	clipTick   = 400 * time.Millisecond
	clipSettle = 500 * time.Millisecond // the copying program has finished by then
	clipTries  = 5                      // busy this many times in a row: give up on that copy
	shotPair   = 12 * time.Second       // a snip arrives as a clipboard picture and a saved file
)

// Programs whose copies are screenshots even if they also put text on the clipboard.
var shotTools = map[string]bool{"snippingtool": true, "screensketch": true, "screenclippinghost": true,
	"sharex": true, "greenshot": true, "lightshot": true, "snagit32": true, "snagiteditor": true}

func isShotTool(exe string) bool {
	base := strings.TrimSuffix(strings.ToLower(filepath.Base(strings.ReplaceAll(exe, `\`, "/"))), ".exe")
	return shotTools[base]
}

// shotLog pairs the two copies of one snip (clipboard picture, saved file) so
// it is posted once.
type shotLog struct {
	mu         sync.Mutex
	clip, file time.Time // last posted from each
	lastSum    [32]byte
	clipPaired bool
	filePaired bool
}

// seen reports whether the other copy of this snip was already posted.
func (l *shotLog) seen(fromFile bool, at time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if fromFile {
		if !l.clipPaired && !l.clip.IsZero() && absDur(at.Sub(l.clip)) < shotPair {
			l.clipPaired = true
			return true
		}
		l.file, l.filePaired = at, false
		return false
	}
	if !l.filePaired && !l.file.IsZero() && absDur(at.Sub(l.file)) < shotPair {
		l.filePaired = true
		return true
	}
	l.clip, l.clipPaired = at, false
	return false
}

func absDur(d time.Duration) time.Duration {
	if d < 0 {
		return -d
	}
	return d
}

func (a *App) postShot(png []byte, from string, fromFile bool, at time.Time) {
	sum := sha256.Sum256(png)
	a.shots.mu.Lock()
	dup := sum == a.shots.lastSum
	a.shots.lastSum = sum
	a.shots.mu.Unlock()
	if dup || a.shots.seen(fromFile, at) {
		return
	}
	if _, err := a.store.CaptureImage(png, from); err != nil {
		log.Println("screenshot:", err)
	}
}

func (a *App) watchClipboard() {
	last, _ := readClipboard() // whatever was copied before launch isn't captured
	seen := clipboardSeq()
	var pending uint32
	var changedAt time.Time
	tries, ticks := 0, 0
	paused := false
	for range time.Tick(clipTick) {
		if !a.store.Settings().Watch { // paused: the clipboard isn't touched at all
			paused = true
			continue
		}
		if paused { // resumed: what was copied while paused is left alone
			paused, pending = false, 0
			seen = clipboardSeq()
			last, _ = readClipboard()
			continue
		}
		seq := clipboardSeq()
		if seq == 0 { // no sequence number (not Windows): look every 3rd tick
			if ticks++; ticks%3 == 0 {
				a.captureClipboard(&last)
			}
			continue
		}
		if seq == seen {
			continue
		}
		if seq != pending {
			pending, changedAt, tries = seq, time.Now(), 0
			continue
		}
		if time.Since(changedAt) < clipSettle {
			continue
		}
		tries++
		if a.captureClipboard(&last) || tries >= clipTries {
			seen = seq
		}
	}
}

// captureClipboard handles one clipboard change; false = the clipboard was
// busy, try again later.
func (a *App) captureClipboard(last *string) bool {
	if clipExcluded() { // password managers ask monitors to leave their copies alone
		return true
	}
	owner := clipboardOwnerExe()
	from := foregroundSource()
	if isShotTool(owner) {
		from = sourceLabel(owner, "")
	}
	// A picture: a screenshot, unless text came with it from an ordinary
	// program (copied Excel cells also carry a picture).
	if clipHasImage() && (!clipHasText() || isShotTool(owner)) {
		if a.store.Settings().NoShots {
			return true
		}
		data, isPNG, busy := grabClipboardImage()
		if busy {
			return false
		}
		if data == nil {
			return true
		}
		png := data
		if !isPNG {
			var err error
			if png, err = dibToPNG(data); err != nil {
				log.Println("screenshot:", err)
				return true
			}
		}
		if len(png) < maxAttachment {
			a.postShot(png, from, false, time.Now())
		}
		return true
	}
	txt, err := readClipboard()
	if err != nil {
		return err.Error() != "clipboard busy"
	}
	if txt == *last {
		return true
	}
	*last = txt
	t := strings.TrimSpace(txt)
	if t == "" || len(t) > 50000 || a.store.IsKnownValue(t) {
		return true
	}
	a.store.IngestFrom(txt, "clipboard", from, "")
	return true
}

// screenshotDirs: where Snipping Tool saves snips (Pictures\Screenshots, also
// under OneDrive when Pictures is backed up there).
func screenshotDirs() []string {
	var out []string
	for _, base := range []string{os.Getenv("USERPROFILE"), os.Getenv("OneDrive"), os.Getenv("OneDriveCommercial"), os.Getenv("OneDriveConsumer")} {
		if base == "" {
			continue
		}
		d := filepath.Join(base, "Pictures", "Screenshots")
		if st, err := os.Stat(d); err == nil && st.IsDir() {
			out = append(out, d)
		}
	}
	return out
}

// watchScreenshots posts snips that Snipping Tool saved but that never
// reached the clipboard (or that the clipboard watcher couldn't read). A snip
// that came through the clipboard as well is posted only once.
func (a *App) watchScreenshots() {
	start := time.Now()
	known := map[string]int64{} // path → size when first seen
	done := map[string]bool{}
	for range time.Tick(2 * time.Second) {
		if s := a.store.Settings(); !s.Watch || s.NoShots {
			continue
		}
		for _, d := range screenshotDirs() {
			ents, _ := os.ReadDir(d)
			for _, e := range ents {
				name := strings.ToLower(e.Name())
				if e.IsDir() || !(strings.HasSuffix(name, ".png")) {
					continue
				}
				p := filepath.Join(d, e.Name())
				info, err := e.Info()
				if err != nil || done[p] || info.ModTime().Before(start) {
					continue
				}
				// Wait for the file to be complete (same size twice) and give the
				// clipboard copy of the same snip time to arrive first.
				if size, ok := known[p]; !ok || size != info.Size() || time.Since(info.ModTime()) < 3*time.Second {
					known[p] = info.Size()
					continue
				}
				done[p] = true
				b, err := os.ReadFile(p)
				if err != nil || len(b) == 0 || len(b) >= maxAttachment {
					continue
				}
				a.postShot(b, "Snipping Tool", true, info.ModTime())
			}
		}
	}
}
