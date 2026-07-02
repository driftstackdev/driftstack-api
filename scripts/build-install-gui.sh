#!/usr/bin/env bash
# Build + codesign + install BOTH gui-client app bundles.
#
# apps/gui-client ships as TWO separate macOS app bundles built from the SAME
# frontend source: "Driftstack.app" (dev.driftstack.gui, the main window —
# `npm run tauri:build`) and "Driftstack Simulator.app" (dev.driftstack.simulator,
# the per-profile device window the main app launches via `open` + `--ds-session=`
# — `npm run tauri:build:simulator`). Real incident 2026-07-02: the main app was
# rebuilt+installed repeatedly across a session while the simulator companion
# bundle was not, leaving every live simulator window running a build over a day
# stale (silently missing that day's fixes) while the main app looked current.
# This script always builds + installs both together so that can't happen again.
set -euo pipefail

cd "$(dirname "$0")/../apps/gui-client"

for target in "tauri:build" "tauri:build:simulator"; do
  echo "==> npm run $target"
  npm run "$target"
done

BUNDLE_DIR="src-tauri/target/release/bundle/macos"
for name in "Driftstack" "Driftstack Simulator"; do
  SRC="$BUNDLE_DIR/$name.app"
  DST="/Applications/$name.app"
  IDENTIFIER=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$SRC/Contents/Info.plist")
  echo "==> codesign + install $name.app ($IDENTIFIER)"
  codesign --force --deep --sign - -i "$IDENTIFIER" "$SRC"
  codesign --verify --deep --strict "$SRC"
  rm -rf "$DST"
  cp -R "$SRC" "$DST"
  codesign --verify --deep --strict "$DST"
  echo "    installed: $DST"
done

echo "==> done — both bundles built, signed, and installed"
