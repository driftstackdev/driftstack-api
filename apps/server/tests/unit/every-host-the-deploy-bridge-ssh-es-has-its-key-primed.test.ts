import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The deploy pipeline was dead for seven weeks and said nothing useful.
 *
 * `deploy-bridge.sh`'s staging pre-flight SSHes to BOTH hosts — it reads
 * `DATABASE_URL` from prod and from staging and refuses if they share a Neon
 * project (a real 2026-07-12 incident: a staging migration ran against prod).
 * But `deploy.yml`'s staging job primed `known_hosts` with the STAGING host
 * only. The prod read therefore died on "Host key verification failed", the
 * guard's `2>/dev/null` discarded that, the value read as empty, and the guard
 * refused.
 *
 * Result: last green deploy 2026-07-12, then 18 consecutive failures, production
 * 72 commits stale, and the AI chat returning 400 to customers because prod
 * predated the model enum it was being sent.
 *
 * ⭐ The two files were each self-consistent. The defect lived in the gap: a
 * script that reaches a host, and a job that never told SSH about it. So this
 * guard derives the hosts from the SCRIPT and checks the WORKFLOW primes them —
 * it never lists them itself, or it goes blind on the third host.
 */

const REPO = resolve(__dirname, '../../../..');
const bridge = readFileSync(resolve(REPO, 'scripts/deploy-bridge.sh'), 'utf8');
const workflow = readFileSync(resolve(REPO, '.github/workflows/deploy.yml'), 'utf8');

