package main

// Team access password for this build: anyone starting a copy of WorkHub
// must type it once per PC (see gate.go). Only a salted hash is here. Set or
// change it with:  go run ./tools/accesshash
// Empty accessCheck = no access password.
var (
	accessSalt  = ""
	accessCheck = ""
)
