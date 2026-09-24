// `onDelete: 'cascade'` looks like a retention policy. Usually it is not one.
//
// A cascade only fires when the PARENT ROW is deleted. This system does not
// delete account rows: `deleteAccount` sets `status = 'deleted'` and
// `deleted_at = now`, and reclaims resources in place. There is no
// `DELETE FROM accounts` anywhere in apps/server/src. So every
// `references(() => accounts.id, { onDelete: 'cascade' })` is a referential
// integrity rule and nothing else — it will not remove a row in the lifetime of
// this deployment.
//
// That is not news to the codebase; it is written down once, for one table. The
// W438 comment beside session_events in AUDIT_TABLES says it exactly: "Its FK to
// sessions is onDelete:cascade, but sessions are marked-destroyed (never
// row-deleted) so the cascade never fires → unbounded growth." That reasoning is
// correct and it generalises to fifteen tables. Nobody had generalised it.
//
// SEVEN OF THEM APPEND A ROW PER EVENT:
//
//   account_audit_log             one row per customer action
//   usage_records                 one row per metered event
//   sessions                      one per session, marked destroyed, never
//                                 removed — the case W438 already documented
//   web_sessions                  one per browser login; revoked by UPDATE
//   incident_update_notifications one per (subscriber × incident update), so it
//                                 grows as the product of two things that grow
//   oauth_pending_links           one per link attempt, consumed by UPDATE
//   billing_email_sends           one per billing email; also the dedup key
//
// The other eight hold one row per live entity — an account's API keys, its
// webhook endpoints, its subscription — and are bounded by the entity count.
// They are in the roster so that the difference is a recorded reading of each
// one rather than an impression.
//
// This changes no schema and adds no sweeper. Retention is a policy decision
// with a privacy-policy sentence attached to it, and picking windows for seven
// tables out of a drift guard would be inventing policy. What it does is make
// the eighth per-event table arrive as a failure instead of as a row in a
// migration nobody reads twice.
//
// SCOPE, AND THE ONE INDIRECTION. The detector reads `apps/server/src/db` only,
// because that is where DB deletes live; scanning all of src drowns in
// `Map.delete(key)`. Inside db/ exactly one delete goes through a variable —
// `auth-flows-repo.ts` does `.delete(t)` where `t = tableForKind(kind)` — which
// covers the three auth-token tables. That is recorded in
// DELETED_VIA_DISPATCHER rather than pattern-matched, and an arm below fails if
// a second indirection appears, because the next one would silently widen the
// roster instead of being resolved.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { codeOnly } from './_helpers/code-only.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB = resolve(HERE, '..', '..', 'src', 'db');

/**
 * Tables removed through `.delete(t)` where `t` comes from `tableForKind`.
 * Resolved by hand because the detector cannot follow the variable, and left
 * visible because an unrecorded indirection is how a table gets counted as
 * unbounded when it is swept every night.
 */
const DELETED_VIA_DISPATCHER = new Set([
  'emailVerifyTokens',
  'magicLinkTokens',
  'passwordResetTokens',
]);

/**
 * Tables with a delete in src/db that is NOT a removal path for the table: it
 * removes one row the same request has just written, so the table still keeps a
 * row per event. The detector counts any delete as a way out, which would read
 * such a table as swept. Resolved by hand, like DELETED_VIA_DISPATCHER, and the
 * arm "every not-retention delete is still a real delete" fails if one goes.
 */
const DELETE_IS_NOT_RETENTION = new Map<string, string>([
  [
    'billingEmailSends',
    'account-lifecycle-repo.ts releaseBillingEmailClaim — gives back the send-once claim of a billing email that was NOT sent, so the Stripe redelivery can send it (live-billing audit #8). Every email that went out keeps its row',
  ],
]);

/**
 * Every table whose only removal path is a cascade from a parent that is itself
 * never row-deleted, and what actually bounds it.
 *
 * `PER-EVENT` — appends a row per action. Nothing removes it, ever.
 * `entity`    — one row per live thing; bounded by how many of that thing exist.
 */