/** Every IPv4 literal the bridge opens an SSH/SCP connection to. */
function hostsTheBridgeConnectsTo(script: string): string[] {
  const hosts = new Set<string>();
  for (const m of script.matchAll(/run_(?:ssh|scp)\s+"?(?:root@)?(\d{1,3}(?:\.\d{1,3}){3})/g)) {
    if (m[1] !== undefined) hosts.add(m[1]);
  }
  // The `$HOST` form resolves from the case statement at the top; collect those
  // literals too, since that is the same connection by another name.
  for (const m of script.matchAll(/HOST="(\d{1,3}(?:\.\d{1,3}){3})"/g)) {
    if (m[1] !== undefined) hosts.add(m[1]);
  }
  return [...hosts].sort();
}

/**
 * Every IPv4 literal primed into known_hosts *by the job that runs the staging
 * bridge*.
 *
 * ⛔ SCOPED TO THAT JOB ON PURPOSE. A whole-file scan finds 128.140.37.74 in the
 * PROD job's own priming step and concludes it is covered — which is false: jobs
 * get fresh runners, so the prod job's known_hosts does nothing for the staging
 * job. Mutation-proved: with a whole-file scan, reverting the fix left all arms
 * green. The window is what makes this guard real.
 */
function hostsPrimedForTheStagingBridge(yaml: string): string[] {
  const start = yaml.indexOf('Configure SSH for Hetzner staging host');
  const end = yaml.indexOf('deploy-bridge.sh staging', start);
  if (start === -1 || end === -1 || end < start) return [];
  const window = yaml.slice(start, end);
  const primed = new Set<string>();
  // `host=<ip>` and `for host in <ip> <ip>` are the two forms in use.
  for (const m of window.matchAll(/host=(\d{1,3}(?:\.\d{1,3}){3})/g)) {
    if (m[1] !== undefined) primed.add(m[1]);
  }
  for (const m of window.matchAll(/for host in ([^\n;]+)/g)) {
    for (const ip of (m[1] ?? '').match(/\d{1,3}(?:\.\d{1,3}){3}/g) ?? []) primed.add(ip);
  }
  return [...primed].sort();
}

describe('every host the deploy bridge SSHes to has its key primed', () => {
  const connects = hostsTheBridgeConnectsTo(bridge);
  const primed = hostsPrimedForTheStagingBridge(workflow);

  it('finds hosts on both sides, or this guard asserts nothing', () => {
    // Non-vacuity: two regexes that silently match nothing would make the
    // subset check below trivially true — the same shape as the bug.
    expect(connects.length, 'no SSH targets parsed out of deploy-bridge.sh').toBeGreaterThanOrEqual(
      2,
    );
    expect(
      primed.length,
      'no ssh-keyscan hosts parsed out of the staging job window in deploy.yml',
    ).toBeGreaterThanOrEqual(2);
  });

  it.each(hostsTheBridgeConnectsTo(bridge))('%s is primed into known_hosts', (host) => {
    expect(
      primed,
      `deploy-bridge.sh opens an SSH connection to ${host}, but deploy.yml never runs ssh-keyscan for it. ` +
        `That call will die on "Host key verification failed" — which is how the pipeline stayed broken from 2026-07-12.`,
    ).toContain(host);
  });

  it('uses no BSD-only shell idioms — it is written on macOS and RUNS on ubuntu', () => {
    // ⛔ `mktemp -t <name>` diverges: BSD/macOS treats the argument as a PREFIX,
    // GNU/coreutils as a TEMPLATE and errors "too few X's in template". The
    // script is hand-run on macOS and executes on an ubuntu runner, so this
    // passed every local test and died the first time the bundle path actually
    // ran in CI — which only happened once DEPLOY_VIA_BUNDLE was switched on,
    // long after the code was written.
    //
    // ⚠️ Comments are STRIPPED first. The prose explaining the trap contains the
    // very string being banned, and a naive grep flags the fix as the defect.
    const code = bridge
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    expect(code, 'mktemp -t is BSD-only; use an explicit XXXXXX template').not.toMatch(
      /mktemp\s+-t\s/,
    );
    // Non-vacuity: the strip must not have eaten the whole file.
    expect(code).toContain('mktemp');
    expect(code.length).toBeGreaterThan(1000);
  });

  it('any job that bundles the repo checks out FULL history', () => {
    // ⛔ `git bundle create` from a SHALLOW clone produces a bundle the far side
    // cannot clone — it dies "Failed to traverse parents" / "remote did not send
    // all necessary objects". actions/checkout defaults to fetch-depth 1, so the
    // bundle path was broken the moment DEPLOY_VIA_BUNDLE was switched on, and
    // deploy-bridge.sh's own comment claiming the bundle "carries full
    // origin/main history" was false in CI while being true on a laptop.
    //
    // Scoped per job: the source-map job never bundles and needs no history.
    //
    // ⚠️ An INVOCATION, not a mention: the file header and the source-map job both
    // discuss deploy-bridge.sh in prose, and matching the bare string flags two
    // jobs that never run it. Comment lines are dropped before the check.
    const jobs = workflow.split(/\n {2}(?=[a-z0-9-]+:\n)/);
    const invokes = (job: string): boolean =>
      job
        .split('\n')
        .filter((line) => !/^\s*#/.test(line))
        .some((line) => /bash\s+scripts\/deploy-bridge\.sh/.test(line));
    const bundling = jobs.filter(invokes);
    expect(bundling.length, 'no job invokes deploy-bridge.sh — the split is wrong').toBe(2);
    for (const job of bundling) {
      expect(job, 'a job that runs deploy-bridge.sh must checkout with fetch-depth: 0').toContain(
        'fetch-depth: 0',
      );
    }
  });

  it('the staging DB-isolation guard reports WHY it could not read a host', () => {
    // The refusal was correct; it was unclearable because the reason went to
    // /dev/null. "prod host present = no" reads identically whether sshd is
    // down, the key is wrong, the host key is unknown, or the var was renamed.
    expect(bridge).not.toMatch(/DATABASE_URL[^\n]*\n\s*"[^\n]*\n?\s*2>\/dev\/null \|\| echo ""/);
    expect(bridge).toContain('why prod could not be read');
    expect(bridge).toContain('why staging could not be read');
  });
});
