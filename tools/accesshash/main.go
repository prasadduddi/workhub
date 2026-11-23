// accesshash sets WorkHub's team access password: it writes access.go with
// a salt and a hash, never the password itself.
//
//	go run ./tools/accesshash            asks for the password
//	WORKHUB_ACCESS='...' go run ./tools/accesshash   (no prompt)
//	go run ./tools/accesshash -off       removes the access password
package main

import (
	"bufio"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"os"
	"strings"
)

const iter = 300_000 // must match accessIter in gate.go

func main() {
	off := flag.Bool("off", false, "remove the access password")
	flag.Parse()
	salt, check := "", ""
	if !*off {
		pw := os.Getenv("WORKHUB_ACCESS")
		if pw == "" {
			fmt.Print("Team access password (at least 8 characters): ")
			pw, _ = bufio.NewReader(os.Stdin).ReadString('\n')
		}
		pw = strings.TrimRight(pw, "\r\n")
		if len([]rune(pw)) < 8 {
			fmt.Fprintln(os.Stderr, "too short — nothing changed")
			os.Exit(1)
		}
		s := make([]byte, 16)
		rand.Read(s)
		k, _ := pbkdf2.Key(sha256.New, pw, s, iter, 32)
		sum := sha256.Sum256(k)
		salt, check = hex.EncodeToString(s), hex.EncodeToString(sum[:])
	}
	src := fmt.Sprintf(`package main

// Team access password for this build: anyone starting a copy of WorkHub
// must type it once per PC (see gate.go). Only a salted hash is here. Set or
// change it with:  go run ./tools/accesshash
// Empty accessCheck = no access password.
var (
	accessSalt  = %q
	accessCheck = %q
)
`, salt, check)
	if err := os.WriteFile("access.go", []byte(src), 0o644); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if *off {
		fmt.Println("access.go updated: no access password.")
	} else {
		fmt.Println("access.go updated. Build (./build.sh) — every copy will ask for this password once per PC.")
	}
}
