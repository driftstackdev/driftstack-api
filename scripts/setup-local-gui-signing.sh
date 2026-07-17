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
SYSTEM_KEYCHAIN="/Library/Keychains/System.keychain"
STATE_DIR="${HOME}/Library/Application Support/Driftstack"
CODESIGN_BIN="${DRIFTSTACK_CODESIGN_BIN:-/usr/bin/codesign}"
LOCKF_BIN="${DRIFTSTACK_LOCKF_BIN:-/usr/bin/lockf}"
READY_MARKER="$STATE_DIR/local-signing-partition-v2.sha256"
LEGACY_READY_MARKER="$STATE_DIR/local-signing-partition-v1.sha256"
INSTALL_LOCK_FILE="$STATE_DIR/gui-build-install.lock"
INSTALL_LOCK_HELD=0
LOGIN_KEYCHAIN=""
TMP_DIR=""
IMPORTED_CERT=0
SYSTEM_TRUSTED_CERT=0
cleanup() {
  local status=$?
  if [[ -n "$TMP_DIR" ]]; then
    rm -rf "$TMP_DIR"
  fi
  if [[ $status -ne 0 && $IMPORTED_CERT -eq 1 && -n "$LOGIN_KEYCHAIN" ]]; then
    if [[ $SYSTEM_TRUSTED_CERT -eq 1 ]]; then
      sudo -n security delete-certificate -c "$IDENTITY_NAME" "$SYSTEM_KEYCHAIN" \
        >/dev/null 2>&1 || true
    fi
    security delete-identity -c "$IDENTITY_NAME" "$LOGIN_KEYCHAIN" >/dev/null 2>&1 || true
    # An untrusted/partial certificate may not be considered an identity even
    # when delete-identity exits successfully, so always remove it separately.
    security delete-certificate -c "$IDENTITY_NAME" "$LOGIN_KEYCHAIN" >/dev/null 2>&1 || true
  fi
  if (( INSTALL_LOCK_HELD == 1 )); then
    exec 9>&-
    INSTALL_LOCK_HELD=0
  fi
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

acquire_signing_lock() {
  local lock_status=0

  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"
  # Share the canonical installer's descriptor-owned lock. Setup can replace,
  # repartition, or delete the exact key the installer selected, so it must be
  # serialized before even discovering the default Keychain. Keeping one open
  # file description for this process also makes normal exit, signals, SIGKILL,
  # and power loss release ownership without stale-PID reclaim races.
  if [[ ! -x "$LOCKF_BIN" ]]; then
    echo "error: required lock helper is unavailable: $LOCKF_BIN" >&2
    return 1
  fi
  exec 9>"$INSTALL_LOCK_FILE"
  "$LOCKF_BIN" -s -t 0 9 || lock_status=$?
  if (( lock_status != 0 )); then
    exec 9>&-
    if (( lock_status == 75 )); then
      echo "error: another Driftstack GUI signing/build/install attempt is already active." >&2
      echo "Wait for it to finish; do not start a second signer or authorization flow." >&2
    else
      echo "error: could not acquire the Driftstack GUI signing/build/install lock (lockf exit $lock_status)." >&2
      echo "No Keychain, signer, build, or installation work was started." >&2
    fi
    return 1
  fi
  INSTALL_LOCK_HELD=1
}

acquire_signing_lock
LOGIN_KEYCHAIN="$(security default-keychain -d user | tr -d ' "')"
if [[ -z "$LOGIN_KEYCHAIN" ]]; then
  echo "error: no default user keychain found" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/driftstack-gui-signing.XXXXXX")"
chmod 700 "$TMP_DIR"
CERT="$TMP_DIR/certificate.pem"
KEY="$TMP_DIR/private-key.pem"

list_signing_identity_records() {
  security find-identity -v -p codesigning 2>/dev/null \
    | sed -nE 's/^[[:space:]]*[0-9]+\) ([[:xdigit:]]{40}) "(.*)"$/\1\	\2/p' \
    | awk -F '\t' '{ hash = toupper($1); if (!seen[hash]++) print hash "\t" $2 }'
}

resolve_installed_identity_hash() {
  local hashes
  local first
  local second
  hashes="$(list_signing_identity_records \
    | awk -F '\t' -v requested="$IDENTITY_NAME" \
      '$2 == requested { print toupper($1) }')"
  first="$(sed -n '1p' <<<"$hashes")"
  second="$(sed -n '2p' <<<"$hashes")"
  if [[ -n "$second" ]]; then
    echo "error: multiple code-signing keys use the same identity name: $IDENTITY_NAME" >&2
    echo "Remove or rename the conflicting identity before any private-key operation." >&2
    return 2
  fi
  [[ -n "$first" ]] || return 1
  printf '%s\n' "$first"
}

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
  local expected_identity_hash="$2"
  local certificate_identity_hash
  local fingerprint
  certificate_identity_hash="$(openssl x509 -in "$certificate_file" -noout -fingerprint -sha1 \
    | cut -d= -f2 | tr -d '[:space:]:' | tr '[:lower:]' '[:upper:]')"
  if [[ "$certificate_identity_hash" != "$expected_identity_hash" ]]; then
    echo "error: selected certificate does not match the resolved signing identity hash" >&2
    return 1
  fi
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

if IDENTITY_HASH="$(resolve_installed_identity_hash)"; then
  echo "==> stable identity already installed: $IDENTITY_NAME"
  security find-certificate -c "$IDENTITY_NAME" -p "$LOGIN_KEYCHAIN" >"$CERT"
  FINGERPRINT="$(certificate_fingerprint "$CERT" "$IDENTITY_HASH")"
  if authorization_marker_matches "$FINGERPRINT"; then
    if verify_prompt_free_codesign "$IDENTITY_HASH"; then
      echo "==> signing-key authorization already completed and canary-proven for this exact identity"
      echo "==> stable identity is ready for prompt-free GUI rebuilds"
      exit 0
    fi
    echo "==> prior authorization marker is stale; repairing the exact signing-key partition"
    rm -f "$READY_MARKER"
  fi
  configure_codesign_partition "$CERT"
  if ! verify_prompt_free_codesign "$IDENTITY_HASH"; then
    rm -f "$READY_MARKER"
    echo "error: signing authorization was not made prompt-free; no readiness marker was written" >&2
    exit 1
  fi
  write_authorization_marker "$FINGERPRINT"
  echo "==> stable identity is ready for prompt-free GUI rebuilds"
  exit 0
else
  resolve_status=$?
  if (( resolve_status == 2 )); then
    exit 1
  fi
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

if ! IDENTITY_HASH="$(resolve_installed_identity_hash)"; then
  echo "error: imported identity is not valid for code signing" >&2
  exit 1
fi

if ! verify_prompt_free_codesign "$IDENTITY_HASH"; then
  rm -f "$READY_MARKER"
  echo "error: signing authorization was not made prompt-free; no readiness marker was written" >&2
  exit 1
fi
write_authorization_marker "$(certificate_fingerprint "$CERT" "$IDENTITY_HASH")"

echo "==> installed stable local identity: $IDENTITY_NAME"
echo "    GUI rebuilds can now retain one signer-anchored designated requirement."
