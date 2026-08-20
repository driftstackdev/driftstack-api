// W425.B (W662-deepened) — drift guard for packages/sdk-typescript/
// src/resources/webhooks.ts. V-307/V-351/V-356/V-359 webhooks TS parity.
//
// W662 splits the original 12 it() blocks into 19 focused per-concept
// blocks + pins previously-implicit invariants:
//
//   • Admin-scope-on-mutations invariant — pinned per-line on create
//     + update + rotateSecret + sendTest. Drift to allowing non-admin
//     keys to mutate would widen the privilege surface; the read-only
//     verbs (list / get / listDeliveries / iterateDeliveries) MUST
//     stay readable without admin so dashboards can render webhook
//     state for any team member.
//   • V-359 24h grace + dual-sign window pinned per-line: "previous
//     secret stays active for 24h (`grace_expires_at`)" + "Driftstack
//     dual-signs every outbound delivery (both the new + old HMAC)"
//     + "Roll the new secret across your verifier infra inside that
//     window". Drift to a different window OR dropping the dual-sign
//     claim would silently change rotation semantics customers
//     anchor their verifier-rollout timelines on.
//   • V-307 replayDelivery account-scoping framing — "the delivery
//     must belong to an endpoint the calling account owns". Drift to
//     dropping the framing would weaken the cross-tenant guard.
//   • V-307 path-anomaly: /v1/webhook-deliveries/:id/replay (NOT
//     under /v1/webhooks/...). Drift to nesting under /v1/webhooks
//     would force callers to know the parent endpoint id (which they
//     may not have if the delivery was looked up by id alone).
//   • V-356 sendTest 'test.ping' literal-type event_type response
//     field — drift to widening to `string` would lose compile-time
//     enforcement that the synthetic event NEVER claims a real
//     event_type from the customer's subscription.
//   • V-356 sendTest bypasses-subscription invariant pinned —
//     drift would require pre-subscribing to test.ping which would
//     break first-time-setup verification.
//   • V-351 update 3 stacked invariants: at-least-one-of (url/
//     events/description/active) + signing-NOT-rotated + 409-on-
//     disabled. All pinned per-line.
//   • V-118 iterateDeliveries cursor walker + status filter
//     re-threaded per page.
//   • Show-ONCE invariant on create (plaintext signing secret) +
//     rotateSecret (fresh plaintext).
//   • Soft-delete idempotent invariant on delete.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/webhooks.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W425.B packages/sdk-typescript/src/resources/webhooks.ts content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path + module header anchor on the resource line', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(/\/\/ WebhooksResource — typed methods for \/v1\/webhooks\./);
  });

  it("Imports — 8 api-types shapes (sorted alphabetical block) covering every verb's wire shape + HttpClient + iteratePaginated. CRITICAL: 8-shape import surface — drift to hand-rolling any of these types would diverge from @driftstack/api-types Zod single-source-of-truth.", () => {
    expect(body).toMatch(
      /import type \{\s*\n?\s*CreateWebhookRequest,\s*\n?\s*CreateWebhookResponse,\s*\n?\s*ListDeliveriesQueryInput,\s*\n?\s*RotateWebhookSecretResponse,\s*\n?\s*UpdateWebhookRequest,\s*\n?\s*WebhookDelivery,\s*\n?\s*WebhookDeliveryStatus,\s*\n?\s*WebhookEndpoint,\s*\n?\s*\} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(/import type \{ HttpClient \} from '\.\.\/http\.js';/);
    expect(body).toMatch(/import \{ iteratePaginated \} from '\.\.\/pagination\.js';/);
  });

  it('WebhookEndpointList envelope — 1-field (data: WebhookEndpoint[]) NO pagination. Endpoints are a small per-account finite set so list-all-once is sound; drift to adding pagination would silently change the contract.', () => {
    expect(body).toMatch(
      /export interface WebhookEndpointList \{\s*\n?\s*data: WebhookEndpoint\[\];\s*\n?\s*\}/,
    );
  });

  it('WebhookDeliveryListPage envelope — 3-field cursor pagination (data + has_more + next_cursor: string | null). Deliveries are unbounded per endpoint so cursor pagination is load-bearing.', () => {
    expect(body).toMatch(
      /export interface WebhookDeliveryListPage \{\s*\n?\s*data: WebhookDelivery\[\];\s*\n?\s*has_more: boolean;\s*\n?\s*next_cursor: string \| null;\s*\n?\s*\}/,
    );
  });

  it('WebhooksResource class declaration + private-readonly http constructor field.', () => {
    expect(body).toMatch(/^export class WebhooksResource \{$/m);
    expect(body).toMatch(/constructor\(private readonly http: HttpClient\) \{\}/);
  });

  it('create verb — POST /v1/webhooks. CRITICAL: "Plaintext signing secret is returned once; store it now — it cannot be retrieved later." + "Requires the `account_owner` scope on the calling key." Two load-bearing invariants — plaintext-once + admin-scope. Drift to dropping admin-scope would let any key create new endpoints (privilege escalation).', () => {
    expect(body).toMatch(
      /\*\s*Create a webhook subscription\. Plaintext signing secret is returned\s*\n?\s*\*\s*once; store it now — it cannot be retrieved later\. Requires the\s*\n?\s*\*\s*`account_owner` scope on the calling key\./,
    );
    expect(body).toMatch(
      /create\(body: CreateWebhookRequest\): Promise<CreateWebhookResponse> \{\s*\n?\s*return this\.http\.request<CreateWebhookResponse>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: '\/v1\/webhooks',\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('list verb — GET /v1/webhooks → WebhookEndpointList. CRITICAL: "Plaintext is never returned" — drift to including plaintext on list would leak ALL signing secrets on every list call. NO admin-scope requirement (read-only verb).', () => {
    expect(body).toMatch(
      /\/\*\* List webhook endpoints for the EFFECTIVE account — your own, or the owner\s*\n?\s*\*\s*you are acting as via `X-Driftstack-Account`\. Plaintext is never returned\./,
    );
    expect(body).toMatch(
      /list\(\): Promise<WebhookEndpointList> \{\s*\n?\s*return this\.http\.request<WebhookEndpointList>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: '\/v1\/webhooks',\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('get verb — GET /v1/webhooks/${encodeURIComponent(id)} → WebhookEndpoint. encodeURIComponent wrapping prevents "abc/../../admin" path traversal. NO admin-scope requirement.', () => {
    expect(body).toMatch(/\/\*\* Get a single webhook endpoint\. \*\//);
    expect(body).toMatch(
      /get\(id: string\): Promise<WebhookEndpoint> \{\s*\n?\s*return this\.http\.request<WebhookEndpoint>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: `\/v1\/webhooks\/\$\{encodeURIComponent\(id\)\}`,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('delete verb — DELETE /v1/webhooks/${encodeURIComponent(id)} → Promise<void>. CRITICAL "Disable (soft-delete) a webhook endpoint. Idempotent." — drift to hard-delete would lose audit-log linkage retroactively; drift to non-idempotent would break the standard cleanup-in-finally pattern.', () => {
    expect(body).toMatch(/\/\*\* Disable \(soft-delete\) a webhook endpoint\. Idempotent\. \*\//);
    expect(body).toMatch(
      /delete\(id: string\): Promise<void> \{\s*\n?\s*return this\.http\.request<void>\(\{\s*\n?\s*method: 'DELETE',\s*\n?\s*path: `\/v1\/webhooks\/\$\{encodeURIComponent\(id\)\}`,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('V-351 update verb — PATCH /v1/webhooks/${encodeURIComponent(id)}. CRITICAL 3 stacked invariants pinned per-line: (1) "At least one of `url`, `events`, `description`, or `active` must be present" (drift to allowing zero fields lets no-op PATCH succeed silently). (2) "The signing secret is NOT rotated by update; use `rotateSecret` for that" (drift to rotating-on-update would force rotation on every UI tweak). (3) "Disabled endpoints cannot be updated (returns 409)" (after soft-delete the endpoint is read-only). + admin-scope requirement.', () => {
    expect(body).toMatch(
      /\*\s*V-351 — partial-update a webhook endpoint\. At least one of `url`,\s*\n?\s*\*\s*`events`, `description`, or `active` must be present\. The\s*\n?\s*\*\s*signing secret is NOT rotated by update; use `rotateSecret` for\s*\n?\s*\*\s*that\. Disabled endpoints cannot be updated \(returns 409\)\.\s*\n?\s*\*\s*Requires the `account_owner` scope on the calling key\./,
    );
    expect(body).toMatch(
      /update\(id: string, body: UpdateWebhookRequest\): Promise<WebhookEndpoint> \{\s*\n?\s*return this\.http\.request<WebhookEndpoint>\(\{\s*\n?\s*method: 'PATCH',\s*\n?\s*path: `\/v1\/webhooks\/\$\{encodeURIComponent\(id\)\}`,\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('listDeliveries verb — GET /v1/webhooks/${encodeURIComponent(id)}/deliveries with 3-param query (limit + cursor + status). Status filter takes WebhookDeliveryStatus enum value (e.g. "dlq"). Conditional-spread pattern on all 3 — drift to `?? defaults` would client-side-default. Type intersection: ListDeliveriesQueryInput & { status?: WebhookDeliveryStatus } combines base pagination with the deliveries-specific status filter.', () => {
    expect(body).toMatch(
      /\/\*\* Paginated delivery log for a webhook endpoint\. Filter by status \(e\.g\. `'dlq'`\)\. \*\//,
    );
    expect(body).toMatch(
      /listDeliveries\(\s*\n?\s*id: string,\s*\n?\s*query: ListDeliveriesQueryInput & \{ status\?: WebhookDeliveryStatus \} = \{\},\s*\n?\s*\): Promise<WebhookDeliveryListPage> \{\s*\n?\s*return this\.http\.request<WebhookDeliveryListPage>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: `\/v1\/webhooks\/\$\{encodeURIComponent\(id\)\}\/deliveries`,\s*\n?\s*query: \{\s*\n?\s*\.\.\.\(query\.limit !== undefined \? \{ limit: query\.limit \} : \{\}\),\s*\n?\s*\.\.\.\(query\.cursor !== undefined \? \{ cursor: query\.cursor \} : \{\}\),\s*\n?\s*\.\.\.\(query\.status !== undefined \? \{ status: query\.status \} : \{\}\),\s*\n?\s*\},\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it("V-118 iterateDeliveries verb — AsyncGenerator<WebhookDelivery, void, void> via iteratePaginated. CRITICAL: status filter walks ONE bucket — example given: `{ status: 'dlq' }` to enumerate the DLQ for replay tooling. The status + limit filters are RE-THREADED per page (drift to dropping the re-threading would broaden iteration mid-walk and leak deliveries from other buckets). cursor !== null guard correctly omits cursor on the first page.", () => {
    expect(body).toMatch(
      /\*\s*Lazily iterate every delivery for a webhook endpoint, walking cursor\s*\n?\s*\*\s*pages automatically\. Filter by status to walk just one bucket\s*\n?\s*\*\s*\(e\.g\. `\{ status: 'dlq' \}` to enumerate the DLQ for replay tooling\)\./,
    );
    expect(body).toMatch(
      /iterateDeliveries\(\s*\n?\s*id: string,\s*\n?\s*opts: \{ limit\?: number; status\?: WebhookDeliveryStatus \} = \{\},\s*\n?\s*\): AsyncGenerator<WebhookDelivery, void, void> \{\s*\n?\s*return iteratePaginated<WebhookDelivery>\(\(cursor\) =>\s*\n?\s*this\.listDeliveries\(id, \{\s*\n?\s*\.\.\.\(opts\.limit !== undefined \? \{ limit: opts\.limit \} : \{\}\),\s*\n?\s*\.\.\.\(opts\.status !== undefined \? \{ status: opts\.status \} : \{\}\),\s*\n?\s*\.\.\.\(cursor !== null \? \{ cursor \} : \{\}\),\s*\n?\s*\}\),\s*\n?\s*\);\s*\n?\s*\}/,
    );
  });

  it('V-307 replayDelivery verb — POST /v1/webhook-deliveries/${encodeURIComponent(deliveryId)}/replay (NOT under /v1/webhooks/...). CRITICAL: path-anomaly is deliberate — callers can replay a delivery by id ALONE without knowing the parent endpoint id (e.g. when a delivery_id was logged in customer infra and they want to replay it). + account-scoping framing: "the delivery must belong to an endpoint the calling account owns" — load-bearing cross-tenant guard.', () => {
    // V-1122 — asserted in pieces: the chained form ran from the V-307
    // anchor through the scope sentence, so correcting the scope broke a
    // pin about the verb.
    expect(body).toMatch(/\*\s*V-307 — replay a webhook delivery\. Resets the delivery to pending/);
    expect(body).toMatch(/Scoped to the EFFECTIVE account: the delivery/);
    expect(body, 'the calling-account claim must not return').not.toMatch(
      /an endpoint the calling account owns/,
    );
    expect(body).toMatch(
      /replayDelivery\(deliveryId: string\): Promise<WebhookDelivery> \{\s*\n?\s*return this\.http\.request<WebhookDelivery>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: `\/v1\/webhook-deliveries\/\$\{encodeURIComponent\(deliveryId\)\}\/replay`,\s*\n?\s*body: \{\},\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('CRITICAL V-359 rotateSecret verb — POST /v1/webhooks/${encodeURIComponent(id)}/rotate-secret. 6-line grace-window claim pinned per-line: fresh plaintext ONCE + 24h via grace_expires_at + Driftstack DUAL-SIGNS every outbound delivery (both new + old HMAC) + customer rolls verifier infra inside the window + admin-scope. Drift to a different window OR dropping dual-sign would silently change rotation semantics customers anchor their verifier-rollout timelines on.', () => {
    expect(body).toMatch(
      /\*\s*V-359 — rotate the webhook signing secret\. The fresh plaintext is\s*\n?\s*\*\s*returned ONCE\. The previous secret stays active for 24h\s*\n?\s*\*\s*\(`grace_expires_at`\) during which Driftstack dual-signs every\s*\n?\s*\*\s*outbound delivery \(both the new \+ old HMAC\)\. Roll the new secret\s*\n?\s*\*\s*across your verifier infra inside that window\. Requires the\s*\n?\s*\*\s*`account_owner` scope on the calling key\./,
    );
    expect(body).toMatch(
      /rotateSecret\(id: string\): Promise<RotateWebhookSecretResponse> \{\s*\n?\s*return this\.http\.request<RotateWebhookSecretResponse>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: `\/v1\/webhooks\/\$\{encodeURIComponent\(id\)\}\/rotate-secret`,\s*\n?\s*body: \{\},\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it("V-356 sendTest verb — POST /v1/webhooks/${encodeURIComponent(id)}/test. CRITICAL: \"Bypasses subscription (the endpoint receives it regardless of which event types it's subscribed to)\" — drift to requiring test.ping in the subscription would break first-time-setup verification (chicken-and-egg). Response carries 3-field shape with `event_type: 'test.ping'` as TS LITERAL type (not `string`) — drift to widening would lose compile-time enforcement that the synthetic event NEVER claims a real event_type from the customer's subscription.", () => {
    expect(body).toMatch(
      /\*\s*V-356 — send a synthetic `test\.ping` event to the endpoint\.\s*\n?\s*\*\s*Bypasses subscription \(the endpoint receives it regardless of\s*\n?\s*\*\s*which event types it's subscribed to\), so customers can verify\s*\n?\s*\*\s*their handler is reachable \+ signature-valid before depending on\s*\n?\s*\*\s*it for real events\. Returns 202 \+ the synthetic delivery id\.\s*\n?\s*\*\s*Requires the `account_owner` scope on the calling key\./,
    );
    expect(body).toMatch(
      /sendTest\(id: string\): Promise<\{\s*\n?\s*delivery_id: string;\s*\n?\s*event_id: string;\s*\n?\s*event_type: 'test\.ping';\s*\n?\s*\}> \{/,
    );
    expect(body).toMatch(/path: `\/v1\/webhooks\/\$\{encodeURIComponent\(id\)\}\/test`,/);
  });

  it('admin-scope-on-mutations invariant pinned across EXACTLY 4 verbs (create + update + rotateSecret + sendTest). Read-only verbs (list + get + listDeliveries + iterateDeliveries) MUST NOT carry the admin requirement so dashboards can render webhook state for any team member. delete is interestingly NOT in the admin list — soft-delete is allowed without admin (the calling key still must own the endpoint, but no admin-scope check).', () => {
    // The "Requires the `account_owner` scope on the calling key" framing
    // wraps across lines in 2 of the 4 JSDocs, so allow optional
    // newline+`* ` between "the" and "`admin`".
    const adminMatches =
      body.match(/Requires the(?:\s|\s*\n\s*\*\s*)`account_owner` scope on the calling key/g) ?? [];
    expect(
      adminMatches.length,
      'expected admin-scope on exactly 4 verbs (create + update + rotateSecret + sendTest)',
    ).toBe(4);
  });

  it('Plaintext-shown-ONCE invariant — both secret-emitting verbs MUST carry the warning. Drift to dropping in either would lose the customer-facing warning that the secret cannot be re-read. The wording wraps across lines in the JSDoc, so a permissive regex catches both forms (`returned once` on create with `*` continuation; `returned ONCE` on rotateSecret).', () => {
    // Allow newline+`* ` wrap between "returned" and "once" or "ONCE".
    const matches = body.match(/returned(?:\s|\s*\n\s*\*\s*)(?:once|ONCE)/g) ?? [];
    expect(matches.length, 'expected 2 plaintext-once mentions (create + rotateSecret)').toBe(2);
  });

  it('encodeURIComponent invariant — webhook id appears in 6 direct call sites (get + delete + update + listDeliveries + rotateSecret + sendTest). iterateDeliveries delegates via this.listDeliveries(id, ...) so the escape happens transitively, not directly. + 1 deliveryId wrapping on replayDelivery. Drift to dropping any escape would let path-traversal via maliciously-crafted ids.', () => {
    const idMatches = body.match(/encodeURIComponent\(id\)/g) ?? [];
    expect(idMatches.length, 'expected encodeURIComponent(id) 6 times').toBe(6);
    const deliveryIdMatches = body.match(/encodeURIComponent\(deliveryId\)/g) ?? [];
    expect(deliveryIdMatches.length, 'expected encodeURIComponent(deliveryId) 1 time').toBe(1);
  });

  it("10-verb inventory + verb-mix invariants — exactly 10 method declarations (create + list + get + delete + update + listDeliveries + iterateDeliveries + replayDelivery + rotateSecret + sendTest). Verb mix: 4 POSTs (create + replayDelivery + rotateSecret + sendTest) + 3 GETs (list + get + listDeliveries) + 1 PATCH (update) + 1 DELETE (delete) = 9 method-level verbs (iterateDeliveries doesn't make its own wire call, it delegates to listDeliveries). Drift to a single-HTTP-call iterate would silently change the cursor walking pattern.", () => {
    const methods = body.match(/^ {2}(?!constructor)[a-zA-Z]+\(/gm) ?? [];
    expect(methods.length, 'expected 10 verb declarations').toBe(10);
    const posts = (body.match(/method: 'POST'/g) ?? []).length;
    expect(posts, 'expected 4 POSTs').toBe(4);
    const gets = (body.match(/method: 'GET'/g) ?? []).length;
    expect(gets, 'expected 3 GETs').toBe(3);
    const patches = (body.match(/method: 'PATCH'/g) ?? []).length;
    expect(patches, 'expected 1 PATCH (update)').toBe(1);
    const deletes = (body.match(/method: 'DELETE'/g) ?? []).length;
    expect(deletes, 'expected 1 DELETE (delete)').toBe(1);
    expect(body).not.toMatch(/method: 'PUT'/);
  });
});
