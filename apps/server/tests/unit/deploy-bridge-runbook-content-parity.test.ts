// Drift-guard for docs/runbooks/deploy-bridge.md. Pins claims that
// previously rotted (invariant count drifted from 8 → 10 silently
// while the runbook kept saying 8). When post-deploy-verify.mjs gains
// or loses a check, or revert-bridge.sh gains/loses a flag, the
// runbook must be updated in the same PR.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..', '..', '..');
const RUNBOOK = join(REPO, 'docs', 'runbooks', 'deploy-bridge.md');
const VERIFY = join(REPO, 'scripts', 'post-deploy-verify.mjs');
const REVERT = join(REPO, 'scripts', 'revert-bridge.sh');
const STATUS = join(REPO, 'scripts', 'deploy-status.sh');
const BRIDGE = join(REPO, 'scripts', 'deploy-bridge.sh');
const MIGRATE = join(REPO, 'apps', 'server', 'src', 'db', 'migrate.ts');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function runVerifierWithVersion(version: string) {
  const source = `
    import { pathToFileURL } from 'node:url';
    process.argv = ['node', ${JSON.stringify(VERIFY)}, '--base-url', 'https://example.test'];
    globalThis.fetch = async (input) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === '/version') {
        return new Response(JSON.stringify({
          version: ${JSON.stringify(version)},
          git_sha: 'abc1234',
          started_at: new Date().toISOString(),
          node_version: process.version,
          driver: 'mock',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    await import(pathToFileURL(${JSON.stringify(VERIFY)}).href + '?version-verifier-test');
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' });
}

describe('deploy-bridge runbook content parity', () => {
  const runbook = read(RUNBOOK);
  const verify = read(VERIFY);
  const revert = read(REVERT);
  const status = read(STATUS);
  const bridge = read(BRIDGE);
  const migrate = read(MIGRATE);

  it('fails closed before a staging deploy when staging and production DB hosts match', () => {
    expect(bridge).toMatch(/if \[ "\$PROD_DB_HOST" = "\$STAGING_DB_HOST" \]; then/);
    expect(bridge).toMatch(/ERROR: staging\+prod DBs match — refusing staging deploy/);
    expect(bridge).toMatch(/DEPLOY_SKIP_STAGING_DB_ISOLATION_CHECK/);
    const refusal = bridge.indexOf('ERROR: staging+prod DBs match');
    const exit = bridge.indexOf('exit 3', refusal);
    const clone = bridge.indexOf('cloning…');
    expect(refusal).toBeGreaterThan(-1);
    expect(exit).toBeGreaterThan(refusal);
    expect(clone).toBeGreaterThan(exit);
  });

  it('also fails closed when either live DB host cannot be read', () => {
    expect(bridge).toMatch(/if \[ -z "\$PROD_DB_HOST" \] \|\| \[ -z "\$STAGING_DB_HOST" \]; then/);
    expect(bridge).toMatch(
      /ERROR: could not verify staging DB isolation — refusing staging deploy/,
    );
  });

  it('publishes the checked-out server package version and rejects runtime placeholders', () => {
    expect(bridge).toMatch(
      /APP_VERSION=\\\$\(node -p \\"require\('\.\/apps\/server\/package\.json'\)\.version\\"\)/,
    );
    expect(bridge).toMatch(/invalid server package version/);
    expect(bridge).toMatch(/sed -i '\/\^APP_VERSION=\/d' \/opt\/driftstack\/api\/\.env/);
    expect(bridge).toMatch(
      /echo \\"APP_VERSION=\\\$APP_VERSION\\" >> \/opt\/driftstack\/api\/\.env/,
    );
    expect(verify).toContain("['', 'unknown', '0.0.0'].includes(body.version.trim())");

    const placeholder = runVerifierWithVersion('0.0.0');
    expect(placeholder.status).toBe(1);
    expect(`${placeholder.stdout}${placeholder.stderr}`).toContain(
      '/version contains placeholder build version "0.0.0"',
    );

    const real = runVerifierWithVersion('0.0.1');
    expect(real.status).toBe(1); // Other deliberately invalid mocked endpoints still fail.
    expect(`${real.stdout}${real.stderr}`).not.toContain('placeholder build version');
  });

  it('runbook invariant count matches the post-deploy-verify.mjs checks[] length', () => {
    // checks[] in post-deploy-verify.mjs is a flat array literal of
    // function refs (or null for conditional). Count `check…,` entries.
    // The conditional `expectedSha ? checkVersionMatchesSha : null` is
    // included in the published count because deploy-bridge always
    // passes --expected-sha.
    const block = verify.match(/const checks = \[([\s\S]*?)\];/);
    const inner = block?.[1];
    expect(inner).toBeDefined();
    const checkCount = (inner!.match(/check[A-Z]\w+/g) ?? []).length;

    expect(checkCount).toBeGreaterThanOrEqual(10);

    const runbookCount = runbook.match(/(\d+)\s+post-deploy-verify invariants/);
    expect(runbookCount?.[1]).toBeDefined();
    expect(Number(runbookCount![1])).toBe(checkCount);
  });

  it('runbook documents the --to-sha operator override iff revert-bridge.sh implements it', () => {
    const scriptHasFlag = /--to-sha/.test(revert);
    const docHasFlag = /--to-sha/.test(runbook);
    expect(docHasFlag).toBe(scriptHasFlag);
  });

  it('runbook documents --dry-run iff revert-bridge.sh implements it', () => {
    const scriptHasFlag = /--dry-run/.test(revert);
    const docHasFlag = /--dry-run/.test(runbook);
    expect(docHasFlag).toBe(scriptHasFlag);
  });

  it('runbook documents migration-drift detection iff deploy-status.sh implements it', () => {
    const scriptHasDrift = /DRIFT expected=/.test(status);
    const docHasDrift = /DRIFT expected=/.test(runbook);
    expect(docHasDrift).toBe(scriptHasDrift);
  });

  it('runbook references the migrate.ts post-condition iff migrate.ts implements it', () => {
    const codeHasPostCondition =
      /post-condition/.test(migrate) && /process\.exit\(2\)/.test(migrate);
    const docHasPostCondition = /post-condition/.test(runbook) && /exit 2/.test(runbook);
    expect(docHasPostCondition).toBe(codeHasPostCondition);
  });

  it('runbook states how many refusals --check can emit, derived from the script. Written after adding a third and fourth condition to --check and leaving the runbook describing two — the drift was invisible because the existing arms pin the FLAG LIST, which that change did not touch.', () => {
    // Count the distinct `[check] FAIL` emissions rather than the assertion
    // blocks: one block can refuse for more than one reason (the build-age block
    // refuses separately for "unknown sha" and "too far behind"), and it is the
    // reasons an operator has to recognise, not the ifs.
    const refusals = (status.match(/\[check\] FAIL/g) ?? []).length;
    expect(refusals, 'the --check refusals vanished from deploy-status.sh').toBeGreaterThanOrEqual(
      4,
    );

    // EVERY occurrence, not the first. The runbook states the number twice — the
    // TL;DR line and the prose below it — and a first-match regex passed happily
    // while the second said something else, which is the same one-of-N hole the
    // guard is meant to close.
    const claimed = [...runbook.matchAll(/(\d+)\s*--check refusals/g)].map((m) => Number(m[1]));
    expect(
      claimed.length,
      'the runbook no longer states how many refusals --check emits',
    ).toBeGreaterThanOrEqual(2);
    expect(
      claimed.filter((n) => n !== refusals),
      `deploy-status.sh emits ${String(refusals)} --check refusals; the runbook claims ${JSON.stringify(claimed)}`,
    ).toEqual([]);
  });

  it('runbook names the build-age refusals specifically, including the override. A count alone would let a condition be swapped for another without notice, and the threshold being overridable is the part an operator mid release train needs to find.', () => {
    expect(status, 'the build-age threshold stopped being overridable').toMatch(
      /DEPLOY_MAX_BEHIND:-\d+/,
    );
    expect(runbook, 'the runbook does not name the build-age override').toContain(
      'DEPLOY_MAX_BEHIND',
    );
    expect(runbook, 'the runbook does not describe the unknown-sha refusal').toMatch(
      /unknown to this checkout/,
    );
  });

  it('runbook names the canonical activation flags monitored by --check', () => {
    // deploy-status.sh --check iterates over these four flags. If a
    // flag is added/removed there, the runbook list must follow.
    const scriptFlags = status.match(/for flag in ([\w ]+); do/);
    const flagsBlock = scriptFlags?.[1];
    expect(flagsBlock).toBeDefined();
    const flags = (flagsBlock ?? '').trim().split(/\s+/);
    for (const flag of flags) {
      expect(runbook).toMatch(new RegExp(`\\b${flag}\\b`));
    }
  });
});
