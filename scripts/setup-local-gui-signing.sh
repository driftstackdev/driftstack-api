#!/usr/bin/env bash
# One-time local macOS setup for a stable Driftstack GUI code-signing identity.
#
# Repeated ad-hoc signatures use the executable's changing CDHash as its designated
# requirement. Keychain correctly treats every rebuilt main/Simulator bundle as new
# code and prompts again. This creates one long-lived, local-only code-signing identity
# in the user's login keychain. The temporary unencrypted private-key file exists only
# inside an owner-only directory and is removed on every exit; the imported key grants
# access to /usr/bin/codesign and the Apple code-signing partition required by
# macOS. No keychain password is read, passed on a command line, or stored.
set -euo pipefail

IDENTITY_NAME="Driftstack Local Development Signing"
LOGIN_KEYCHAIN="$(security default-keychain -d user | tr -d ' "')"
SYSTEM_KEYCHAIN="/Library/Keychains/System.keychain"
STATE_DIR="${HOME}/Library/Application Support/Driftstack"
CODESIGN_BIN="${DRIFTSTACK_CODESIGN_BIN:-/usr/bin/codesign}"
READY_MARKER="$STATE_DIR/local-signing-partition-v2.sha256"
LEGACY_READY_MARKER="$STATE_DIR/local-signing-partition-v1.sha256"
if [[ -z "$LOGIN_KEYCHAIN" ]]; then
  echo "error: no default user keychain found" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/driftstack-gui-signing.XXXXXX")"
chmod 700 "$TMP_DIR"
IMPORTED_CERT=0
SYSTEM_TRUSTED_CERT=0
cleanup() {
  local status=$?
  rm -rf "$TMP_DIR"
  if [[ $status -ne 0 && $IMPORTED_CERT -eq 1 ]]; then
    if [[ $SYSTEM_TRUSTED_CERT -eq 1 ]]; then
      sudo -n security delete-certificate -c "$IDENTITY_NAME" "$SYSTEM_KEYCHAIN" \
        >/dev/null 2>&1 || true
    fi
    security delete-identity -c "$IDENTITY_NAME" "$LOGIN_KEYCHAIN" >/dev/null 2>&1 || true
    # An untrusted/partial certificate may not be considered an identity even
    # when delete-identity exits successfully, so always remove it separately.
    security delete-certificate -c "$IDENTITY_NAME" "$LOGIN_KEYCHAIN" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

CERT="$TMP_DIR/certificate.pem"
KEY="$TMP_DIR/private-key.pem"

configure_codesign_partition() {
  local certificate_file="$1"
  local application_label
  application_label="$({
    openssl x509 -in "$certificate_file" -noout -ext subjectKeyIdentifier 2>/dev/null || true
  } | tail -n +2 | tr -d '[:space:]:' | tr '[:lower:]' '[:upper:]')"
  if [[ ! "$application_label" =~ ^[0-9A-F]{40}$ ]]; then
    echo "error: could not derive the signing key application label" >&2
    return 1
  fi

  echo "==> authorizing Apple code-signing tools for the exact local signing key"
  echo "    macOS may ask once for the login-keychain password; approve this setup action"
  # `security(1)` requires the apple: partition for /usr/bin/codesign. Match
  # the certificate's subject-key identifier/application label plus private,
  # signing-key attributes so no unrelated login-keychain key is changed.
  # Omitting deprecated `-k password` deliberately leaves authorization to
  # SecurityAgent instead of exposing or persisting the password.
  security set-key-partition-list \
    -a "$application_label" \
    -s \
    -t private \
    -S 'apple-tool:,apple:,codesign:' \
    "$LOGIN_KEYCHAIN" \
    >/dev/null
}

certificate_fingerprint() {
  local certificate_file="$1"
  local fingerprint
  fingerprint="$(openssl x509 -in "$certificate_file" -noout -fingerprint -sha256 \
    | cut -d= -f2 | tr -d '[:space:]:' | tr '[:lower:]' '[:upper:]')"
  if [[ ! "$fingerprint" =~ ^[0-9A-F]{64}$ ]]; then
    echo "error: could not derive the signing certificate fingerprint" >&2
    return 1
  fi
  printf '%s' "$fingerprint"
}

authorization_marker_matches() {
  local expected="$1"
  [[ -f "$READY_MARKER" ]] || return 1
  [[ "$(tr -d '[:space:]' <"$READY_MARKER")" == "$expected" ]]
}

write_authorization_marker() {
  local fingerprint="$1"
  local marker_tmp
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"
  marker_tmp="$(mktemp "$STATE_DIR/.local-signing-partition-v2.XXXXXX")"
  chmod 600 "$marker_tmp"
  printf '%s\n' "$fingerprint" >"$marker_tmp"
  mv -f "$marker_tmp" "$READY_MARKER"
  rm -f "$LEGACY_READY_MARKER"
}

