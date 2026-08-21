// W408.C — drift guard for apps/server/src/services/webhook-worker.ts.
// V-164 inline webhook delivery worker. Long-running claim → POST →
// observe → record loop. Drift here either breaks the 6-attempt
// exponential backoff schedule (DLQ boundary regression) or
// scrambles MAX_ATTEMPTS=6 / AUTO_DISABLE=50 thresholds.
//
//   • V-164 framing pinned: 5-step loop (claim → sign+POST →
//     observe → recordDelivered|recordRetry|recordDlq → maybe
//     auto-disable on consecutiveFailures cross).
//   • Process-local loop framing: SELECT FOR UPDATE SKIP LOCKED
//     coordinates across instances (in DrizzleWebhooksRepo.claim).
//   • MAX_ATTEMPTS = 6 (0..5 inclusive = 6 total tries including
//     initial); AUTO_DISABLE_AFTER_CONSECUTIVE_FAILURES = 50.
//   • BACKOFF_MS_BY_ATTEMPT 5-entry ladder (1min / 5min / 15min /
//     30min / 60min).
//   • Defaults: DEFAULT_TIMEOUT_MS=10_000; DEFAULT_IDLE_SLEEP_MS=
//     2_000; DEFAULT_BATCH_SIZE=25.
//   • Endpoint disabled/deleted between enqueue and claim → direct
//     DLQ (no recoverable path).
//   • POST headers: content-type + x-driftstack-signature + event-
//     id + event-type + user-agent driftstack-webhooks/1.0.
//   • V-093 durationMs: Date.now() reporting (~1ms precision OK);
//     excludes body serialization + signing.
//   • handleOutcome: 2xx → recordDelivered; AbortError.name →
//     lastError='timeout'; jitter = floor(random*backoff*0.15) on
//     retry.
//   • DeliveryOutcome 3-kind union (delivered | retry | dlq).
//   • readExcerpt: SIZE-capped bounded body-stream read
//     (MAX_RESPONSE_READ_BYTES) + cancel (undici decompression-bomb /
//     huge-body defense), EXCERPT_MAX_CHARS=4096 slice; text() fallback
//     when no body stream; try/catch null fallback.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/webhook-worker.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W408.C apps/server/src/services/webhook-worker.ts content parity', () => {
  const body = read(LIB);

  it('V-164 framing pinned: 5-step loop (claim → sign+POST → observe → record* → maybe auto-disable)', () => {
    expect(body).toMatch(/Webhook delivery worker\./);
    expect(body).toMatch(
      /1\. Claim a batch of pending deliveries whose nextAttemptAt is past\s*\n?\s*\/\/\s*2\. For each: build the signed POST, send via fetch, observe response\s*\n?\s*\/\/\s*3\. On 2xx → recordDelivered \(resets endpoint\.consecutiveFailures\)\s*\n?\s*\/\/\s*4\. On non-2xx \/ network \/ timeout → recordRetry \(if attempts < MAX\) or\s*\n?\s*\/\/\s*recordDlq \(if attempts == MAX\)\. Only recordDlq bumps\s*\n?\s*\/\/\s*endpoint\.consecutiveFailures: that counter is a per-DELIVERY signal, and\s*\n?\s*\/\/\s*a retry is an attempt WITHIN one delivery\.\s*\n?\s*\/\/\s*5\. If endpoint\.consecutiveFailures crosses the auto-disable threshold,\s*\n?\s*\/\/\s*mark the endpoint disabled\./,
    );
    expect(body).toMatch(
      /The loop is process-local; in production we'd run one worker per app\s*\n?\s*\/\/\s*instance and rely on SELECT\.\.\.FOR UPDATE SKIP LOCKED to coordinate\s*\n?\s*\/\/\s*\(already in DrizzleWebhooksRepo\.claim\)\./,
    );
  });

  it('MAX_ATTEMPTS = 6 (0..5 inclusive = 6 total tries); AUTO_DISABLE_AFTER_CONSECUTIVE_FAILURES = 50', () => {
    expect(body).toMatch(
      /const MAX_ATTEMPTS = 6; \/\/ attempt indices 0\.\.5 \(initial \+ 5 retries\); DLQ when the next index would be 6/,
    );
    expect(body).toMatch(/const AUTO_DISABLE_AFTER_CONSECUTIVE_FAILURES = 50;/);
  });

  it('BACKOFF_MS_BY_ATTEMPT: 5-entry exponential ladder (1min / 5min / 15min / 30min / 60min)', () => {
    expect(body).toMatch(
      /Backoff schedule per attempt-index AFTER a failure\. Index = the next\s*\n?\s*\*\s*attempt number \(1 = first retry … 5 = fifth\/last retry, scheduled\s*\n?\s*\*\s*60 min out\)\.[\s\S]*?\*\s*1: 1 min\s*\n?\s*\*\s*2: 5 min\s*\n?\s*\*\s*3: 15 min\s*\n?\s*\*\s*4: 30 min\s*\n?\s*\*\s*5: 60 min/,
    );
    expect(body).toMatch(
      /const BACKOFF_MS_BY_ATTEMPT: Record<number, number> = \{\s*\n?\s*1: 60_000,\s*\n?\s*2: 5 \* 60_000,\s*\n?\s*3: 15 \* 60_000,\s*\n?\s*4: 30 \* 60_000,\s*\n?\s*5: 60 \* 60_000,\s*\n?\s*\};/,
    );
  });

  it('Defaults: DEFAULT_TIMEOUT_MS=10_000 + DEFAULT_IDLE_SLEEP_MS=2_000 + DEFAULT_BATCH_SIZE=25', () => {
    expect(body).toMatch(/const DEFAULT_TIMEOUT_MS = 10_000;/);
    expect(body).toMatch(/const DEFAULT_IDLE_SLEEP_MS = 2_000;/);
    expect(body).toMatch(/const DEFAULT_BATCH_SIZE = 25;/);
  });

  it('Endpoint disabled/deleted between enqueue and claim → direct DLQ (no recoverable path)', () => {
    expect(body).toMatch(
      /\/\/ Fallback: endpoint not in subscriber set \(might have been deleted \/\s*\n?\s*\/\/ disabled between enqueue and claim\)\. Treat as DLQ — there's no\s*\n?\s*\/\/ recoverable path\./,
    );
    expect(body).toMatch(
      /if \(!endpoint \|\| !endpoint\.active \|\| endpoint\.disabledAt !== null\) \{\s*\n?\s*await this\.config\.repo\.recordDlq\(delivery\.id, \{\s*\n?\s*responseStatus: null,\s*\n?\s*lastError: 'endpoint disabled or deleted between enqueue and claim',/,
    );
  });

  it("POST headers: content-type + x-driftstack-signature + event-id + event-type + user-agent 'driftstack-webhooks/1.0'", () => {
    expect(body).toMatch(/'content-type': 'application\/json',/);
    expect(body).toMatch(/'x-driftstack-signature': sigHeader,/);
    expect(body).toMatch(/'x-driftstack-event-id': delivery\.eventId,/);
    expect(body).toMatch(/'x-driftstack-event-type': delivery\.eventType,/);
    expect(body).toMatch(/'user-agent': 'driftstack-webhooks\/1\.0',/);
  });

  it('V-093 durationMs framing: Date.now() reporting; excludes body serialization + signing; includes DNS+TCP+TLS+HTTP', () => {
    expect(body).toMatch(
      /\/\/ V-093: wall-clock duration of the actual fetch call\. Excludes\s*\n?\s*\/\/ body serialization \+ signing \(negligible\) but includes DNS \+\s*\n?\s*\/\/ TCP \+ TLS \+ HTTP exchange\./,
    );
    expect(body).toMatch(/const fetchStartMs = Date\.now\(\);/);
    expect(body).toMatch(/const durationMs = Date\.now\(\) - fetchStartMs;/);
  });

  it("handleOutcome: 2xx → recordDelivered; network failures use the bounded credential-safe sanitizer; AbortError.name → lastError='timeout'", () => {
    expect(body).toMatch(
      /if \(response && response\.ok\) \{\s*\n?\s*await this\.config\.repo\.recordDelivered\(delivery\.id, \{\s*\n?\s*responseStatus: response\.status,\s*\n?\s*at,\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(/'webhook delivered',/);
    expect(body).toMatch(
      /const lastError = networkError \? safeTransportError\(networkError\) : null;/,
    );
  });

  it('persisted transport failures are capped at 500 chars and pass through redactText before retry/DLQ logging', () => {
    expect(body).toMatch(/import \{ redactText \} from '\.\.\/lib\/redact-url\.js';/);
    expect(body).toMatch(/const TRANSPORT_ERROR_MAX_CHARS = 500;/);
    expect(body).toMatch(/if \(error\.name === 'AbortError'\) return 'timeout';/);
    expect(body).toMatch(
      /sliceWithoutSplittingSurrogate\(error\.message, TRANSPORT_ERROR_MAX_CHARS\)/,
    );
    expect(body).toMatch(
      /sliceWithoutSplittingSurrogate\(\s*\n?\s*redactText\(bounded\) \|\| 'transport failure',\s*\n?\s*TRANSPORT_ERROR_MAX_CHARS,\s*\n?\s*\)/,
    );
  });

  it('handleOutcome: nextAttemptIndex >= MAX_ATTEMPTS → recordDlq + auto-disable check (via maybeAutoDisable, re-reading the CURRENT consecutiveFailures)', () => {
    expect(body).toMatch(
      /if \(nextAttemptIndex >= MAX_ATTEMPTS\) \{\s*\n?\s*await this\.config\.repo\.recordDlq\(delivery\.id, \{\s*\n?\s*responseStatus,\s*\n?\s*lastError,\s*\n?\s*at,\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(/'webhook delivery → DLQ \(max attempts\)',/);
    expect(body).toMatch(
      /\/\/ Auto-disable check\s*\n?\s*await this\.maybeAutoDisable\(endpoint\.id, at\);/,
    );
  });

  it('maybeAutoDisable: re-reads the CURRENT consecutiveFailures (not the claim-time snapshot) so concurrent same-batch failures count once each, then disables idempotently past the threshold', () => {
    expect(body).toMatch(
      /private async maybeAutoDisable\(endpointId: string, at: Date\): Promise<void> \{/,
    );
    // Re-read the live endpoint row, skip if already disabled/deleted.
    expect(body).toMatch(
      /const current = await this\.config\.repo\.findEndpointById\(endpointId\);/,
    );
    expect(body).toMatch(/if \(!current \|\| current\.disabledAt !== null\) return;/);
    // Threshold check is against the re-read CURRENT count, not snapshot+1.
    expect(body).toMatch(
      /if \(current\.consecutiveFailures >= AUTO_DISABLE_AFTER_CONSECUTIVE_FAILURES\) \{\s*\n?\s*await this\.config\.repo\.disableEndpoint\(endpointId, at\);/,
    );
  });

  it('handleOutcome retry: jitter = floor(Math.random() * backoff * 0.15) + recordRetry with nextAttemptAt', () => {
    expect(body).toMatch(
      /const backoffMs = BACKOFF_MS_BY_ATTEMPT\[nextAttemptIndex\] \?\? 60_000;/,
    );
    expect(body).toMatch(/const jitterMs = Math\.floor\(Math\.random\(\) \* backoffMs \* 0\.15\);/);
    expect(body).toMatch(
      /const nextAttemptAt = new Date\(at\.getTime\(\) \+ backoffMs \+ jitterMs\);/,
    );
    expect(body).toMatch(/'webhook delivery scheduled for retry',/);
  });

  it('DeliveryOutcome: 3-kind union (delivered with status / retry with nextAttemptAt / dlq)', () => {
    expect(body).toMatch(
      /export type DeliveryOutcome =\s*\n?\s*\| \{ kind: 'delivered'; delivery: WebhookDeliveryRow; status: number \}\s*\n?\s*\| \{ kind: 'retry'; delivery: WebhookDeliveryRow; nextAttemptAt: Date \}\s*\n?\s*\| \{ kind: 'dlq'; delivery: WebhookDeliveryRow \};/,
    );
  });

  it('readExcerpt: SIZE-capped bounded read (MAX_RESPONSE_READ_BYTES) off the body stream + cancel — undici decompression-bomb / huge-body defense for the untrusted outbound path; EXCERPT_MAX_CHARS=4096; text() fallback only when no body stream; try/catch null fallback', () => {
    expect(body).toMatch(/const MAX_RESPONSE_READ_BYTES = 64 \* 1024;/);
    expect(body).toMatch(/const EXCERPT_MAX_CHARS = 4096;/);
    expect(body).toMatch(
      /async function readExcerpt\(response: Response\): Promise<string \| null> \{/,
    );
    // Bounded stream read + cancel — the load-bearing size cap.
    expect(body).toMatch(/while \(total < MAX_RESPONSE_READ_BYTES\) \{/);
    expect(body).toMatch(/const remaining = MAX_RESPONSE_READ_BYTES - total;/);
    expect(body).toMatch(/const bytesToKeep = Math\.min\(value\.length, remaining\);/);
    expect(body).toMatch(/chunks\.push\(value\.slice\(0, bytesToKeep\)\);/);
    expect(body).toMatch(/await reader\.cancel\(\)\.catch\(\(\) => undefined\);/);
    expect(body).toMatch(
      /sliceWithoutSplittingSurrogate\(\s*\n?\s*Buffer\.concat\(chunks, total\)\.toString\('utf8'\),\s*\n?\s*EXCERPT_MAX_CHARS,\s*\n?\s*\)/,
    );
    // text() fallback only for bodyless test-double responses; null on throw.
    expect(body).toMatch(
      /if \(!body\) \{\s*\n?\s*const text = await response\.text\(\);\s*\n?\s*return sliceWithoutSplittingSurrogate\(text, EXCERPT_MAX_CHARS\);/,
    );
    expect(body).toMatch(/\} catch \{\s*\n?\s*return null;\s*\n?\s*\}/);
  });

  it('2xx bodies are cancelled before the attempt timer is cleared', () => {
    expect(body).toMatch(
      /if \(!response\.ok\) \{\s*\n?\s*responseExcerpt = await readExcerpt\(response\);\s*\n?\s*\} else \{\s*\n?\s*await response\.body\?\.cancel\(\)\.catch\(\(\) => undefined\);/,
    );
  });

  it('run(): while-loop on this.running; empty claim → sleep idleSleepMs; deliver batch via Promise.all', () => {
    expect(body).toMatch(
      /async run\(\): Promise<void> \{\s*\n?\s*if \(this\.running\) return;\s*\n?\s*this\.running = true;/,
    );
    expect(body).toMatch(
      /if \(claimed\.length === 0\) \{\s*\n?\s*await sleep\(idleSleepMs\);\s*\n?\s*continue;\s*\n?\s*\}\s*\n?\s*await Promise\.all\(claimed\.map\(\(d\) => this\.deliver\(d\)\)\);/,
    );
  });

  it('tickOnce: single claim + deliver-batch sync (used in tests)', () => {
    expect(body).toMatch(
      /\/\*\* Tick once: claim \+ deliver one batch synchronously\. Used in tests\. \*\/\s*\n?\s*async tickOnce\(\): Promise<\{ claimed: number; outcomes: DeliveryOutcome\[\] \}>/,
    );
  });

  it('WebhookWorkerConfig: 4 test seams (fetch / sleep / now / deliveryTimeoutMs); idleSleepMs + batchSize tunables', () => {
    expect(body).toMatch(
      /\/\*\* Override the global fetch \(test seam\)\. \*\/\s*\n?\s*fetch\?: typeof fetch;/,
    );
    expect(body).toMatch(
      /\/\*\* Override sleep — useful for tight test loops\. \*\/\s*\n?\s*sleep\?: \(ms: number\) => Promise<void>;/,
    );
    expect(body).toMatch(
      /\/\*\* Override "now" — useful for deterministic backoff tests\. \*\/\s*\n?\s*now\?: \(\) => Date;/,
    );
    expect(body).toMatch(
      /\/\*\* Per-attempt delivery timeout \(ms\)\. Default 10s\. \*\/\s*\n?\s*deliveryTimeoutMs\?: number;/,
    );
  });

  it("SSRF hardening: the outbound delivery fetch sets redirect:'error' (no 3xx-follow to an internal target)", () => {
    expect(body).toMatch(/redirect: 'error',/);
  });

  it('CRITICAL default sender uses the literal-preflight + connect-time-DNS-pinned guarded fetch', () => {
    expect(body).toMatch(/import \{ ssrfGuardedFetch \} from '\.\.\/lib\/ssrf-guarded-fetch\.js';/);
    expect(body).toMatch(/const fetchImpl = this\.config\.fetch \?\? ssrfGuardedFetch;/);
  });

  it('defaultSleep: setTimeout-resolves-Promise helper', () => {
    expect(body).toMatch(
      /function defaultSleep\(ms: number\): Promise<void> \{\s*\n?\s*return new Promise\(\(resolve\) => setTimeout\(resolve, ms\)\);\s*\n?\s*\}/,
    );
  });

  it('imports: Logger + signWebhookPayload + WebhookDeliveryRow + WebhookEndpointRow + WebhooksRepo types', () => {
    expect(body).toMatch(/import type \{ Logger \} from '\.\.\/lib\/logger\.js';/);
    expect(body).toMatch(/import \{ signWebhookPayload \} from '\.\.\/lib\/webhook-signing\.js';/);
    expect(body).toMatch(
      /import type \{ WebhookDeliveryRow, WebhookEndpointRow, WebhooksRepo \} from '\.\/webhooks\.js';/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