const CASCADE_ONLY_TABLES = new Map<string, string>([
  ['account_audit_log', 'PER-EVENT — one row per customer action'],
  ['account_oauth_links', 'entity — one row per account per provider'],
  ['api_keys', 'entity — per account, capped by the key limit'],
  [
    'billing_email_sends',
    'PER-EVENT — one row per billing email; also the (event, kind) dedup key',
  ],
  [
    'billing_invoice_payments',
    'PER-EVENT — one row per PAID invoice (its primary key is the invoice id), so a monthly subscriber adds twelve a year and an annual one adds one. Bounded by billing cadence, not by customer activity, and it is the record of what was paid for',
  ],
  ['credit_accounts', 'entity — one row per account (its primary key)'],
  [
    'credit_ledger',
    'PER-EVENT — one row per balance movement: every grant, task charge, expiry, repayment and adjustment. Append-only by trigger, so nothing but the account cascade can ever remove a row',
  ],
  [
    'credit_lots',
    'PER-EVENT — one row per grant: each month of included credits, each plan change, goodwill grant and top-up. Removed only with the account, by trigger',
  ],
  [
    'credit_model_calls',
    'PER-EVENT — one row per billable model call a task makes, written before it is sent (0131). Bounded per TASK by the fit ladder and by what the task reserved, and unbounded over time the way the ledger is: it is the record of what each call was allowed to cost and what it did cost. Removed only with the account, by trigger',
  ],
  ['credit_plan_overrides', 'entity — at most one per account (its primary key), set by an admin'],
  [
    'credit_reservation_holds',
    'PER-EVENT — one row per (task, lot): what one task held in one lot (0131). At most three open tasks per account at a time, but the rows stay after the task settles, so it grows with tasks run. Removed only with the account, by trigger',
  ],
  [
    'credit_reservations',
    'PER-EVENT — one row per AI task (0131). AT MOST THREE OPEN at a time per account (credit_reservations_open_slot_unique), which bounds what is IN FLIGHT and not what accumulates: a settled row stays, because it is what the task charges point at. Removed only with the account, by trigger',
  ],
  [
    'credit_clawbacks',
    'PER-EVENT — one row per refund, dispute or plan change whose credits were taken back (unique on source, reference and target, so the same one is recorded once). Bounded by how often payments are reversed or plans change, not by use; removed only with the account, by trigger',
  ],
  [
    'credit_window_level_changes',
    "PER-EVENT — one row per change of a month window's level (a plan change, a refund, a dispute). Append-only by trigger, and it goes only with its window",
  ],
  [
    'credit_windows',
    'PER-EVENT — one row per granted month per account (unique on account, source, payment and month; an exclusion constraint forbids two that overlap, so an account adds at most about twelve a year however many payment sources it has). Removed only with the account, by trigger',
  ],
  [
    'crypto_entitlements',
    'PER-EVENT — one row per crypto ORDER (unique on order_id), not one per account. I recorded it as per-account when this roster landed; the schema says otherwise, and a customer who buys fifty times has fifty rows',
  ],
  [
    'incident_update_notifications',
    'PER-EVENT — one row per (subscriber, incident), UPSERTED. I recorded it as per incident UPDATE; the unique key is (subscriber_id, incident_id) and markSent upserts, which is the whole point of a throttle table. It still grows with subscribers, but the update dimension does not multiply and incidents are staff-created',
  ],
  ['incident_updates', 'entity — per incident, and incidents are staff-created'],
  ['oauth_clients', 'entity — registered by staff'],
  ['oauth_pending_links', 'PER-EVENT — one row per link attempt, consumed by UPDATE not DELETE'],
  [
    'rate_limit_buckets',
    'entity — and in fact nothing writes it at all; the live counters are in Redis (D-015)',
  ],
  ['sessions', 'PER-EVENT — marked destroyed, never removed. The case W438 documented'],
  ['subscriptions', 'entity — per account'],
  [
    'teams',
    'entity — one per owner today, minted ONLY by the 0114 backfill; no create route exists yet. ⚠️ Deliberately NOT unique on owner_account_id, because multiple teams per owner is the point of the table, so nothing caps this structurally. When a create route lands this bound stops being true and must be re-stated — an owner able to POST teams is per-request, not per-account',
  ],
  ['usage_records', 'PER-EVENT — one row per metered event'],
  ['web_sessions', 'PER-EVENT — one row per browser login; revoked by UPDATE'],
  ['webhook_endpoints', 'entity — per account, capped by the endpoint limit'],
]);

