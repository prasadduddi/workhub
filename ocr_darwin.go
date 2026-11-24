package main

// Reading text from a picture on a Mac with the Vision framework (macOS 10.15
// and later), through osascript's JavaScript bridge — no extra software. The
// picture's path goes in an environment variable, never into the script text.

import (
	"errors"
	"os"
	"os/exec"
	"strings"
)

const ocrSupported = true

const ocrScript = `ObjC.import('Vision'); ObjC.import('Foundation');
const path = $.NSProcessInfo.processInfo.environment.objectForKey('WH_OCR_PATH').js;
const req = $.VNRecognizeTextRequest.alloc.init;
req.recognitionLevel = 0; // accurate
req.usesLanguageCorrection = false; // host names and passwords are not words
const h = $.VNImageRequestHandler.alloc.initWithURLOptions($.NSURL.fileURLWithPath(path), $({}));
h.performRequestsError($([req]), null);
const out = [], res = req.results;
for (let i = 0; i < res.count; i++) out.push(res.objectAtIndex(i).topCandidates(1).objectAtIndex(0).string.js);
out.join('\n');`

func ocrImage(img []byte) (string, error) {
	f, err := os.CreateTemp("", "workhub-ocr-*.png")
	if err != nil {
		return "", err
	}
	defer os.Remove(f.Name())
	if _, err := f.Write(img); err != nil {
		f.Close()
		return "", err
	}
	f.Close()
	cmd := exec.Command("osascript", "-l", "JavaScript", "-e", ocrScript)
	cmd.Env = append(os.Environ(), "WH_OCR_PATH="+f.Name())
	out, err := cmd.Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) && len(ee.Stderr) > 0 {
			return "", errors.New(strings.TrimSpace(string(ee.Stderr)))
		}
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}
