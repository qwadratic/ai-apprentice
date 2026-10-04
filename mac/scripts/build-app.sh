#!/usr/bin/env bash
# Build release binary and assemble build/Clipa.app (ad-hoc signed).
# Usage: scripts/build-app.sh            native arch
#        UNIVERSAL=1 scripts/build-app.sh  arm64 + x86_64
set -euo pipefail

cd "$(dirname "$0")/.."
APP_NAME="Clipa"
APP="build/${APP_NAME}.app"

ARCH_FLAGS=()
if [[ "${UNIVERSAL:-0}" == "1" ]]; then
  ARCH_FLAGS=(--arch arm64 --arch x86_64)
fi

echo "==> swift build -c release"
swift build -c release ${ARCH_FLAGS[@]+"${ARCH_FLAGS[@]}"}
BIN_DIR="$(swift build -c release --show-bin-path ${ARCH_FLAGS[@]+"${ARCH_FLAGS[@]}"})"

echo "==> assembling ${APP}"
rm -rf "${APP}"
mkdir -p "${APP}/Contents/MacOS" "${APP}/Contents/Resources"
cp "${BIN_DIR}/${APP_NAME}" "${APP}/Contents/MacOS/${APP_NAME}"
cp Resources/Info.plist "${APP}/Contents/Info.plist"
cp -R Resources/kb "${APP}/Contents/Resources/kb"
if [[ -f Resources/AppIcon.icns ]]; then
  cp Resources/AppIcon.icns "${APP}/Contents/Resources/AppIcon.icns"
fi
plutil -lint "${APP}/Contents/Info.plist"

echo "==> ad-hoc signing"
codesign --force --deep -s - "${APP}"
codesign --verify --verbose=2 "${APP}"

echo
echo "Built ${APP}"
echo "Run:  open ${APP}"
echo "If macOS keeps old permission state after a rebuild:  tccutil reset All com.hacknation.clipa"
