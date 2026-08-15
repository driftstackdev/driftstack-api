// The webhook delivery drain loop's three bounds, exercised.
//
// Context for why this file exists at all: re-verifying the 2026-06-11 launch
// readiness doc today showed its second RED blocker — "the API enqueues
// deliveries but no prod driver POSTs them" — has SHIPPED. `bootstrap.ts` builds
// a `WebhookDeliveryWorker` and runs it on a poller.
//
// ⚠️ But the component certified as shipped had no behavioural test. Its only
// coverage was `services-webhook-worker-content-parity`, a source-text pin, and
// a pin cannot tell a working drain from one that spins or stalls. Certifying it
// without checking that was half a job.
//
// `drainWebhookDeliveries` is the part worth pinning because it is the part with
// the bounds. Its own comments in bootstrap say why each exists: a single tick
// claimed at most one batch, so a backlog from one busy account "could never
// drain, and every other customer's events queued behind it" — while an
// unbounded drain would let a hot queue monopolise the process. Both failures
// are silent; neither throws.
//
// LEDGER — control 5/5:
//
//   drain stops after ONE batch (the original defect)  4 red
//   maxBatches cap removed                             1 red
//   wall-clock budget removed                          1 red
//
// D1 reproduces the bug the drain was written to fix rather than disabling the
// fix generically — the same principle as the webhook empty-list regression.
// D2 and D3 each red exactly one arm because the two bounds catch DIFFERENT
// runaway shapes: a fast hot queue is stopped by the batch cap, a slow one by
// the clock, and 20 slow batches can outlast a poll interval while the count is
// still bounded.

import { describe, expect, it } from 'vitest';
import { drainWebhookDeliveries } from '../../src/services/webhook-worker.js';

describe('drainWebhookDeliveries — the three bounds', () => {
  it('CRITICAL keeps claiming while work keeps coming, so a backlog drains instead of trickling one batch per poll. That trickle was the original defect: a deployment-wide ceiling that did not scale with anything.', async () => {
    const claims = [25, 25, 25, 4, 0];
    let i = 0;
    const r = await drainWebhookDeliveries({
      tick: () => Promise.resolve({ claimed: claims[i++] ?? 0 }),
      maxBatches: 20,
      budgetMs: 30_000,
    });
    // Four productive ticks plus the one that came back empty.
    expect(r.batches).toBe(5);
    expect(r.claimed).toBe(79);
  });

  it('CRITICAL stops on an empty tick rather than burning its whole batch budget on an idle queue', async () => {
    let ticks = 0;
    const r = await drainWebhookDeliveries({
      tick: () => {
        ticks += 1;
        return Promise.resolve({ claimed: 0 });
      },
      maxBatches: 20,
      budgetMs: 30_000,
    });
    expect(ticks, 'an idle queue costs exactly one tick').toBe(1);
    expect(r.batches).toBe(1);
    expect(r.claimed).toBe(0);
  });

  it('CRITICAL a permanently hot queue is capped by maxBatches, so one busy account cannot monopolise the tick', async () => {
    let ticks = 0;
    const r = await drainWebhookDeliveries({
      tick: () => {
        ticks += 1;
        return Promise.resolve({ claimed: 25 });
      },
      maxBatches: 20,
      budgetMs: 30_000,
    });
    // Without the cap this loop does not terminate — the tick never returns 0.
    expect(ticks).toBe(20);
    expect(r.batches).toBe(20);
  });

  it('CRITICAL the wall-clock budget stops a slow drain before the next poll overlaps it. The batch cap alone is not enough: 20 slow batches can outlast the poll interval even though the count is bounded.', async () => {
    let ticks = 0;
    let clock = 0;
    const r = await drainWebhookDeliveries({
      tick: () => {
        ticks += 1;
        clock += 400; // each batch is slow
        return Promise.resolve({ claimed: 25 });
      },
      maxBatches: 20,
      budgetMs: 1_000,
      now: () => clock,
    });
    // Budget is consumed after the third batch (1200ms >= 1000ms), well before
    // the 20-batch cap would have applied.
    expect(ticks).toBe(3);
    expect(r.batches).toBe(3);
  });

  it('reports the totals it actually achieved, since the caller logs them as delivery throughput', async () => {
    const claims = [10, 7, 0];
    let i = 0;
    const r = await drainWebhookDeliveries({
      tick: () => Promise.resolve({ claimed: claims[i++] ?? 0 }),
      maxBatches: 20,
      budgetMs: 30_000,
    });
    expect(r).toEqual({ batches: 3, claimed: 17 });
  });
});
