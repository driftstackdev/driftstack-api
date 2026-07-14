#!/usr/bin/env bash
# One-time local macOS setup for a stable Driftstack GUI code-signing identity.
#
# Repeated ad-hoc signatures use the executable's changing CDHash as its designated
# requirement. Keychain correctly treats every rebuilt main/Simulator bundle as new
# code and prompts again. This creates one long-lived, local-only code-signing identity
# in the user's login keychain. The temporary unencrypted private-key file exists only
# inside an owner-only directory and is removed on every exit; the imported key grants
# access only to /usr/bin/codesign. No keychain password is read or stored by this script.
set -euo pipefail

IDENTITY_NAME="Driftstack Local Development Signing"
LOGIN_KEYCHAIN="$(security default-keychain -d user | tr -d ' "')"
if [[ -z "$LOGIN_KEYCHAIN" ]]; then
  echo "error: no default user keychain found" >&2
  exit 1
fi

if security find-identity -v -p codesigning 2>/dev/null | grep -Fq "\"$IDENTITY_NAME\""; then
  echo "==> stable identity already installed: $IDENTITY_NAME"
  exit 0
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/driftstack-gui-signing.XXXXXX")"
chmod 700 "$TMP_DIR"
IMPORTED_CERT=0
cleanup() {
  local status=$?
  rm -rf "$TMP_DIR"
  if [[ $status -ne 0 && $IMPORTED_CERT -eq 1 ]]; then
    security delete-identity -c "$IDENTITY_NAME" "$LOGIN_KEYCHAIN" >/dev/null 2>&1 ||
      security delete-certificate -c "$IDENTITY_NAME" "$LOGIN_KEYCHAIN" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

CERT="$TMP_DIR/certificate.pem"
KEY="$TMP_DIR/private-key.pem"

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

# Trust only this certificate for code signing in the current user's trust domain.
# This is local development trust, not a distributable/notarizable Apple identity.
security add-trusted-cert -r trustRoot -p codeSign -k "$LOGIN_KEYCHAIN" "$CERT"

if ! security find-identity -v -p codesigning 2>/dev/null | grep -Fq "\"$IDENTITY_NAME\""; then
  echo "error: imported identity is not valid for code signing" >&2
  exit 1
fi

echo "==> installed stable local identity: $IDENTITY_NAME"
echo "    GUI rebuilds can now retain one signer-anchored designated requirement."
