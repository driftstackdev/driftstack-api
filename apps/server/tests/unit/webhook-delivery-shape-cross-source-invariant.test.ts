// W898 — WebhookDelivery 12-field shape + V-512 DLQ filter cross-
// source invariant. Two-hundred-twenty-fourth in the drift-guard
// series. Pins the webhook-delivery audit/replay shapes:
//
//   WebhookDelivery (12 fields):
//     id + webhook_id + event_id + event_type + status + attempts
//     + next_attempt_at + last_response_status + last_response_excerpt
//     + last_error + delivered_at + created_at.
//
//   ListDlqQuery (V-512):
//     - limit: 1-100 default 50.
//     - cursor optional.
//     - endpoint_id: 1-200 chars (V-512 drill-down filter).
//
//   V-512 framing: 'Customer support workflow: a customer reports
//     "my endpoint is missing events"; admin pulls just that
//     endpoint's DLQ rows without wading through other accounts.'
//
// stays in lockstep across api-types Zod canonical.
//
// Drift would silently break:
//   * Admin DLQ drill-down UI when V-512 filter changes shape.
//   * Webhook-delivery audit trail rendering missing fields.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W898 WebhookDelivery shape + V-512 DLQ cross-source invariant', () => {
  // ─── WebhookDelivery 12-field shape ──────────────────────────

  it('CRITICAL packages/api-types/src/webhooks.ts WebhookDeliverySchema has 12 fields — id + webhook_id + event_id + event_type + status + attempts + next_attempt_at + last_response_status + last_response_excerpt + last_error + delivered_at + created_at. The 12-field shape is the full delivery-audit trail.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/webhooks.ts'));
    const m = p.match(/WebhookDeliverySchema = z\.object\(\{([\s\S]+?)\}\);/);
    expect(m).not.toBeNull();
    const body = m![1];
    for (const f of [
      'id:',
      'webhook_id:',
      'event_id:',
      'event_type:',
      'status:',
      'attempts:',
      'next_attempt_at:',
      'last_response_status:',
      'last_response_excerpt:',
      'last_error:',
      'delivered_at:',
      'created_at:',
    ]) {
      expect(body, `WebhookDeliverySchema must have ${f}`).toMatch(new RegExp(f));
    }
  });

  it('CRITICAL WebhookDelivery uses typed prefixed-id schemas — id: WebhookDeliveryIdSchema + webhook_id: WebhookEndpointIdSchema. The typed IDs prevent cross-resource ID-confusion bugs.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/webhooks.ts'));
    expect(p).toMatch(
      /WebhookDeliverySchema = z\.object\(\{\s*\n\s*id: WebhookDeliveryIdSchema,\s*\n\s*webhook_id: WebhookEndpointIdSchema,/,
    );
  });

  it('CRITICAL WebhookDelivery nullables — last_response_status + last_response_excerpt + last_error + delivered_at all nullable. last_response_* are null until first attempt; last_error is null on success; delivered_at is null until delivered status.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/webhooks.ts'));
    expect(p).toMatch(/last_response_status: z\.number\(\)\.int\(\)\.nullable\(\)/);
    expect(p).toMatch(/last_response_excerpt: z\.string\(\)\.nullable\(\)/);
    expect(p).toMatch(/last_error: z\.string\(\)\.nullable\(\)/);
    expect(p).toMatch(/delivered_at: Iso8601Schema\.nullable\(\)/);
  });

  it('CRITICAL WebhookDelivery.event_type uses WebhookEventTypeSchema (9-value enum NOT subscribable subset). The 9-value covers all events INCLUDING test.ping — admin DLQ-view shows test-ping deliveries too.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/webhooks.ts'));
    expect(p).toMatch(
      /WebhookDeliverySchema = z\.object\(\{[\s\S]+?event_type: WebhookEventTypeSchema/,
    );
  });

  // ─── V-512 ListDlqQuery shape ────────────────────────────────

  it('CRITICAL packages/api-types/src/admin.ts ListDlqQuerySchema has V-512 endpoint_id drill-down — z.string().min(1).max(200).optional(). The 1-200 char bound matches V-512 admin filter pattern.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/admin.ts'));
    expect(p).toMatch(
      /ListDlqQuerySchema = z\.object\(\{[\s\S]+?endpoint_id: z\.string\(\)\.min\(1\)\.max\(200\)\.optional\(\)/,
    );
  });

  it("CRITICAL V-512 framing pins the support-workflow narrative — 'Customer support workflow: a customer reports my endpoint is missing events; admin pulls just that endpoint's DLQ rows without wading through other accounts'. The narrative teaches support reps the use case.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/admin.ts'));
    expect(p).toMatch(
      /V-512 — optional drill-down by webhook-endpoint id\. Customer\s*\n\s*\/\/ support workflow: a customer reports "my endpoint is missing\s*\n\s*\/\/ events"; admin pulls just that endpoint's DLQ rows without\s*\n\s*\/\/ wading through other accounts'\./,
    );
  });

  it('CRITICAL ListDlqQuery limit + cursor parity with audit-log queries — limit: 1-100 default 50, cursor optional. The shared pagination contract makes admin UI consistent.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/admin.ts'));
    expect(p).toMatch(
      // V-1473 — the cursor is capped at 512 now. This pin quoted the BARE shape,
      // which is the one slice 149 exists to remove, so it froze the defect.
      /ListDlqQuerySchema = z\.object\(\{\s*\n\s*limit: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(100\)\.default\(50\),[\s\S]*?cursor: z\.string\(\)\.min\(1\)\.max\(512\)\.optional\(\),/,
    );
  });

  // ─── WebhookEndpoint delivery_counts V-185 ───────────────────

  it('CRITICAL WebhookEndpoint.delivery_counts uses 3-field aggregate shape (delivered + failed + dlq, each int().nonnegative()). The V-185 anchor + 3-counter aggregate is what per-endpoint summary dashboards depend on.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/webhooks.ts'));
    expect(p).toMatch(/V-185 — aggregate per-endpoint delivery counts/);
    expect(p).toMatch(
      /delivery_counts: z\.object\(\{\s*\n\s*delivered: z\.number\(\)\.int\(\)\.nonnegative\(\),\s*\n\s*failed: z\.number\(\)\.int\(\)\.nonnegative\(\),\s*\n\s*dlq: z\.number\(\)\.int\(\)\.nonnegative\(\),/,
    );
  });

  // ─── 12-field cardinality + V-512 + V-185 anchors ────────────

  it('CRITICAL WebhookDelivery = EXACTLY 12 fields. The 12-field shape covers ID + correlation (event_id, webhook_id) + status + retry state (attempts, next_attempt_at) + response capture (3 nullable fields) + timestamps (delivered_at, created_at).', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/webhooks.ts'));
    const m = p.match(/WebhookDeliverySchema = z\.object\(\{([\s\S]+?)\}\);/);
    expect(m).not.toBeNull();
    const body = m![1] ?? '';
    const fieldCount = (body.match(/^\s*[a-z_]+:/gm) || []).length;
    expect(fieldCount).toBe(12);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/webhook-delivery-shape-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
