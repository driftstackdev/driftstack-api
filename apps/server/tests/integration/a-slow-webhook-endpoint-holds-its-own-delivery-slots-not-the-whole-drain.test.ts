// One slow webhook endpoint must cost its own delivery slots, not everybody's.
//
// Webhooks audit #2 (2026-09-24). The worker delivered in BATCHES: claim 25,
// `Promise.allSettled` them, claim the next 25. A batch therefore lasted as long
// as its slowest delivery, and an endpoint that answers 200 after ten seconds —
// slow but succeeding, so nothing ever backs it off — keeps a backlog whose rows
// are always the oldest and so sit in every batch. Every batch then took ten
// seconds, and the 30-second drain budget ran about three batches a minute
// instead of twenty, for every account on the deployment. That contradicts the
// events page: "one endpoint with a backlog cannot hold up another's events".
//
// The drain is now a bounded POOL: a slot that frees claims a new delivery at
// once, and the claim counts an endpoint's deliveries already in flight against
// its per-endpoint cap. A straggler then holds at most its capped share of the
// slots, while the rest keep cycling.
//
// This is the audit's scenario, measured the way the audit measured it: ten fast
// endpoints with 200 deliveries between them, one endpoint answering after
// 1.5 s with an older backlog, a 3 s budget, and fetch stubbed so nothing leaves
// the machine. Real Postgres, in a database of its own, because the fairness is
// a window function plus row locks and the claim is global.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestLogger } from '../../src/lib/logger.js';
import { WebhookDeliveryWorker } from '../../src/services/webhook-worker.js';
import { openWebhookDeliveryDb, type WebhookDeliveryDb } from './_helpers/webhook-delivery-db.js';

const ISOLATED_DB_NAME = 'driftstack_iso_webhook_drain_pool';
/** How long the straggler takes to answer (200, so it is never backed off). */
const SLOW_MS = 1_500;
/** The drain's wall-clock budget in the audit's scenario. */
const BUDGET_MS = 3_000;
/** Bootstrap's ceilings: 25 slots, 500 deliveries per drain. */
const SLOTS = 25;
const MAX_DELIVERIES = 500;
const FAST_ENDPOINTS = 10;
const PER_FAST_ENDPOINT = 20;

let fx: WebhookDeliveryDb | null = null;

beforeAll(async () => {
  fx = await openWebhookDeliveryDb(ISOLATED_DB_NAME);
});

beforeEach(async () => {
  await fx?.wipe();
});

