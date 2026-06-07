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
//     clear for response fields.
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

  it('imports: and/desc/eq/isNotNull/isNull/lt/sql from drizzle-orm; 9 service types; Database; accounts + webhookDeliveries + webhookEndpoints schemas', () => {
    expect(body).toMatch(
      /import \{ and, desc, eq, isNotNull, isNull, lt, sql \} from 'drizzle-orm';/,
    );
    expect(body).toMatch(
      /import type \{\s*\n?\s*EndpointDeliveryCounts,\s*\n?\s*ListDeliveriesPage,\s*\n?\s*NewWebhookDeliveryInput,\s*\n?\s*NewWebhookEndpointInput,\s*\n?\s*WebhookDeliveryRow,\s*\n?\s*WebhookDeliveryStatus,\s*\n?\s*WebhookEndpointRow,\s*\n?\s*WebhookEventType,\s*\n?\s*WebhooksRepo,\s*\n?\s*\} from '\.\.\/services\/webhooks\.js';/,
    );
    expect(body).toMatch(
      /import \{ accounts, webhookDeliveries, webhookEndpoints \} from '\.\/schema\.js';/,
    );
  });

  it("insertEndpoint: 6-field values (accountId + url + secret + secretPrefix + events + description); throws 'insertEndpoint returned no row'", () => {
    expect(body).toMatch(
      /\.values\(\{\s*\n?\s*accountId: input\.accountId,\s*\n?\s*url: input\.url,\s*\n?\s*secret: input\.secret,\s*\n?\s*secretPrefix: input\.secretPrefix,\s*\n?\s*events: input\.events,\s*\n?\s*description: input\.description,\s*\n?\s*\}\)\s*\n?\s*\.returning\(\);/,
    );
    expect(body).toMatch(/if \(!row\) throw new Error\('insertEndpoint returned no row'\);/);
  });

  it("deliveryCountsByEndpoint framing pinned: 'GROUP BY endpoint_id + status — one row per (endpoint, status) tuple. Only counts statuses we care about for the dashboard surface; pending / in_flight aren't aggregated here.' + delivered/failed/dlq aggregation", () => {
    expect(body).toMatch(
      /\/\/ GROUP BY endpoint_id \+ status — one row per \(endpoint, status\)\s*\n?\s*\/\/ tuple\. Only counts statuses we care about for the dashboard\s*\n?\s*\/\/ surface; pending \/ in_flight aren't aggregated here\./,
    );
    expect(body).toMatch(/\.groupBy\(webhookDeliveries\.webhookId, webhookDeliveries\.status\);/);
    expect(body).toMatch(
      /if \(r\.status === 'delivered'\) existing\.delivered = r\.cnt;\s*\n?\s*else if \(r\.status === 'failed'\) existing\.failed = r\.cnt;\s*\n?\s*else if \(r\.status === 'dlq'\) existing\.dlq = r\.cnt;/,
    );
  });

  it('countActiveEndpoints: count(*)::int where and(accountId, active=true); disableEndpoint: 3-field set (active:false + disabledAt + updatedAt:new Date())', () => {
    expect(body).toMatch(
      /\.select\(\{ count: sql<number>`count\(\*\)::int` \}\)\s*\n?\s*\.from\(webhookEndpoints\)\s*\n?\s*\.where\(and\(eq\(webhookEndpoints\.accountId, accountId\), eq\(webhookEndpoints\.active, true\)\)\);/,
    );
    expect(body).toMatch(
      /async disableEndpoint\(id: string, at: Date\): Promise<void> \{\s*\n?\s*await this\.database\.db\s*\n?\s*\.update\(webhookEndpoints\)\s*\n?\s*\.set\(\{ active: false, disabledAt: at, updatedAt: new Date\(\) \}\)\s*\n?\s*\.where\(eq\(webhookEndpoints\.id, id\)\);\s*\n?\s*\}/,
    );
  });

  it("updateEndpoint: account-scoped + isNull(disabledAt) tombstone rationale 'disabled rows are tombstones'", () => {
    expect(body).toMatch(/\/\/ Account-scoped \+ not-disabled — disabled rows are tombstones\./);
    expect(body).toMatch(
      /\.where\(\s*\n?\s*and\(\s*\n?\s*eq\(webhookEndpoints\.id, input\.id\),\s*\n?\s*eq\(webhookEndpoints\.accountId, input\.accountId\),\s*\n?\s*isNull\(webhookEndpoints\.disabledAt\),\s*\n?\s*\),\s*\n?\s*\)\s*\n?\s*\.returning\(\);/,
    );
  });

  it("rotateSecret framing pinned: 'Single UPDATE: copy current secret/prefix INTO the prev slot, overwrite current with the new pair, set the grace expiry. No SELECT-then-UPDATE race — Postgres reads the row's current values at UPDATE time.'", () => {
    expect(body).toMatch(
      /\/\/ Single UPDATE: copy current secret\/prefix INTO the prev slot,\s*\n?\s*\/\/ overwrite current with the new pair, set the grace expiry\.\s*\n?\s*\/\/ No SELECT-then-UPDATE race — Postgres reads the row's current\s*\n?\s*\/\/ values at UPDATE time\./,
    );
    expect(body).toMatch(/secretPrev: sql`\$\{webhookEndpoints\.secret\}`,/);
  });

  it('enqueueDelivery: 4-field base values (webhookId + eventId + eventType + payload) + conditional nextAttemptAt spread', () => {
    expect(body).toMatch(
      /await this\.database\.db\.insert\(webhookDeliveries\)\.values\(\{\s*\n?\s*webhookId: input\.webhookId,\s*\n?\s*eventId: input\.eventId,\s*\n?\s*eventType: input\.eventType,\s*\n?\s*payload: input\.payload,\s*\n?\s*\.\.\.\(input\.nextAttemptAt !== undefined \? \{ nextAttemptAt: input\.nextAttemptAt \} : \{\}\),\s*\n?\s*\}\);/,
    );
  });

  it('listEndpointsSubscribedTo: events @> ARRAY[<eventType>] raw SQL contains-array on Postgres enum array; account+active filter', () => {
    expect(body).toMatch(
      /\/\/ events @> ARRAY\[<eventType>\] — every endpoint whose events array\s*\n?\s*\/\/ contains the eventType\./,
    );
    expect(body).toMatch(
      /sql`\$\{webhookEndpoints\.events\} @> ARRAY\[\$\{eventType\}\]::webhook_event_type\[\]`/,
    );
  });

  it("claim framing pinned: 'Atomic claim: SELECT ... FOR UPDATE SKIP LOCKED → UPDATE status = in_flight → RETURNING.' + ISO-string timestamp binder caveat; CTE with FOR UPDATE SKIP LOCKED + UPDATE...RETURNING", () => {
    expect(body).toMatch(
      /\/\/ Atomic claim: SELECT \.\.\. FOR UPDATE SKIP LOCKED → UPDATE status = in_flight\s*\n?\s*\/\/ → RETURNING\. ISO-string the timestamp because postgres-js's\s*\n?\s*\/\/ tagged-template binder rejects raw Date in this position\./,
    );
    expect(body).toMatch(/const nowIso = opts\.now\.toISOString\(\);/);
    expect(body).toMatch(/WITH claimed AS \(/);
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
      /UPDATE webhook_deliveries\s*\n?\s*SET status = 'in_flight', updated_at = NOW\(\)\s*\n?\s*WHERE id IN \(SELECT id FROM claimed\)\s*\n?\s*RETURNING \*/,
    );
  });

  it("recordDelivered: tx-bracketed; delivery set status='delivered' + endpoint counter RESET (consecutiveFailures:0 + lastSuccessAt); recordRetry: status='pending' + consecutiveFailures+=1 + lastFailureAt:new Date(); recordDlq: status='dlq' + consecutiveFailures+=1 + lastFailureAt:opts.at", () => {
    expect(body).toMatch(
      /\.set\(\{\s*\n?\s*status: 'delivered',\s*\n?\s*lastResponseStatus: opts\.responseStatus,\s*\n?\s*deliveredAt: opts\.at,\s*\n?\s*updatedAt: new Date\(\),\s*\n?\s*\}\)/,
    );
    expect(body).toMatch(
      /\.set\(\{\s*\n?\s*consecutiveFailures: 0,\s*\n?\s*lastSuccessAt: opts\.at,\s*\n?\s*updatedAt: new Date\(\),\s*\n?\s*\}\)/,
    );
    expect(body).toMatch(
      /\.set\(\{\s*\n?\s*consecutiveFailures: sql`\$\{webhookEndpoints\.consecutiveFailures\} \+ 1`,\s*\n?\s*lastFailureAt: new Date\(\),\s*\n?\s*updatedAt: new Date\(\),\s*\n?\s*\}\)/,
    );
    expect(body).toMatch(
      /\.set\(\{\s*\n?\s*status: 'dlq',\s*\n?\s*lastResponseStatus: opts\.responseStatus,\s*\n?\s*lastError: opts\.lastError,\s*\n?\s*updatedAt: opts\.at,\s*\n?\s*\}\)/,
    );
  });

  it('listDlqDeliveries: V-512 endpointId filter drill-down; limit+1 hasMore + nextCursor=last.createdAt.toISOString(); listDeliveriesForEndpoint: findEndpoint ownership-verify-before-listing + early-return on unowned', () => {
    expect(body).toMatch(
      /\/\/ V-512 — drill-down filter; uuid scoped to a single endpoint\s*\n?\s*\/\/ \(column is `webhook_id` at the schema level\)\./,
    );
    expect(body).toMatch(
      /\.orderBy\(desc\(webhookDeliveries\.createdAt\)\)\s*\n?\s*\.limit\(opts\.limit \+ 1\);\s*\n?\s*const hasMore = rows\.length > opts\.limit;\s*\n?\s*const items = hasMore \? rows\.slice\(0, opts\.limit\) : rows;\s*\n?\s*const last = items\[items\.length - 1\];\s*\n?\s*return \{\s*\n?\s*items: items\.map\(toDeliveryRow\),\s*\n?\s*nextCursor: hasMore && last \? last\.createdAt\.toISOString\(\) : null,\s*\n?\s*\};/,
    );
    expect(body).toMatch(
      /\/\/ Verify ownership before listing\.\s*\n?\s*const owned = await this\.findEndpoint\(endpointId, accountId\);\s*\n?\s*if \(!owned\) return \{ items: \[\], nextCursor: null \};/,
    );
  });

  it("resetDeliveryToPending: 8-field reset (status:'pending' + attempts:0 + nextAttemptAt + 4× null clears + updatedAt)", () => {
    expect(body).toMatch(
      /\.set\(\{\s*\n?\s*status: 'pending',\s*\n?\s*attempts: 0,\s*\n?\s*nextAttemptAt: at,\s*\n?\s*lastResponseStatus: null,\s*\n?\s*lastResponseExcerpt: null,\s*\n?\s*lastError: null,\s*\n?\s*deliveredAt: null,\s*\n?\s*updatedAt: at,\s*\n?\s*\}\)/,
    );
  });

  it("deleteDelivery: STATUS-MATCHED hard-delete — WHERE and(id, status='dlq') so a concurrent requeue (row flipped to 'pending' between the service check and this delete) matches 0 rows instead of nuking an active delivery; returns result.length > 0", () => {
    // The `AND status='dlq'` clause IS the race-safety mechanism the
    // admin discard path relies on (WebhooksAdminService.discardFromDlq).
    // Dropping it would silently allow hard-deleting a now-active row.
    expect(body).toMatch(
      /\.delete\(webhookDeliveries\)\s*\n?\s*\.where\(and\(eq\(webhookDeliveries\.id, deliveryId\), eq\(webhookDeliveries\.status, 'dlq'\)\)\)\s*\n?\s*\.returning\(\{ id: webhookDeliveries\.id \}\);\s*\n?\s*return result\.length > 0;/,
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

  it('toEndpointRow: 20-field WebhookEndpointRow (id + accountId + url + secret + secretPrefix + secretPrev + secretPrevExpiresAt + secretCreatedAt + lastReminderSentAt + graceWindowEndsAt + forceRotatedAt + events + description + active + consecutiveFailures + lastSuccessAt + lastFailureAt + disabledAt + 2 timestamps; secretCreatedAt + lastReminderSentAt added in v2-#10 migration 0048; graceWindowEndsAt + forceRotatedAt added in v2-#28 force-rotation slice)', () => {
    expect(body).toMatch(
      /function toEndpointRow\(r: typeof webhookEndpoints\.\$inferSelect\): WebhookEndpointRow \{\s*\n?\s*return \{\s*\n?\s*id: r\.id,\s*\n?\s*accountId: r\.accountId,\s*\n?\s*url: r\.url,\s*\n?\s*secret: r\.secret,\s*\n?\s*secretPrefix: r\.secretPrefix,\s*\n?\s*secretPrev: r\.secretPrev,\s*\n?\s*secretPrevExpiresAt: r\.secretPrevExpiresAt,\s*\n?\s*secretCreatedAt: r\.secretCreatedAt,\s*\n?\s*lastReminderSentAt: r\.lastReminderSentAt,[\s\S]*?graceWindowEndsAt: r\.graceWindowEndsAt,\s*\n?\s*forceRotatedAt: r\.forceRotatedAt,\s*\n?\s*events: r\.events,\s*\n?\s*description: r\.description,\s*\n?\s*active: r\.active,\s*\n?\s*consecutiveFailures: r\.consecutiveFailures,\s*\n?\s*lastSuccessAt: r\.lastSuccessAt,\s*\n?\s*lastFailureAt: r\.lastFailureAt,\s*\n?\s*disabledAt: r\.disabledAt,\s*\n?\s*createdAt: r\.createdAt,\s*\n?\s*updatedAt: r\.updatedAt,\s*\n?\s*\};\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
