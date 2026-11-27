package main

// 🔒 Certificate expiry (Monitor): the TLS certificate of every HTTPS check and
// of TCP checks on the usual TLS ports is read every 6 hours; the page shows the
// days left and a notification goes out 30, 14 and 3 days before it expires and
// when it has expired (once per certificate and step).

import (
	"crypto/tls"
	"net"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

var tlsPorts = map[string]bool{"443": true, "8443": true, "9443": true, "636": true, "993": true, "995": true, "465": true, "2484": true, "5986": true, "6443": true}

type certInfo struct {
	Expires time.Time `json:"cert_expires,omitzero"`
	Subject string    `json:"cert_subject,omitempty"`
	Issuer  string    `json:"cert_issuer,omitempty"`
	Err     string    `json:"cert_err,omitempty"`
	At      time.Time `json:"-"`
}

var certs = struct {
	sync.Mutex
	m    map[string]*certInfo // check id → certificate
	told map[string]bool      // check+expiry+step → notified
}{m: map[string]*certInfo{}, told: map[string]bool{}}

// tlsTarget: host:port to read a certificate from ("" = not a TLS check).
func tlsTarget(c MonitorCheck) string {
	if c.Kind == "http" {
		u, err := url.Parse(c.Target)
		if err != nil || u.Scheme != "https" {
			return ""
		}
		if u.Port() == "" {
			return net.JoinHostPort(u.Hostname(), "443")
		}
		return u.Host
	}
	if _, port, err := net.SplitHostPort(c.Target); err == nil && tlsPorts[port] {
		return c.Target
	}
	return ""
}

var readCert = func(target string) (*certInfo, error) {
	host, _, _ := net.SplitHostPort(target)
	conn, err := tls.DialWithDialer(&net.Dialer{Timeout: 6 * time.Second}, "tcp", target,
		&tls.Config{ServerName: host, InsecureSkipVerify: true}) // reading the date only: company CAs aren't trusted here
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	st := conn.ConnectionState()
	if len(st.PeerCertificates) == 0 {
		return &certInfo{Err: "no certificate"}, nil
	}
	c := st.PeerCertificates[0]
	return &certInfo{Expires: c.NotAfter, Subject: c.Subject.CommonName, Issuer: c.Issuer.CommonName}, nil
}

// checkCert reads a check's certificate when due (every 6 h) and notifies on the 30 / 14 / 3-day steps.
func (a *App) checkCert(c MonitorCheck) {
	target := tlsTarget(c)
	if target == "" {
		return
	}
	certs.Lock()
	ci := certs.m[c.ID]
	due := ci == nil || time.Since(ci.At) > 6*time.Hour
	certs.Unlock()
	if !due {
		return
	}
	ci, err := readCert(target)
	if err != nil {
		ci = &certInfo{Err: shortNetErr(err)}
	}
	ci.At = time.Now()
	certs.Lock()
	certs.m[c.ID] = ci
	certs.Unlock()
	if ci.Expires.IsZero() {
		return
	}
	days := int(time.Until(ci.Expires).Hours() / 24)
	step := ""
	switch {
	case time.Now().After(ci.Expires):
		step = "expired"
	case days <= 3:
		step = "3"
	case days <= 14:
		step = "14"
	case days <= 30:
		step = "30"
	}
	if step == "" {
		return
	}
	key := c.ID + ci.Expires.String() + step
	certs.Lock()
	seen := certs.told[key]
	certs.told[key] = true
	certs.Unlock()
	if seen {
		return
	}
	title := "🔒 Certificate expires in " + strconv.Itoa(days) + " day" + map[bool]string{true: "", false: "s"}[days == 1] + " — " + c.Name
	if step == "expired" {
		title = "⛔ Certificate EXPIRED — " + c.Name
	}
	a.notify("monitor", title, strings.TrimSpace(ci.Subject+" · until "+ci.Expires.Local().Format("2 Jan 2006")), "monitor", c.ID)
}

func certOf(id string) *certInfo {
	certs.Lock()
	defer certs.Unlock()
	if ci := certs.m[id]; ci != nil {
		c := *ci
		return &c
	}
	return nil
}
