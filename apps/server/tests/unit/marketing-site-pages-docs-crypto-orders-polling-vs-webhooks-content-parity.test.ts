// W509.A — drift guard for apps/marketing-site/src/pages/docs/crypto-orders-polling-vs-webhooks.astro.
// V-666.BV practitioner guide. Drift here either claims crypto.order.*
// webhooks are subscribable today (would mislead customers building
// against an unsubscribable event) or breaks the polling-cadence
// guidance.
//
//   • V-666.BV doc-comment framing.
//   • crypto-order state machine: pending → confirming → paid /
//     failed / partial / cancelled.
//   • crypto.order.* not in SubscribableWebhookEventTypeSchema today.
//   • Today: GET /v1/billing/crypto-orders polling.
//   • 3-cadence guidance: 1-5s + 30-60s + hourly/nightly + V-666.BU
//     cursor + V-534 history view + V-534.BS 60s default.
//   • Roadmap hybrid: webhooks + reconciliation polling.
//   • Idempotency planning: (order_id, status) upsert key.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(
  REPO_ROOT,
  'apps/marketing-site/src/pages/docs/crypto-orders-polling-vs-webhooks.astro',
);

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W509.A apps/marketing-site/src/pages/docs/crypto-orders-polling-vs-webhooks.astro content parity', () => {
  const body = read(LIB);

  it("V-666.BV framing pinned: 'practitioner guide on how to detect crypto-order state changes. Webhooks for `crypto.order.*` are roadmap (not in SubscribableWebhookEventTypeSchema today) so this page primarily documents the polling pattern + describes the hybrid pattern as the planned end-state.' — pinned so the V-666.BV anchor + 'not in SubscribableWebhookEventTypeSchema today' commitment + polling-as-primary-doc framing all survive (drift to softening 'roadmap' would let customers think the webhooks are live)", () => {
    expect(body).toMatch(
      /\/\/ V-666\.BV — practitioner guide on how to detect crypto-order state\s*\n?\s*\/\/ changes\. Webhooks for `crypto\.order\.\*` are roadmap \(not in\s*\n?\s*\/\/ SubscribableWebhookEventTypeSchema today\) so this page primarily\s*\n?\s*\/\/ documents the polling pattern \+ describes the hybrid pattern as\s*\n?\s*\/\/ the planned end-state\./,
    );
  });

  it("Order state-machine framing pinned: 'pending → confirming → paid (or failed / partial / cancelled)' — pinned so the 5-state crypto-order lifecycle stays consistent (drift to adding/dropping a state would create marketing↔OpenAPI-enum divergence)", () => {
    expect(body).toMatch(
      /A crypto order's status moves between\s*\n?\s*<code>pending<\/code> → <code>confirming<\/code> →\s*\n?\s*<code>paid<\/code> \(or <code>failed<\/code> \/\s*\n?\s*<code>partial<\/code> \/ <code>cancelled<\/code>\)\./,
    );
  });

  it("Today-polling-only commitment pinned: 'crypto.order.paid / crypto.order.failed are emitted server-side but are not yet in SubscribableWebhookEventTypeSchema, so they cannot be the target of a POST /v1/webhooks subscription. Until they graduate, every integration polls.' — pinned so the explicit 'emitted-but-not-subscribable' nuance + the 'polls until graduates' commitment survive (drift to softening 'cannot be the target of POST /v1/webhooks' would mislead customers about the subscribability)", () => {
    expect(body).toMatch(
      /<code>crypto\.order\.paid<\/code> \/ <code>crypto\.order\.failed<\/code>\s*\n?\s*are emitted server-side but are <strong>not yet<\/strong> in\s*\n?\s*<code>SubscribableWebhookEventTypeSchema<\/code>, so they\s*\n?\s*cannot be the target of a <code>POST \/v1\/webhooks<\/code>\s*\n?\s*subscription\. Until they graduate, every integration polls\./,
    );
  });

  it("3-cadence polling guidance: 1-5s (user watching) + 30-60s (dashboard background, V-534 default) + hourly/nightly (reconciliation, V-666.BU cursor) — pinned so the 3-cadence + 2-V-anchor (V-534 + V-666.BU) guidance survive (drift to dropping the 'stop polling once terminal' guidance would let polling run indefinitely; drift to dropping V-666.BU cursor anchor would orphan the backfill mechanism)", () => {
    expect(body).toMatch(
      /<strong>1-5 seconds<\/strong>: user is watching a "Pay\s*\n?\s*with crypto" page\. Stop polling once status is terminal\./,
    );
    expect(body).toMatch(
      /<strong>30-60 seconds<\/strong>: background process tied\s*\n?\s*to a dashboard tab\. Default for the V-534 history view\./,
    );
    expect(body).toMatch(
      /<strong>Hourly \/ nightly<\/strong>: reconciliation \+\s*\n?\s*backfill\. Use the cursor \(V-666\.BU\) to walk every order\s*\n?\s*once per window\./,
    );
  });

  it("Customer dashboard 60s-polling + V-534.BS pattern pinned: 'The Driftstack customer dashboard polls GET /v1/billing/crypto-orders every 60s while any visible order is still pending (V-534.BS).' + 'shorten the poll interval to 5-10s — the rate-limit budget on the customer list endpoint is generous enough' — pinned so the 60s default + V-534.BS anchor + 5-10s rate-limit-budget rationale survive (drift to a different default cadence would create marketing↔customer-dashboard divergence)", () => {
    expect(body).toMatch(
      /The Driftstack customer dashboard polls\s*\n?\s*<code>GET \/v1\/billing\/crypto-orders<\/code> every 60s while\s*\n?\s*any visible order is still <code>pending<\/code> \(V-534\.BS\)\./,
    );
    expect(body).toMatch(
      /shorten the poll interval to 5-10s — the rate-limit budget\s*\n?\s*on the customer list endpoint is generous enough/,
    );
  });

  it("listAll() pattern pinned: 'The SDK's listAll() manages cursors internally and yields one envelope at a time, so consumers can break early without paying for the full scan.' — pinned so the listAll cursor-managed framing + break-early-without-full-scan commitment survive (drift to dropping 'break early' would let customers think they have to walk the whole list)", () => {
    expect(body).toMatch(
      /The SDK's <code>listAll\(\)<\/code> manages cursors internally\s*\n?\s*and yields one envelope at a time, so consumers can\s*\n?\s*<code>break<\/code> early without paying for the full scan\./,
    );
  });

  it("Roadmap hybrid framing: 'recommended pattern will be hybrid: webhooks for sub-second notification, nightly polling for backfill. Until then, integrators that need sub-second latency tighten the poll interval rather than wait for the webhook surface.' — pinned so the hybrid-end-state framing + 'until then tighten poll' commitment survive (drift to dropping the hybrid framing would orphan the planned end-state from the doc)", () => {
    expect(body).toMatch(
      /recommended pattern will be hybrid: webhooks for\s*\n?\s*sub-second notification, nightly polling for backfill\.\s*\n?\s*Until then, integrators that need sub-second latency\s*\n?\s*tighten the poll interval rather than wait for the webhook\s*\n?\s*surface\./,
    );
  });

  it("Idempotency planning: '(order_id, status) so duplicate crypto.order.paid events for the same order are a no-op' — pinned so the (order_id, status) upsert-key idempotency-planning advice survives (drift to dropping the composite-key guidance would let customers build receivers that double-process retried events)", () => {
    expect(body).toMatch(
      /Key your local DB\s*\n?\s*upsert on <code>\(order_id, status\)<\/code> so duplicate\s*\n?\s*<code>crypto\.order\.paid<\/code> events for the same order are\s*\n?\s*a no-op\./,
    );
  });

  it('4-related-doc cluster pinned: /docs/webhooks-crypto-events (roadmap) + /docs/webhooks (signing+retries) + /docs/sdk-typescript-crypto-orders + /docs/billing-crypto-integration-guide — pinned so the 4-related-doc navigation surface stays complete (drift to dropping the roadmap cross-reference would orphan the future-feature anchor)', () => {
    expect(body).toMatch(
      /<a href="\/docs\/webhooks-crypto-events">Crypto webhook events \(roadmap\)<\/a>/,
    );
    expect(body).toMatch(/<a href="\/docs\/webhooks">Webhook signing \+ retries<\/a>/);
    expect(body).toMatch(
      /<a href="\/docs\/sdk-typescript-crypto-orders">SDK reference — crypto orders<\/a>/,
    );
    expect(body).toMatch(
      /<a href="\/docs\/billing-crypto-integration-guide">Integration guide<\/a>/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
