// V-759 — privacy-policy §9 retention, implemented as ANONYMISATION rather than deletion.
//
// §9 USED TO DISCLOSE two windows that nothing enforced: revoked API-key records "retained
// 90 days for audit then deleted", and session metadata "90 days operational". Both were
// unimplemented. Implementing them as literal row deletions is IMPOSSIBLE, and the reasons
// are structural rather than stylistic:
//
// (2026-08-15 — the authentication-data row has since been corrected to describe this
// sweeper. It promised a deletion the RESTRICT references below make impossible, and a
// content-parity pin held that sentence in place, so the claim was protected by a passing
// test. `a-retention-promise-matches-what-the-sweeper-does` now reads the verb from BOTH
// sides and fails on disagreement in either direction.)
//
//   • `usage_records.session_id` CASCADES from `sessions`. Deleting a 90-day-old session
//     would delete its usage records — which §9's own table requires be kept for 7 YEARS
//     ("Billing data | 7 years post-transaction (Dutch tax law, AWR Art 52)"). The naive
//     purge breaks a statutory obligation to satisfy a contractual one.
//   • `api_keys` is RESTRICT-referenced by `admin_audit_log`, `incidents`,
//     `incident_updates`, `rate_limit_overrides` and `sessions`. Audit rows outlive the key
//     by years precisely so an audit entry can never point at a vanished actor, so the row
//     cannot be deleted at all.
//
// §9's own closing paragraph authorises the alternative: "Driftstack deletes the Personal
// Data OR ANONYMISES IT (rendering it no longer attributable to a Data Subject). Anonymised
// aggregates may be retained for capacity planning." Keeping the row while scrubbing what
// identifies it is therefore the disclosed behaviour, not a workaround — and it is what the
// Session-metadata row's "aggregated counters retained indefinitely" clause describes.
//
// Design record: docs/internal/2026-08-12-retention-anonymisation-design.md
//
// ── Constraints discovered before writing these statements ──────────────────────────
//
//  1. `api_keys.key_prefix` carries `uniqueIndex('api_keys_prefix_unique')`, so it must NOT
//     be scrubbed to a shared sentinel — the second row would violate uniqueness. It is
//     left intact; it is a non-secret lookup fragment, not credential material.
//  2. `key_hash` has no unique index today, but its sentinel is still made PER-ROW UNIQUE
//     (`scrubbed:<id>`) so that adding one later cannot silently start failing the sweep.
//  3. `sessions.purpose` is an ENUM (`session_purpose`: production_customer /
//     cumulative_rig_validation / test_domain_probe), i.e. a fixed internal vocabulary and
//     NOT personal data — so it is deliberately NOT scrubbed. The customer-supplied fields
//     on `sessions` are `label` (text) and `metadata` (jsonb), both NULLABLE, so that scrub
//     needs no sentinel at all. Only `api_keys.name` and `api_keys.key_hash` are notNull
//     text, and those get a recognisable sentinel — support must read it as "scrubbed on
//     schedule", never as "corrupted".
//  4. `updated_at` is deliberately NOT bumped. Scrubbing is not account activity, and other
//     sweepers use timestamps as staleness anchors.

import { sql } from 'drizzle-orm';
import type { Database } from './client.js';

/**
 * Written into notNull text columns whose content was personal data. Deliberately
 * human-legible: an operator reading a support ticket must be able to tell this apart from
 * corruption.
 */
export const RETENTION_SCRUB_SENTINEL = '[scrubbed: retention]';

/**
 * §9: "90 days after revocation the record is anonymised" / "90 days operational".
 *
 * The authentication-data row used to read "retained 90 days for audit then
 * deleted", which nothing here ever did — it was corrected to describe this
 * sweeper rather than a deletion the RESTRICT references make impossible.
 */
export const RETENTION_WINDOW_DAYS = 90;

export interface RetentionScrubOutcome {
  /** Rows changed by THIS tick. Already-scrubbed rows are excluded, so repeats report 0. */
  readonly affected: number;
  /** True when the batch limit was hit — more remain, and the next tick will take them. */
  readonly capped: boolean;
}

export interface RetentionScrubRepo {
  scrubExpiredSessionMetadata(args: {
    olderThan: Date;
    limit: number;
  }): Promise<RetentionScrubOutcome>;
  deleteExpiredSessionOperations(args: {
    olderThan: Date;
    limit: number;
  }): Promise<RetentionScrubOutcome>;
  scrubExpiredRevokedApiKeys(args: {
    olderThan: Date;
    limit: number;
  }): Promise<RetentionScrubOutcome>;
}

/** postgres-js returns the RowList directly; pg/neon wrap it as { rows }. */
function rowCount(result: unknown): number {
  const wrapped = (result as { rows?: unknown[] }).rows;
  const rows = wrapped ?? (result as unknown[]);
  return Array.isArray(rows) ? rows.length : 0;
}

