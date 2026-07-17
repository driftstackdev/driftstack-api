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
const LOCAL_IDENTITY_HASH = 'A1'.repeat(20);
const DEVELOPER_IDENTITY_HASH = 'C3'.repeat(20);
const CONFLICTING_LOCAL_IDENTITY_HASH = 'D4'.repeat(20);

const makeExecutable = (path: string, body: string): void => {
  writeFileSync(path, `#!/bin/sh\nset -eu\n${body}`, { mode: 0o700 });
  chmodSync(path, 0o700);
};

const runMockedSignerSetup = (
  marker: string,
  codesignMode: 'success' | 'fail' | 'hang' = 'success',
  identityMode: 'duplicates' | 'conflict' = 'duplicates',
  lockState: 'available' | 'active' | 'error' = 'available',
) => {
  const root = mkdtempSync(join(tmpdir(), 'driftstack-signing-test.'));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const stateDir = join(home, 'Library/Application Support/Driftstack');
  const markerPath = join(stateDir, 'local-signing-partition-v2.sha256');
  const securityLog = join(root, 'security.log');
  const codesignLog = join(root, 'codesign.log');
  mkdirSync(bin, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(markerPath, `${marker}\n`);

  makeExecutable(
    join(bin, 'security'),
    `printf '%s\\n' "$*" >>"$SECURITY_LOG"
case "$1" in
  default-keychain) printf '"%s/login.keychain-db"\\n' "$HOME" ;;
	  find-identity)
	    printf '  1) ${LOCAL_IDENTITY_HASH} "Driftstack Local Development Signing"\\n'
	    printf '  2) ${
        identityMode === 'conflict' ? CONFLICTING_LOCAL_IDENTITY_HASH : LOCAL_IDENTITY_HASH
      } "Driftstack Local Development Signing"\\n'
	    ;;
  find-certificate) printf 'mock certificate\\n' ;;
  set-key-partition-list) exit 0 ;;
  *) exit 70 ;;
esac
`,
  );
  makeExecutable(
    join(bin, 'openssl'),
    `case " $* " in
  *" -fingerprint -sha1 "*) printf 'sha1 Fingerprint=${LOCAL_IDENTITY_HASH}\\n' ;;
  *" -fingerprint -sha256 "*) printf 'sha256 Fingerprint=${CERT_FINGERPRINT}\\n' ;;
  *" -ext subjectKeyIdentifier "*) printf 'X509v3 Subject Key Identifier:\\n    %s\\n' '${'B2:'.repeat(19)}B2' ;;
  *) exit 71 ;;
esac
`,
  );
  makeExecutable(
    join(bin, 'codesign'),
    `printf '%s\n' "$*" >>"$CODESIGN_LOG"
${codesignMode === 'hang' ? 'exec /bin/sleep 30' : codesignMode === 'fail' ? 'exit 72' : 'exit 0'}
`,
  );
  makeExecutable(
    join(bin, 'lockf'),
    lockState === 'active' ? 'exit 75' : lockState === 'error' ? 'exit 70' : 'exit 0',
  );

  const result = spawnSync('bash', [resolve(REPO_ROOT, 'scripts/setup-local-gui-signing.sh')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      SECURITY_LOG: securityLog,
      CODESIGN_LOG: codesignLog,
      DRIFTSTACK_CODESIGN_BIN: join(bin, 'codesign'),
      DRIFTSTACK_LOCKF_BIN: join(bin, 'lockf'),
      DRIFTSTACK_SIGNING_CANARY_TIMEOUT_SECONDS: '1',
    },
  });

  return {
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    codesignCalls: existsSync(codesignLog) ? readFileSync(codesignLog, 'utf8') : '',
    marker: existsSync(markerPath) ? readFileSync(markerPath, 'utf8').trim() : undefined,
    result,
    securityCalls: existsSync(securityLog) ? readFileSync(securityLog, 'utf8') : '',
  };
};

