//go:build !windows && !darwin

package main

import "errors"

const ocrSupported = false

func ocrImage([]byte) (string, error) {
	return "", errors.New("reading text from pictures isn't available on this system")
}
