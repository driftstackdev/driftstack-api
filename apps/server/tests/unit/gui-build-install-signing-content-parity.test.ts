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

  it('builds only the two app bundles consumed by the local installer', () => {
    const body = read('scripts/build-install-gui.sh');

    expect(body).toContain('for target in "tauri:build" "tauri:build:simulator"');
    expect(body).toContain('npm run "$target" -- --bundles app');
    expect(body).not.toContain('npm run "$target"\n');
  });

  it('creates a local-only identity without persisting a keychain password or plaintext secret', () => {
    const body = read('scripts/setup-local-gui-signing.sh');

    expect(body).toContain('Driftstack Local Development Signing');
    expect(body).toContain('security default-keychain -d user');
    expect(body).toContain('mktemp -d');
    expect(body).toContain('trap cleanup EXIT');
    expect(body).toContain('security delete-identity -c "$IDENTITY_NAME"');
    expect(body).toContain('security delete-certificate -c "$IDENTITY_NAME" "$LOGIN_KEYCHAIN"');
    expect(body).toContain('openssl genrsa -traditional -out "$KEY" 3072');
    expect(body).toContain('extendedKeyUsage=critical,codeSigning');
    expect(body).toContain('-T /usr/bin/codesign');
    expect(body).toContain('openssl x509 -in "$certificate_file" -noout -ext subjectKeyIdentifier');
    expect(body).toContain("-S 'apple-tool:,apple:,codesign:'");
    expect(body).toContain('-a "$application_label"');
    expect(body).toContain('-t private');
    expect(body).toContain('configure_codesign_partition "$CERT"');
    expect(body).toContain('SYSTEM_KEYCHAIN="/Library/Keychains/System.keychain"');
    expect(body).toContain('sudo -n security add-trusted-cert');
    expect(body).toContain('SYSTEM_TRUSTED_CERT=1');
    expect(body).toContain('sudo -n security delete-certificate');
    expect(body).toContain('security add-trusted-cert -r trustRoot -p codeSign');
    expect(body).not.toMatch(/unlock-keychain| -A(?:\s|$)/);
    const partitionSetup = body.match(/configure_codesign_partition\(\) \{([\s\S]*?)\n\}/)?.[1];
    expect(partitionSetup).toBeDefined();
    expect(partitionSetup).not.toMatch(/^\s*-k(?:\s|$)/m);
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
    expect(body).toMatch(/scopes the partition change to that\s+exact private key/);
    expect(body).toMatch(/requires the\s+`apple:` code-signing partition/);
    expect(body).toContain('without another password dialog');
    expect(body).toContain(
      'the script never reads, passes on a command line, or stores the password',
    );
    expect(body).toMatch(/requests only the macOS `\.app`\s+target/);
    expect(body).toContain('cannot replace Developer ID signing/notarisation');
  });
});
