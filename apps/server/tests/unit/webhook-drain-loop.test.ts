// Behavioural guard for the webhook delivery drain loop's STOP CONDITION.
//
// `repo.claim` ranks pending deliveries within each endpoint and takes at most
// `perEndpointCap` (5) per call, so it deliberately returns fewer than a full
// batch whenever the ready work is concentrated on few endpoints — which is the
// normal shape of a backlog. A drain loop that stops on a PARTIAL batch
// therefore stops after ONE claim in exactly the case it exists for: a single
// endpoint recovering from an outage drains at 5 per poll, i.e. 5/minute, while
// the stop condition makes it look handled. That was the bug in the first cut of
// this loop (V-717, corrected in V-718).
//
// Only an EMPTY claim means nothing is ready.

import { describe, expect, it } from 'vitest';
import { drainWebhookDeliveries } from '../../src/services/webhook-worker.js';

/** A queue of `total` ready deliveries served `perClaim` at a time. */
function backlog(total: number, perClaim: number): () => Promise<{ claimed: number }> {
  let remaining = total;
  return () => {
    const claimed = Math.min(perClaim, remaining);
    remaining -= claimed;
    return Promise.resolve({ claimed });
  };
}

describe('webhook drain loop', () => {
  it('keeps draining a single-endpoint backlog that claim() caps at 5 per call', async () => {
    // 40 ready deliveries on ONE endpoint. claim() returns 5 each time — always
    // a partial batch against the 25 ceiling. The old `claimed < batchSize`
    // stop condition ended after the first 5.
    const result = await drainWebhookDeliveries({
      tick: backlog(40, 5),
      maxBatches: 20,
      budgetMs: 30_000,
    });

    expect(result.claimed).toBe(40);
    expect(result.batches).toBe(9); // 8 full claims of 5, then one empty
  });

  it('stops immediately when nothing is ready', async () => {
    const result = await drainWebhookDeliveries({
      tick: backlog(0, 5),
      maxBatches: 20,
      budgetMs: 30_000,
    });
    expect(result.claimed).toBe(0);
    expect(result.batches).toBe(1);
  });

  it('is bounded by maxBatches so a hot queue cannot monopolise the process', async () => {
    const result = await drainWebhookDeliveries({
      tick: backlog(10_000, 5),
      maxBatches: 20,
      budgetMs: 30_000,
    });
    expect(result.batches).toBe(20);
    expect(result.claimed).toBe(100);
  });

  it('is bounded by the wall-clock budget even when batches remain', async () => {
    // Each tick "takes" 10s of the 25s budget.
    let clock = 0;
    const result = await drainWebhookDeliveries({
      tick: () => {
        clock += 10_000;
        return Promise.resolve({ claimed: 5 });
      },
      maxBatches: 20,
      budgetMs: 25_000,
      now: () => clock,
    });
    // Budget is checked AFTER each tick, so it stops on the first tick whose
    // elapsed time reaches the budget rather than overrunning it further.
    expect(result.batches).toBe(3);
  });
});
