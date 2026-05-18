// Arc 7 obs.14 — drift guard for the outbound webhook delivery
// counters. The dispatcher in services/durable-webhook-delivery.ts
// emits two counters; this test pins the metric-name strings
// against the METRIC_NAMES catalog so a rename on either side
// breaks CI.
//
// Functional verification of emission would require Drizzle + a
// running database (the worker writes attempt rows + updates the
// delivery status). That coverage lives at integration-test layer
// once the dispatcher gets plumbed into bootstrap; the drift guard
// is the layer that lives in the cheap unit-test tier.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { METRIC_NAMES } from '../../src/services/metrics-registry.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const WORKER_SRC = resolve(REPO_ROOT, 'apps/server/src/services/durable-webhook-delivery.ts');

describe('Arc 7 obs.14 — webhook delivery metric name drift guard', () => {
  const src = readFileSync(WORKER_SRC, 'utf8');

  it('catalog includes the webhook-delivery counters', () => {
    expect(METRIC_NAMES.webhookDeliveryAttemptTotal).toBe(
      'driftstack_webhook_delivery_attempt_total',
    );
    expect(METRIC_NAMES.webhookDeliveryTerminalTotal).toBe(
      'driftstack_webhook_delivery_terminal_total',
    );
  });

  it('worker emits via METRIC_NAMES (NOT inline string literals — drift-proof)', () => {
    // The worker MUST reference METRIC_NAMES for both counters. If
    // a future refactor inlines the strings, the catalog can drift
    // silently — fail loudly here instead.
    expect(src).toMatch(/METRIC_NAMES\.webhookDeliveryAttemptTotal/);
    expect(src).toMatch(/METRIC_NAMES\.webhookDeliveryTerminalTotal/);
    // No raw string literals should remain. The strings appear in
    // METRIC_NAMES itself (in metrics-registry.ts) but NOT in the
    // worker source.
    expect(src.includes(`'driftstack_webhook_delivery_attempt_total'`)).toBe(false);
    expect(src.includes(`'driftstack_webhook_delivery_terminal_total'`)).toBe(false);
  });

  it('worker emits the attempt counter with the outcome label', () => {
    expect(src).toMatch(
      /metrics\?\.inc\(METRIC_NAMES\.webhookDeliveryAttemptTotal,\s*\{\s*outcome:/,
    );
  });

  it('worker emits the terminal counter with the terminal_state label', () => {
    expect(src).toMatch(/terminal_state:\s*'delivered'/);
    expect(src).toMatch(/terminal_state:\s*'dlq'/);
  });

  it('worker wraps every metrics.inc call in try/swallow (best-effort, must not break dispatch)', () => {
    // Crude but effective: every metrics?.inc invocation should be
    // surrounded by `try { ... } catch { ... }`. Count them and check
    // they all appear inside a try-catch (same line + close to it).
    const incLines: number[] = [];
    src.split('\n').forEach((line, i) => {
      if (line.includes('this.metrics?.inc(')) incLines.push(i);
    });
    expect(incLines.length).toBeGreaterThanOrEqual(3);
    const lines = src.split('\n');
    for (const i of incLines) {
      // Look up to 2 lines back for a `try {`.
      const window = lines.slice(Math.max(0, i - 2), i + 1).join('\n');
      expect(window, `metrics.inc at line ${(i + 1).toString()} must be in try/swallow`).toMatch(
        /try\s*\{/,
      );
    }
  });
});
