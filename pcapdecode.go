package main

// Reading a tcpdump capture (classic pcap) as it arrives, and a Wireshark-like
// one-line summary of each packet: from, to, protocol, info.

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
)

type pcapReader struct {
	r        io.Reader
	order    binary.ByteOrder
	nano     bool
	LinkType uint32
	Header   []byte // the 24-byte file header (written to the .pcap first)
}

func newPcapReader(r io.Reader) (*pcapReader, error) {
	h := make([]byte, 24)
	if _, err := io.ReadFull(r, h); err != nil {
		return nil, err
	}
	p := &pcapReader{r: r, Header: h}
	switch {
	case bytes.Equal(h[:4], []byte{0xd4, 0xc3, 0xb2, 0xa1}):
		p.order = binary.LittleEndian
	case bytes.Equal(h[:4], []byte{0xa1, 0xb2, 0xc3, 0xd4}):
		p.order = binary.BigEndian
	case bytes.Equal(h[:4], []byte{0x4d, 0x3c, 0xb2, 0xa1}):
		p.order, p.nano = binary.LittleEndian, true
	case bytes.Equal(h[:4], []byte{0xa1, 0xb2, 0x3c, 0x4d}):
		p.order, p.nano = binary.BigEndian, true
	default:
		return nil, errors.New("not a tcpdump capture (pcap) — the server sent something else")
	}
	p.LinkType = p.order.Uint32(h[20:24]) & 0x0fffffff
	return p, nil
}

type pcapRecord struct {
	Sec, Frac uint32 // Frac: µs (or ns)
	OrigLen   int
	Data      []byte
	Raw       []byte // record header + data, as in the file
}

func (p *pcapReader) Next() (*pcapRecord, error) {
	h := make([]byte, 16)
	if _, err := io.ReadFull(p.r, h); err != nil {
		return nil, err
	}
	incl := p.order.Uint32(h[8:12])
	if incl > 262144 {
		return nil, fmt.Errorf("broken capture (a packet of %d bytes)", incl)
	}
	data := make([]byte, incl)
	if _, err := io.ReadFull(p.r, data); err != nil {
		return nil, err
	}
	frac := p.order.Uint32(h[4:8])
	if p.nano {
		frac /= 1000
	}
	return &pcapRecord{Sec: p.order.Uint32(h[0:4]), Frac: frac, OrigLen: int(p.order.Uint32(h[12:16])), Data: data, Raw: append(h, data...)}, nil
}

var wellKnownPorts = map[int]string{20: "FTP-DATA", 21: "FTP", 22: "SSH", 23: "TELNET", 25: "SMTP", 53: "DNS", 67: "DHCP", 68: "DHCP", 80: "HTTP", 110: "POP3", 123: "NTP",
	143: "IMAP", 161: "SNMP", 389: "LDAP", 443: "TLS", 445: "SMB", 514: "SYSLOG", 587: "SMTP", 636: "LDAPS", 993: "IMAPS", 1433: "MSSQL", 1521: "TNS", 1522: "TNS",
	2049: "NFS", 3306: "MySQL", 3389: "RDP", 5432: "PGSQL", 5672: "AMQP", 6379: "Redis", 8080: "HTTP", 8443: "TLS", 9092: "Kafka", 27017: "MongoDB"}

