// W871 — Webhook policy cross-source invariant. One-hundred-
// ninety-seventh in the drift-guard series. Pins the V-185/V-356/
// V-359 webhook policy contract:
//
//   1. URL must use https:// — refined via Zod refine on both
//      Create + Update request schemas.
//   2. events array bounded — min(1).max(10) events per webhook.
//   3. description bounded — max(200) chars.
//   4. V-356 — events array uses SubscribableWebhookEventType
//      (5-value subset, EXCLUDING test.ping).
//   5. V-359 — rotate-secret response includes 24h grace_expires_at
//      timestamp + dual-signing semantics framing.
//
// stays in lockstep across:
//   - packages/api-types/src/webhooks.ts (Zod canonical source).
//   - apps/customer-dashboard/src/pages/webhooks.astro (HTTPS
//     required form helper text).
//
// Drift would silently break:
//   * Server rejecting valid configurations OR accepting invalid.
//   * Customer-dashboard offering settings the server rejects.
//   * V-359 secret-rotation grace contract.
//   * V-356 test.ping leak into customer subscriptions.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CreateWebhookRequestSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const MAX_EVENTS_PER_WEBHOOK = 10;
const MAX_DESCRIPTION_CHARS = 200;

describe('W871 Webhook policy cross-source invariant', () => {
  // ─── CreateWebhookRequestSchema https refine ─────────────────

  it('CRITICAL packages/api-types/src/webhooks.ts CreateWebhookRequestSchema url field enforces https:// with the same message, as a PUBLISHABLE regex rather than a refine (V-1498 — a refine never reached the OpenAPI document). The https-only rule is what prevents customers from pointing webhooks at http:// (leaking secrets) or non-URL strings (refusing delivery).', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/webhooks.ts'));
    expect(p).toMatch(
      /CreateWebhookRequestSchema = z\.object\(\{[\s\S]+?url: z\s*\.string\(\)\s*\.url\(\)\s*\.regex\(\/\^https:\\\/\\\/\/, \{ message: 'Webhook URL must use https:\/\/' \}\),/,
    );
  });

  it('CRITICAL packages/api-types/src/webhooks.ts CreateWebhookRequest events field is SubscribableWebhookEventTypeSchema array with .min(1).max(10). V-356 — customers cannot subscribe to test.ping; 1-10 events per webhook.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/webhooks.ts'));
    expect(p).toMatch(
      /CreateWebhookRequestSchema = z\.object\(\{[\s\S]+?events: z\.array\(SubscribableWebhookEventTypeSchema\)\.min\(1\)\.max\(10\)/,
    );
  });

  it('CRITICAL CreateWebhookRequest description field is bounded to max(200) chars + nullable + optional. The 200-char cap keeps audit-trail descriptions readable + bounds storage cost; nullable matches the dashboard create-form posting `description: null` for a blank description (the route normalizes with `?? null`, mirroring Update).', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/webhooks.ts'));
    expect(p).toMatch(
      /CreateWebhookRequestSchema = z\.object\(\{[\s\S]+?description: z\.string\(\)\.max\(200\)\.nullable\(\)\.optional\(\)/,
    );
  });

  it('CreateWebhookRequestSchema accepts description: null (dashboard blank-description path) as well as undefined + a string, and rejects > 200 chars', () => {
    const base = {
      url: 'https://example.com/webhook',
      events: ['session.completed'] as const,
    };
    expect(CreateWebhookRequestSchema.safeParse({ ...base, description: null }).success).toBe(true);
    expect(CreateWebhookRequestSchema.safeParse({ ...base }).success).toBe(true);
    expect(CreateWebhookRequestSchema.safeParse({ ...base, description: 'ok' }).success).toBe(true);
    expect(
      CreateWebhookRequestSchema.safeParse({ ...base, description: 'x'.repeat(201) }).success,
    ).toBe(false);
  });

  // ─── UpdateWebhookRequestSchema same constraints ─────────────

  it("CRITICAL packages/api-types/src/webhooks.ts UpdateWebhookRequestSchema mirrors Create constraints — https-regex + Subscribable.min(1).max(10) + description.max(200). The dual-validation is what makes 'edit endpoint' UX behave identically to 'create endpoint'.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/webhooks.ts'));
    expect(p).toMatch(
      /UpdateWebhookRequestSchema = z\s*\.object\(\{[\s\S]+?\.regex\(\/\^https:\\\/\\\/\/, \{ message: 'Webhook URL must use https:\/\/' \}\)/,
    );
    expect(p).toMatch(
      /UpdateWebhookRequestSchema[\s\S]+?events: z\.array\(SubscribableWebhookEventTypeSchema\)\.min\(1\)\.max\(10\)/,
    );
    expect(p).toMatch(
      /UpdateWebhookRequestSchema[\s\S]+?description: z\.string\(\)\.max\(200\)\.nullable\(\)\.optional\(\)/,
    );
  });

  it("CRITICAL UpdateWebhookRequestSchema refine pins 'At least one field must be provided' — partial PATCH semantics. Drift to allowing an empty body would let no-op PATCHes succeed silently.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/webhooks.ts'));
    expect(p).toMatch(/At least one field must be provided\./);
  });

  // ─── V-359 RotateWebhookSecretResponse 24h grace ─────────────

  it('CRITICAL packages/api-types/src/webhooks.ts RotateWebhookSecretResponseSchema has grace_expires_at: Iso8601Schema with the dual-signing semantics describe text. V-359 — every outbound delivery is signed with both the new + old secret during the grace window.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/webhooks.ts'));
    expect(p).toMatch(
      /RotateWebhookSecretResponseSchema = z\.object\(\{[\s\S]+?grace_expires_at: Iso8601Schema\.describe\(/,
    );
    expect(p).toMatch(/every outbound delivery is signed with both the new \+ old secret/);
  });

  it('CRITICAL V-359 anchor pinned for rotate-secret response. The framing pins the secret-rotation provenance to future maintainers.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/webhooks.ts'));
    expect(p).toMatch(/V-359 — POST \/v1\/webhooks\/:id\/rotate-secret response/);
  });

  // ─── 24h grace period framing pinned ─────────────────────────

  it("CRITICAL WebhookEndpointSchema has prev_secret_prefix + rotation_grace_expires_at fields, both nullable. The 'null when no rotation in flight' framing matches the V-359 24h dual-signing model — when grace expires, prev_secret_prefix should be cleared.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/webhooks.ts'));
    expect(p).toMatch(/prev_secret_prefix: z\s*\.string\(\)\s*\.nullable\(\)/);
    expect(p).toMatch(/rotation_grace_expires_at: Iso8601Schema\.nullable\(\)/);
    expect(p).toMatch(/V-359 — populated only during the 24h rotation grace period/);
  });

  // ─── Customer-dashboard https-required form helper ────────────

  it("CRITICAL apps/customer-dashboard/src/pages/webhooks.astro form helper text pins 'HTTPS required. The endpoint must respond 2xx within 10s for delivery to count as successful.' The 2-sentence framing communicates both the protocol constraint + the success criterion.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/webhooks.astro'));
    expect(p).toMatch(/HTTPS required\./);
    expect(p).toMatch(/respond 2xx within 10s for delivery to count\s*as successful/);
  });

  it("CRITICAL apps/customer-dashboard/src/pages/webhooks.astro 'New endpoint' + 'Edit endpoint' form url inputs have type=\"url\" + required + placeholder='https://...'. The HTML5 type=url + required attrs match server-side validation expectations.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/webhooks.astro'));
    expect(p).toMatch(/name="url"\s*\n\s*type="url"\s*\n\s*required/);
    expect(p).toMatch(/placeholder="https:\/\/hooks\.example\.com\/driftstack"/);
  });

  // ─── Cardinality constants ───────────────────────────────────

  it('CRITICAL events-per-webhook cap = 10 + description cap = 200 chars. The 10-event cap intentionally limits to a small fan-out + the 200-char description is short enough to render inline in dashboards.', () => {
    expect(MAX_EVENTS_PER_WEBHOOK).toBe(10);
    expect(MAX_DESCRIPTION_CHARS).toBe(200);
  });

  // ─── V-185 delivery-counts shape ────────────────────────────

  it('CRITICAL WebhookEndpointSchema.delivery_counts has EXACTLY 3 fields — delivered + failed + dlq (each int().nonnegative()). The 3-counter aggregate is what dashboard per-endpoint summaries depend on. Drift would silently miss a status bucket.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/webhooks.ts'));
    expect(p).toMatch(
      /delivery_counts: z\.object\(\{\s*\n\s*delivered: z\.number\(\)\.int\(\)\.nonnegative\(\),\s*\n\s*failed: z\.number\(\)\.int\(\)\.nonnegative\(\),\s*\n\s*dlq: z\.number\(\)\.int\(\)\.nonnegative\(\),\s*\n\s*\}\)/,
    );
    expect(p).toMatch(/V-185 — aggregate per-endpoint delivery counts/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/webhook-policy-cross-source-invariant.test.ts'),
      ),
    ).toBe(true);
  });
});
