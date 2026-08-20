// V-1201 — every array-returning read without an ORDER BY is one somebody reviewed.
//
// A Postgres SELECT with no ORDER BY has NO guaranteed row order. An in-memory double returns
// insertion order, every time, for free. So a unit test that asserts an order passes against the
// double and promises something the shipping query does not provide — the V-1197 shape again,
// with the double supplying a guarantee rather than a predicate.
//
// The order-sensitive failures are quiet ones: a list that reorders between page loads, a
// last-write-wins index whose winner changes per request, a `.find()` that picks a different row.
// None of them throw.
//
// This is not a rule that reads need ORDER BY. Most of these genuinely do not: an id list fed to
// a purge job, a fan-out that mails everyone, an aggregate immediately keyed into a Map. The rule
// is that each one is REVIEWED — the allowlist below records what was checked and why it is safe,
// so a read added next month has to earn its place rather than inherit the silence.
//
// Every entry was verified against its consumers on 2026-08-20, and two entries did NOT survive
// that review: `oauth-links-repo.listForAccount` and `email-preferences-repo.list` both render
// straight to a customer, so both gained an ORDER BY in the same commit as this file. Their
// absence from this list is the point — the allowlist holds the reads that were examined and
// cleared, not the ones nobody had gotten to.
//
// Five of the twelve looked like defects and were closed by a UNIQUE constraint rather than by
// the query: a contested key is what makes arbitrary order observable, and a unique index means
// there is no contest. That reasoning is per-entry below because it is exactly what a future
// reader would otherwise have to re-derive.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DB_DIR = resolve(REPO_ROOT, 'apps/server/src/db');

/**
 * Reviewed 2026-08-20. Key is `file::method`; the value is why arbitrary order is unobservable
 * there. Removing an entry is as much a review as adding one — a stale entry means the method is
 * gone and the reasoning no longer describes anything.
 */
const REVIEWED: Record<string, string> = {
  'account-deletion-purge-repo.ts::findDeletedAccountIdsWithByokKeyBefore':
    'string[] handed to the purge sweeper, which processes every id it is given',
  'agent-sessions-repo.ts::listActivePairModeSessionIds':
    'id list iterated in full by the bootstrap unpark loop',
  'auth-repo.ts::findActiveRateLimitOverrides':
    'indexOverrides() folds these into a record keyed by bucketKey (last write wins), but ' +
    'rate_limit_overrides_account_bucket_unique on (account_id, bucket_key) means at most one ' +
    'active row per key, so the fold is never contested',
  'auth-repo.ts::findTeamMemberships':
    'consumed as ctx.teams.find(t => t.ownerAccountId === …); ' +
    'team_members_owner_member_unique on (owner_account_id, member_account_id) means the find ' +
    'can match at most one row, so it cannot pick a different role on a different request',
  'cost-nightly-accounts-provider.ts::listAllAccountIds':
    'every id is processed by the nightly cost job; the only read is .length',
  'health-probes-repo.ts::countByTargetSince':
    'an aggregate immediately re-keyed by target in sla-reporting',
  'pricing-repo.ts::listAll':
    'folded into a Map keyed by tier, and tier is the pricing PRIMARY KEY so the fold is never ' +
    'contested; the returned order comes from the TIER_MONTHLY_PRICE_CENTS ladder, not from SQL',
  'sessions-repo.ts::listActiveByAccount':
    'destroyAllForAccount iterates the whole list and destroys each one',
  'status-subscribers-repo.ts::listConfirmed':
    'incident-notifications mails every recipient — no batching, slicing or truncation',
  'status-subscribers-repo.ts::listPurgeCandidates': 'every candidate is purged in one call',
  'usage-repo.ts::dailyBucketsForRange':
    'the GROUP BY result is merged into a Map and then explicitly sorted by date before it is ' +
    'returned, so the arbitrary aggregate order never escapes the method',
  'webhooks-repo.ts::listEndpointsSubscribedTo':
    'fan-out: every subscribed endpoint is delivered to',
};

/** Array-returning `.select(` methods in a repo file that carry no `.orderBy(`. */
function unorderedReads(source: string): string[] {
  const found: string[] = [];
  const parts = source.split(/\n {2}(?:private |public )?(?:async )?([a-zA-Z][a-zA-Z0-9_]*)\(/);
  for (let i = 1; i < parts.length - 1; i += 2) {
    const name = parts[i] ?? '';
    const body = parts[i + 1] ?? '';
    const ret = /\)\s*:\s*Promise<([^>]*(?:<[^>]*>)?[^>]*)>/.exec(body)?.[1] ?? '';
    if (!ret.includes('[]')) continue;
    if (!body.includes('.select(')) continue;
    if (body.includes('.orderBy(') || body.includes('limit(1)')) continue;
    found.push(name);
  }
  return found;
}

function scan(): string[] {
  const out: string[] = [];
  for (const file of readdirSync(DB_DIR)
    .filter((f) => f.endsWith('.ts'))
    .sort()) {
    for (const method of unorderedReads(readFileSync(resolve(DB_DIR, file), 'utf8'))) {
      out.push(`${file}::${method}`);
    }
  }
  return out;
}

describe('V-1201 an unordered read is reviewed, not accidental', () => {
  it('CRITICAL the detector still detects. It must find an array-returning select with no orderBy, and must NOT flag the same method once ordered — a detector that has quietly stopped matching reports an empty offender list forever, which reads exactly like a clean repo.', () => {
    const unordered = `
  async listThings(accountId: string): Promise<ThingRow[]> {
    const rows = await this.database.db.select().from(things).where(eq(things.accountId, accountId));
    return rows.map(toThing);
  }
`;
    expect(
      unorderedReads(unordered),
      'the detector missed an unordered array-returning select',
    ).toEqual(['listThings']);
    expect(
      unorderedReads(unordered.replace('accountId))', 'accountId)).orderBy(asc(things.id))')),
      'the detector flags a method that DOES order, which would make the allowlist meaningless',
    ).toEqual([]);
  });

  it('CRITICAL the scan reached the repo layer it claims to cover. An empty walk would agree with any allowlist at all.', () => {
    expect(readdirSync(DB_DIR).filter((f) => f.endsWith('.ts')).length).toBeGreaterThan(20);
    expect(
      scan().length,
      'the scan found no unordered reads anywhere, which contradicts the review',
    ).toBeGreaterThan(5);
  });

  it('CRITICAL every unordered array read is on the reviewed list. A new one means nobody has checked whether its consumer depends on the order the double happens to provide and the database does not.', () => {
    const unreviewed = scan().filter((k) => !(k in REVIEWED));
    expect(
      unreviewed,
      'these array-returning reads have no ORDER BY and no review entry. Either add `.orderBy(...)` ' +
        '(the answer whenever the rows reach a customer or a `.find()` / last-write-wins fold over ' +
        'a non-unique key), or add an entry above saying which consumer you checked and why ' +
        'arbitrary order is unobservable there',
    ).toEqual([]);
  });

  it('CRITICAL no reviewed entry has gone stale. An entry whose method was renamed, deleted or since ordered is reasoning that no longer describes any code, and it would silently keep vouching for whatever took the name.', () => {
    const live = new Set(scan());
    const stale = Object.keys(REVIEWED).filter((k) => !live.has(k));
    expect(
      stale,
      'these entries no longer match an unordered read — delete them, or if the method was ' +
        'renamed, re-verify the consumer under its new name rather than moving the entry',
    ).toEqual([]);
  });
});