/**
 * The uniqueness key each table actually declares, read from the schema.
 *
 * The reasons above are prose I wrote by reading, and two of them were wrong for
 * a day: `crypto_entitlements` was recorded as one row per ACCOUNT when its
 * unique index is on `order_id` (one per purchase), and
 * `incident_update_notifications` as one row per incident UPDATE when its key is
 * `(subscriber_id, incident_id)` and `markSent` upserts. Both errors were
 * visible in the schema the whole time; nothing put the schema next to the
 * sentence.
 *
 * This does. A recorded key that stops matching the schema fails, so the fact
 * the prose is reasoning FROM cannot drift out from under it. It cannot check
 * the prose itself — but neither of those two mistakes survives having the real
 * key sitting beside the claim.
 */
const UNIQUENESS_KEY = new Map<string, string>([
  ['account_audit_log', '(pk only)'],
  ['account_oauth_links', 'provider,providerSub'],
  ['api_keys', 'keyPrefix'],
  ['billing_email_sends', '(pk only)'],
  ['billing_invoice_payments', '(pk only)'],
  ['credit_accounts', '(pk only)'],
  ['credit_ledger', 'accountId,idempotencyKey'],
  // `windowId` is the partial unique "at most one MONTHLY lot per window" (0130);
  // a window may still hold several plan-change lots, so the per-grant key stands.
  ['credit_lots', 'grantKey;windowId'],
  ['credit_model_calls', 'reservationId,seq'],
  ['credit_plan_overrides', '(pk only)'],
  // Two partial unique indexes: at most three OPEN enforced tasks per account
  // (one per slot), and at most one task per (account, request key) where a
  // request key is present — only the idempotent lane sets one (M2).
  // `id,accountId` is not a third way to be unique — the id alone already is.
  // It is there so a hold and a model call can key on the task AND the account
  // (0131), which is what stops a task being backed by another account's credit.
  ['credit_reservations', 'accountId,slot;accountId,requestKey;id,accountId'],
  ['credit_reservation_holds', '(pk only)'],
  ['credit_clawbacks', 'source,sourceRef,targetKey'],
  ['credit_window_level_changes', '(pk only)'],
  // `id,accountId` is not a second way to be unique — the id alone already is.
  // It is there so `credit_lots_window_fk` can key on the window AND the
  // account (0130), which is what stops a lot naming another account's window.
  ['credit_windows', 'accountId,source,sourceRef,naturalStart;id,accountId'],
  ['crypto_entitlements', 'orderId'],
  ['incident_update_notifications', 'subscriberId,incidentId'],
  ['incident_updates', '(pk only)'],
  ['oauth_clients', '(pk only)'],
  ['oauth_pending_links', 'tokenHash'],
  ['rate_limit_buckets', '(pk only)'],
  ['sessions', '(pk only)'],
  ['subscriptions', 'stripeSubscriptionId'],
  ['teams', 'slug'],
  ['usage_records', '(pk only)'],
  ['web_sessions', 'tokenHash'],
  ['webhook_endpoints', '(pk only)'],
]);

/** `uniqueIndex(...).on(t.a, t.b)` columns per table, or `(pk only)`. */
function declaredUniquenessKeys(): Map<string, string> {
  const schema = readFileSync(resolve(DB, 'schema.ts'), 'utf8');
  const out = new Map<string, string>();
  for (const m of schema.matchAll(/export const (\w+) = pgTable\(\s*'([a-z_]+)'/g)) {
    const start = m.index ?? 0;
    const next = schema.indexOf('export const', start + 10);
    const body = schema.slice(start, next === -1 ? schema.length : next);
    const keys: string[] = [];
    // ⛔ BOTH SPELLINGS. Drizzle declares uniqueness two ways — `uniqueIndex(…)`
    // and the table-level `unique(…)` — and reading only the first is a silent
    // scope boundary: a key declared the other way reads as "(pk only)" here,
    // which is indistinguishable from a table that has no key at all. 0131
    // converts `credit_windows_id_account_unique` from one spelling to the
    // other and declares `credit_model_calls_seq_unique` in the second, so both
    // were about to fall out of this derivation.
    for (const u of body.matchAll(/(?:uniqueIndex|unique)\([^)]*\)\s*\.on\(([^)]*)\)/g)) {
      keys.push(
        (u[1] ?? '')
          .split(',')
          .map((x) => x.trim().replace('t.', ''))
          .filter((x) => x.length > 0)
          .join(','),
      );
    }
    out.set(m[2] ?? '', keys.length > 0 ? keys.join(';') : '(pk only)');
  }
  return out;
}

