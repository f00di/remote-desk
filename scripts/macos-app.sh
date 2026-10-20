#!/bin/sh
# Builds "bin/Remote Desk.app". With --install, also copies it to
# ~/Applications (replacing an older copy). Opening the app starts the agent;
# the Quit button on its admin page stops it. Nothing runs at login.
set -eu
cd "$(dirname "$0")/.."

VERSION=${VERSION:-0.1.1}
APP="bin/Remote Desk.app"
DEST="$HOME/Applications/Remote Desk.app"

if [ "${1:-}" = "--install" ] && pgrep -f "Remote Desk.app/Contents/MacOS/remote-desk" >/dev/null; then
  echo "Remote Desk is running. Quit it from its admin page first." >&2
  exit 1
fi

go build -trimpath -o bin/remote-desk .
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp bin/remote-desk "$APP/Contents/MacOS/remote-desk"

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
  <key>LSBackgroundOnly</key><true/>
  <key>LSEnvironment</key>
  <dict><key>REMOTE_DESK_APP_LAUNCH</key><string>1</string></dict>
  <key>NSDesktopFolderUsageDescription</key><string>So your phone can open files on your Desktop.</string>
  <key>NSDocumentsFolderUsageDescription</key><string>So your phone can open files in Documents.</string>
  <key>NSDownloadsFolderUsageDescription</key><string>So your phone can open files in Downloads.</string>
  <key>NSRemovableVolumesUsageDescription</key><string>So your phone can open files on external drives.</string>
  <key>NSNetworkVolumesUsageDescription</key><string>So your phone can open files on network drives.</string>
  <key>NSLocalNetworkUsageDescription</key><string>Remote Desk talks to your phone through Tailscale, directly when they share a network.</string>
</dict>
</plist>
EOF

codesign --force --deep --sign - "$APP"
echo "Built: $APP"

if [ "${1:-}" = "--install" ]; then
  mkdir -p "$HOME/Applications"
  rm -rf "$DEST"
  cp -R "$APP" "$DEST"
  echo "Installed: $DEST"
fi
