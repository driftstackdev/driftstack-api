// Pausing a webhook endpoint holds its deliveries; it does not throw them away.
//
// Webhooks audit #3 (2026-09-24). The endpoints page offers `PATCH active:false`
// as a pause "for maintenance windows or post-incident cooldowns. Resume with
// `active: true`." What it actually did:
//
//   - every delivery already queued went straight to the DLQ at the next drain,
//     each one counting as a failed delivery toward auto-disable;
//   - events raised during the pause were never queued at all;
//   - after resume, the counter stood at the number of dropped deliveries, so
//     the first failed attempt tombstoned the endpoint — permanently.
//
// The audit's run: 55 queued, pause, drain → `{"dlq":55}`, consecutive_failures
// 55; resume, one 503 → disabled_at set, and the endpoint could never be patched
// again. A customer who followed the docs lost their queued events AND their
// endpoint.
//
// Now a paused endpoint (active=false, disabled_at IS NULL) DEFERS: its
// deliveries are not attempted, not dead-lettered and not counted while it is
// paused, events raised meanwhile are queued for it, and all of them go out
// after `active: true`. A DELETED endpoint (disabled_at set) still fails its
// deliveries terminally, as documented.
//
// Run against both repositories: the in-memory double is what the unit suites
// stand on, and Postgres is what production runs. The Postgres half uses a
// database of its own because the claim is global.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ApiKeyScope } from '@driftstack/api-types';
import { createTestLogger } from '../../src/lib/logger.js';
import type { AccountContext } from '../../src/services/auth.js';
import { WebhookDeliveryWorker } from '../../src/services/webhook-worker.js';
import {
  WebhooksService,
  type WebhookDeliveryRow,
  type WebhooksRepo,
} from '../../src/services/webhooks.js';
import { InMemoryWebhooksRepo } from './_helpers/in-memory-webhooks-repo.js';
import { openWebhookDeliveryDb, type WebhookDeliveryDb } from './_helpers/webhook-delivery-db.js';

const ISOLATED_DB_NAME = 'driftstack_iso_webhook_pause_defers';
const QUEUED_BEFORE_PAUSE = 55;

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

function ownerCtx(accountId: string): AccountContext {
  return {
    account: { id: accountId },
    apiKey: { id: 'key_pause', scopes: ['account_owner'] as ApiKeyScope[] },
  } as unknown as AccountContext;
}

interface Harness {
  repo: WebhooksRepo;
  accountId: string;
}

async function harnessFor(kind: 'in-memory' | 'postgres'): Promise<Harness> {
  if (kind === 'in-memory') return { repo: new InMemoryWebhooksRepo(), accountId: randomUUID() };
  return { repo: fx!.repo, accountId: await fx!.seedAccount() };
}

/** A worker whose clock and fetch answer the test can change between drains. */
function workerFor(repo: WebhooksRepo): {
  worker: WebhookDeliveryWorker;
  fetchCalls: () => number;
  answerWith: (status: number) => void;
  advance: (ms: number) => void;
} {
  let calls = 0;
  let status = 200;
  // A second ahead of the wall clock: Postgres stamps `next_attempt_at` in
  // microseconds and a JS Date truncates to the millisecond, so a delivery
  // queued in the same millisecond as the claim would otherwise not yet be due.
  let offsetMs = 1_000;
  const worker = new WebhookDeliveryWorker({
    repo,
    logger: createTestLogger(),
    now: () => new Date(Date.now() + offsetMs),
    fetch: async () => {
      calls += 1;
      await Promise.resolve();
      return new Response(status >= 400 ? 'receiver down' : null, { status });
    },
  });
  return {
    worker,
    fetchCalls: () => calls,
    answerWith: (s) => {
      status = s;
    },
    advance: (ms) => {
      offsetMs += ms;
    },
  };
}

/** Tick until a claim comes back empty — everything due has been handled. */
async function drainAll(worker: WebhookDeliveryWorker): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const { claimed } = await worker.tickOnce();
    if (claimed === 0) return;
  }
  throw new Error('the queue never drained');
}

async function deliveriesOf(h: Harness, endpointId: string): Promise<WebhookDeliveryRow[]> {
  const page = await h.repo.listDeliveriesForEndpoint(endpointId, h.accountId, { limit: 500 });
  return page.items;
}

function byStatus(rows: WebhookDeliveryRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = (out[r.status] ?? 0) + 1;
  return out;
}

