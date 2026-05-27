// Cross-source invariant: webhook delivery does 5 retries / 6 total
// attempts before DLQ, declared in 3 source places — packages/
// webhook-delivery + apps/server/services/durable-webhook-delivery
// (export of DEFAULT_MAX_ATTEMPTS) + apps/server/services/webhook-
// worker (local MAX_ATTEMPTS) + docs/webhooks/replay.md customer copy.
// Drift would either give up too early (customer angry: "you only
// tried 3 times!") or hammer customer endpoints forever.
//
// NOTE: the per-source string pins below are necessary but were
// historically *toothless* — each matched its own constant in
// isolation, so the three could silently disagree (and did: the code
// did 4 retries while the docs promised 5, finding #5). The final
// `numeric consistency` test computes the actual integers and asserts
// all three are equal AND equal to (backoff entries + 1), which is the
// real contract a reader cares about.

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

  it('packages/webhook-delivery in-memory exports DEFAULT_MAX_ATTEMPTS = 6', () => {
    expect(pkg).toMatch(/export const DEFAULT_MAX_ATTEMPTS = 6;/);
  });

  it('services/durable-webhook-delivery re-exports DEFAULT_MAX_ATTEMPTS = 6 + uses it as the DLQ-promotion threshold', () => {
    expect(svc).toMatch(/export const DEFAULT_MAX_ATTEMPTS = 6;/);
    expect(svc).toMatch(/if \(attemptNumber >= DEFAULT_MAX_ATTEMPTS\) \{/);
  });

  it("services/webhook-worker pins MAX_ATTEMPTS = 6 with the explicit 'attempt indices 0..5 (initial + 5 retries)' rationale", () => {
    expect(worker).toMatch(
      /const MAX_ATTEMPTS = 6; \/\/ attempt indices 0\.\.5 \(initial \+ 5 retries\); DLQ when the next index would be 6/,
    );
    expect(worker).toMatch(/if \(nextAttemptIndex >= MAX_ATTEMPTS\) \{/);
  });

  it("docs/webhooks/replay.md customer copy claims 'retries failed webhook deliveries 5 times with exponential' — pinned so the 5-retry customer-facing claim matches the server-side constants (drift would either confuse customers or break the DLQ promotion threshold)", () => {
    expect(docs).toMatch(/Driftstack retries failed webhook deliveries 5 times with exponential/);
  });

  it("packages/webhook-delivery in-memory header documents the 1min / 5min / 15min / 30min / 60min backoff schedule + 'Max 5' retries — pinned so the canonical backoff schedule stays documented", () => {
    expect(pkg).toMatch(/1min \/ 5min \/ 15min \/ 30min \/ 60min between attempts\. Max 5/);
  });

  it('numeric consistency: all three max-attempts constants are equal AND equal to (backoff entries + 1)', () => {
    const intAfter = (src: string, re: RegExp): number => {
      const m = re.exec(src);
      expect(m, `expected to find ${re.source}`).not.toBeNull();
      return Number(m?.[1]);
    };
    const pkgMax = intAfter(pkg, /DEFAULT_MAX_ATTEMPTS = (\d+);/);
    const svcMax = intAfter(svc, /DEFAULT_MAX_ATTEMPTS = (\d+);/);
    const workerMax = intAfter(worker, /MAX_ATTEMPTS = (\d+);/);
    // All three implementations must agree on the cap.
    expect(pkgMax).toBe(6);
    expect(svcMax).toBe(workerMax);
    expect(workerMax).toBe(pkgMax);
    // The cap = total attempts = initial + (one backoff slot per retry).
    // The worker's BACKOFF_MS_BY_ATTEMPT keys are 1..N (one per retry),
    // so the cap must be backoff-entries + 1, otherwise the highest
    // backoff slot is unreachable (the exact off-by-one from finding #5).
    const backoffKeys = [...worker.matchAll(/^ {2}(\d+): /gm)].map((m) => Number(m[1]));
    expect(backoffKeys).toEqual([1, 2, 3, 4, 5]);
    expect(workerMax).toBe(backoffKeys.length + 1);
  });
});
