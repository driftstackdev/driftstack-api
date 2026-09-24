// W787 — apps/docs webhooks/{endpoints,events,replay}.md triplet
// parity guard. One-hundred-thirteenth in the cross-SDK drift-
// guard series.
//
// /webhooks/ subtree is the canonical reference for the V-181 +
// V-273 webhook system. Drift to the event catalog, the signature
// header format, or the retry/replay flow would mismatch W753
// dashboard /webhooks + W776 SDK error-handling + V-359 + V-475
// server-side enforcement.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WebhookEventTypeSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const EP = resolve(REPO_ROOT, 'apps/docs/src/pages/webhooks/endpoints.md');
const EV = resolve(REPO_ROOT, 'apps/docs/src/pages/webhooks/events.md');
const RPL = resolve(REPO_ROOT, 'apps/docs/src/pages/webhooks/replay.md');

describe('W787 docs webhooks/ triplet content parity', () => {
  it('all 3 webhooks files exist', () => {
    expect(existsSync(EP)).toBe(true);
    expect(existsSync(EV)).toBe(true);
    expect(existsSync(RPL)).toBe(true);
  });

  // ─── webhooks/endpoints.md ────────────────────────────────────

  it('CRITICAL endpoints.md frontmatter pinned.', () => {
    const p = read(EP);

    expect(p).toMatch(
      /^---\nlayout: \.\.\/\.\.\/layouts\/DocLayout\.astro\ntitle: Webhook endpoints\n/,
    );
    expect(p).toMatch(
      /description: Subscribe to events, list \/ patch \/ delete endpoints, send test deliveries, and rotate signing secrets — the \/v1\/webhooks resource\./,
    );
  });

  it("CRITICAL webhook-endpoint definition framing pinned. The 'A webhook endpoint is a customer-controlled HTTPS URL that Driftstack POSTs event payloads to. Each endpoint subscribes to one or more event types' wording is the canonical customer-explanation.", () => {
    const p = read(EP);

    expect(p).toMatch(
      /A \*\*webhook endpoint\*\* is a customer-controlled HTTPS URL that\s*\n?Driftstack POSTs event payloads to\./,
    );
    expect(p).toMatch(/Each endpoint subscribes to one\s*\n?or more event types/);
  });

  it('CRITICAL whk_-prefix id + secret_prefix 12-char + 24h-grace-rotation framing pinned. Matches W753 dashboard /webhooks V-359 rotation-in-flight + W750 api-keys secret-prefix convention.', () => {
    const p = read(EP);

    expect(p).toMatch(/"id": "whk_<uuid>",/);
    expect(p).toMatch(/`secret_prefix` is the first 12 chars of the plaintext secret\./);
    expect(p).toMatch(/Safe to log \+ display; the full secret is shown ONCE at create/);
    expect(p).toMatch(
      /`prev_secret_prefix` \+ `rotation_grace_expires_at` are null\s*\n?\s+except during the 24-hour grace period after a secret rotation/,
    );
    expect(p).toMatch(/Driftstack is dual-signing every outbound/);
  });

  it("CRITICAL test.ping not-subscribable framing pinned. The 'test.ping is delivery-side-only and is rejected if passed in the events array' wording matches W753 dashboard /webhooks + V-475 contract.", () => {
    const p = read(EP);

    expect(p).toMatch(
      /Only subscribable event types\s*\n?\s+count here; `test\.ping` is delivery-side-only and is rejected if\s*\n?\s+passed in the events array/,
    );
  });

  it('CRITICAL one-time secret + encrypted-at-rest framing pinned (2026-09-15: the AES-256-GCM envelope and delivery-worker boundary are how we run it and left the customer page; the promise — shown once, stored encrypted, later reads return only the prefix, rotate if lost — stays)', () => {
    const p = read(EP);

    expect(p).toMatch(
      /> \*\*Save the secret now\.\*\* It is shown ONCE\. Driftstack stores it encrypted,\s*\n?> and later reads return only the `secret_prefix`, never the full secret\. If\s*\n?> you lose it, rotate the secret to get a new one\./,
    );
    expect(p).not.toMatch(/AES-256-GCM|delivery worker/);
  });

  it('CRITICAL POST /v1/webhooks 3-error set pinned — 400 ValidationFailed (https/empty/>10 entries/test.ping) + 403 Forbidden (account_owner scope) + 409 Conflict (max 10 active endpoints). 2026-06-24: the endpoint cap is a ConflictError (HTTP 409), NOT a 429 TierLimit — services/webhooks.ts:376-381 throws ConflictError when active >= MAX_ENDPOINTS_PER_ACCOUNT (=10, line 302).', () => {
    const p = read(EP);

    expect(p).toMatch(
      /`400 ValidationFailed` — URL not https:\/\/, or events array empty\s*\n?\s+\/ >10 entries \/ contains `test\.ping`\./,
    );
    expect(p).toMatch(/`403 Forbidden` — `account_owner` scope missing on the calling key\./);
    // Webhooks audit #4 (2026-09-24): the cap counts every endpoint that is not
    // deleted — "active" was the loophole (pause, create, resume).
    expect(p).toMatch(
      /`409 Conflict` — the account already has 10 endpoints, the most it\s*\n?\s*can have\. Paused endpoints count toward the limit; only deleting an\s*\n?\s*endpoint frees a place\./,
    );
    expect(p).not.toMatch(/max 10 active endpoints/);
    // The stale 429-TierLimit framing must NOT return (it's a 409 ConflictError).
    expect(p).not.toMatch(/`429 TierLimit` — account at the max-endpoints-per-account cap\./);
  });

  it("CRITICAL PATCH active:false pauses-delivery framing pinned. The 'active: false pauses delivery without deleting the endpoint; useful for maintenance windows or post-incident cooldowns. Resume with active: true' wording matches W753 dashboard /webhooks edit-form behavior.", () => {
    const p = read(EP);

    expect(p).toMatch(
      /`active: false` pauses delivery without deleting the endpoint;\s*\n?useful for maintenance windows or post-incident cooldowns\./,
    );
    // Webhooks audit #3 (2026-09-24): what a pause does, exactly — held, not
    // attempted, not dead-lettered, not counted; queued during; sent after resume.
    expect(p).toMatch(/Resume with `active: true`: everything held is then delivered/);
    expect(p).toMatch(
      /deliveries already queued for it are held: they are not attempted,\s*\n?\s*not moved to the DLQ, and not counted in `consecutive_failures`/,
    );
    expect(p).toMatch(
      /events raised during the pause are queued for it and held the same\s*\n?\s*way\./,
    );
  });

  // ─── webhooks/events.md ───────────────────────────────────────

  it('CRITICAL events.md frontmatter pinned.', () => {
    const p = read(EV);

    expect(p).toMatch(
      /^---\nlayout: \.\.\/\.\.\/layouts\/DocLayout\.astro\ntitle: Webhook events catalog\n/,
    );
    expect(p).toMatch(
      /description: Reference for every webhook event type the Driftstack API emits — payload shapes, signature verification, retry policy\./,
    );
  });

  it('CRITICAL current-only framing is pinned without declared-but-unwired or planned event classes.', () => {
    const p = read(EV);

    expect(p).toMatch(
      /customer-facing reference for webhook events emitted by\s*Driftstack, plus the test event/,
    );
    expect(p).not.toMatch(/\[DECLARED\]|\[PLANNED\]|roadmap/i);
  });

  it('CRITICAL quick-index catalog completeness — every WebhookEventTypeSchema value is documented and retired quota declarations stay absent.', () => {
    const p = read(EV);

    // Source of truth: every emittable event type MUST appear in the
    // catalog. Deriving from the enum (rather than a hardcoded copy that
    // silently drifts) means a future additive enum value — e.g. the
    // 2026-05-22 crypto.order.* pair — fails this test until documented.
    for (const ev of WebhookEventTypeSchema.options) {
      expect(p, `enum event ${ev}`).toMatch(new RegExp(`\\| \`${ev.replace(/\./g, '\\.')}\``));
    }

    const plannedEvents: string[] = [];
    for (const ev of plannedEvents) {
      expect(p, `planned event ${ev}`).toMatch(new RegExp(`\\| \`${ev.replace(/\./g, '\\.')}\``));
    }
    expect(p).not.toMatch(/quota\.warning_80pct|quota\.exceeded|trial_pack\./);
  });

  it('CRITICAL <uuid> common-envelope shape pinned — id (bare UUID, matching services/webhooks.ts randomUUID()) + type + created_at + data (the real delivered body; no account_id / emitted_at). Drift to a different envelope would break SDK type discriminators.', () => {
    const p = read(EV);

    expect(p).toMatch(/"id": "<uuid>",/);
    expect(p).toMatch(/"type": "<event-type>",/);
    expect(p).toMatch(/"created_at": "2026-05-05T12:34:56\.789Z",/);
    // The wire body (services/webhooks.ts enqueueEvent) carries NO
    // account_id and NO emitted_at — the timestamp is created_at.
    expect(p).not.toMatch(/"account_id":/);
    expect(p).not.toMatch(/"emitted_at":/);
  });

  it("CRITICAL X-Driftstack-Signature header format pinned — 'X-Driftstack-Signature: t=<unix-seconds>,v1=<hex> — HMAC-SHA256(<t>.<raw body>) keyed by the endpoint signing secret, where <t> is the header value (not a body field)'. Matches W753 + V-273 webhook-delivery toolkit + the canonical x-driftstack-signature header set by webhook-worker + webhook-signing.ts.", () => {
    const p = read(EV);

    expect(p).toMatch(
      /`X-Driftstack-Signature: t=<unix-seconds>,v1=<hex>` —\s*\n?\s+HMAC-SHA256\(`<t>\.<raw body>`\) keyed by the endpoint signing\s*\n?\s+secret, where `<t>` is the `t=<unix-seconds>` value from this\s*\n?\s+same header \(NOT a body field\)\./,
    );
    // 2026-09-15 — the three SDK source paths left the customer page; the
    // header bullet points at the Verification section, which names each SDK
    // helper by its import name instead.
    expect(p).toMatch(
      /same header \(NOT a body field\)\. See \[Verification\]\(#verification\)\s*below\./,
    );
    expect(p).not.toMatch(/packages\/sdk-(?:typescript|go|python)\//);
    expect(p).toMatch(/from `@driftstack\/sdk`/);
    expect(p).toMatch(/`driftstack\.VerifyWebhookSignature`/);
    expect(p).toMatch(/`from driftstack import verify_webhook_signature`/);
  });

  it('CRITICAL X-Driftstack-Event-Id + X-Driftstack-Event-Type headers pinned (the canonical set webhook-worker sends alongside x-driftstack-signature). Drift to dropping would lose log-correlation + handler-routing utility.', () => {
    const p = read(EV);

    expect(p).toMatch(/`X-Driftstack-Event-Id: <uuid>` — duplicate of the top-level/);
    expect(p).toMatch(/`X-Driftstack-Event-Type: <event-type>` — the delivered event/);
  });

  it('CRITICAL retry-policy 6-attempt (initial + 5 retries) exponential backoff pinned — 1m + 5m + 15m + 30m + 60m (matches webhook-worker BACKOFF_MS_BY_ATTEMPT). The 5-step backoff schedule is the canonical retry contract; drift would mismatch V-273 + V-475 server-side.', () => {
    const p = read(EV);

    expect(p).toMatch(
      /Retry policy: 6 attempts \(the initial delivery plus 5 retries\) with\s*\n?exponential backoff at 1m, 5m, 15m, 30m, 60m\./,
    );
    expect(p).toMatch(/Final failures land in DLQ/);
  });

  it("CRITICAL idempotency-via-uuid framing pinned. The 'every delivery includes the same <uuid> id. Customers should dedup on this id — the same event may be re-delivered after a replay or DLQ requeue' wording is the load-bearing customer-handler-design guidance (2026-09-15: '(admin tooling)' left the page — replay is customer self-service).", () => {
    const p = read(EV);

    expect(p).toMatch(
      /Idempotency: every delivery includes the same `<uuid>` id\. Customers\s*\n?should dedup on this id — the same event may be re-delivered after a\s*\n?replay or DLQ requeue\./,
    );
  });

  it("CRITICAL test.ping bypasses-subscription-array framing pinned. The 'Fires REGARDLESS of subscription so customers can verify their handler signature-checks correctly without subscribing to it' wording matches W753 dashboard /webhooks sendTest + V-475.", () => {
    const p = read(EV);

    expect(p).toMatch(/Fires REGARDLESS of subscription so customers can verify/);
    expect(p).toMatch(/their handler signature-checks correctly without subscribing to it\./);
    expect(p).toMatch(/Customers cannot subscribe to `test\.ping` \(the API rejects it\)/);
  });

  // ─── webhooks/replay.md ───────────────────────────────────────

  it('CRITICAL replay.md frontmatter pinned.', () => {
    const p = read(RPL);

    expect(p).toMatch(
      /^---\nlayout: \.\.\/\.\.\/layouts\/DocLayout\.astro\ntitle: Replaying webhook deliveries\n/,
    );
    expect(p).toMatch(
      /description: Re-fire a failed or DLQ webhook delivery via \/v1\/webhook-deliveries\/:id\/replay\./,
    );
  });

  it("CRITICAL replay self-service framing pinned. The 'When your endpoint goes down for a brief outage and you fix it, you can re-fire any delivery yourself rather than emailing support' wording is the canonical customer-empowerment framing.", () => {
    const p = read(RPL);

    expect(p).toMatch(/Driftstack retries failed webhook deliveries 5 times with exponential/);
    expect(p).toMatch(/backoff before parking them in the DLQ\./);
    expect(p).toMatch(
      /When your endpoint goes down\s*\n?for a brief outage and you fix it, you can re-fire any delivery\s*\n?yourself rather than emailing support\./,
    );
  });

  it("CRITICAL POST /v1/webhook-deliveries/:deliveryId/replay endpoint pinned. The 'Resets the delivery to pending; Driftstack re-sends it within about a minute (up to 60 seconds)' wording — corrected 2026-08-15 to the poller's real 60s cadence, reworded 2026-09-15 without the worker/poll-cycle internals — matches W753 dashboard /webhooks replay action.", () => {
    const p = read(RPL);

    expect(p).toMatch(/`POST \/v1\/webhook-deliveries\/:deliveryId\/replay`/);
    expect(p).toMatch(
      /Resets the delivery to `pending`; Driftstack re-sends it within about a\s*\n?minute \(up to 60 seconds\)\./,
    );
  });

  it('CRITICAL wdl_-prefix + delivery-shape pinned — id/webhook_id/event_id/event_type/status/attempts/next_attempt_at. Drift would mismatch SDK consumer typings.', () => {
    const p = read(RPL);

    expect(p).toMatch(/"id": "wdl_00000000-0000-4000-8000-000000000001"/);
    expect(p).toMatch(/"webhook_id":/);
    expect(p).toMatch(/"event_id":/);
    expect(p).toMatch(/"event_type": "session\.completed"/);
    expect(p).toMatch(/"status": "pending"/);
    expect(p).toMatch(/"attempts": 0/);
  });

  it('CRITICAL 4-step typical-flow pinned — endpoint down at 10:00 + retries on backoff + ~2h-to-DLQ + fix at 13:00 + replay-each-DLQ. The numbered sequence matches the V-475 dashboard /webhooks delivery-log filter+replay UX.', () => {
    const p = read(RPL);

    expect(p).toMatch(/1\. Your endpoint goes down at 10:00 — Driftstack retries each delivery/);
    expect(p).toMatch(/~2 hours later the deliveries land in DLQ\s*\(`status: "dlq"`\)\./);
    expect(p).toMatch(/2\. You fix your endpoint at 13:00\./);
    expect(p).toMatch(
      /3\. List the DLQ deliveries:\s*\n?\s+`GET \/v1\/webhooks\/:webhookId\/deliveries\?status=dlq`/,
    );
    expect(p).toMatch(
      /4\. Replay each one: `POST \/v1\/webhook-deliveries\/:deliveryId\/replay`\./,
    );
  });

  it('CRITICAL 3-language SDK examples + lazy-iterate pattern pinned. TS iterateDeliveries + Python iterate_deliveries + Go ListDeliveries with DeliveryDLQ constant — the cross-language replay flow is the load-bearing SDK contract.', () => {
    const p = read(RPL);

    expect(p).toMatch(/await client\.webhooks\.listDeliveries\('whk_xxx', \{ status: 'dlq' \}\)/);
    expect(p).toMatch(
      /for await \(const delivery of client\.webhooks\.iterateDeliveries\('whk_xxx', \{ status: 'dlq' \}\)\)/,
    );
    expect(p).toMatch(/client\.webhooks\.iterate_deliveries\("whk_xxx", status="dlq"\)/);
    expect(p).toMatch(/client\.Webhooks\.ListDeliveries\(/);
    expect(p).toMatch(/Status: driftstack\.DeliveryDLQ/);
  });

  it("CRITICAL 404-not-403 existence-leak-prevention framing pinned. The '(We return 404 not 403 so the endpoint doesn\\'t leak the existence of other accounts\\' deliveries.)' wording matches W763 + W766 cross-account-no-existence-leak privacy contract.", () => {
    const p = read(RPL);

    expect(p).toMatch(
      /`404 Not Found` — the delivery id is unknown, or the delivery belongs\s*\n?\s+to an endpoint that isn't yours\. \(We return 404 not 403 so the\s*\n?\s+endpoint doesn't leak the existence of other accounts' deliveries\.\)/,
    );
  });

  it("CRITICAL audit-log webhook_delivery.replayed framing pinned. The 'Every customer-initiated replay records a webhook_delivery.replayed entry' wording matches W755 + W768 audit-log action catalog.", () => {
    const p = read(RPL);

    expect(p).toMatch(
      /Every customer-initiated replay records a `webhook_delivery\.replayed`\s*\n?entry in your account audit log/,
    );
    expect(p).toMatch(/`GET \/v1\/account\/audit-log\?action=webhook_delivery\.replayed`/);
    expect(p).toMatch(
      /The\s*\n?payload includes `endpoint_id` and `event_type` for cross-reference\./,
    );
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/docs-pages-webhooks-triplet-content-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