afterAll(async () => {
  await fx?.wipe();
  await fx?.close();
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface DrainStats {
  fastDelivered: number;
  slowDelivered: number;
  claims: number;
  elapsed: number;
  /** ms after the start when the LAST fast delivery got its answer. */
  lastFastAnswerAt: number | null;
  /** ms after the start when the straggler first answered. */
  firstSlowAnswerAt: number | null;
  /** The most straggler deliveries ever in flight at once. */
  maxSlowInFlight: number;
}

/** Drive the drain exactly as bootstrap's poller does. */
async function runDrain(worker: WebhookDeliveryWorker): Promise<{ claims: number }> {
  return worker.drain({ maxDeliveries: MAX_DELIVERIES, budgetMs: BUDGET_MS });
}

async function scenario(withStraggler: boolean): Promise<DrainStats> {
  const db = fx!;
  const account = await db.seedAccount();
  const fast: string[] = [];
  for (let i = 0; i < FAST_ENDPOINTS; i += 1) {
    fast.push(await db.seedEndpoint(account, `https://fast-${String(i)}.hooks.test.local/in`));
  }
  let slow: string | null = null;
  if (withStraggler) {
    slow = await db.seedEndpoint(account, 'https://slow.hooks.test.local/in');
    // The straggler's backlog is the OLDEST work in the queue, as in production:
    // a backlog is exactly what keeps an endpoint's rows first in line.
    await db.seedDue(slow, 40, 10_000);
  }
  for (const id of fast) await db.seedDue(id, PER_FAST_ENDPOINT, 100);

  const t0 = Date.now();
  let lastFastAnswerAt: number | null = null;
  let firstSlowAnswerAt: number | null = null;
  let slowInFlight = 0;
  let maxSlowInFlight = 0;
  const fetchStub = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('slow.')) {
      slowInFlight += 1;
      maxSlowInFlight = Math.max(maxSlowInFlight, slowInFlight);
      await sleep(SLOW_MS);
      slowInFlight -= 1;
      firstSlowAnswerAt ??= Date.now() - t0;
      return new Response(null, { status: 200 });
    }
    await Promise.resolve();
    lastFastAnswerAt = Date.now() - t0;
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  const worker = new WebhookDeliveryWorker({
    repo: db.repo,
    logger: createTestLogger(),
    fetch: fetchStub,
    batchSize: SLOTS,
  });
  const { claims } = await runDrain(worker);
  const elapsed = Date.now() - t0;

  const delivered = async (ids: string[]): Promise<number> => {
    if (ids.length === 0) return 0;
    const rows = await db.client<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM webhook_deliveries
      WHERE webhook_id IN ${db.client(ids)} AND status = 'delivered'`;
    return rows[0]?.n ?? 0;
  };
  return {
    fastDelivered: await delivered(fast),
    slowDelivered: await delivered(slow === null ? [] : [slow]),
    claims,
    elapsed,
    lastFastAnswerAt,
    firstSlowAnswerAt,
    maxSlowInFlight,
  };
}

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'a slow webhook endpoint holds its own delivery slots, not the whole drain',
  () => {
    it('CRITICAL the isolated database was reached. Every arm below is DB-backed; without it they would prove nothing about the claim or the pool.', () => {
      expect(fx, `could not create or reach ${ISOLATED_DB_NAME}`).not.toBeNull();
    });

    it('control: with no straggler, one drain delivers all 200 fast deliveries', async () => {
      const stats = await scenario(false);
      expect(stats.fastDelivered, JSON.stringify(stats)).toBe(FAST_ENDPOINTS * PER_FAST_ENDPOINT);
    });

    it('CRITICAL with a 1.5 s straggler and a 3 s budget, every fast delivery still goes out — and all of them before the straggler has answered once. Batching delivered 40 of the 200 (two batches, each as long as its slowest row).', async () => {
      const stats = await scenario(true);
      expect(
        stats.fastDelivered,
        `fast endpoints were held up by the straggler: ${JSON.stringify(stats)}`,
      ).toBe(FAST_ENDPOINTS * PER_FAST_ENDPOINT);
      expect(stats.lastFastAnswerAt, JSON.stringify(stats)).not.toBeNull();
      expect(stats.firstSlowAnswerAt, JSON.stringify(stats)).not.toBeNull();
      expect(
        stats.lastFastAnswerAt! < stats.firstSlowAnswerAt!,
        `a fast delivery waited for the straggler's answer: ${JSON.stringify(stats)}`,
      ).toBe(true);
    });

    it('CRITICAL the straggler never holds more than its per-endpoint share of the slots (5 of 25), yet it keeps draining rather than being starved in turn', async () => {
      const stats = await scenario(true);
      expect(stats.maxSlowInFlight, JSON.stringify(stats)).toBeGreaterThan(0);
      expect(
        stats.maxSlowInFlight,
        `the straggler took more than its share of the pool: ${JSON.stringify(stats)}`,
      ).toBeLessThanOrEqual(5);
      // 3 s budget / 1.5 s per answer: two rounds of five.
      expect(stats.slowDelivered, JSON.stringify(stats)).toBeGreaterThanOrEqual(5);
    });

    it('CRITICAL the budget still bounds the drain: it stops claiming at the budget and returns once what it started has answered — not after the whole straggler backlog', async () => {
      const stats = await scenario(true);
      // 40 straggler rows at 1.5 s per round of five would take 12 s to clear.
      expect(stats.slowDelivered, JSON.stringify(stats)).toBeLessThan(40);
      expect(stats.elapsed, JSON.stringify(stats)).toBeLessThan(BUDGET_MS + SLOW_MS + 1_000);
    });
  },
);