// decodePacket: from, to, protocol and info for one packet of the given link type.
func decodePacket(link uint32, d []byte) (src, dst, proto, info string) {
	var etype uint16
	var p []byte
	switch link {
	case 1: // Ethernet
		if len(d) < 14 {
			return "", "", "?", "short frame"
		}
		etype, p = binary.BigEndian.Uint16(d[12:14]), d[14:]
		for etype == 0x8100 && len(p) >= 4 { // VLAN
			etype, p = binary.BigEndian.Uint16(p[2:4]), p[4:]
		}
	case 113: // Linux cooked (tcpdump -i any)
		if len(d) < 16 {
			return "", "", "?", "short frame"
		}
		etype, p = binary.BigEndian.Uint16(d[14:16]), d[16:]
	case 276: // Linux cooked v2
		if len(d) < 20 {
			return "", "", "?", "short frame"
		}
		etype, p = binary.BigEndian.Uint16(d[0:2]), d[20:]
	case 0, 12, 101, 228, 229: // loopback / raw IP
		p = d
		if link == 0 && len(p) >= 4 {
			p = p[4:]
		}
		if len(p) > 0 && p[0]>>4 == 6 {
			etype = 0x86dd
		} else {
			etype = 0x0800
		}
	default:
		return "", "", fmt.Sprintf("LINK-%d", link), fmt.Sprintf("%d bytes", len(d))
	}
	switch etype {
	case 0x0800:
		return decodeIPv4(p)
	case 0x86dd:
		return decodeIPv6(p)
	case 0x0806:
		if len(p) >= 28 {
			sha, spa, tpa := net.HardwareAddr(p[8:14]), net.IP(p[14:18]), net.IP(p[24:28])
			if binary.BigEndian.Uint16(p[6:8]) == 2 {
				return spa.String(), tpa.String(), "ARP", fmt.Sprintf("%s is at %s", spa, sha)
			}
			return spa.String(), tpa.String(), "ARP", fmt.Sprintf("Who has %s? Tell %s", tpa, spa)
		}
		return "", "", "ARP", "ARP"
	}
	return "", "", fmt.Sprintf("0x%04x", etype), fmt.Sprintf("%d bytes", len(p))
}

func decodeIPv4(p []byte) (src, dst, proto, info string) {
	if len(p) < 20 {
		return "", "", "IPv4", "short packet"
	}
	ihl := int(p[0]&0x0f) * 4
	if ihl < 20 || len(p) < ihl {
		return "", "", "IPv4", "bad header"
	}
	src, dst = net.IP(p[12:16]).String(), net.IP(p[16:20]).String()
	total := int(binary.BigEndian.Uint16(p[2:4]))
	body := p[ihl:]
	if total >= ihl && total-ihl < len(body) {
		body = body[:total-ihl]
	}
	pr, inf := decodeTransport(p[9], body, total-ihl)
	return src, dst, pr, inf
}

func decodeIPv6(p []byte) (src, dst, proto, info string) {
	if len(p) < 40 {
		return "", "", "IPv6", "short packet"
	}
	src, dst = net.IP(p[8:24]).String(), net.IP(p[24:40]).String()
	plen := int(binary.BigEndian.Uint16(p[4:6]))
	next, body := p[6], p[40:]
	for (next == 0 || next == 43 || next == 60) && len(body) >= 8 { // hop-by-hop, routing, destination options
		next, body = body[0], body[(int(body[1])+1)*8:]
	}
	pr, inf := decodeTransport(next, body, plen)
	return src, dst, pr, inf
}

