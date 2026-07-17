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
GUI_DIR="${DRIFTSTACK_GUI_DIR:-$ROOT_DIR/apps/gui-client}"
ENTITLEMENTS="${DRIFTSTACK_GUI_ENTITLEMENTS:-$GUI_DIR/src-tauri/Entitlements.plist}"
APPLICATIONS_DIR="${DRIFTSTACK_APPLICATIONS_DIR:-/Applications}"
PLIST_BUDDY_BIN="${DRIFTSTACK_PLIST_BUDDY_BIN:-/usr/libexec/PlistBuddy}"
CODESIGN_BIN="${DRIFTSTACK_CODESIGN_BIN:-/usr/bin/codesign}"
LOCKF_BIN="${DRIFTSTACK_LOCKF_BIN:-/usr/bin/lockf}"
LOCAL_SIGNING_IDENTITY="Driftstack Local Development Signing"
SIGNING_STATE_DIR="${HOME}/Library/Application Support/Driftstack"
SIGNING_READY_MARKER="$SIGNING_STATE_DIR/local-signing-partition-v2.sha256"
INSTALL_LOCK_FILE="$SIGNING_STATE_DIR/gui-build-install.lock"
SIGNING_CANARY_DIR=""
INSTALL_LOCK_HELD=0

cleanup_signing_canary() {
  if [[ -n "$SIGNING_CANARY_DIR" ]]; then
    rm -rf "$SIGNING_CANARY_DIR"
    SIGNING_CANARY_DIR=""
  fi
}

