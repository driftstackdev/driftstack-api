#!/usr/bin/env bash
# Build + stably codesign + install BOTH gui-client app bundles.
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

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
GUI_DIR="$ROOT_DIR/apps/gui-client"
ENTITLEMENTS="$GUI_DIR/src-tauri/Entitlements.plist"
LOCAL_SIGNING_IDENTITY="Driftstack Local Development Signing"

list_signing_identities() {
  security find-identity -v -p codesigning 2>/dev/null \
    | sed -nE 's/^[[:space:]]*[0-9]+\) [[:xdigit:]]+ "(.*)"$/\1/p'
}

resolve_signing_identity() {
  local requested="${APPLE_SIGNING_IDENTITY:-}"
  local identities
  identities="$(list_signing_identities)"

  if [[ -n "$requested" ]]; then
    if ! grep -Fqx -- "$requested" <<<"$identities"; then
      echo "error: APPLE_SIGNING_IDENTITY is not a valid code-signing identity: $requested" >&2
      return 1
    fi
    printf '%s\n' "$requested"
    return
  fi

  if grep -Fqx -- "$LOCAL_SIGNING_IDENTITY" <<<"$identities"; then
    printf '%s\n' "$LOCAL_SIGNING_IDENTITY"
    return
  fi

  local developer_id
  developer_id="$(grep -m1 '^Developer ID Application:' <<<"$identities" || true)"
  if [[ -n "$developer_id" ]]; then
    printf '%s\n' "$developer_id"
    return
  fi

  echo "error: no stable macOS code-signing identity is available." >&2
  echo "Run scripts/setup-local-gui-signing.sh once, or set APPLE_SIGNING_IDENTITY." >&2
  echo "Refusing ad-hoc signing: it changes the app's designated requirement on every" >&2
  echo "build and makes Keychain prompt again for both Driftstack applications." >&2
  return 1
}

signature_requirement() {
  codesign -d -r- "$1" 2>&1 | sed -nE 's/^#? ?designated => /designated => /p'
}

verify_stable_signature() {
  local app="$1"
  local identifier="$2"
  local requirement
  codesign --verify --deep --strict "$app"
  requirement="$(signature_requirement "$app")"
  if [[ -z "$requirement" || "$requirement" == *cdhash* ]]; then
    echo "error: $app has an unstable/ad-hoc designated requirement: $requirement" >&2
    return 1
  fi
  if [[ "$requirement" != *"identifier \"$identifier\""* || "$requirement" != *anchor* ]]; then
    echo "error: $app designated requirement is not bound to $identifier and a signer anchor" >&2
    echo "       $requirement" >&2
    return 1
  fi
  printf '%s\n' "$requirement"
}

SIGNING_IDENTITY="$(resolve_signing_identity)"
echo "==> stable signing identity: $SIGNING_IDENTITY"

if [[ "${1:-}" == "--preflight" ]]; then
  exit 0
fi
if [[ $# -ne 0 ]]; then
  echo "usage: scripts/build-install-gui.sh [--preflight]" >&2
  exit 2
fi

cd "$GUI_DIR"

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
  codesign \
    --force \
    --deep \
    --options runtime \
    --entitlements "$ENTITLEMENTS" \
    --sign "$SIGNING_IDENTITY" \
    --identifier "$IDENTIFIER" \
    "$SRC"
  SRC_REQUIREMENT="$(verify_stable_signature "$SRC" "$IDENTIFIER")"
  rm -rf "$DST"
  ditto "$SRC" "$DST"
  DST_REQUIREMENT="$(verify_stable_signature "$DST" "$IDENTIFIER")"
  if [[ "$SRC_REQUIREMENT" != "$DST_REQUIREMENT" ]]; then
    echo "error: installed $name.app signature requirement changed during copy" >&2
    exit 1
  fi
  echo "    requirement: $DST_REQUIREMENT"
  echo "    installed: $DST"
done

echo "==> done — both bundles built, signed, and installed"
