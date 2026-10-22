# Remote Desk

Get any file from your laptop on your iPhone, from anywhere (mobile data or any Wi-Fi). Read-only, one phone only, $0. How it works and why it's safe: [docs/design.md](docs/design.md).

## Download
**Download for Mac** on the website, https://f00di.github.io/remote-desk/#get (macOS 13+, Apple silicon or Intel; no sign-up). It isn't notarized yet, so the first time: drag **Remote Desk** into Applications, open it, close the warning, then System Settings → Privacy & Security → **Open Anyway**. Then carry on from step 2 below. There's a Windows download there too (not tried on a real PC yet). Or build it yourself (step 1).

## One-time setup (Mac)

You need: this Mac, your iPhone, and a free Tailscale account (sign in with Apple, Google, Microsoft or GitHub).

1. **Build and install the app** (Go is installed with Homebrew), or use the download above:
   ```bash
   make install
   ```
   This puts **Remote Desk** in `~/Applications`. Open it like any app: its window is laid out like a code editor, with **Status**, **Your phone**, **Shared folders**, **Activity** and **Settings** on the left bar and a command palette on **Cmd+K**. **Closing the window keeps it running** so your phone can still reach the Mac (click the Dock icon to bring it back); **Quit** (Cmd+Q, or **Quit** at the right end of the bottom bar) stops it. It never starts at login.
2. **Sign in to Tailscale**: click **Sign in to Tailscale** on the admin page. Use the account you will also use on the iPhone.
3. **Turn on HTTPS in Tailscale**: the admin page links to the [DNS settings](https://login.tailscale.com/admin/dns). Turn on **MagicDNS** if it's off, then **Enable HTTPS** under HTTPS Certificates. The admin page moves on by itself.
4. **Stop the 180-day sign-out**: in [Machines](https://login.tailscale.com/admin/machines), open the `rd-…` machine, then **Disable key expiry**.
5. **Give it access to your files**: System Settings → Privacy & Security → **Full Disk Access** → **+** → Cmd+Shift+G, `~/Applications` → **Remote Desk** → Open → switch it on. Then quit Remote Desk and open it again.
   - **Do this only once:** add your Apple ID in Xcode → Settings (Cmd + ,) → Accounts → **+** (free), select **(Personal Team)** → Manage Certificates → **+** → **Apple Development**. `make install` then signs Remote Desk with that certificate, and macOS keeps Full Disk Access across every update (until the certificate is renewed after a year). Without it, each build is a "new" app and you have to remove and re-add it in Full Disk Access after every install.
   - If `security find-identity -v -p codesigning` says **0 valid identities** after that, the Mac is missing Apple's current intermediate certificate: download `AppleWWDRCAG3.cer` from https://www.apple.com/certificateauthority/ and add it to the **login** keychain (not iCloud), e.g. `security import ~/Downloads/AppleWWDRCAG3.cer -k ~/Library/Keychains/login.keychain-db`.
   - The window's **Shared folders** section shows whether Full Disk Access is on.
6. **On the iPhone**: install **Tailscale** from the App Store, sign in with the same account and switch it on.
7. **Add Remote Desk to the Home Screen**: scan the QR code on the admin page with the iPhone camera → Safari opens → Share → **Add to Home Screen** → open **Remote Desk** from the Home Screen.
8. **Pair**: on the Mac open **Your phone** and click **Show pairing code**. Type the code on the phone, choose a 6-digit PIN (twice), then click **Approve** on the Mac (or press Cmd+Return).

## Check it works away from home
Turn **Wi-Fi off** on the iPhone (mobile data only), keep Tailscale on, open Remote Desk, enter the PIN, then open a folder, search for a file, preview a photo or PDF and tap **Download** (top right of the preview) → Save to Files.

## iCloud Drive and folders that ask for the PIN
- iCloud Drive is **not shared** unless you add it on the admin page (path `~/Library/Mobile Documents/com~apple~CloudDocs`). Once added, the phone **asks for your PIN again every time** it goes into it, it closes again when you leave it or after 2 minutes unused, and its files only show up in search while it's open.
- Any other folder can get the same with **Ask for PIN** on the admin page (or the checkbox when adding it). A protected folder can't be reached through another shared folder that contains it.
- Wrong PINs there count towards the same 5-try lock.

## Everyday use
- Laptop: plugged in, awake, online, **Remote Desk** running (its window can be closed).
- Phone: Tailscale on → Remote Desk → PIN.
- Lost phone: admin page → **Unpair**, and remove it in Tailscale's Machines page.
- Locked after 5 wrong PINs: admin page → **Your phone** → **Unlock**.
- Colour theme: the theme button in the phone's bottom bar, or **Settings** (or Cmd+K → Color theme) on the laptop. 14 themes from the code editor; **Dark Modern** is the default and **Follow system** switches between Dark and Light Modern. Each device remembers its own choice.

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
  With the Apple Development certificate (setup step 5), that's it. Without it, remove the old **Remote Desk** in Full Disk Access (−) and add it again (+). Then open Remote Desk. Pairing, Tailscale sign-in and settings are kept.
- **Windows:** quit it, replace `Remote Desk.exe` with the new build, start it again. No Full Disk Access step.
- There is no automatic update yet; see "If it were available publicly" in `docs/design.md`.

## Windows
`make windows-app` builds `bin/Remote Desk.exe` with its own window (it uses WebView2, built into Windows 11). Run it on the PC and follow the same steps (no Full Disk Access step; allow it on **private networks** if Windows Firewall asks). Closing the window minimises it; Quit stops it. It compiles, but it hasn't been run on a real PC yet.

## Website
`site/` is the information page (no sign-up), published to https://f00di.github.io/remote-desk/ by `.github/workflows/pages.yml` when `main` changes `site/`. One-time setting: repo Settings → Pages → Source: **GitHub Actions**. It's unlisted (noindex) until there's a signed download. Its download buttons link to the latest GitHub release (see "Publishing a download"). Colours, fonts and radii live only in `site/theme.css`, so a new theme replaces that one file.

## Publishing a download
1. `make release` (version from `VERSION`, default in `scripts/macos-app.sh`) builds `dist/Remote-Desk-Mac.zip` (Apple silicon + Intel, signed ad hoc so your own certificate never ships) and `dist/Remote-Desk-Windows.zip`, and prints their SHA-256.
2. On GitHub: **Releases → Draft a new release**, tag `v0.4.0` (the version), attach both zips, **Publish release**.
3. The site links to `releases/latest/download/Remote-Desk-Mac.zip` and `…/Remote-Desk-Windows.zip`, so keep those names. A new release updates the buttons with no change to the site.
- Downloads are signed ad hoc, so each new download is a new app to macOS: people re-add it in Full Disk Access after updating, and click Open Anyway again. A Developer ID signature and notarization ($99/yr) would remove both.

## For development
- `make test`: gofmt, vet, all tests, Windows build.
- Quit Remote Desk before `make install` (the script refuses while it runs). Logs: `~/Library/Application Support/RemoteDesk/agent.log`.
- `make dev ROOT=/some/test/folder`: dev mode. No Tailscale, phone site on http://127.0.0.1:47801 with a fake phone identity, separate state; admin page as usual. Never point it at real files you don't want in screenshots. Add `--headless` to get the admin page in the browser instead of a window (`make build` has no window at all).
