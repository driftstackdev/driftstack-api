// W425.B — drift guard for packages/sdk-typescript/src/resources/webhooks.ts.
// WebhooksResource — admin-scope subscription management +
// V-307 replay + V-359 rotate-secret + V-356 send-test +
// V-118 iterateDeliveries. Drift here breaks the admin-only
// subscription lifecycle or strips the rotate-secret/replay
// recovery paths customers rely on.
//
//   • Framing pinned: typed methods for /v1/webhooks.
//   • WebhookEndpointList (data[]) + WebhookDeliveryListPage
//     (data[] + has_more + next_cursor).
//   • Admin-scope rationale on create / update / rotateSecret /
//     sendTest.
//   • V-118 iterateDeliveries with status filter for DLQ replay.
//   • V-307 replayDelivery via /v1/webhook-deliveries/:id/replay.
//   • V-359 rotateSecret returns plaintext ONCE; 24h grace via
//     grace_expires_at; dual-sign window.
//   • V-356 sendTest synthetic `test.ping`.

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

  it('Framing pinned: typed methods for /v1/webhooks', () => {
    expect(body).toMatch(/\/\/ WebhooksResource — typed methods for \/v1\/webhooks\./);
  });

  it('WebhookEndpointList: data: WebhookEndpoint[]; WebhookDeliveryListPage: data + has_more + next_cursor string|null', () => {
    expect(body).toMatch(
      /export interface WebhookEndpointList \{\s*\n?\s*data: WebhookEndpoint\[\];\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /export interface WebhookDeliveryListPage \{\s*\n?\s*data: WebhookDelivery\[\];\s*\n?\s*has_more: boolean;\s*\n?\s*next_cursor: string \| null;\s*\n?\s*\}/,
    );
  });

  it("create(body): POST /v1/webhooks; plaintext signing secret returned once (store-now-or-lose-it); requires 'admin' scope", () => {
    expect(body).toMatch(
      /\*\s*Create a webhook subscription\. Plaintext signing secret is returned\s*\n?\s*\*\s*once; store it now — it cannot be retrieved later\. Requires the\s*\n?\s*\*\s*`admin` scope on the calling key\./,
    );
    expect(body).toMatch(
      /create\(body: CreateWebhookRequest\): Promise<CreateWebhookResponse> \{\s*\n?\s*return this\.http\.request<CreateWebhookResponse>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: '\/v1\/webhooks',\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('list/get/delete pinned: list -> WebhookEndpointList (plaintext never returned); get -> WebhookEndpoint encoded id; delete -> void idempotent (soft-delete)', () => {
    expect(body).toMatch(
      /\/\*\* List webhook endpoints for the calling account\. Plaintext is never returned\. \*\//,
    );
    expect(body).toMatch(
      /list\(\): Promise<WebhookEndpointList> \{\s*\n?\s*return this\.http\.request<WebhookEndpointList>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: '\/v1\/webhooks',\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(/\/\*\* Get a single webhook endpoint\. \*\//);
    expect(body).toMatch(
      /get\(id: string\): Promise<WebhookEndpoint> \{\s*\n?\s*return this\.http\.request<WebhookEndpoint>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: `\/v1\/webhooks\/\$\{encodeURIComponent\(id\)\}`,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(/\/\*\* Disable \(soft-delete\) a webhook endpoint\. Idempotent\. \*\//);
    expect(body).toMatch(
      /delete\(id: string\): Promise<void> \{\s*\n?\s*return this\.http\.request<void>\(\{\s*\n?\s*method: 'DELETE',\s*\n?\s*path: `\/v1\/webhooks\/\$\{encodeURIComponent\(id\)\}`,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it("V-351 update: PATCH /v1/webhooks/:id; at least one of url/events/description/active; secret NOT rotated (use rotateSecret); 409 on disabled endpoints; requires 'admin' scope", () => {
    expect(body).toMatch(
      /\*\s*V-351 — partial-update a webhook endpoint\. At least one of `url`,\s*\n?\s*\*\s*`events`, `description`, or `active` must be present\. The\s*\n?\s*\*\s*signing secret is NOT rotated by update; use `rotateSecret` for\s*\n?\s*\*\s*that\. Disabled endpoints cannot be updated \(returns 409\)\.\s*\n?\s*\*\s*Requires the `admin` scope on the calling key\./,
    );
    expect(body).toMatch(
      /update\(id: string, body: UpdateWebhookRequest\): Promise<WebhookEndpoint> \{\s*\n?\s*return this\.http\.request<WebhookEndpoint>\(\{\s*\n?\s*method: 'PATCH',\s*\n?\s*path: `\/v1\/webhooks\/\$\{encodeURIComponent\(id\)\}`,\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it("listDeliveries: GET /v1/webhooks/:id/deliveries; status filter (e.g. 'dlq'); limit/cursor/status conditional-spread", () => {
    expect(body).toMatch(
      /\/\*\* Paginated delivery log for a webhook endpoint\. Filter by status \(e\.g\. `'dlq'`\)\. \*\//,
    );
    expect(body).toMatch(
      /listDeliveries\(\s*\n?\s*id: string,\s*\n?\s*query: ListDeliveriesQueryInput & \{ status\?: WebhookDeliveryStatus \} = \{\},\s*\n?\s*\): Promise<WebhookDeliveryListPage> \{/,
    );
    expect(body).toMatch(
      /query: \{\s*\n?\s*\.\.\.\(query\.limit !== undefined \? \{ limit: query\.limit \} : \{\}\),\s*\n?\s*\.\.\.\(query\.cursor !== undefined \? \{ cursor: query\.cursor \} : \{\}\),\s*\n?\s*\.\.\.\(query\.status !== undefined \? \{ status: query\.status \} : \{\}\),\s*\n?\s*\},/,
    );
  });

  it("V-118 iterateDeliveries: AsyncGenerator<WebhookDelivery, void, void>; status filter walks one bucket (e.g. 'dlq' for replay tooling); cursor !== null guard", () => {
    expect(body).toMatch(
      /\*\s*Lazily iterate every delivery for a webhook endpoint, walking cursor\s*\n?\s*\*\s*pages automatically\. Filter by status to walk just one bucket\s*\n?\s*\*\s*\(e\.g\. `\{ status: 'dlq' \}` to enumerate the DLQ for replay tooling\)\./,
    );
    expect(body).toMatch(
      /iterateDeliveries\(\s*\n?\s*id: string,\s*\n?\s*opts: \{ limit\?: number; status\?: WebhookDeliveryStatus \} = \{\},\s*\n?\s*\): AsyncGenerator<WebhookDelivery, void, void> \{\s*\n?\s*return iteratePaginated<WebhookDelivery>\(\(cursor\) =>\s*\n?\s*this\.listDeliveries\(id, \{\s*\n?\s*\.\.\.\(opts\.limit !== undefined \? \{ limit: opts\.limit \} : \{\}\),\s*\n?\s*\.\.\.\(opts\.status !== undefined \? \{ status: opts\.status \} : \{\}\),\s*\n?\s*\.\.\.\(cursor !== null \? \{ cursor \} : \{\}\),\s*\n?\s*\}\),\s*\n?\s*\);\s*\n?\s*\}/,
    );
  });

  it('V-307 replayDelivery: POST /v1/webhook-deliveries/:deliveryId/replay (NOT under /v1/webhooks); resets to pending; account-scoped; empty body {}', () => {
    expect(body).toMatch(
      /\*\s*V-307 — replay a webhook delivery\. Resets the delivery to pending \+\s*\n?\s*\*\s*the worker re-fires it\. Account-scoped: the delivery must belong to\s*\n?\s*\*\s*an endpoint the calling account owns\. Useful when the customer's\s*\n?\s*\*\s*downstream had a brief outage and wants to re-fire the failed deliveries\./,
    );
    expect(body).toMatch(
      /replayDelivery\(deliveryId: string\): Promise<WebhookDelivery> \{\s*\n?\s*return this\.http\.request<WebhookDelivery>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: `\/v1\/webhook-deliveries\/\$\{encodeURIComponent\(deliveryId\)\}\/replay`,\s*\n?\s*body: \{\},\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it("V-359 rotateSecret: POST /v1/webhooks/:id/rotate-secret; fresh plaintext returned ONCE; 24h grace via grace_expires_at; dual-sign window; requires 'admin' scope", () => {
    expect(body).toMatch(
      /\*\s*V-359 — rotate the webhook signing secret\. The fresh plaintext is\s*\n?\s*\*\s*returned ONCE\. The previous secret stays active for 24h\s*\n?\s*\*\s*\(`grace_expires_at`\) during which Driftstack dual-signs every\s*\n?\s*\*\s*outbound delivery \(both the new \+ old HMAC\)\. Roll the new secret\s*\n?\s*\*\s*across your verifier infra inside that window\. Requires the\s*\n?\s*\*\s*`admin` scope on the calling key\./,
    );
    expect(body).toMatch(
      /rotateSecret\(id: string\): Promise<RotateWebhookSecretResponse> \{\s*\n?\s*return this\.http\.request<RotateWebhookSecretResponse>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: `\/v1\/webhooks\/\$\{encodeURIComponent\(id\)\}\/rotate-secret`,\s*\n?\s*body: \{\},\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it("V-356 sendTest: POST /v1/webhooks/:id/test; synthetic 'test.ping' bypasses subscription; 202 + delivery_id+event_id+event_type:test.ping; requires 'admin' scope", () => {
    expect(body).toMatch(
      /\*\s*V-356 — send a synthetic `test\.ping` event to the endpoint\.\s*\n?\s*\*\s*Bypasses subscription \(the endpoint receives it regardless of\s*\n?\s*\*\s*which event types it's subscribed to\), so customers can verify\s*\n?\s*\*\s*their handler is reachable \+ signature-valid before depending on\s*\n?\s*\*\s*it for real events\. Returns 202 \+ the synthetic delivery id\.\s*\n?\s*\*\s*Requires the `admin` scope on the calling key\./,
    );
    expect(body).toMatch(
      /sendTest\(id: string\): Promise<\{\s*\n?\s*delivery_id: string;\s*\n?\s*event_id: string;\s*\n?\s*event_type: 'test\.ping';\s*\n?\s*\}> \{/,
    );
    expect(body).toMatch(/path: `\/v1\/webhooks\/\$\{encodeURIComponent\(id\)\}\/test`,/);
  });

  it('imports: 8 api-types shapes (CreateWebhookRequest/Response + ListDeliveriesQueryInput + RotateWebhookSecretResponse + UpdateWebhookRequest + WebhookDelivery/Status + WebhookEndpoint) + HttpClient + iteratePaginated', () => {
    expect(body).toMatch(
      /import type \{\s*\n?\s*CreateWebhookRequest,\s*\n?\s*CreateWebhookResponse,\s*\n?\s*ListDeliveriesQueryInput,\s*\n?\s*RotateWebhookSecretResponse,\s*\n?\s*UpdateWebhookRequest,\s*\n?\s*WebhookDelivery,\s*\n?\s*WebhookDeliveryStatus,\s*\n?\s*WebhookEndpoint,\s*\n?\s*\} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(/import type \{ HttpClient \} from '\.\.\/http\.js';/);
    expect(body).toMatch(/import \{ iteratePaginated \} from '\.\.\/pagination\.js';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
