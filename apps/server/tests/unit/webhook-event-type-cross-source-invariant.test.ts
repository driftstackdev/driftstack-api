// W852 — WebhookEventType 9-value roster cross-source invariant.
// One-hundred-seventy-eighth in the drift-guard series. Pins the
// 9-value WebhookEventType closed-roster:
//   1. session.completed
//   2. session.failed
//   3. api_key.revoked
//   4. session.egress_capability_changed
//   5. test.ping (server-only, not subscribable)
//   6–7. crypto.order.paid / crypto.order.failed
//   8. session.challenge_detected
//   9. session.profile_save_failed
// stays in lockstep across:
//   - packages/api-types/src/webhooks.ts (Zod canonical source).
//   - apps/server/src/db/schema.ts pgEnum (Postgres runtime enum).
//   - packages/sdk-go/types.go (Go SDK closed-enum consts).
//   - apps/customer-dashboard/src/pages/webhooks.astro (8
//     subscribable checkboxes per V-356; test.ping is NOT
//     subscribable).
//
// Drift in any of these — adding a value to api-types without the
// pgEnum, or removing from Go SDK without api-types — would
// silently let webhook deliveries route through unrecognised
// channels OR let customers subscribe to types the server doesn't
// emit.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

// V-356 — the canonical 6-value roster + 5-value subscribable subset.
// Arc 5 EGRESS eg.7 extends the closed roster with
// `session.egress_capability_changed` (subscribable).
const ALL_WEBHOOK_EVENTS = [
  'session.completed',
  'session.failed',
  'api_key.revoked',
  'test.ping',
  'session.egress_capability_changed',
  // V-666 (2026-05-22) — crypto-order terminal events.
  'crypto.order.paid',
  'crypto.order.failed',
  'session.challenge_detected',
  'session.profile_save_failed',
] as const;

const SUBSCRIBABLE_EVENTS = [
  'session.completed',
  'session.failed',
  'api_key.revoked',
  'session.egress_capability_changed',
  // V-666 (2026-05-22) — crypto-order terminal events (subscribable).
  'crypto.order.paid',
  'crypto.order.failed',
  'session.challenge_detected',
  'session.profile_save_failed',
] as const;

