#!/bin/bash
# Installs the latest Clipa for macOS into ~/Applications and opens it. One line in Terminal:
#   curl -fsSL https://raw.githubusercontent.com/qwadratic/clipa/main/mac/scripts/install.sh | bash
# The app is ad-hoc signed, not notarized: a copy downloaded by a browser is quarantined and macOS refuses to open it.
# Downloaded with curl it carries no quarantine, so after this the app opens with a double click in ~/Applications.
set -euo pipefail

url="https://github.com/qwadratic/clipa/releases/download/clipa-macos-latest/Clipa-macos.zip"
dest="$HOME/Applications"
bundle="com.hacknation.clipa"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

osascript -e 'quit app "Clipa"' >/dev/null 2>&1 || true
mkdir -p "$dest"
echo "Downloading Clipa..."
curl -fsSL -o "$tmp/Clipa.zip" "$url"
ditto -x -k "$tmp/Clipa.zip" "$tmp"
[ -d "$tmp/Clipa.app" ] || { echo "The download holds no Clipa.app." >&2; exit 1; }
rm -rf "$dest/Clipa.app"
mv "$tmp/Clipa.app" "$dest/Clipa.app"
xattr -dr com.apple.quarantine "$dest/Clipa.app" 2>/dev/null || true
# Every build has a new ad-hoc signature, so earlier permission grants no longer match: macOS asks again.
tccutil reset ScreenCapture "$bundle" >/dev/null 2>&1 || true
tccutil reset Microphone "$bundle" >/dev/null 2>&1 || true
open "$dest/Clipa.app"
echo "Clipa is in $dest/Clipa.app. Next time, double-click it there."
echo "Allow Screen Recording when asked (System Settings > Privacy & Security), then quit and reopen Clipa."
