// Every retention / lifecycle sweep is wired unconditionally.
//
// These jobs are how the product keeps its published erasure and expiry
// promises. Putting one behind a feature flag couples a commitment to something
// unrelated, and it fails in the quietest possible way: a job that is never
// registered logs nothing, throws nothing, and leaves the suite green. Nobody
// finds out until someone asks why data from a year ago is still there.
//
// This is not a hypothetical style rule. The account-deletion purge WAS gated
// on the BYOK service being wired, which was correct while the BYOK key was the
// only thing it erased. Two more §9 commitments were later hung off that same
// sweeper — proxy credentials, wrapped under a different key, and profiles and
// snapshots, which need no key at all — and the gate silently became "an unset
// MFA_ENCRYPTION_KEY switches off three retention promises".
//
// The convention already existed and was already written down: the crypto
// entitlement-expiry sweep carries a comment saying it is "Wired
// UNCONDITIONALLY (not behind the crypto/IPN config gate)" because backfilled
// entitlements must expire even where the intake path is unconfigured. It just
// was not checkable. Now it is.
//
// Deliberately structural rather than a source-text pin: the check is whether a
// registration sits inside a conditional, which is a property of the code's
// shape, not of how any line is spelled.
//
// V-759 — the scan is FAIL-CLOSED, and that is a correction. It used to match
// only names shaped `register*(Sweep|Purge|Reap|Prune)*Job(`, which made a new
// retention job exempt by DEFAULT: adding `registerRetentionScrubJob` (the
// privacy-policy §9 anonymisation sweep) left this file green while the job it
// was written to protect was invisible to it. A guard against a silent absence
// must not itself go silent when the thing it guards is renamed. So every
// `register*Job(` is now in scope, and anything claimed NOT to be a retention
// job needs an explicit entry with a reason.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const BOOTSTRAP = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'lib',
  'bootstrap.ts',
);

/**
 * EVERY recurring-job registration. Deliberately not narrowed by name shape —
 * see the V-759 note above for what narrowing cost.
 */
const ANY_JOB_RE = /register(\w+)Job\(/;

/**
 * Registrations that are genuinely not retention or lifecycle work, each with
 * the reason. This list is the only way out of the check, so adding a job whose
 * name does not look like a sweep still gets checked unless someone states here
 * why it keeps no data promise.
 */
const NOT_A_RETENTION_JOB: Record<string, string> = {
  CostNightlyJob:
    'Cost-threshold evaluation and notification. Reads usage and dispatches alerts; ' +
    'deletes, expires and anonymises nothing, so no retention promise depends on it.',
};

/**
 * A registration whose enclosing scope is a conditional or a loop, rather than
 * the bootstrap body itself.
 *
 * Determined by brace depth relative to the function body: bootstrap's own
 * statements sit at one level of indentation, so anything deeper is inside
 * something. Cheaper and more robust than parsing, and it cannot be defeated by
 * reformatting the way a text pin can.
 */
interface Registration {
  readonly line: number;
  readonly name: string;
  readonly indent: number;
}

/** Every `register*Job(` in bootstrap, retention or not. */
function allRegistrations(): Registration[] {
  const lines = readFileSync(BOOTSTRAP, 'utf8').split('\n');
  const out: Registration[] = [];
  lines.forEach((line, i) => {
    const name = ANY_JOB_RE.exec(line)?.[1];
    if (name === undefined) return;
    out.push({ line: i + 1, name: `${name}Job`, indent: line.length - line.trimStart().length });
  });
  return out;
}

/**
 * Jobs deliberately armed inside a conditional, each with the reason its
 * capability genuinely does not exist in some deployments. Empty today: every
 * retention sweep is unconditional. An entry here is a claim that the promise
 * itself does not apply when the flag is off — not that the flag is convenient.
 */
const CONDITIONAL_BY_DESIGN: Record<string, string> = {};

describe('retention and lifecycle sweeps are wired unconditionally', () => {
  const all = allRegistrations();
  const found = all.filter((r) => NOT_A_RETENTION_JOB[r.name] === undefined);

  it('CRITICAL the scan found the retention registrations. An empty scan would make the check below vacuously true — and the failure this guards against is itself a silent absence, so a silent scan failure would be doubly useless.', () => {
    expect(found.length, 'retention/lifecycle job registrations in bootstrap').toBeGreaterThan(5);
    const names = found.map((r) => r.name);
    expect(names, 'the account-deletion purge must be among them').toContain(
      'AccountDeletionPurgeJob',
    );
    expect(names, 'so must the profile trash purge').toContain('ProfileTrashPurgeJob');
    // Named explicitly because this job is why the scan was widened: its name
    // matched none of the old Sweep/Purge/Reap/Prune shapes, so it enforced a
    // published §9 window while being invisible to the check protecting it.
    expect(names, 'so must the privacy §9 retention scrub (V-759)').toContain('RetentionScrubJob');
  });

  it('CRITICAL every non-retention exemption still names a registered job, and states a reason. A stale or blank entry is a permanent hole in a fail-closed list.', () => {
    const registered = new Set(all.map((r) => r.name));
    const stale = Object.keys(NOT_A_RETENTION_JOB)
      .filter((n) => !registered.has(n))
      .sort();
    expect(stale, 'NOT_A_RETENTION_JOB entr(ies) for jobs that no longer exist:').toEqual([]);

    const unexplained = Object.entries(NOT_A_RETENTION_JOB)
      .filter(([, reason]) => reason.trim().length < 40)
      .map(([n]) => n)
      .sort();
    expect(unexplained, 'exemption(s) without a real stated reason:').toEqual([]);
  });

  it('CRITICAL no retention sweep is armed inside a conditional. A job that is never registered logs nothing and throws nothing, so a flag that switches one off is invisible until someone asks why year-old data is still there.', () => {
    const gated = found
      .filter((r) => r.indent > 2)
      .filter((r) => CONDITIONAL_BY_DESIGN[r.name] === undefined)
      .map((r) => `${r.name} (bootstrap.ts:${r.line}, indent ${r.indent})`);

    expect(
      gated.sort(),
      'retention sweep(s) armed inside a conditional — hoist them, or add them to CONDITIONAL_BY_DESIGN with the reason the promise does not apply when the flag is off:',
    ).toEqual([]);
  });

  it('CRITICAL the exemption list may only SHRINK — an entry that becomes unconditional must leave it, and an entry naming a job that no longer exists must go too.', () => {
    const names = new Set(found.map((r) => r.name));
    const nowUnconditional = Object.keys(CONDITIONAL_BY_DESIGN)
      .filter((n) => found.some((r) => r.name === n && r.indent === 2))
      .sort();
    expect(
      nowUnconditional,
      'these are unconditional now — remove them from CONDITIONAL_BY_DESIGN:',
    ).toEqual([]);

    const stale = Object.keys(CONDITIONAL_BY_DESIGN)
      .filter((n) => !names.has(n))
      .sort();
    expect(stale, 'exemption(s) for jobs that are no longer registered:').toEqual([]);
  });
});
