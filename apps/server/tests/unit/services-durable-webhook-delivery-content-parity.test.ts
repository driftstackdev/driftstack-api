// W404.A — drift guard for apps/server/src/services/durable-webhook-delivery.ts.
// V-173 Postgres-backed @driftstack/webhook-delivery implementation
// (companion to V-164 in-memory). Drift here either breaks the
// SELECT...FOR UPDATE SKIP LOCKED claim invariant (concurrent
// workers double-deliver) or scrambles the v1 signature shape
// (customer verifiers stop validating).
//
//   • V-173 framing + coexistence note pinned: package-interface-
//     conformant Postgres-backed FORWARD path; webhooks.ts inline
//     production today; migration to fully replace is separate
//     future V-NNN.
//   • SELECT...FOR UPDATE SKIP LOCKED claim pattern reused inline
//     (mirrors existing webhook-worker.ts WebhooksRepo.claim).
//   • BACKOFF_MS_BY_ATTEMPT 5-entry exponential ladder (60s / 5m /
//     15m / 30m / 60m).
//   • DEFAULT_TIMEOUT_MS = 10_000; DEFAULT_MAX_ATTEMPTS = 6.
//   • WebhookEventType 5-literal union (session.completed /
//     session.failed / quota.warning_80pct / quota.exceeded /
//     api_key.revoked).
//   • DurableWebhookDeliveryService: enqueue inserts row with
//     status=pending + nextAttemptAt=now; replay flips to pending.
//   • list: limit clamp 200 max + 50 default; cursor by createdAt
//     desc + id desc; nextCursor only when hasMore.
//   • DurableDlqManager: list filters status='dlq' + optional
//     accountId via JOIN; discard FK-cascades to attempts.
//   • DurableWebhookWorker.processTick: SELECT FOR UPDATE SKIP
//     LOCKED claim → flip to in_flight in same txn → deliver loop
//     → success/dlq/retry branch.
//   • V-359 dual-sign during rotation grace: prev secret folded into
//     a second `v1=` of the single x-driftstack-signature header via
//     signWebhookPayload, only when secretPrev in grace window.
//   • Headers: x-driftstack-event-id / event-type / signature
//     (canonical t=,v1= form). No separate emitted-at / signature-prev.
//   • Signing delegated to canonical signWebhookPayload
//     (apps/server/src/lib/webhook-signing.ts) — single-header
//     `t=<sec>,v1=<hex>[,v1=<prevHex>]`, SDK-verifiable.
//   • AbortController timeout + 200-char responseExcerpt truncation
//     + 5xx/timeout → retry with backoff; attempts >= MAX_ATTEMPTS
//     → status=dlq.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/durable-webhook-delivery.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W404.A apps/server/src/services/durable-webhook-delivery.ts content parity', () => {
  const body = read(LIB);

  it('V-173 framing pinned + coexistence with V-164 inline webhooks.ts', () => {
    expect(body).toMatch(
      /V-173 — DurableWebhookDeliveryService: Postgres-backed implementation\s*\n?\s*\/\/\s*of @driftstack\/webhook-delivery's WebhookDeliveryService \+ DlqManager\s*\n?\s*\/\/\s*interfaces\. Companion to V-164 InMemoryWebhookDelivery\./,
    );
    expect(body).toMatch(
      /COEXISTENCE NOTE: apps\/server\/src\/services\/webhooks\.ts is the existing\s*\n?\s*\/\/\s*inline implementation \(production today\)\. V-173 lands the\s*\n?\s*\/\/\s*package-interface-conformant Postgres-backed implementation as the\s*\n?\s*\/\/\s*FORWARD path\./,
    );
  });

  it('SELECT...FOR UPDATE SKIP LOCKED claim invariant pinned (reused inline, not via WebhooksRepo.claim). Date interp converted to nowIso (2026-05-19 d9417a91 drift-guard: never interpolate raw Date in sql template literal — toISOString() at the boundary instead, since postgres-js Bind step calls Buffer.byteLength on the param).', () => {
    expect(body).toMatch(
      /Worker uses SELECT\.\.\.FOR UPDATE SKIP LOCKED for cross-process\s*\n?\s*\/\/\s*coordination \(the existing webhook-worker\.ts already uses this\s*\n?\s*\/\/\s*pattern via WebhooksRepo\.claim; V-173 reuses the same primitive\s*\n?\s*\/\/\s*inline rather than depending on the existing repo\)\./,
    );
    expect(body).toMatch(/const nowIso = nowDate\.toISOString\(\);/);
    // V-173.R — claim widened to also reclaim stale in_flight rows (a crashed/
    // redeployed worker's stranded row) so a delivery is never silently lost.
    expect(body).toMatch(
      /const staleBeforeIso = new Date\(nowMs - RECLAIM_STALE_IN_FLIGHT_MS\)\.toISOString\(\);/,
    );
    // The claim is no longer a single FIFO select. It ranks per endpoint in a
    // `due` CTE, caps and limits in `fair`, then takes the locks separately —
    // PostgreSQL forbids FOR UPDATE alongside a window function. Plain FIFO let
    // one DOWN endpoint fill every batch, and because the batch is delivered
    // serially those rows also consumed the tick timing out, so other
    // customers' webhooks were never attempted rather than merely delayed.
    // Behaviourally proved on the live claim in `db-webhook-delivery-fair-claim`;
    // held here and in `webhook-claim-fairness-parity` for this unwired path.
    expect(body).toMatch(/WITH due AS \(/);
    expect(body).toMatch(/row_number\(\) OVER \(PARTITION BY webhook_id/);
    expect(body).toMatch(/rn <= \$\{perEndpointCap\}/);
    expect(body).toMatch(/FOR UPDATE SKIP LOCKED/);
  });

  it('BACKOFF_MS_BY_ATTEMPT 5-entry ladder (60s / 5m / 15m / 30m / 60m); DEFAULT_TIMEOUT_MS=10_000; DEFAULT_MAX_ATTEMPTS=6', () => {
    expect(body).toMatch(
      /export const BACKOFF_MS_BY_ATTEMPT: Record<number, number> = \{\s*\n?\s*1: 60_000,\s*\n?\s*2: 5 \* 60_000,\s*\n?\s*3: 15 \* 60_000,\s*\n?\s*4: 30 \* 60_000,\s*\n?\s*5: 60 \* 60_000,\s*\n?\s*\};/,
    );
    expect(body).toMatch(/export const DEFAULT_TIMEOUT_MS = 10_000;/);
    expect(body).toMatch(/export const DEFAULT_MAX_ATTEMPTS = 6;/);
  });

  it('WebhookEventType: imported from @driftstack/api-types (canonical 9-value roster), not re-declared locally', () => {
    expect(body).toMatch(/import type \{ WebhookEventType \} from '@driftstack\/api-types';/);
    // No drift-prone local re-declaration (was a stale 5-value union missing
    // test.ping / egress / the V-666 crypto pair).
    expect(body).not.toMatch(/type WebhookEventType =/);
  });

  it('enqueue: insert row status=pending + attempts=0 + nextAttemptAt=now; replay: flips to pending + deliveredAt null', () => {
    expect(body).toMatch(
      /\.insert\(webhookDeliveries\)\s*\n?\s*\.values\(\{\s*\n?\s*webhookId: opts\.endpoint\.id,\s*\n?\s*eventId: opts\.payload\.eventId,\s*\n?\s*eventType: opts\.payload\.eventType as WebhookEventType,\s*\n?\s*payload: \{ body: opts\.payload\.body, emittedAtSec: opts\.payload\.emittedAtSec \},\s*\n?\s*status: 'pending',\s*\n?\s*attempts: 0,\s*\n?\s*nextAttemptAt: new Date\(nowMs\),/,
    );
    expect(body).toMatch(
      /\.update\(webhookDeliveries\)\s*\n?\s*\.set\(\{\s*\n?\s*status: 'pending',\s*\n?\s*nextAttemptAt: new Date\(nowMs\),\s*\n?\s*deliveredAt: null,\s*\n?\s*\}\)/,
    );
  });

  it('list: limit clamp 200 max + 50 default; cursor by createdAt desc + id desc; nextCursor only when hasMore', () => {
    expect(body).toMatch(/const limit = Math\.min\(opts\.limit \?\? 50, 200\);/);
    expect(body).toMatch(
      /\.orderBy\(desc\(webhookDeliveries\.createdAt\), desc\(webhookDeliveries\.id\)\)\s*\n?\s*\.limit\(limit \+ 1\);/,
    );
    expect(body).toMatch(
      /const hasMore = rows\.length > limit;\s*\n?\s*const page = hasMore \? rows\.slice\(0, limit\) : rows;/,
    );
    expect(body).toMatch(
      /const nextCursor = hasMore \? \(page\[page\.length - 1\]\?\.id \?\? null\) : null;/,
    );
  });

  it('DurableDlqManager.discard: FK CASCADE on webhook_delivery_attempts.delivery_id auto-cleanup framing', () => {
    expect(body).toMatch(
      /\/\/ FK CASCADE on webhook_delivery_attempts\.delivery_id cleans up the\s*\n?\s*\/\/ attempt log automatically\./,
    );
    expect(body).toMatch(
      /await this\.database\.db\.delete\(webhookDeliveries\)\.where\(eq\(webhookDeliveries\.id, deliveryId\)\);/,
    );
  });

  it('processTick: SELECT FOR UPDATE SKIP LOCKED claim → flip to in_flight (with updated_at = now staleness anchor) in same txn; default batchSize=25', () => {
    expect(body).toMatch(/const batchSize = opts\.batchSize \?\? 25;/);
    expect(body).toMatch(/\/\/ Atomic claim: SELECT due rows \+ flip to in_flight in one txn\./);
    // V-173.R — the in_flight flip sets updated_at = now so the reclaim
    // staleness anchor advances (otherwise a reclaimed row reads stale forever).
    expect(body).toMatch(
      /await tx\s*\n?\s*\.update\(webhookDeliveries\)\s*\n?\s*\.set\(\{ status: 'in_flight', updatedAt: nowDate \}\)\s*\n?\s*\.where\(inArray\(webhookDeliveries\.id, ids\)\);/,
    );
  });

  it('V-173.R review wjf04whfl #1 — the three terminal/retry UPDATEs fence on status=in_flight (.returning + 0-row no-op) so a stale/reclaimed worker cannot resurrect a finalized delivery', () => {
    // RECLAIM_STALE_IN_FLIGHT_MS constant exported + used as the reclaim anchor.
    expect(body).toMatch(/export const RECLAIM_STALE_IN_FLIGHT_MS = 5 \* 60 \* 1000;/);
    // Every terminal/retry UPDATE narrows its WHERE to the current in_flight
    // owner. There are exactly three (success / dlq / retry).
    // Format-tolerant: prettier may wrap the .where(...) across lines, so match
    // the fenced predicate itself (kept on one line) rather than the .where wrapper.
    const fenced = body.match(
      /and\(eq\(webhookDeliveries\.id, delivery\.id\), eq\(webhookDeliveries\.status, 'in_flight'\)\)/g,
    );
    expect(fenced?.length).toBe(3);
    // The success + dlq branches treat a 0-row result as a no-op (early-return).
    expect(body).toMatch(/if \(!updated\) return 'delivered';/);
    expect(body).toMatch(/if \(!updated\) return 'dlqed';/);
    // No terminal/retry UPDATE matches by id alone (the un-fenced pre-fix shape).
    expect(body).not.toMatch(
      /\.set\(\{[\s\S]*?status: 'delivered',[\s\S]*?\}\)\s*\n?\s*\.where\(eq\(webhookDeliveries\.id, delivery\.id\)\);/,
    );
  });

  it('V-359 dual-sign: prev secret folded into a second v1= via signWebhookPayload, only when secretPrev in grace window', () => {
    expect(body).toMatch(/const prevInGrace =\s*\n?\s*endpoint\.secretPrev !== null &&/);
    expect(body).toMatch(/endpoint\.secretPrevExpiresAt\.getTime\(\) > this\.now\(\);/);
    expect(body).toMatch(
      /const sigHeader = signWebhookPayload\(\{\s*\n?\s*body,\s*\n?\s*secret: endpoint\.secret,\s*\n?\s*\.\.\.\(prevInGrace \? \{ secretPrev: endpoint\.secretPrev as string \} : \{\}\),\s*\n?\s*\}\);/,
    );
    // Re-signs at ATTEMPT TIME — no override pinning the signed timestamp to
    // the enqueue time (would fail the SDK ±300s window on retries).
    expect(body).not.toMatch(/secretPrev as string \} : \{\}\),\s*\n?\s*timestampSec:/);
  });

  it('deliver headers: 3 x-driftstack-* headers (event-id / event-type / signature) + content-type; no emitted-at or signature-prev header', () => {
    expect(body).toMatch(/'content-type': 'application\/json',/);
    expect(body).toMatch(/'x-driftstack-event-id': delivery\.eventId,/);
    expect(body).toMatch(/'x-driftstack-event-type': delivery\.eventType,/);
    expect(body).toMatch(/'x-driftstack-signature': sigHeader,/);
    expect(body).not.toMatch(/'x-driftstack-emitted-at':/);
    expect(body).not.toMatch(/'x-driftstack-signature-prev':/);
  });

  it('deliver outcome: 2xx and session.failed suppress response bodies; other non-2xx retains bounded excerpt; timeout/transport stay classified', () => {
    expect(body).toMatch(/const successful = response\.status >= 200 && response\.status < 300;/);
    expect(body).toMatch(
      /const suppressResponseDiagnostics =\s*\n?\s*successful \|\| delivery\.eventType === 'session\.failed';/,
    );
    expect(body).toMatch(
      /const responseExcerpt = suppressResponseDiagnostics\s*\n?\s*\? null\s*\n?\s*: await readResponseExcerpt\(response\);/,
    );
    expect(body).toMatch(/if \(suppressResponseDiagnostics\) \{/);
    expect(body).toMatch(/outcome: successful \? 'success' : 'http_error',/);
    expect(body).toMatch(
      /const isTimeout = error\.name === 'AbortError' \|\| error\.name === 'TimeoutError';/,
    );
    expect(body).toMatch(/outcome: isTimeout \? 'timeout' : 'transport_error',/);
    expect(body).toMatch(
      /if \(delivery\.eventType === 'session\.failed'\) \{[\s\S]*?attempt = \{ \.\.\.attempt, responseExcerpt: null, errorMessage: null \};/,
    );
  });

  it('transport diagnostics: central redaction, exact timeout, and a 500-character pre/post bound', () => {
    expect(body).toMatch(/import \{ redactText \} from '\.\.\/lib\/redact-url\.js';/);
    expect(body).toMatch(/const TRANSPORT_ERROR_MAX_CHARS = 500;/);
    expect(body).toMatch(/errorMessage: safeTransportError\(error\),/);
    expect(body).toMatch(
      /if \(error\.name === 'AbortError' \|\| error\.name === 'TimeoutError'\) return 'timeout';/,
    );
    expect(body).toMatch(/error\.message\.slice\(0, TRANSPORT_ERROR_MAX_CHARS\)/);
    expect(body).toMatch(
      /\(redactText\(bounded\) \|\| 'transport failure'\)\.slice\(0, TRANSPORT_ERROR_MAX_CHARS\)/,
    );
    expect(body).not.toMatch(/errorMessage: e\?\.message/);
  });

  it('response lifecycle: success body cancelled; failure body capped at 64 KiB decoded bytes and 200 characters without retaining an oversized chunk', () => {
    expect(body).toMatch(/const RESPONSE_READ_MAX_BYTES = 64 \* 1024;/);
    expect(body).toMatch(/const RESPONSE_EXCERPT_MAX_CHARS = 200;/);
    expect(body).toMatch(/await response\.body\?\.cancel\(\)\.catch\(\(\) => undefined\);/);
    expect(body).toMatch(/const reader = response\.body\.getReader\(\);/);
    expect(body).toMatch(/const bytesToKeep = Math\.min\(value\.byteLength, remaining\);/);
    expect(body).toMatch(
      /decoder\.decode\(value\.subarray\(0, bytesToKeep\), \{ stream: true \}\)/,
    );
    expect(body).toMatch(/parts\.join\(''\)\.slice\(0, RESPONSE_EXCERPT_MAX_CHARS\)/);
    expect(body).not.toMatch(/await response\.text\(\)/);
  });

  it('deliver branch: success → status=delivered + lastError=null; attempts>=MAX_ATTEMPTS → status=dlq; else → status=pending with backoff', () => {
    expect(body).toMatch(
      /if \(attempt\.outcome === 'success'\) \{[\s\S]+?status: 'delivered',[\s\S]+?lastError: null,/,
    );
    expect(body).toMatch(/if \(attemptNumber >= DEFAULT_MAX_ATTEMPTS\) \{[\s\S]+?status: 'dlq',/);
    expect(body).toMatch(
      /const backoffMs = BACKOFF_MS_BY_ATTEMPT\[attemptNumber\] \?\? 60 \* 60_000;/,
    );
    expect(body).toMatch(/nextAttemptAt: new Date\(this\.now\(\) \+ backoffMs\),/);
  });

  it('signing delegated to the canonical signWebhookPayload (t=,v1= header); no local bare-hex signPayload', () => {
    expect(body).toMatch(/import \{ signWebhookPayload \} from '\.\.\/lib\/webhook-signing\.js';/);
    expect(body).not.toMatch(/export function signPayload\(/);
  });

  it('rowToDeliveryRecord: terminal states (delivered/failed/dlq) → nextAttemptAtMs=null; else getTime()', () => {
    expect(body).toMatch(
      /nextAttemptAtMs:\s*\n?\s*row\.status === 'delivered' \|\| row\.status === 'failed' \|\| row\.status === 'dlq'\s*\n?\s*\?\s*null\s*\n?\s*:\s*row\.nextAttemptAt\.getTime\(\),/,
    );
  });

  it('DurableWebhookDeliveryDeps: database + fetch? test seam (defaults to ssrfGuardedFetch) + now? test seam (defaults to Date.now)', () => {
    expect(body).toMatch(/export interface DurableWebhookDeliveryDeps \{/);
    expect(body).toMatch(/database: Database;/);
    expect(body).toMatch(
      /\/\*\* Test seam — defaults to the SSRF-guarded fetch \(connection-time DNS pin\)\. \*\/\s*\n?\s*fetch\?: typeof fetch;/,
    );
    expect(body).toMatch(
      /\/\*\* Test seam — defaults to \(\) => Date\.now\(\)\. \*\/\s*\n?\s*now\?: \(\) => number;/,
    );
    expect(body).toMatch(/const now = deps\.now \?\? \(\(\) => Date\.now\(\)\);/);
    // SSRF hardening — the outbound delivery fetch must NOT follow redirects
    // (a 3xx to an internal target would bypass the create-time https-only check).
    expect(body).toMatch(/redirect: 'error',/);
  });

  it('SSRF-safe-by-default invariant: the durable sender (V-173 FORWARD path) defaults its fetch to ssrfGuardedFetch — same connection-time DNS-rebind pin the live webhook-worker.ts poller uses — so a future cutover cannot silently lose the guard', () => {
    // The import is wired (the guard lives in apps/server/src/lib).
    expect(body).toMatch(/import \{ ssrfGuardedFetch \} from '\.\.\/lib\/ssrf-guarded-fetch\.js';/);
    // The default is the guarded fetch — NOT bare globalThis.fetch (the
    // create-time webhook-target-guard can't stop DNS rebind; this is the
    // connection-time layer, and it must be the DEFAULT, not opt-in).
    expect(body).toMatch(/const fetchFn = deps\.fetch \?\? ssrfGuardedFetch;/);
    expect(body).not.toMatch(/const fetchFn = deps\.fetch \?\? globalThis\.fetch/);
  });

  it('imports: drizzle-orm helpers (and/asc/desc/eq/inArray/lt/or/sql) + signWebhookPayload + webhook-delivery package types + Database + schema', () => {
    expect(body).toMatch(/import \{ signWebhookPayload \} from '\.\.\/lib\/webhook-signing\.js';/);
    expect(body).toMatch(
      /import \{ and, asc, desc, eq, inArray, lt, or, sql \} from 'drizzle-orm';/,
    );
    expect(body).toMatch(
      /import type \{\s*\n?\s*DlqManager,\s*\n?\s*EnqueueDeliveryOpts,\s*\n?\s*ListDeliveriesOpts,\s*\n?\s*ListDeliveriesPage,\s*\n?\s*RequeueDlqOpts,\s*\n?\s*WebhookDeliveryService,\s*\n?\s*\} from '@driftstack\/webhook-delivery';/,
    );
    expect(body).toMatch(/import type \{ Database \} from '\.\.\/db\/client\.js';/);
    expect(body).toMatch(
      /import \{ webhookDeliveries, webhookDeliveryAttempts, webhookEndpoints \} from '\.\.\/db\/schema\.js';/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
