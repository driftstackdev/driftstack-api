// W449.C — drift guard for apps/server/src/db/webhooks-repo.ts.
// DrizzleWebhooksRepo. Drift here either drops the CTE+FOR UPDATE
// SKIP LOCKED on claim() (concurrent workers double-deliver the
// same pending webhook) or breaks rotateSecret's single-UPDATE
// (the SELECT-then-UPDATE race would lose a delivery's signature
// verification across the rotation window).
//
//   • insertEndpoint: 6-field values; throws on no-row.
//   • listEndpoints: account-scoped + orderBy desc(createdAt).
//   • deliveryCountsByEndpoint framing pinned: GROUP BY (endpoint,
//     status) — one row per (endpoint, status) tuple. Aggregates
//     delivered/failed/dlq only; pending/in_flight excluded.
//   • findEndpoint (account-scoped) + findEndpointById (admin path).
//   • countActiveEndpoints: count(*) where and(accountId, active=true).
//   • disableEndpoint: 3-field set (active:false + disabledAt +
//     updatedAt).
//   • updateEndpoint: selective spread + isNull(disabledAt) — tombstone
//     rationale 'disabled rows are tombstones'.
//   • rotateSecret framing pinned: 'Single UPDATE: copy current
//     secret/prefix INTO the prev slot, overwrite current with new
//     pair, set grace expiry. No SELECT-then-UPDATE race.'
//   • enqueueDelivery: 4-field base + conditional nextAttemptAt spread.
//   • listEndpointsSubscribedTo: events @> ARRAY[<eventType>] raw SQL
//     contains-array on Postgres enum array.
//   • claim framing pinned: 'Atomic claim: SELECT ... FOR UPDATE SKIP
//     LOCKED → UPDATE status = in_flight → RETURNING.' + ISO-string
//     timestamp binder caveat.
//   • record{Delivered,Retry,Dlq}: tx-bracketed delivery update +
//     endpoint counter bump (consecutiveFailures reset on delivered;
//     ++1 on retry/dlq; lastSuccessAt/lastFailureAt timestamps).
//   • listDlqDeliveries + listDeliveriesForEndpoint: limit+1 hasMore
//     + nextCursor=createdAt.toISOString() convention; V-512 endpointId
//     filter on listDlqDeliveries.
//   • resetDeliveryToPending: 8-field reset incl. attempts:0 + null
//     clear for response fields; WHERE and(id, status != 'in_flight')
//     so a replay can't stomp a row a worker currently has claimed.
//   • rawToDeliveryRow: snake_case→camelCase mapping for postgres-js
//     CTE result row.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/db/webhooks-repo.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W449.C apps/server/src/db/webhooks-repo.ts content parity', () => {
  const body = read(LIB);

  it("header framing pinned: 'Drizzle-backed implementation of WebhooksRepo.'", () => {
    expect(body).toMatch(/\/\/ Drizzle-backed implementation of WebhooksRepo\./);
  });

  it('imports record identity plus migration/query helpers and the established service/schema types', () => {
    // gt/lte (Arc 3 sub-slice 28.5 follow-up) are typed drizzle
    // comparison operators, not raw `sql` template interpolation — they
    // sidestep the drizzle-orm Date-param-in-raw-sql crash class
    // entirely (docs/internal/drizzle-date-param-workaround.md), same
    // rationale as the existing lt(webhookEndpoints.secretCreatedAt, cutoff)
    // / lt(webhookEndpoints.secretPrevExpiresAt, args.now) call sites below.
    expect(body).toContain("import { randomUUID } from 'node:crypto';");
    for (const token of [
      'and',
      'asc',
      'count',
      'desc',
      'eq',
      'gt',
      'isNotNull',
      'isNull',
      'lte',
      'lt',
      'ne',
      'or',
      'sql',
    ]) {
      expect(body).toMatch(new RegExp(`\\b${token}\\b`));
    }
    expect(body).toMatch(
      /import type \{\s*EndpointDeliveryCounts,\s*ListDeliveriesPage,\s*NewWebhookDeliveryInput,\s*NewWebhookEndpointInput,\s*WebhookDeliveryRow,\s*WebhookDeliveryStatus,\s*WebhookEndpointRow,\s*WebhookEventType,\s*WebhooksRepo,\s*\} from '\.\.\/services\/webhooks\.js';/,
    );
    expect(body).toMatch(
      /import \{ accounts, webhookDeliveries, webhookEndpoints \} from '\.\/schema\.js';/,
    );
  });

  it("insertEndpoint preallocates the final UUID and encrypts under its account+endpoint tuple; throws 'insertEndpoint returned no row'", () => {
    expect(body).toMatch(/const endpointId = randomUUID\(\);/);
    expect(body).toMatch(
      /\.values\(\{\s*id: endpointId,\s*accountId: input\.accountId,[\s\S]*?secret: this\.encryptForStorage\(input\.secret, \{\s*accountId: input\.accountId,\s*endpointId,\s*\}\),[\s\S]*?description: input\.description,\s*\}\)\s*\.returning\(\);/,
    );
    expect(body).toMatch(/if \(!row\) throw new Error\('insertEndpoint returned no row'\);/);
  });

  it("deliveryCountsByEndpoint framing pinned: 'GROUP BY endpoint_id + status — one row per (endpoint, status) tuple. Only counts statuses we care about for the dashboard surface; pending / in_flight aren't aggregated here.' + delivered/failed/dlq aggregation", () => {
    expect(body).toMatch(
      /\/\/ GROUP BY endpoint_id \+ status — one row per \(endpoint, status\)\s*\/\/ tuple\. Only counts statuses we care about for the dashboard\s*\/\/ surface; pending \/ in_flight aren't aggregated here\./,
    );
    expect(body).toMatch(/\.groupBy\(webhookDeliveries\.webhookId, webhookDeliveries\.status\);/);
    expect(body).toMatch(
      /if \(r\.status === 'delivered'\) existing\.delivered = r\.cnt;\s*else if \(r\.status === 'failed'\) existing\.failed = r\.cnt;\s*else if \(r\.status === 'dlq'\) existing\.dlq = r\.cnt;/,
    );
  });

  it('countActiveEndpoints: count(*)::int where and(accountId, active=true); disableEndpoint: 3-field set (active:false + disabledAt + updatedAt:new Date())', () => {
    expect(body).toMatch(
      /\.select\(\{ count: sql<number>`count\(\*\)::int` \}\)\s*\.from\(webhookEndpoints\)\s*\.where\(and\(eq\(webhookEndpoints\.accountId, accountId\), eq\(webhookEndpoints\.active, true\)\)\);/,
    );
    expect(body).toMatch(
      /async disableEndpoint\(id: string, at: Date\): Promise<void> \{\s*await this\.database\.db\s*\.update\(webhookEndpoints\)\s*\.set\(\{ active: false, disabledAt: at, updatedAt: new Date\(\) \}\)\s*\.where\(eq\(webhookEndpoints\.id, id\)\);\s*\}/,
    );
  });

  it("updateEndpoint: account-scoped + isNull(disabledAt) tombstone rationale 'disabled rows are tombstones'", () => {
    expect(body).toMatch(/\/\/ Account-scoped \+ not-disabled — disabled rows are tombstones\./);
    expect(body).toMatch(
      /\.where\(\s*and\(\s*eq\(webhookEndpoints\.id, input\.id\),\s*eq\(webhookEndpoints\.accountId, input\.accountId\),\s*isNull\(webhookEndpoints\.disabledAt\),\s*\),\s*\)\s*\.returning\(\);/,
    );
  });

  it("rotateSecret framing pinned: 'Single UPDATE: copy current secret/prefix INTO the prev slot, overwrite current with the new pair, set the grace expiry. No SELECT-then-UPDATE race — Postgres reads the row's current values at UPDATE time.'", () => {
    expect(body).toMatch(
      /\/\/ Single UPDATE: copy current secret\/prefix INTO the prev slot,\s*\/\/ overwrite current with the new pair, set the grace expiry\.\s*\/\/ No SELECT-then-UPDATE race — Postgres reads the row's current\s*\/\/ values at UPDATE time\./,
    );
    // V-359.G.2 (Fable audit 2026-07-03): the prev slot preserves the customer's
    // still-deployed secret under a live FORCE-rotation grace (forceRotatedAt set +
    // not-yet-expired) rather than clobbering it with the un-deployed force secret —
    // else the worker dual-signs {new, force} and both fail the customer's verifier.
    expect(body).toMatch(
      /secretPrev: sql`CASE WHEN \$\{webhookEndpoints\.forceRotatedAt\} IS NOT NULL AND \$\{webhookEndpoints\.secretPrevExpiresAt\} > \$\{nowIso\}::timestamptz THEN \$\{webhookEndpoints\.secretPrev\} ELSE \$\{webhookEndpoints\.secret\} END`,/,
    );
    expect(body).toMatch(/const nowIso = input\.now\.toISOString\(\);/);
  });

  it('enqueueDelivery: 4-field base values (webhookId + eventId + eventType + payload) + conditional nextAttemptAt spread + RETURNING id (returns the real delivery row id)', () => {
    expect(body).toMatch(
      /const \[row\] = await this\.database\.db\s*\.insert\(webhookDeliveries\)\s*\.values\(\{\s*webhookId: input\.webhookId,\s*eventId: input\.eventId,\s*eventType: input\.eventType,\s*payload: input\.payload,\s*\.\.\.\(input\.nextAttemptAt !== undefined \? \{ nextAttemptAt: input\.nextAttemptAt \} : \{\}\),\s*\}\)\s*\.returning\(\{ id: webhookDeliveries\.id \}\);/,
    );
    // returns the real DB row id (not the eventId) so a test-event delivery_id resolves.
    expect(body).toMatch(/return row\.id;/);
  });

  it('listEndpointsSubscribedTo: events @> ARRAY[<eventType>] raw SQL contains-array on Postgres enum array; account+active filter', () => {
    expect(body).toMatch(
      /\/\/ events @> ARRAY\[<eventType>\] — every endpoint whose events array\s*\/\/ contains the eventType\./,
    );
    expect(body).toMatch(
      /sql`\$\{webhookEndpoints\.events\} @> ARRAY\[\$\{eventType\}\]::webhook_event_type\[\]`/,
    );
  });

  it("claim framing pinned: 'Atomic claim: SELECT ... FOR UPDATE SKIP LOCKED → UPDATE status = in_flight → RETURNING.' + ISO-string timestamp binder caveat; CTE with FOR UPDATE SKIP LOCKED + UPDATE...RETURNING", () => {
    expect(body).toMatch(
      /\/\/ Atomic claim: SELECT \.\.\. FOR UPDATE SKIP LOCKED → UPDATE status = in_flight\s*\/\/ → RETURNING\. ISO-string the timestamp because postgres-js's\s*\/\/ tagged-template binder rejects raw Date in this position\./,
    );
    expect(body).toMatch(/const nowIso = opts\.now\.toISOString\(\);/);
    // The claim is now three CTEs: `due` ranks per endpoint, `fair` caps and
    // limits, `claimed` takes the locks. Split because a single FIFO
    // `ORDER BY next_attempt_at LIMIT n` let one down endpoint fill every batch
    // and — since delivery is serial — stop other customers' webhooks being
    // attempted at all. The lock is separate because PostgreSQL forbids FOR
    // UPDATE alongside a window function; SKIP LOCKED still applies.
    expect(body).toMatch(/WITH due AS \(/);
    expect(body).toMatch(/row_number\(\) OVER \(PARTITION BY webhook_id/);
    expect(body).toMatch(/claimed AS \(/);
    expect(body).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(body).toMatch(/SELECT id FROM webhook_deliveries/);
    // V-173.R — claim covers due-pending AND stale-in_flight reclaim (discrete
    // pins; the WHERE grew past the safe \s*\n? chain length).
    expect(body).toMatch(/\(status = 'pending' AND next_attempt_at <= \$\{nowIso\}::timestamptz\)/);
    expect(body).toMatch(
      /\(status = 'in_flight' AND updated_at <= \$\{staleBeforeIso\}::timestamptz\)/,
    );
    expect(body).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(body).toMatch(/const RECLAIM_STALE_IN_FLIGHT_MS = 5 \* 60 \* 1000;/);
    expect(body).toMatch(
      /const staleBeforeIso = new Date\(opts\.now\.getTime\(\) - RECLAIM_STALE_IN_FLIGHT_MS\)\.toISOString\(\);/,
    );
    expect(body).toMatch(
      /UPDATE webhook_deliveries\s*SET status = 'in_flight', updated_at = NOW\(\)\s*WHERE id IN \(SELECT id FROM claimed\)\s*RETURNING \*/,
    );
  });

  it("recordDelivered: tx-bracketed; delivery set status='delivered' + endpoint counter RESET (consecutiveFailures:0 + lastSuccessAt); recordRetry: status='pending' + lastFailureAt only (the per-DELIVERY counter is NOT advanced by a retry attempt); recordDlq: status='dlq' + consecutiveFailures+=1 + lastFailureAt:opts.at", () => {
    expect(body).toMatch(
      /\.set\(\{\s*status: 'delivered',\s*lastResponseStatus: opts\.responseStatus,\s*deliveredAt: opts\.at,\s*updatedAt: new Date\(\),\s*\}\)/,
    );
    expect(body).toMatch(
      /\.set\(\{\s*consecutiveFailures: 0,\s*lastSuccessAt: opts\.at,\s*updatedAt: new Date\(\),\s*\}\)/,
    );
    // recordRetry must NOT advance consecutiveFailures. That counter is the
    // per-DELIVERY signal the docs tell customers to monitor ("increments on
    // each failed delivery"; "auto-disabled after 50 consecutive failed
    // deliveries"), and MAX_ATTEMPTS is 6 — counting attempts tombstoned an
    // endpoint after ~9 failed deliveries instead of 50, irreversibly. The
    // behavioural proof is db-webhooks-repo-consecutive-failures-drizzle.
    expect(body).toMatch(/\.set\(\{\s*\/\/ NOT consecutiveFailures\./);
    expect(body).not.toMatch(
      /\.set\(\{\s*consecutiveFailures: sql`\$\{webhookEndpoints\.consecutiveFailures\} \+ 1`,\s*lastFailureAt: new Date\(\),/,
    );
    expect(body).toMatch(
      /\.set\(\{\s*status: 'dlq',\s*lastResponseStatus: opts\.responseStatus,\s*lastError: opts\.lastError,\s*updatedAt: opts\.at,\s*\}\)/,
    );
  });

  it('listDlqDeliveries: V-512 endpointId filter drill-down; limit+1 hasMore + composite (createdAt,id) keyset cursor (#125, no boundary-ms row drops); listDeliveriesForEndpoint: findEndpoint ownership-verify-before-listing + early-return on unowned', () => {
    expect(body).toMatch(
      /\/\/ V-512 — drill-down filter; uuid scoped to a single endpoint\s*\/\/ \(column is `webhook_id` at the schema level\)\./,
    );
    // #125 — deterministic composite ordering (createdAt DESC, id DESC) so the
    // keyset can tiebreak on id and never drop rows sharing the boundary ms.
    expect(body).toMatch(
      /\.orderBy\(desc\(webhookDeliveries\.createdAt\), desc\(webhookDeliveries\.id\)\)\s*\.limit\(opts\.limit \+ 1\);\s*const hasMore = rows\.length > opts\.limit;\s*const items = hasMore \? rows\.slice\(0, opts\.limit\) : rows;\s*const last = items\[items\.length - 1\];\s*return \{\s*items: items\.map\(toDeliveryRow\),\s*nextCursor: hasMore && last \? encodeDeliveryCursor\(last\.createdAt, last\.id\) : null,\s*\};/,
    );
    // The composite keyset predicate (created_at < T OR (created_at = T AND id < lastId)).
    expect(body).toMatch(
      /return or\(\s*lt\(webhookDeliveries\.createdAt, cursor\.createdAt\),\s*and\(eq\(webhookDeliveries\.createdAt, cursor\.createdAt\), lt\(webhookDeliveries\.id, cursor\.id\)\),\s*\);/,
    );
    expect(body).toMatch(
      /\/\/ Verify ownership before listing\.\s*const owned = await this\.findEndpoint\(endpointId, accountId\);\s*if \(!owned\) return \{ items: \[\], nextCursor: null \};/,
    );
  });

  it("resetDeliveryToPending: 8-field reset (status:'pending' + attempts:0 + nextAttemptAt + 4× null clears + updatedAt)", () => {
    expect(body).toMatch(
      /\.set\(\{\s*status: 'pending',\s*attempts: 0,\s*nextAttemptAt: at,\s*lastResponseStatus: null,\s*lastResponseExcerpt: null,\s*lastError: null,\s*deliveredAt: null,\s*updatedAt: at,\s*\}\)/,
    );
  });

  it("resetDeliveryToPending: WHERE and(id, status != 'in_flight') — fences OUT in_flight (not IN 'dlq') so customer/admin replay of a non-DLQ row still works, but can't stomp a row a worker currently has claimed", () => {
    expect(body).toMatch(
      /\.where\(and\(eq\(webhookDeliveries\.id, deliveryId\), ne\(webhookDeliveries\.status, 'in_flight'\)\)\)\s*\.returning\(\);\s*return row \? toDeliveryRow\(row\) : null;/,
    );
  });

  it("deleteDelivery: STATUS-MATCHED hard-delete — WHERE and(id, status='dlq') so a concurrent requeue (row flipped to 'pending' between the service check and this delete) matches 0 rows instead of nuking an active delivery; returns result.length > 0", () => {
    // The `AND status='dlq'` clause IS the race-safety mechanism the
    // admin discard path relies on (WebhooksAdminService.discardFromDlq).
    // Dropping it would silently allow hard-deleting a now-active row.
    expect(body).toMatch(
      /\.delete\(webhookDeliveries\)\s*\.where\(and\(eq\(webhookDeliveries\.id, deliveryId\), eq\(webhookDeliveries\.status, 'dlq'\)\)\)\s*\.returning\(\{ id: webhookDeliveries\.id \}\);\s*return result\.length > 0;/,
    );
  });

  it("rawToDeliveryRow framing pinned: 'Raw postgres-js rows returned from the CTE come as snake_case strings.' + snake_case→camelCase mapping incl. attempts→Number/timestamps→new Date()", () => {
    expect(body).toMatch(
      /\/\*\* Raw postgres-js rows returned from the CTE come as snake_case strings\. \*\//,
    );
    expect(body).toMatch(
      /function rawToDeliveryRow\(r: Record<string, unknown>\): WebhookDeliveryRow \{[\s\S]*?webhookId: r\.webhook_id as string,[\s\S]*?attempts: Number\(r\.attempts\),[\s\S]*?nextAttemptAt: new Date\(r\.next_attempt_at as string\),[\s\S]*?deliveredAt: r\.delivered_at \? new Date\(r\.delivered_at as string\) : null,/,
    );
  });

  it('toEndpointRow requires the key and binds both current/previous ordinary reads to account+endpoint', () => {
    expect(body).toMatch(
      /function toEndpointRow\([\s\S]*?if \(secretEncryptionKeyBase64 === undefined\)[\s\S]*?const context = \{ accountId: r\.accountId, endpointId: r\.id \};[\s\S]*?secret: readWebhookSecret\(r\.secret, secretEncryptionKeyBase64, context\),[\s\S]*?readWebhookSecret\(r\.secretPrev, secretEncryptionKeyBase64, context\)[\s\S]*?updatedAt: r\.updatedAt,/,
    );
  });

  it('prevalidates bounded legacy pages and exact-CASes id+account+both old slots while updating secrets only', () => {
    expect(body).toMatch(/const MAX_WEBHOOK_SECRET_MIGRATION_BATCH = 500;/);
    expect(body).toMatch(/const prepared = rows\.map\(\(row\) =>/);
    expect(body).toMatch(/convertWebhookSecretToV2\(row\.secret, encryptionKey, context\)/);
    expect(body).toMatch(/async encryptLegacySecrets\([\s\S]*?remaining: number/);
    expect(body).toMatch(/eq\(webhookEndpoints\.secret, row\.secret\)/);
    expect(body).toMatch(/eq\(webhookEndpoints\.accountId, row\.accountId\)/);
    expect(body).toMatch(
      /webhookEndpoints\.secretPrev\} IS NOT DISTINCT FROM \$\{row\.secretPrev\}/,
    );
    expect(body).toMatch(/\.set\(\{ secret, secretPrev \}\)/);
    expect(body).toMatch(/return \{ scanned: rows\.length, converted, remaining:/);
    expect(body).toMatch(/\.where\(webhookSecretsAreV2\(\)\)/);
    expect(body).toMatch(/\.where\(webhookSecretsAreNotV2\(\)\)/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
