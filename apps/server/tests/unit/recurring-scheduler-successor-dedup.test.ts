// Every recurring sweep enqueues its successor with future-successor dedup, so
// a re-arm cannot fan out into duplicate parallel chains.
//
// The roster below listed nine. The server registers twelve: crypto-entitlement-
// reconcile, daily-maintenance and retention-scrub were never checked. All three
// satisfy the invariant today — this was an unenforced state, not a live defect —
// but a regression in any of them would have gone unnoticed, and the reconciler
// is the path that recovers paid crypto customers whose entitlement never landed.
//
// So the consumers are DISCOVERED from the `register*Job` export convention and
// the roster must cover what discovery finds. The roster is kept because naming
// the members is what makes a REMOVAL deliberate; it just no longer decides the
// population on its own.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICES = resolve(HERE, '..', '..', 'src', 'services');

/** Service files that register a recurring job, read from the source. */
const DISCOVERED: readonly string[] = readdirSync(SERVICES)
  .filter((f) => f.endsWith('.ts'))
  .filter((f) =>
    /export function register\w*Job\(/.test(readFileSync(resolve(SERVICES, f), 'utf8')),
  )
  .sort();

const RECURRING_CONSUMERS = [
  'oauth-retention-sweeper.ts',
  'auth-flows-sweeper.ts',
  'session-duration-sweeper.ts',
  'scheduled-jobs-prune-sweeper.ts',
  'crypto-entitlement-expiry-sweeper.ts',
  'profile-trash-purge-sweeper.ts',
  'account-deletion-purge-sweeper.ts',
  'agent-session-orphan-sweeper.ts',
  'cost-nightly-job.ts',
  'crypto-entitlement-reconcile-sweeper.ts',
  'daily-maintenance-jobs.ts',
  'retention-scrub-sweeper.ts',
] as const;

describe('recurring scheduled-job successor dedup invariant', () => {
  it('CRITICAL the discovery found the registrars, so the loop below is not empty', () => {
    expect(
      DISCOVERED.length,
      'no register*Job services were discovered — the convention changed and this invariant now ' +
        'covers nothing',
    ).toBeGreaterThanOrEqual(12);
  });

  it('CRITICAL the roster covers every service that registers a recurring job', () => {
    // The check that would have caught the three this file silently skipped.
    const listed = new Set<string>(RECURRING_CONSUMERS);
    const missing = DISCOVERED.filter((f) => !listed.has(f));
    expect(
      missing,
      'a service registers a recurring job but is absent from RECURRING_CONSUMERS, so its ' +
        'successor-dedup is never asserted — a re-arm that stops deduping fans out into duplicate ' +
        'parallel chains, and nothing here would notice',
    ).toEqual([]);
  });

  for (const filename of DISCOVERED) {
    it(`${filename} passes the current run-time boundary and never disables dedup`, () => {
      const body = readFileSync(resolve(SERVICES, filename), 'utf8');
      expect(body).toMatch(/currentRunAt: job\.runAt,/);
      expect(body).toMatch(/dedupOnAccountAndType: true,/);
      expect(body).toMatch(/dedupAfterRunAt: opts\.currentRunAt/);
      expect(body).not.toMatch(/dedupOnAccountAndType:\s*false/);
      expect(body).not.toMatch(/dedup:\s*false/);
    });
  }
});
