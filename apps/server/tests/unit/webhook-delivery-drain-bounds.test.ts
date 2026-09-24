// The webhook delivery drain's bounds, exercised.
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
// LEDGER — control 5/5 (2026-08, against the batch loop):
//
//   drain stops after ONE batch (the original defect)  4 red
//   maxBatches cap removed                             1 red
//   wall-clock budget removed                          1 red
//
// D1 reproduces the bug the drain was written to fix rather than disabling the
// fix generically — the same principle as the webhook empty-list regression.
// D2 and D3 each red exactly one arm because the two bounds catch DIFFERENT
// runaway shapes: a fast hot queue is stopped by the count cap, a slow one by
// the clock, and a slow drain can outlast a poll interval while the count is
// still bounded.
//
// 2026-09-24 (webhooks audit #2): the drain became a bounded POOL — a slot that
// frees claims again at once, so one slow delivery holds one slot instead of
// setting the length of a whole batch. The bounds carried over (the batch cap
// became a delivery cap, `maxDeliveries`), and the pool adds three properties of
// its own, pinned in the second block: the pool size is never exceeded, a slow
// delivery does not stop the others being claimed, and a drain never returns —
// not even on a failed claim — while a delivery it started is still running.

import { describe, expect, it } from 'vitest';
import { drainWebhookDeliveries } from '../../src/services/webhook-worker.js';

/** `total` ready deliveries, handed out as the slots allow; records every claim's size. */
function backlog(total: number) {
  let remaining = total;
  const sizes: number[] = [];
  return {
    claim: (slots: number): Promise<number[]> => {
      const n = Math.min(slots, remaining);
      remaining -= n;
      sizes.push(n);
      return Promise.resolve(Array.from({ length: n }, (_, k) => k));
    },
    sizes,
  };
}

const instant = (): Promise<void> => Promise.resolve();

describe('drainWebhookDeliveries — the bounds', () => {
  it('CRITICAL keeps claiming while work keeps coming, so a backlog drains instead of trickling one batch per poll. That trickle was the original defect: a deployment-wide ceiling that did not scale with anything.', async () => {
    const queue = backlog(79);
    const r = await drainWebhookDeliveries({
      claim: queue.claim,
      deliver: instant,
      concurrency: 25,
      maxDeliveries: 500,
      budgetMs: 30_000,
    });
    expect(r.claimed).toBe(79);
    // At least four productive claims of 25 slots, and it ended on an empty one.
    expect(r.claims).toBeGreaterThanOrEqual(5);
    expect(queue.sizes.at(-1)).toBe(0);
  });

  it('CRITICAL stops on an empty claim rather than burning its whole budget on an idle queue', async () => {
    let claims = 0;
    const r = await drainWebhookDeliveries({
      claim: () => {
        claims += 1;
        return Promise.resolve([]);
      },
      deliver: instant,
      concurrency: 25,
      maxDeliveries: 500,
      budgetMs: 30_000,
    });
    expect(claims, 'an idle queue costs exactly one claim').toBe(1);
    expect(r.claims).toBe(1);
    expect(r.claimed).toBe(0);
  });

  it('CRITICAL a permanently hot queue is capped by maxDeliveries, so one busy account cannot monopolise the tick', async () => {
    let claims = 0;
    const r = await drainWebhookDeliveries({
      claim: (slots) => {
        claims += 1;
        return Promise.resolve(Array.from({ length: slots }, (_, k) => k));
      },
      deliver: instant,
      concurrency: 25,
      maxDeliveries: 500,
      budgetMs: 30_000,
    });
    // Without the cap this loop does not terminate — the claim never comes back empty.
    expect(r.claimed).toBe(500);
    expect(claims).toBeLessThan(10_000);
  });

  it('CRITICAL the wall-clock budget stops a slow drain before the next poll overlaps it. The count cap alone is not enough: slow deliveries can outlast the poll interval even though the count is bounded.', async () => {
    let clock = 0;
    const r = await drainWebhookDeliveries({
      claim: (slots) => Promise.resolve(Array.from({ length: slots }, (_, k) => k)),
      deliver: async () => {
        clock += 400; // each delivery is slow
        await Promise.resolve();
      },
      concurrency: 1,
      maxDeliveries: 500,
      budgetMs: 1_000,
      now: () => clock,
    });
    // The budget is spent after the third delivery (1200ms >= 1000ms), well before
    // the 500-delivery cap would have applied.
    expect(r.claimed).toBe(3);
  });

  it('reports the totals it actually achieved, since the caller logs them as delivery throughput', async () => {
    const queue = backlog(17);
    const r = await drainWebhookDeliveries({
      claim: queue.claim,
      deliver: instant,
      concurrency: 25,
      maxDeliveries: 500,
      budgetMs: 30_000,
    });
    expect(r.claimed).toBe(17);
    expect(r.claims).toBe(queue.sizes.length);
  });
});

