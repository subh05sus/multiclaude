#!/bin/sh
# Build the menu bar app: sh menubar/build.sh [path/to/MultiClaude.app]
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="${1:-$HOME/.multiclaude/MultiClaude.app}"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O -framework AppKit "$HERE/MultiClaude.swift" -o "$APP/Contents/MacOS/MultiClaude"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>MultiClaude</string>
  <key>CFBundleIdentifier</key><string>com.multiclaude.menubar</string>
  <key>CFBundleExecutable</key><string>MultiClaude</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST
codesign --force --sign - "$APP" >/dev/null 2>&1 || true
echo "Built $APP"
