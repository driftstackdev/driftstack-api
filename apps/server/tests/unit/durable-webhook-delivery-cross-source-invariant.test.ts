// W918 — V-173 DurableWebhookDeliveryService cross-source invariant.
// Two-hundred-forty-fourth in the drift-guard series. Pins the
// Postgres-backed webhook-delivery system:
//
//   V-173 anchor — 'DurableWebhookDeliveryService: Postgres-backed
//   implementation of @driftstack/webhook-delivery's
//   WebhookDeliveryService + DlqManager interfaces. Companion to
//   V-164 InMemoryWebhookDelivery'.
//
//   Coexistence with webhooks.ts (existing inline impl) — both
//   write to same webhook_endpoints + webhook_deliveries tables;
//   each service owns deliveries it created. Migration to fully
//   replace webhooks.ts is separate future V-NNN.
//
//   Worker uses SELECT...FOR UPDATE SKIP LOCKED for cross-process
//   coordination (same primitive webhook-worker.ts uses).
//
//   DeliveryRecord.attempts (full history) maps to V-173-introduced
//   webhook_delivery_attempts table (one row per attempt). Existing
//   webhook_deliveries.attempts integer column stores the count.
//
//   BACKOFF_MS_BY_ATTEMPT (5-attempt schedule):
//     1 → 60_000        (1m)
//     2 → 5 * 60_000    (5m)
//     3 → 15 * 60_000   (15m)
//     4 → 30 * 60_000   (30m)
//     5 → 60 * 60_000   (1h)
//   Mirrors V-164 InMemoryWebhookDelivery; total ≈ 1h51m before DLQ.
//
//   DEFAULT_TIMEOUT_MS = 10_000  (10s per attempt).
//   DEFAULT_MAX_ATTEMPTS = 6  (initial + 5 retries).
//
//   ProcessTickResult: { pulled + delivered + retried + dlqed }
//   (4-counter ops-metric shape).
//
//   WebhookEventType allowed (5-value enum, per schema.ts):
//     session.completed | session.failed | quota.warning_80pct |
//     quota.exceeded | api_key.revoked.
//
//   signPayload — v1 signature is HMAC-SHA256 over
//   '<emittedAtSec>.<body>', hex-encoded. Stripe-style.
//
// stays in lockstep across
// apps/server/src/services/durable-webhook-delivery.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BACKOFF_MS_BY_ATTEMPT,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_ATTEMPTS,
  signPayload,
} from '../../src/services/durable-webhook-delivery.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W918 V-173 durable-webhook-delivery cross-source invariant', () => {
  // ─── V-173 anchor + V-164 companion framing ──────────────────

  it("CRITICAL apps/server/src/services/durable-webhook-delivery.ts header pins V-173 anchor — 'V-173 — DurableWebhookDeliveryService: Postgres-backed implementation of @driftstack/webhook-delivery's WebhookDeliveryService + DlqManager interfaces. Companion to V-164 InMemoryWebhookDelivery'. The V-173 + V-164 anchors are the policy provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/durable-webhook-delivery.ts'));
    expect(p).toMatch(/V-173 — DurableWebhookDeliveryService: Postgres-backed implementation/);
    expect(p).toMatch(/of @driftstack\/webhook-delivery's WebhookDeliveryService \+ DlqManager/);
    expect(p).toMatch(/interfaces\. Companion to V-164 InMemoryWebhookDelivery/);
  });

  // ─── COEXISTENCE NOTE framing ────────────────────────────────

  it("CRITICAL header pins COEXISTENCE NOTE — 'apps/server/src/services/webhooks.ts is the existing inline implementation (production today). V-173 lands the package-interface-conformant Postgres-backed implementation as the FORWARD path'. The coexistence framing prevents confusion between the 2 implementations.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/durable-webhook-delivery.ts'));
    expect(p).toMatch(
      /COEXISTENCE NOTE: apps\/server\/src\/services\/webhooks\.ts is the existing/,
    );
    expect(p).toMatch(/inline implementation \(production today\)\. V-173 lands the/);
    expect(p).toMatch(/package-interface-conformant Postgres-backed implementation as the/);
    expect(p).toMatch(/FORWARD path/);
  });

  it("CRITICAL coexistence detail — 'each service owns deliveries it created'. The own-what-you-create rule is what makes the 2-impl coexistence safe.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/durable-webhook-delivery.ts'));
    expect(p).toMatch(
      /the existing service\s*\n\/\/ owns deliveries it created, the new service owns deliveries it/,
    );
    expect(p).toMatch(/created/);
  });

  // ─── SKIP LOCKED worker coordination ─────────────────────────

  it("CRITICAL worker uses 'SELECT...FOR UPDATE SKIP LOCKED for cross-process coordination'. The SKIP LOCKED is what makes the worker horizontally-scalable — same primitive webhook-worker.ts uses.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/durable-webhook-delivery.ts'));
    expect(p).toMatch(/SELECT\.\.\.FOR UPDATE SKIP LOCKED for cross-process/);
    expect(p).toMatch(/coordination/);
  });

  // ─── DeliveryRecord.attempts → webhook_delivery_attempts table ─

  it("CRITICAL header pins attempts-table framing — 'DeliveryRecord.attempts array (full history) maps to the V-173-introduced webhook_delivery_attempts table (one row per attempt). The existing webhook_deliveries.attempts integer column stores the count'. The 2-column-split keeps attempt-history relational + count cheap.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/durable-webhook-delivery.ts'));
    expect(p).toMatch(/The package's DeliveryRecord\.attempts array \(full history\) maps to/);
    expect(p).toMatch(/the V-173-introduced webhook_delivery_attempts table \(one row per/);
    expect(p).toMatch(/attempt\)\. The existing webhook_deliveries\.attempts integer column/);
    expect(p).toMatch(/stores the count/);
  });

  // ─── BACKOFF_MS_BY_ATTEMPT 5-step schedule ───────────────────

  it("CRITICAL BACKOFF_MS_BY_ATTEMPT framing — 'Backoff schedule mirroring V-164 InMemoryWebhookDelivery'. The 5-step schedule is the cross-package contract that lets InMemory + Durable behave identically under retry.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/durable-webhook-delivery.ts'));
    expect(p).toMatch(/Backoff schedule mirroring V-164 InMemoryWebhookDelivery/);
  });

  it('CRITICAL BACKOFF_MS_BY_ATTEMPT is 1m / 5m / 15m / 30m / 1h (5-attempt schedule). Mechanically verified via runtime constants — drift would change customer-facing retry timing.', () => {
    expect(BACKOFF_MS_BY_ATTEMPT[1]).toBe(60_000);
    expect(BACKOFF_MS_BY_ATTEMPT[2]).toBe(5 * 60_000);
    expect(BACKOFF_MS_BY_ATTEMPT[3]).toBe(15 * 60_000);
    expect(BACKOFF_MS_BY_ATTEMPT[4]).toBe(30 * 60_000);
    expect(BACKOFF_MS_BY_ATTEMPT[5]).toBe(60 * 60_000);
  });

  it('CRITICAL BACKOFF_MS_BY_ATTEMPT total ≤ 1h51m (= 6660_000 ms). Customer-facing retention window for DLQ-bound deliveries.', () => {
    const total = Object.values(BACKOFF_MS_BY_ATTEMPT).reduce((a, b) => a + b, 0);
    expect(total).toBe(60_000 + 300_000 + 900_000 + 1_800_000 + 3_600_000);
    expect(total).toBe(6_660_000);
  });

  // ─── DEFAULT_TIMEOUT_MS = 10s + DEFAULT_MAX_ATTEMPTS = 6 ─────

  it('CRITICAL DEFAULT_TIMEOUT_MS = 10_000 (10s per attempt). The 10s cap bounds per-attempt latency before AbortController fires.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/durable-webhook-delivery.ts'));
    expect(p).toMatch(/export const DEFAULT_TIMEOUT_MS = 10_000;/);
    expect(DEFAULT_TIMEOUT_MS).toBe(10_000);
  });

  it('CRITICAL DEFAULT_MAX_ATTEMPTS = 6 (initial + 5 retries; one backoff entry per retry). The 6-attempt cap bounds total retry runtime; the 5-entry backoff table is one slot per retry, so length = cap - 1.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/durable-webhook-delivery.ts'));
    expect(p).toMatch(/export const DEFAULT_MAX_ATTEMPTS = 6;/);
    expect(DEFAULT_MAX_ATTEMPTS).toBe(6);
    expect(Object.keys(BACKOFF_MS_BY_ATTEMPT)).toHaveLength(DEFAULT_MAX_ATTEMPTS - 1);
  });

  // ─── ProcessTickResult 4-counter shape ───────────────────────

  it('CRITICAL ProcessTickResult has 4 counters — pulled + delivered + retried + dlqed. The 4-counter ops-metric shape is what dashboards aggregate for webhook throughput.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/durable-webhook-delivery.ts'));
    expect(p).toMatch(/export interface ProcessTickResult \{/);
    expect(p).toMatch(/pulled: number;/);
    expect(p).toMatch(/delivered: number;/);
    expect(p).toMatch(/retried: number;/);
    expect(p).toMatch(/dlqed: number;/);
  });

  // ─── WebhookEventType 5-value enum ───────────────────────────

  it("CRITICAL WebhookEventType has 5 values per schema.ts — 'session.completed' | 'session.failed' | 'quota.warning_80pct' | 'quota.exceeded' | 'api_key.revoked'. The 5-event enum is what schema's webhook_event_type pgEnum mirrors.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/durable-webhook-delivery.ts'));
    expect(p).toMatch(/Allowed event_type values for the `webhook_event_type` enum/);
    expect(p).toMatch(/\| 'session\.completed'/);
    expect(p).toMatch(/\| 'session\.failed'/);
    expect(p).toMatch(/\| 'quota\.warning_80pct'/);
    expect(p).toMatch(/\| 'quota\.exceeded'/);
    expect(p).toMatch(/\| 'api_key\.revoked';/);
  });

  // ─── signPayload v1 HMAC-SHA256 hex ──────────────────────────

  it("CRITICAL signPayload framing — 'v1 signature: HMAC-SHA256 over <emittedAtSec>.<body>, hex-encoded'. The Stripe-style timestamp.body signing is what defends against replay-without-timestamp-rotation.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/durable-webhook-delivery.ts'));
    expect(p).toMatch(/v1 signature: HMAC-SHA256 over `<emittedAtSec>\.<body>`, hex-encoded/);
  });

  it('CRITICAL signPayload mechanically computes HMAC-SHA256 over emittedAtSec.body. The runtime parity check prevents drift between the JSDoc framing and the actual implementation.', () => {
    const secret = 'whsec_test_secret';
    const body = '{"event":"session.completed","id":"sess_abc"}';
    const emittedAtSec = 1747370000;
    const expected = createHmac('sha256', secret)
      .update(`${emittedAtSec}.${body}`, 'utf-8')
      .digest('hex');
    expect(signPayload(secret, body, emittedAtSec)).toBe(expected);
    expect(signPayload(secret, body, emittedAtSec)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('CRITICAL signPayload produces different outputs for different timestamps (replay-defense). Drift to a body-only signature would let attackers replay old payloads with a stolen signature.', () => {
    const sig1 = signPayload('s', 'body', 1000);
    const sig2 = signPayload('s', 'body', 2000);
    expect(sig1).not.toBe(sig2);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/durable-webhook-delivery-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
