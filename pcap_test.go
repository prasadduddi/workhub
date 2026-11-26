package main

import (
	"bytes"
	"encoding/binary"
	"io"
	"net"
	"strings"
	"testing"
)

// test packets

func ipv4(proto byte, src, dst string, body []byte) []byte {
	h := make([]byte, 20)
	h[0], h[9] = 0x45, proto
	binary.BigEndian.PutUint16(h[2:4], uint16(20+len(body)))
	copy(h[12:16], net.ParseIP(src).To4())
	copy(h[16:20], net.ParseIP(dst).To4())
	return append(h, body...)
}

func tcp(sp, dp int, flags byte, payload string) []byte {
	h := make([]byte, 20)
	binary.BigEndian.PutUint16(h[0:2], uint16(sp))
	binary.BigEndian.PutUint16(h[2:4], uint16(dp))
	binary.BigEndian.PutUint32(h[4:8], 1000)
	binary.BigEndian.PutUint32(h[8:12], 2000)
	h[12], h[13] = 5<<4, flags
	return append(h, payload...)
}

func udp(sp, dp int, payload []byte) []byte {
	h := make([]byte, 8)
	binary.BigEndian.PutUint16(h[0:2], uint16(sp))
	binary.BigEndian.PutUint16(h[2:4], uint16(dp))
	binary.BigEndian.PutUint16(h[4:6], uint16(8+len(payload)))
	return append(h, payload...)
}

func eth(etype uint16, p []byte) []byte {
	h := make([]byte, 14)
	binary.BigEndian.PutUint16(h[12:14], etype)
	return append(h, p...)
}

func dnsQuery(name string) []byte {
	m := make([]byte, 12)
	binary.BigEndian.PutUint16(m[4:6], 1)
	for _, l := range strings.Split(name, ".") {
		m = append(m, byte(len(l)))
		m = append(m, l...)
	}
	return append(m, 0, 0, 1, 0, 1)
}

func pcapFile(link uint32, pkts ...[]byte) []byte {
	var b bytes.Buffer
	h := make([]byte, 24)
	copy(h, []byte{0xd4, 0xc3, 0xb2, 0xa1})
	binary.LittleEndian.PutUint16(h[4:6], 2)
	binary.LittleEndian.PutUint16(h[6:8], 4)
	binary.LittleEndian.PutUint32(h[16:20], 65535)
	binary.LittleEndian.PutUint32(h[20:24], link)
	b.Write(h)
	for i, p := range pkts {
		r := make([]byte, 16)
		binary.LittleEndian.PutUint32(r[0:4], 1700000000+uint32(i))
		binary.LittleEndian.PutUint32(r[4:8], 250000)
		binary.LittleEndian.PutUint32(r[8:12], uint32(len(p)))
		binary.LittleEndian.PutUint32(r[12:16], uint32(len(p)))
		b.Write(r)
		b.Write(p)
	}
	return b.Bytes()
}

