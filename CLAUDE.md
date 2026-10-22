# Remote Desk

Reach the files on your Mac or Windows laptop from your iPhone, from anywhere, read-only. Personal use for now (one owner, one laptop, one phone). Design and security model: `docs/design.md`. Setup steps: `README.md`.

## How it fits together
- **Laptop agent** (Go, one binary for macOS and Windows). It joins the owner's Tailscale network by itself through Tailscale's embedded library (`tailscale.com/tsnet`), so the laptop needs no Tailscale app. It serves the phone site at `https://<hostname>.<tailnet>.ts.net` with a real Tailscale certificate, and nothing on the home Wi-Fi or the internet.
- **Phone**: the free Tailscale app plus our site saved to the Home Screen. No App Store app, no Apple fee.
- **Desktop app** (Wails v2, build tags `desktop,production`): the admin page in a native window, served in-process by `App.DesktopHandler` (custom URL scheme, no network listener, no key). Closing the window hides it on macOS / minimises it on Windows; Quit stops it. The web view has no `confirm()`/`alert()`: use in-page confirms (inline Unpair confirm, Quit dialog) and toasts. On macOS the title bar is hidden and the page draws its own (`--wails-draggable: drag`).
- **Admin page in a browser**: `http://127.0.0.1:47800` (headless builds, `remote-desk open`). Needs the admin key cookie.
- **Website**: `site/` (static, no build step, no sign-up), deployed to GitHub Pages by `.github/workflows/pages.yml`. Its download buttons link to the latest GitHub release's `Remote-Desk-Mac.zip` / `Remote-Desk-Windows.zip` (`make release`). All colours/fonts in `site/theme.css` (Light/Dark Modern from the app's tokens).

## Code map
- `main.go`: flags; `agent.go`: starts everything (`startAgent`); `desktop.go` (tag `desktop`) / `desktop_stub.go`: the window. `--dev` = no Tailscale, phone site on `http://127.0.0.1:47801`, fake device identity, separate state in `<config>/dev`, for testing in a desktop browser only.
- `internal/config`: config dir (`~/Library/Application Support/RemoteDesk`, `%AppData%\RemoteDesk`), `config.json`, atomic 0600 writes.
- `internal/auth`: pairing window + code, the one paired device, PIN hash (argon2id), login challenge/signature check, lockout, sessions.
- `internal/files`: shared roots, path resolution and every access rule, listing, search, preview kinds. Per-OS rules in `rules_*.go`.
- `internal/tailnet`: tsnet wrapper (status, TLS listener, `WhoIs` → `auth.Peer`).
- `internal/server`: phone API + static site, admin API, security headers, app icon.
- `internal/awake`, `internal/activity`: keep-awake while plugged in, activity log.
- `web/phone`, `web/admin`: plain HTML/CSS/JS, embedded with `go:embed`. No build step, no npm.
- `web/shared` (served to both): `tokens.css` (every colour, size, radius and motion value; 14 themes as `:root[data-theme=…]`, Dark Modern default), `theme.js` (theme list for the pickers, applies the saved `rd.theme` before first paint), `icons.js` (`RD.icon(name, size)`, 16px line icons), `favicon.svg`. App icon PNGs: `internal/server/appicon/` (iOS full-bleed, macOS squircle).

## UI design (Claude Design handoff)
- Editor-style layout. Phone: auth header, breadcrumb top bar, explorer list, editor-tab preview sheet, palette-style search, bottom status bar with READ-ONLY, theme and lock. Admin: title bar with command box, activity bar, sidebar, tab + breadcrumbs, bottom Activity panel, status bar, ⌘K palette, ⌘K ⌘T theme picker.
- Components only use the tokens; they never branch on the theme. Flat surfaces, 1px borders, radius 3/4/6, shadows only on overlays. Motion: 120/150/180 ms ease-out, no bounce, reduced motion respected.
- CSP has no `unsafe-inline`: no style attributes in markup. Colours from data (theme swatches) are set with `el.style` in JS.

## Security rules (do not weaken without the owner saying so)
- Read-only. No endpoint may write, move or delete anything on the laptop.
- PIN-protected folders (iCloud Drive always; others by `Root.Protected`): list/file answer 403 `needPIN` until `/api/protected/open` (fresh signed challenge + PIN, counts towards the lockout); open for 2 min idle / 10 min max per session; closed when the phone leaves; excluded from search while closed; never reachable through a plain root that contains them. iCloud is not in the default roots.
- Exactly one paired device. Pairing is refused while one is paired; the owner unpairs on the laptop first.
- Every phone API call checks the Tailscale device (`WhoIs` stable node ID) against the paired one; file calls also need a session from a signed challenge + PIN.
- Pairing needs: same Tailscale account as the laptop, the one-time code from the admin page (5 tries, 5 minutes), and Approve on the admin page.
- All path checks go through `files.FS.Resolve`: no `..`, no absolute paths, no dotfiles, symlinks must stay inside the root, per-OS deny/hide lists, the agent's own config dir is never served. Case-insensitive on macOS and Windows.
- Files are served inline only for safe preview types (images, video, audio, PDF, plain text); everything else downloads as `application/octet-stream`. File responses carry `nosniff` and a sandbox CSP.
- Admin server: binds 127.0.0.1 only, checks `Host` (DNS rebinding) and `Origin` on POST, admin key cookie.
- Never log or display file contents, PINs, keys or session tokens. The activity log records names and paths only.

## Commands
- `make build` (→ `bin/remote-desk`, headless), `make install` (→ `~/Applications/Remote Desk.app` with the window; signs with an "Apple Development" identity if the keychain has one, else ad hoc), `make windows-app` (→ `bin/Remote Desk.exe`), `make release` (→ `dist/` zips for a GitHub release: universal Mac app signed ad hoc, Windows exe), `make test` (gofmt + vet + tests + Windows builds), `make dev ROOT=<folder>` (dev mode against a test folder).
- Run for real: `make install` → `~/Applications/Remote Desk.app` (background-only app; `launch_unix.go` starts the agent detached and exits so a second open shows the admin page; Quit is on the admin page). Never runs at login. Quit it before reinstalling; re-add it to Full Disk Access after each install.

## Working rules
- No commit, push or install-at-login without the owner saying so.
- Keep `docs/design.md` (status section) and `README.md` current when behaviour changes.
- Test changes with `make test`; UI changes in dev mode in the browser (phone width). The Claude preview tool reads the wrong project's launch.json here: serve `site/` with `python3 -m http.server` under a `/remote-desk/` folder instead.