export class DrizzleRetentionScrubRepo implements RetentionScrubRepo {
  constructor(private readonly database: Database) {}

  /**
   * Null the customer-supplied `label` and `metadata` on sessions that ended more than the
   * window ago. The ROW SURVIVES — that is the whole point, because `usage_records` cascades
   * from it and §9 keeps billing data for 7 years.
   *
   * `purpose` and `archetype` are deliberately untouched: both are fixed internal
   * vocabularies, not personal data, and `purpose` is a Postgres enum that cannot hold a
   * sentinel anyway.
   *
   * Cutoff is `destroyed_at`, so a live session is never touched and a session with a NULL
   * `destroyed_at` stays the duration/orphan sweepers' business. `label IS NOT NULL OR
   * metadata IS NOT NULL` is the already-scrubbed guard, which makes repeat ticks report 0
   * instead of inflating the count forever. The predicate is repeated in the UPDATE's WHERE,
   * not just the CTE: the CTE is a snapshot, and re-checking under the row lock is what
   * stops a concurrently-resurrected row being scrubbed (#79).
   */
  async scrubExpiredSessionMetadata(args: {
    olderThan: Date;
    limit: number;
  }): Promise<RetentionScrubOutcome> {
    const cutoff = args.olderThan.toISOString();
    const result = await this.database.db.execute<{ id: string }>(sql`
      WITH due AS (
        SELECT id FROM sessions
         WHERE destroyed_at IS NOT NULL
           AND destroyed_at < ${cutoff}
           AND (label IS NOT NULL OR metadata IS NOT NULL)
         ORDER BY destroyed_at ASC
         LIMIT ${args.limit}
         FOR UPDATE SKIP LOCKED
      )
      UPDATE sessions s
         SET label = NULL,
             metadata = NULL
        FROM due
       WHERE s.id = due.id
         AND s.destroyed_at IS NOT NULL
         AND s.destroyed_at < ${cutoff}
         AND (s.label IS NOT NULL OR s.metadata IS NOT NULL)
       RETURNING s.id;
    `);
    const affected = rowCount(result);
    return { affected, capped: affected >= args.limit };
  }

  /**
   * Delete operation rows belonging to sessions that ended more than the window ago.
   *
   * DELETE rather than scrub here, and that asymmetry is deliberate: nothing references
   * `session_operations`, so removal is FK-safe, and `request_fingerprint` / `result` /
   * `error` are request payload traces with no aggregate value to preserve. The window is
   * the PARENT session's `destroyed_at`, so operations of a live session are never touched.
   */
  async deleteExpiredSessionOperations(args: {
    olderThan: Date;
    limit: number;
  }): Promise<RetentionScrubOutcome> {
    const cutoff = args.olderThan.toISOString();
    const result = await this.database.db.execute<{ id: string }>(sql`
      WITH due AS (
        SELECT so.id
          FROM session_operations so
          JOIN sessions s ON s.id = so.session_id
         WHERE s.destroyed_at IS NOT NULL
           AND s.destroyed_at < ${cutoff}
         ORDER BY so.created_at ASC
         LIMIT ${args.limit}
         FOR UPDATE OF so SKIP LOCKED
      )
      DELETE FROM session_operations so
       USING due
       WHERE so.id = due.id
       RETURNING so.id;
    `);
    const affected = rowCount(result);
    return { affected, capped: affected >= args.limit };
  }

  /**
   * Scrub the customer-supplied name and the credential hash off API keys revoked more than
   * the window ago. The ROW SURVIVES so `admin_audit_log` and the incident tables keep their
   * RESTRICT-protected attribution.
   *
   * `key_prefix` is intentionally left alone — it is uniquely indexed, so a shared sentinel
   * would collide, and it is a non-secret lookup fragment rather than credential material.
   * The `key_hash` sentinel is per-row unique for the same collision-safety reason.
   */
  async scrubExpiredRevokedApiKeys(args: {
    olderThan: Date;
    limit: number;
  }): Promise<RetentionScrubOutcome> {
    const cutoff = args.olderThan.toISOString();
    const result = await this.database.db.execute<{ id: string }>(sql`
      WITH due AS (
        SELECT id FROM api_keys
         WHERE revoked_at IS NOT NULL
           AND revoked_at < ${cutoff}
           AND name <> ${RETENTION_SCRUB_SENTINEL}
         ORDER BY revoked_at ASC
         LIMIT ${args.limit}
         FOR UPDATE SKIP LOCKED
      )
      UPDATE api_keys k
         SET name = ${RETENTION_SCRUB_SENTINEL},
             key_hash = 'scrubbed:' || k.id::text
        FROM due
       WHERE k.id = due.id
         AND k.revoked_at IS NOT NULL
         AND k.revoked_at < ${cutoff}
         AND k.name <> ${RETENTION_SCRUB_SENTINEL}
       RETURNING k.id;
    `);
    const affected = rowCount(result);
    return { affected, capped: affected >= args.limit };
  }
}