cleanup() {
  cleanup_signing_canary
  if (( INSTALL_LOCK_HELD == 1 )); then
    exec 9>&-
    INSTALL_LOCK_HELD=0
  fi
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

list_signing_identities() {
  security find-identity -v -p codesigning 2>/dev/null \
    | sed -nE 's/^[[:space:]]*[0-9]+\) ([[:xdigit:]]{40}) "(.*)"$/\1\	\2/p' \
    | awk -F '\t' '{ hash = toupper($1); if (!seen[hash]++) print hash "\t" $2 }'
}

resolve_signing_identity() {
  local requested="${APPLE_SIGNING_IDENTITY:-}"
  local identities
  local conflict
  local record=""
  identities="$(list_signing_identities)"

  conflict="$(awk -F '\t' '
    {
      hash = toupper($1)
      name = $2
      if (hash_for_name[name] != "" && hash_for_name[name] != hash) {
        print name
        exit
      }
      hash_for_name[name] = hash
    }
  ' <<<"$identities")"
  if [[ -n "$conflict" ]]; then
    echo "error: multiple code-signing keys use the same identity name: $conflict" >&2
    echo "Remove or rename the conflicting identity before any private-key operation." >&2
    return 1
  fi

  if [[ -n "$requested" ]]; then
    if [[ "$requested" =~ ^[[:xdigit:]]{40}$ ]]; then
      requested="$(printf '%s' "$requested" | tr '[:lower:]' '[:upper:]')"
      record="$(awk -F '\t' -v requested="$requested" \
        'toupper($1) == requested { print; exit }' <<<"$identities")"
    else
      record="$(awk -F '\t' -v requested="$requested" \
        '$2 == requested { print; exit }' <<<"$identities")"
    fi
    if [[ -z "$record" ]]; then
      echo "error: APPLE_SIGNING_IDENTITY is not a valid code-signing identity: $requested" >&2
      return 1
    fi
    printf '%s\n' "$record"
    return
  fi

  record="$(awk -F '\t' -v requested="$LOCAL_SIGNING_IDENTITY" \
    '$2 == requested { print; exit }' <<<"$identities")"
  if [[ -n "$record" ]]; then
    printf '%s\n' "$record"
    return
  fi

  record="$(awk -F '\t' '$2 ~ /^Developer ID Application:/ { print; exit }' \
    <<<"$identities")"
  if [[ -n "$record" ]]; then
    printf '%s\n' "$record"
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
  local expected_identity_hash="$2"
  local certificate
  local certificate_identity_hash
  local fingerprint

  if ! certificate="$(security find-certificate -c "$identity" -p 2>/dev/null)" || [[ -z "$certificate" ]]; then
    echo "error: could not read the selected local signing certificate: $identity" >&2
    return 1
  fi
  certificate_identity_hash="$(printf '%s\n' "$certificate" \
    | openssl x509 -noout -fingerprint -sha1 2>/dev/null \
    | cut -d= -f2 \
    | tr -d '[:space:]:' \
    | tr '[:lower:]' '[:upper:]')"
  if [[ "$certificate_identity_hash" != "$expected_identity_hash" ]]; then
    echo "error: selected certificate does not match the resolved signing identity hash" >&2
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
  local identity_hash="$1"
  local identity_name="$2"
  local fingerprint
  local marker=""

  # Developer ID identities have their own Apple-issued keychain policy. The
  # local marker belongs only to setup-local-gui-signing.sh's exact identity.
  [[ "$identity_name" == "$LOCAL_SIGNING_IDENTITY" ]] || return 0

  fingerprint="$(local_signing_certificate_fingerprint "$identity_name" "$identity_hash")"
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

acquire_install_lock() {
  local lock_status=0

  mkdir -p "$SIGNING_STATE_DIR"
  chmod 700 "$SIGNING_STATE_DIR"
  # Keep one open file description for the script lifetime. BSD lockf ties the
  # lock to that descriptor, so normal exit, signals, SIGKILL and power loss
  # all release kernel ownership without stale-PID deletion or reclaim races.
  # The inert owner-only file deliberately remains for stable lock ordering.
  if [[ ! -x "$LOCKF_BIN" ]]; then
    echo "error: required lock helper is unavailable: $LOCKF_BIN" >&2
    return 1
  fi
  exec 9>"$INSTALL_LOCK_FILE"
  "$LOCKF_BIN" -s -t 0 9 || lock_status=$?
  if (( lock_status != 0 )); then
    exec 9>&-
    if (( lock_status == 75 )); then
      echo "error: another Driftstack GUI build/install attempt is already active." >&2
      echo "Wait for it to finish; do not start a second signer or authorization flow." >&2
    else
      echo "error: could not acquire the Driftstack GUI build/install lock (lockf exit $lock_status)." >&2
      echo "No signer, build, or installation work was started." >&2
    fi
    return 1
  fi
  INSTALL_LOCK_HELD=1
}

verify_prompt_free_codesign() {
  local identity="$1"
  local timeout_seconds="${DRIFTSTACK_SIGNING_CANARY_TIMEOUT_SECONDS:-8}"
  local canary
  local result

  if [[ ! "$timeout_seconds" =~ ^[0-9]+$ ]] \
    || (( timeout_seconds < 1 || timeout_seconds > 30 )); then
    echo "error: DRIFTSTACK_SIGNING_CANARY_TIMEOUT_SECONDS must be an integer from 1 to 30" >&2
    return 1
  fi
  if [[ ! -x "$CODESIGN_BIN" ]]; then
    echo "error: codesign executable is unavailable: $CODESIGN_BIN" >&2
    return 1
  fi

  SIGNING_CANARY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/driftstack-codesign-canary.XXXXXX")"
  chmod 700 "$SIGNING_CANARY_DIR"
  canary="$SIGNING_CANARY_DIR/codesign-canary"
  cp /usr/bin/true "$canary"
  chmod 700 "$canary"

  set +e
  /usr/bin/perl -e \
    'my $timeout = shift @ARGV; alarm $timeout; exec @ARGV or die "exec failed: $!\n"' \
    "$timeout_seconds" \
    "$CODESIGN_BIN" --force --sign "$identity" "$canary" \
    >/dev/null 2>"$SIGNING_CANARY_DIR/codesign.stderr"
  result=$?
  set -e
  if (( result != 0 )) || ! "$CODESIGN_BIN" --verify --strict "$canary" >/dev/null 2>&1; then
    cleanup_signing_canary
    echo "error: prompt-free codesign proof failed or exceeded ${timeout_seconds}s." >&2
    return 1
  fi
  cleanup_signing_canary
}

signature_requirement() {
  "$CODESIGN_BIN" -d -r- "$1" 2>&1 | sed -nE 's/^#? ?designated => /designated => /p'
}

verify_stable_signature() {
  local app="$1"
  local identifier="$2"
  local requirement
  "$CODESIGN_BIN" --verify --deep --strict "$app"
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

if [[ "${1:-}" == "--preflight" ]]; then
  [[ $# -eq 1 ]] || { echo "usage: scripts/build-install-gui.sh [--preflight]" >&2; exit 2; }
elif [[ $# -ne 0 ]]; then
  echo "usage: scripts/build-install-gui.sh [--preflight]" >&2
  exit 2
fi

acquire_install_lock
SIGNING_RECORD="$(resolve_signing_identity)"
IFS=$'\t' read -r SIGNING_IDENTITY_HASH SIGNING_IDENTITY_NAME <<<"$SIGNING_RECORD"
if [[ ! "$SIGNING_IDENTITY_HASH" =~ ^[0-9A-F]{40}$ || -z "$SIGNING_IDENTITY_NAME" ]]; then
  echo "error: selected code-signing identity record is malformed" >&2
  exit 1
fi
verify_local_signing_authorization "$SIGNING_IDENTITY_HASH" "$SIGNING_IDENTITY_NAME"
if ! verify_prompt_free_codesign "$SIGNING_IDENTITY_HASH"; then
  if [[ "$SIGNING_IDENTITY_NAME" == "$LOCAL_SIGNING_IDENTITY" ]]; then
    rm -f "$SIGNING_READY_MARKER"
    echo "Run scripts/setup-local-gui-signing.sh once, then rerun this command." >&2
  else
    echo "Repair prompt-free private-key access for the selected Developer ID identity." >&2
  fi
  echo "No GUI build, bundle codesign, or install work was started." >&2
  exit 1
fi
echo "==> stable signing identity: $SIGNING_IDENTITY_NAME ($SIGNING_IDENTITY_HASH)"
if [[ "$SIGNING_IDENTITY_NAME" == "$LOCAL_SIGNING_IDENTITY" ]]; then
  echo "==> prompt-free signing authorization: exact certificate marker + canary verified"
else
  echo "==> prompt-free signing canary: verified"
fi

if [[ "${1:-}" == "--preflight" ]]; then
  exit 0
fi

cd "$GUI_DIR"

for target in "tauri:build" "tauri:build:simulator"; do
  echo "==> npm run $target -- --bundles app"
  # This local installer consumes only the macOS .app bundle below. Keep
  # distribution targets (DMG/NSIS/AppImage/deb) out of this prompt-free path:
  # they add unrelated platform tooling and Finder automation failure modes.
  (
    unset APPLE_SIGNING_IDENTITY APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD
    unset APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID
    unset APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH
    npm run "$target" -- --bundles app
  )
done

BUNDLE_DIR="src-tauri/target/release/bundle/macos"
BUNDLE_NAMES=("Driftstack" "Driftstack Simulator")
BUNDLE_IDENTIFIERS=()
BUNDLE_REQUIREMENTS=()

for name in "${BUNDLE_NAMES[@]}"; do
  SRC="$BUNDLE_DIR/$name.app"
  IDENTIFIER=$("$PLIST_BUDDY_BIN" -c "Print :CFBundleIdentifier" "$SRC/Contents/Info.plist")
  echo "==> codesign + verify $name.app ($IDENTIFIER)"
  "$CODESIGN_BIN" \
    --force \
    --deep \
    --options runtime \
    --entitlements "$ENTITLEMENTS" \
    --sign "$SIGNING_IDENTITY_HASH" \
    --identifier "$IDENTIFIER" \
    "$SRC"
  SRC_REQUIREMENT="$(verify_stable_signature "$SRC" "$IDENTIFIER")"
  BUNDLE_IDENTIFIERS+=("$IDENTIFIER")
  BUNDLE_REQUIREMENTS+=("$SRC_REQUIREMENT")
done

echo "==> both source bundles are signed and verified; installing as one release pair"
for index in "${!BUNDLE_NAMES[@]}"; do
  name="${BUNDLE_NAMES[$index]}"
  SRC="$BUNDLE_DIR/$name.app"
  DST="$APPLICATIONS_DIR/$name.app"
  IDENTIFIER="${BUNDLE_IDENTIFIERS[$index]}"
  SRC_REQUIREMENT="${BUNDLE_REQUIREMENTS[$index]}"
  echo "==> install $name.app ($IDENTIFIER)"
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