describe('drainWebhookDeliveries — the pool', () => {
  it('CRITICAL never has more than `concurrency` deliveries in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    let remaining = 200;
    const r = await drainWebhookDeliveries({
      claim: (slots) => {
        const n = Math.min(slots, remaining);
        remaining -= n;
        return Promise.resolve(Array.from({ length: n }, (_, k) => k));
      },
      deliver: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
      },
      concurrency: 7,
      maxDeliveries: 500,
      budgetMs: 30_000,
    });
    expect(r.claimed).toBe(200);
    expect(peak).toBe(7);
  });

  it('CRITICAL a slow delivery holds its own slot, not the drain: the fast ones behind it are claimed and delivered while it is still running. A batch waited for its slowest row.', async () => {
    let release!: () => void;
    const slowAnswered = new Promise<void>((resolve) => {
      release = resolve;
    });
    let fastDone = 0;
    let fastDoneBeforeSlow = -1;
    let remaining = 50;
    let slowClaimed = false;
    const drain = drainWebhookDeliveries<'slow' | 'fast'>({
      claim: (slots) => {
        const rows: Array<'slow' | 'fast'> = [];
        if (!slowClaimed) {
          slowClaimed = true;
          rows.push('slow');
        }
        while (rows.length < slots && remaining > 0) {
          rows.push('fast');
          remaining -= 1;
        }
        return Promise.resolve(rows);
      },
      deliver: async (row) => {
        if (row === 'slow') {
          await slowAnswered;
          fastDoneBeforeSlow = fastDone;
          return;
        }
        await Promise.resolve();
        fastDone += 1;
        if (fastDone === 50) release();
      },
      concurrency: 5,
      maxDeliveries: 500,
      budgetMs: 30_000,
    });
    const r = await drain;
    expect(r.claimed).toBe(51);
    expect(fastDoneBeforeSlow, 'the fast deliveries waited for the slow one').toBe(50);
  });

  it('CRITICAL a claim that throws still waits for the deliveries already started before the drain rejects — the caller’s no-overlap latch is released only when nothing is running', async () => {
    let running = 0;
    let claims = 0;
    let runningWhenSettled = -1;
    const drain = drainWebhookDeliveries({
      claim: () => {
        claims += 1;
        if (claims === 1) return Promise.resolve([1, 2]);
        return Promise.reject(new Error('db down'));
      },
      deliver: async () => {
        running += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
      },
      concurrency: 5,
      maxDeliveries: 500,
      budgetMs: 30_000,
    }).catch((err: unknown) => {
      runningWhenSettled = running;
      throw err;
    });
    await expect(drain).rejects.toThrow(/db down/);
    expect(runningWhenSettled).toBe(0);
  });

  it('CRITICAL a delivery that rejects despite its own error boundary is reported and costs only itself', async () => {
    const reported: unknown[] = [];
    let delivered = 0;
    const r = await drainWebhookDeliveries({
      claim: backlog(3).claim,
      deliver: (row) => {
        if (row === 0) return Promise.reject(new Error('escaped'));
        delivered += 1;
        return Promise.resolve();
      },
      concurrency: 5,
      maxDeliveries: 500,
      budgetMs: 30_000,
      onDeliverError: (_row, err) => reported.push(err),
    });
    expect(r.claimed).toBe(3);
    expect(delivered).toBe(2);
    expect(reported).toHaveLength(1);
  });
});
