import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');
const read = (path: string): string => readFileSync(resolve(REPO_ROOT, path), 'utf8');
const CERT_FINGERPRINT = 'A1'.repeat(32);

const makeExecutable = (path: string, body: string): void => {
  writeFileSync(path, `#!/bin/sh\nset -eu\n${body}`, { mode: 0o700 });
  chmodSync(path, 0o700);
};

const runMockedSignerSetup = (marker: string) => {
  const root = mkdtempSync(join(tmpdir(), 'driftstack-signing-test.'));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const stateDir = join(home, 'Library/Application Support/Driftstack');
  const markerPath = join(stateDir, 'local-signing-partition-v1.sha256');
  const securityLog = join(root, 'security.log');
  mkdirSync(bin, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(markerPath, `${marker}\n`);

  makeExecutable(
    join(bin, 'security'),
    `printf '%s\\n' "$*" >>"$SECURITY_LOG"
case "$1" in
  default-keychain) printf '"%s/login.keychain-db"\\n' "$HOME" ;;
  find-identity) printf '  1) A1 "Driftstack Local Development Signing"\\n' ;;
  find-certificate) printf 'mock certificate\\n' ;;
  set-key-partition-list) exit 0 ;;
  *) exit 70 ;;
esac
`,
  );
  makeExecutable(
    join(bin, 'openssl'),
    `case " $* " in
  *" -fingerprint -sha256 "*) printf 'sha256 Fingerprint=${CERT_FINGERPRINT}\\n' ;;
  *" -ext subjectKeyIdentifier "*) printf 'X509v3 Subject Key Identifier:\\n    %s\\n' '${'B2:'.repeat(19)}B2' ;;
  *) exit 71 ;;
esac
`,
  );

  const result = spawnSync('bash', [resolve(REPO_ROOT, 'scripts/setup-local-gui-signing.sh')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      SECURITY_LOG: securityLog,
    },
  });

  return {
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    marker: readFileSync(markerPath, 'utf8').trim(),
    result,
    securityCalls: readFileSync(securityLog, 'utf8'),
  };
};

