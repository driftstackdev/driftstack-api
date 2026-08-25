// W454.B — drift guard for packages/webhook-delivery/src/in-memory.ts.
// V-164 first real WebhookDeliveryService + DlqManager implementation.
// Drift here either drops the BACKOFF_MS_BY_ATTEMPT schedule (the
// 1/5/15/30/60 minute retry curve that production webhook-worker
// mirrors — divergence between in-memory + Postgres-backed impls
// breaks the seam contract) or breaks the v1 signature
// HMAC-SHA256(`${emittedAtSec}.${body}`) format (customers verifying
// payloads with the documented algorithm reject our deliveries).
//
//   • V-164 framing pinned + 'Distinct from V-144's mock' rationale +
//     'Storage is in-memory (Map-backed) — sufficient for unit tests,
//     GUI-client integration tests, and small self-hosted single-
//     process workloads' framing.
//   • Out-of-scope framing pinned: persistence, FOR UPDATE SKIP
//     LOCKED, cross-region replication.
//   • BACKOFF_MS_BY_ATTEMPT: 5-entry curve 1min/5min/15min/30min/60min.
//   • DEFAULT_TIMEOUT_MS=10_000; DEFAULT_MAX_ATTEMPTS=6.
//   • InMemoryWebhookDeliveryDeps: 3-field (fetch test seam + now
//     test seam + getEndpoint required).
//   • SharedDeliveryStore: 3-field (queue + dlq + idCounter); 'The
//     two services hold the same maps so that DLQ promotion in
//     delivery is visible to the DLQ admin surface, and replay() /
//     requeue() can round-trip between them.' framing pinned.
//   • createInMemoryWebhookDelivery returns {deliveries + dlq +
//     processTick}.
//   • nextId: `wdl_${padStart(8, '0')}`.
//   • Service.enqueue: 8-field DeliveryRecord (status:'pending' +
//     attempts:[] + nextAttemptAtMs:now + createdAtMs:now +
//     completedAtMs:null).
//   • Service.list: limit cap min(opts.limit ?? 50, 200); cursor
//     skip via findIndex; newest-first by createdAtMs with id
//     tiebreak.
//   • DlqManager.list: limit cap 200; sort desc by enteredDlqAtMs.
//   • replayShared: round-trip from active queue OR dlq; preserves
//     attempts for postmortem; throws on missing.
//   • DeliveryWorker.processTick framing pinned: 'claimed records
//     get leasedUntilMs = now + leaseMs. If the worker crashes mid-
//     delivery, the lease expires and the record is reclaimed by
//     the next tick.'
//   • deliver: missing-endpoint → transport_error + immediate dlq;
//     2xx → 'success'; non-2xx → 'http_error' with 'HTTP ${status}'
//     errorMessage; timeout via AbortError/TimeoutError; max-attempts
//     check.
//   • recordAttempt: success → status='delivered' + nextAttemptAtMs:
//     null; toDlq → DlqEntry move + delete from queue; retry →
//     status='pending' + nextAttemptAtMs = now + backoff.
//   • fetchWithTimeout: AbortController + 3 x-driftstack-* headers
//     (event-id + event-type + signature) + content-type
//     application/json.
//   • signPayload: canonical `t=<emittedAtSec>,v1=<hex>` header where
//     hex = HMAC-SHA256(secret, `${emittedAtSec}.${body}`); SDK-
//     verifiable single-header form.
//   • dlqReasonFromAttempts: `${count}× ${outcome}: ${errorMessage}`.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/webhook-delivery/src/in-memory.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W454.B packages/webhook-delivery/src/in-memory.ts content parity', () => {
  const body = read(LIB);

  it("V-164 framing pinned: 'V-164 — first real implementation of @driftstack/webhook-delivery.' + 'Distinct from V-144's mock (which short-circuits every enqueue to delivered): this implementation actually exercises the retry curve, the state machine (pending → in_flight → delivered | dlq), signature signing, and DLQ promotion. Storage is in-memory (Map-backed) — sufficient for unit tests, GUI-client integration tests, and small self-hosted single-process workloads.'", () => {
    expect(body).toMatch(
      /\/\/ V-164 — first real implementation of @driftstack\/webhook-delivery\./,
    );
    expect(body).toMatch(
      /\/\/ Distinct from V-144's mock \(which short-circuits every enqueue to\s*\/\/ `delivered`\): this implementation actually exercises the retry\s*\/\/ curve, the state machine \(pending → in_flight → delivered \| dlq\),\s*\/\/ signature signing, and DLQ promotion\. Storage is in-memory\s*\/\/ \(Map-backed\) — sufficient for unit tests, GUI-client integration\s*\/\/ tests, and small self-hosted single-process workloads\./,
    );
  });

  it("Out-of-scope framing pinned: 'Persistence across process restarts (Postgres-backed impl drops in behind the same interface — see V-144 V-log Next).' + 'SELECT...FOR UPDATE SKIP LOCKED concurrency (single-process).' + 'Cross-region replication.'", () => {
    expect(body).toMatch(
      /\/\/\s*- Persistence across process restarts \(Postgres-backed impl\s*\/\/\s*drops in behind the same interface — see V-144 V-log Next\)\.\s*\/\/\s*- SELECT\.\.\.FOR UPDATE SKIP LOCKED concurrency \(single-process\)\.\s*\/\/\s*- Cross-region replication\./,
    );
  });

  it("Backoff curve framing pinned: 'Backoff curve mirrors apps/server/src/services/webhook-worker.ts: 1min / 5min / 15min / 30min / 60min between attempts. Max 5 retries (6 attempts total including initial); 6th failure → DLQ.' + BACKOFF_MS_BY_ATTEMPT exact values", () => {
    expect(body).toMatch(
      /\/\/ Backoff curve mirrors apps\/server\/src\/services\/webhook-worker\.ts:\s*\/\/ 1min \/ 5min \/ 15min \/ 30min \/ 60min between attempts\. Max 5\s*\/\/ retries \(6 attempts total including initial\); 6th failure → DLQ\./,
    );
    expect(body).toMatch(
      /export const BACKOFF_MS_BY_ATTEMPT: Record<number, number> = \{\s*1: 60_000,\s*2: 5 \* 60_000,\s*3: 15 \* 60_000,\s*4: 30 \* 60_000,\s*5: 60 \* 60_000,\s*\};/,
    );
    expect(body).toMatch(/export const DEFAULT_TIMEOUT_MS = 10_000;/);
    expect(body).toMatch(/export const DEFAULT_MAX_ATTEMPTS = 6;/);
  });

  it("InMemoryWebhookDeliveryDeps: 4-field (fetch test seam, now a loud production SSRF-guard warning (audit fix WD-2) + now test seam 'defaults to () => Date.now()' + getEndpoint required + maxDlqEntries (audit fix WD-4)); 'The delivery service does not own endpoint storage' framing pinned", () => {
    expect(body).toContain('export interface InMemoryWebhookDeliveryDeps {');
    expect(body).toContain('fetch?: typeof fetch;');
    expect(body).toContain('PRODUCTION CALLERS MUST INJECT AN SSRF-GUARDED FETCH');
    expect(body).toContain('/** Test seam — defaults to () => Date.now(). */');
    expect(body).toContain('now?: () => number;');
    expect(body).toContain(
      '/** Lookup an endpoint by id. The delivery service does not own endpoint storage. */',
    );
    expect(body).toContain('getEndpoint: (endpointId: string) => DeliveryEndpoint | null;');
    expect(body).toContain('maxDlqEntries?: number;');
  });

  it("ProcessTickResult: 4-field (pulled + delivered + retried + dlqed); SharedDeliveryStore framing pinned 'The two services hold the same maps so that DLQ promotion in delivery is visible to the DLQ admin surface, and replay() / requeue() can round-trip between them.'", () => {
    expect(body).toMatch(
      /export interface ProcessTickResult \{[\s\S]*?pulled: number;[\s\S]*?delivered: number;[\s\S]*?retried: number;[\s\S]*?dlqed: number;/,
    );
    expect(body).toMatch(
      /\* Shared state between InMemoryWebhookDeliveryService \+ InMemoryDlqManager\.\s*\*\s*The two services hold the same maps so that DLQ promotion in delivery\s*\*\s*is visible to the DLQ admin surface, and replay\(\) \/ requeue\(\) can\s*\*\s*round-trip between them\./,
    );
  });

  it('createInMemoryWebhookDelivery: store init (queue/dlq/idCounter) + fetch/now resolution from deps + returns {deliveries + dlq + processTick: (opts) => worker.processTick(opts)}', () => {
    expect(body).toMatch(
      /export function createInMemoryWebhookDelivery\([\s\S]*?const store: SharedDeliveryStore = \{\s*queue: new Map\(\),\s*dlq: new Map\(\),\s*idCounter: \{ value: 0 \},\s*\};/,
    );
    expect(body).toMatch(/const fetchFn = deps\.fetch \?\? globalThis\.fetch\.bind\(globalThis\);/);
    expect(body).toMatch(/const now = deps\.now \?\? \(\(\) => Date\.now\(\)\);/);
    expect(body).toMatch(
      /return \{\s*deliveries,\s*dlq,\s*processTick: \(opts\) => worker\.processTick\(opts\),\s*\};/,
    );
  });

  it("nextId: `wdl_${padStart(8, '0')}` format; enqueue: 8-field DeliveryRecord (status:'pending', attempts:[], nextAttemptAtMs:now, createdAtMs:now, completedAtMs:null)", () => {
    expect(body).toMatch(
      /function nextId\(store: SharedDeliveryStore\): string \{\s*store\.idCounter\.value \+= 1;\s*return `wdl_\$\{store\.idCounter\.value\.toString\(\)\.padStart\(8, '0'\)\}`;\s*\}/,
    );
    expect(body).toMatch(
      /const record: DeliveryRecord = \{\s*id,\s*endpointId: opts\.endpoint\.id,\s*payload: opts\.payload,\s*status: 'pending',\s*attempts: \[\],\s*nextAttemptAtMs: now,\s*createdAtMs: now,\s*completedAtMs: null,\s*\};/,
    );
  });

  it('Service.list: limit cap min(opts.limit ?? 50, 200); cursor skip via findIndex + slice(idx+1); newest-first sort by createdAtMs with id-localeCompare tiebreak; nextCursor when entries.length > limit', () => {
    expect(body).toMatch(/const limit = Math\.min\(opts\.limit \?\? 50, 200\);/);
    expect(body).toMatch(
      /entries\.sort\(\(a, b\) => \{\s*if \(a\.record\.createdAtMs !== b\.record\.createdAtMs\) \{\s*return b\.record\.createdAtMs - a\.record\.createdAtMs;\s*\}\s*return a\.record\.id\.localeCompare\(b\.record\.id\);\s*\}\);/,
    );
    expect(body).toMatch(
      /if \(opts\.cursor !== undefined\) \{\s*const idx = entries\.findIndex\(\(e\) => e\.record\.id === opts\.cursor\);\s*if \(idx >= 0\) entries = entries\.slice\(idx \+ 1\);\s*\}/,
    );
  });

  it('InMemoryDlqManager.list: limit cap 200; sort desc by enteredDlqAtMs; cursor by deliveryId; requeue delegates to replayShared; discard: dlq.delete + Promise.resolve()', () => {
    expect(body).toMatch(/entries\.sort\(\(a, b\) => b\.enteredDlqAtMs - a\.enteredDlqAtMs\);/);
    expect(body).toMatch(
      /requeue\(opts: RequeueDlqOpts\): Promise<DeliveryRecord> \{\s*return Promise\.resolve\(replayShared\(this\.store, this\.getEndpoint, this\.now, opts\.deliveryId\)\);\s*\}/,
    );
    expect(body).toMatch(
      /discard\(deliveryId: string\): Promise<void> \{\s*this\.store\.dlq\.delete\(deliveryId\);\s*return Promise\.resolve\(\);\s*\}/,
    );
  });

  it("replayShared framing pinned: 'Re-arms an active queue record OR re-enqueues a DLQ entry, preserving the attempt history for postmortem.' + active-queue branch preserves attempts + nextAttemptAtMs:now() + completedAtMs:null; dlq branch reads endpoint or throws + re-inserts into queue + deletes from dlq", () => {
    expect(body).toMatch(
      /\* Shared replay path used by both WebhookDeliveryService\.replay and\s*\*\s*DlqManager\.requeue\. Re-arms an active queue record OR re-enqueues\s*\*\s*a DLQ entry, preserving the attempt history for postmortem\./,
    );
    expect(body).toMatch(
      /const replayed: DeliveryRecord = \{\s*\.\.\.entry\.record,\s*status: 'pending',\s*attempts: entry\.record\.attempts,\s*nextAttemptAtMs: now\(\),\s*completedAtMs: null,\s*\};/,
    );
    expect(body).toMatch(
      /throw new Error\(`replay: endpoint \$\{dlqEntry\.endpointId\} not found`\);/,
    );
    expect(body).toMatch(/throw new Error\(`replay: delivery \$\{deliveryId\} not found`\);/);
    expect(body).toMatch(/store\.dlq\.delete\(dlqEntry\.deliveryId\);/);
  });

  it("DeliveryWorker.processTick framing pinned: 'Lease pattern: claimed records get leasedUntilMs = now + leaseMs. If the worker crashes mid-delivery, the lease expires and the record is reclaimed by the next tick.' + batchSize default 25 + leaseDurationMs default 30_000", () => {
    expect(body).toMatch(
      /\* Lease pattern: claimed records get `leasedUntilMs = now \+ leaseMs`\.\s*\*\s*If the worker crashes mid-delivery, the lease expires and the\s*\*\s*record is reclaimed by the next tick\./,
    );
    expect(body).toMatch(
      /const batchSize = opts\.batchSize \?\? 25;\s*const leaseDurationMs = opts\.leaseDurationMs \?\? 30_000;/,
    );
    // V-173.R — the due set is now (due-pending OR stuck-in_flight-with-expired-lease)
    // so a crashed worker's in_flight row is reclaimed. Discrete pins.
    expect(body).toMatch(/const pendingDue =/);
    expect(body).toMatch(/e\.record\.status === 'pending' &&/);
    expect(body).toMatch(/e\.record\.nextAttemptAtMs !== null/);
    expect(body).toMatch(/e\.record\.nextAttemptAtMs <= now/);
    expect(body).toMatch(/const stuckInFlight =/);
    expect(body).toMatch(/e\.record\.status === 'in_flight' &&/);
    expect(body).toMatch(/e\.leasedUntilMs !== null/);
    expect(body).toMatch(/return pendingDue \|\| stuckInFlight;/);
    expect(body).toMatch(
      /entry\.leasedUntilMs = now \+ leaseDurationMs;\s*entry\.record = \{ \.\.\.entry\.record, status: 'in_flight' \};/,
    );
  });

  it("deliver: missing endpoint → transport_error attempt + immediate dlq (recordAttempt with toDlq=true); 2xx → outcome:'success'; non-2xx → outcome:'http_error' + errorMessage `HTTP ${status}`; timeout via AbortError/TimeoutError → outcome:'timeout'; max-attempts check `attemptNumber >= maxAttempts` → dlq", () => {
    expect(body).toMatch(
      /errorMessage: 'endpoint not found at delivery time',[\s\S]*?this\.recordAttempt\(entry, attempt, true\);\s*return 'dlqed';/,
    );
    expect(body).toMatch(/outcome: response\.ok \? 'success' : 'http_error',/);
    expect(body).toMatch(
      /errorMessage: response\.ok \? null : `HTTP \$\{response\.status\.toString\(\)\}`,/,
    );
    expect(body).toMatch(
      /const isTimeout = error\.name === 'AbortError' \|\| error\.name === 'TimeoutError';/,
    );
    expect(body).toMatch(
      /if \(attempt\.outcome === 'success'\) \{\s*this\.recordAttempt\(entry, attempt, false\);\s*return 'delivered';\s*\}\s*if \(attemptNumber >= maxAttempts\) \{\s*this\.recordAttempt\(entry, attempt, true\);\s*return 'dlqed';\s*\}/,
    );
  });

  it('transport diagnostics: mirrored credential classes, exact timeout, and a 500-character pre/post bound', () => {
    expect(body).toMatch(/const TRANSPORT_ERROR_MAX_CHARS = 500;/);
    expect(body).toMatch(/const TRANSPORT_TOKEN_RE =/);
    expect(body).toMatch(/const TRANSPORT_BEARER_RE =/);
    expect(body).toMatch(/const TRANSPORT_BASIC_RE =/);
    expect(body).toMatch(/const TRANSPORT_USERINFO_RE =/);
    expect(body).toMatch(/errorMessage: safeTransportError\(error\),/);
    expect(body).toMatch(
      /if \(error\.name === 'AbortError' \|\| error\.name === 'TimeoutError'\) return 'timeout';/,
    );
    expect(body).toMatch(/error\.message\.slice\(0, TRANSPORT_ERROR_MAX_CHARS\)/);
    expect(body).toMatch(/\.replace\(TRANSPORT_TOKEN_RE, '\$1\[redacted\]'\)/);
    expect(body).toMatch(/\.replace\(TRANSPORT_BEARER_RE, '\$1\[redacted\]'\)/);
    expect(body).toMatch(/\.replace\(TRANSPORT_BASIC_RE, '\$1\[redacted\]'\)/);
    expect(body).toMatch(/\.replace\(TRANSPORT_USERINFO_RE, '\$1\[redacted\]@'\)/);
    expect(body).not.toMatch(/errorMessage: e\?\.message/);
  });

  it("recordAttempt: success → status:'delivered' + nextAttemptAtMs:null + completedAtMs:now + leasedUntilMs:null; toDlq → DlqEntry with totalAttempts/attempts/enteredDlqAtMs/reason + dlq.set + queue.delete; retry → status:'pending' + nextAttemptAtMs = now + backoff (fallback 60min)", () => {
    expect(body).toMatch(
      /if \(attempt\.outcome === 'success'\) \{\s*entry\.record = \{\s*\.\.\.entry\.record,\s*status: 'delivered',\s*attempts: newAttempts,\s*nextAttemptAtMs: null,\s*completedAtMs: now,\s*\};\s*entry\.leasedUntilMs = null;/,
    );
    expect(body).toMatch(
      /const dlqEntry: DlqEntry = \{\s*deliveryId: entry\.record\.id,[\s\S]*?totalAttempts: newAttempts\.length,\s*attempts: newAttempts,\s*enteredDlqAtMs: now,\s*reason: dlqReasonFromAttempts\(newAttempts\),\s*\};[\s\S]*?this\.store\.dlq\.set\(entry\.record\.id, dlqEntry\);[\s\S]*?this\.store\.queue\.delete\(entry\.record\.id\);/,
    );
    expect(body).toMatch(
      /const backoffMs = BACKOFF_MS_BY_ATTEMPT\[attempt\.attempt\] \?\? 60 \* 60_000;/,
    );
    expect(body).toMatch(
      /entry\.record = \{\s*\.\.\.entry\.record,\s*status: nextStatus,\s*attempts: newAttempts,\s*nextAttemptAtMs: now \+ backoffMs,\s*completedAtMs: null,\s*\};/,
    );
  });

  it('fetchWithTimeout: AbortController with setTimeout for timeout; 3 x-driftstack-* headers (event-id + event-type + signature) + content-type application/json + body: payload.body; finally clearTimeout', () => {
    expect(body).toMatch(
      /const controller = new AbortController\(\);\s*const timer = setTimeout\(\(\) => controller\.abort\(\), timeoutMs\);/,
    );
    expect(body).toMatch(
      /headers: \{\s*'content-type': 'application\/json',\s*'x-driftstack-event-id': payload\.eventId,\s*'x-driftstack-event-type': payload\.eventType,\s*'x-driftstack-signature': signature,\s*\},/,
    );
    expect(body).toMatch(/finally \{\s*clearTimeout\(timer\);\s*\}/);
    // SSRF hardening — the outbound fetch must NOT follow redirects (a 3xx to
    // an internal target would bypass the create-time https-only check).
    expect(body).toMatch(/redirect: 'error',/);
  });

  it('response lifecycle: success body cancelled; failure body capped at 64 KiB decoded bytes and 200 characters, with timer clearing only after read/cancel', () => {
    expect(body).toMatch(/const RESPONSE_READ_MAX_BYTES = 64 \* 1024;/);
    expect(body).toMatch(/const RESPONSE_EXCERPT_MAX_CHARS = 200;/);
    expect(body).toMatch(
      /if \(response\.ok\) \{\s*await response\.body\?\.cancel\(\)\.catch\(\(\) => undefined\);/,
    );
    expect(body).toMatch(/excerpt: await readResponseExcerpt\(response\),/);
    expect(body).toMatch(/const reader = response\.body\.getReader\(\);/);
    expect(body).toMatch(/const bytesToKeep = Math\.min\(value\.byteLength, remaining\);/);
    expect(body).toMatch(/parts\.join\(''\)\.slice\(0, RESPONSE_EXCERPT_MAX_CHARS\)/);
    expect(body).toMatch(/await reader\.cancel\(\)\.catch\(\(\) => undefined\);/);
    expect(body).not.toMatch(/await response\.text\(\)/);
  });

  it('signPayload returns the canonical t=<sentAtSec>,v1=<hex> header (HMAC-SHA256 over `<sentAtSec>.<body>`), re-stamped per send (#7), matching the SDK verifier', () => {
    expect(body).toMatch(/Stripe-style `t=<sentAtSec>,v1=<hex>`/);
    // #7 — sentAtSec defaults to emittedAtSec but the worker passes the current
    // send time so each retry is re-stamped + re-signed (SDK tolerance window).
    expect(body).toMatch(
      /export function signPayload\(\s*secret: string,\s*payload: DeliveryPayload,\s*sentAtSec: number = payload\.emittedAtSec,\s*\): string \{/,
    );
    expect(body).toMatch(/const data = `\$\{sentAtSec\.toString\(\)\}\.\$\{payload\.body\}`;/);
    expect(body).toMatch(
      /const hex = createHmac\('sha256', secret\)\.update\(data, 'utf-8'\)\.digest\('hex'\);/,
    );
    expect(body).toMatch(/return `t=\$\{sentAtSec\.toString\(\)\},v1=\$\{hex\}`;/);
    // The worker stamps with the CURRENT send time, not the stored emit time.
    expect(body).toMatch(/const sentAtSec = Math\.floor\(this\.now\(\) \/ 1000\);/);
    expect(body).toMatch(
      /const signature = signPayload\(endpoint\.signingSecret, payload, sentAtSec\);/,
    );
  });

  it("dlqReasonFromAttempts: `${count}× ${outcome}: ${errorMessage ?? '(no message)'}` format", () => {
    expect(body).toMatch(
      /function dlqReasonFromAttempts\(attempts: readonly DeliveryAttempt\[\]\): string \{\s*const last = attempts\[attempts\.length - 1\]!;\s*return `\$\{attempts\.length\.toString\(\)\}× \$\{last\.outcome\}: \$\{last\.errorMessage \?\? '\(no message\)'\}`;\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