func TestPcapDecode(t *testing.T) {
	icmp := []byte{8, 0, 0, 0, 0, 1, 0, 1}
	arp := make([]byte, 28)
	binary.BigEndian.PutUint16(arp[6:8], 1)
	copy(arp[14:18], net.ParseIP("10.0.0.21").To4())
	copy(arp[24:28], net.ParseIP("10.0.0.1").To4())
	v6 := make([]byte, 40)
	v6[0], v6[6] = 0x60, 58
	binary.BigEndian.PutUint16(v6[4:6], 8)
	copy(v6[8:24], net.ParseIP("fe80::1"))
	copy(v6[24:40], net.ParseIP("fe80::2"))
	v6 = append(v6, 128, 0, 0, 0, 0, 0, 0, 0)

	file := pcapFile(1,
		eth(0x0800, ipv4(6, "10.0.0.21", "10.0.0.31", tcp(52344, 1521, 0x18, "\x00\x3a\x00\x00\x01"))),
		eth(0x0800, ipv4(6, "10.0.0.15", "10.0.0.21", tcp(51000, 8080, 0x18, "GET /api/payments/4711 HTTP/1.1\r\nHost: x\r\n\r\n"))),
		eth(0x0800, ipv4(17, "10.0.0.21", "10.0.0.2", udp(40000, 53, dnsQuery("db.acme.local")))),
		eth(0x0800, ipv4(1, "10.0.0.21", "10.0.0.31", icmp)),
		eth(0x0806, arp),
		eth(0x86dd, v6),
		eth(0x0800, ipv4(6, "10.0.0.31", "10.0.0.21", tcp(1521, 52344, 0x12, ""))),
	)
	pr, err := newPcapReader(bytes.NewReader(file))
	if err != nil || pr.LinkType != 1 {
		t.Fatalf("header: %v %d", err, pr.LinkType)
	}
	var got []string
	for {
		rec, err := pr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		src, dst, proto, info := decodePacket(pr.LinkType, rec.Data)
		got = append(got, strings.Join([]string{src, dst, proto, info}, " | "))
	}
	want := []string{
		"10.0.0.21 | 10.0.0.31 | TNS | 52344 → 1521 [ACK, PSH] Seq=1000 Ack=2000 Len=5",
		"10.0.0.15 | 10.0.0.21 | HTTP | GET /api/payments/4711 HTTP/1.1",
		"10.0.0.21 | 10.0.0.2 | DNS | Standard query A db.acme.local",
		"10.0.0.21 | 10.0.0.31 | ICMP | Echo (ping) request",
		"10.0.0.21 | 10.0.0.1 | ARP | Who has 10.0.0.1? Tell 10.0.0.21",
		"fe80::1 | fe80::2 | ICMPv6 | Echo (ping) request",
		"10.0.0.31 | 10.0.0.21 | TNS | 1521 → 52344 [SYN, ACK] Seq=1000 Ack=2000 Len=0",
	}
	if len(got) != len(want) {
		t.Fatalf("got %d packets: %v", len(got), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("packet %d:\n got  %s\n want %s", i+1, got[i], want[i])
		}
	}
	// tcpdump -i any (Linux cooked v2)
	sll2 := make([]byte, 20)
	binary.BigEndian.PutUint16(sll2[0:2], 0x0800)
	if _, _, proto, _ := decodePacket(276, append(sll2, ipv4(6, "10.0.0.1", "10.0.0.2", tcp(1, 5432, 0x02, ""))...)); proto != "PGSQL" {
		t.Fatalf("cooked v2: %s", proto)
	}
	if _, err := newPcapReader(strings.NewReader("sudo: a password is required\n.........")); err == nil {
		t.Fatal("text output must not pass as a capture")
	}
}

func TestCaptureCommand(t *testing.T) {
	c, pw := captureCommand("deploy", "any", "port 1521", true, 22, 65535, true, true)
	if !pw || !strings.Contains(c, `exec sudo -S -p '' "$T" -i 'any' -U -n -s 65535 -w - '(port 1521) and not port 22'`) {
		t.Fatalf("sudo with password: %s", c)
	}
	if c, pw = captureCommand("deploy", "eth0", "", false, 22, 65535, true, false); pw || !strings.Contains(c, `exec sudo -n "$T" -i 'eth0'`) || strings.Contains(c, "not port") {
		t.Fatalf("sudo -n: %s", c)
	}
	if c, _ = captureCommand("root", "any", "host 10.0.0.31", true, 2222, 65535, true, true); strings.Contains(c, "sudo") || !strings.Contains(c, "not port 2222") {
		t.Fatalf("root: %s", c)
	}
	if c, _ = captureCommand("u", "any", "host x and port 80", false, 22, 65535, false, true); strings.Contains(c, "sudo") || !strings.Contains(c, `'(host x and port 80)'`) {
		t.Fatalf("no sudo: %s", c)
	}
	if m, isErr := explainCaptureErr("sudo: a password is required"); !isErr || !strings.Contains(m, "save this server's password") {
		t.Fatal("password advice")
	}
	if _, isErr := explainCaptureErr("tcpdump: listening on any, link-type LINUX_SLL2"); isErr {
		t.Fatal("listening is not an error")
	}
}
