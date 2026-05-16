// Drift-guard for docs/runbooks/deploy-bridge.md. Pins claims that
// previously rotted (invariant count drifted from 8 → 10 silently
// while the runbook kept saying 8). When post-deploy-verify.mjs gains
// or loses a check, or revert-bridge.sh gains/loses a flag, the
// runbook must be updated in the same PR.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..', '..', '..');
const RUNBOOK = join(REPO, 'docs', 'runbooks', 'deploy-bridge.md');
const VERIFY = join(REPO, 'scripts', 'post-deploy-verify.mjs');
const REVERT = join(REPO, 'scripts', 'revert-bridge.sh');
const STATUS = join(REPO, 'scripts', 'deploy-status.sh');
const MIGRATE = join(REPO, 'apps', 'server', 'src', 'db', 'migrate.ts');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('deploy-bridge runbook content parity', () => {
  const runbook = read(RUNBOOK);
  const verify = read(VERIFY);
  const revert = read(REVERT);
  const status = read(STATUS);
  const migrate = read(MIGRATE);

  it('runbook invariant count matches the post-deploy-verify.mjs checks[] length', () => {
    // checks[] in post-deploy-verify.mjs is a flat array literal of
    // function refs (or null for conditional). Count `check…,` entries.
    // The conditional `expectedSha ? checkVersionMatchesSha : null` is
    // included in the published count because deploy-bridge always
    // passes --expected-sha.
    const block = verify.match(/const checks = \[([\s\S]*?)\];/);
    expect(block).not.toBeNull();
    const inner = block![1];
    const checkCount = (inner.match(/check[A-Z]\w+/g) ?? []).length;

    expect(checkCount).toBeGreaterThanOrEqual(10);

    const runbookCount = runbook.match(/(\d+)\s+post-deploy-verify invariants/);
    expect(runbookCount).not.toBeNull();
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

  it('runbook names the canonical activation flags monitored by --check', () => {
    // deploy-status.sh --check iterates over these four flags. If a
    // flag is added/removed there, the runbook list must follow.
    const scriptFlags = status.match(/for flag in ([\w ]+); do/);
    expect(scriptFlags).not.toBeNull();
    const flags = scriptFlags![1].trim().split(/\s+/);
    for (const flag of flags) {
      expect(runbook).toMatch(new RegExp(`\\b${flag}\\b`));
    }
  });
});
