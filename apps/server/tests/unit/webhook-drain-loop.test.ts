// Behavioural guard for the webhook delivery drain loop's STOP CONDITION.
//
// `repo.claim` ranks pending deliveries within each endpoint and takes at most
// `perEndpointCap` (5) per endpoint, so it deliberately returns fewer than it was
// asked for whenever the ready work is concentrated on few endpoints — which is
// the normal shape of a backlog. A drain loop that stops on a PARTIAL claim
// therefore stops after ONE claim in exactly the case it exists for: a single
// endpoint recovering from an outage drains at 5 per poll, i.e. 5/minute, while
// the stop condition makes it look handled. That was the bug in the first cut of
// this loop (V-717, corrected in V-718).
//
// Only an EMPTY claim with nothing still in flight means nothing is ready.
//
// 2026-09-24 (webhooks audit #2): the drain is a bounded POOL now — each slot
// that frees claims again — rather than a batch loop over `tickOnce`. The stop
// condition this file guards is the same; the arms drive the pool's own
// `claim(slots)` / `deliver(row)` seams, with a queue that caps each claim at 5
// rows per endpoint and honours the in-flight count the way the real claim does.

import { describe, expect, it } from 'vitest';
import { drainWebhookDeliveries } from '../../src/services/webhook-worker.js';

/**
 * `total` ready deliveries on ONE endpoint. Like the real claim, it hands out at
 * most `perEndpointCap` minus what that endpoint already has in flight.
 */
function oneEndpointBacklog(total: number, perEndpointCap = 5) {
  let remaining = total;
  let inFlight = 0;
  let delivered = 0;
  return {
    claim: (slots: number): Promise<number[]> => {
      const n = Math.min(slots, remaining, Math.max(0, perEndpointCap - inFlight));
      remaining -= n;
      inFlight += n;
      return Promise.resolve(Array.from({ length: n }, (_, i) => i));
    },
    deliver: async (): Promise<void> => {
      await Promise.resolve();
      inFlight -= 1;
      delivered += 1;
    },
    delivered: () => delivered,
  };
}

describe('webhook drain loop', () => {
  it('keeps draining a single-endpoint backlog that claim() caps at 5 at a time', async () => {
    // 40 ready deliveries on ONE endpoint. claim() never returns more than 5 —
    // always short of the 25 slots asked for. Stopping on a short claim ended
    // the drain after the first 5.
    const queue = oneEndpointBacklog(40);
    const result = await drainWebhookDeliveries({
      claim: queue.claim,
      deliver: queue.deliver,
      concurrency: 25,
      maxDeliveries: 500,
      budgetMs: 30_000,
    });

    expect(result.claimed).toBe(40);
    expect(queue.delivered()).toBe(40);
    // At least 8 productive claims of 5, then the empty one that ended it.
    expect(result.claims).toBeGreaterThanOrEqual(9);
  });

  it('stops immediately when nothing is ready', async () => {
    const queue = oneEndpointBacklog(0);
    const result = await drainWebhookDeliveries({
      claim: queue.claim,
      deliver: queue.deliver,
      concurrency: 25,
      maxDeliveries: 500,
      budgetMs: 30_000,
    });
    expect(result.claimed).toBe(0);
    expect(result.claims).toBe(1);
  });

  it('is bounded by maxDeliveries so a hot queue cannot monopolise the process', async () => {
    const queue = oneEndpointBacklog(10_000);
    const result = await drainWebhookDeliveries({
      claim: queue.claim,
      deliver: queue.deliver,
      concurrency: 25,
      maxDeliveries: 100,
      budgetMs: 30_000,
    });
    expect(result.claimed).toBe(100);
    expect(queue.delivered()).toBe(100);
  });

  it('is bounded by the wall-clock budget even when work remains', async () => {
    // Each delivery "takes" 10s of the 25s budget; one slot, so one at a time.
    let clock = 0;
    const queue = oneEndpointBacklog(10_000);
    const result = await drainWebhookDeliveries({
      claim: queue.claim,
      deliver: async () => {
        clock += 10_000;
        await queue.deliver();
      },
      concurrency: 1,
      maxDeliveries: 500,
      budgetMs: 25_000,
      now: () => clock,
    });
    // The budget is checked before each claim, so it stops claiming on the first
    // check at or past the budget rather than overrunning it further.
    expect(result.claimed).toBe(3);
  });
});
