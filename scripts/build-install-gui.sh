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
SIGNING_STATE_DIR="${HOME}/Library/Application Support/Driftstack"
SIGNING_READY_MARKER="$SIGNING_STATE_DIR/local-signing-partition-v1.sha256"

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

local_signing_certificate_fingerprint() {
  local identity="$1"
  local certificate
  local fingerprint

  if ! certificate="$(security find-certificate -c "$identity" -p 2>/dev/null)" || [[ -z "$certificate" ]]; then
    echo "error: could not read the selected local signing certificate: $identity" >&2
    return 1
  fi
  fingerprint="$(printf '%s\n' "$certificate" \
    | openssl x509 -noout -fingerprint -sha256 2>/dev/null \
    | cut -d= -f2 \
    | tr -d '[:space:]:' \
    | tr '[:lower:]' '[:upper:]')"
  if [[ ! "$fingerprint" =~ ^[0-9A-F]{64}$ ]]; then
    echo "error: could not derive the selected local signing certificate fingerprint" >&2
    return 1
  fi
  printf '%s\n' "$fingerprint"
}

verify_local_signing_authorization() {
  local identity="$1"
  local fingerprint
  local marker=""

  # Developer ID identities have their own Apple-issued keychain policy. The
  # local marker belongs only to setup-local-gui-signing.sh's exact identity.
  [[ "$identity" == "$LOCAL_SIGNING_IDENTITY" ]] || return 0

  fingerprint="$(local_signing_certificate_fingerprint "$identity")"
  if [[ -f "$SIGNING_READY_MARKER" ]]; then
    marker="$(tr -d '[:space:]' <"$SIGNING_READY_MARKER")"
  fi
  if [[ "$marker" != "$fingerprint" ]]; then
    echo "error: the exact local signing key is not authorized for prompt-free codesign." >&2
    echo "Run scripts/setup-local-gui-signing.sh once, then rerun this command." >&2
    echo "No GUI build, codesign, or install work was started." >&2
    return 1
  fi
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
verify_local_signing_authorization "$SIGNING_IDENTITY"
echo "==> stable signing identity: $SIGNING_IDENTITY"
if [[ "$SIGNING_IDENTITY" == "$LOCAL_SIGNING_IDENTITY" ]]; then
  echo "==> prompt-free signing authorization: exact certificate marker verified"
fi

if [[ "${1:-}" == "--preflight" ]]; then
  exit 0
fi
if [[ $# -ne 0 ]]; then
  echo "usage: scripts/build-install-gui.sh [--preflight]" >&2
  exit 2
fi

cd "$GUI_DIR"

for target in "tauri:build" "tauri:build:simulator"; do
  echo "==> npm run $target -- --bundles app"
  # This local installer consumes only the macOS .app bundle below. Keep
  # distribution targets (DMG/NSIS/AppImage/deb) out of this prompt-free path:
  # they add unrelated platform tooling and Finder automation failure modes.
  npm run "$target" -- --bundles app
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