func decodeTransport(ipProto byte, b []byte, length int) (proto, info string) {
	switch ipProto {
	case 6:
		if len(b) < 20 {
			return "TCP", "short segment"
		}
		sp, dp := int(binary.BigEndian.Uint16(b[0:2])), int(binary.BigEndian.Uint16(b[2:4]))
		seq, ack := binary.BigEndian.Uint32(b[4:8]), binary.BigEndian.Uint32(b[8:12])
		off := int(b[12]>>4) * 4
		fl := b[13]
		var flags []string
		for _, f := range []struct {
			bit  byte
			name string
		}{{0x02, "SYN"}, {0x10, "ACK"}, {0x08, "PSH"}, {0x01, "FIN"}, {0x04, "RST"}, {0x20, "URG"}} {
			if fl&f.bit != 0 {
				flags = append(flags, f.name)
			}
		}
		payload := []byte{}
		if off >= 20 && off <= len(b) {
			payload = b[off:]
		}
		plen := max(length-off, 0)
		proto = portName(sp, dp, "TCP")
		if l := httpLine(payload); l != "" {
			return "HTTP", l
		}
		info = fmt.Sprintf("%d → %d [%s] Seq=%d", sp, dp, strings.Join(flags, ", "), seq)
		if fl&0x10 != 0 {
			info += fmt.Sprintf(" Ack=%d", ack)
		}
		return proto, info + fmt.Sprintf(" Len=%d", plen)
	case 17:
		if len(b) < 8 {
			return "UDP", "short datagram"
		}
		sp, dp := int(binary.BigEndian.Uint16(b[0:2])), int(binary.BigEndian.Uint16(b[2:4]))
		ul := int(binary.BigEndian.Uint16(b[4:6]))
		if (sp == 53 || dp == 53) && len(b) > 20 {
			return "DNS", dnsInfo(b[8:])
		}
		return portName(sp, dp, "UDP"), fmt.Sprintf("%d → %d Len=%d", sp, dp, max(ul-8, 0))
	case 1:
		if len(b) < 2 {
			return "ICMP", ""
		}
		names := map[byte]string{0: "Echo (ping) reply", 3: "Destination unreachable", 8: "Echo (ping) request", 11: "Time exceeded", 5: "Redirect"}
		return "ICMP", orDefault(names[b[0]], fmt.Sprintf("type %d code %d", b[0], b[1]))
	case 58:
		if len(b) < 1 {
			return "ICMPv6", ""
		}
		names := map[byte]string{128: "Echo (ping) request", 129: "Echo (ping) reply", 135: "Neighbor Solicitation", 136: "Neighbor Advertisement", 133: "Router Solicitation", 134: "Router Advertisement"}
		return "ICMPv6", orDefault(names[b[0]], fmt.Sprintf("type %d", b[0]))
	}
	return fmt.Sprintf("IP-%d", ipProto), fmt.Sprintf("%d bytes", length)
}

func portName(sp, dp int, def string) string {
	if n, ok := wellKnownPorts[dp]; ok {
		return n
	}
	if n, ok := wellKnownPorts[sp]; ok {
		return n
	}
	return def
}

// httpLine: "GET /api/payments HTTP/1.1" or "HTTP/1.1 200 OK" when the payload starts an HTTP message.
func httpLine(p []byte) string {
	for _, m := range []string{"GET ", "POST ", "PUT ", "DELETE ", "HEAD ", "PATCH ", "OPTIONS ", "HTTP/1."} {
		if bytes.HasPrefix(p, []byte(m)) {
			line := p
			if i := bytes.Index(p, []byte("\r\n")); i > 0 {
				line = p[:i]
			}
			if len(line) > 120 {
				line = line[:120]
			}
			return strings.ToValidUTF8(string(line), "?")
		}
	}
	return ""
}

// dnsInfo: "Standard query A db.acme.local" / "Standard query response A …".
func dnsInfo(m []byte) string {
	if len(m) < 12 {
		return "DNS"
	}
	resp := m[2]&0x80 != 0
	var name []string
	i := 12
	for i < len(m) && m[i] != 0 && len(name) < 20 {
		l := int(m[i])
		if l&0xc0 != 0 || i+1+l > len(m) {
			break
		}
		name = append(name, string(m[i+1:i+1+l]))
		i += 1 + l
	}
	qt := ""
	if i+3 < len(m) {
		qt = map[uint16]string{1: "A", 28: "AAAA", 5: "CNAME", 15: "MX", 12: "PTR", 16: "TXT", 33: "SRV"}[binary.BigEndian.Uint16(m[i+1:i+3])]
	}
	kind := "Standard query"
	if resp {
		kind = "Standard query response"
	}
	return strings.TrimSpace(fmt.Sprintf("%s %s %s", kind, qt, strings.Join(name, ".")))
}
