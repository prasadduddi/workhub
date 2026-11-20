//go:build windows

package main

import (
	"errors"
	"fmt"
	"runtime"
	"strings"
	"time"

	ole "github.com/go-ole/go-ole"
	"github.com/go-ole/go-ole/oleutil"
)

const mailSupported = true

const olFolderInbox = 6

// fetchMail reads mail received after `since` from classic Outlook through its
// COM interface (no admin rights needed). Outlook must already be running.
func fetchMail(folder string, since time.Time) (out []mailItem, err error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if err := ole.CoInitializeEx(0, ole.COINIT_APARTMENTTHREADED); err != nil {
		if oe, ok := err.(*ole.OleError); !ok || oe.Code() != 1 { // S_FALSE: already initialised
			return nil, err
		}
	}
	defer ole.CoUninitialize()
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("Outlook error: %v", r)
		}
	}()

	unk, err := oleutil.GetActiveObject("Outlook.Application")
	if err != nil {
		return nil, errors.New("classic Outlook is not running (start Outlook; the new Outlook / Outlook on the web cannot be read by other programs)")
	}
	defer unk.Release()
	app, err := unk.QueryInterface(ole.IID_IDispatch)
	if err != nil {
		return nil, err
	}
	defer app.Release()

	ns := mustDisp(oleutil.CallMethod(app, "GetNamespace", "MAPI"))
	defer ns.Release()
	f := mustDisp(oleutil.CallMethod(ns, "GetDefaultFolder", olFolderInbox))
	if p := strings.Trim(strings.ReplaceAll(folder, `\`, "/"), "/"); p != "" && !strings.EqualFold(p, "inbox") {
		parts := strings.Split(p, "/")
		cur := f
		if strings.EqualFold(parts[0], "inbox") {
			parts = parts[1:]
		} else { // path from the mailbox root, e.g. "Vendors"
			cur = mustDisp(oleutil.GetProperty(f, "Parent"))
			f.Release()
		}
		for _, name := range parts {
			folders := mustDisp(oleutil.GetProperty(cur, "Folders"))
			next, err := oleutil.CallMethod(folders, "Item", name)
			folders.Release()
			if err != nil {
				cur.Release()
				return nil, fmt.Errorf("Outlook folder %q not found", name)
			}
			cur.Release()
			cur = next.ToIDispatch()
		}
		f = cur
	}
	defer f.Release()

	items := mustDisp(oleutil.GetProperty(f, "Items"))
	defer items.Release()
	_, _ = oleutil.CallMethod(items, "Sort", "[ReceivedTime]", true) // newest first
	v, err := oleutil.CallMethod(items, "GetFirst")
	for n := 0; err == nil && v != nil && v.VT == ole.VT_DISPATCH && n < 500; n++ {
		it := v.ToIDispatch()
		m, ok, stop := readItem(it, since)
		it.Release()
		if stop {
			break
		}
		if ok {
			out = append(out, m)
		}
		v, err = oleutil.CallMethod(items, "GetNext")
	}
	return out, nil
}

// readItem reads one mail. stop is true once mail is older than `since`.
func readItem(it *ole.IDispatch, since time.Time) (m mailItem, ok, stop bool) {
	if cls, err := oleutil.GetProperty(it, "Class"); err != nil || cls.Val != 43 { // 43 = olMail (skip meeting requests etc.)
		return m, false, false
	}
	if t, err := oleutil.GetProperty(it, "ReceivedTime"); err == nil {
		if tv, ok := t.Value().(time.Time); ok {
			m.Received = tv
		}
	}
	if !m.Received.After(since) {
		return m, false, true
	}
	m.ID = str(it, "EntryID")
	m.From = str(it, "SenderName")
	m.Subject = str(it, "Subject")
	m.Address = str(it, "SenderEmailAddress")
	if strings.EqualFold(str(it, "SenderEmailType"), "EX") { // Exchange user: get the SMTP address
		if s, err := oleutil.GetProperty(it, "Sender"); err == nil && s.VT == ole.VT_DISPATCH {
			sd := s.ToIDispatch()
			if u, err := oleutil.CallMethod(sd, "GetExchangeUser"); err == nil && u.VT == ole.VT_DISPATCH {
				ud := u.ToIDispatch()
				m.Address = orDefault(str(ud, "PrimarySmtpAddress"), m.Address)
				ud.Release()
			}
			sd.Release()
		}
	}
	m.Body = str(it, "Body")
	return m, true, false
}

func str(d *ole.IDispatch, prop string) string {
	v, err := oleutil.GetProperty(d, prop)
	if err != nil {
		return ""
	}
	defer v.Clear()
	if s, ok := v.Value().(string); ok {
		return s
	}
	return ""
}

func mustDisp(v *ole.VARIANT, err error) *ole.IDispatch {
	if err != nil {
		panic(err)
	}
	return v.ToIDispatch()
}
