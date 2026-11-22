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

func sendMail(to, subject, body string) error {
	return errors.New("sending the code needs classic Outlook on Windows — use the recovery code")
}

func outlookEvents(from, to time.Time) ([]OutlookEvent, error) {
	return nil, errors.New("Outlook meetings are shown on Windows with classic Outlook running")
}