verify_prompt_free_codesign() {
  local identity="$1"
  local timeout_seconds="${DRIFTSTACK_SIGNING_CANARY_TIMEOUT_SECONDS:-8}"
  local canary="$TMP_DIR/codesign-canary"
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

  cp /usr/bin/true "$canary"
  chmod 700 "$canary"
  set +e
  /usr/bin/perl -e \
    'my $timeout = shift @ARGV; alarm $timeout; exec @ARGV or die "exec failed: $!\n"' \
    "$timeout_seconds" \
    "$CODESIGN_BIN" --force --sign "$identity" "$canary" \
    >/dev/null 2>"$TMP_DIR/codesign.stderr"
  result=$?
  set -e
  if (( result != 0 )) || ! "$CODESIGN_BIN" --verify --strict "$canary" >/dev/null 2>&1; then
    echo "error: prompt-free codesign proof failed or exceeded ${timeout_seconds}s." >&2
    return 1
  fi
}

if security find-identity -v -p codesigning 2>/dev/null | grep -Fq "\"$IDENTITY_NAME\""; then
  echo "==> stable identity already installed: $IDENTITY_NAME"
  security find-certificate -c "$IDENTITY_NAME" -p "$LOGIN_KEYCHAIN" >"$CERT"
  FINGERPRINT="$(certificate_fingerprint "$CERT")"
  if authorization_marker_matches "$FINGERPRINT"; then
    if verify_prompt_free_codesign "$IDENTITY_NAME"; then
      echo "==> signing-key authorization already completed and canary-proven for this exact identity"
      echo "==> stable identity is ready for prompt-free GUI rebuilds"
      exit 0
    fi
    echo "==> prior authorization marker is stale; repairing the exact signing-key partition"
    rm -f "$READY_MARKER"
  fi
  configure_codesign_partition "$CERT"
  if ! verify_prompt_free_codesign "$IDENTITY_NAME"; then
    rm -f "$READY_MARKER"
    echo "error: signing authorization was not made prompt-free; no readiness marker was written" >&2
    exit 1
  fi
  write_authorization_marker "$FINGERPRINT"
  echo "==> stable identity is ready for prompt-free GUI rebuilds"
  exit 0
fi

echo "==> creating local code-signing identity"
openssl genrsa -traditional -out "$KEY" 3072 >/dev/null 2>&1
openssl req \
  -x509 \
  -new \
  -key "$KEY" \
  -sha256 \
  -days 3650 \
  -subj "/CN=$IDENTITY_NAME/O=Driftstack Development/OU=Local GUI" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning" \
  -out "$CERT" \
  >/dev/null 2>&1
chmod 600 "$CERT" "$KEY"

echo "==> importing into $LOGIN_KEYCHAIN (macOS may ask once to unlock it)"
security import "$CERT" -k "$LOGIN_KEYCHAIN" -t cert -f pemseq >/dev/null
IMPORTED_CERT=1
security import "$KEY" -k "$LOGIN_KEYCHAIN" -t priv -f openssl -T /usr/bin/codesign >/dev/null
configure_codesign_partition "$CERT"

# Prefer cached, noninteractive administrator authorization. A trust record in
# the system domain validates the login-keychain identity without presenting a
# second SecurityAgent password dialog. If no cached authorization exists, keep
# the one-time user-domain trust flow instead of storing or requesting a password
# in this script. This remains local development trust, not an Apple identity.
if sudo -n security add-trusted-cert \
  -d \
  -r trustRoot \
  -p codeSign \
  -k "$SYSTEM_KEYCHAIN" \
  "$CERT" \
  >/dev/null 2>&1; then
  SYSTEM_TRUSTED_CERT=1
  echo "==> installed code-signing trust with cached administrator authorization"
else
  echo "==> cached administrator authorization unavailable; approving user trust may ask once"
  security add-trusted-cert -r trustRoot -p codeSign -k "$LOGIN_KEYCHAIN" "$CERT"
fi

if ! security find-identity -v -p codesigning 2>/dev/null | grep -Fq "\"$IDENTITY_NAME\""; then
  echo "error: imported identity is not valid for code signing" >&2
  exit 1
fi

if ! verify_prompt_free_codesign "$IDENTITY_NAME"; then
  rm -f "$READY_MARKER"
  echo "error: signing authorization was not made prompt-free; no readiness marker was written" >&2
  exit 1
fi
write_authorization_marker "$(certificate_fingerprint "$CERT")"

echo "==> installed stable local identity: $IDENTITY_NAME"
echo "    GUI rebuilds can now retain one signer-anchored designated requirement."
