# Remote Desk

Reach the files on your Mac or Windows laptop from your iPhone, from anywhere, read-only. Personal use for now (one owner, one laptop, one phone). Design and security model: `docs/design.md`. Setup steps: `README.md`.

## How it fits together
- **Laptop agent** (Go, one binary for macOS and Windows). It joins the owner's Tailscale network by itself through Tailscale's embedded library (`tailscale.com/tsnet`), so the laptop needs no Tailscale app. It serves the phone site at `https://<hostname>.<tailnet>.ts.net` with a real Tailscale certificate, and nothing on the home Wi-Fi or the internet.
- **Phone**: the free Tailscale app plus our site saved to the Home Screen. No App Store app, no Apple fee.
- **Admin page**: `http://127.0.0.1:47800` on the laptop only (status, QR code, pairing approval, shared folders, activity). Needs the admin key cookie; `remote-desk open` opens it.

## Code map
- `main.go`: flags, config, starts everything. `--dev` = no Tailscale, phone site on `http://127.0.0.1:47801`, fake device identity, separate state in `<config>/dev`, for testing in a desktop browser only.
- `internal/config`: config dir (`~/Library/Application Support/RemoteDesk`, `%AppData%\RemoteDesk`), `config.json`, atomic 0600 writes.
- `internal/auth`: pairing window + code, the one paired device, PIN hash (argon2id), login challenge/signature check, lockout, sessions.
- `internal/files`: shared roots, path resolution and every access rule, listing, search, preview kinds. Per-OS rules in `rules_*.go`.
- `internal/tailnet`: tsnet wrapper (status, TLS listener, `WhoIs` → `auth.Peer`).
- `internal/server`: phone API + static site, admin API, security headers, app icon.
- `internal/awake`, `internal/activity`: keep-awake while plugged in, activity log.
- `web/phone`, `web/admin`: plain HTML/CSS/JS, embedded with `go:embed`. No build step, no npm.

## Security rules (do not weaken without the owner saying so)
- Read-only. No endpoint may write, move or delete anything on the laptop.
- Exactly one paired device. Pairing is refused while one is paired; the owner unpairs on the laptop first.
- Every phone API call checks the Tailscale device (`WhoIs` stable node ID) against the paired one; file calls also need a session from a signed challenge + PIN.
- Pairing needs: same Tailscale account as the laptop, the one-time code from the admin page (5 tries, 5 minutes), and Approve on the admin page.
- All path checks go through `files.FS.Resolve`: no `..`, no absolute paths, no dotfiles, symlinks must stay inside the root, per-OS deny/hide lists, the agent's own config dir is never served. Case-insensitive on macOS and Windows.
- Files are served inline only for safe preview types (images, video, audio, PDF, plain text); everything else downloads as `application/octet-stream`. File responses carry `nosniff` and a sandbox CSP.
- Admin server: binds 127.0.0.1 only, checks `Host` (DNS rebinding) and `Origin` on POST, admin key cookie.
- Never log or display file contents, PINs, keys or session tokens. The activity log records names and paths only.

## Commands
- `make build` (→ `bin/remote-desk`), `make windows` (→ `bin/remote-desk.exe`), `make test` (`go vet` + `go test ./...` + Windows cross-build), `make dev ROOT=<folder>` (dev mode against a test folder).
- Run for real: `make install` → `~/Applications/Remote Desk.app` (background-only app; `launch_unix.go` starts the agent detached and exits so a second open shows the admin page; Quit is on the admin page). Never runs at login. Quit it before reinstalling; re-add it to Full Disk Access after each install.

## Working rules
- No commit, push or install-at-login without the owner saying so.
- Keep `docs/design.md` (status section) and `README.md` current when behaviour changes.
- Test changes with `make test`; UI changes in dev mode in the browser (phone width).