interface Table {
  readonly sql: string;
  /** Parent table consts this one cascades from. */
  readonly cascadeParents: string[];
}

function parseSchema(): Map<string, Table> {
  const schema = readFileSync(resolve(DB, 'schema.ts'), 'utf8');
  const out = new Map<string, Table>();
  for (const m of schema.matchAll(/export const (\w+) = pgTable\(\s*'([a-z_]+)'/g)) {
    const start = m.index ?? 0;
    const next = schema.indexOf('export const', start + 10);
    const body = schema.slice(start, next === -1 ? schema.length : next);
    const cascadeParents: string[] = [];
    for (const r of body.matchAll(/references\(\(\) => (\w+)\.\w+(?:,\s*\{([^}]*)\})?\)/g)) {
      if (/onDelete:\s*'cascade'/.test(r[2] ?? '')) cascadeParents.push(r[1] ?? '');
    }
    out.set(m[1] ?? '', { sql: m[2] ?? '', cascadeParents });
  }
  return out;
}

interface Deletes {
  /** Table consts with a literal `.delete(const)` or raw `DELETE FROM`. */
  readonly direct: Set<string>;
  /** `.delete(x)` where x is not a table const — must be resolved by hand. */
  readonly indirect: string[];
}

function parseDeletes(tables: Map<string, Table>): Deletes {
  const direct = new Set<string>();
  const indirect: string[] = [];
  const bySql = new Map([...tables].map(([c, t]) => [t.sql, c]));
  for (const f of readdirSync(DB).filter((x) => x.endsWith('.ts'))) {
    // ⛔ Comments stripped, and both patterns need it. The raw-SQL matcher is
    // case-INsensitive, so ordinary prose ("cascade-delete from either side")
    // parses as a DELETE and names a table. Measured 2026-08-28 across the 55
    // files here: one such phantom today, in schema.ts, capturing the word
    // `either` -- harmless only because no table is called that. Had it named a
    // real table, that table would enter `direct`, be skipped by cascadeOnly(),
    // and leave the roster. The rot arm below turns that into a LOUD failure
    // rather than a silent one, which is why this was a fragility and not a
    // defect -- but a red traced back to a sentence costs a reader an hour.
    const src = codeOnly(readFileSync(resolve(DB, f), 'utf8'));
    for (const m of src.matchAll(/\.delete\(\s*(\w+)\s*\)/g)) {
      const id = m[1] ?? '';
      if (tables.has(id)) direct.add(id);
      else indirect.push(`${f}: .delete(${id})`);
    }
    for (const m of src.matchAll(/DELETE FROM\s+([a-z_]+)/gi)) {
      const c = bySql.get((m[1] ?? '').toLowerCase());
      if (c !== undefined) direct.add(c);
    }
  }
  return { direct, indirect };
}

function cascadeOnly(): string[] {
  const tables = parseSchema();
  const { direct } = parseDeletes(tables);
  const out: string[] = [];
  for (const [name, { sql, cascadeParents }] of tables) {
    if (
      (direct.has(name) && !DELETE_IS_NOT_RETENTION.has(name)) ||
      DELETED_VIA_DISPATCHER.has(name)
    )
      continue;
    if (cascadeParents.length === 0) continue;
    // A cascade whose parent IS deleted really does fire.
    if (cascadeParents.some((p) => direct.has(p))) continue;
    out.push(sql);
  }
  return out.sort();
}

