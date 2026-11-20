//go:build !windows

package main

import (
	"errors"
	"time"
)

const mailSupported = false

func fetchMail(folder string, since time.Time) ([]mailItem, *mailItem, error) {
	return nil, nil, errors.New("Outlook monitoring works on Windows with classic Outlook")
}