describe('W852 WebhookEventType cross-source invariant', () => {
  // ─── api-types canonical source ──────────────────────────────

  it('CRITICAL packages/api-types/src/webhooks.ts WebhookEventTypeSchema = z.enum([...9 values...]). The 9-value closed-roster is the contract every consumer pivots on (Arc 5 EGRESS eg.7 added session.egress_capability_changed; V-666 added crypto.order.paid + crypto.order.failed).', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/webhooks.ts'));
    expect(p).toMatch(/export const WebhookEventTypeSchema = z\.enum\(\[/);
    for (const ev of ALL_WEBHOOK_EVENTS) {
      expect(p, `WebhookEventTypeSchema must include '${ev}'`).toMatch(
        new RegExp(`'${ev.replace(/\./g, '\\.')}'`),
      );
    }
  });

  it('CRITICAL packages/api-types/src/webhooks.ts SubscribableWebhookEventTypeSchema is the 8-value subset EXCLUDING test.ping. Per V-356, test.ping is server-only — dispatched ONLY via POST /v1/webhooks/:id/test endpoint, never via subscription. Arc 5 EGRESS eg.7 added session.egress_capability_changed; V-666 added crypto.order.paid + crypto.order.failed as the 7th + 8th subscribable.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/webhooks.ts'));
    const m = p.match(/SubscribableWebhookEventTypeSchema = z\.enum\(\[([\s\S]+?)\]\)/);
    expect(m, 'SubscribableWebhookEventTypeSchema declaration must match').not.toBeNull();
    const body = m![1];
    for (const ev of SUBSCRIBABLE_EVENTS) {
      expect(body, `subscribable must include '${ev}'`).toMatch(
        new RegExp(`'${ev.replace(/\./g, '\\.')}'`),
      );
    }
    // test.ping must NOT be in the subscribable subset.
    expect(body, 'test.ping must NOT be subscribable per V-356').not.toMatch(/'test\.ping'/);
  });

  it('CRITICAL types re-export from z.infer (drift-proof). Hand-written union types would drift from runtime enums.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/webhooks.ts'));
    expect(p).toMatch(/export type WebhookEventType = z\.infer<typeof WebhookEventTypeSchema>;/);
    expect(p).toMatch(
      /export type SubscribableWebhookEventType = z\.infer<typeof SubscribableWebhookEventTypeSchema>;/,
    );
  });

  // ─── DB pgEnum lockstep ──────────────────────────────────────

  it('CRITICAL apps/server/src/db/schema.ts contains every current event while retaining the two historical quota values for migration compatibility.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/schema.ts'));
    expect(p).toMatch(/webhookEventType = pgEnum\('webhook_event_type', \[/);
    // Extract the body of the webhookEventType pgEnum.
    const m = p.match(/webhookEventType = pgEnum\('webhook_event_type', \[([\s\S]+?)\]\);/);
    expect(m, 'webhookEventType pgEnum body must be present').not.toBeNull();
    const body = m![1];
    for (const ev of ALL_WEBHOOK_EVENTS) {
      expect(body, `pgEnum must include '${ev}'`).toMatch(
        new RegExp(`'${ev.replace(/\./g, '\\.')}'`),
      );
    }
    expect(body).toMatch(/'quota\.warning_80pct'/);
    expect(body).toMatch(/'quota\.exceeded'/);
  });

  // ─── Go SDK closed-enum consts ───────────────────────────────

  it('CRITICAL packages/sdk-go/types.go declares the current 9 WebhookEventType constants.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-go/types.go'));
    expect(p).toMatch(/type WebhookEventType string/);
    expect(p).toMatch(/EventSessionCompleted +WebhookEventType = "session\.completed"/);
    expect(p).toMatch(/EventSessionFailed +WebhookEventType = "session\.failed"/);
    expect(p).toMatch(/EventAPIKeyRevoked +WebhookEventType = "api_key\.revoked"/);
    expect(p).toMatch(
      /EventSessionEgressCapabilityChanged +WebhookEventType = "session\.egress_capability_changed"/,
    );
    expect(p).toMatch(/EventTestPing WebhookEventType = "test\.ping"/);
    expect(p).toMatch(/EventCryptoOrderPaid +WebhookEventType = "crypto\.order\.paid"/);
    expect(p).toMatch(/EventCryptoOrderFailed +WebhookEventType = "crypto\.order\.failed"/);
    expect(p).toMatch(
      /EventSessionChallengeDetected +WebhookEventType = "session\.challenge_detected"/,
    );
    expect(p).toMatch(
      /EventSessionProfileSaveFailed +WebhookEventType = "session\.profile_save_failed"/,
    );
    expect(p).not.toMatch(/EventQuotaWarning80Pct|EventQuotaExceeded/);
  });

  it("CRITICAL Go SDK 'closed enum' framing pinned. The 'closed enum of supported webhook events' comment threads the type-system intent (vs an open-string enum). Drift to weakening the framing would invite a Go SDK consumer to invent their own consts.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-go/types.go'));
    expect(p).toMatch(/closed enum of supported webhook events/);
  });

  // ─── customer-dashboard subscribable-checkbox rendering ──────

  it('CRITICAL apps/customer-dashboard/src/pages/webhooks.astro renders checkboxes for ALL 8 SUBSCRIBABLE events (NOT test.ping). The form pivots on these exact event-strings as checkbox values; drift to missing a checkbox would silently let customers be unable to subscribe to that event in the dashboard.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/webhooks.astro'));
    for (const ev of SUBSCRIBABLE_EVENTS) {
      expect(p, `webhooks.astro missing checkbox value='${ev}'`).toMatch(
        new RegExp(`value="${ev.replace(/\./g, '\\.')}"`),
      );
    }
    // test.ping must NOT be rendered as a subscribable checkbox.
    expect(p, 'test.ping must NOT be rendered as a checkbox value').not.toMatch(
      /name="event" value="test\.ping"/,
    );
  });

  // ─── V-356 anchor traceable ─────────────────────────────────

  it("CRITICAL V-356 anchor pinned in api-types/webhooks.ts. The 'V-356' anchor threads the test-ping-only-via-test-endpoint provenance for cross-link discovery.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/webhooks.ts'));
    expect(p).toMatch(/V-356/);
  });

  // ─── 9 + 8 cardinality (6+5 pre-egress; 7+6 pre-V-666-crypto) ───

  it('CRITICAL WebhookEventType = exactly 9 values + SubscribableWebhookEventType = exactly 8 (9 minus test.ping). Arc 5 EGRESS eg.7 added session.egress_capability_changed; V-666 (2026-05-22) added crypto.order.paid + crypto.order.failed — cardinality 6/5 → 7/6 → 9/8.', () => {
    expect(ALL_WEBHOOK_EVENTS.length).toBe(9);
    expect(SUBSCRIBABLE_EVENTS.length).toBe(8);
    expect(SUBSCRIBABLE_EVENTS.length).toBe(ALL_WEBHOOK_EVENTS.length - 1);
  });

  // ─── No forbidden / legacy event names ───────────────────────

  it('CRITICAL no source declares forbidden event names (session.created / webhook.* / *.created / *.deleted). These are common-namespace patterns that V-356 intentionally avoids — the namespace is reserved for the closed 6-value roster.', () => {
    const apiTypes = read(resolve(REPO_ROOT, 'packages/api-types/src/webhooks.ts'));
    for (const forbidden of [
      "'session.created'",
      "'session.deleted'",
      "'webhook.created'",
      "'account.created'",
    ]) {
      expect(
        apiTypes,
        `WebhookEventType must NOT include forbidden event ${forbidden}`,
      ).not.toMatch(new RegExp(`WebhookEventTypeSchema[\\s\\S]+?${forbidden}[\\s\\S]+?\\]\\)`));
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/webhook-event-type-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
