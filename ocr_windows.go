package main

// Reading text from a picture with the OCR built into Windows 10/11
// (Windows.Media.Ocr, in the languages of your Windows profile), through
// Windows PowerShell 5.1 — no extra software. The picture's path goes in an
// environment variable, never into the script text.

import (
	"encoding/base64"
	"errors"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"unicode/utf16"
)

const ocrSupported = true

const ocrScript = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation` + "`" + `1' })[0]
function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:WH_OCR_PATH)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) { throw 'no OCR language is installed in Windows' }
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$result.Lines | ForEach-Object { $_.Text }
`

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
	u := utf16.Encode([]rune(ocrScript))
	b := make([]byte, len(u)*2)
	for i, c := range u {
		b[2*i], b[2*i+1] = byte(c), byte(c>>8)
	}
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", base64.StdEncoding.EncodeToString(b))
	cmd.Env = append(os.Environ(), "WH_OCR_PATH="+f.Name())
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
	out, err := cmd.Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) && len(ee.Stderr) > 0 {
			return "", errors.New(strings.TrimSpace(string(ee.Stderr)))
		}
		return "", err
	}
	return strings.TrimSpace(strings.ReplaceAll(string(out), "\r\n", "\n")), nil
}
