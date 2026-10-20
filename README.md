# Remote Desk

Get any file from your laptop on your iPhone, from anywhere (mobile data or any Wi-Fi). Read-only, one phone only, $0. How it works and why it's safe: [docs/design.md](docs/design.md).

## One-time setup (Mac)

You need: this Mac, your iPhone, and a free Tailscale account (sign in with Apple, Google, Microsoft or GitHub).

1. **Build and install the app** (Go is installed with Homebrew):
   ```bash
   make install
   ```
   This puts **Remote Desk** in `~/Applications`. Open it like any app: it runs in the background (no Dock icon) and opens its admin page in your browser. Opening it again just reopens the admin page. It never starts at login; the **Quit** button at the bottom of the admin page stops it.
2. **Sign in to Tailscale**: click **Sign in to Tailscale** on the admin page. Use the account you will also use on the iPhone.
3. **Turn on HTTPS in Tailscale**: the admin page links to the [DNS settings](https://login.tailscale.com/admin/dns). Turn on **MagicDNS** if it's off, then **Enable HTTPS** under HTTPS Certificates. The admin page moves on by itself.
4. **Stop the 180-day sign-out**: in [Machines](https://login.tailscale.com/admin/machines), open the `rd-…` machine, then **Disable key expiry**.
5. **Give it access to your files**: System Settings → Privacy & Security → **Full Disk Access** → **+** → Cmd+Shift+G, `~/Applications` → **Remote Desk** → Open → switch it on. Then Quit Remote Desk from its admin page and open it again. After every `make install`, remove it from the list and add it again (the rebuilt app has a new signature).
6. **On the iPhone**: install **Tailscale** from the App Store, sign in with the same account and switch it on.
7. **Add Remote Desk to the Home Screen**: scan the QR code on the admin page with the iPhone camera → Safari opens → Share → **Add to Home Screen** → open **Remote Desk** from the Home Screen.
8. **Pair**: on the Mac click **Show pairing code**, type it on the phone with a name and a 6-digit PIN, then click **Approve** on the Mac.

## Check it works away from home
Turn **Wi-Fi off** on the iPhone (mobile data only), keep Tailscale on, open Remote Desk, enter the PIN, then open a folder, search for a file, preview a photo or PDF and use **Share or save** → Save to Files.

## Everyday use
- Laptop: plugged in, awake, online, **Remote Desk** open (open it from Applications; opening it again shows the admin page).
- Phone: Tailscale on → Remote Desk → PIN.
- Lost phone: admin page → **Unpair**, and remove it in Tailscale's Machines page.
- Locked after 5 wrong PINs: admin page → **Unlock**.

## If something's wrong
| You see | Do this |
|---|---|
| "Can't reach your laptop" | Tailscale on on the phone? Laptop awake and online? Remote Desk open on the laptop? |
| "The laptop's system blocked this folder" | Step 5 (Full Disk Access). |
| Admin page stuck on "Getting the HTTPS certificate" | Step 3; the first certificate can take a minute. |
| "This phone's key is gone" | Website data was cleared on the phone: Unpair on the laptop and pair again. |
| Stuck on a file page with no back button | Swipe Remote Desk away in the app switcher and open it again (fixed in 0.1.1: the Home Screen app only saves through the share sheet now). |

## Updating
- **iPhone:** nothing to do. The phone app is a page the laptop serves, so it updates when the laptop does; close and reopen it from the Home Screen to load the new version.
- **Mac:** quit Remote Desk from its admin page, then get the new code and reinstall:
  ```bash
  git pull && make install
  ```
  In Full Disk Access, remove the old **Remote Desk** (−) and add it again (+): each build has a new signature, so macOS treats it as a new app. Then open Remote Desk. Pairing, Tailscale sign-in and settings are kept.
- **Windows:** quit it, replace `remote-desk.exe` with the new build, start it again. No Full Disk Access step.
- There is no automatic update yet; see "If it were available publicly" in `docs/design.md`.

## Windows
`make windows` builds `bin/remote-desk.exe`; run it on the PC and follow the same steps (no Full Disk Access step; allow it on **private networks** if Windows Firewall asks). It compiles and its code paths are written for Windows, but it hasn't been run on a real PC yet.

## For development
- `make test`: gofmt, vet, all tests, Windows build.
- Quit Remote Desk before `make install` (the script refuses while it runs). Logs: `~/Library/Application Support/RemoteDesk/agent.log`.
- `make dev ROOT=/some/test/folder`: dev mode. No Tailscale, phone site on http://127.0.0.1:47801 with a fake phone identity, separate state; admin page as usual. Never point it at real files you don't want in screenshots.
