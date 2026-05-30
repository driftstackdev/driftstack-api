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
//   Signing delegated to canonical signWebhookPayload — single
//   x-driftstack-signature header 't=<sec>,v1=<hex>[,v1=<prevHex>]'
//   (HMAC-SHA256 over '<sec>.<body>'). SDK-verifiable; no bare hex.
//
// stays in lockstep across
// apps/server/src/services/durable-webhook-delivery.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BACKOFF_MS_BY_ATTEMPT,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_ATTEMPTS,
} from '../../src/services/durable-webhook-delivery.js';
import { signWebhookPayload } from '../../src/lib/webhook-signing.js';

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

  // ─── WebhookEventType imported from the canonical (not re-declared) ──

  it('CRITICAL durable-webhook-delivery.ts imports WebhookEventType from @driftstack/api-types (the canonical 9-value roster) instead of re-declaring a local stale union. The event_type cast then tracks the canonical automatically — a local duplicate previously drifted to 5 values (missing test.ping / egress / the V-666 crypto pair).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/durable-webhook-delivery.ts'));
    expect(p).toMatch(/import type \{ WebhookEventType \} from '@driftstack\/api-types';/);
    expect(p).toMatch(/eventType: opts\.payload\.eventType as WebhookEventType/);
    // No drift-prone local re-declaration of the union.
    expect(p).not.toMatch(/type WebhookEventType =/);
  });

  // ─── canonical signWebhookPayload delegation ─────────────────

  it('CRITICAL the durable sender delegates signing to the canonical signWebhookPayload (single t=,v1= header) — no local bare-hex signPayload remains. This is what keeps the emitted header SDK-verifiable on production cutover (finding #12).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/durable-webhook-delivery.ts'));
    expect(p).toMatch(/import \{ signWebhookPayload \} from '\.\.\/lib\/webhook-signing\.js';/);
    expect(p).toMatch(/const sigHeader = signWebhookPayload\(\{/);
    expect(p).toMatch(/'x-driftstack-signature': sigHeader,/);
    expect(p).not.toMatch(/export function signPayload\(/);
  });

  it('CRITICAL signWebhookPayload emits Stripe-style t=,v1= over <timestampSec>.<body> (replay-defense via timestamp). Different timestamps → different signatures.', () => {
    const header = signWebhookPayload({ body: 'b', secret: 's', timestampSec: 1747370000 });
    expect(header).toMatch(/^t=1747370000,v1=[0-9a-f]{64}$/);
    const a = signWebhookPayload({ body: 'body', secret: 's', timestampSec: 1000 });
    const b = signWebhookPayload({ body: 'body', secret: 's', timestampSec: 2000 });
    expect(a).not.toBe(b);
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
