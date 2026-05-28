// Cross-source invariant: webhook signature headers MUST use the
// canonical names `x-driftstack-signature` (current secret) and
// `x-driftstack-signature-prev` (previous secret during rotation
// grace). The names appear in the delivery dispatcher, the docs
// SDK examples, and the customer-facing webhooks/endpoints.md.
// Drift on either header name would silently break customer
// signature verification across every SDK + every doc example.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DELIVERY = resolve(REPO_ROOT, 'apps/server/src/services/durable-webhook-delivery.ts');
const WORKER = resolve(REPO_ROOT, 'apps/server/src/services/webhook-worker.ts');
const DOCS_ENDPOINTS = resolve(REPO_ROOT, 'apps/docs/src/pages/webhooks/endpoints.md');
const SDK_TS = resolve(REPO_ROOT, 'apps/docs/src/pages/sdk/typescript-quickstart.md');
const SDK_PY = resolve(REPO_ROOT, 'apps/docs/src/pages/sdk/python-quickstart.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('webhook signature-header name cross-source invariant', () => {
  const delivery = read(DELIVERY);
  const worker = read(WORKER);
  const docsEndpoints = read(DOCS_ENDPOINTS);
  const sdkTs = read(SDK_TS);
  const sdkPy = read(SDK_PY);

  it('services/durable-webhook-delivery emits the canonical single x-driftstack-signature header (rotation prev folded into a second v1= via signWebhookPayload, not a separate header)', () => {
    expect(delivery).toMatch(/'x-driftstack-signature': sigHeader,/);
    expect(delivery).toMatch(/const sigHeader = signWebhookPayload\(\{/);
    expect(delivery).not.toMatch(/'x-driftstack-signature-prev':/);
  });

  it('services/webhook-worker emits x-driftstack-signature', () => {
    expect(worker).toMatch(/'x-driftstack-signature': sigHeader,/);
  });

  it('docs/webhooks/endpoints.md customer-facing copy references both headers (current + prev) for the rotation grace period', () => {
    expect(docsEndpoints).toMatch(
      /delivery \(`x-driftstack-signature` \+ `x-driftstack-signature-prev`\)/,
    );
    expect(docsEndpoints).toMatch(/`x-driftstack-signature` \(new HMAC\) and/);
    expect(docsEndpoints).toMatch(/`x-driftstack-signature-prev` \(old HMAC\) are emitted\./);
  });

  it('docs/sdk/typescript-quickstart.md SDK example reads both signature headers (lowercase, matching the actual emit)', () => {
    expect(sdkTs).toMatch(/req\.headers\['x-driftstack-signature'\] as string,/);
    expect(sdkTs).toMatch(/req\.headers\['x-driftstack-signature-prev'\] as string \| undefined,/);
  });

  it('docs/sdk/python-quickstart.md SDK example reads both signature headers (lowercase, matching the actual emit)', () => {
    expect(sdkPy).toMatch(/header=request\.headers\["x-driftstack-signature"\],/);
    expect(sdkPy).toMatch(/header_prev=request\.headers\.get\("x-driftstack-signature-prev"\),/);
  });
});
