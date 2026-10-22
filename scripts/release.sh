#!/bin/sh
# Builds the two downloads the website links to, into dist/:
#   Remote-Desk-Mac.zip      Remote Desk.app for Apple silicon and Intel Macs (macOS 13+). Signed ad
#                            hoc, not notarized: macOS asks for "Open Anyway" the first time.
#   Remote-Desk-Windows.zip  Remote Desk.exe (64-bit, needs WebView2). Unsigned, not tried on a real PC.
# Then upload both to a GitHub release (see README "Publishing a download"). The site links to
# releases/latest/download/<name>, so keep these two names.
set -eu
cd "$(dirname "$0")/.."

VERSION=${VERSION:-0.4.0}
OUT=dist

rm -rf "$OUT"
mkdir -p "$OUT"

UNIVERSAL=1 SIGN_ID=- VERSION="$VERSION" sh scripts/macos-app.sh
# ditto keeps the app's signature and permissions intact (plain zip can break them).
ditto -c -k --keepParent "bin/Remote Desk.app" "$OUT/Remote-Desk-Mac.zip"

make windows-app
(cd bin && zip -q -X "../$OUT/Remote-Desk-Windows.zip" "Remote Desk.exe")

echo
echo "Release $VERSION in $OUT/:"
(cd "$OUT" && ls -lh -- *.zip | awk '{print "  " $NF "  " $5}' && echo && shasum -a 256 -- *.zip)
