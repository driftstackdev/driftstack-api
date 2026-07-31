// Both webhook claim implementations rank per endpoint.
//
// There are two. `DrizzleWebhooksRepo.claim` is what production runs today, and
// `DurableWebhookWorker.processTick` in durable-webhook-delivery.ts is the
// documented FORWARD path — its own header calls a full replacement of the
// existing service "a separate future V-NNN once V-173 has soak time". It is
// wired NOWHERE right now.
//
// That is exactly what makes it dangerous. A plain FIFO claim lets a DOWN
// endpoint fill every batch (its retries carry the oldest `next_attempt_at`),
// and because the worker delivers a batch serially those rows also consume the
// tick timing out — other customers' webhooks are not delayed, they are never
// attempted. That was fixed in the live claim. If the successor were cut over
// still carrying a plain FIFO claim, the starvation would come straight back,
// and nothing in the suite would notice, because a behavioural test can only
// exercise the implementation that is actually wired.
//
// I know this failure mode concretely rather than theoretically: the first
// version of that fix went into the successor by mistake, and the only reason
// it surfaced was a test calling a method the live repo does not have.
//
// STRUCTURAL, and deliberately so. The live claim has a full behavioural suite
// against real Postgres (`db-webhook-delivery-fair-claim`) — that is where the
// property is actually proven. This file exists for the half that cannot be
// proven behaviourally without building a delivery fixture (secret decryption,
// signing, HTTP) for code nothing calls. Checking the window function is a weak
// assertion; it is the strongest one available for an unwired path, and it is
// strictly better than the alternative of checking nothing.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

const IMPLEMENTATIONS: ReadonlyArray<{ label: string; path: string; wired: boolean }> = [
  { label: 'live — DrizzleWebhooksRepo.claim', path: 'db/webhooks-repo.ts', wired: true },
  {
    label: 'successor — DurableWebhookWorker.processTick',
    path: 'services/durable-webhook-delivery.ts',
    wired: false,
  },
];

function sourceOf(rel: string): string {
  return readFileSync(resolve(SRC, rel), 'utf8');
}

describe('every webhook claim implementation ranks per endpoint, wired or not', () => {
  it('CRITICAL both implementations were actually found and read. An unreadable path would make the checks below vacuous, and this file exists precisely because one of the two is easy to overlook.', () => {
    for (const impl of IMPLEMENTATIONS) {
      expect(sourceOf(impl.path).length, `${impl.label} source`).toBeGreaterThan(1000);
    }
  });

  it('CRITICAL each claim partitions by webhook_id. Without the PARTITION the row number is one global sequence and the per-endpoint cap silently degrades into a plain global LIMIT — the exact starvation this fixed, reintroduced in a form that still looks like the fix.', () => {
    const missing = IMPLEMENTATIONS.filter(
      (impl) => !/row_number\(\)\s+OVER\s+\(PARTITION BY webhook_id/.test(sourceOf(impl.path)),
    ).map((impl) => impl.label);

    expect(missing.sort(), 'webhook claim(s) without per-endpoint ranking:').toEqual([]);
  });

  it('CRITICAL each claim still takes its locks with SKIP LOCKED. The ranking had to move the lock into a separate step, because PostgreSQL forbids FOR UPDATE alongside a window function — losing SKIP LOCKED there would let two workers claim the same delivery and double-send it.', () => {
    const missing = IMPLEMENTATIONS.filter(
      (impl) => !/FOR UPDATE SKIP LOCKED/.test(sourceOf(impl.path)),
    ).map((impl) => impl.label);

    expect(missing.sort(), 'webhook claim(s) that lost SKIP LOCKED:').toEqual([]);
  });

  it('CRITICAL each claim caps per endpoint rather than only limiting the batch. A batch LIMIT alone is what FIFO already did.', () => {
    const missing = IMPLEMENTATIONS.filter(
      (impl) => !/rn <= \$\{perEndpointCap\}/.test(sourceOf(impl.path)),
    ).map((impl) => impl.label);

    expect(missing.sort(), 'webhook claim(s) without a per-endpoint cap:').toEqual([]);
  });

  it('records which implementation is live, so the day the cutover happens this file is the thing that says the successor was already covered', () => {
    expect(IMPLEMENTATIONS.filter((i) => i.wired).map((i) => i.path)).toEqual([
      'db/webhooks-repo.ts',
    ]);
  });
});
