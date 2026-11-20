#!/bin/sh
# Builds WorkHub.exe (Windows, 64-bit) plus a native binary for local testing,
# then packages a timestamped zip for the work laptop.
set -e
cd "$(dirname "$0")"
stamp="$(date +%Y-%m-%d-%H%M)"
go mod tidy
GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "-s -w -X main.version=$stamp" -o dist/WorkHub.exe .
go build -trimpath -ldflags "-X main.version=$stamp" -o dist/workhub-local .
cp README.md TESTING.txt dist/
zip="WorkHub-$stamp.zip"
(cd dist && rm -f "$zip" && zip -q "$zip" WorkHub.exe TESTING.txt README.md)
echo "Package: dist/$zip"
