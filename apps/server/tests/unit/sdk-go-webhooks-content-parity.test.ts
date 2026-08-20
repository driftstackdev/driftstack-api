// W593.A (W628-deepened) — drift guard for packages/sdk-go/webhooks.go.
// The original W593.A test pinned the 10-verb surface in a single
// monster it() block. W628 splits it into per-verb focused blocks +
// adds pins for previously-implicit invariants:
//
//   • HTTP-method correctness per verb (POST/GET/DELETE/PATCH).
//   • RotateSecret 24h dual-sign grace window (load-bearing for
//     customer secret-rotation playbooks — drift here would break
//     the "roll the new secret across your verifier infra inside
//     the 24h window" contract).
//   • Update partial-update 400-on-empty + 409-on-disabled rules.
//   • SendTest "always test.ping" event-type invariant.
//   • ListDeliveries 3-param query (limit / cursor / status) with
//     conditional setting on non-zero values.
//   • ReplayDelivery account-scoping (delivery must belong to an
//     endpoint the calling account owns).
//   • RotateWebhookSecretResponse 5-field struct shape pinned with
//     exact json tags so a Go SDK regen can't silently drop a
//     field that the customer-side verifier depends on.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-go/webhooks.go');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W593.A packages/sdk-go/webhooks.go content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path + WebhooksResource binds /v1/webhooks', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(/\/\/ WebhooksResource handles \/v1\/webhooks\./);
    expect(body).toMatch(/type WebhooksResource struct \{\s*\n\s*client \*Client\s*\n\}/);
  });

  it('Create — POST /v1/webhooks + plaintext-secret-returned-ONCE invariant + admin-scope requirement pinned (drift here would silently weaken the secret-disclosure contract customers rely on for verifier infra)', () => {
    expect(body).toMatch(
      /\/\/ Create a webhook subscription\. Plaintext signing secret is returned/,
    );
    expect(body).toMatch(/\/\/ ONCE in CreateWebhookResponse\.Secret — store it immediately\./);
    expect(body).toMatch(/\/\/ Requires the account_owner scope\./);
    expect(body).toMatch(
      /func \(r \*WebhooksResource\) Create\(ctx context\.Context, body \*CreateWebhookRequest\) \(\*CreateWebhookResponse, error\)/,
    );
    expect(body).toMatch(/method: "POST",\s*\n\s*path:\s+"\/v1\/webhooks",/);
  });

  it('List — GET /v1/webhooks, account-scoped (current account only) pinned', () => {
    expect(body).toMatch(/\/\/ List webhook endpoints for the current account\./);
    expect(body).toMatch(
      /func \(r \*WebhooksResource\) List\(ctx context\.Context\) \(\*WebhookEndpointList, error\)/,
    );
    expect(body).toMatch(/method: "GET",\s*\n\s*path:\s+"\/v1\/webhooks",/);
  });

  it('Get — GET /v1/webhooks/{id} + PathEscape on webhookID (escapes user-controlled id segment so we never produce a malformed URL with embedded slashes)', () => {
    expect(body).toMatch(/\/\/ Get a single webhook endpoint by id\./);
    expect(body).toMatch(
      /func \(r \*WebhooksResource\) Get\(ctx context\.Context, webhookID string\) \(\*WebhookEndpoint, error\)/,
    );
    expect(body).toMatch(
      /method: "GET",\s*\n\s*path:\s+"\/v1\/webhooks\/" \+ url\.PathEscape\(webhookID\),/,
    );
  });

  it('Delete — DELETE /v1/webhooks/{id}, soft-delete (disables endpoint) + idempotent + returns plain error (no body) pinned', () => {
    expect(body).toMatch(/\/\/ Delete soft-deletes \(disables\) the endpoint\. Idempotent\./);
    expect(body).toMatch(
      /func \(r \*WebhooksResource\) Delete\(ctx context\.Context, webhookID string\) error/,
    );
    expect(body).toMatch(
      /method: "DELETE",\s*\n\s*path:\s+"\/v1\/webhooks\/" \+ url\.PathEscape\(webhookID\),/,
    );
  });

  it('ListDeliveries — GET /v1/webhooks/{id}/deliveries + 3-param ListDeliveriesQuery (limit / cursor / status) with conditional setting on non-zero values (zero-value Go semantics: a Limit of 0 or empty Cursor/Status is treated as "unset" and not sent to the server)', () => {
    expect(body).toMatch(/\/\/ ListDeliveries returns a page of delivery rows for an endpoint\./);
    expect(body).toMatch(
      /func \(r \*WebhooksResource\) ListDeliveries\(ctx context\.Context, webhookID string, query \*ListDeliveriesQuery\) \(\*WebhookDeliveryListPage, error\)/,
    );
    // Conditional setting: 3 if-blocks guarding limit / cursor / status.
    expect(body).toMatch(
      /if query\.Limit > 0 \{\s*\n\s*q\.Set\("limit", strconv\.Itoa\(query\.Limit\)\)\s*\n\s*\}/,
    );
    expect(body).toMatch(
      /if query\.Cursor != "" \{\s*\n\s*q\.Set\("cursor", query\.Cursor\)\s*\n\s*\}/,
    );
    expect(body).toMatch(
      /if query\.Status != "" \{\s*\n\s*q\.Set\("status", string\(query\.Status\)\)\s*\n\s*\}/,
    );
    expect(body).toMatch(
      /path:\s+"\/v1\/webhooks\/" \+ url\.PathEscape\(webhookID\) \+ "\/deliveries",/,
    );
  });

  it('IterateDeliveries — cursor-walking variant of ListDeliveries (cross-SDK parity with TS iterateDeliveries + Python iterate_deliveries). callback returns false to stop early; Limit + Status thread through every page; Cursor managed internally. Drift to dropping this method would leave Go customers unable to walk every delivery the way the other two SDKs do.', () => {
    expect(body).toMatch(
      /\/\/ IterateDeliveries yields every delivery for an endpoint across cursor/,
    );
    expect(body).toMatch(
      /func \(r \*WebhooksResource\) IterateDeliveries\(ctx context\.Context, webhookID string, query \*ListDeliveriesQuery, fn func\(\*WebhookDelivery\) \(bool, error\)\) error/,
    );
    // Threads Limit + Status into the per-page ListDeliveries call + uses
    // the shared advanceCursor guard (no inline cursor-equality loop).
    expect(body).toMatch(
      /r\.ListDeliveries\(ctx, webhookID, &ListDeliveriesQuery\{Limit: limit, Cursor: cursor, Status: status\}\)/,
    );
    expect(body).toMatch(/next, done, err := advanceCursor\(cursor, page\.NextCursor\)/);
  });

  it('ReplayDelivery — V-307 POST /v1/webhook-deliveries/{deliveryID}/replay with empty struct body + account-scope enforcement framing ("delivery must belong to an endpoint the calling account owns") pinned (drift to dropping the account-scope comment would lose the contract context customers reason about; the server-side enforcement is the actual guard but the SDK comment is the customer-facing contract)', () => {
    expect(body).toMatch(
      /\/\/ ReplayDelivery is V-307 — resets a webhook delivery to pending so the/,
    );
    expect(body).toMatch(
      /\/\/ worker re-fires it\. Scoped to the EFFECTIVE account: the delivery must/,
    );
    // V-1122 — the replay is scoped to the EFFECTIVE account: the route
    // resolves effectiveAccountIdForWrite, so a team admin replays the
    // owner's delivery. Six surfaces said "the calling account".
    expect(body).toMatch(
      /\/\/ belong to an endpoint the caller's own account owns, or one owned by the/,
    );
    expect(body, 'the calling-account claim must not return').not.toMatch(
      /\/\/ endpoint the calling account owns\./,
    );
    expect(body).toMatch(
      /func \(r \*WebhooksResource\) ReplayDelivery\(ctx context\.Context, deliveryID string\) \(\*WebhookDelivery, error\)/,
    );
    expect(body).toMatch(
      /method: "POST",\s*\n\s*path:\s+"\/v1\/webhook-deliveries\/" \+ url\.PathEscape\(deliveryID\) \+ "\/replay",\s*\n\s*body:\s+struct\{\}\{\},/,
    );
  });

  it("RotateWebhookSecretResponse — V-359 5-field struct shape pinned: ID + Secret (plaintext-once) + SecretPrefix + PrevSecretPrefix + GraceExpiresAt (time.Time). Each json tag locked so a Go-SDK regen can't silently drop a field customer verifiers depend on for the dual-sign rollout window.", () => {
    expect(body).toMatch(/\/\/ RotateWebhookSecretResponse — V-359 secret rotation result\./);
    expect(body).toMatch(/\/\/ fresh plaintext is in Secret \(returned ONCE\); during the/);
    expect(body).toMatch(
      /\/\/ GraceExpiresAt window Driftstack dual-signs every outbound delivery/,
    );
    expect(body).toMatch(/\/\/ with both the new \+ previous secret\./);
    expect(body).toMatch(
      /^type RotateWebhookSecretResponse struct \{\s*\n\s*ID\s+string\s+`json:"id"`\s*\n\s*Secret\s+string\s+`json:"secret"`\s*\n\s*SecretPrefix\s+string\s+`json:"secret_prefix"`\s*\n\s*PrevSecretPrefix string\s+`json:"prev_secret_prefix"`\s*\n\s*GraceExpiresAt\s+time\.Time `json:"grace_expires_at"`\s*\n\}/m,
    );
  });

  it('RotateSecret — V-359 POST /v1/webhooks/{id}/rotate-secret + 24h dual-sign grace-window invariant ("The previous secret stays active for 24h (GraceExpiresAt) during which Driftstack dual-signs every outbound delivery") + admin-scope on calling key. Drift here would break the customer-facing "roll the new secret across your verifier infra inside that window" contract.', () => {
    expect(body).toMatch(
      /\/\/ RotateSecret is V-359 — rotate the webhook signing secret\. The fresh/,
    );
    expect(body).toMatch(
      /\/\/ plaintext is returned ONCE\. The previous secret stays active for 24h/,
    );
    expect(body).toMatch(
      /\/\/ \(GraceExpiresAt\) during which Driftstack dual-signs every outbound/,
    );
    expect(body).toMatch(
      /\/\/ delivery\. Roll the new secret across your verifier infra inside that/,
    );
    expect(body).toMatch(/\/\/ window\. Requires the account_owner scope on the calling key\./);
    expect(body).toMatch(
      /func \(r \*WebhooksResource\) RotateSecret\(ctx context\.Context, webhookID string\) \(\*RotateWebhookSecretResponse, error\)/,
    );
    expect(body).toMatch(
      /method: "POST",\s*\n\s*path:\s+"\/v1\/webhooks\/" \+ url\.PathEscape\(webhookID\) \+ "\/rotate-secret",\s*\n\s*body:\s+struct\{\}\{\},/,
    );
  });

  it('SendTestWebhookResponse + SendTest — V-356 POST /v1/webhooks/{id}/test, synthetic test.ping delivery + bypasses subscription (endpoint receives the event regardless of which event types it is subscribed to) + "always test.ping" event-type invariant + returns 202 + admin-scope. Drift here would break customer first-time-setup smoke-tests of their handler+signature verification.', () => {
    expect(body).toMatch(/\/\/ SendTestWebhookResponse — V-356 synthetic test\.ping delivery/);
    expect(body).toMatch(
      /\/\/ receipt\. The endpoint receives the event regardless of which event/,
    );
    expect(body).toMatch(/\/\/ types it's subscribed to\./);
    expect(body).toMatch(
      /^type SendTestWebhookResponse struct \{\s*\n\s*DeliveryID string `json:"delivery_id"`\s*\n\s*EventID\s+string `json:"event_id"`\s*\n\s*EventType\s+string `json:"event_type"` \/\/ always "test\.ping"\s*\n\}/m,
    );
    expect(body).toMatch(/\/\/ SendTest is V-356 — send a synthetic test\.ping event to the/);
    expect(body).toMatch(/\/\/ endpoint\. Bypasses subscription so customers can verify their/);
    expect(body).toMatch(/\/\/ handler is reachable \+ signature-valid before depending on it for/);
    expect(body).toMatch(/\/\/ real events\. Returns 202 \+ the synthetic delivery id\./);
    expect(body).toMatch(
      /func \(r \*WebhooksResource\) SendTest\(ctx context\.Context, webhookID string\) \(\*SendTestWebhookResponse, error\)/,
    );
    expect(body).toMatch(
      /method: "POST",\s*\n\s*path:\s+"\/v1\/webhooks\/" \+ url\.PathEscape\(webhookID\) \+ "\/test",\s*\n\s*body:\s+struct\{\}\{\},/,
    );
  });

  it('Update — V-351 PATCH /v1/webhooks/{id} partial update + at-least-one-of-URL/Events/Description/Active 400 invariant + signing-secret-NOT-rotated-by-Update separation-of-concerns + disabled-endpoint-409 invariant + admin-scope. Drift here would break the "use RotateSecret for that" contract that keeps the secret-rotation flow auditable and explicit.', () => {
    expect(body).toMatch(/\/\/ Update is V-351 — partial-update a webhook endpoint\. At least one/);
    expect(body).toMatch(
      /\/\/ of URL \/ Events \/ Description \/ Active must be non-nil; otherwise/,
    );
    expect(body).toMatch(/\/\/ the server returns 400\. The signing secret is NOT rotated by/);
    expect(body).toMatch(/\/\/ Update; use RotateSecret for that\. Disabled endpoints can't be/);
    expect(body).toMatch(
      /\/\/ updated \(returns 409\)\. Requires the account_owner scope on the calling key\./,
    );
    expect(body).toMatch(
      /func \(r \*WebhooksResource\) Update\(ctx context\.Context, webhookID string, body \*UpdateWebhookRequest\) \(\*WebhookEndpoint, error\)/,
    );
    expect(body).toMatch(
      /method: "PATCH",\s*\n\s*path:\s+"\/v1\/webhooks\/" \+ url\.PathEscape\(webhookID\),/,
    );
  });
});
