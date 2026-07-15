import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');
const read = (path: string): string => readFileSync(resolve(REPO_ROOT, path), 'utf8');

describe('GUI local signing and install contract', () => {
  it('refuses ad-hoc identities and verifies signer-anchored designated requirements', () => {
    const body = read('scripts/build-install-gui.sh');

    expect(body).not.toContain('codesign --force --deep --sign -');
    expect(body).toContain('security find-identity -v -p codesigning');
    expect(body).toContain('Run scripts/setup-local-gui-signing.sh once');
    expect(body).toContain('Refusing ad-hoc signing');
    expect(body).toContain('requirement" == *cdhash*');
    expect(body).toContain('*"identifier \\"$identifier\\""*');
    expect(body).toContain('requirement" != *anchor*');
    expect(body).toContain('--options runtime');
    expect(body).toContain('--entitlements "$ENTITLEMENTS"');
    expect(body).toContain('--sign "$SIGNING_IDENTITY"');
    expect(body).toContain('SRC_REQUIREMENT="$(verify_stable_signature');
    expect(body).toContain('DST_REQUIREMENT="$(verify_stable_signature');
    expect(body).toContain('if [[ "$SRC_REQUIREMENT" != "$DST_REQUIREMENT" ]]');
  });

  it('creates a local-only identity without persisting a keychain password or plaintext secret', () => {
    const body = read('scripts/setup-local-gui-signing.sh');

    expect(body).toContain('Driftstack Local Development Signing');
    expect(body).toContain('security default-keychain -d user');
    expect(body).toContain('mktemp -d');
    expect(body).toContain('trap cleanup EXIT');
    expect(body).toContain('security delete-identity -c "$IDENTITY_NAME"');
    expect(body).toContain('openssl genrsa -traditional -out "$KEY" 3072');
    expect(body).toContain('extendedKeyUsage=critical,codeSigning');
    expect(body).toContain('-T /usr/bin/codesign');
    expect(body).toContain('SYSTEM_KEYCHAIN="/Library/Keychains/System.keychain"');
    expect(body).toContain('sudo -n security add-trusted-cert');
    expect(body).toContain('SYSTEM_TRUSTED_CERT=1');
    expect(body).toContain('sudo -n security delete-certificate');
    expect(body).toContain('security add-trusted-cert -r trustRoot -p codeSign');
    expect(body).not.toMatch(/unlock-keychain|set-key-partition-list| -A(?:\s|$)/);
    expect(body).not.toMatch(/KEYCHAIN_PASSWORD|APPLE_PASSWORD/);
  });

  it('documents stable signing as the Keychain fix without weakening secret storage', () => {
    const body = read('apps/gui-client/PACKAGING.md');

    expect(body).toMatch(/^## Local build \+ install without repeated Keychain prompts$/m);
    expect(body).toMatch(
      /Never\s+work around a prompt by moving API, proxy, or per-session control keys/,
    );
    expect(body).toContain("designated requirement is the executable's CDHash");
    expect(body).toContain('scripts/setup-local-gui-signing.sh');
    expect(body).toContain('grants its private key only to `/usr/bin/codesign`');
    expect(body).toContain('without another password dialog');
    expect(body).toContain('the script never reads or\nstores that password');
    expect(body).toContain('cannot replace Developer ID signing/notarisation');
  });
});