function pauseContract(kind: 'in-memory' | 'postgres'): void {
  it('CRITICAL the repository under test is really there', () => {
    // The in-memory half needs nothing; the Postgres half needs its database.
    expect(
      kind === 'in-memory' || fx !== null,
      `could not create or reach ${ISOLATED_DB_NAME}`,
    ).toBe(true);
  });

  it('CRITICAL pause with deliveries queued: none is attempted, none is dead-lettered, the failure count does not move, and an event raised during the pause is queued for the endpoint. After resume a 503 retries rather than tombstoning the endpoint, and the held deliveries then go out.', async () => {
    const h = await harnessFor(kind);
    const svc = new WebhooksService(h.repo);
    const ctx = ownerCtx(h.accountId);
    const { row: endpoint } = await svc.create(ctx, {
      url: 'https://hooks.test.local/paused',
      events: ['session.completed'],
      description: null,
    });
    for (let i = 0; i < QUEUED_BEFORE_PAUSE; i += 1) {
      await svc.enqueueEvent(h.accountId, 'session.completed', { session_id: `ses_${String(i)}` });
    }

    await svc.update(ctx, endpoint.id, { active: false });
    await svc.enqueueEvent(h.accountId, 'session.completed', { session_id: 'ses_during_pause' });
    const queued = QUEUED_BEFORE_PAUSE + 1;
    expect(
      (await deliveriesOf(h, endpoint.id)).length,
      'the event raised during the pause was not queued for the paused endpoint',
    ).toBe(queued);

    const w = workerFor(h.repo);
    await drainAll(w.worker);
    const paused = await deliveriesOf(h, endpoint.id);
    const whilePaused = await h.repo.findEndpointById(endpoint.id);
    expect(w.fetchCalls(), 'a delivery was attempted while the endpoint was paused').toBe(0);
    expect(byStatus(paused), 'paused deliveries were not held').toEqual({ pending: queued });
    expect(
      paused.every((d) => d.attempts === 0),
      'a paused delivery spent an attempt',
    ).toBe(true);
    expect(
      whilePaused?.consecutiveFailures,
      'held deliveries counted as failed deliveries toward auto-disable',
    ).toBe(0);

    await svc.update(ctx, endpoint.id, { active: true });
    w.answerWith(503);
    await drainAll(w.worker);
    const afterFailure = await h.repo.findEndpointById(endpoint.id);
    expect(afterFailure?.disabledAt, 'a 503 after resume tombstoned the endpoint').toBeNull();
    expect(afterFailure?.active).toBe(true);
    expect(afterFailure?.consecutiveFailures).toBe(0);
    expect(w.fetchCalls(), 'the held deliveries were not attempted after resume').toBe(queued);
    expect(byStatus(await deliveriesOf(h, endpoint.id))).toEqual({ pending: queued });

    // Past the first retry's backoff (1 min + up to 15% jitter), the receiver is back.
    w.answerWith(200);
    w.advance(3 * 60_000);
    await drainAll(w.worker);
    expect(byStatus(await deliveriesOf(h, endpoint.id))).toEqual({ delivered: queued });
  });

  it('CRITICAL an endpoint paused after its delivery was claimed defers that delivery: back to pending, no attempt spent, nothing sent, nothing dead-lettered', async () => {
    const h = await harnessFor(kind);
    const svc = new WebhooksService(h.repo);
    const ctx = ownerCtx(h.accountId);
    const { row: endpoint } = await svc.create(ctx, {
      url: 'https://hooks.test.local/paused-mid-claim',
      events: ['session.completed'],
      description: null,
    });
    await svc.enqueueEvent(h.accountId, 'session.completed', { session_id: 'ses_race' });

    // The pause lands between the claim and the delivery.
    const raced = Object.create(h.repo) as WebhooksRepo;
    raced.claim = async (opts) => {
      const rows = await h.repo.claim(opts);
      await h.repo.updateEndpoint({ id: endpoint.id, accountId: h.accountId, active: false });
      return rows;
    };
    const w = workerFor(raced);
    const { claimed, outcomes } = await w.worker.tickOnce();

    expect(claimed).toBe(1);
    expect(outcomes.map((o) => o.kind)).toEqual(['deferred']);
    expect(w.fetchCalls()).toBe(0);
    const [row] = await deliveriesOf(h, endpoint.id);
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(0);
    expect((await h.repo.findEndpointById(endpoint.id))?.consecutiveFailures).toBe(0);
  });

  it('CRITICAL a DELETED endpoint still fails its queued deliveries terminally — deferring is for a pause, not for a tombstone', async () => {
    const h = await harnessFor(kind);
    const svc = new WebhooksService(h.repo);
    const ctx = ownerCtx(h.accountId);
    const { row: endpoint } = await svc.create(ctx, {
      url: 'https://hooks.test.local/deleted',
      events: ['session.completed'],
      description: null,
    });
    await svc.enqueueEvent(h.accountId, 'session.completed', { session_id: 'ses_deleted' });
    await svc.delete(ctx, endpoint.id);

    const w = workerFor(h.repo);
    await drainAll(w.worker);
    expect(w.fetchCalls()).toBe(0);
    expect(byStatus(await deliveriesOf(h, endpoint.id))).toEqual({ dlq: 1 });
    expect(
      await svc.enqueueEvent(h.accountId, 'session.completed', { session_id: 'ses_after' }),
      'an event was queued for a deleted endpoint',
    ).toBe(0);
  });
}

describe('a paused webhook endpoint holds its deliveries until it is resumed (in-memory)', () => {
  pauseContract('in-memory');
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'a paused webhook endpoint holds its deliveries until it is resumed (postgres)',
  () => {
    pauseContract('postgres');
  },
);
