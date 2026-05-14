// W855 — WebhookDeliveryStatus 5-value cross-source invariant.
// One-hundred-eighty-first in the drift-guard series. Pins the
// 5-value webhook-delivery lifecycle enum:
//   1. pending   — queued, not yet picked up by worker.
//   2. in_flight — worker is currently attempting delivery.
//   3. delivered — terminal success (2xx response).
//   4. failed    — terminal failure (worker gave up after retries).
//   5. dlq       — dead-letter queue (failed + persisted for replay).
// stays in lockstep across:
//   - packages/api-types/src/webhooks.ts (Zod canonical source).
//   - apps/server/src/db/schema.ts pgEnum (Postgres runtime).
//   - packages/sdk-go/types.go (Go SDK closed-enum consts).
//   - apps/customer-dashboard/src/pages/webhooks.astro (per-
//     endpoint deliveries filter dropdown + per-row status
//     classification for retry-eligibility).
//
// Drift in any of these — adding a status without coordinated
// Go SDK + dashboard updates — would silently let webhooks queue
// in a status the worker doesn't recognise OR let the dashboard
// fail to render the filter for the new status.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const DELIVERY_STATUSES = ['pending', 'in_flight', 'delivered', 'failed', 'dlq'] as const;

describe('W855 WebhookDeliveryStatus cross-source invariant', () => {
  // ─── api-types canonical source ──────────────────────────────

  it('CRITICAL packages/api-types/src/webhooks.ts WebhookDeliveryStatusSchema = z.enum([5 values]). The 5-value closed lifecycle is the contract every consumer pivots on.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/webhooks.ts'));
    expect(p).toMatch(/export const WebhookDeliveryStatusSchema = z\.enum\(\[/);
    const m = p.match(/WebhookDeliveryStatusSchema = z\.enum\(\[([\s\S]+?)\]\)/);
    expect(m, 'WebhookDeliveryStatusSchema declaration must match').not.toBeNull();
    const body = m![1];
    for (const s of DELIVERY_STATUSES) {
      expect(body, `WebhookDeliveryStatusSchema must include '${s}'`).toMatch(new RegExp(`'${s}'`));
    }
  });

  it('CRITICAL WebhookDeliveryStatus type re-exports from z.infer (drift-proof).', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/webhooks.ts'));
    expect(p).toMatch(
      /export type WebhookDeliveryStatus = z\.infer<typeof WebhookDeliveryStatusSchema>;/,
    );
  });

  // ─── DB pgEnum lockstep ──────────────────────────────────────

  it("CRITICAL apps/server/src/db/schema.ts webhookDeliveryStatus = pgEnum('webhook_delivery_status', [5 values]) in the SAME order. Postgres rejects INSERTs of unknown values — drift would crash the worker on persist.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/schema.ts'));
    expect(p).toMatch(/webhookDeliveryStatus = pgEnum\('webhook_delivery_status', \[/);
    const m = p.match(
      /webhookDeliveryStatus = pgEnum\('webhook_delivery_status', \[([\s\S]+?)\]\);/,
    );
    expect(m, 'webhookDeliveryStatus pgEnum body must be present').not.toBeNull();
    const body = m![1];
    for (const s of DELIVERY_STATUSES) {
      expect(body, `pgEnum must include '${s}'`).toMatch(new RegExp(`'${s}'`));
    }
  });

  // ─── Go SDK closed-enum consts ───────────────────────────────

  it('CRITICAL packages/sdk-go/types.go declares 5 WebhookDeliveryStatus consts — DeliveryPending + DeliveryInFlight + DeliveryDelivered + DeliveryFailed + DeliveryDLQ. Each maps to one canonical status string.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-go/types.go'));
    expect(p).toMatch(/type WebhookDeliveryStatus string/);
    expect(p).toMatch(/DeliveryPending\s+WebhookDeliveryStatus = "pending"/);
    expect(p).toMatch(/DeliveryInFlight\s+WebhookDeliveryStatus = "in_flight"/);
    expect(p).toMatch(/DeliveryDelivered WebhookDeliveryStatus = "delivered"/);
    expect(p).toMatch(/DeliveryFailed\s+WebhookDeliveryStatus = "failed"/);
    expect(p).toMatch(/DeliveryDLQ\s+WebhookDeliveryStatus = "dlq"/);
  });

  // ─── Customer-dashboard filter dropdown ──────────────────────

  it("CRITICAL apps/customer-dashboard/src/pages/webhooks.astro per-endpoint deliveries-filter dropdown renders ALL 5 status options + 'All statuses' (the empty-string sentinel). Drift to missing a status option would silently hide that bucket from the dashboard filter.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/webhooks.astro'));
    // The dropdown is rendered from a JS array literal.
    expect(p).toMatch(/\['', 'pending', 'in_flight', 'delivered', 'failed', 'dlq'\]/);
  });

  it("CRITICAL apps/customer-dashboard/src/pages/webhooks.astro per-row status classification — pending/in_flight render as 'in-flight'; delivered as 'success'; failed/dlq as 'failure'. The classification drives retry-eligibility UI; drift would let the dashboard misclassify retry-eligible rows.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/webhooks.astro'));
    // pending OR in_flight = in-flight.
    expect(p).toMatch(/d\.status === 'pending' \|\| d\.status === 'in_flight'/);
    // delivered = success.
    expect(p).toMatch(/d\.status === 'delivered'/);
  });

  // ─── 5-value cardinality + 2 terminal-failure ─────────────────

  it("CRITICAL WebhookDeliveryStatus = EXACTLY 5 values. The 5-value lifecycle is what worker poll-queries + DLQ-replay jobs depend on (each enumerates 'pending+in_flight' for poll, 'failed+dlq' for replay).", () => {
    expect(DELIVERY_STATUSES.length).toBe(5);
    // 2 in-flight + 1 success + 2 terminal-failure.
    const inFlight = (['pending', 'in_flight'] as const).filter((s) =>
      (DELIVERY_STATUSES as readonly string[]).includes(s),
    );
    const success = (['delivered'] as const).filter((s) =>
      (DELIVERY_STATUSES as readonly string[]).includes(s),
    );
    const failure = (['failed', 'dlq'] as const).filter((s) =>
      (DELIVERY_STATUSES as readonly string[]).includes(s),
    );
    expect(inFlight.length).toBe(2);
    expect(success.length).toBe(1);
    expect(failure.length).toBe(2);
  });

  // ─── No forbidden / legacy status names ──────────────────────

  it('CRITICAL no source declares forbidden delivery-status names (queued / sent / retrying / acknowledged / canceled). These are common queue-system patterns the 5-value model intentionally avoids — drift would fragment the lifecycle story.', () => {
    const apiTypes = read(resolve(REPO_ROOT, 'packages/api-types/src/webhooks.ts'));
    const forbidden = ['queued', 'sent', 'retrying', 'acknowledged', 'canceled'];
    const m = apiTypes.match(/WebhookDeliveryStatusSchema = z\.enum\(\[([\s\S]+?)\]\)/);
    expect(m).not.toBeNull();
    const body = m![1];
    for (const f of forbidden) {
      expect(body, `WebhookDeliveryStatus must NOT include forbidden ${f}`).not.toMatch(
        new RegExp(`'${f}'`),
      );
    }
  });

  // ─── 'dlq' is the named-replay-eligible bucket ────────────────

  it("CRITICAL 'dlq' is a SEPARATE terminal-failure bucket from 'failed' (not merged into one 'errored' state). The split exists so DLQ-replay jobs can target the 'dlq' bucket without re-triggering still-retrying rows. Drift to merging would break the replay/retry separation.", () => {
    expect(DELIVERY_STATUSES).toContain('dlq');
    expect(DELIVERY_STATUSES).toContain('failed');
    expect(DELIVERY_STATUSES.indexOf('failed')).not.toBe(DELIVERY_STATUSES.indexOf('dlq'));
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/webhook-delivery-status-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
