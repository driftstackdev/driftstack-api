// W570.C — drift guard for /docs/api/webhook-events.md.
// V-203 webhook event catalog. Drift here either reorders the 3-state
// LIVE/DECLARED/PLANNED taxonomy, drops a [LIVE] event from the 3-event
// fired set (session.completed/failed + api_key.revoked), or unsets
// the Driftstack-Signature t=...,v1=... HMAC-SHA256 verification.
//
//   • V-203. Webhook event catalog.
//   • 3 [LIVE]: session.completed + session.failed + api_key.revoked.
//   • 2 [DECLARED]: quota.warning_80pct + quota.exceeded.
//   • 11 [PLANNED]: session.created/destroyed + profile.created/deleted
//     + api_key.minted + subscription.changed/cancelled +
//     trial_pack.purchased/expired + webhook_endpoint.created/deleted.
//   • Retry: 5 attempts, 1m/5m/15m/30m/60m backoff → DLQ.
//   • 10s timeout, plaintext secret returned ONCE on create.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/api/webhook-events.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W570.C /docs/api/webhook-events.md content parity', () => {
  const body = read(LIB);

  it('Header + V-203-source-of-truth + 3-state LIVE/DECLARED/PLANNED + 16-event quick-index framing pinned', () => {
    expect(body).toMatch(/^# Webhook events — catalog \+ payload shapes$/m);
    expect(body).toMatch(/V-203 — comprehensive reference for every webhook event type the/);
    expect(body).toMatch(/Driftstack control plane emits \(or will emit\)\./);
    expect(body).toMatch(/Source-of-truth for/);
    expect(body).toMatch(/the customer-facing `\/api\/webhook-events` docs page on the marketing/);
    expect(body).toMatch(/site \(when it lands as a Tier 3 visual surface\)\./);
    expect(body).toMatch(/> \*\*Status notation\*\*: events are tagged/);
    expect(body).toMatch(
      /> \[LIVE\] \(declared in the enum \+ fired by a service emitter today\),/,
    );
    expect(body).toMatch(
      /> \[DECLARED\] \(declared in the enum but no production emitter wired\),/,
    );
    expect(body).toMatch(/> \[PLANNED\] \(not yet in the enum; queued for V-NNN\)\./);
    expect(body).toMatch(/## Quick index/);
    expect(body).toMatch(
      /\| `session\.completed`\s+\| \[LIVE\]\s+\| Session is destroyed cleanly\s+\|/,
    );
    expect(body).toMatch(
      /\| `session\.failed`\s+\| \[LIVE\]\s+\| Session terminates in `errored` state\s+\|/,
    );
    expect(body).toMatch(
      /\| `api_key\.revoked`\s+\| \[LIVE\]\s+\| API key revoked \(customer or admin\)\s+\|/,
    );
    expect(body).toMatch(
      /\| `quota\.warning_80pct`\s+\| \[DECLARED\] \| Account hits 80% of tier quota\s+\|/,
    );
    expect(body).toMatch(
      /\| `quota\.exceeded`\s+\| \[DECLARED\] \| Account hits 100% of tier quota\s+\|/,
    );
    // Arc 5 EGRESS eg.7 — new DECLARED entry between the
    // quota.exceeded row and the [PLANNED] block.
    expect(body).toMatch(
      /\| `session\.egress_capability_changed` \| \[DECLARED\] \| Harness emitted an egress\.capability_report for a SOCKS5 session \|/,
    );
    expect(body).toMatch(
      /\| `session\.created`\s+\| \[PLANNED\]\s+\| Session transitions `creating` → `ready`\s+\|/,
    );
    expect(body).toMatch(
      /\| `session\.destroyed`\s+\| \[PLANNED\]\s+\| Distinct from `session\.completed` \(no semantic shift\)\s+\|/,
    );
    expect(body).toMatch(/\| `profile\.created`\s+\| \[PLANNED\]\s+\| New profile created\s+\|/);
    expect(body).toMatch(/\| `profile\.deleted`\s+\| \[PLANNED\]\s+\| Profile deleted\s+\|/);
    expect(body).toMatch(/\| `api_key\.minted`\s+\| \[PLANNED\]\s+\| New API key issued\s+\|/);
    expect(body).toMatch(
      /\| `subscription\.changed`\s+\| \[PLANNED\]\s+\| Tier changed via Stripe\s+\|/,
    );
    expect(body).toMatch(
      /\| `subscription\.cancelled`\s+\| \[PLANNED\]\s+\| Subscription cancelled\s+\|/,
    );
    expect(body).toMatch(
      /\| `trial_pack\.purchased`\s+\| \[PLANNED\]\s+\| \$2\.99 trial pack purchased\s+\|/,
    );
    expect(body).toMatch(
      /\| `trial_pack\.expired`\s+\| \[PLANNED\]\s+\| Trial pack expired \(14-day window closed\)\s+\|/,
    );
    expect(body).toMatch(
      /\| `webhook_endpoint\.created`\s+\| \[PLANNED\]\s+\| New webhook endpoint registered\s+\|/,
    );
    expect(body).toMatch(
      /\| `webhook_endpoint\.deleted`\s+\| \[PLANNED\]\s+\| Webhook endpoint deleted\s+\|/,
    );
  });

  it('Common envelope + 4-header (Content-Type + Signature + Event-Id + Delivery-Attempt) + retry policy + idempotency framing pinned', () => {
    expect(body).toMatch(/## Common envelope/);
    expect(body).toMatch(/Every webhook delivery is a `POST` to the customer's registered URL/);
    expect(body).toMatch(/with the following envelope:/);
    expect(body).toMatch(/"id": "evt_<uuid>",/);
    expect(body).toMatch(/"type": "<event-type>",/);
    expect(body).toMatch(/"account_id": "acc_<uuid>",/);
    expect(body).toMatch(/"emitted_at": "2026-05-05T12:34:56\.789Z",/);
    expect(body).toMatch(/"data": \{/);
    expect(body).toMatch(/- `Content-Type: application\/json`/);
    expect(body).toMatch(/- `Driftstack-Signature: t=<unix-seconds>,v1=<hex>` —/);
    expect(body).toMatch(/HMAC-SHA256\(`<emitted_at_seconds>\.<raw body>`\) keyed by the/);
    expect(body).toMatch(/endpoint signing secret\. Verification reference:/);
    expect(body).toMatch(/`packages\/sdk-typescript\/src\/webhook-signature\.ts` \(TS\),/);
    expect(body).toMatch(/`packages\/sdk-go\/webhook_signature\.go` \(Go\),/);
    expect(body).toMatch(/`packages\/sdk-python\/src\/driftstack\/webhook_signature\.py` \(Py\)\./);
    expect(body).toMatch(/- `Driftstack-Event-Id: evt_<uuid>` — duplicate of `data\.id`,/);
    expect(body).toMatch(/surfaces in HTTP logs without parsing the body\./);
    expect(body).toMatch(/- `Driftstack-Delivery-Attempt: <n>` — increments on each retry\./);
    expect(body).toMatch(/Retry policy: 5 attempts with exponential backoff at 1m, 5m, 15m,/);
    expect(body).toMatch(/30m, 60m\. Final failures land in DLQ/);
    expect(body).toMatch(/\(see `docs\/api\/webhooks\.md` and the admin \/webhook-dlq page\)\./);
    expect(body).toMatch(/Idempotency: every delivery includes the same `evt_<uuid>`\./);
    expect(body).toMatch(/Customers/);
    expect(body).toMatch(/should dedup on this id — the same event may be re-delivered after a/);
    expect(body).toMatch(/manual replay \(admin tooling\) or DLQ requeue\./);
  });

  it('3 LIVE event payload shapes + 2 DECLARED quota shapes + subscribing + verification + failure-modes framing pinned', () => {
    expect(body).toMatch(/### `session\.completed` \[LIVE\]/);
    expect(body).toMatch(/Fires when `DELETE \/v1\/sessions\/:id` lands on a session in a/);
    expect(body).toMatch(/non-terminal state\. The destroy path is idempotent; this event fires/);
    expect(body).toMatch(/exactly once per logical destroy\./);
    expect(body).toMatch(/"session_id": "ses_<uuid>",/);
    expect(body).toMatch(/"duration_ms": 245000/);
    expect(body).toMatch(/Emitter: `apps\/server\/src\/services\/sessions\.ts` `destroy\(\)`\./);
    expect(body).toMatch(/### `session\.failed` \[LIVE\]/);
    expect(body).toMatch(/Fires when a session transitions to `errored` \(driver failure,/);
    expect(body).toMatch(/unrecoverable error during navigate \/ interact \/ capture \/ etc\.\)\./);
    expect(body).toMatch(/The session's `destroyed_at` is set; subsequent ops on the session/);
    expect(body).toMatch(/return 410\./);
    expect(body).toMatch(/"duration_ms": 12300,/);
    expect(body).toMatch(/"operation": "navigate",/);
    expect(body).toMatch(/"error_name": "DriverTimeoutError",/);
    expect(body).toMatch(/"error_message": "Page load exceeded 30000ms"/);
    expect(body).toMatch(/Emitter: `runWithFailureCapture\(\)` in `services\/sessions\.ts`\./);
    expect(body).toMatch(/### `api_key\.revoked` \[LIVE\]/);
    expect(body).toMatch(/Fires whenever an API key is revoked, regardless of who initiated/);
    expect(body).toMatch(/the revocation \(account_owner via `DELETE \/v1\/api-keys\/:id` OR/);
    expect(body).toMatch(
      /driftstack_internal_admin via `POST \/v1\/admin\/api-keys\/:id\/revoke`\)\./,
    );
    expect(body).toMatch(/The revoking party is \*\*not\*\* carried in this event — refer to the/);
    expect(body).toMatch(/audit log for full provenance\./);
    expect(body).toMatch(/"api_key_id": "key_<uuid>",/);
    expect(body).toMatch(/"name": "production",/);
    expect(body).toMatch(/"revoked_at": "2026-05-05T12:34:56\.789Z"/);
    expect(body).toMatch(/Emitter: `apps\/server\/src\/services\/api-keys\.ts` `revoke\(\)`\./);
    expect(body).toMatch(/### `quota\.warning_80pct` \[DECLARED\]/);
    expect(body).toMatch(
      /\*\*Will\*\* fire when an account's metered usage hits 80% of the tier's/,
    );
    expect(body).toMatch(/quota\. Currently declared in the enum but not wired to a usage-/);
    expect(body).toMatch(/threshold check — see V-NNN follow-up\./);
    expect(body).toMatch(/"tier": "api_builder",/);
    expect(body).toMatch(/"metric": "session_minutes",/);
    expect(body).toMatch(/"used": 4000,/);
    expect(body).toMatch(/"limit": 5000,/);
    expect(body).toMatch(/"percentage": 80,/);
    expect(body).toMatch(/"period_start": "2026-05-01T00:00:00\.000Z",/);
    expect(body).toMatch(/"period_end": "2026-06-01T00:00:00\.000Z"/);
    expect(body).toMatch(/### `quota\.exceeded` \[DECLARED\]/);
    expect(body).toMatch(/\*\*Will\*\* fire when an account hits 100% of the tier quota\./);
    expect(body).toMatch(/"used": 5000,/);
    expect(body).toMatch(/"percentage": 100,/);
    expect(body).toMatch(/## Planned events \(not yet in enum\)/);
    expect(body).toMatch(/Adding a/);
    expect(body).toMatch(/new event type is a Class A schema migration \(additive enum value\)/);
    expect(body).toMatch(/plus an emitter in the relevant service plus an SDK type bump/);
    expect(body).toMatch(/across TS \/ Python \/ Go\./);
    expect(body).toMatch(/## Subscribing to events/);
    expect(body).toMatch(/Customers register webhook endpoints via/);
    expect(body).toMatch(/`POST \/v1\/webhooks \{ url, events: \[\.\.\.\], description\? \}`\./);
    expect(body).toMatch(/`events` array is a closed enum subset — the response 400s if any/);
    expect(body).toMatch(/unknown event type is supplied\./);
    expect(body).toMatch(/The plaintext signing secret is returned \*\*once\*\* in the create/);
    expect(body).toMatch(/response\. Store it server-side; the Driftstack API never returns it/);
    expect(body).toMatch(/again\. To rotate, delete \+ re-create the endpoint\./);
    expect(body).toMatch(/## Verification/);
    expect(body).toMatch(
      /- TS: `verifyWebhookSignature\(\{ secret, header, body, toleranceSec \}\)`/,
    );
    expect(body).toMatch(/in `packages\/sdk-typescript\/src\/webhook-signature\.ts`\./);
    expect(body).toMatch(
      /- Go: `VerifyWebhookSignature` in `packages\/sdk-go\/webhook_signature\.go`\./,
    );
    expect(body).toMatch(/- Python: `verify_webhook_signature` in/);
    expect(body).toMatch(/`packages\/sdk-python\/src\/driftstack\/webhook_signature\.py`\./);
    expect(body).toMatch(/All three follow the same Stripe-adjacent pattern: parse `t=` and/);
    expect(body).toMatch(
      /`v1=` from the header, recompute HMAC-SHA256\(`<t>\.<body>`\), constant-/,
    );
    expect(body).toMatch(/time compare\./);
    expect(body).toMatch(/## Failure modes/);
    expect(body).toMatch(/A delivery is considered "successful" only if your endpoint returns/);
    expect(body).toMatch(/HTTP 2xx within the 10s timeout\./);
    expect(body).toMatch(/After 5 failed attempts the delivery lands in DLQ\./);
    expect(body).toMatch(/DLQ deliveries/);
    expect(body).toMatch(/are visible in the admin panel/);
    expect(body).toMatch(/\(`admin\.driftstack\.dev\/webhook-dlq`\) — staff can manually requeue/);
    expect(body).toMatch(/them after investigating the failure\./);
    expect(body).toMatch(
      /The endpoint is \*\*not\*\* auto-disabled on consecutive failures today\./,
    );
    expect(body).toMatch(/Auto-disable after N consecutive failures is a planned safety net/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