describe('a cascade from a row nobody deletes is not a retention policy', () => {
  const tables = parseSchema();

  it('CRITICAL the premise holds: nothing deletes an account row. Every reading below rests on this one fact — if `deleteAccount` ever starts removing the row, fifteen cascades begin firing and this whole file is describing a system that no longer exists.', () => {
    // Same reason as parseDeletes, opposite direction: this arm is a NEGATIVE
    // sentinel, so a comment merely QUOTING `DELETE FROM accounts` -- exactly what
    // a future note explaining why accounts are never row-deleted would say --
    // fails it. Prose can neither create nor destroy a delete.
    const src = readdirSync(DB)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => codeOnly(readFileSync(resolve(DB, f), 'utf8')))
      .join('\n');
    expect(src, 'an account row is now deleted — re-read this file from the top').not.toMatch(
      /\.delete\(\s*accounts\s*\)|DELETE FROM accounts\b/i,
    );
  });

  it('CRITICAL the scan sees the schema and can tell a deleted table from a cascade-only one. This asserts a set equals a list, so a parser that read nothing would report an empty set — no unbounded tables at all, which is both the most reassuring answer and the wrong one. Probed in both directions by name.', () => {
    expect(tables.size, 'tables parsed out of schema.ts').toBeGreaterThan(45);
    const { direct } = parseDeletes(tables);
    expect(direct.size, 'table consts with a direct delete').toBeGreaterThan(20);
    expect(
      cascadeOnly(),
      'profiles has a real purge path and must NOT be reported as cascade-only',
    ).not.toContain('profiles');
    expect(cascadeOnly(), 'usage_records is cascade-only — the detector is broken').toContain(
      'usage_records',
    );
  });

  it('CRITICAL every delete that goes through a variable is resolved by hand. The detector cannot follow `.delete(t)`, so an unrecorded one makes a swept table look unbounded — or, worse, hides that a table stopped being swept. There is exactly one today and it is the tableForKind dispatcher.', () => {
    const { indirect } = parseDeletes(tables);
    expect([...new Set(indirect)].sort(), 'unresolved indirect delete(s) in src/db:').toEqual([
      'auth-flows-repo.ts: .delete(t)',
    ]);
    // And it must still cover what DELETED_VIA_DISPATCHER claims it covers.
    const repo = readFileSync(resolve(DB, 'auth-flows-repo.ts'), 'utf8');
    expect(repo, 'the dispatcher this exemption names is gone').toMatch(/tableForKind/);
    for (const t of DELETED_VIA_DISPATCHER) {
      expect(
        repo,
        `${t} is exempted as dispatcher-deleted but the repo no longer names it`,
      ).toMatch(new RegExp(`\\b${t}\\b`));
    }
  });

  it('CRITICAL every not-retention delete is still a real delete. An entry here keeps a table on the roster although the detector found a delete for it; once that delete is gone the entry is only an exemption nobody re-reads.', () => {
    const { direct } = parseDeletes(tables);
    const gone = [...DELETE_IS_NOT_RETENTION.keys()].filter((t) => !direct.has(t)).sort();
    expect(gone, 'recorded not-retention delete(s) that no longer exist:').toEqual([]);
  });

  it('CRITICAL no table relies on a cascade that cannot fire without that being recorded. Add it here with what bounds it in practice. If the honest answer is "nothing — it appends a row per event", say PER-EVENT, because that is a table that is fine in staging and is a disk-full page at scale.', () => {
    const unrecorded = cascadeOnly().filter((t) => !CASCADE_ONLY_TABLES.has(t));
    expect(unrecorded, 'cascade-only table(s) with no recorded bound:').toEqual([]);
  });

  it('CRITICAL every recorded entry still names a real cascade-only table. A stale entry claims a table was reviewed when it has since gained a sweeper — which is the good outcome, and it should show up as a required edit here rather than as an exemption nobody re-reads.', () => {
    const live = new Set(cascadeOnly());
    const stale = [...CASCADE_ONLY_TABLES.keys()].filter((t) => !live.has(t)).sort();
    expect(stale, 'recorded table(s) that are no longer cascade-only:').toEqual([]);
  });

  it('CRITICAL rate_limit_buckets is written, or the docs say it is not. It is in the roster above as entity-bounded for an unusual reason: nothing writes it at all. D-015 describes it as a durability snapshot "synced periodically" and architecture.md listed it under Metering as "(snapshots)" — a table that exists in every production database, is named in two documents as a live durability mechanism, and has never held a row. Whoever builds the sync must delete these notices; whoever deletes the notices must build the sync.', () => {
    const src = readdirSync(DB)
      .filter((f) => f.endsWith('.ts') && f !== 'schema.ts')
      .map((f) => readFileSync(resolve(DB, f), 'utf8'))
      .join('\n');
    const written = /\.insert\(\s*rateLimitBuckets\s*\)|INSERT INTO rate_limit_buckets/i.test(src);
    const docs = resolve(HERE, '..', '..', '..', '..', 'docs');
    const notices =
      /Reality check 2026-08-18[\s\S]{0,400}?nothing reads or writes it/.test(
        readFileSync(resolve(docs, 'decisions.md'), 'utf8'),
      ) &&
      /`rate_limit_buckets` — which exists in the schema but is \*\*never written\*\*/.test(
        readFileSync(resolve(docs, 'architecture.md'), 'utf8'),
      );
    expect(
      written !== notices,
      written
        ? 'rate_limit_buckets is written now — remove the D-015 reality check and the architecture.md note, and say what the sync period is'
        : 'nothing writes rate_limit_buckets and the docs no longer say so — D-015 and architecture.md describe a durability mechanism that does not exist',
    ).toBe(true);
  });

  it('CRITICAL every recorded table still declares the uniqueness key its reason reasons from. The reasons are prose; the key is a fact. Two reasons were wrong for a day — crypto_entitlements recorded as one row per ACCOUNT against a unique index on order_id, and incident_update_notifications as one row per incident UPDATE against a key of (subscriber_id, incident_id) with an upserting writer. Both were visible in the schema; nothing put the schema beside the sentence.', () => {
    const declared = declaredUniquenessKeys();
    const drifted: string[] = [];
    for (const [table, key] of UNIQUENESS_KEY) {
      const actual = declared.get(table);
      if (actual !== key)
        drifted.push(`${table}: recorded ${key}, schema says ${actual ?? '<table gone>'}`);
    }
    expect(drifted.sort(), 'recorded uniqueness key(s) that no longer match the schema:').toEqual(
      [],
    );
    // And the two rosters must cover the same tables, or one of them is stale.
    expect(
      [...UNIQUENESS_KEY.keys()].sort(),
      'the key roster must cover exactly the cascade roster',
    ).toEqual([...CASCADE_ONLY_TABLES.keys()].sort());
  });

  it('CRITICAL the per-event set is still exactly these seventeen. The entity-bounded majority is the boring part of the roster; this is the list that says whether the situation is getting worse, and an eighteenth would otherwise arrive as one more line in a table of twenty-seven.', () => {
    const perEvent = [...CASCADE_ONLY_TABLES.entries()]
      .filter(([, why]) => why.startsWith('PER-EVENT'))
      .map(([t]) => t)
      .sort();
    expect(perEvent, 'tables that append a row per event and are never removed:').toEqual([
      'account_audit_log',
      'billing_email_sends',
      // Paid invoices (0129). A financial record too: one row per invoice a
      // customer paid, growing with billing cadence rather than with use.
      'billing_invoice_payments',
      // The AI credits ledger and its lots (0128). A financial record, append-only
      // BY TRIGGER: no sweeper may remove a row without breaking the rule that a
      // balance is the sum of its rows. Retention here is a policy decision with
      // an accounting answer, not something a drift guard picks.
      // The month windows, their level history and the record of credits taken
      // back (0130) are the same record one level up: what each grant was for.
      'credit_clawbacks',
      'credit_ledger',
      'credit_lots',
      // The tasks credits are spent through, what each held, and every model
      // call each made (0131). Three open tasks per account at a time is a
      // bound on what is IN FLIGHT; the settled rows stay, because they are
      // what a task charge in the ledger points at.
      'credit_model_calls',
      'credit_reservation_holds',
      'credit_reservations',
      'credit_window_level_changes',
      'credit_windows',
      'crypto_entitlements',
      'incident_update_notifications',
      'oauth_pending_links',
      'sessions',
      'usage_records',
      'web_sessions',
    ]);
  });
});
