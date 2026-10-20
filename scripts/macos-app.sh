#!/bin/sh
# Builds "bin/Remote Desk.app": the agent with its own window (Wails, build
# tags desktop,production). With --install, also copies it to ~/Applications
# (replacing an older copy). Closing the window keeps it running; Quit stops
# it. Nothing runs at login.
set -eu
cd "$(dirname "$0")/.."

VERSION=${VERSION:-0.4.0}
APP="bin/Remote Desk.app"
DEST="$HOME/Applications/Remote Desk.app"

# -x: the process name itself, so a shell whose command line merely
# mentions the app doesn't count as "running".
if [ "${1:-}" = "--install" ] && pgrep -x remote-desk >/dev/null; then
  echo "Remote Desk is running. Quit it from its admin page first." >&2
  exit 1
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
# Wails needs cgo and, on macOS 11+, the UniformTypeIdentifiers framework.
CGO_ENABLED=1 CGO_LDFLAGS="-framework UniformTypeIdentifiers" \
  go build -trimpath -tags desktop,production -ldflags "-s -w" -o "$APP/Contents/MacOS/remote-desk" .

ICONSET="$(mktemp -d)/AppIcon.iconset"
go run ./cmd/mkicon "$ICONSET"
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
rm -rf "$(dirname "$ICONSET")"

cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Remote Desk</string>
  <key>CFBundleDisplayName</key><string>Remote Desk</string>
  <key>CFBundleIdentifier</key><string>com.remotedesk.agent</string>
  <key>CFBundleExecutable</key><string>remote-desk</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.utilities</string>
  <key>NSDesktopFolderUsageDescription</key><string>So your phone can open files on your Desktop.</string>
  <key>NSDocumentsFolderUsageDescription</key><string>So your phone can open files in Documents.</string>
  <key>NSDownloadsFolderUsageDescription</key><string>So your phone can open files in Downloads.</string>
  <key>NSRemovableVolumesUsageDescription</key><string>So your phone can open files on external drives.</string>
  <key>NSNetworkVolumesUsageDescription</key><string>So your phone can open files on network drives.</string>
  <key>NSLocalNetworkUsageDescription</key><string>Remote Desk talks to your phone through Tailscale, directly when they share a network.</string>
</dict>
</plist>
EOF

# Sign with a stable identity if there is one (an "Apple Development"
# certificate from Xcode → Settings → Accounts, free with an Apple ID), so
# macOS keeps Full Disk Access across rebuilds. SIGN_ID overrides it.
# Otherwise sign ad hoc: each build then counts as a new app.
ID=${SIGN_ID:-$(security find-identity -v -p codesigning 2>/dev/null | awk -F'"' '/Apple Development/ {print $2; exit}')}
if [ -n "$ID" ]; then
  codesign --force --deep --sign "$ID" "$APP"
  echo "Signed with: $ID (Full Disk Access is kept across updates)"
else
  codesign --force --deep --sign - "$APP"
  echo "Signed ad hoc: re-add Remote Desk in Full Disk Access after installing"
fi
echo "Built: $APP"

if [ "${1:-}" = "--install" ]; then
  mkdir -p "$HOME/Applications"
  rm -rf "$DEST"
  cp -R "$APP" "$DEST"
  echo "Installed: $DEST"
fi
