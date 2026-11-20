# WorkHub

Portable work toolkit for Windows: collects hosts, ports, URLs and logins from the
clipboard, plus PuTTY-style SSH and command prompts, FileZilla-style SFTP/FTP,
Oracle/PostgreSQL SQL window, Git browser, bookmarks and a Notepad++-style editor.
One file, no install, no admin rights, no Python, Java or Oracle client needed.

## Get it onto a Windows laptop

**Easiest (no Git or Go needed):** open this repository's **Releases** page in the
browser, download `WorkHub.exe` (or the zip), save it in a folder you own such as
`Documents\WorkHub`, and double-click it.

**Build it yourself on the laptop (no admin needed):**
1. Download the Go *zip* for Windows from https://go.dev/dl/ and extract it to e.g. `%USERPROFILE%\go-sdk`.
2. Get the code: `git clone <this repo>`, or use GitHub's **Code → Download ZIP**.
3. In the project folder: `%USERPROFILE%\go-sdk\go\bin\go build -o WorkHub.exe .`
   (this downloads libraries from the internet; a company proxy may need `set HTTPS_PROXY=...`).

When it starts, your browser opens WorkHub. Keep the small console window open;
closing it stops WorkHub. "Windows protected your PC" → **More info → Run anyway**.

## Your data
- Stored in `%LOCALAPPDATA%\WorkHub\data`, encrypted and tied to your Windows login.
  Every version of the exe, run from any folder, uses the same data, so updating = run the new exe.
- Nothing is stored in this repository. Data from one laptop cannot be opened on another.
- First run imports old `workhub-data` folders it finds; **Import data…** and **Data location…**
  in the sidebar handle other cases. If data can't be opened, a recovery page lets you pick another folder.

## Separate workspaces (one per client)
Each laptop keeps its own data. For a second client on the same laptop, make a shortcut to
`WorkHub.exe -workspace ClientB`: it gets its own data, key, port and session.

## Releasing a new version
Push to `main` and GitHub Actions builds and tests it (the exe is under the run's *Artifacts*).
Tag it to publish a release:

    git tag v1.1 && git push origin v1.1

## Developing
    ./build.sh                 # dist/WorkHub.exe, dist/workhub-local, dist/WorkHub-<timestamp>.zip
    go test -short ./...       # quick tests; without -short also runs a real PostgreSQL test

Options: `WorkHub.exe -workspace NAME -data D:\folder -port 47821 -no-browser`
