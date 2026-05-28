// Cross-source invariant: webhook signatures are carried in the
// SINGLE canonical header `x-driftstack-signature`. During the
// rotation grace window the previous-secret HMAC is folded into a
// SECOND `v1=` entry inside that one header (`t=…,v1=<new>,v1=<old>`),
// NOT a separate `x-driftstack-signature-prev` header — no wired
// server path emits such a header. The single-header form appears in
// the delivery dispatcher, the worker, the customer-facing
// webhooks/endpoints.md, and the SDK quickstart examples. Drift to
// claiming a separate prev header would tell customers to read a
// request header that is never sent.

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

  it('docs/webhooks/endpoints.md customer-facing copy describes the compound dual-v1= single header (NOT a separate prev header)', () => {
    expect(docsEndpoints).toMatch(/`t=<sec>,v1=<new>,v1=<old>`/);
    expect(docsEndpoints).toMatch(/There is no separate/);
    expect(docsEndpoints).not.toMatch(/`x-driftstack-signature-prev` \(old HMAC\) are emitted/);
  });

  it('docs/sdk/typescript-quickstart.md SDK example reads only the single signature header (no never-sent prev header)', () => {
    expect(sdkTs).toMatch(/req\.headers\['x-driftstack-signature'\] as string,/);
    expect(sdkTs).not.toMatch(/x-driftstack-signature-prev/);
  });

  it('docs/sdk/python-quickstart.md SDK example reads only the single signature header (no never-sent prev header)', () => {
    expect(sdkPy).toMatch(/header=request\.headers\["x-driftstack-signature"\],/);
    expect(sdkPy).not.toMatch(/x-driftstack-signature-prev/);
  });
});