const runMockedBuildInstall = (opts: {
  marker?: string;
  requestedIdentity?: string;
  args?: string[];
  codesignMode?: 'success' | 'fail' | 'hang';
  identityMode?: 'duplicates' | 'conflict';
  lockState?: 'active' | 'stale' | 'error';
}) => {
  const root = mkdtempSync(join(tmpdir(), 'driftstack-build-install-test.'));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const guiDir = join(root, 'gui');
  const applicationsDir = join(root, 'Applications');
  const bundleDir = join(guiDir, 'src-tauri/target/release/bundle/macos');
  const stateDir = join(home, 'Library/Application Support/Driftstack');
  const markerPath = join(stateDir, 'local-signing-partition-v2.sha256');
  const securityLog = join(root, 'security.log');
  const npmLog = join(root, 'npm.log');
  const npmEnvLog = join(root, 'npm-env.log');
  const codesignLog = join(root, 'codesign.log');
  const installLog = join(root, 'install.log');
  const eventLog = join(root, 'events.log');
  mkdirSync(bin, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  if (opts.lockState) {
    writeFileSync(join(stateDir, 'gui-build-install.lock'), 'inert lock inode\n');
  }
  mkdirSync(applicationsDir, { recursive: true });
  for (const name of ['Driftstack', 'Driftstack Simulator']) {
    const contents = join(bundleDir, `${name}.app/Contents`);
    mkdirSync(contents, { recursive: true });
    writeFileSync(join(contents, 'Info.plist'), 'mock plist\n');
  }
  mkdirSync(join(guiDir, 'src-tauri'), { recursive: true });
  writeFileSync(join(guiDir, 'src-tauri/Entitlements.plist'), 'mock entitlements\n');
  if (opts.marker !== undefined) writeFileSync(markerPath, `${opts.marker}\n`);

  makeExecutable(
    join(bin, 'security'),
    `printf '%s\\n' "$*" >>"$SECURITY_LOG"
case "$1" in
  find-identity)
    printf '  1) ${LOCAL_IDENTITY_HASH} "Driftstack Local Development Signing"\\n'
    printf '  2) ${
      opts.identityMode === 'conflict' ? CONFLICTING_LOCAL_IDENTITY_HASH : LOCAL_IDENTITY_HASH
    } "Driftstack Local Development Signing"\\n'
    printf '  3) ${DEVELOPER_IDENTITY_HASH} "Developer ID Application: Driftstack Test (TEAMID)"\\n'
    ;;
  find-certificate) printf 'mock certificate\\n' ;;
  *) exit 70 ;;
esac
`,
  );
  makeExecutable(
    join(bin, 'openssl'),
    `case " $* " in
  *" -fingerprint -sha1 "*) printf 'sha1 Fingerprint=${LOCAL_IDENTITY_HASH}\\n' ;;
  *" -fingerprint -sha256 "*) printf 'sha256 Fingerprint=${CERT_FINGERPRINT}\\n' ;;
  *) exit 71 ;;
esac
`,
  );
  makeExecutable(
    join(bin, 'npm'),
    `printf '%s\\n' "$*" >>"$NPM_LOG"
printf 'npm %s\\n' "$*" >>"$EVENT_LOG"
if env | grep -E '^(APPLE_SIGNING_IDENTITY|APPLE_CERTIFICATE|APPLE_CERTIFICATE_PASSWORD|APPLE_ID|APPLE_PASSWORD|APPLE_TEAM_ID|APPLE_API_KEY|APPLE_API_ISSUER|APPLE_API_KEY_PATH)=' >>"$NPM_ENV_LOG"; then
  :
else
  printf '<clean>\\n' >>"$NPM_ENV_LOG"
fi
`,
  );
  makeExecutable(
    join(bin, 'lockf'),
    opts.lockState === 'active' ? 'exit 75' : opts.lockState === 'error' ? 'exit 70' : 'exit 0',
  );
  makeExecutable(
    join(bin, 'codesign'),
    `printf '%s\\n' "$*" >>"$CODESIGN_LOG"
printf 'codesign %s\\n' "$*" >>"$EVENT_LOG"
${
  opts.codesignMode === 'hang'
    ? 'exec /bin/sleep 30'
    : opts.codesignMode === 'fail'
      ? 'exit 72'
      : `case " $* " in
  *" -d -r- "*"Driftstack Simulator.app"*) printf 'designated => anchor local and identifier "dev.driftstack.simulator"\\n' >&2 ;;
  *" -d -r- "*) printf 'designated => anchor local and identifier "dev.driftstack.gui"\\n' >&2 ;;
esac
exit 0`
}
`,
  );
  makeExecutable(
    join(bin, 'plistbuddy'),
    `case "$*" in
  *"Driftstack Simulator.app"*) printf 'dev.driftstack.simulator\\n' ;;
  *) printf 'dev.driftstack.gui\\n' ;;
esac
`,
  );
  makeExecutable(
    join(bin, 'ditto'),
    `printf '%s\\n' "$*" >>"$INSTALL_LOG"
printf 'install %s\\n' "$*" >>"$EVENT_LOG"
cp -R "$1" "$2"
`,
  );

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    SECURITY_LOG: securityLog,
    NPM_LOG: npmLog,
    NPM_ENV_LOG: npmEnvLog,
    CODESIGN_LOG: codesignLog,
    INSTALL_LOG: installLog,
    EVENT_LOG: eventLog,
    DRIFTSTACK_CODESIGN_BIN: join(bin, 'codesign'),
    DRIFTSTACK_LOCKF_BIN: join(bin, 'lockf'),
    DRIFTSTACK_GUI_DIR: guiDir,
    DRIFTSTACK_APPLICATIONS_DIR: applicationsDir,
    DRIFTSTACK_PLIST_BUDDY_BIN: join(bin, 'plistbuddy'),
    DRIFTSTACK_SIGNING_CANARY_TIMEOUT_SECONDS: '1',
    APPLE_CERTIFICATE: 'must-not-reach-tauri',
    APPLE_CERTIFICATE_PASSWORD: 'must-not-reach-tauri',
    APPLE_ID: 'must-not-reach-tauri',
    APPLE_PASSWORD: 'must-not-reach-tauri',
    APPLE_TEAM_ID: 'must-not-reach-tauri',
    APPLE_API_KEY: 'must-not-reach-tauri',
    APPLE_API_ISSUER: 'must-not-reach-tauri',
    APPLE_API_KEY_PATH: 'must-not-reach-tauri',
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
    events: existsSync(eventLog) ? readFileSync(eventLog, 'utf8') : '',
    installCalls: existsSync(installLog) ? readFileSync(installLog, 'utf8') : '',
    markerExists: existsSync(markerPath),
    npmCalls: existsSync(npmLog) ? readFileSync(npmLog, 'utf8') : '',
    npmEnvCalls: existsSync(npmEnvLog) ? readFileSync(npmEnvLog, 'utf8') : '',
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
    expect(body).toContain('--sign "$SIGNING_IDENTITY_HASH"');
    expect(body).toContain(
      'selected certificate does not match the resolved signing identity hash',
    );
    expect(body).toContain('([[:xdigit:]]{40})');
    expect(body).toContain('multiple code-signing keys use the same identity name');
    expect(body).toContain('LOCKF_BIN="${DRIFTSTACK_LOCKF_BIN:-/usr/bin/lockf}"');
    expect(body).toContain('exec 9>"$INSTALL_LOCK_FILE"');
    expect(body).toContain('"$LOCKF_BIN" -s -t 0 9 || lock_status=$?');
    expect(body).toContain('if (( lock_status == 75 )); then');
    expect(body).toContain('required lock helper is unavailable');
    expect(body).toContain('exec 9>&-');
    expect(body).not.toMatch(/kill -0|INSTALL_LOCK_DIR\/pid/);
    expect(body).toContain('SRC_REQUIREMENT="$(verify_stable_signature');
    expect(body).toContain('DST_REQUIREMENT="$(verify_stable_signature');
    expect(body).toContain('if [[ "$SRC_REQUIREMENT" != "$DST_REQUIREMENT" ]]');
  });

  it('builds only the two app bundles consumed by the local installer', () => {
    const body = read('scripts/build-install-gui.sh');

    expect(body).toContain('for target in "tauri:build" "tauri:build:simulator"');
    expect(body).toContain('npm run "$target" -- --bundles app');
    expect(body).toContain('unset APPLE_SIGNING_IDENTITY APPLE_CERTIFICATE');
    expect(body).toContain('unset APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID');
    expect(body).toContain('unset APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH');
    expect(body).not.toContain('npm run "$target"\n');
    const signPair = body.indexOf('for name in "${BUNDLE_NAMES[@]}"');
    const pairReady = body.indexOf(
      'both source bundles are signed and verified; installing as one release pair',
    );
    const installPair = body.indexOf('for index in "${!BUNDLE_NAMES[@]}"');
    const firstRemoval = body.indexOf('rm -rf "$DST"');
    expect(signPair).toBeGreaterThan(-1);
    expect(pairReady).toBeGreaterThan(signPair);
    expect(installPair).toBeGreaterThan(pairReady);
    expect(firstRemoval).toBeGreaterThan(installPair);
  });

  it('signs and verifies both mocked source bundles before either installed app changes', () => {
    const result = runMockedBuildInstall({
      marker: CERT_FINGERPRINT,
      requestedIdentity: 'Driftstack Local Development Signing',
      args: [],
    });
    try {
      expect(result.result.status).toBe(0);
      expect(result.npmCalls.trim().split('\n')).toEqual([
        'run tauri:build -- --bundles app',
        'run tauri:build:simulator -- --bundles app',
      ]);
      expect(result.npmEnvCalls.trim().split('\n')).toEqual(['<clean>', '<clean>']);
      const events = result.events.trim().split('\n');
      const canarySigns = events.filter(
        (event) =>
          event.startsWith(`codesign --force --sign ${LOCAL_IDENTITY_HASH}`) &&
          event.includes('codesign-canary'),
      );
      const firstBuild = events.findIndex((event) => event.startsWith('npm run '));
      const firstInstall = events.findIndex((event) => event.startsWith('install '));
      const sourceSigns = events
        .slice(0, firstInstall)
        .filter((event) => event.startsWith('codesign --force --deep'));
      expect(canarySigns).toHaveLength(1);
      expect(events.indexOf(canarySigns[0]!)).toBeLessThan(firstBuild);
      expect(firstInstall).toBeGreaterThan(-1);
      expect(sourceSigns).toHaveLength(2);
      expect(sourceSigns[0]).toContain('Driftstack.app');
      expect(sourceSigns[1]).toContain('Driftstack Simulator.app');
      expect(result.installCalls.trim().split('\n')).toHaveLength(2);
      expect(result.result.stdout).toContain(
        'both source bundles are signed and verified; installing as one release pair',
      );
    } finally {
      result.cleanup();
    }
  });

  it('fails before build unless the exact local certificate authorization marker matches', () => {
    const ready = runMockedBuildInstall({ marker: CERT_FINGERPRINT });
    try {
      expect(ready.result.status).toBe(0);
      expect(ready.result.stdout).toContain(
        'prompt-free signing authorization: exact certificate marker + canary verified',
      );
      expect(ready.securityCalls).toContain(
        'find-certificate -c Driftstack Local Development Signing -p',
      );
      expect(ready.npmCalls).toBe('');
      expect(ready.codesignCalls).toContain(`--force --sign ${LOCAL_IDENTITY_HASH}`);
      expect(ready.codesignCalls).toContain('--verify --strict');
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

  it('invalidates a matching marker when the bounded real signing proof fails or waits', () => {
    for (const codesignMode of ['fail', 'hang'] as const) {
      const startedAt = Date.now();
      const blocked = runMockedBuildInstall({ marker: CERT_FINGERPRINT, codesignMode });
      try {
        expect(blocked.result.status).not.toBe(0);
        expect(blocked.result.stderr).toContain('prompt-free codesign proof failed');
        expect(blocked.result.stderr).toContain('Run scripts/setup-local-gui-signing.sh once');
        expect(blocked.result.stderr).toContain(
          'No GUI build, bundle codesign, or install work was started.',
        );
        expect(blocked.npmCalls).toBe('');
        expect(blocked.codesignCalls).toContain(`--force --sign ${LOCAL_IDENTITY_HASH}`);
        expect(blocked.markerExists).toBe(false);
        expect(Date.now() - startedAt).toBeLessThan(5_000);
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
      expect(result.codesignCalls).toContain(`--force --sign ${DEVELOPER_IDENTITY_HASH}`);
    } finally {
      result.cleanup();
    }
  });

  it('collapses identical identity hashes and rejects conflicting same-name keys before signing', () => {
    const duplicate = runMockedBuildInstall({ marker: CERT_FINGERPRINT });
    try {
      expect(duplicate.result.status).toBe(0);
      expect(duplicate.result.stdout).toContain(
        `Driftstack Local Development Signing (${LOCAL_IDENTITY_HASH})`,
      );
      expect(duplicate.codesignCalls).toContain(`--force --sign ${LOCAL_IDENTITY_HASH}`);
    } finally {
      duplicate.cleanup();
    }

    const conflict = runMockedBuildInstall({
      marker: CERT_FINGERPRINT,
      args: [],
      identityMode: 'conflict',
    });
    try {
      expect(conflict.result.status).not.toBe(0);
      expect(conflict.result.stderr).toContain(
        'multiple code-signing keys use the same identity name',
      );
      expect(conflict.codesignCalls).toBe('');
      expect(conflict.npmCalls).toBe('');
      expect(conflict.installCalls).toBe('');
    } finally {
      conflict.cleanup();
    }
  });

  it('refuses a concurrent installer before identity or private-key access', () => {
    const blocked = runMockedBuildInstall({
      marker: CERT_FINGERPRINT,
      args: [],
      lockState: 'active',
    });
    try {
      expect(blocked.result.status).not.toBe(0);
      expect(blocked.result.stderr).toContain('another Driftstack GUI build/install attempt');
      expect(blocked.securityCalls).toBe('');
      expect(blocked.codesignCalls).toBe('');
      expect(blocked.npmCalls).toBe('');
      expect(blocked.installCalls).toBe('');
    } finally {
      blocked.cleanup();
    }
  });

  it('reports lock-helper failure separately from an active installer', () => {
    const failed = runMockedBuildInstall({
      marker: CERT_FINGERPRINT,
      args: [],
      lockState: 'error',
    });
    try {
      expect(failed.result.status).not.toBe(0);
      expect(failed.result.stderr).toContain(
        'could not acquire the Driftstack GUI build/install lock (lockf exit 70)',
      );
      expect(failed.result.stderr).not.toContain('another Driftstack GUI build/install attempt');
      expect(failed.securityCalls).toBe('');
      expect(failed.codesignCalls).toBe('');
      expect(failed.npmCalls).toBe('');
      expect(failed.installCalls).toBe('');
    } finally {
      failed.cleanup();
    }
  });

  it('ignores an inert prior lock file because kernel ownership—not file existence—is authoritative', () => {
    const recovered = runMockedBuildInstall({
      marker: CERT_FINGERPRINT,
      args: ['--preflight'],
      lockState: 'stale',
    });
    try {
      expect(recovered.result.status).toBe(0);
      expect(recovered.result.stdout).toContain('prompt-free signing authorization');
      expect(recovered.codesignCalls).toContain(`--force --sign ${LOCAL_IDENTITY_HASH}`);
      expect(recovered.npmCalls).toBe('');
      expect(recovered.installCalls).toBe('');
    } finally {
      recovered.cleanup();
    }
  });

  it('creates a local-only identity without persisting a keychain password or plaintext secret', () => {
    const body = read('scripts/setup-local-gui-signing.sh');

    expect(body).toContain('Driftstack Local Development Signing');
    expect(body).toContain('security default-keychain -d user');
    expect(body).toContain('LOCKF_BIN="${DRIFTSTACK_LOCKF_BIN:-/usr/bin/lockf}"');
    expect(body).toContain('INSTALL_LOCK_FILE="$STATE_DIR/gui-build-install.lock"');
    expect(body).toContain('exec 9>"$INSTALL_LOCK_FILE"');
    expect(body).toContain('"$LOCKF_BIN" -s -t 0 9 || lock_status=$?');
    expect(body).toContain('exec 9>&-');
    expect(body.lastIndexOf('\nacquire_signing_lock\n')).toBeLessThan(
      body.indexOf('security default-keychain -d user'),
    );
    expect(body).toContain('list_signing_identity_records');
    expect(body).toContain('resolve_installed_identity_hash');
    expect(body).toContain('multiple code-signing keys use the same identity name');
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
    expect(body).toContain('READY_MARKER="$STATE_DIR/local-signing-partition-v2.sha256"');
    expect(body).toContain('LEGACY_READY_MARKER="$STATE_DIR/local-signing-partition-v1.sha256"');
    expect(body).toContain('openssl x509 -in "$certificate_file" -noout -fingerprint -sha256');
    expect(body).toContain('openssl x509 -in "$certificate_file" -noout -fingerprint -sha1');
    expect(body).toContain('authorization_marker_matches "$FINGERPRINT"');
    expect(body).toContain(
      'signing-key authorization already completed and canary-proven for this exact identity',
    );
    expect(body).toContain('verify_prompt_free_codesign "$IDENTITY_HASH"');
    expect(body).toContain('no readiness marker was written');
    expect(body).toContain('write_authorization_marker "$FINGERPRINT"');
    expect(body).toContain('chmod 700 "$STATE_DIR"');
    expect(body).toContain('chmod 600 "$marker_tmp"');
    expect(body).toContain(
      'write_authorization_marker "$(certificate_fingerprint "$CERT" "$IDENTITY_HASH")"',
    );
    expect(body).not.toMatch(/unlock-keychain| -A(?:\s|$)/);
    const partitionSetup = body.match(/configure_codesign_partition\(\) \{([\s\S]*?)\n\}/)?.[1];
    expect(partitionSetup).toBeDefined();
    expect(partitionSetup).not.toMatch(/^\s*-k(?:\s|$)/m);
    expect(body).not.toMatch(/KEYCHAIN_PASSWORD|APPLE_PASSWORD/);
  });

  it('refuses setup while the canonical installer owns the shared lock, before Keychain access', () => {
    const blocked = runMockedSignerSetup(CERT_FINGERPRINT, 'success', 'duplicates', 'active');
    try {
      expect(blocked.result.status).not.toBe(0);
      expect(blocked.result.stderr).toContain(
        'another Driftstack GUI signing/build/install attempt is already active',
      );
      expect(blocked.securityCalls).toBe('');
      expect(blocked.codesignCalls).toBe('');
      expect(blocked.marker).toBe(CERT_FINGERPRINT);
    } finally {
      blocked.cleanup();
    }
  });

  it('skips partition authorization only for the exact identity fingerprint', () => {
    const matching = runMockedSignerSetup(CERT_FINGERPRINT);
    try {
      expect(matching.result.status).toBe(0);
      expect(matching.result.stdout).toContain(
        'signing-key authorization already completed and canary-proven for this exact identity',
      );
      expect(matching.securityCalls).not.toContain('set-key-partition-list');
      expect(matching.marker).toBe(CERT_FINGERPRINT);
      expect(matching.codesignCalls).toContain(`--force --sign ${LOCAL_IDENTITY_HASH}`);
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

  it('refuses a conflicting setup identity name before partition or signing access', () => {
    const conflict = runMockedSignerSetup(CERT_FINGERPRINT, 'success', 'conflict');
    try {
      expect(conflict.result.status).not.toBe(0);
      expect(conflict.result.stderr).toContain(
        'multiple code-signing keys use the same identity name',
      );
      expect(conflict.securityCalls).not.toContain('find-certificate');
      expect(conflict.securityCalls).not.toContain('set-key-partition-list');
      expect(conflict.codesignCalls).toBe('');
    } finally {
      conflict.cleanup();
    }
  });

  it('never writes a readiness marker when setup cannot prove prompt-free signing', () => {
    for (const codesignMode of ['fail', 'hang'] as const) {
      const setup = runMockedSignerSetup('C3'.repeat(32), codesignMode);
      try {
        expect(setup.result.status).not.toBe(0);
        expect(setup.result.stderr).toContain('no readiness marker was written');
        expect(setup.securityCalls.match(/^set-key-partition-list /gm)).toHaveLength(1);
        expect(setup.marker).toBeUndefined();
      } finally {
        setup.cleanup();
      }
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
    expect(body).toContain('disposable copy of `/usr/bin/true`');
    expect(body).toContain('setup and installer share one descriptor-owned kernel lock');
    expect(body).toMatch(/acquired before\s+setup discovers the default Keychain/);
    expect(body).toContain('admits only one local build/sign/install attempt at a time');
    expect(body).toContain('`--preflight` is an optional first-setup or diagnostic check');
    expect(body).toContain('removes Apple certificate/signing/notarisation variables');
    expect(body).toContain('exactly the two final source-bundle signatures');
    expect(body).toMatch(/signs and verifies\s+both source bundles before replacing either/);
    expect(body).toMatch(/scopes the partition change to that\s+exact private key/);
    expect(body).toMatch(/requires the\s+`apple:` code-signing partition/);
    expect(body).toContain('without another password dialog');
    expect(body).toContain(
      'the script never reads, passes on a command line, or stores the password',
    );
    expect(body).toMatch(/requests\s+only\s+the macOS `\.app` target/);
    expect(body).toContain('cannot replace Developer ID signing/notarisation');
  });
});
