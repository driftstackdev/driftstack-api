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

/**
 * V-1202 — the detector above only sees Drizzle `.select(` chains, so every raw tagged-template
 * query was invisible to it. That was an unstated blind spot in a guard whose whole subject is
 * unstated guarantees. Measured before being described: 22 raw SELECT blocks in src/db, 15
 * without ORDER BY — and all 15 are advisory-lock acquisitions or scalar counts, so the gap was
 * real but empty. These arms keep it empty.
 */
function rawSelectsWithoutOrderBy(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/(?:sql|client<[^>]*>)`([^`]*)`/g)) {
    const body = m[1] ?? '';
    if (!/\bSELECT\b/i.test(body)) continue;
    if (/\bORDER BY\b/i.test(body)) continue;
    out.push(body.replace(/\s+/g, ' ').trim());
  }
  return out;
}

/** A read with no ORDER BY is fine when it cannot return a contested row set. */
const SCALAR_OR_LOCK =
  /pg_advisory_xact_lock\(|hashtext(?:extended)?\(|SELECT\s+\(?\s*(?:SELECT\s+)?count\(/i;

/** Reviewed 2026-08-20, same standard as REVIEWED above. */
const REVIEWED_RAW: Array<{ match: string; why: string }> = [
  {
    match: 'WITH lifecycle_intervals AS',
    why:
      'the lifecycle CTE inside dailyBucketsForRange — its rows are merged into a Map keyed by ' +
      'day and the method sorts by date before returning, so no arbitrary order escapes',
  },
  {
    match: "SELECT set_config('statement_timeout'",
    why:
      'agent-turn-telemetry-repo aggregate: sets a transaction-local statement timeout for the ' +
      'health watchdog. One row, one column, and its result is never read — there is no row set ' +
      'whose order could matter',
  },
  // credit-windows-repo (reviewed 2026-09-19). Five statements, each of which can return AT MOST
  // ONE ROW, and for four of them a constraint is what says so.
  {
    match: 'INSERT INTO credit_windows (account_id, source, source_ref',
    why:
      'writeWindow: inserts one window. Its SELECT has no FROM — it is a VALUES row written as a ' +
      'SELECT only so that it can carry the "contains now()" WHERE',
  },
  {
    match: 'SELECT id FROM credit_windows WHERE account_id = ${accountId}::uuid AND source =',
    why:
      'writeWindow: looks one window up by (account, source, source_ref, natural_start), which ' +
      'is exactly credit_windows_source_month_unique — at most one row',
  },
  {
    match: 'INSERT INTO credit_lots (account_id, kind, spend_rank, window_id, grant_key',
    why:
      'ensureMonthlyLot and ensureProrationLot: each inserts one lot, read from one window by ' +
      'its primary key',
  },
  {
    match: 'SELECT id, granted_micro::text AS granted FROM credit_lots WHERE window_id =',
    why:
      "ensureMonthlyLot: a window's monthly lot. credit_lots_one_monthly_per_window (a partial " +
      'unique index) means at most one row',
  },
  // credit-windows-repo, the plan-change writers (reviewed 2026-09-19). Both can return at most
  // one row, and for both a unique index is what says so.
  {
    match: 'SELECT id, granted_micro::text AS granted FROM credit_lots WHERE grant_key =',
    why:
      'ensureProrationLot: the lot it just inserted, looked up by its grant key. ' +
      'credit_lots_grant_key_unique means at most one row',
  },
  {
    match: 'SELECT id, account_id, source, source_ref, target_key, state,',
    why:
      'findClawback: one clawback by (source, source_ref, target_key), which is exactly ' +
      'credit_clawbacks_idempotency_unique — at most one row, and that uniqueness is the ' +
      'whole reason the read exists',
  },
  // credit-windows-repo, the standing-claims total (reviewed 2026-09-20). An
  // aggregate over one account, one row, one column.
  {
    match: 'SELECT COALESCE(SUM(pending_micro), 0)::text AS micro FROM credit_clawbacks',
    why:
      'pendingClaimTotalMicro: a SUM over one account. One row, and it is read as a number — ' +
      'there is no row set whose order could matter',
  },
  // credit-reservations-repo (reviewed 2026-09-20). Three statements: two that
  // can return at most one row by a PRIMARY KEY, and one aggregate.
  {
    match: 'SELECT id, account_id, agent_session_id, mode, model, rate_card_version, slot, state,',
    why:
      'lockReservation: one reservation by `credit_reservations.id`, its primary key — at most ' +
      'one row, and the FOR UPDATE on it is the point of the read',
  },
  {
    match: 'SELECT account_id FROM credit_reservations WHERE id = ${id}::uuid',
    why: 'accountOf: the same primary-key lookup, one column of it',
  },
  {
    match: 'SELECT COALESCE(SUM(charged_micro), 0)::text AS micro FROM credit_model_calls',
    why:
      "chargedByCalls: a SUM over one reservation's calls. One row, read as a number; the " +
      'database re-checks the same total at COMMIT',
  },
  {
    match: 'SET committed_micro = (SELECT COALESCE(SUM(CASE WHEN c.state =',
    why:
      'settleStartedCallsAfterACrash: a scalar sub-SELECT that recomputes one reservation’s ' +
      "committed_micro from its own calls — a started call's bound, a settled one's charge. " +
      'One row, one number, correlated on the reservation’s primary key; it is the same ' +
      'expression `credit_check_reservation` re-evaluates at COMMIT',
  },
  // credit-reservations-repo, the per-call admission and settlement (reviewed
  // 2026-09-20). Four statements, each about ONE task or ONE call, addressed by
  // a primary key or a unique constraint.
  // credit-rate-card-repo, the owner-only publisher (reviewed 2026-09-22).
  {
    match: 'SELECT (COALESCE(MAX(version), 0) + 1)::int AS next FROM credit_rate_cards',
    why:
      'publish: an aggregate over the whole card table (MAX(version) + 1) that returns exactly ' +
      'one row with no GROUP BY, taken under the publish advisory lock acquired on the line ' +
      'above it, so two publishers cannot both read the same next version; ' +
      '`credit_rate_cards.version` is the primary key and refuses a repeat',
  },
  {
    match: 'SELECT state, model, (now() >= max_until) AS past_ceiling',
    why:
      'admissionRefusal: one reservation by `credit_reservations.id`, its primary key, read only ' +
      'to say which predicate the admission UPDATE failed — at most one row',
  },
  {
    match: 'INSERT INTO credit_model_calls (id, reservation_id, account_id, seq,',
    why:
      "insertModelCall: the SELECT is an aggregate over one task's calls (MAX(seq) + 1), which " +
      'returns exactly one row with no GROUP BY. It names the next sequence number; ' +
      '`credit_model_calls_seq_unique` refuses a second call that reuses one',
  },
  {
    match: 'SELECT r.id AS reservation_id, r.mode, r.rate_card_version',
    why:
      'lockCallForSettlement, first half: one call by `credit_model_calls.id`, its primary key, ' +
      'joined to its one reservation by that table’s primary key — at most one row, and the ' +
      'FOR UPDATE on the reservation is the point of the read',
  },
  {
    match: 'SELECT account_id, state, sent, model, bound_micro::text AS bound,',
    why:
      'lockCallForSettlement, second half: the same call by its primary key, re-read AFTER the ' +
      'reservation lock is held because a joined read re-checks only the relation it locks — at ' +
      'most one row, and it takes that row’s own lock',
  },
  {
    match: 'SELECT mode, model, rate_card_version, state, reserved_micro::text AS reserved,',
    why:
      'reservationTerms: the same primary-key lookup as lockReservation, without the lock, so ' +
      'planning the next call does not queue behind a settlement of the same task',
  },
  {
    match: 'FROM credit_windows WHERE account_id = ${accountId}::uuid AND window_start <= now()',
    why:
      'currentWindow: the window containing now(). credit_windows_no_overlap (an exclusion ' +
      "constraint) means an account's windows never overlap, so one instant is in at most one",
  },
  // credit-reservations-repo, the lease keeper's claim (reviewed 2026-09-20).
  {
    match: "SELECT CASE WHEN max_until < now() THEN 'max_age' ELSE 'lease_expired' END AS reason",
    why:
      'claimLapsedReservation: one reservation by `credit_reservations.id`, its primary key — at ' +
      'most one row. The FOR UPDATE on it is the point of the read, and the row it locks is the ' +
      'one the same transaction then settles. (Its candidate read, `lapsedReservations`, DOES ' +
      'order — by lease then id — because there the order decides which fifty are settled first)',
  },
];

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
  it('CRITICAL raw tagged-template reads are covered too. The chain detector above cannot see `sql`/`client` queries at all, so without this arm the guard would report a clean repo while every hand-written SELECT went unexamined — the exact shape it exists to catch.', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(DB_DIR)
      .filter((f) => f.endsWith('.ts'))
      .sort()) {
      for (const body of rawSelectsWithoutOrderBy(readFileSync(resolve(DB_DIR, file), 'utf8'))) {
        if (SCALAR_OR_LOCK.test(body)) continue;
        if (REVIEWED_RAW.some((r) => body.includes(r.match))) continue;
        offenders.push(`${file} — ${body.slice(0, 70)}`);
      }
    }
    expect(
      offenders,
      'these raw SELECTs have no ORDER BY and are neither a lock acquisition, a scalar count, nor ' +
        'reviewed above. A raw query that returns a contested row set in arbitrary order is the ' +
        'same defect as an unordered .select() chain, and nothing else in the suite looks at them',
    ).toEqual([]);
  });

  it('CRITICAL the raw-SQL detector still finds raw SQL. It is a second detector with the same failure mode as the first: match nothing, report clean, look identical to a healthy repo.', () => {
    const all = readdirSync(DB_DIR)
      .filter((f) => f.endsWith('.ts'))
      .flatMap((f) => rawSelectsWithoutOrderBy(readFileSync(resolve(DB_DIR, f), 'utf8')));
    expect(
      all.length,
      'the raw-SQL detector matched nothing across the whole repo layer',
    ).toBeGreaterThan(10);
    expect(
      rawSelectsWithoutOrderBy('const x = sql`SELECT a FROM t WHERE b = 1`;'),
      'the detector missed a bare raw SELECT with no ORDER BY',
    ).toEqual(['SELECT a FROM t WHERE b = 1']);
    expect(
      rawSelectsWithoutOrderBy('const x = sql`SELECT a FROM t ORDER BY a`;'),
      'the detector flags a raw SELECT that DOES order',
    ).toEqual([]);
  });
});
