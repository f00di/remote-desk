# Remote Desk: design

## Goal
If you leave a file on your laptop, you can find it and get it on your iPhone from anywhere (mobile data, any Wi-Fi). Read-only. One laptop, one phone, nobody else. Personal use first, at $0.

## Shape
```
iPhone (Tailscale app on)                         Laptop (Mac or Windows)
Home Screen web app  ── HTTPS over Tailscale ──▶  remote-desk agent
  key made on this phone                            joins your tailnet via tsnet
  PIN                                               serves https://rd-xxxx.<tailnet>.ts.net
                                                    admin page on http://127.0.0.1:47800
```
- **Reachability:** Tailscale (free personal plan). Encrypted WireGuard tunnel between your own devices, works behind home routers and mobile networks, relays (still encrypted) when a direct path fails. Tailscale can't read the traffic.
- **HTTPS:** Tailscale issues a real Let's Encrypt certificate for the `ts.net` name, so Safari trusts it with no certificate install.
- **The laptop is invisible** to the Wi-Fi it's on and to the internet. It only listens inside your tailnet (443, plus 80 that redirects).

## Verification (three locks)
1. **Network:** only devices in your Tailscale account reach the laptop.
2. **Device:** every phone request is checked with Tailscale `WhoIs`. Only the paired device's stable node ID is served. Pairing also requires the device to belong to the same Tailscale account as the laptop.
3. **Phone key + PIN:** pairing creates a P-256 key in the Home Screen app's storage with WebCrypto (`extractable: false`, so page code can't read it out). Each unlock: laptop sends a one-time challenge (60 s), the phone signs it, and sends the 6-digit PIN. The laptop checks the signature against the stored public key and the PIN against an argon2id hash. 5 failures in a row lock it until you unlock or unpair on the laptop. Sessions: 15 min idle, 8 h max, HttpOnly + Secure + SameSite=Strict cookie, bound to the device.

### Pairing
1. Admin page shows a QR code of the site address. Scan it on the iPhone (Tailscale on), then Share → Add to Home Screen, then open it from the Home Screen. Pairing happens there, because Home Screen apps keep their own storage and Safari can clear site storage after 7 days without use.
2. Click **Show pairing code** on the laptop: 8 characters, 5 minutes, 5 tries, single use.
3. On the phone: type the code, name the phone, choose a PIN. The phone makes its key and sends the public half.
4. The laptop shows the request with the Tailscale device name and OS. **Approve** stores it; pairing closes. A second device is refused until you **Unpair**.

### What it protects against
| Who | Result |
|---|---|
| Anyone on the internet or the same Wi-Fi as the laptop | Can't reach it: the agent only listens inside your tailnet. |
| Your other Tailscale devices (iPad, Mac) | Reach the site, refused by the device check. |
| Someone who got into your Tailscale account | Their device isn't the paired one; can't pair without the code shown on your laptop and your Approve. |
| Someone holding your unlocked phone | Needs the PIN; 5 wrong tries locks it. |
| Lost phone | Unpair on the laptop, remove it from the Tailscale admin console. |
| Someone at your unlocked laptop | Already has your files. Gap in v1: Approve/Unpair don't ask for the laptop password yet. |
| Malware on the laptop | Out of scope. |

### Files
- Read-only: browse, search by name, preview (images, video, audio, PDF, text), download or share (Save to Files, AirDrop, WhatsApp, mail).
- Shared folders: your home folder by default (plus iCloud Drive on a Mac). Editable on the admin page.
- Never served: dotfiles and dot-folders (`.ssh`, `.env`, …), `~/Library` and Windows `AppData` (unless you share a folder inside them), keychains, browser profiles, password-manager data, Windows credential stores, system folders, and the agent's own data.
- Paths: no `..` or absolute paths, symlinks must stay inside the shared folder, checks are case-insensitive on macOS and Windows.
- Only safe types display in the page; everything else (HTML, SVG, Office files…) downloads as a plain file, so a file can never run code inside the app.

