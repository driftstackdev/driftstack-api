// W258.A — drift-guard for docs.driftstack.io/webhooks/replay. Pins
// the replay endpoint, the retry-count claim, and the SDK methods
// cited in code samples.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOC = resolve(REPO_ROOT, 'apps/docs/src/pages/webhooks/replay.md');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/webhooks.ts');
const DISPATCHER = resolve(REPO_ROOT, 'apps/server/src/services/durable-webhook-delivery.ts');
const TS_SDK = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/webhooks.ts');
const PY_SDK = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/webhooks.py');
const GO_SDK = resolve(REPO_ROOT, 'packages/sdk-go/webhooks.go');
const GO_TYPES = resolve(REPO_ROOT, 'packages/sdk-go/types.go');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W258.A docs/webhooks/replay ↔ live replay surface parity', () => {
  const doc = read(DOC);
  const route = read(ROUTE);
  const dispatcher = read(DISPATCHER);

  it('POST /v1/webhook-deliveries/:deliveryId/replay is documented + registered', () => {
    expect(doc).toMatch(/POST \/v1\/webhook-deliveries\/:deliveryId\/replay/);
    expect(route).toContain(`'/v1/webhook-deliveries/:deliveryId/replay'`);
  });

  it('retry-count claim (5 retries) matches DEFAULT_MAX_ATTEMPTS = 6 (initial + 5 retries)', () => {
    expect(doc).toMatch(/retries failed webhook deliveries 5 times/);
    expect(dispatcher).toContain('DEFAULT_MAX_ATTEMPTS = 6');
  });

  it('TypeScript SDK methods cited exist on WebhooksResource', () => {
    const ts = read(TS_SDK);
    expect(doc).toContain('client.webhooks.listDeliveries');
    expect(doc).toContain('client.webhooks.iterateDeliveries');
    expect(doc).toContain('client.webhooks.replayDelivery');
    expect(ts).toMatch(/\blistDeliveries\s*\(/);
    expect(ts).toMatch(/\biterateDeliveries\s*\(/);
    expect(ts).toMatch(/\breplayDelivery\s*\(/);
  });

  it('Python SDK methods cited exist on WebhooksResource', () => {
    const py = read(PY_SDK);
    expect(doc).toContain('iterate_deliveries');
    expect(doc).toContain('replay_delivery');
    expect(py).toMatch(/def\s+iterate_deliveries\s*\(/);
    expect(py).toMatch(/def\s+replay_delivery\s*\(/);
  });

  it('Go SDK methods + DeliveryDLQ constant cited exist', () => {
    const go = read(GO_SDK);
    const types = read(GO_TYPES);
    expect(doc).toContain('client.Webhooks.ListDeliveries');
    expect(doc).toContain('client.Webhooks.ReplayDelivery');
    expect(doc).toContain('driftstack.DeliveryDLQ');
    expect(go).toMatch(/func\s+\(r\s+\*WebhooksResource\)\s+ListDeliveries/);
    expect(go).toMatch(/func\s+\(r\s+\*WebhooksResource\)\s+ReplayDelivery/);
    expect(types).toContain('DeliveryDLQ');
  });

  it('audit action name matches the live constant', () => {
    expect(doc).toMatch(/webhook_delivery\.replayed/);
    // The audit-log endpoint accepts `action=webhook_delivery.replayed`.
    expect(doc).toMatch(/\/v1\/account\/audit-log\?action=webhook_delivery\.replayed/);
  });

  it('error rows cite the canonical 4xx codes', () => {
    for (const code of ['404 Not Found', '400 Bad Request', '429 Too Many Requests']) {
      expect(doc).toContain(code);
    }
  });
});
