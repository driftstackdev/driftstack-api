// W584.A — drift guard for packages/sdk-python/src/resources/webhooks.py.
// WebhooksResource Python parity. Drift here either drops a verb,
// breaks the V-359 24h secret-rotation grace, V-307 replay, V-356
// test-ping, or V-351 partial-update PATCH.
//
//   • 10 verbs each: create / list / get / delete / list_deliveries
//     / iterate_deliveries / replay_delivery / rotate_secret / send_
//     test / update.
//   • Plaintext signing secret returned ONCE; admin scope required.
//   • V-359 rotate_secret: 24h grace (grace_expires_at) with dual-
//     sign during the window.
//   • V-307 replay_delivery: resets to pending; account-scoped.
//   • V-356 send_test: synthetic test.ping bypassing subscription.
//   • V-351 update: PATCH; at least one of url/events/description/
//     active; signing secret NOT rotated; disabled endpoint = 409.
//   • Pagination envelope: WebhookDeliveryListPage (data + has_more
//     + next_cursor).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/webhooks.py');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W584.A packages/sdk-python/src/driftstack/resources/webhooks.py content parity', () => {
  const body = read(LIB);

  it('Module docstring + 5 generated models (CreateWebhookRequest/Response + ListDeliveriesQuery + WebhookDelivery + WebhookEndpoint) + envelopes + _webhook_path helper pinned', () => {
    expect(body).toMatch(/^"""Webhooks resource — \/v1\/webhooks\."""/);
    expect(body).toMatch(
      /^from driftstack\._generated\.models import \(\s*\n\s*CreateWebhookRequest,\s*\n\s*CreateWebhookResponse,\s*\n\s*ListDeliveriesQuery,\s*\n\s*WebhookDelivery,\s*\n\s*WebhookEndpoint,\s*\n\)$/m,
    );
    expect(body).toMatch(
      /^class WebhookEndpointList\(BaseModel\):\s*\n\s*"""Response shape for ``GET \/v1\/webhooks``\."""\s*\n\s*data: list\[WebhookEndpoint\]$/m,
    );
    expect(body).toMatch(
      /^class WebhookDeliveryListPage\(BaseModel\):\s*\n\s*"""Response shape for ``GET \/v1\/webhooks\/\{id\}\/deliveries``\."""\s*\n\s*data: list\[WebhookDelivery\]\s*\n\s*has_more: bool\s*\n\s*next_cursor: str \| None$/m,
    );
    expect(body).toMatch(
      /^def _webhook_path\(webhook_id: str, suffix: str = ""\) -> str:\s*\n\s*return f"\/v1\/webhooks\/\{quote\(webhook_id, safe=''\)\}\{suffix\}"$/m,
    );
  });

  it('Sync WebhooksResource: create (plaintext signing secret ONCE + admin scope) + list + get + delete (soft-delete idempotent disable) — all model_validate pydantic', () => {
    expect(body).toMatch(/^class WebhooksResource:$/m);
    expect(body).toMatch(
      /def create\(self, body: CreateWebhookRequest \| dict\[str, Any\]\) -> CreateWebhookResponse:/,
    );
    expect(body).toMatch(/"""Create a webhook subscription\./);
    expect(body).toMatch(/Plaintext signing secret is returned ONCE; store it now — it/);
    expect(body).toMatch(/cannot be retrieved later\. Requires the ``admin`` scope\./);
    expect(body).toMatch(/return CreateWebhookResponse\.model_validate\(data\)/);
    expect(body).toMatch(
      /def list\(self\) -> WebhookEndpointList:\s*\n\s*data = self\._http\.request\("GET", "\/v1\/webhooks"\)\s*\n\s*return WebhookEndpointList\.model_validate\(data\)/,
    );
    expect(body).toMatch(
      /def get\(self, webhook_id: str\) -> WebhookEndpoint:\s*\n\s*data = self\._http\.request\("GET", _webhook_path\(webhook_id\)\)\s*\n\s*return WebhookEndpoint\.model_validate\(data\)/,
    );
    expect(body).toMatch(
      /def delete\(self, webhook_id: str\) -> None:\s*\n\s*"""Soft-delete \(disable\) the endpoint\. Idempotent\."""\s*\n\s*self\._http\.request\("DELETE", _webhook_path\(webhook_id\)\)/,
    );
  });

  it('Sync deliveries verbs: list_deliveries ListDeliveriesQuery → WebhookDeliveryListPage + iterate_deliveries lazy walk with status filter threaded per-page + V-307 replay_delivery resets-to-pending account-scoped', () => {
    expect(body).toMatch(
      /def list_deliveries\(\s*\n\s*self,\s*\n\s*webhook_id: str,\s*\n\s*query: ListDeliveriesQuery \| dict\[str, Any\] \| None = None,\s*\n\s*\) -> WebhookDeliveryListPage:/,
    );
    expect(body).toMatch(/_webhook_path\(webhook_id, "\/deliveries"\)/);
    expect(body).toMatch(
      /def iterate_deliveries\(\s*\n\s*self,\s*\n\s*webhook_id: str,\s*\n\s*\*,\s*\n\s*limit: int \| None = None,\s*\n\s*status: str \| None = None,\s*\n\s*\) -> Iterator\[WebhookDelivery\]:/,
    );
    expect(body).toMatch(/"""Lazily walk every delivery for an endpoint\./);
    expect(body).toMatch(/Filter by ``status`` \(e\.g\. ``'dlq'``\) to walk just one bucket;/);
    expect(body).toMatch(/the filter threads through every page\./);
    expect(body).toMatch(/def replay_delivery\(self, delivery_id: str\) -> WebhookDelivery:/);
    expect(body).toMatch(/"""V-307 — replay a webhook delivery\./);
    expect(body).toMatch(/Resets the delivery to ``pending`` so the worker re-fires it\./);
    expect(body).toMatch(/Account-scoped: the delivery must belong to an endpoint the/);
    expect(body).toMatch(/calling account owns\./);
    expect(body).toMatch(/f"\/v1\/webhook-deliveries\/\{quote\(delivery_id, safe=''\)\}\/replay"/);
  });

  it('Sync V-359 rotate_secret 24h dual-sign grace + V-356 send_test synthetic test.ping bypassing subscription + V-351 update PATCH partial-update (>=1 of url/events/description/active; signing secret NOT rotated; disabled = 409)', () => {
    expect(body).toMatch(/def rotate_secret\(self, webhook_id: str\) -> dict\[str, Any\]:/);
    expect(body).toMatch(/"""V-359 — rotate the webhook signing secret\./);
    expect(body).toMatch(/Returns the fresh plaintext \(shown ONCE\) plus grace metadata:/);
    expect(body).toMatch(/the previous secret stays active for 24h/);
    expect(body).toMatch(/\(``grace_expires_at``\) during which Driftstack dual-signs/);
    expect(body).toMatch(/every outbound delivery \(both new \+ old HMAC\)\. Roll the new/);
    expect(body).toMatch(/secret across your verifier infra inside that window\./);
    expect(body).toMatch(/_webhook_path\(webhook_id, "\/rotate-secret"\)/);
    expect(body).toMatch(/def send_test\(self, webhook_id: str\) -> dict\[str, Any\]:/);
    expect(body).toMatch(/"""V-356 — send a synthetic ``test\.ping`` event to the endpoint\./);
    expect(body).toMatch(/Bypasses subscription so customers can verify their handler/);
    expect(body).toMatch(/is reachable \+ signature-valid before depending on it for/);
    expect(body).toMatch(/real events\. Returns ``\{delivery_id, event_id, event_type\}``\./);
    expect(body).toMatch(/_webhook_path\(webhook_id, "\/test"\)/);
    expect(body).toMatch(
      /def update\(self, webhook_id: str, body: dict\[str, Any\]\) -> WebhookEndpoint:/,
    );
    expect(body).toMatch(/"""V-351 — partial-update a webhook endpoint\./);
    expect(body).toMatch(/At least one of ``url``, ``events``, ``description``, or/);
    expect(body).toMatch(/``active`` must be present\. The signing secret is NOT rotated/);
    expect(body).toMatch(/by update; use :meth:`rotate_secret` for that\. Disabled/);
    expect(body).toMatch(/endpoints cannot be updated \(returns 409\)\./);
    expect(body).toMatch(/return WebhookEndpoint\.model_validate\(data\)/);
  });

  it('Async AsyncWebhooksResource: mirrored awaited 10-verb surface with :meth: cross-refs back to sync', () => {
    expect(body).toMatch(/^class AsyncWebhooksResource:$/m);
    expect(body).toMatch(
      /async def replay_delivery\(self, delivery_id: str\) -> WebhookDelivery:\s*\n\s*"""V-307 — async replay\. See :meth:`WebhooksResource\.replay_delivery`\."""/,
    );
    expect(body).toMatch(
      /async def rotate_secret\(self, webhook_id: str\) -> dict\[str, Any\]:\s*\n\s*"""V-359 — async secret rotation\. See :meth:`WebhooksResource\.rotate_secret`\."""/,
    );
    expect(body).toMatch(
      /async def send_test\(self, webhook_id: str\) -> dict\[str, Any\]:\s*\n\s*"""V-356 — async test ping\. See :meth:`WebhooksResource\.send_test`\."""/,
    );
    expect(body).toMatch(
      /async def update\(self, webhook_id: str, body: dict\[str, Any\]\) -> WebhookEndpoint:\s*\n\s*"""V-351 — async partial-update\. See :meth:`WebhooksResource\.update`\."""/,
    );
    expect(body).toMatch(
      /def iterate_deliveries\(\s*\n\s*self,\s*\n\s*webhook_id: str,\s*\n\s*\*,\s*\n\s*limit: int \| None = None,\s*\n\s*status: str \| None = None,\s*\n\s*\) -> AsyncIterator\[WebhookDelivery\]:\s*\n\s*"""Async variant of :meth:`WebhooksResource\.iterate_deliveries`\."""/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