const runMockedBuildInstall = (opts: {
  marker?: string;
  requestedIdentity?: string;
  args?: string[];
}) => {
  const root = mkdtempSync(join(tmpdir(), 'driftstack-build-install-test.'));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const stateDir = join(home, 'Library/Application Support/Driftstack');
  const markerPath = join(stateDir, 'local-signing-partition-v1.sha256');
  const securityLog = join(root, 'security.log');
  const npmLog = join(root, 'npm.log');
  const codesignLog = join(root, 'codesign.log');
  mkdirSync(bin, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  if (opts.marker !== undefined) writeFileSync(markerPath, `${opts.marker}\n`);

  makeExecutable(
    join(bin, 'security'),
    `printf '%s\\n' "$*" >>"$SECURITY_LOG"
case "$1" in
  find-identity)
    printf '  1) A1 "Driftstack Local Development Signing"\\n'
    printf '  2) A2 "Developer ID Application: Driftstack Test (TEAMID)"\\n'
    ;;
  find-certificate) printf 'mock certificate\\n' ;;
  *) exit 70 ;;
esac
`,
  );
  makeExecutable(
    join(bin, 'openssl'),
    `case " $* " in
  *" -fingerprint -sha256 "*) printf 'sha256 Fingerprint=${CERT_FINGERPRINT}\\n' ;;
  *) exit 71 ;;
esac
`,
  );
  makeExecutable(join(bin, 'npm'), `printf '%s\\n' "$*" >>"$NPM_LOG"`);
  makeExecutable(join(bin, 'codesign'), `printf '%s\\n' "$*" >>"$CODESIGN_LOG"`);

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    SECURITY_LOG: securityLog,
    NPM_LOG: npmLog,
    CODESIGN_LOG: codesignLog,
    ...(opts.requestedIdentity !== undefined
      ? { APPLE_SIGNING_IDENTITY: opts.requestedIdentity }
      : { APPLE_SIGNING_IDENTITY: '' }),
  };
  const result = spawnSync(
    'bash',
    [resolve(REPO_ROOT, 'scripts/build-install-gui.sh'), ...(opts.args ?? ['--preflight'])],
    { encoding: 'utf8', env },
  );

  return {
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    codesignCalls: existsSync(codesignLog) ? readFileSync(codesignLog, 'utf8') : '',
    npmCalls: existsSync(npmLog) ? readFileSync(npmLog, 'utf8') : '',
    result,
    securityCalls: existsSync(securityLog) ? readFileSync(securityLog, 'utf8') : '',
  };
};

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

  it('fails before build unless the exact local certificate authorization marker matches', () => {
    const ready = runMockedBuildInstall({ marker: CERT_FINGERPRINT });
    try {
      expect(ready.result.status).toBe(0);
      expect(ready.result.stdout).toContain(
        'prompt-free signing authorization: exact certificate marker verified',
      );
      expect(ready.securityCalls).toContain(
        'find-certificate -c Driftstack Local Development Signing -p',
      );
      expect(ready.npmCalls).toBe('');
      expect(ready.codesignCalls).toBe('');
    } finally {
      ready.cleanup();
    }

    for (const marker of [undefined, 'C3'.repeat(32)]) {
      const blocked = runMockedBuildInstall({ marker, args: [] });
      try {
        expect(blocked.result.status).not.toBe(0);
        expect(blocked.result.stderr).toContain('Run scripts/setup-local-gui-signing.sh once');
        expect(blocked.result.stderr).toContain(
          'No GUI build, codesign, or install work was started.',
        );
        expect(blocked.npmCalls).toBe('');
        expect(blocked.codesignCalls).toBe('');
        expect(blocked.securityCalls).not.toContain('set-key-partition-list');
      } finally {
        blocked.cleanup();
      }
    }
  });

  it('does not apply the local authorization marker to an explicit Developer ID identity', () => {
    const developerId = 'Developer ID Application: Driftstack Test (TEAMID)';
    const result = runMockedBuildInstall({ requestedIdentity: developerId });
    try {
      expect(result.result.status).toBe(0);
      expect(result.result.stdout).toContain(`stable signing identity: ${developerId}`);
      expect(result.securityCalls).not.toContain('find-certificate');
      expect(result.npmCalls).toBe('');
      expect(result.codesignCalls).toBe('');
    } finally {
      result.cleanup();
    }
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
    expect(body).toContain('READY_MARKER="$STATE_DIR/local-signing-partition-v1.sha256"');
    expect(body).toContain('openssl x509 -in "$certificate_file" -noout -fingerprint -sha256');
    expect(body).toContain('authorization_marker_matches "$FINGERPRINT"');
    expect(body).toContain('signing-key authorization already completed for this exact identity');
    expect(body).toContain('write_authorization_marker "$FINGERPRINT"');
    expect(body).toContain('chmod 700 "$STATE_DIR"');
    expect(body).toContain('chmod 600 "$marker_tmp"');
    expect(body).toContain('write_authorization_marker "$(certificate_fingerprint "$CERT")"');
    expect(body).not.toMatch(/unlock-keychain| -A(?:\s|$)/);
    const partitionSetup = body.match(/configure_codesign_partition\(\) \{([\s\S]*?)\n\}/)?.[1];
    expect(partitionSetup).toBeDefined();
    expect(partitionSetup).not.toMatch(/^\s*-k(?:\s|$)/m);
    expect(body).not.toMatch(/KEYCHAIN_PASSWORD|APPLE_PASSWORD/);
  });

  it('skips partition authorization only for the exact identity fingerprint', () => {
    const matching = runMockedSignerSetup(CERT_FINGERPRINT);
    try {
      expect(matching.result.status).toBe(0);
      expect(matching.result.stdout).toContain(
        'signing-key authorization already completed for this exact identity',
      );
      expect(matching.securityCalls).not.toContain('set-key-partition-list');
      expect(matching.marker).toBe(CERT_FINGERPRINT);
    } finally {
      matching.cleanup();
    }

    const rotated = runMockedSignerSetup('C3'.repeat(32));
    try {
      expect(rotated.result.status).toBe(0);
      expect(rotated.securityCalls.match(/^set-key-partition-list /gm)).toHaveLength(1);
      expect(rotated.marker).toBe(CERT_FINGERPRINT);
    } finally {
      rotated.cleanup();
    }
  });

  it('documents stable signing as the Keychain fix without weakening secret storage', () => {
    const body = read('apps/gui-client/PACKAGING.md');

    expect(body).toMatch(/^## Local build \+ install without repeated Keychain prompts$/m);
    expect(body).toMatch(
      /Never\s+work around a prompt by moving API, proxy, or per-session control keys/,
    );
    expect(body).toContain("designated requirement is the executable's CDHash");
    expect(body).toContain('scripts/setup-local-gui-signing.sh');
    expect(body).toContain('requires the exact');
    expect(body).toContain('before either Tauri build');
    expect(body).toMatch(/scopes the partition change to that\s+exact private key/);
    expect(body).toMatch(/requires the\s+`apple:` code-signing partition/);
    expect(body).toContain('without another password dialog');
    expect(body).toContain(
      'the script never reads, passes on a command line, or stores the password',
    );
    expect(body).toMatch(/requests\s+only the macOS `\.app` target/);
    expect(body).toContain('cannot replace Developer ID signing/notarisation');
  });
});