## Known limits
- The laptop must be on, awake and online. A MacBook sleeps when the lid closes. The agent keeps it awake while plugged in (macOS `caffeinate -s`; Windows `SetThreadExecutionState` while on AC). Windows: set "When I close the lid" to "Do nothing" on power.
- Tailscale must be on on the phone.
- Turning on HTTPS in Tailscale puts the machine name in public certificate logs. The agent uses a random name like `rd-7f3k`.
- Tailscale node keys expire (default 180 days). Disable key expiry for the laptop in the Tailscale admin console.
- macOS: grant the binary Full Disk Access, or it gets permission errors on Desktop/Documents/Downloads. Rebuilding the binary changes its signature, so re-grant after a rebuild.
- No Face ID yet. Possible later with a passkey (real domain now available), but passkeys sync to your other Apple devices, so it would sit on top of the device key, not replace it.

## If it were available publicly
Personal use costs $0. A public release changes these things:

| Area | Personal (now) | Public |
|---|---|---|
| Phone | Home Screen web app + free Tailscale app | A native iPhone app becomes worth the Apple Developer fee ($99/yr): Face ID with a Secure Enclave key, no Add-to-Home-Screen steps, the laptop shows up in the Files app, App Store install. |
| Network | Your own free Tailscale account | Either keep "bring your own Tailscale" ($0 for us, more setup for users), or run our own relay with end-to-end encryption (one QR scan to set up, but server and bandwidth costs that grow with users, so it needs a paid plan). |
| Laptop app | Unsigned binary, admin page in the browser | Menu-bar/tray app, installer, start at login, signed auto-updates. macOS Developer ID + notarization (same $99/yr). Windows code signing (estimate: roughly $10/month with Azure Trusted Signing up to a few hundred dollars a year for a certificate). Guided Full Disk Access, firewall and sleep setup. |
| Laptop confirmation | Admin page click | Touch ID / Windows Hello / password required to approve or unpair. |
| Misuse | Not a concern | A remote file-access tool can be installed on someone else's laptop to spy. Needs an always-visible tray icon, a notification on every connection, no hidden mode. Antivirus and stores look harder at remote-access tools. |
| Security | Tests + your own use | Independent security review before launch, a vulnerability-report address, signed releases, prompt dependency updates (Tailscale ships often), crash reports without file names. |
| Legal | None | Privacy policy and terms (files never pass through us, but relay metadata like IP addresses would), data-protection law where users live, App Store encryption export questions, support. |
| Product | Mac + iPhone | Windows testing matrix, Android, thumbnails, faster search index, Arabic and other languages. |

Rough yearly cost (estimates): public with bring-your-own-Tailscale and the web app ≈ $99 (Apple) + Windows signing ≈ $220–500/yr. With a native app and our own relay, add hosting (from a few dollars a month to much more with heavy use) and a one-off security review.

## Status
- **v1 (branch `agent-v1`, not committed yet):** agent with embedded Tailscale, pairing, key + PIN login, lockout, browse/search/preview/download, admin page, keep-awake, activity log, dev mode.
- **Verified:** 17 Go tests (path rules incl. symlink escapes and case tricks, pairing and login rules, stolen-cookie and other-device refusal, cross-site POSTs, admin Host/Origin/key checks, file headers, range requests). Dev mode in a desktop browser at phone width: pair → approve → browse → search → text/image preview → lock → wrong PIN → unlock; pairing survives a restart; HTML files only download.
- **Not verified yet (needs the real iPhone over Tailscale):** the Tailscale login + HTTPS certificate path; Safari keeping the key in the Home Screen app; inline PDF preview; Share or save (the share sheet); Download inside the Home Screen app; the offline screen (service worker; the desktop test browser blocks service workers). Windows: compiles and vets, never run.
- **Next:** real iPhone test over mobile data; laptop password/Touch ID on Approve and Unpair; start at login; menu-bar icon; Face ID passkey experiment.
