// W956 — webhook-worker delivery-loop cross-source invariant. Two-
// hundred-eighty-second in the drift-guard series. Pins the webhook
// delivery worker:
//
//   Service intro — 'Webhook delivery worker. Long-running loop'.
//
//   5-step loop:
//     1. Claim a batch of pending deliveries whose nextAttemptAt
//        is past.
//     2. For each: build the signed POST, send via fetch, observe
//        response.
//     3. On 2xx → recordDelivered (resets
//        endpoint.consecutiveFailures).
//     4. On non-2xx / network / timeout → recordRetry (if attempts
//        < MAX) or recordDlq (if attempts == MAX). Only recordDlq bumps
//        endpoint.consecutiveFailures.
//     5. If endpoint.consecutiveFailures crosses the auto-disable
//        threshold, mark the endpoint disabled.
//
//   Process-local + SKIP-LOCKED framing — 'The loop is process-
//   local; in production we'd run one worker per app instance and
//   rely on SELECT...FOR UPDATE SKIP LOCKED to coordinate (already
//   in DrizzleWebhooksRepo.claim)'.
//
//   MAX_ATTEMPTS = 6 ('attempt indices 0..5 (initial + 5 retries);
//   DLQ when the next index would be 6').
//
//   BACKOFF_MS_BY_ATTEMPT 5-step schedule (mirrors V-173 durable-
//   webhook-delivery W918 schedule):
//     - 1 → 1m   (60_000 ms).
//     - 2 → 5m   (300_000 ms).
//     - 3 → 15m  (900_000 ms).
//     - 4 → 30m  (1_800_000 ms).
//     - 5 → 60m  (3_600_000 ms).
//
//   AUTO_DISABLE_AFTER_CONSECUTIVE_FAILURES = 50.
//
//   Default constants:
//     - DEFAULT_TIMEOUT_MS = 10_000 (10s per-attempt).
//     - DEFAULT_IDLE_SLEEP_MS = 2_000 (2s empty-claim sleep).
//     - DEFAULT_BATCH_SIZE = 25.
//
//   WebhookWorkerConfig (7-field DI): repo + logger + fetch (test
//     seam) + sleep (test seam) + now (test seam) +
//     deliveryTimeoutMs (10s) + idleSleepMs (2s) + batchSize (25).
//
// stays in lockstep across apps/server/src/services/webhook-worker.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W956 webhook-worker delivery-loop cross-source invariant', () => {
  // ─── Service intro + long-running loop framing ───────────────

  it("CRITICAL apps/server/src/services/webhook-worker.ts header pins surface — 'Webhook delivery worker. Long-running loop'. The long-running-loop posture is the central design.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/webhook-worker.ts'));
    expect(p).toMatch(/Webhook delivery worker\./);
    expect(p).toMatch(/Long-running loop:/);
  });

  // ─── 5-step loop framing ─────────────────────────────────────

  it("CRITICAL 5-step loop framing — 1. Claim batch where nextAttemptAt past. 2. For each: build signed POST + fetch + observe. 3. 2xx → recordDelivered (resets consecutiveFailures). 4. Non-2xx/network/timeout → recordRetry (attempts<MAX) or recordDlq (attempts==MAX); only recordDlq bumps consecutiveFailures. 5. Cross auto-disable threshold → mark endpoint disabled. The 5-step delivery state machine is the worker's contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/webhook-worker.ts'));
    expect(p).toMatch(/1\. Claim a batch of pending deliveries whose nextAttemptAt is past/);
    expect(p).toMatch(/2\. For each: build the signed POST, send via fetch, observe response/);
    expect(p).toMatch(/3\. On 2xx → recordDelivered \(resets endpoint\.consecutiveFailures\)/);
    expect(p).toMatch(
      /4\. On non-2xx \/ network \/ timeout → recordRetry \(if attempts < MAX\) or/,
    );
    // V-1274c — the header used to say BOTH writers bump the counter. Only recordDlq does: a
    // retry is an attempt within one delivery, and counting it tombstoned endpoints roughly
    // 6x early. The pin follows the corrected framing.
    expect(p).toMatch(/recordDlq \(if attempts == MAX\)\. Only recordDlq bumps/);
    expect(p).toMatch(/a retry is an attempt WITHIN one delivery\./);
    expect(p).toMatch(/5\. If endpoint\.consecutiveFailures crosses the auto-disable threshold,/);
    expect(p).toMatch(/mark the endpoint disabled\./);
  });

  // ─── Process-local + SKIP-LOCKED framing ─────────────────────

  it("CRITICAL process-local + SKIP-LOCKED framing — 'The loop is process-local; in production we'd run one worker per app instance and rely on SELECT...FOR UPDATE SKIP LOCKED to coordinate (already in DrizzleWebhooksRepo.claim)'. The 1-worker-per-instance + SKIP-LOCKED matches W918 durable-webhook-delivery V-173 coordination.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/webhook-worker.ts'));
    expect(p).toMatch(/The loop is process-local; in production we'd run one worker per app/);
    expect(p).toMatch(/instance and rely on SELECT\.\.\.FOR UPDATE SKIP LOCKED to coordinate/);
    expect(p).toMatch(/\(already in DrizzleWebhooksRepo\.claim\)\./);
  });

  // ─── MAX_ATTEMPTS = 6 + framing ──────────────────────────────

  it("CRITICAL MAX_ATTEMPTS = 6 — 'attempt indices 0..5 (initial + 5 retries); DLQ when the next index would be 6'. The 6-total-tries framing distinguishes attempt count from total tries; drift would change customer-facing retry behavior.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/webhook-worker.ts'));
    expect(p).toMatch(
      /const MAX_ATTEMPTS = 6;\s*\/\/ attempt indices 0\.\.5 \(initial \+ 5 retries\); DLQ when the next index would be 6/,
    );
  });

  // ─── BACKOFF_MS_BY_ATTEMPT 5-step schedule ───────────────────

  it('CRITICAL BACKOFF_MS_BY_ATTEMPT 5-step schedule — 1: 1 min + 2: 5 min + 3: 15 min + 4: 30 min + 5: 60 min. Mirrors W918 durable-webhook-delivery V-173 BACKOFF_MS_BY_ATTEMPT — cross-source contract that lets InMemory + Durable behave identically under retry.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/webhook-worker.ts'));
    expect(p).toMatch(/Backoff schedule per attempt-index AFTER a failure\. Index = the next/);
    expect(p).toMatch(/attempt number \(1 = first retry … 5 = fifth\/last retry, scheduled/);
    expect(p).toMatch(/1: 1 min/);
    expect(p).toMatch(/2: 5 min/);
    expect(p).toMatch(/3: 15 min/);
    expect(p).toMatch(/4: 30 min/);
    expect(p).toMatch(/5: 60 min/);
  });

  it('CRITICAL BACKOFF_MS_BY_ATTEMPT runtime values — 1:60_000 + 2:5*60_000 + 3:15*60_000 + 4:30*60_000 + 5:60*60_000. Mechanically pinned to match W918 BACKOFF_MS_BY_ATTEMPT V-173 schedule.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/webhook-worker.ts'));
    expect(p).toMatch(/const BACKOFF_MS_BY_ATTEMPT: Record<number, number> = \{/);
    expect(p).toMatch(/1: 60_000,/);
    expect(p).toMatch(/2: 5 \* 60_000,/);
    expect(p).toMatch(/3: 15 \* 60_000,/);
    expect(p).toMatch(/4: 30 \* 60_000,/);
    expect(p).toMatch(/5: 60 \* 60_000,/);
  });

  // ─── AUTO_DISABLE threshold = 50 ─────────────────────────────

  it('CRITICAL AUTO_DISABLE_AFTER_CONSECUTIVE_FAILURES = 50. The 50-failure threshold matches W949 webhooks-service consecutiveFailures column; drift would change auto-disable timing.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/webhook-worker.ts'));
    expect(p).toMatch(/const AUTO_DISABLE_AFTER_CONSECUTIVE_FAILURES = 50;/);
  });

  // ─── Default constants ───────────────────────────────────────

  it('CRITICAL DEFAULT_TIMEOUT_MS = 10_000 (10s per-attempt). Mirrors W918 durable-webhook-delivery DEFAULT_TIMEOUT_MS — cross-source 10s timeout contract.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/webhook-worker.ts'));
    expect(p).toMatch(/const DEFAULT_TIMEOUT_MS = 10_000;/);
  });

  it('CRITICAL DEFAULT_IDLE_SLEEP_MS = 2_000 (2s empty-claim sleep). The 2s idle prevents the worker from busy-looping when there are no deliveries to claim.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/webhook-worker.ts'));
    expect(p).toMatch(/const DEFAULT_IDLE_SLEEP_MS = 2_000;/);
  });

  it('CRITICAL DEFAULT_BATCH_SIZE = 25 (deliveries per claim). The 25-batch matches W915 scheduled-jobs default + bounds per-tick memory.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/webhook-worker.ts'));
    expect(p).toMatch(/const DEFAULT_BATCH_SIZE = 25;/);
  });

  // ─── WebhookWorkerConfig DI shape ────────────────────────────

  it('CRITICAL WebhookWorkerConfig has 7+ fields — repo (required) + logger (required) + fetch? (test seam) + sleep? (test seam) + now? (test seam) + deliveryTimeoutMs? (default 10s) + idleSleepMs? (default 2s) + batchSize? (default 25). The 7+-field DI surface lets tests substitute fetch + sleep + now without touching production code.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/webhook-worker.ts'));
    expect(p).toMatch(/export interface WebhookWorkerConfig \{/);
    expect(p).toMatch(/repo: WebhooksRepo;/);
    expect(p).toMatch(/logger: Logger;/);
    expect(p).toMatch(/Override the global fetch \(test seam\)\./);
    expect(p).toMatch(/fetch\?: typeof fetch;/);
    expect(p).toMatch(/Override sleep — useful for tight test loops\./);
    expect(p).toMatch(/sleep\?: \(ms: number\) => Promise<void>;/);
    expect(p).toMatch(/Override "now" — useful for deterministic backoff tests\./);
    expect(p).toMatch(/now\?: \(\) => Date;/);
    expect(p).toMatch(/Per-attempt delivery timeout \(ms\)\. Default 10s\./);
    expect(p).toMatch(/deliveryTimeoutMs\?: number;/);
    expect(p).toMatch(/Empty-claim sleep \(ms\)\. Default 2s\./);
    expect(p).toMatch(/idleSleepMs\?: number;/);
    expect(p).toMatch(/Batch size per claim\. Default 25\./);
    expect(p).toMatch(/batchSize\?: number;/);
  });

  // ─── signWebhookPayload import (V-185 / V-359 signature) ─────

  it('CRITICAL imports signWebhookPayload from lib/webhook-signing — keeps HMAC-SHA256 signing primitive in lib/ (matches W949 webhooks-service / W918 V-173 durable-webhook-delivery lib-vs-service split).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/webhook-worker.ts'));
    expect(p).toMatch(/import \{ signWebhookPayload \} from '\.\.\/lib\/webhook-signing\.js';/);
  });

  // ─── W918 cross-source contract: 5-step backoff mirrors V-173 ─

  it('CRITICAL cross-source: webhook-worker BACKOFF_MS_BY_ATTEMPT matches W918 V-173 durable-webhook-delivery values exactly (1m/5m/15m/30m/60m). The dual-impl-mirror contract is what makes InMemory + Durable behave identically under retry.', () => {
    // This is a runtime cross-source check between both worker files.
    const workerSrc = read(resolve(REPO_ROOT, 'apps/server/src/services/webhook-worker.ts'));
    const durableSrc = read(
      resolve(REPO_ROOT, 'apps/server/src/services/durable-webhook-delivery.ts'),
    );
    for (const expected of [
      '1: 60_000',
      '2: 5 \\* 60_000',
      '3: 15 \\* 60_000',
      '4: 30 \\* 60_000',
      '5: 60 \\* 60_000',
    ]) {
      expect(workerSrc).toMatch(new RegExp(expected));
      expect(durableSrc).toMatch(new RegExp(expected));
    }
  });

  // ─── WebhooksRepo + WebhookDeliveryRow + WebhookEndpointRow imports ─

  it('CRITICAL imports type WebhookDeliveryRow + WebhookEndpointRow + WebhooksRepo from webhooks service — the 3-type import bridges the worker to W949 webhooks-service row shapes + repo interface.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/webhook-worker.ts'));
    expect(p).toMatch(
      /import type \{ WebhookDeliveryRow, WebhookEndpointRow, WebhooksRepo \} from '\.\/webhooks\.js';/,
    );
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/webhook-worker-cross-source-invariant.test.ts'),
      ),
    ).toBe(true);
  });
});
