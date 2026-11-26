# AGENTS.md — how to work on WorkHub

Instructions for AI coding agents (and new developers). Read this before changing anything.

## What WorkHub is

A personal work hub for someone supporting banking/payment systems: connections (SSH, SFTP/FTP, Oracle/PostgreSQL),
task threads (Slack-like), notes, calendar, Jira, Confluence search ("Ask"), an API client, monitors, Git, captures of
copied text, and more. One Go program serves a local web UI.

- **Two Windows builds from the same code**: `WorkHub-Desktop.exe` (own window, Edge WebView2, `-tags desktop`) and
  `WorkHub-web.exe` (opens in the browser). Also runs on macOS for development and the demo.
- **Users are not developers.** Every text in the UI is plain, short English. New features that send data anywhere
  (AI, Teams, …) are **off by default** and say so.

## Layout

- `*.go` (package `main`, repo root) — the server: one file per feature (`jira.go`, `confluence.go`, `ask.go`,
  `confindex.go`, `pcap.go`, `threads.go`, `subthreads.go`, `teams.go`, …), with `*_test.go` next to them.
  - `main.go` — start-up, the HTTP **guard** (token cookie, Host check) and **all routes** (`routes()`).
  - `store.go` — the encrypted data file (`workhub.dat`); add settings/config fields to `state` / `Settings`.
  - `*_windows.go`, `desktop_*_windows.go` (`//go:build windows && desktop`), `sys_other.go` — OS-specific code.
- `static/` — the UI, embedded into the binary (`//go:embed static`). Plain JavaScript, **no framework, no build
  step**, one file per feature (`app.js` core, `work.js` threads, `ask.js`, `pcap.js`, `settings.js`, …), all
  loaded by `index.html` in order. `style.css` (CSS variables; dark theme via `@media (prefers-color-scheme: dark)`
  blocks, which `Theme` turns into a switch). `whatsnew.js` and `help.js` are user documentation.
  `static/vendor/` (CodeMirror 5, xterm) and `static/fonts/` (Lato, OFL) are bundled — **never load anything from
  the internet** in the page.
- `tools/demolab/` — the demo: `run-demo.sh` builds and starts WorkHub with made-up data (`seed.py`), two SSH
  servers (`main.go`, ports 2222/2223, a pretend `tcpdump`), a pretend Jira + Confluence (`fake_jira.py`, :47990).
- `tools/uitest/` — the browser smoke test (Playwright, Python): `smoke.py`, run with `run.sh`.
- `REQUIREMENTS.txt` — the owner's TODO list (local only, see below). `TESTING.txt` — manual checks for Windows.

## Tools and commands

- **Go is at `~/sdk/go/bin` and is not on PATH**: start commands with `export PATH=$HOME/sdk/go/bin:$PATH`.
- **There is no Node / npm.** JavaScript is checked by the browser test (and a syntax check in Chromium).
- `go vet ./... && go test -count=1 ./...` — Go tests.
- `tools/uitest/run.sh` — builds a fresh demo and runs every browser check (about 3 minutes; must end
  `N passed, 0 failed`). Set up once with `tools/uitest/setup.sh`.
- `tools/demolab/run-demo.sh` — start the demo (`reset` first for fresh data, `stop` to stop). The URL with the
  sign-in token is printed and in `dist/sim/workhub.log`.
- `GOOS=windows GOARCH=amd64 go build -tags desktop -o /dev/null .` and the same without `-tags desktop` —
  **always check both Windows builds compile** after touching Go code (Windows-only files aren't compiled on macOS).
- `./build.sh` (Windows exes + local binary), `./build.sh check` (vet + tests + browser test first).

## How a change is done

1. Take the item (usually from `REQUIREMENTS.txt` → TODO, quoted exactly as the owner wrote it).
2. Implement it — server in a Go file, routes in `main.go`, UI in `static/`.
3. Tests: Go tests for server logic (`httptest`, fake servers — never real company systems) **and** a browser check
   in `tools/uitest/smoke.py` (`@check("…")`) for anything visible. Run everything; all must pass.
4. User documentation, in plain words:
   - `static/whatsnew.js` — an entry under the next version at the top of `RELEASES`.
   - `static/help.js` — a topic when there's something to learn.
   - `TESTING.txt` — `[ ]` lines for what can only be checked on Windows / real servers.
5. `REQUIREMENTS.txt` — move the item from TODO to **COMPLETED** with a short "-> Done: …" (what, where it is in the
   UI, how it's tested, what is not yet tried on a real system) and "(not released yet)".
6. Leave the demo running for the owner to try (`tools/demolab/run-demo.sh`) and give its URL.

## Rules

- **`REQUIREMENTS.txt` is never committed** (`git add -A -- . ':!REQUIREMENTS.txt'`).
- **Only made-up data in the repository.** A pre-commit / pre-push scan (`.git/hooks/workhub-scan.sh`) blocks real
  IPs, emails, personal paths and company names. Use `example.com` / `*.example.com` / `acme.local` emails and hosts,
  `10.0.0.x` / `192.0.2.x` IPs, `C:\Users\me\` / `/Users/me/` paths. Never edit the scan or its allow-list yourself —
  ask the owner (they edit it).
- **Commit, push, tag or release only when the owner asks** ("tag and push"). Then: commit (message
  `<version>: <summary>` + body), push `main`, create an annotated tag `v<version>` (only after the commit
  succeeded), push the tag; GitHub Actions builds and publishes the release; wait for it, then add the title and
  notes with `gh release edit`, and mark the items "(released in <version>)" in `REQUIREMENTS.txt`.
- **Security stays as it is**: the server listens on `127.0.0.1` only; every request needs the token cookie and a
  `127.0.0.1:<port>` Host; websockets check the Origin. Secrets (passwords, tokens, API keys) stay on the server —
  never send them to the page. Nothing is sent outside the PC unless the user set it up.
- **PROD safety**: anything that runs on or changes a PROD server asks first (`askYes`).
- **No browser pop-ups**: use `askYes(…)` / `askText(…)` (WorkHub's own boxes), never `confirm()` / `prompt()` /
  `alert()` (they show "127.0.0.1 says"). Read the clipboard with `clipText()` (no browser permission prompt).
- Keep changes focused; follow the existing style; plain-English comments that say *why*.

## Gotchas

- In `smoke.py`, `ev("x = () => …")` makes Playwright **call** the returned function — end such expressions with `; 0`.
- JS template literals: backticks inside `` `…` `` HTML must be escaped (`` \` ``).
- `#apiBody`, the snippet and file-view text boxes are CodeMirror editors over a `<textarea>` (`editorOverTextarea`):
  reading / setting `.value` still works; playwright `fill()` doesn't (set `.cm.setValue(...)`).
- Most lists re-render often: re-query elements after `render()`; don't keep DOM references.
- Embedded static files: restart the demo (`run-demo.sh`) after changing `static/` to see it.
- Two Go tests can fail on the owner's Mac for local reasons (not bugs): `TestPostgresQueryWindow` when port 54329 is
  taken, and `TestLocalShell` when the user's zsh shows a prompt at start-up. Everything else must pass.
- Flaky browser check: "+ New thread asks in WorkHub's own box" occasionally times out under load — re-run once.
