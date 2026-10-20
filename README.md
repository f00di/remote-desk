# Remote Desk

Get any file from your laptop on your iPhone, from anywhere (mobile data or any Wi-Fi). Read-only, one phone only, $0. How it works and why it's safe: [docs/design.md](docs/design.md).

## One-time setup (Mac)

You need: this Mac, your iPhone, and a free Tailscale account (sign in with Apple, Google, Microsoft or GitHub).

1. **Build and start the agent** (Go is installed with Homebrew):
   ```bash
   make build
   ```
   ```bash
   bin/remote-desk
   ```
   The admin page opens in your browser. Keep this Terminal window open while you use it (start-at-login is a later step).
2. **Sign in to Tailscale**: click **Sign in to Tailscale** on the admin page. Use the account you will also use on the iPhone.
3. **Turn on HTTPS in Tailscale**: the admin page links to the [DNS settings](https://login.tailscale.com/admin/dns). Turn on **MagicDNS** if it's off, then **Enable HTTPS** under HTTPS Certificates. The admin page moves on by itself.
4. **Stop the 180-day sign-out**: in [Machines](https://login.tailscale.com/admin/machines), open the `rd-…` machine, then **Disable key expiry**.
5. **Give it access to your files**: System Settings → Privacy & Security → **Full Disk Access** → **+** → press Cmd+Shift+G and paste the path of `bin/remote-desk` in this folder → turn it on. (If you started it from Terminal, macOS may ask about Terminal instead; allow it.) After every rebuild, remove and re-add it.
6. **On the iPhone**: install **Tailscale** from the App Store, sign in with the same account and switch it on.
7. **Add Remote Desk to the Home Screen**: scan the QR code on the admin page with the iPhone camera → Safari opens → Share → **Add to Home Screen** → open **Remote Desk** from the Home Screen.
8. **Pair**: on the Mac click **Show pairing code**, type it on the phone with a name and a 6-digit PIN, then click **Approve** on the Mac.

## Check it works away from home
Turn **Wi-Fi off** on the iPhone (mobile data only), keep Tailscale on, open Remote Desk, enter the PIN, then open a folder, search for a file, preview a photo or PDF and use **Share or save** → Save to Files.

## Everyday use
- Laptop: plugged in, awake, online, `bin/remote-desk` running. Reopen the admin page with `bin/remote-desk open`.
- Phone: Tailscale on → Remote Desk → PIN.
- Lost phone: admin page → **Unpair**, and remove it in Tailscale's Machines page.
- Locked after 5 wrong PINs: admin page → **Unlock**.

## If something's wrong
| You see | Do this |
|---|---|
| "Can't reach your laptop" | Tailscale on on the phone? Laptop awake and online? `bin/remote-desk` running? |
| "The laptop's system blocked this folder" | Step 5 (Full Disk Access). |
| Admin page stuck on "Getting the HTTPS certificate" | Step 3; the first certificate can take a minute. |
| "This phone's key is gone" | Website data was cleared on the phone: Unpair on the laptop and pair again. |

## Windows
`make windows` builds `bin/remote-desk.exe`; run it on the PC and follow the same steps (no Full Disk Access step; allow it on **private networks** if Windows Firewall asks). It compiles and its code paths are written for Windows, but it hasn't been run on a real PC yet.

## For development
- `make test`: gofmt, vet, all tests, Windows build.
- `make dev ROOT=/some/test/folder`: dev mode. No Tailscale, phone site on http://127.0.0.1:47801 with a fake phone identity, separate state; admin page as usual. Never point it at real files you don't want in screenshots.
