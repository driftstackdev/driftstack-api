// Cross-source invariant: webhook delivery max-attempts before DLQ
// is 5, declared in 3 places — packages/webhook-delivery + apps/
// server/services/durable-webhook-delivery (export of
// DEFAULT_MAX_ATTEMPTS) + apps/server/services/webhook-worker (local
// MAX_ATTEMPTS) + docs/webhooks/replay.md customer-facing copy.
// Drift would either give up too early (customer angry: "you only
// tried 3 times!") or hammer customer endpoints forever.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PKG = resolve(REPO_ROOT, 'packages/webhook-delivery/src/in-memory.ts');
const SVC = resolve(REPO_ROOT, 'apps/server/src/services/durable-webhook-delivery.ts');
const WORKER = resolve(REPO_ROOT, 'apps/server/src/services/webhook-worker.ts');
const DOCS = resolve(REPO_ROOT, 'apps/docs/src/pages/webhooks/replay.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('webhook 5-retry max-attempts cross-source invariant', () => {
  const pkg = read(PKG);
  const svc = read(SVC);
  const worker = read(WORKER);
  const docs = read(DOCS);

  it('packages/webhook-delivery in-memory exports DEFAULT_MAX_ATTEMPTS = 5', () => {
    expect(pkg).toMatch(/export const DEFAULT_MAX_ATTEMPTS = 5;/);
  });

  it('services/durable-webhook-delivery re-exports DEFAULT_MAX_ATTEMPTS = 5 + uses it as the DLQ-promotion threshold', () => {
    expect(svc).toMatch(/export const DEFAULT_MAX_ATTEMPTS = 5;/);
    expect(svc).toMatch(/if \(attemptNumber >= DEFAULT_MAX_ATTEMPTS\) \{/);
  });

  it("services/webhook-worker pins MAX_ATTEMPTS = 5 with the explicit '0..5 inclusive (initial + 5 retries) → 6 total tries' rationale", () => {
    expect(worker).toMatch(
      /const MAX_ATTEMPTS = 5; \/\/ 0\.\.5 inclusive \(initial \+ 5 retries\) → 6 total tries/,
    );
    expect(worker).toMatch(/if \(nextAttemptIndex >= MAX_ATTEMPTS\) \{/);
  });

  it("docs/webhooks/replay.md customer copy claims 'retries failed webhook deliveries 5 times with exponential' — pinned so the 5-retry customer-facing claim matches the server-side constants (drift would either confuse customers or break the DLQ promotion threshold)", () => {
    expect(docs).toMatch(/Driftstack retries failed webhook deliveries 5 times with exponential/);
  });

  it("packages/webhook-delivery in-memory header documents the 1min / 5min / 15min / 30min / 60min backoff schedule + 'Max 5' attempts — pinned so the canonical backoff schedule stays documented", () => {
    expect(pkg).toMatch(/1min \/ 5min \/ 15min \/ 30min \/ 60min between attempts\. Max 5/);
  });
});
