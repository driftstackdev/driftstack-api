// `deploy-status.sh` printed the running SHA for months and never judged it.
//
// Found the hard way. Production was serving a build from 2026-07-15 — 982 commits
// behind HEAD — and nothing said so. The snapshot line
//
//   /version           : git_sha=443d0a377 uptime=… (since …)
//
// had been correct and useless the whole time: a datum nobody reads is not a signal.
// It surfaced only because a customer incident was harder to diagnose than it should
// have been, and the reason turned out to be that a log field committed a month
// earlier had never shipped.
//
// ── measured against production, three independent ways ───────────────────────
//
// The SHA is a label written at deploy time, so a stale label could have explained
// the first signal on its own. It did not:
//
//   /version                     git_sha 443d0a377 (2026-07-15), started 2026-07-29
//   GET /v1/status               three-field body — `open_incidents` and
//                                `incident_data_complete` absent, both live since V-796
//   GET /v1/profiles (no auth)   401 with NO `WWW-Authenticate`, which 7db4eede9 added
//
// The running binary really did predate all of it. 189 commits to apps/server/src were
// stranded, 96 of them reading as customer-visible fixes.
//
// So `--check` gained a third assertion beside migration drift and the activation
// flags, and this file is what proves the assertion can fail. The computation lives in
// a `compute_build_age` shell function with a `--build-age <sha>` entry point that does
// no network and no SSH, for one reason: a test that regexed this script would pin the
// TEXT of a comparison and could never establish that the comparison works. That is the
// exact failure mode the stale snapshot line already demonstrated once.
//
// ⚠️ The `?`-on-unknown behaviour is the load-bearing half. A shallow clone that
// reported `0 commits behind` would read as the healthiest possible answer while
// knowing nothing at all, so an unresolvable SHA has to be distinguishable from an
// up-to-date one — and `--check` fails on it rather than passing.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SCRIPT = resolve(REPO_ROOT, 'scripts/deploy-status.sh');

/** Drive the real script's no-network entry point. */
function buildAge(sha: string): { behind: string; built: string } {
  const out = execFileSync('bash', [SCRIPT, '--build-age', sha], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  }).trim();
  const [behind, built] = out.split(/\s+/);
  return { behind: behind ?? '', built: built ?? '' };
}

function gitOut(args: string[]): string {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

describe('a deploy snapshot that does not judge the sha is not a check', () => {
  it('CRITICAL HEAD reports ZERO commits behind. Every other arm here reports a NON-zero or unknown answer, and an implementation that always said "far behind" would satisfy them while being useless — this is the arm that makes the rest mean something, and it is also the answer a healthy deploy must produce.', () => {
    const { behind, built } = buildAge('HEAD');
    expect(behind, 'HEAD is not zero commits behind itself').toBe('0');
    expect(built, 'no build date was derived for HEAD').toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('CRITICAL an OLDER commit reports the real distance, derived from git rather than restated. A hardcoded expectation here would rot into a second copy of the number the script is supposed to compute.', () => {
    const older = gitOut(['rev-parse', '--short', 'HEAD~5']);
    const expected = gitOut(['rev-list', '--count', `${older}..HEAD`]);
    const { behind, built } = buildAge(older);
    expect(behind, `build age for ${older} disagreed with git`).toBe(expected);
    expect(Number(behind), 'an older commit reported as not behind at all').toBeGreaterThan(0);
    expect(built).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('CRITICAL an UNKNOWN sha reports "?" and NOT zero. This is the half that carries the weight: a shallow or stale clone that answered "0 commits behind" would be reporting the healthiest possible result while knowing nothing, and the check below refuses that answer precisely because it cannot be distinguished from a good one by a human skimming output.', () => {
    const { behind, built } = buildAge('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    expect(behind, 'an unresolvable sha did not report unknown').toBe('?');
    expect(built, 'an unresolvable sha invented a build date').toBe('?');
  });

  it('CRITICAL an EMPTY or absent sha is unknown too, not zero. `--build-age` with no argument, and the "?" the /version parse falls back to when the endpoint is unreachable, both land here — an unreachable server must not read as an up-to-date one.', () => {
    expect(buildAge('?').behind, 'the /version fallback sentinel resolved to a distance').toBe('?');
    const bare = execFileSync('bash', [SCRIPT, '--build-age'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 30_000,
    }).trim();
    expect(bare, 'a missing sha argument produced a distance').toBe('? ?');
  });

  it('CRITICAL --check FAILS on both an unknown sha and an over-threshold distance, and the threshold is overridable. Without the failure branches the number is just another line of output — which is the state this whole file exists to end.', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    // The two refusals, and the fact that each raises the shared failure flag the
    // migration-drift and activation-flag assertions already use.
    const checkBlock = /if \[ "\$BEHIND" = "\?" \]; then[\s\S]{0,600}?CHECK_FAIL=1/.exec(src);
    expect(checkBlock, 'the unknown-sha refusal is gone from --check').not.toBeNull();
    expect(
      /elif \[ "\$BEHIND" -gt "\$MAX_BEHIND" \]; then[\s\S]{0,400}?CHECK_FAIL=1/.test(src),
      'the over-threshold refusal is gone from --check',
    ).toBe(true);
    expect(
      /MAX_BEHIND="\$\{DEPLOY_MAX_BEHIND:-\d+\}"/.test(src),
      'the threshold stopped being overridable, so an operator mid release train has to learn to ignore a red',
    ).toBe(true);
  });

  it('the build age reaches the machine-readable output too. --json is what a cron or dashboard consumes, and a staleness signal only humans can see is the same defect in a different place.', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src, '--json no longer carries the build age').toContain('"commits_behind_head":"%s"');
    expect(src, '--json no longer carries the build date').toContain('"built_on":"%s"');
    expect(src, 'the human snapshot no longer prints the build age').toContain('build age');
  });
});
