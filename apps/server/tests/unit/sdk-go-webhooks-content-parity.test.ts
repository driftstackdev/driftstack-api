// W593.A — drift guard for packages/sdk-go/webhooks.go.

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

  it('WebhooksResource 10-verb surface (Create + List + Get + Delete + ListDeliveries + ReplayDelivery V-307 + RotateSecret V-359 24h dual-sign + SendTest V-356 test.ping + Update V-351 partial) + admin-scope + plaintext-once invariants pinned', () => {
    expect(body).toMatch(/\/\/ WebhooksResource handles \/v1\/webhooks\./);
    expect(body).toMatch(
      /\/\/ Create a webhook subscription\. Plaintext signing secret is returned/,
    );
    expect(body).toMatch(/\/\/ ONCE in CreateWebhookResponse\.Secret — store it immediately\./);
    expect(body).toMatch(/\/\/ Requires the admin scope\./);
    expect(body).toMatch(/path:\s+"\/v1\/webhooks",/);
    expect(body).toMatch(/path:\s+"\/v1\/webhooks\/" \+ url\.PathEscape\(webhookID\),/);
    expect(body).toMatch(/\/\/ Delete soft-deletes \(disables\) the endpoint\. Idempotent\./);
    expect(body).toMatch(
      /path:\s+"\/v1\/webhooks\/" \+ url\.PathEscape\(webhookID\) \+ "\/deliveries",/,
    );
    expect(body).toMatch(/q\.Set\("status", string\(query\.Status\)\)/);
    expect(body).toMatch(
      /\/\/ ReplayDelivery is V-307 — resets a webhook delivery to pending so the/,
    );
    expect(body).toMatch(
      /\/\/ worker re-fires it\. Account-scoped: the delivery must belong to an/,
    );
    expect(body).toMatch(/\/\/ endpoint the calling account owns\./);
    expect(body).toMatch(
      /path:\s+"\/v1\/webhook-deliveries\/" \+ url\.PathEscape\(deliveryID\) \+ "\/replay",/,
    );
    expect(body).toMatch(/\/\/ RotateWebhookSecretResponse — V-359 secret rotation result\./);
    expect(body).toMatch(/\/\/ fresh plaintext is in Secret \(returned ONCE\); during the/);
    expect(body).toMatch(
      /\/\/ GraceExpiresAt window Driftstack dual-signs every outbound delivery/,
    );
    expect(body).toMatch(/\/\/ with both the new \+ previous secret\./);
    expect(body).toMatch(
      /^type RotateWebhookSecretResponse struct \{\s*\n\s*ID\s+string\s+`json:"id"`\s*\n\s*Secret\s+string\s+`json:"secret"`\s*\n\s*SecretPrefix\s+string\s+`json:"secret_prefix"`\s*\n\s*PrevSecretPrefix string\s+`json:"prev_secret_prefix"`\s*\n\s*GraceExpiresAt\s+time\.Time `json:"grace_expires_at"`\s*\n\}/m,
    );
    expect(body).toMatch(/\/\/ RotateSecret is V-359 — rotate the webhook signing secret\./);
    expect(body).toMatch(
      /path:\s+"\/v1\/webhooks\/" \+ url\.PathEscape\(webhookID\) \+ "\/rotate-secret",/,
    );
    expect(body).toMatch(/\/\/ SendTestWebhookResponse — V-356 synthetic test\.ping delivery/);
    expect(body).toMatch(/EventType\s+string `json:"event_type"` \/\/ always "test\.ping"/);
    expect(body).toMatch(/\/\/ Update is V-351 — partial-update a webhook endpoint\./);
    expect(body).toMatch(
      /\/\/ of URL \/ Events \/ Description \/ Active must be non-nil; otherwise/,
    );
    expect(body).toMatch(/\/\/ Update; use RotateSecret for that\. Disabled endpoints can't be/);
    expect(body).toMatch(/\/\/ updated \(returns 409\)\./);
    expect(body).toMatch(
      /method: "PATCH",\s*\n\s*path:\s+"\/v1\/webhooks\/" \+ url\.PathEscape\(webhookID\),/,
    );
    expect(body).toMatch(/\/\/ SendTest is V-356 — send a synthetic test\.ping event to the/);
    expect(body).toMatch(/\/\/ endpoint\. Bypasses subscription so customers can verify their/);
    expect(body).toMatch(/path:\s+"\/v1\/webhooks\/" \+ url\.PathEscape\(webhookID\) \+ "\/test",/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
